import { OPERATOR_REQUEST_HEADERS } from "../src/request-integrity.js";
import { describe, expect, it } from "vitest";
import { scriptedBranch } from "../src/agent/test-double.js";
import type { SellerRecord } from "../src/agent/seller-records.js";
import { PayPalClient } from "../src/paypal/client.js";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";
import { buyerOpensDispute, sellOne, startSystem } from "./support/system.js";

const UPS = { carrierName: "UPS", trackingNumber: "1Z999" };
const deliveredScan: SellerRecord = {
  kind: "carrier_delivery_scan",
  label: "Carrier delivery scan (UPS)",
  fact: "UPS delivered to front door on 2026-10-04.",
  recordedAt: "2026-10-04T19:12:00Z",
  carrier: "UPS",
  trackingNumber: "1Z999",
};
const notShipped: SellerRecord = {
  kind: "not_shipped",
  label: "Seller fulfilment note",
  fact: "Item was out of stock and never shipped.",
  recordedAt: "2026-10-03T16:00:00Z",
};

describe("end to end: contest branch", () => {
  it("recommends, is blocked by the guard until PayPal permits it, then approve -> execute -> adjudicate", async () => {
    const model = scriptedBranch("contest", UPS);
    const sys = startSystem({ model });
    const { captureId } = await sellOne(sys, "a", { carrier: "UPS", number: "1Z999" });
    sys.records[captureId] = [deliveredScan];

    const { disputeId } = await buyerOpensDispute(sys, captureId);
    let { body: c } = await sys.api("GET", `/api/cases/${disputeId}`);
    expect(c).toMatchObject({ status: "evidence_gathered", assessment: { kind: "hold", reason: "UNSUPPORTED_RESPONSE" } });
    expect(c.guardFailures).toEqual([{ code: "SELLER_RESPONSE_NOT_REQUESTED" }, { code: "ACTION_NOT_PERMITTED", action: "contest", rel: "provide_evidence" }]);
    const tracking = c.evidence.find((e: any) => e.source === "paypal.tracking");
    expect(tracking.label).toMatch(/not proof of delivery/i);
    expect(c.evidence.some((e: any) => e.source === "seller.record")).toBe(true);

    const blocked = await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "seller@example.com", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("not_approvable");

    await sys.client.escalate(disputeId, "seller disputes the claim", "esc-a");
    const required = await sys.api("POST", `/api/sandbox/disputes/${disputeId}/require-evidence`, {});
    expect(required).toMatchObject({ status: 200, body: { simulated_resolution: true } });
    await sys.sim.flushDeliveries();

    ({ body: c } = await sys.api("GET", `/api/cases/${disputeId}`));
    expect(c.permittedRels).toContain("provide_evidence");
    expect(c.guardFailures).toEqual([]);

    const noBody = await sys.api("POST", `/api/cases/${disputeId}/approve`, {});
    expect(noBody.status).toBe(400);
    const early = await sys.api("POST", `/api/cases/${disputeId}/execute`);
    expect(early.status).toBe(409);

    const approved = await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "seller@example.com", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision });
    expect(approved).toMatchObject({ status: 200, body: { status: "approved", approvedBy: "seller@example.com" } });

    const executed = await sys.api("POST", `/api/cases/${disputeId}/execute`);
    expect(executed).toMatchObject({ status: 200, body: { status: "executed", execution: { action: "contest", httpStatus: 200 } } });
    const dispute = await sys.client.getDispute(disputeId);
    expect(dispute.status).toBe("UNDER_REVIEW");
    expect(dispute.evidences).toHaveLength(1);

    const again = await sys.api("POST", `/api/cases/${disputeId}/execute`);
    expect(again.status).toBe(200);
    expect(sys.sim.state.actionLog.filter((a) => a.rel === "provide_evidence")).toHaveLength(1);

    const adjudicated = await sys.api("POST", `/api/sandbox/disputes/${disputeId}/adjudicate`, { outcome: "SELLER_FAVOR" });
    expect(adjudicated.body.simulated_resolution).toBe(true);
    await sys.sim.flushDeliveries();
    ({ body: c } = await sys.api("GET", `/api/cases/${disputeId}`));
    expect(c).toMatchObject({ status: "resolved", outcome: "RESOLVED_SELLER_FAVOUR" });
    expect(c.audit.map((a: any) => a.kind)).toEqual(expect.arrayContaining(["case.created", "approved", "paypal.action", "webhook.received"]));
    expect(sys.sim.state.deliveryErrors).toEqual([]);
  });
});

