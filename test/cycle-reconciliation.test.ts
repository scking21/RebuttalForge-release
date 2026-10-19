import { OPERATOR_REQUEST_HEADERS } from "../src/request-integrity.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createApp } from "../src/server.js";
import { scriptedBranch } from "../src/agent/test-double.js";
import { buyerOpensDispute, sellOne, startSystem } from "./support/system.js";

const stores = new Set<Store>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); });

async function setup() {
  const model = scriptedBranch("contest", { carrierName: "UPS", trackingNumber: "1Z999" });
  const sys = startSystem({ model });
  stores.add(sys.store);
  const { captureId } = await sellOne(sys, "audit", { carrier: "UPS", number: "1Z999" });
  sys.records[captureId] = [{ kind: "carrier_delivery_scan", label: "Delivery", fact: "UPS delivered 1Z999", recordedAt: "2026-10-04T00:00:00Z", carrier: "UPS", trackingNumber: "1Z999" }];
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  sys.sim.setWebhookUrl(undefined);
  await sys.client.escalate(disputeId, "test", "esc");
  await sys.client.requireEvidence(disputeId, "SELLER_EVIDENCE", "req");
  const database = join(mkdtempSync(join(tmpdir(), "audit-persist-")), "case.sqlite");
  let store = new Store(database);
  stores.add(store);
  const appForStore = () => createApp({ client: sys.client, store, model, sellerRecords: id => sys.records[id] ?? [], webhookId: "WH-TEST" });
  let app = appForStore();
  const api = async (path: string, body?: unknown) => {
    const response = await app.request(`/api/cases/${disputeId}/${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...OPERATOR_REQUEST_HEADERS }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const approve = () => api("approve", { approvedBy: "seller", recommendationRevision: store.getCase(disputeId)?.recommendationRevision });
  const restart = () => {
    stores.delete(store);
    store.close();
    store = new Store(database);
    stores.add(store);
    app = appForStore();
  };
  return { ...sys, disputeId, api, approve, restart, db: () => store };
}

const request = (date: string) => ({ source: "REQUESTED_FROM_SELLER", evidence_type: "PROOF_OF_FULFILLMENT", date });

async function acknowledgeWithoutFollowup(sys: Awaited<ReturnType<typeof setup>>) {
  const provide = sys.client.provideEvidence.bind(sys.client);
  vi.spyOn(sys.client, "provideEvidence").mockImplementation(async (...args) => {
    const result = await provide(...args);
    sys.failures.getDisputeOnce = true;
    return result;
  });
  await sys.api("reassess");
  await sys.approve();
  const first = await sys.api("execute");
  expect(first.body.status).toBe("executed");
  expect(first.body.execution.afterSellerRequest).toBeUndefined();
  sys.restart();
  return first;
}

describe("reviewed cycle reconciliation regressions", () => {
  it("does not invalidate approval when allowed response subtype sets are reordered", async () => {
    const sys = await setup();
    let options = { accept_claim: { accept_claim_types: ["REFUND", "REFUND_WITH_RETURN"] } };
    const read = sys.client.getDispute.bind(sys.client);
    vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), allowed_response_options: options }));
    await sys.api("reassess");
    expect((await sys.approve()).status).toBe(200);
    options = { accept_claim: { accept_claim_types: ["REFUND_WITH_RETURN", "REFUND"] } };
    expect((await sys.api("execute")).body.status).toBe("executed");
  });

  it.each(["reorder", "duplicate", "remove", "deadline"])("does not reopen the same seller request after %s and SQLite restart", async change => {
    const sys = await setup();
    const dispute = sys.sim.state.disputes.get(sys.disputeId)!;
    dispute.evidences = [request("2026-10-01T00:00:00Z"), request("2026-10-02T00:00:00Z")];
    const provide = sys.client.provideEvidence.bind(sys.client);
    vi.spyOn(sys.client, "provideEvidence").mockImplementation(async (...args) => {
      const result = await provide(...args);
      dispute.status = "WAITING_FOR_SELLER_RESPONSE";
      return result;
    });
    await sys.api("reassess");
    await sys.approve();
    const first = await sys.api("execute");
    expect(first.body.status).toBe("executed");
    sys.restart();
    if (change === "reorder") dispute.evidences.reverse();
    if (change === "duplicate") dispute.evidences.push({ ...dispute.evidences[0] });
    if (change === "remove") dispute.evidences.shift();
    if (change === "deadline") dispute.dueDate = "2027-01-01T00:00:00Z";
    expect((await sys.api("reassess")).body.status).toBe("executed");
    expect((await sys.approve()).status).toBe(409);
    expect((await sys.api("execute")).body.execution.requestId).toBe(first.body.execution.requestId);
    expect(sys.sim.state.actionLog.filter(a => a.rel === "provide_evidence")).toHaveLength(1);
  });

  it("displays a newly added request but holds after acknowledged success and failed follow-up GET", async () => {
    const sys = await setup();
    await acknowledgeWithoutFollowup(sys);
    await sys.client.requireEvidence(sys.disputeId, "SELLER_EVIDENCE", "new-provider-request");
    sys.sim.state.disputes.get(sys.disputeId)!.evidences.push(request("2026-10-11T00:00:00Z"));
    const result = await sys.api("reassess");
    expect(result.body.status).toBe("executed");
    expect(result.body.postExecutionReview.evidence).toContainEqual(request("2026-10-11T00:00:00Z"));
    expect((await sys.approve()).status).toBe(409);
    await sys.api("execute");
    expect(sys.sim.state.actionLog.filter(a => a.rel === "provide_evidence")).toHaveLength(1);
  });

  it("does not treat an observed non-waiting state as permission for another response", async () => {
    const sys = await setup();
    await acknowledgeWithoutFollowup(sys);
    const checkpoint = await sys.api("reassess");
    expect(checkpoint.body.status).toBe("executed");
    expect(checkpoint.body.execution.afterSellerRequest).toBeUndefined();
    sys.restart();
    await sys.client.requireEvidence(sys.disputeId, "SELLER_EVIDENCE", "later-provider-request");
    expect((await sys.api("reassess")).body.postExecutionReview.providerStatus).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect((await sys.approve()).status).toBe(409);
  });

  it("holds an unchanged waiting state when the follow-up read failed", async () => {
    const sys = await setup();
    await acknowledgeWithoutFollowup(sys);
    sys.sim.state.disputes.get(sys.disputeId)!.status = "WAITING_FOR_SELLER_RESPONSE";
    expect((await sys.api("reassess")).body.status).toBe("executed");
    expect((await sys.approve()).status).toBe(409);
    expect(sys.sim.state.actionLog.filter(a => a.rel === "provide_evidence")).toHaveLength(1);
  });

  it("preserves unknown outcome across SQLite restart and refuses a new intent", async () => {
    const sys = await setup();
    const provide = sys.client.provideEvidence.bind(sys.client);
    vi.spyOn(sys.client, "provideEvidence").mockImplementation(async (...args) => {
      expect(sys.db().getCase(sys.disputeId)?.pendingAction?.requestId).toBe(args[2]);
      await provide(...args);
      throw new TypeError("provider committed; response lost");
    });
    await sys.api("reassess");
    await sys.approve();
    expect((await sys.api("execute")).body.error).toBe("unknown_outcome");
    const pending = sys.db().getCase(sys.disputeId)?.pendingAction;
    sys.restart();
    expect(sys.db().getCase(sys.disputeId)?.pendingAction).toEqual(pending);
    expect((await sys.api("reassess")).body.error).toBe("manual_reconciliation_required");
    expect((await sys.api("execute")).body.error).toBe("manual_reconciliation_required");
    expect(sys.sim.state.actionLog.filter(a => a.rel === "provide_evidence")).toHaveLength(1);
  });
});
