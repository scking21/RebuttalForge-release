import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRecommendation } from "../src/agent/guard.js";
import { gatherEvidence } from "../src/agent/evidence.js";
import { evidenceDrivenDouble, scriptedBranch } from "../src/agent/test-double.js";
import { snapshotForCase } from "../src/approval.js";
import type { Evidence, Recommendation } from "../src/domain.js";
import { openDispute, paidOrder, startSimulator } from "./support/sandbox.js";
import { buyerOpensDispute, sellOne, startSystem, type System } from "./support/system.js";

const captureId = "CAP-1";
const pair = { carrierName: "UPS", trackingNumber: "1Z999" };
const source = (patch: Partial<Evidence> = {}): Evidence => ({
  id: "E1", source: "seller.record", provenance: "directSellerAssertion", label: "Synthetic fulfillment record",
  fact: "UPS 1Z999 delivered according to the seller record.", ref: `seller-records/${captureId}.json#0`, observedAt: "2026-10-18T00:00:00Z",
  ...patch,
});
const linked = (patch: Partial<Evidence> = {}): Evidence => source({
  fulfillment: { kind: "seller_delivery_record", captureId, ...pair }, ...patch,
});
const recommendation = (tracking = pair, evidenceIds = ["E1"]): Recommendation => ({
  action: "contest", confidence: "high", summary: "Synthetic provenance test.", supports: [{ text: "The seller record states fulfillment details.", evidenceIds }], contradicts: [],
  draft: { note: "If approved, submit the cited seller tracking assertion.", evidenceType: "PROOF_OF_FULFILLMENT", tracking },
});
const policy = { status: "WAITING_FOR_SELLER_RESPONSE", requestedEvidence: [], unclassifiedEvidence: [], offerTypes: null, acceptClaimTypes: null };
const run = (evidence: Evidence[], rec = recommendation(), expectedCapture: string | undefined = captureId) =>
  checkRecommendation(rec, evidence, ["provide_evidence"], { currency_code: "USD", value: "48.00" }, undefined, new Date(), policy, expectedCapture);
const rejected = (evidence: Evidence[], rec = recommendation(), expectedCapture = captureId) => {
  expect(run(evidence, rec, expectedCapture)).toContainEqual({ code: "TRACKING_NOT_IN_EVIDENCE", trackingNumber: rec.draft.tracking!.trackingNumber });
};
const systems: System[] = [];
afterEach(() => { for (const sys of systems.splice(0)) sys.store.close(); vi.restoreAllMocks(); });

