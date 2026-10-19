import { describe, expect, it } from "vitest";
import { PayPalError, type OrderInput } from "../src/paypal/client.js";
import { openDispute, paidOrder, startSimulator } from "./support/sandbox.js";

const rels = (d: { links: Array<{ rel: string }> }) => d.links.map((l) => l.rel).filter((r) => r !== "self").sort();

async function caught(p: Promise<unknown>): Promise<PayPalError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PayPalError);
  return err as PayPalError;
}

describe("simulator: auth and orders", () => {
  it("labels every response and issues one cached token", async () => {
    const sb = startSimulator();
    await paidOrder(sb);
    expect(sb.sim.state.tokensIssued).toBe(1);
    const res = await sb.sim.app.request("/v2/checkout/orders/NOPE", { headers: { authorization: "Bearer bad" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-dispute-desk-simulator")).toBe("true");
    expect(await res.json()).toMatchObject({ name: "AUTHENTICATION_FAILURE" });
  });

  it("refuses to capture an unapproved order, then captures and tracks after approval", async () => {
    const sb = startSimulator();
    const created = await sb.client.createOrder(
      { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] },
      "o1",
    );
    const err = await caught(sb.client.captureOrder(created.id, "c1"));
    expect(err).toMatchObject({ status: 422, name: "UNPROCESSABLE_ENTITY" });
    expect(err.body).toMatchObject({ details: [{ issue: "ORDER_NOT_APPROVED" }] });

    const { orderId, captureId } = await paidOrder(sb, "2");
    const capture = await sb.client.getCapture(captureId);
    expect(capture).toMatchObject({ status: "COMPLETED", supplementary_data: { related_ids: { order_id: orderId } } });

    await sb.client.addTracking(orderId, { captureId, trackingNumber: "1Z999", carrier: "UPS", notifyPayer: false }, "t1");
    const tracker = await sb.client.getTracking(captureId, "1Z999");
    expect(tracker).toMatchObject({ status: "SHIPPED", carrier: "UPS", tracking_number: "1Z999" });
    const order = await sb.client.getOrder(orderId);
    expect(order.purchase_units[0]?.shipping?.trackers?.[0]?.id).toBe(`${captureId}-1Z999`);
  });
});

describe("simulator: dispute state machine", () => {
  it("opens as OPEN/INQUIRY with the inquiry links and delivers a verifiable CREATED webhook", async () => {
    const sb = startSimulator();
    const { captureId } = await paidOrder(sb);
    const opened = await openDispute(sb, captureId);

    const dispute = await sb.client.getDispute(opened.dispute_id);
    expect(dispute).toMatchObject({
      status: "OPEN",
      dispute_life_cycle_stage: "INQUIRY",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      disputed_transactions: [{ seller_transaction_id: captureId }],
    });
    expect(rels(dispute)).toEqual(["accept_claim", "escalate", "make_offer", "send_message"]);
    expect(dispute.messages[0]).toMatchObject({ posted_by: "BUYER", content: "Never arrived" });

    expect(sb.deliveries).toHaveLength(1);
    const { headers, event } = sb.deliveries[0]!;
    expect(event).toMatchObject({ id: opened.event_id, event_type: "CUSTOMER.DISPUTE.CREATED", resource_type: "dispute" });
    const webhookHeaders = {
      authAlgo: headers.get("paypal-auth-algo")!,
      certUrl: headers.get("paypal-cert-url")!,
      transmissionId: headers.get("paypal-transmission-id")!,
      transmissionSig: headers.get("paypal-transmission-sig")!,
      transmissionTime: headers.get("paypal-transmission-time")!,
    };
    expect(await sb.client.verifyWebhookSignature({ headers: webhookHeaders, webhookId: "WH", event })).toBe(true);
    expect(await sb.client.verifyWebhookSignature({ headers: webhookHeaders, webhookId: "WH", event: { ...event, summary: "tampered" } })).toBe(false);
    expect(
      await sb.client.verifyWebhookSignature({ headers: { ...webhookHeaders, transmissionId: "never-sent" }, webhookId: "WH", event }),
    ).toBe(false);
  });

  it("walks escalate -> require-evidence -> provide-evidence -> adjudicate", async () => {
    const sb = startSimulator();
    const { captureId } = await paidOrder(sb);
    const { dispute_id: id } = await openDispute(sb, captureId);

    await sb.client.escalate(id, "seller disagrees", "esc");
    let d = await sb.client.getDispute(id);
    expect(d).toMatchObject({ status: "UNDER_REVIEW", dispute_life_cycle_stage: "CHARGEBACK" });
    expect(rels(d)).toEqual(["adjudicate", "require_evidence"]);

    await sb.client.requireEvidence(id, "SELLER_EVIDENCE", "req");
    d = await sb.client.getDispute(id);
    expect(d.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(rels(d)).toEqual(["accept_claim", "provide_evidence"]);

    const res = await sb.client.provideEvidence(
      id,
      { evidenceType: "PROOF_OF_FULFILLMENT", tracking: { carrierName: "UPS", trackingNumber: "1Z999" }, notes: "delivered" },
      "ev",
    );
    expect(res.httpStatus).toBe(200);
    d = await sb.client.getDispute(id);
    expect(d.status).toBe("UNDER_REVIEW");
    expect(d.evidences).toHaveLength(1);
    expect(d.evidences[0]).toMatchObject({
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999" }] },
      notes: "delivered",
    });

    await sb.client.adjudicate(id, "SELLER_FAVOR", "adj");
    d = await sb.client.getDispute(id);
    expect(d).toMatchObject({ status: "RESOLVED", dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" } });
    expect(rels(d)).toEqual([]);

    await sb.sim.flushDeliveries();
    expect(sb.deliveries.map((x) => x.event.event_type)).toEqual([
      "CUSTOMER.DISPUTE.CREATED",
      "CUSTOMER.DISPUTE.UPDATED",
      "CUSTOMER.DISPUTE.UPDATED",
      "CUSTOMER.DISPUTE.UPDATED",
      "CUSTOMER.DISPUTE.RESOLVED",
    ]);
  });

  it("accept-claim resolves for the buyer and records exactly one refund", async () => {
    const sb = startSimulator();
    const { orderId, captureId } = await paidOrder(sb);
    const { dispute_id: id } = await openDispute(sb, captureId);

    await sb.client.acceptClaim(id, { note: "item never shipped" }, "acc");
    const d = await sb.client.getDispute(id);
    expect(d).toMatchObject({ status: "RESOLVED", dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" } });
    const order = await sb.client.getOrder(orderId);
    expect(order.purchase_units[0]?.payments?.refunds).toHaveLength(1);
    expect((await sb.client.getCapture(captureId)).status).toBe("REFUNDED");
  });

  it("make-offer works in INQUIRY, rejects amounts above the dispute, and is gone after escalate", async () => {
    const sb = startSimulator();
    const { captureId } = await paidOrder(sb);
    const { dispute_id: id } = await openDispute(sb, captureId);

    const tooMuch = await caught(
      sb.client.makeOffer(id, { note: "n", offerType: "REFUND", amount: { currency_code: "USD", value: "99.00" } }, "o-big"),
    );
    expect(tooMuch).toMatchObject({ status: 422 });

    await sb.client.makeOffer(id, { note: "partial", offerType: "REFUND", amount: { currency_code: "USD", value: "20.00" } }, "o1");
    let d = await sb.client.getDispute(id);
    expect(d.status).toBe("WAITING_FOR_BUYER_RESPONSE");
    expect(d).toMatchObject({ offer: { seller_offered_amount: { value: "20.00" } } });
    expect(rels(d)).toEqual(["escalate"]);

    await sb.client.escalate(id, "buyer declined", "e1");
    const afterEscalate = await caught(
      sb.client.makeOffer(id, { note: "n", offerType: "REFUND", amount: { currency_code: "USD", value: "20.00" } }, "o2"),
    );
    expect(afterEscalate).toMatchObject({ status: 422 });
  });

  it("send-message appends a seller message and stays in INQUIRY", async () => {
    const sb = startSimulator();
    const { captureId } = await paidOrder(sb);
    const { dispute_id: id } = await openDispute(sb, captureId);
    await sb.client.sendMessage(id, "Tracking attached", "m1");
    const d = await sb.client.getDispute(id);
    expect(d.messages.at(-1)).toMatchObject({ posted_by: "SELLER", content: "Tracking attached" });
    expect(d.status).toBe("OPEN");
  });
});

describe("simulator: errors", () => {
  it("returns a PayPal-style 422 when the rel is not in the current links, and changes nothing", async () => {
    const sb = startSimulator();
    const { captureId } = await paidOrder(sb);
    const { dispute_id: id } = await openDispute(sb, captureId);

    const err = await caught(
      sb.client.provideEvidence(id, { evidenceType: "PROOF_OF_FULFILLMENT", notes: "x" }, "ev-too-early"),
    );
    expect(err).toMatchObject({ status: 422, name: "UNPROCESSABLE_ENTITY" });
    expect(err.debugId).toBeTruthy();
    expect(err.body).toMatchObject({
      name: "UNPROCESSABLE_ENTITY",
      debug_id: expect.any(String),
      details: [{ issue: "ACTION_NOT_ALLOWED_IN_CURRENT_STATE" }],
    });
    expect(sb.sim.state.actionLog).toEqual([]);
    expect((await sb.client.getDispute(id)).status).toBe("OPEN");

    const sandboxOnly = await caught(sb.client.adjudicate(id, "BUYER_FAVOR", "adj-early"));
    expect(sandboxOnly.status).toBe(422);
  });

  it("returns 404 for unknown disputes and rejects multipart for no-attachment acceptance", async () => {
    const sb = startSimulator();
    expect(await caught(sb.client.getDispute("PP-D-0"))).toMatchObject({ status: 404, name: "RESOURCE_NOT_FOUND" });

    const { captureId } = await paidOrder(sb);
    const { dispute_id: id } = await openDispute(sb, captureId);
    const tokenRes = await sb.sim.app.request("/v1/oauth2/token", {
      method: "POST",
      headers: { authorization: `Basic ${btoa("a:b")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const token = ((await tokenRes.json()) as { access_token: string }).access_token;
    const post = (body: string, contentType: string) =>
      sb.sim.app.request(`/v1/customer/disputes/${id}/accept-claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body,
      });

    const wrongPart = await post(
      `--B\r\nContent-Disposition: form-data; name="wrong"\r\nContent-Type: application/json\r\n\r\n{}\r\n--B--\r\n`,
      "multipart/form-data; boundary=B",
    );
    expect(wrongPart.status).toBe(415);
    const untypedPart = await post(
      `--B\r\nContent-Disposition: form-data; name="accept-claim-document"\r\n\r\n{"note":"n","accept_claim_type":"REFUND"}\r\n--B--\r\n`,
      "multipart/form-data; boundary=B",
    );
    expect(untypedPart.status).toBe(415);
    const plainJson = await post(`{"note":"n","accept_claim_type":"REFUND"}`, "application/json");
    expect(plainJson.status).toBe(200);
  });
});

describe("simulator: idempotency and redelivery", () => {
  it("replays the first response for a repeated PayPal-Request-Id and acts once", async () => {
    const sb = startSimulator();
    const { orderId, captureId } = await paidOrder(sb);
    const { dispute_id: id } = await openDispute(sb, captureId);

    const first = await sb.client.acceptClaim(id, { note: "n" }, "same-id");
    const second = await sb.client.acceptClaim(id, { note: "n" }, "same-id");
    expect(second).toEqual(first);
    expect(sb.sim.state.actionLog.filter((a) => a.rel === "accept_claim")).toHaveLength(1);
    expect((await sb.client.getOrder(orderId)).purchase_units[0]?.payments?.refunds).toHaveLength(1);

    const fresh = await caught(sb.client.acceptClaim(id, { note: "n" }, "other-id"));
    expect(fresh.status).toBe(422);
  });

  it("makes a repeated order create with one request id return the same order", async () => {
    const sb = startSimulator();
    const input: OrderInput = { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "5.00" } }] };
    const a = await sb.client.createOrder(input, "same");
    const b = await sb.client.createOrder(input, "same");
    expect(b.id).toBe(a.id);
    expect(sb.sim.state.orders.size).toBe(1);
  });

  it("redelivers the same event with a fresh transmission that still verifies", async () => {
    const sb = startSimulator();
    const { captureId } = await paidOrder(sb);
    const opened = await openDispute(sb, captureId);

    const res = await sb.simPost(`/_sim/webhooks/redeliver/${opened.event_id}`);
    expect(res.body).toMatchObject({ event_id: opened.event_id, listener_status: 200 });
    expect(sb.deliveries).toHaveLength(2);
    const [a, b] = sb.deliveries;
    expect(b!.event).toEqual(a!.event);
    expect(b!.headers.get("paypal-transmission-id")).not.toBe(a!.headers.get("paypal-transmission-id"));
    expect(sb.sim.state.deliveryErrors).toEqual([]);
  });

  it("filters the dispute list by transaction id and rejects unsupported filters", async () => {
    const sb = startSimulator();
    const one = await paidOrder(sb, "a");
    const two = await paidOrder(sb, "b");
    const d1 = await openDispute(sb, one.captureId);
    await openDispute(sb, two.captureId);
    const list = await sb.client.listDisputes({ disputed_transaction_id: one.captureId });
    expect(list.items.map((i) => i.dispute_id)).toEqual([d1.dispute_id]);
    expect(await caught(sb.client.listDisputes({ dispute_state: "RESOLVED" }))).toMatchObject({ status: 400 });
  });
});
