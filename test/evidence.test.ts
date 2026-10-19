import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gatherEvidence } from "../src/agent/evidence.js";
import { fileSellerRecords, type SellerRecord } from "../src/agent/seller-records.js";
import { openDispute, paidOrder, startSimulator } from "./support/sandbox.js";

const delivery: SellerRecord = {
  kind: "carrier_delivery_scan",
  label: "Carrier delivery scan (UPS)",
  fact: "UPS delivered to front door 2026-10-04.",
  recordedAt: "2026-10-04T19:12:00Z",
  trackingNumber: "1Z999",
};

async function scenario(withTracking: boolean) {
  const sb = startSimulator();
  const { orderId, captureId } = await paidOrder(sb);
  if (withTracking) {
    await sb.client.addTracking(orderId, { captureId, trackingNumber: "1Z999", carrier: "UPS", notifyPayer: false }, "t");
  }
  const { dispute_id } = await openDispute(sb, captureId, "Where is my parcel?");
  return { sb, captureId, disputeId: dispute_id };
}

describe("gatherEvidence", () => {
  it("builds stable E-ids from dispute, order, tracking, seller record and messages", async () => {
    const { sb, disputeId, captureId } = await scenario(true);
    const loader = (id: string) => (id === captureId ? [delivery] : []);
    const a = await gatherEvidence(sb.client, disputeId, loader, new Date("2026-10-09T00:00:00Z"));
    const b = await gatherEvidence(sb.client, disputeId, loader, new Date("2026-10-09T00:00:00Z"));
    expect(b.evidence).toEqual(a.evidence);
    expect(a.evidence.map((e) => e.id)).toEqual(a.evidence.map((_, i) => `E${i + 1}`));
    expect(a.evidence.map((e) => e.source)).toEqual([
      "paypal.dispute",
      "paypal.dispute",
      "paypal.order",
      "paypal.order",
      "paypal.order",
      "paypal.tracking",
      "seller.record",
      "paypal.dispute",
    ]);
    const byLabel = (needle: string) => a.evidence.find((e) => e.label.includes(needle))!;
    expect(byLabel("Item purchased").fact).toContain("Ceramic pour-over set x1");
    expect(byLabel("Shipping address").fact).toContain("Austin");
    expect(byLabel("message from BUYER").fact).toContain("Where is my parcel?");
    expect(a.dispute.dispute_id).toBe(disputeId);
  });

  it("labels PayPal tracking as the seller's own submission and keeps delivery proof with the seller record", async () => {
    const { sb, disputeId, captureId } = await scenario(true);
    const { evidence } = await gatherEvidence(sb.client, disputeId, (id) => (id === captureId ? [delivery] : []));
    const tracking = evidence.find((e) => e.source === "paypal.tracking")!;
    expect(tracking.label).toMatch(/not proof of delivery/i);
    expect(tracking.fact).toMatch(/seller told PayPal/);
    expect(tracking.fact).toMatch(/does not show the parcel was delivered/);
    expect(tracking.fact).not.toMatch(/\bdelivered\b.*\bto front door/);

    const deliveryEvidence = evidence.filter((e) => /deliver/i.test(e.fact) && !e.fact.includes("does not show"));
    expect(deliveryEvidence.map((e) => e.source)).toContain("seller.record");
    expect(evidence.find((e) => e.source === "seller.record")?.fact).toContain("UPS delivered to front door");
  });

  it("states lookup limitations without claiming no tracking or non-shipment", async () => {
    const { sb, disputeId } = await scenario(false);
    const { evidence } = await gatherEvidence(sb.client, disputeId, () => []);
    expect(evidence.find((e) => e.source === "paypal.tracking")?.fact).toMatch(/does not establish whether tracking was submitted or the item shipped/);
    expect(evidence.some((e) => e.source === "seller.record")).toBe(false);
  });
});

describe("fileSellerRecords", () => {
  it("reads <capture_id>.json, returns [] for a missing file, and refuses path-like ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "records-"));
    writeFileSync(join(dir, "CAP1.json"), JSON.stringify([delivery]));
    const load = fileSellerRecords(dir);
    expect(load("CAP1")).toEqual([delivery]);
    expect(load("CAP2")).toEqual([]);
    expect(load("../CAP1")).toEqual([]);
  });

  it("loads the shipped example fixtures", () => {
    const load = fileSellerRecords("fixtures/seller-records");
    expect(load("EXAMPLE_DELIVERED")[0]?.kind).toBe("carrier_delivery_scan");
    expect(load("EXAMPLE_NOT_SHIPPED")[0]?.kind).toBe("not_shipped");
  });
});

describe('capture identity and purchase-unit selection', () => {
  async function setup() {
    const s = await scenario(false);
    const capture = await s.sb.client.getCapture(s.captureId);
    const order = await s.sb.client.getOrder(capture.supplementary_data!.related_ids!.order_id!);
    return { ...s, capture, order };
  }
  it('takes items and address from the unit containing the capture, even when it is second', async () => {
    const s = await setup();
    s.order.purchase_units.unshift({ items: [{ name: 'WRONG ITEM' }], shipping: { address: { admin_area_2: 'WRONG CITY' } }, payments: { captures: [{ id: 'OTHER', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] } });
    s.sb.client.getOrder = async () => s.order;
    const result = await gatherEvidence(s.sb.client, s.disputeId, () => []);
    expect(result.evidence.find(e => e.label === 'Item purchased')?.fact).toContain('Ceramic');
    expect(JSON.stringify(result.evidence)).not.toContain('WRONG');
  });
  it.each(['absent', 'ambiguous', 'wrong-capture', 'wrong-order', 'missing-order', 'wrong-dispute', 'ambiguous-dispute'])('refuses %s identity', async mode => {
    const s = await setup();
    if (mode === 'absent') s.order.purchase_units = [];
    if (mode === 'ambiguous') s.order.purchase_units.push(structuredClone(s.order.purchase_units[0]!));
    if (mode === 'wrong-capture') s.capture.id = 'WRONG';
    if (mode === 'wrong-order') s.order.id = 'WRONG';
    if (mode === 'missing-order') s.capture.supplementary_data = undefined;
    const dispute = await s.sb.client.getDispute(s.disputeId);
    if (mode === 'wrong-dispute') dispute.dispute_id = 'WRONG';
    if (mode === 'ambiguous-dispute') dispute.disputed_transactions.push({ seller_transaction_id: 'OTHER' });
    s.sb.client.getDispute = async () => dispute;
    s.sb.client.getCapture = async () => s.capture;
    s.sb.client.getOrder = async () => s.order;
    await expect(gatherEvidence(s.sb.client, s.disputeId, () => [])).rejects.toThrow(/identity|capture|order|purchase unit/i);
  });
});
