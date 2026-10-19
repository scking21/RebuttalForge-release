import { describe, expect, it, vi } from "vitest";
import { scriptedBranch } from "../src/agent/test-double.js";
import { PayPalError } from "../src/paypal/client.js";
import { buyerOpensDispute, sellOne, startSystem } from "./support/system.js";

async function contestCase() {
  const model = scriptedBranch("contest", { carrierName: "UPS", trackingNumber: "1Z999" });
  const sys = startSystem({ model });
  const { captureId } = await sellOne(sys, "cycles", { carrier: "UPS", number: "1Z999" });
  sys.records[captureId] = [{ kind: "carrier_delivery_scan", label: "Carrier delivery scan", fact: "UPS delivered 1Z999", recordedAt: "2026-10-04T00:00:00Z", carrier: "UPS", trackingNumber: "1Z999" }];
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  await sys.client.escalate(disputeId, "test", "esc");
  await sys.client.requireEvidence(disputeId, "SELLER_EVIDENCE", "req");
  await sys.sim.flushDeliveries();
  const approve = () => sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "seller", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision });
  const execute = () => sys.api("POST", `/api/cases/${disputeId}/execute`);
  return { ...sys, disputeId, approve, execute };
}

describe("renewed seller response cycles", () => {
  it("shows additional provider work without creating another executable cycle", async () => {
    const sys = await contestCase();
    await sys.approve();
    const first = await sys.execute();
    expect(first.body.status).toBe("executed");
    await sys.sim.flushDeliveries();
    await sys.client.requireEvidence(sys.disputeId, "SELLER_EVIDENCE", "req-second");
    await sys.sim.flushDeliveries();
    const refreshed = sys.store.getCase(sys.disputeId);
    expect(refreshed?.status).toBe("executed");
    expect(refreshed?.execution).toEqual(first.body.execution);
    expect(refreshed?.postExecutionReview?.reason).toContain("manual review");
    expect(refreshed?.postExecutionReview?.providerStatus).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect((await sys.approve()).status).toBe(409);
    expect((await sys.execute()).body.execution.requestId).toBe(first.body.execution.requestId);
    expect(sys.sim.state.actionLog.filter(a => a.rel === "provide_evidence")).toHaveLength(1);
  });

  it("does not renew an unchanged executed case on manual reassessment", async () => {
    const sys = await contestCase();
    await sys.approve();
    const first = await sys.execute();
    const result = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(result.body.status).toBe("executed");
    expect(result.body.execution).toEqual(first.body.execution);
  });

  it("invalidates approved advice when fresh buyer evidence arrives", async () => {
    const sys = await contestCase();
    await sys.approve();
    const oldRevision = sys.store.getCase(sys.disputeId)?.recommendationRevision;
    sys.sim.state.disputes.get(sys.disputeId)!.messages.push({ posted_by: "BUYER", time_posted: "2026-10-11T00:00:00Z", content: "New information" });
    const result = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(result.body.status).toBe("recommended");
    expect(result.body.recommendationRevision).not.toBe(oldRevision);
    expect((await sys.execute()).status).toBe(409);
  });

  it("holds an ambiguous outbound action across reassess and execute", async () => {
    const sys = await contestCase();
    await sys.approve();
    vi.spyOn(sys.client, "provideEvidence").mockRejectedValue(new TypeError("connection lost after send"));
    expect((await sys.execute()).body.error).toBe("unknown_outcome");
    expect(sys.store.getCase(sys.disputeId)).toHaveProperty("pendingAction");
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`)).body.error).toBe("manual_reconciliation_required");
    expect((await sys.execute()).body.error).toBe("manual_reconciliation_required");
    expect(sys.client.provideEvidence).toHaveBeenCalledTimes(1);
  });
});


describe("response cycle failure boundaries", () => {
  it("does not replace an action after it applied but its response was lost", async () => {
    const sys = await contestCase();
    await sys.approve();
    const provide = sys.client.provideEvidence.bind(sys.client);
    vi.spyOn(sys.client, "provideEvidence").mockImplementation(async (...args) => {
      await provide(...args);
      throw new TypeError("response lost after provider commit");
    });
    expect((await sys.execute()).body.error).toBe("unknown_outcome");
    await sys.sim.flushDeliveries();
    expect(sys.sim.state.actionLog.filter(a => a.rel === "provide_evidence")).toHaveLength(1);
    await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    await sys.approve();
    await sys.execute();
    expect(sys.client.provideEvidence).toHaveBeenCalledTimes(1);
    expect(sys.sim.state.actionLog.filter(a => a.rel === "provide_evidence")).toHaveLength(1);
  });

  it.each([408, 500, 503])("holds ambiguous HTTP %s failures", async status => {
    const sys = await contestCase();
    await sys.approve();
    vi.spyOn(sys.client, "provideEvidence").mockRejectedValue(new PayPalError(status, "ERROR", "uncertain", undefined, {}));
    expect((await sys.execute()).body.error).toBe("unknown_outcome");
    expect(sys.store.getCase(sys.disputeId)?.pendingAction).toBeDefined();
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`)).status).toBe(409);
  });

  it("allows new review after a definite provider rejection", async () => {
    const sys = await contestCase();
    await sys.approve();
    vi.spyOn(sys.client, "provideEvidence").mockRejectedValue(new PayPalError(422, "VALIDATION_ERROR", "rejected", undefined, {}));
    expect((await sys.execute()).body.error).toBe("paypal_error");
    expect(sys.store.getCase(sys.disputeId)?.pendingAction).toBeUndefined();
    expect((await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`)).body.status).toBe("recommended");
  });

  it("retains completed execution when follow-up details have the wrong identity", async () => {
    const sys = await contestCase();
    await sys.approve();
    const read = sys.client.getDispute.bind(sys.client);
    let reads = 0;
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => {
      const d = await read(id);
      return ++reads === 1 ? d : { ...d, dispute_id: "OTHER-DISPUTE", status: "RESOLVED" };
    });
    const result = await sys.execute();
    expect(result.body.status).toBe("executed");
    expect(result.body.execution.afterSellerRequest).toBeUndefined();
    expect(result.body.execution.response.after.unavailable).toMatch(/identity/);
    expect(result.body.outcome).toBeUndefined();
  });

  it("does not create a new cycle from a buyer message when provider still awaits the same response", async () => {
    const sys = await contestCase();
    await sys.approve();
    const provide = sys.client.provideEvidence.bind(sys.client);
    vi.spyOn(sys.client, "provideEvidence").mockImplementation(async (...args) => {
      const result = await provide(...args);
      sys.sim.state.disputes.get(sys.disputeId)!.status = "WAITING_FOR_SELLER_RESPONSE";
      return result;
    });
    const first = await sys.execute();
    sys.sim.state.disputes.get(sys.disputeId)!.messages.push({ posted_by: "BUYER", time_posted: "2026-10-11T00:00:00Z", content: "Another message" });
    const refreshed = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
    expect(refreshed.body.status).toBe("executed");
    expect(refreshed.body.execution).toEqual(first.body.execution);
  });
});


it("refreshes deadline and evidence while preserving the acknowledged action and manual hold", async () => {
  const sys = await contestCase();
  await sys.approve();
  const first = await sys.execute();
  sys.sim.setWebhookUrl(undefined);
  const d = sys.sim.state.disputes.get(sys.disputeId)!;
  d.status = "WAITING_FOR_SELLER_RESPONSE";
  d.dueDate = "2027-01-15T00:00:00Z";
  d.evidences.push({ source: "REQUESTED_FROM_SELLER", evidence_type: "OTHER", notes: "New requested documents" });
  const refreshed = await sys.api("POST", `/api/cases/${sys.disputeId}/reassess`);
  expect(refreshed.body.sellerResponseDueDate).toBe("2027-01-15T00:00:00Z");
  expect(refreshed.body.postExecutionReview.evidence).toContainEqual(expect.objectContaining({ notes: "New requested documents" }));
  expect(refreshed.body.execution).toEqual(first.body.execution);
  expect((await sys.approve()).status).toBe(409);
  expect(() => sys.store.beginAssessment(sys.disputeId)).toThrow(/prior action may have reached PayPal/);
  await sys.execute();
  expect(sys.sim.state.actionLog.filter(action => action.rel === "provide_evidence")).toHaveLength(1);
});
