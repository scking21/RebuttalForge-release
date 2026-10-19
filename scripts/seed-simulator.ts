// Opens two disputes on the local stand-in so the UI has cases to show:
// one where a carrier scan supports the seller, one where the item never shipped.
// It only talks to the simulator's /_sim endpoints, which do not exist in PayPal.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PayPalClient, loadPayPalConfig } from "../src/paypal/client.js";
import type { SellerRecord } from "../src/agent/seller-records.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

const client = new PayPalClient(loadPayPalConfig());
if (!client.simulator) {
  console.error(`Refusing to seed ${client.baseUrl}: this script only works against the local stand-in.`);
  process.exit(1);
}

const apiUrl = process.env.DISPUTE_DESK_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const sellerDir = process.env.SELLER_RECORDS_DIR ?? "fixtures/seller-records";
const runId = Date.now().toString(36);

async function sim(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

interface Scenario {
  key: string;
  item: string;
  value: string;
  buyerNote: string;
  tracking?: { carrier: string; number: string };
  record: SellerRecord;
}

const scenarios: Scenario[] = [
  {
    key: "delivered",
    item: "Ceramic pour-over set",
    value: "48.00",
    buyerNote: "My parcel never arrived.",
    tracking: { carrier: "UPS", number: "1Z999AA10123456784" },
    record: {
      kind: "carrier_delivery_scan",
      label: "Carrier delivery scan (UPS)",
      fact: "UPS scan: delivered to front door, signed 'S. BUYER', 2026-10-04 14:12 local. Tracking 1Z999AA10123456784.",
      recordedAt: "2026-10-04T19:12:00Z",
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
    },
  },
  {
    key: "not-shipped",
    item: "Hand-thrown mug, set of two",
    value: "36.00",
    buyerNote: "It has been three weeks and nothing has shipped.",
    record: {
      kind: "not_shipped",
      label: "Seller fulfilment note",
      fact: "Item was out of stock and never shipped. No label was purchased and no carrier ever received a parcel for this order.",
      recordedAt: "2026-10-03T16:00:00Z",
    },
  },
];

await sim("/_sim/config", { webhook_url: `${apiUrl}/webhooks/paypal` });
mkdirSync(sellerDir, { recursive: true });

for (const s of scenarios) {
  const amount = { currency_code: "USD", value: s.value };
  const order = await client.createOrder(
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: `seed-${runId}-${s.key}`,
          description: s.item,
          amount,
          items: [{ name: s.item, quantity: "1", unit_amount: amount }],
          shipping: {
            name: { full_name: "Sam Buyer" },
            address: { address_line_1: "1 Main St", admin_area_2: "Austin", admin_area_1: "TX", postal_code: "78701", country_code: "US" },
          },
        },
      ],
    },
    `seed-${runId}-${s.key}-order`,
  );
  await sim(`/_sim/orders/${order.id}/approve`);
  const captured = await client.captureOrder(order.id, `seed-${runId}-${s.key}-capture`);
  const captureId = captured.purchase_units[0]?.payments?.captures?.[0]?.id;
  if (!captureId) throw new Error(`No capture on order ${order.id}`);
  if (s.tracking) {
    await client.addTracking(
      order.id,
      { captureId, trackingNumber: s.tracking.number, carrier: s.tracking.carrier, notifyPayer: false },
      `seed-${runId}-${s.key}-track`,
    );
  }
  writeFileSync(join(sellerDir, `${captureId}.json`), JSON.stringify([s.record], null, 2));
  const opened = await sim("/_sim/disputes", { capture_id: captureId, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", note: s.buyerNote });
  console.log(`${s.key}: dispute ${opened.dispute_id} on capture ${captureId}`);
}
