import { describe, expect, it, vi } from "vitest";
import { decisionFacts, snapshotForCase } from "../src/approval.js";
import { executeApproved, IncompleteDraft } from "../src/agent/execute.js";
import type { Case } from "../src/domain.js";
import { scriptedBranch } from "../src/agent/test-double.js";
import { buyerOpensDispute, sellOne, startSystem } from "./support/system.js";

async function setup(action: "contest" | "concede" = "concede") {
  const model = scriptedBranch(action, { carrierName: "UPS", trackingNumber: "1Z999" });
  const sys = startSystem({ model });
  const { captureId } = await sellOne(sys, "policy", { carrier: "UPS", number: "1Z999" });
  sys.records[captureId] = [{ kind: "carrier_delivery_scan", label: "Carrier delivery scan", fact: "UPS delivered 1Z999", recordedAt: "2026-10-04T00:00:00Z", carrier: "UPS", trackingNumber: "1Z999" }];
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  sys.sim.setWebhookUrl(undefined);
  if (action === "contest") {
    await sys.client.escalate(disputeId, "test", "esc");
    await sys.client.requireEvidence(disputeId, "SELLER_EVIDENCE", "req");
  }
  return { ...sys, model, disputeId };
}

describe("provider response policy safety", () => {
  it("blocks refund when the provider only allows a return-based refund", async () => {
    const sys = await setup();
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND_WITH_RETURN"] } } }));
    const result = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(result.body.guardFailures).toContainEqual({ code: "RESPONSE_SUBTYPE_NOT_PERMITTED", action: "concede", subtype: "REFUND" });
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/approve`, { approvedBy: "seller", recommendationRevision: result.body.recommendationRevision })).status).toBe(409);
  });

  it("leaves requested refund evidence for manual review rather than sending tracking", async () => {
    const sys = await setup("contest");
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), evidences: [{ source: "REQUESTED_FROM_SELLER", evidence_type: "PROOF_OF_REFUND" }] }));
    const result = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(result.body.guardFailures).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MANUAL_EVIDENCE_REVIEW" })]));
    expect(sys.model.calls.at(-1)?.dispute).toHaveProperty("responsePolicy");
  });

  it("invalidates approval when only the requested seller evidence changes", async () => {
    const sys = await setup("contest");
    const assessed = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(assessed.body.guardFailures).toEqual([]);
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/approve`, { approvedBy: "seller", recommendationRevision: assessed.body.recommendationRevision })).status).toBe(200);
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), evidences: [{ source: "REQUESTED_FROM_SELLER", evidence_type: "PROOF_OF_REFUND" }] }));
    sys.fetchCalls.length = 0;
    const result = await sys.api("POST", `/api/cases/${sys.disputeId}/execute`);
    expect(result).toMatchObject({ status: 409, body: { error: "approval_stale" } });
    expect(sys.fetchCalls.filter(call => call.startsWith("POST /v1/customer"))).toEqual([]);
  });
});


describe("response policy boundary cases", () => {
  it.each([undefined, {}, { accept_claim: { accept_claim_types: [] } }, { accept_claim: { accept_claim_types: "REFUND" } }])("fails closed for absent or malformed refund permission %j", async options => {
    const sys = await setup();
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), allowed_response_options: options }));
    const result = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(result.body.guardFailures).toContainEqual({ code: "RESPONSE_SUBTYPE_NOT_PERMITTED", action: "concede", subtype: "REFUND" });
  });

  it.each([
    { source: "REQUESTED_FROM_SELLER" },
    { source: "REQUESTED_FROM_SELLER", evidence_type: "OTHER" },
    { source: "REQUESTED_FROM_SELLER", evidence_type: "PROOF_OF_FULFILLMENT", notes: "Attach delivery signature" },
    { source: "REQUESTED_FROM_SELLER", evidence_type: "PROOF_OF_FULFILLMENT", action_info: { mandatory: true } },
  ])("requires manual review for unsupported request %j", async request => {
    const sys = await setup("contest");
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), evidences: [request] }));
    const result = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(result.body.guardFailures).toContainEqual(expect.objectContaining({ code: "MANUAL_EVIDENCE_REVIEW" }));
  });

  it("permits supported tracking requests and ignores a buyer-only refund request", async () => {
    const sys = await setup("contest");
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), evidences: [
      { source: "REQUESTED_FROM_SELLER", evidence_type: "PROOF_OF_FULFILLMENT" },
      { source: "REQUESTED_FROM_BUYER", evidence_type: "PROOF_OF_REFUND" },
    ] }));
    const result = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(result.body.guardFailures).toEqual([]);
  });

  it.each(["allowed options", "same-type request details", "buyer message"])("invalidates reviewed financial action after changed %s", async change => {
    const sys = await setup();
    const assessed = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    await sys.api("POST", `/api/cases/${sys.disputeId}/approve`, { approvedBy: "seller", recommendationRevision: assessed.body.recommendationRevision });
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => {
      const dispute = await read(id);
      if (change === "allowed options") dispute.allowed_response_options = { accept_claim: { accept_claim_types: ["REFUND_WITH_RETURN"] } };
      if (change === "same-type request details") dispute.evidences = [{ source: "REQUESTED_FROM_SELLER", evidence_type: "PROOF_OF_FULFILLMENT", notes: "new request" }];
      if (change === "buyer message") dispute.messages.push({ posted_by: "BUYER", time_posted: "2026-10-11T00:00:00Z", content: "New details" });
      return dispute;
    });
    sys.fetchCalls.length = 0;
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/execute`)).body.error).toBe("approval_stale");
    expect(sys.fetchCalls.filter(call => call.startsWith("POST /v1/customer"))).toEqual([]);
  });
});

describe("action-specific mandatory evidence", () => {
  it("blocks refund acceptance when mandatory supporting evidence applies to REFUND", async () => {
    const sys = await setup();
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), evidences: [{
      source: "REQUESTED_FROM_SELLER", evidence_type: "OTHER", notes: "Required supporting information",
      action_info: { action: "ACCEPT_CLAIM", response_option: "REFUND", mandatory: true },
    }] }));
    const assessed = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(assessed.body.guardFailures).toContainEqual(expect.objectContaining({ code: "MANUAL_EVIDENCE_REVIEW" }));
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/approve`, { approvedBy: "seller", recommendationRevision: assessed.body.recommendationRevision })).status).toBe(409);
    expect(sys.sim.state.actionLog.filter(action => action.rel === "accept_claim")).toHaveLength(0);
  });
});


