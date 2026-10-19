import { ApprovalStale, decisionFacts, snapshotForCase } from "../src/approval.js";
import { describe, expect, it } from "vitest";
import { ExecutionBlocked, IncompleteDraft, executeApproved } from "../src/agent/execute.js";
import type { Case, Recommendation } from "../src/domain.js";
import { openDispute, paidOrder, startSimulator, type Sandbox } from "./support/sandbox.js";
import { gatherEvidence } from "../src/agent/evidence.js";

const rec = (over: Partial<Recommendation>): Recommendation => ({
  action: "concede",
  confidence: "high",
  summary: "s",
  supports: [],
  contradicts: [],
  draft: { note: "n" },
  ...over,
});

const approved = async (sb: Sandbox, disputeId: string, recommendation: Recommendation): Promise<Case> => {
  const dispute = await sb.client.getDispute(disputeId);
  const c: Case = {
    disputeId, status: "approved", reason: dispute.reason, amount: dispute.dispute_amount,
    sellerResponseDueDate: dispute.seller_response_due_date,
    permittedRels: dispute.links.map(l => l.rel), evidence: [], assessment: { kind: "actionable", recommendation },
    recommendationRevision: "test-reviewed-version", decisionFacts: decisionFacts(dispute),
    guardFailures: [], approvedBy: "seller", updatedAt: "2026-10-09T00:00:00Z",
  };
  c.approvedSnapshot = snapshotForCase(c);
  return c;
};

async function disputed(sb: Sandbox, evidenceEligible = false) {
  const { orderId, captureId } = await paidOrder(sb);
  const { dispute_id } = await openDispute(sb, captureId);
  if (evidenceEligible) {
    await sb.client.escalate(dispute_id, "n", "e");
    await sb.client.requireEvidence(dispute_id, "SELLER_EVIDENCE", "r");
  }
  return { orderId, captureId, disputeId: dispute_id };
}

describe("executeApproved", () => {
  it("concede calls accept-claim once, records the resolved state, and never issues a refund call", async () => {
    const sb = startSimulator();
    const { orderId, disputeId } = await disputed(sb);
    sb.requests.length = 0;

    const { execution, after } = await executeApproved(await approved(sb, disputeId, rec({ action: "concede" })), sb.client);

    const writes = sb.requests.filter((r) => r.startsWith("POST"));
    expect(writes).toEqual([`POST /v1/customer/disputes/${disputeId}/accept-claim`]);
    expect(sb.requests.some((r) => /refund/i.test(r))).toBe(false);
    expect(execution).toMatchObject({ action: "concede", requestId: expect.stringMatching(/^dd-[a-f0-9]{32}$/), httpStatus: 200 });
    expect(after).toMatchObject({ status: "RESOLVED", dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" } });
    expect(execution.response).toMatchObject({ after: { status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR" } });
    expect((await sb.client.getOrder(orderId)).purchase_units[0]?.payments?.refunds).toHaveLength(1);
  });

  it("contest submits proof of fulfilment and the evidence persists on re-fetch", async () => {
    const sb = startSimulator();
    const { disputeId, orderId, captureId } = await disputed(sb, true);
    await sb.client.addTracking(orderId, { captureId, trackingNumber: "1Z999", carrier: "UPS", notifyPayer: false }, "contest-tracking");
    const { evidence } = await gatherEvidence(sb.client, disputeId, () => []);
    const trackingRecord = evidence.find(e => e.source === "paypal.tracking")!;
    const draft = {
      note: "Delivered",
      evidenceType: "PROOF_OF_FULFILLMENT",
      tracking: { carrierName: "UPS", trackingNumber: "1Z999" },
    };
    const c = await approved(sb, disputeId, rec({ action: "contest", draft, supports: [{ text: "Seller tracking submission", evidenceIds: [trackingRecord.id] }] }));
    c.evidence = evidence;
    c.approvedSnapshot = snapshotForCase(c);
    const { after } = await executeApproved(c, sb.client);
    expect(after?.status).toBe("UNDER_REVIEW");
    expect(after?.evidences[0]).toMatchObject({
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999" }] },
    });
  });

  it("is idempotent: a case that already has an execution makes no second PayPal action", async () => {
    const sb = startSimulator();
    const { disputeId } = await disputed(sb);
    const first = await executeApproved(await approved(sb, disputeId, rec({ action: "concede" })), sb.client);
    sb.requests.length = 0;

    const replay = await executeApproved({ ...await approved(sb, disputeId, rec({ action: "concede" })), status: "executed", execution: first.execution }, sb.client);

    expect(replay.execution).toEqual(first.execution);
    expect(sb.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    expect(sb.sim.state.actionLog.filter((a) => a.rel === "accept_claim")).toHaveLength(1);
  });

  it("re-checks the rel first: a retry of an already-applied action is blocked, not repeated", async () => {
    const sb = startSimulator();
    const { disputeId } = await disputed(sb);
    const c = await approved(sb, disputeId, rec({ action: "concede" }));
    await executeApproved(c, sb.client);
    await expect(executeApproved(c, sb.client)).rejects.toBeInstanceOf(ApprovalStale);
    expect(sb.sim.state.actionLog.filter((a) => a.rel === "accept_claim")).toHaveLength(1);
  });

  it("blocks contest before the dispute is evidence-eligible without calling provide-evidence", async () => {
    const sb = startSimulator();
    const { disputeId } = await disputed(sb);
    sb.requests.length = 0;
    const draft = { note: "n", tracking: { carrierName: "UPS", trackingNumber: "1Z" } };
    await expect(executeApproved(await approved(sb, disputeId, rec({ action: "contest", draft })), sb.client)).rejects.toMatchObject({
      rel: "provide_evidence",
    });
    expect(sb.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  it("refuses incomplete drafts and unapproved cases", async () => {
    const sb = startSimulator();
    const { disputeId } = await disputed(sb, true);
    await expect(executeApproved(await approved(sb, disputeId, rec({ action: "contest" })), sb.client)).rejects.toBeInstanceOf(IncompleteDraft);
    const notApproved = { ...await approved(sb, disputeId, rec({ action: "concede" })), status: "recommended" as const };
    await expect(executeApproved(notApproved, sb.client)).rejects.toThrow(/not approved/);
  });
});