describe("end to end: concede branch", () => {
  it("concedes through accept-claim alone and records one refund", async () => {
    const sys = startSystem({ model: scriptedBranch("concede") });
    const { orderId, captureId } = await sellOne(sys, "b");
    sys.records[captureId] = [notShipped];

    const { disputeId } = await buyerOpensDispute(sys, captureId);
    let { body: c } = await sys.api("GET", `/api/cases/${disputeId}`);
    expect(c).toMatchObject({ status: "recommended", assessment: { kind: "actionable", recommendation: { action: "concede" } }, guardFailures: [] });
    expect(c.evidence.find((e: any) => e.source === "paypal.tracking").fact).toMatch(/does not establish whether tracking was submitted or the item shipped/);

    await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "seller@example.com", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision });
    sys.fetchCalls.length = 0;
    const executed = await sys.api("POST", `/api/cases/${disputeId}/execute`);
    expect(executed.body).toMatchObject({ status: "resolved", outcome: "RESOLVED_BUYER_FAVOUR", execution: { action: "concede" } });
    const disputeWrites = sys.fetchCalls.filter((r) => r.startsWith("POST /v1/customer/"));
    expect(disputeWrites).toEqual([`POST /v1/customer/disputes/${disputeId}/accept-claim`]);
    expect(sys.fetchCalls.some((r) => /refund/i.test(r))).toBe(false);

    const order = await sys.client.getOrder(orderId);
    expect(order.purchase_units[0]?.payments?.refunds).toHaveLength(1);

    await sys.sim.flushDeliveries();
    ({ body: c } = await sys.api("GET", `/api/cases/${disputeId}`));
    expect(c.status).toBe("resolved");
    expect(c.audit.some((a: any) => a.kind === "webhook.ignored" || a.kind === "webhook.received")).toBe(true);
  });
});

describe("webhook handling", () => {
  it("processes a duplicate event id once", async () => {
    const model = scriptedBranch("concede");
    const sys = startSystem({ model });
    const { captureId } = await sellOne(sys, "c");
    sys.records[captureId] = [notShipped];
    const { disputeId, eventId } = await buyerOpensDispute(sys, captureId);
    expect(model.calls).toHaveLength(1);
    const before = (await sys.api("GET", `/api/cases/${disputeId}`)).body;

    const redelivered = await sys.simPost(`/_sim/webhooks/redeliver/${eventId}`);
    expect(redelivered.body.listener_status).toBe(200);

    const after = (await sys.api("GET", `/api/cases/${disputeId}`)).body;
    expect(model.calls).toHaveLength(1);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.audit.filter((a: any) => a.kind === "webhook.duplicate")).toHaveLength(1);
    expect(after.audit.filter((a: any) => a.kind === "webhook.received")).toHaveLength(1);
  });

  it("rejects a forged event whose signature does not verify", async () => {
    const sys = startSystem({ model: scriptedBranch("concede") });
    const res = await sys.server.request("/webhooks/paypal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": "forged",
        "paypal-transmission-time": "2026-10-09T00:00:00Z",
        "paypal-transmission-sig": "forged",
        "paypal-cert-url": "https://example.test/cert",
        "paypal-auth-algo": "SHA256withRSA",
      },
      body: JSON.stringify({ id: "WH-FAKE", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1" } }),
    });
    expect(res.status).toBe(401);
    expect((await sys.api("GET", "/api/cases")).body).toEqual([]);
  });

  it("answers 500 and releases the event when processing fails, so a redelivery succeeds", async () => {
    const sys = startSystem({ model: scriptedBranch("concede") });
    const { captureId } = await sellOne(sys, "d");
    sys.records[captureId] = [notShipped];
    sys.failures.getDisputeOnce = true;
    const { disputeId, eventId } = await buyerOpensDispute(sys, captureId);
    expect(sys.sim.state.deliveryErrors).toEqual([expect.stringContaining("listener answered 500")]);
    expect((await sys.api("GET", `/api/cases/${disputeId}`)).status).toBe(404);

    await sys.simPost(`/_sim/webhooks/redeliver/${eventId}`);
    expect((await sys.api("GET", `/api/cases/${disputeId}`)).body.status).toBe("recommended");
  });
});

