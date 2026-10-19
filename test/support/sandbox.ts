import { PayPalClient } from "../../src/paypal/client.js";
import { createSimulator, type SimulatorOptions } from "../../src/simulator/app.js";

export interface Delivery {
  headers: Headers;
  event: Record<string, any>;
}

export function startSimulator(options: SimulatorOptions = {}) {
  const deliveries: Delivery[] = [];
  const sim = createSimulator({
    webhookUrl: "http://listener.test/webhooks/paypal",
    deliver: async (_url, init) => {
      deliveries.push({ headers: new Headers(init?.headers), event: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    },
    ...options,
  });
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
    return sim.app.request(String(url), init);
  };
  const client = new PayPalClient(
    { baseUrl: "http://localhost:4010", clientId: "id", clientSecret: "secret" },
    { fetch: fetchImpl },
  );
  const simPost = async (path: string, body?: unknown) => {
    const res = await sim.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { sim, client, deliveries, simPost, requests };
}

export type Sandbox = ReturnType<typeof startSimulator>;

export async function paidOrder(sb: Sandbox, tag = "1") {
  const created = await sb.client.createOrder(
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: `ref-${tag}`,
          amount: { currency_code: "USD", value: "48.00" },
          items: [{ name: "Ceramic pour-over set", quantity: "1", unit_amount: { currency_code: "USD", value: "48.00" } }],
          shipping: {
            name: { full_name: "Sam Buyer" },
            address: { address_line_1: "1 Main St", admin_area_2: "Austin", admin_area_1: "TX", postal_code: "78701", country_code: "US" },
          },
        },
      ],
    },
    `order-${tag}`,
  );
  await sb.simPost(`/_sim/orders/${created.id}/approve`);
  const captured = await sb.client.captureOrder(created.id, `capture-${tag}`);
  const captureId = captured.purchase_units[0]!.payments!.captures![0]!.id;
  return { orderId: created.id, captureId };
}

export async function openDispute(sb: Sandbox, captureId: string, note = "Never arrived") {
  const res = await sb.simPost("/_sim/disputes", {
    capture_id: captureId,
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    note,
  });
  await sb.sim.flushDeliveries();
  return res.body as { dispute_id: string; event_id: string };
}
