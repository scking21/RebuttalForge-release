import type { Hono } from "hono";
import type { Model } from "../../src/agent/model.js";
import type { SellerRecord } from "../../src/agent/seller-records.js";
import { PayPalClient } from "../../src/paypal/client.js";
import { createApp } from "../../src/server.js";
import { createSimulator } from "../../src/simulator/app.js";
import { Store } from "../../src/store.js";
import { OPERATOR_REQUEST_HEADERS } from "../../src/request-integrity.js";

export const WEBHOOK_ID = "WH-TEST";

export interface SystemOptions {
  model?: Model;
  records?: Record<string, SellerRecord[]>;
  operatorToken?: string;
}

// Simulator and server wired to each other in-process: no ports, real HTTP semantics via Hono.
export function startSystem(options: SystemOptions = {}) {
  let server!: Hono;
  const sim = createSimulator({
    webhookUrl: "http://server.test/webhooks/paypal",
    deliver: async (url, init) => server.request(String(url), init),
  });
  const records = options.records ?? {};
  const fetchCalls: string[] = [];
  const failures: { getDisputeOnce: boolean; when?: (call: string) => boolean } = { getDisputeOnce: false };
  const client = new PayPalClient(
    { baseUrl: "http://localhost:4010", clientId: "id", clientSecret: "secret" },
    {
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        fetchCalls.push(`${init?.method ?? "GET"} ${path}`);
        if (failures.when?.(`${init?.method ?? "GET"} ${path}`)) throw new TypeError("simulated network failure");
        if (failures.getDisputeOnce && (init?.method ?? "GET") === "GET" && path.startsWith("/v1/customer/disputes/")) {
          failures.getDisputeOnce = false;
          throw new TypeError("simulated network failure");
        }
        return sim.app.request(String(url), init);
      },
    },
  );
  const store = new Store();
  server = createApp({
    client,
    store,
    model: options.model,
    sellerRecords: (captureId) => records[captureId] ?? [],
    webhookId: WEBHOOK_ID,
    operatorToken: options.operatorToken,
  });

  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await server.request(path, {
      method,
      headers: { "content-type": "application/json", ...(method === "GET" ? {} : OPERATOR_REQUEST_HEADERS), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const simPost = async (path: string, body?: unknown) => {
    const res = await sim.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { sim, client, store, server, api, simPost, records, fetchCalls, failures };
}

export type System = ReturnType<typeof startSystem>;

export async function sellOne(sys: System, tag: string, tracking?: { carrier: string; number: string }) {
  const created = await sys.client.createOrder(
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: "48.00" },
          items: [{ name: "Ceramic pour-over set", quantity: "1", unit_amount: { currency_code: "USD", value: "48.00" } }],
          shipping: { name: { full_name: "Sam Buyer" }, address: { address_line_1: "1 Main St", admin_area_2: "Austin", admin_area_1: "TX", postal_code: "78701", country_code: "US" } },
        },
      ],
    },
    `order-${tag}`,
  );
  await sys.simPost(`/_sim/orders/${created.id}/approve`);
  const captured = await sys.client.captureOrder(created.id, `capture-${tag}`);
  const captureId = captured.purchase_units[0]!.payments!.captures![0]!.id;
  if (tracking) {
    await sys.client.addTracking(created.id, { captureId, trackingNumber: tracking.number, carrier: tracking.carrier, notifyPayer: false }, `track-${tag}`);
  }
  return { orderId: created.id, captureId };
}

export async function buyerOpensDispute(sys: System, captureId: string, note = "My parcel never arrived") {
  const res = await sys.simPost("/_sim/disputes", { capture_id: captureId, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", note });
  await sys.sim.flushDeliveries();
  return { disputeId: res.body.dispute_id as string, eventId: res.body.event_id as string };
}