describe("AI not configured", () => {
  it("stops at evidence_gathered with a plain error instead of fabricating a recommendation", async () => {
    const sys = startSystem();
    const { captureId } = await sellOne(sys, "e");
    sys.records[captureId] = [notShipped];
    const { disputeId } = await buyerOpensDispute(sys, captureId);

    const { body: c } = await sys.api("GET", `/api/cases/${disputeId}`);
    expect(c).toMatchObject({ status: "evidence_gathered", error: "AI not configured" });
    expect(c.assessment?.recommendation).toBeUndefined();
    expect((await sys.api("GET", "/api/health")).body).toMatchObject({ aiConfigured: false, simulator: true });
    const approve = await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "x", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision });
    expect(approve.status).toBe(409);
  });

  it("reassess creates the case from PayPal when no webhook arrived", async () => {
    const sys = startSystem({ model: scriptedBranch("concede") });
    const { captureId } = await sellOne(sys, "f");
    sys.records[captureId] = [notShipped];
    sys.sim.setWebhookUrl(undefined);
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    expect((await sys.api("GET", "/api/cases")).body).toEqual([]);

    const res = await sys.api("POST", `/api/cases/${disputeId}/reassess`);
    expect(res).toMatchObject({ status: 200, body: { status: "recommended" } });
    expect((await sys.api("POST", "/api/cases/PP-D-404/reassess")).status).toBe(404);
  });
});

describe("reassess after execution", () => {
  it("marks an executed case resolved when PayPal resolved it and no webhook arrived", async () => {
    const sys = startSystem({ model: scriptedBranch("concede") });
    const { captureId } = await sellOne(sys, "g");
    sys.records[captureId] = [notShipped];
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "seller@example.com", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision });
    sys.sim.setWebhookUrl(undefined);
    await sys.client.acceptClaim(disputeId, { note: "n" }, "out-of-band");

    const stale = await sys.api("GET", `/api/cases/${disputeId}`);
    expect(stale.body.status).toBe("approved");
    const synced = await sys.api("POST", `/api/cases/${disputeId}/reassess`);
    expect(synced).toMatchObject({ status: 200, body: { status: "resolved", outcome: "RESOLVED_BUYER_FAVOUR" } });
  });
});

describe("sandbox helpers", () => {
  it("answer 403 when the PayPal base URL is neither sandbox nor the simulator", async () => {
    const client = new PayPalClient({ baseUrl: "https://paypal.example.test", clientId: "i", clientSecret: "s" }, {
      fetch: async () => {
        throw new Error("must not call PayPal");
      },
    });
    const app = createApp({ client, store: new Store(), sellerRecords: () => [] });
    for (const path of ["require-evidence", "adjudicate"]) {
      const res = await app.request(`/api/sandbox/disputes/PP-D-1/${path}`, { method: "POST", body: "{}", headers: { "content-type": "application/json", ...OPERATOR_REQUEST_HEADERS } });
      expect(res.status).toBe(403);
    }
  });

  it("allow CORS from the web dev server only", async () => {
    const sys = startSystem();
    const ok = await sys.server.request("/api/health", { headers: { origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await sys.server.request("/api/health", { headers: { origin: "http://evil.test" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