describe("tracking must match one cited, capture-linked fulfillment record", () => {
  it("the labeled local test double copies retained structured fields instead of scraping prose", async () => {
    const output = await evidenceDrivenDouble().recommend({
      dispute: { disputeId: "SYNTHETIC", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", stage: "CHARGEBACK", status: policy.status, amount: { currency_code: "USD", value: "48.00" } },
      evidence: [linked({ fact: "The seller supplied structured fulfillment fields." })], permittedActions: ["contest"],
    });
    expect(output).toMatchObject({ kind: "actionable", recommendation: { draft: { tracking: pair } } });
  });
  it("rejects the original date/year substring plus invented carrier", () => {
    rejected([source({ source: "paypal.dispute", provenance: "providerTransactionFact", fact: "Dispute filed on 2026-10-18.", ref: "GET /v1/customer/disputes/SYNTHETIC" })], recommendation({ carrierName: "INVENTED_CARRIER", trackingNumber: "2026" }));
  });
  it("fails closed on an exact carrier/number present only in unstructured text", () => rejected([source()]));
  it("rejects a tracking-number substring of a real structured identifier", () => rejected([linked()], recommendation({ ...pair, trackingNumber: "1Z9" })));
  it("rejects an invented carrier for a real tracking number", () => rejected([linked()], recommendation({ ...pair, carrierName: "INVENTED_CARRIER" })));
  it("cannot combine carrier and number from different fulfillment records", () => {
    const second = linked({ id: "E2", fact: "FEDEX FEDEX999 seller record", ref: `seller-records/${captureId}.json#1`, fulfillment: { kind: "seller_delivery_record", captureId, carrierName: "FEDEX", trackingNumber: "FEDEX999" } });
    rejected([linked(), second], recommendation({ carrierName: "UPS", trackingNumber: "FEDEX999" }, ["E1", "E2"]));
  });
  it("accepts the complete pair from one cited record without scraping its free text", () => {
    expect(run([linked({ fact: "The seller supplied structured tracking fields separately." })])).toEqual([]);
  });
  it("accepts a successfully retrieved, identity-matched PayPal seller tracking submission", () => {
    expect(run([linked({ source: "paypal.tracking", ref: `GET /v1/shipping/trackers/${captureId}-${pair.trackingNumber}`, fulfillment: { kind: "paypal_tracking_submission", captureId, ...pair } })])).toEqual([]);
  });
  it("requires the matching record to be cited in supports", () => {
    rejected([source({ id: "E1" }), linked({ id: "E2" })]);
    const rec = recommendation(); rec.contradicts = [{ text: "A separate seller assertion", evidenceIds: ["E2"] }];
    rejected([source({ id: "E1" }), linked({ id: "E2" })], rec);
  });
  it("rejects a fulfillment pair linked to another capture", () => rejected([linked({ fulfillment: { kind: "seller_delivery_record", captureId: "OTHER-CAPTURE", ...pair } })]));
  it("fails closed without an established expected capture", () => {
    expect(checkRecommendation(recommendation(), [linked()], ["provide_evidence"], { currency_code: "USD", value: "48.00" }, undefined, new Date(), policy)).toContainEqual({ code: "TRACKING_NOT_IN_EVIDENCE", trackingNumber: pair.trackingNumber });
  });
  it.each([
    { source: "paypal.dispute" }, { provenance: "lookupObservation" }, { provenance: "buyerStatement" },
    { ref: "seller-records/OTHER-CAPTURE.json#0" }, { ref: "unidentified record" },
    { fulfillment: { kind: "paypal_tracking_submission", captureId, ...pair } },
  ] as Partial<Evidence>[])("rejects wrong source, provenance, source reference or source kind: %j", patch => rejected([linked(patch)]));
  it.each([
    { ...pair, carrierName: "ups" }, { ...pair, carrierName: " UPS " }, { ...pair, trackingNumber: "1Z999 " },
    { ...pair, trackingNumber: "" }, { ...pair, carrierName: "" },
  ])("requires exact canonical draft fields, without silently changing the approved payload: %j", tracking => rejected([linked()], recommendation(tracking)));
  it("rejects an ambiguous duplicate evidence ID", () => rejected([linked(), source({ fact: "A different record reused E1." })]));
});

describe("gathered tracking provenance", () => {
  async function scenario() {
    const sb = startSimulator();
    const { orderId, captureId } = await paidOrder(sb);
    const { dispute_id } = await openDispute(sb, captureId);
    return { sb, orderId, captureId, disputeId: dispute_id };
  }
  const scan = { kind: "carrier_delivery_scan" as const, label: "Synthetic seller scan", fact: "Seller reports delivery.", recordedAt: "2026-10-18T00:00:00Z", carrier: " ups ", trackingNumber: " 1Z999 " };
  it("retains one normalized pair, capture and exact seller-record reference without claiming independent verification", async () => {
    const s = await scenario();
    const { evidence } = await gatherEvidence(s.sb.client, s.disputeId, () => [scan]);
    expect(evidence.find(e => e.source === "seller.record")).toMatchObject({
      provenance: "directSellerAssertion", ref: `seller-records/${s.captureId}.json#0`,
      fulfillment: { kind: "seller_delivery_record", captureId: s.captureId, ...pair },
    });
  });
  it("retains the paired fields from a successful PayPal tracking response for the matched capture", async () => {
    const s = await scenario();
    await s.sb.client.addTracking(s.orderId, { captureId: s.captureId, trackingNumber: pair.trackingNumber, carrier: pair.carrierName, notifyPayer: false }, "structured-tracking");
    const { evidence } = await gatherEvidence(s.sb.client, s.disputeId, () => []);
    expect(evidence.find(e => e.source === "paypal.tracking")).toMatchObject({ provenance: "directSellerAssertion", fulfillment: { kind: "paypal_tracking_submission", captureId: s.captureId, ...pair } });
  });
  it.each(["missing-carrier", "missing-number", "note", "not_shipped", "control-character"])("does not promote %s seller text into usable fulfillment fields", async mode => {
    const s = await scenario();
    const record = { ...scan };
    if (mode === "missing-carrier") delete (record as Partial<typeof record>).carrier;
    if (mode === "missing-number") delete (record as Partial<typeof record>).trackingNumber;
    if (mode === "note" || mode === "not_shipped") Object.assign(record, { kind: mode });
    if (mode === "control-character") record.carrier = "UP\nS";
    const { evidence } = await gatherEvidence(s.sb.client, s.disputeId, () => [record]);
    expect(evidence.find(e => e.source === "seller.record")?.fulfillment).toBeUndefined();
    expect(evidence.find(e => e.source === "seller.record")?.fact).toContain(record.fact);
  });
  it("keeps a numbered 404 lookup as an observation without usable fulfillment fields", async () => {
    const s = await scenario();
    const { evidence } = await gatherEvidence(s.sb.client, s.disputeId, () => [{ ...scan, trackingNumber: pair.trackingNumber }]);
    const lookup = evidence.find(e => e.source === "paypal.tracking")!;
    expect(lookup.provenance).toBe("lookupObservation");
    expect(lookup.fulfillment).toBeUndefined();
    expect(lookup.fact).toContain("HTTP 404");
  });
  it("does not borrow a carrier from seller text when the PayPal tracking response has no carrier", async () => {
    const s = await scenario();
    vi.spyOn(s.sb.client, "getTracking").mockResolvedValue({ transaction_id: s.captureId, tracking_number: pair.trackingNumber, status: "SHIPPED" });
    const { evidence } = await gatherEvidence(s.sb.client, s.disputeId, () => [{ ...scan, trackingNumber: pair.trackingNumber }]);
    expect(evidence.find(e => e.source === "paypal.tracking")?.fulfillment).toBeUndefined();
  });
});

async function readyContest() {
  const sys = startSystem({ model: scriptedBranch("contest", pair) }); systems.push(sys);
  const { captureId } = await sellOne(sys, "tracking-boundary", { carrier: pair.carrierName, number: pair.trackingNumber });
  sys.records[captureId] = [{ kind: "carrier_delivery_scan", label: "Synthetic seller scan", fact: "UPS 1Z999 seller-reported delivery", recordedAt: "2026-10-18T00:00:00Z", carrier: pair.carrierName, trackingNumber: pair.trackingNumber }];
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  await sys.client.escalate(disputeId, "Synthetic test", "tracking-escalate");
  await sys.api("POST", `/api/sandbox/disputes/${disputeId}/require-evidence`, {});
  await sys.sim.flushDeliveries();
  expect(sys.store.getCase(disputeId)?.status).toBe("recommended");
  return { sys, disputeId };
}

describe("approval and execution recheck persisted tracking provenance", () => {
  it("refuses to approve legacy unstructured tracking despite previously empty guard failures", async () => {
    const { sys, disputeId } = await readyContest();
    const c = sys.store.getCase(disputeId)!; c.evidence.forEach(e => { delete e.fulfillment; }); sys.store.saveCase(c);
    const response = await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "Synthetic operator", recommendationRevision: c.recommendationRevision });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("guard_failures");
    expect(sys.store.getCase(disputeId)?.status).toBe("recommended");
  });
  it("refuses a legacy approval without structured linkage before any provider action or execution claim", async () => {
    const { sys, disputeId } = await readyContest();
    const c = sys.store.getCase(disputeId)!;
    c.evidence.forEach(e => { delete e.fulfillment; });
    sys.store.saveCase(c);
    sys.store.transition(disputeId, "approved", { approvedBy: "Synthetic legacy operator", approvedSnapshot: snapshotForCase(c) });
    sys.fetchCalls.length = 0;
    const response = await sys.api("POST", `/api/cases/${disputeId}/execute`);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("execution_blocked");
    expect(sys.fetchCalls.filter(call => call.startsWith("POST"))).toEqual([]);
    expect(sys.store.getCase(disputeId)?.pendingAction).toBeUndefined();
  });
  it("still requires approval and executes one valid, cited, structured pair exactly once", async () => {
    const { sys, disputeId } = await readyContest();
    expect((await sys.api("POST", `/api/cases/${disputeId}/execute`)).status).toBe(409);
    const c = sys.store.getCase(disputeId)!;
    expect((await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "Synthetic operator", recommendationRevision: c.recommendationRevision })).status).toBe(200);
    sys.fetchCalls.length = 0;
    expect((await sys.api("POST", `/api/cases/${disputeId}/execute`)).status).toBe(200);
    expect((await sys.api("POST", `/api/cases/${disputeId}/execute`)).status).toBe(200);
    expect(sys.fetchCalls.filter(call => call.endsWith("/provide-evidence"))).toHaveLength(1);
  });

  it.each(["carrier", "number", "capture", "provenance", "reference"])("invalidates prior approval if stored fulfillment %s changes", async change => {
    const { sys, disputeId } = await readyContest();
    let c = sys.store.getCase(disputeId)!;
    expect((await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "Synthetic operator", recommendationRevision: c.recommendationRevision })).status).toBe(200);
    c = sys.store.getCase(disputeId)!;
    const record = c.evidence.find(e => e.fulfillment)!;
    if (change === "carrier") record.fulfillment!.carrierName = "FEDEX";
    if (change === "number") record.fulfillment!.trackingNumber = "OTHER";
    if (change === "capture") record.fulfillment!.captureId = "OTHER";
    if (change === "provenance") record.provenance = "lookupObservation";
    if (change === "reference") record.ref = "unreviewed source";
    sys.store.saveCase(c);
    sys.fetchCalls.length = 0;
    const response = await sys.api("POST", `/api/cases/${disputeId}/execute`);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("approval_stale");
    expect(sys.fetchCalls.filter(call => call.startsWith("POST"))).toEqual([]);
  });
});