describe("mandatory evidence applicability boundary", () => {
  it.each([
    { action: "PROVIDE_EVIDENCE", mandatory: true },
    { action: "ACCEPT_CLAIM", response_option: "REFUND_WITH_RETURN", mandatory: true },
    { action: "ACCEPT_CLAIM", response_option: "REFUND", mandatory: false },
  ])("does not block an explicitly unrelated or optional request %j", async actionInfo => {
    const sys = await setup();
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), evidences: [{
      source: "REQUESTED_FROM_SELLER", evidence_type: "OTHER", action_info: actionInfo,
    }] }));
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`)).body.guardFailures).toEqual([]);
  });

  it.each([
    null,
    {},
    { action: "ACCEPT_CLAIM", response_option: "REFUND" },
    { action: "ACCEPT_CLAIM", response_option: { unexpected: true }, mandatory: true },
    { action: "ACCEPT_CLAIM", response_option: "", mandatory: true },
    { action: "ACCEPT_CLAIM", response_option: "refund", mandatory: true },
    { action: "NEW_ACTION", mandatory: true },
  ])("holds unclear evidence applicability %j", async actionInfo => {
    const sys = await setup();
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), evidences: [{
      source: "REQUESTED_FROM_SELLER", evidence_type: "OTHER", action_info: actionInfo,
    }] }));
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`)).body.guardFailures).toContainEqual(expect.objectContaining({ code: "MANUAL_EVIDENCE_REVIEW" }));
  });

  it("shows complete requested evidence in the seller's review and blocks unsupported direct execution", async () => {
    const sys = await setup();
    const reviewed = sys.store.getCase(sys.disputeId)!;
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), evidences: [{
      source: "REQUESTED_FROM_SELLER", evidence_type: "OTHER", notes: "Attach signed document",
      action_info: { action: "ACCEPT_CLAIM", response_option: "REFUND", mandatory: true },
    }] }));
    const result = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(result.body.evidence).toContainEqual(expect.objectContaining({ label: "PayPal evidence response requirements", fact: expect.stringContaining("Attach signed document") }));
    const dispute = await sys.client.getDispute(sys.disputeId);
    const syntheticApproved: Case = { ...sys.store.getCase(sys.disputeId)!, status: "approved", assessment: reviewed.assessment, recommendationRevision: "synthetic-reviewed", guardFailures: [], decisionFacts: decisionFacts(dispute) };
    syntheticApproved.approvedSnapshot = snapshotForCase(syntheticApproved);
    await expect(executeApproved(syntheticApproved, sys.client)).rejects.toBeInstanceOf(IncompleteDraft);
    expect(sys.sim.state.actionLog.filter(action => action.rel === "accept_claim")).toHaveLength(0);
  });

  it.each([undefined, "NEW_SOURCE", null])("holds unclassified evidence source %j", async source => {
    const sys = await setup();
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), evidences: [{ source, evidence_type: "OTHER" }] }));
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`)).body.guardFailures).toContainEqual(expect.objectContaining({ code: "MANUAL_EVIDENCE_REVIEW" }));
  });
});
