import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { PAYPAL_REL, type Money } from "../domain.js";
import { SIMULATOR_HEADER } from "../paypal/client.js";
import type { DisputeStage, DisputeStatus } from "../paypal/schemas.js";

// A local stand-in for the PayPal sandbox. It is NOT evidence that the real
// sandbox behaves this way: every status transition, error name and issue code
// here is written from the task spec, not observed from PayPal.

interface SimOrder {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  intent: string;
  units: Array<Record<string, unknown> & { amount: Money }>;
  captureId?: string;
  trackers: Array<{ id: string; captureId: string; trackingNumber: string; carrier: string; createdAt: string }>;
}

interface SimRefund {
  id: string;
  amount: Money;
  createdAt: string;
  disputeId: string;
}

interface SimCapture {
  id: string;
  orderId: string;
  amount: Money;
  createdAt: string;
  refunds: SimRefund[];
}

interface SimDispute {
  id: string;
  reason: string;
  status: DisputeStatus;
  stage: DisputeStage;
  amount: Money;
  captureId: string;
  buyerTransactionId: string;
  createdAt: string;
  updatedAt: string;
  dueDate: string;
  messages: Array<{ posted_by: string; time_posted: string; content: string }>;
  evidences: Array<Record<string, unknown>>;
  offer?: { offer_type: string; seller_offered_amount: Money };
  outcome?: string;
}

interface SimEvent {
  id: string;
  body: Record<string, unknown>;
}

interface Result {
  status: number;
  body: unknown;
}

export interface SimulatorOptions {
  webhookUrl?: string;
  // Replace to deliver webhooks in-process instead of over HTTP.
  deliver?: typeof fetch;
  baseUrl?: string;
  tokenTtlSeconds?: number;
  now?: () => Date;
}

const ACTION_PATH: Record<string, string> = {
  [PAYPAL_REL.provideEvidence]: "provide-evidence",
  [PAYPAL_REL.makeOffer]: "make-offer",
  [PAYPAL_REL.acceptClaim]: "accept-claim",
  [PAYPAL_REL.sendMessage]: "send-message",
  [PAYPAL_REL.escalate]: "escalate",
  [PAYPAL_REL.requireEvidence]: "require-evidence",
  [PAYPAL_REL.adjudicate]: "adjudicate",
};

const MoneyIn = z.object({ currency_code: z.string().min(1), value: z.string().regex(/^\d+(\.\d{1,2})?$/) });
const OrderIn = z.object({
  intent: z.literal("CAPTURE"),
  purchase_units: z.array(z.object({ amount: MoneyIn }).passthrough()).min(1),
});
const TrackIn = z.object({
  capture_id: z.string().min(1),
  tracking_number: z.string().min(1),
  carrier: z.string().min(1),
  notify_payer: z.boolean().optional(),
});
const EvidenceIn = z.object({
  evidences: z
    .array(
      z
        .object({
          evidence_type: z.string().min(1),
          evidence_info: z
            .object({
              tracking_info: z
                .array(z.object({ carrier_name: z.string().min(1), tracking_number: z.string().min(1) }))
                .optional(),
            })
            .passthrough()
            .optional(),
          notes: z.string().max(2000).optional(),
        })
        .passthrough(),
    )
    .min(1),
});
const OfferIn = z.object({
  note: z.string().max(2000),
  offer_type: z.enum(["REFUND", "REFUND_WITH_RETURN", "REFUND_WITH_REPLACEMENT", "REPLACEMENT_WITHOUT_REFUND"]),
  offer_amount: MoneyIn,
});
const AcceptIn = z.object({
  note: z.string().max(2000),
  accept_claim_type: z.enum(["REFUND", "REFUND_WITH_RETURN", "PARTIAL_REFUND"]),
});
const MessageIn = z.object({ message: z.string().min(1).max(2000) });
const EscalateIn = z.object({ note: z.string().max(2000) });
const RequireIn = z.object({ action: z.enum(["SELLER_EVIDENCE", "BUYER_EVIDENCE"]) });
const AdjudicateIn = z.object({ adjudication_outcome: z.enum(["BUYER_FAVOR", "SELLER_FAVOR"]) });
const VerifyIn = z.object({
  auth_algo: z.string().min(1),
  cert_url: z.string().min(1),
  transmission_id: z.string().min(1),
  transmission_sig: z.string().min(1),
  transmission_time: z.string().min(1),
  webhook_id: z.string().min(1),
  webhook_event: z.record(z.string(), z.unknown()),
});
const SimDisputeIn = z.object({
  capture_id: z.string().min(1),
  reason: z.string().default("MERCHANDISE_OR_SERVICE_NOT_RECEIVED"),
  note: z.string().default(""),
});

function fail(status: number, name: string, message: string, issue?: string, description?: string): Result {
  return {
    status,
    body: {
      name,
      message,
      debug_id: randomBytes(6).toString("hex"),
      details: issue ? [{ issue, ...(description ? { description } : {}) }] : [],
    },
  };
}

const notFound = (what: string): Result =>
  fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", "INVALID_RESOURCE_ID", `${what} not found`);

const unprocessable = (issue: string, description: string): Result =>
  fail(
    422,
    "UNPROCESSABLE_ENTITY",
    "The requested action could not be performed, semantically incorrect, or failed business validation.",
    issue,
    description,
  );

const isResult = (v: unknown): v is Result => typeof v === "object" && v !== null && "status" in v && "body" in v;

function pid(len = 17): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  return Array.from(randomBytes(len), (b) => alphabet[b % alphabet.length]).join("");
}

function parseMultipart(contentType: string, text: string): Array<{ name: string; contentType: string; body: string }> {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return [];
  return text
    .split(`--${boundary}`)
    .slice(1)
    .filter((chunk) => !chunk.startsWith("--"))
    .map((chunk) => {
      const [head = "", ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
      const name = /name="([^"]+)"/.exec(head)?.[1] ?? "";
      const partType = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "";
      return { name, contentType: partType, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
    });
}

export function createSimulator(options: SimulatorOptions = {}) {
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const deliver = options.deliver ?? fetch;
  const baseUrl = options.baseUrl ?? "http://localhost:4010";
  const ttl = options.tokenTtlSeconds ?? 32400;
  let webhookUrl = options.webhookUrl;
  let disputeCounter = 0;

  const state = {
    tokens: new Map<string, number>(),
    tokensIssued: 0,
    orders: new Map<string, SimOrder>(),
    captures: new Map<string, SimCapture>(),
    disputes: new Map<string, SimDispute>(),
    events: new Map<string, SimEvent>(),
    transmissions: new Map<string, { sig: string; time: string; algo: string; event: Record<string, unknown> }>(),
    replays: new Map<string, Result>(),
    actionLog: [] as Array<{ disputeId: string; rel: string; requestId: string | undefined }>,
    deliveryErrors: [] as string[],
  };
  const pending = new Set<Promise<unknown>>();

  const relsFor = (d: SimDispute): string[] => {
    switch (d.status) {
      case "OPEN":
        return d.stage === "INQUIRY"
          ? [PAYPAL_REL.sendMessage, PAYPAL_REL.makeOffer, PAYPAL_REL.acceptClaim, PAYPAL_REL.escalate]
          : [];
      case "UNDER_REVIEW":
        return [PAYPAL_REL.requireEvidence, PAYPAL_REL.adjudicate];
      case "WAITING_FOR_SELLER_RESPONSE":
        return [PAYPAL_REL.provideEvidence, PAYPAL_REL.acceptClaim];
      case "WAITING_FOR_BUYER_RESPONSE":
        return d.offer ? [PAYPAL_REL.escalate] : [];
      default:
        return [];
    }
  };

  const disputeUrl = (d: SimDispute) => `${baseUrl}/v1/customer/disputes/${d.id}`;
  const linksFor = (d: SimDispute) => [
    { href: disputeUrl(d), rel: "self", method: "GET" },
    ...relsFor(d).map((rel) => ({ href: `${disputeUrl(d)}/${ACTION_PATH[rel]}`, rel, method: "POST" })),
  ];

  const disputeView = (d: SimDispute) => ({
    dispute_id: d.id,
    create_time: d.createdAt,
    update_time: d.updatedAt,
    reason: d.reason,
    status: d.status,
    dispute_life_cycle_stage: d.stage,
    dispute_amount: d.amount,
    disputed_transactions: [
      { seller_transaction_id: d.captureId, buyer_transaction_id: d.buyerTransactionId, gross_amount: d.amount },
    ],
    seller_response_due_date: d.dueDate,
    allowed_response_options: {
      make_offer: { offer_types: relsFor(d).includes(PAYPAL_REL.makeOffer) ? ["REFUND"] : [] },
      accept_claim: { accept_claim_types: relsFor(d).includes(PAYPAL_REL.acceptClaim) ? ["REFUND"] : [] },
    },
    messages: d.messages,
    evidences: d.evidences,
    ...(d.offer ? { offer: d.offer } : {}),
    ...(d.outcome ? { dispute_outcome: { outcome_code: d.outcome } } : {}),
    links: linksFor(d),
  });

  const captureView = (c: SimCapture) => ({
    id: c.id,
    status: c.refunds.length ? "REFUNDED" : "COMPLETED",
    amount: c.amount,
    final_capture: true,
    create_time: c.createdAt,
    update_time: c.createdAt,
    supplementary_data: { related_ids: { order_id: c.orderId } },
    links: [{ href: `${baseUrl}/v2/payments/captures/${c.id}`, rel: "self", method: "GET" }],
  });

  const orderView = (o: SimOrder) => {
    const capture = o.captureId ? state.captures.get(o.captureId) : undefined;
    return {
      id: o.id,
      status: o.status,
      intent: o.intent,
      purchase_units: o.units.map((u, i) => {
        const base = { ...u };
        const shipping = { ...(u.shipping as object | undefined) };
        const trackers =
          i === 0 ? o.trackers.map((t) => ({ id: t.id, create_time: t.createdAt })) : undefined;
        return {
          ...base,
          shipping: { ...shipping, ...(trackers?.length ? { trackers } : {}) },
          ...(i === 0 && capture
            ? {
                payments: {
                  captures: [captureView(capture)],
                  ...(capture.refunds.length
                    ? { refunds: capture.refunds.map((r) => ({ id: r.id, amount: r.amount, create_time: r.createdAt })) }
                    : {}),
                },
              }
            : {}),
        };
      }),
      links: [
        { href: `${baseUrl}/v2/checkout/orders/${o.id}`, rel: "self", method: "GET" },
        ...(o.status === "CREATED"
          ? [{ href: `${baseUrl}/_sim/orders/${o.id}/approve`, rel: "approve", method: "POST" }]
          : []),
      ],
    };
  };

  const sign = (transmissionId: string, time: string, body: string) =>
    createHash("sha256").update(`${transmissionId}|${time}|${body}`).digest("base64");

  async function send(event: SimEvent): Promise<number | undefined> {
    if (!webhookUrl) return undefined;
    const body = JSON.stringify(event.body);
    const transmissionId = randomUUID();
    const time = iso();
    const sig = sign(transmissionId, time, body);
    state.transmissions.set(transmissionId, { sig, time, algo: "SHA256withRSA", event: event.body });
    try {
      const res = await deliver(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "paypal-transmission-id": transmissionId,
          "paypal-transmission-time": time,
          "paypal-transmission-sig": sig,
          "paypal-cert-url": "https://simulator.invalid/cert.pem",
          "paypal-auth-algo": "SHA256withRSA",
        },
        body,
      });
      if (!res.ok) state.deliveryErrors.push(`${event.id}: listener answered ${res.status}`);
      return res.status;
    } catch (e) {
      state.deliveryErrors.push(`${event.id}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  function emit(type: string, d: SimDispute): SimEvent {
    const event: SimEvent = {
      id: `WH-${pid(20)}`,
      body: {
        id: "",
        event_version: "1.0",
        create_time: iso(),
        resource_type: "dispute",
        event_type: type,
        summary: `${type} for ${d.id}`,
        resource: disputeView(d),
      },
    };
    event.body.id = event.id;
    state.events.set(event.id, event);
    const p = send(event).finally(() => pending.delete(p));
    pending.add(p);
    return event;
  }

  const touch = (d: SimDispute) => {
    d.updatedAt = iso();
  };
  const plusDays = (days: number) => new Date(now().getTime() + days * 86_400_000).toISOString();

  function refundOnce(d: SimDispute) {
    const capture = state.captures.get(d.captureId);
    if (!capture || capture.refunds.some((r) => r.disputeId === d.id)) return;
    capture.refunds.push({ id: pid(), amount: d.amount, createdAt: iso(), disputeId: d.id });
  }

  function resolve(d: SimDispute, outcome: "RESOLVED_BUYER_FAVOUR" | "RESOLVED_SELLER_FAVOUR") {
    d.status = "RESOLVED";
    d.outcome = outcome;
    if (outcome === "RESOLVED_BUYER_FAVOUR") refundOnce(d);
  }

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set(SIMULATOR_HEADER, "true");
  });

  const reply = (c: Context, r: Result) => c.json(r.body as object, r.status as ContentfulStatusCode);

  async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S> | Result> {
    if (!(c.req.header("content-type") ?? "").startsWith("application/json")) {
      return fail(415, "UNSUPPORTED_MEDIA_TYPE", "The server does not support the requested media type.", "UNSUPPORTED_MEDIA_TYPE");
    }
    return validate(await c.req.text(), schema);
  }

  async function readPart<S extends z.ZodType>(c: Context, part: string, schema: S): Promise<z.infer<S> | Result> {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      return fail(415, "UNSUPPORTED_MEDIA_TYPE", "The server does not support the requested media type.", "UNSUPPORTED_MEDIA_TYPE", "expected multipart/form-data");
    }
    const found = parseMultipart(contentType, await c.req.text()).find((p) => p.name === part);
    if (!found) {
      return fail(400, "INVALID_REQUEST", "Request is not well-formed, syntactically incorrect, or violates schema.", "MISSING_REQUIRED_PARAMETER", `multipart part "${part}" is required`);
    }
    if (!found.contentType.startsWith("application/json")) {
      return fail(400, "INVALID_REQUEST", "Request is not well-formed, syntactically incorrect, or violates schema.", "INVALID_PARAMETER_VALUE", `part "${part}" must be application/json`);
    }
    return validate(found.body, schema);
  }

  function validate<S extends z.ZodType>(text: string, schema: S): z.infer<S> | Result {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail(400, "INVALID_REQUEST", "Request is not well-formed, syntactically incorrect, or violates schema.", "MALFORMED_REQUEST_JSON");
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    return fail(
      400,
      "INVALID_REQUEST",
      "Request is not well-formed, syntactically incorrect, or violates schema.",
      "INVALID_PARAMETER_VALUE",
      `${issue?.path.join(".") || "body"}: ${issue?.message}`,
    );
  }

  // The same PayPal-Request-Id on the same endpoint replays the first success.
  async function idempotent(c: Context, run: () => Promise<Result> | Result): Promise<Response> {
    const requestId = c.req.header("paypal-request-id");
    const key = `${c.req.method} ${new URL(c.req.url).pathname} ${requestId}`;
    const replay = requestId ? state.replays.get(key) : undefined;
    if (replay) return reply(c, replay);
    const result = await run();
    if (requestId && result.status < 300) state.replays.set(key, result);
    return reply(c, result);
  }

  app.post("/v1/oauth2/token", async (c) => {
    const basic = /^Basic (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const [id, secret] = basic ? Buffer.from(basic, "base64").toString().split(":") : [];
    if (!id || !secret) {
      return c.json({ error: "invalid_client", error_description: "Client Authentication failed" }, 401);
    }
    const form = new URLSearchParams(await c.req.text());
    if (form.get("grant_type") !== "client_credentials") {
      return c.json({ error: "unsupported_grant_type", error_description: "Grant type is not supported" }, 400);
    }
    const token = `SIM-${pid(40)}`;
    state.tokens.set(token, now().getTime() + ttl * 1000);
    state.tokensIssued += 1;
    return c.json({
      scope: "https://uri.paypal.com/services/disputes/read-seller https://uri.paypal.com/services/disputes/update-seller",
      access_token: token,
      token_type: "Bearer",
      app_id: "APP-SIMULATOR",
      expires_in: ttl,
      nonce: randomUUID(),
    });
  });

  for (const prefix of ["/v1/customer", "/v1/shipping", "/v1/notifications", "/v2"]) {
    app.use(`${prefix}/*`, async (c, next) => {
      const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      const expiresAt = token ? state.tokens.get(token) : undefined;
      if (!expiresAt || expiresAt < now().getTime()) {
        return reply(
          c,
          fail(401, "AUTHENTICATION_FAILURE", "Authentication failed due to invalid authentication credentials or a missing Authorization header.", "INVALID_TOKEN"),
        );
      }
      await next();
    });
  }

  app.post("/v2/checkout/orders", (c) =>
    idempotent(c, async () => {
      const input = await readJson(c, OrderIn);
      if (isResult(input)) return input;
      const order: SimOrder = {
        id: pid(),
        status: "CREATED",
        intent: input.intent,
        units: input.purchase_units as SimOrder["units"],
        trackers: [],
      };
      state.orders.set(order.id, order);
      return { status: 201, body: orderView(order) };
    }),
  );

  app.get("/v2/checkout/orders/:id", (c) => {
    const order = state.orders.get(c.req.param("id"));
    return reply(c, order ? { status: 200, body: orderView(order) } : notFound("order"));
  });

  app.post("/v2/checkout/orders/:id/capture", (c) =>
    idempotent(c, () => {
      const order = state.orders.get(c.req.param("id"));
      if (!order) return notFound("order");
      if (order.status === "COMPLETED") return unprocessable("ORDER_ALREADY_CAPTURED", "Order already captured.");
      if (order.status !== "APPROVED") return unprocessable("ORDER_NOT_APPROVED", "Payer has not approved the order.");
      const capture: SimCapture = {
        id: pid(),
        orderId: order.id,
        amount: order.units[0]!.amount,
        createdAt: iso(),
        refunds: [],
      };
      state.captures.set(capture.id, capture);
      order.captureId = capture.id;
      order.status = "COMPLETED";
      return { status: 201, body: orderView(order) };
    }),
  );

  app.get("/v2/payments/captures/:id", (c) => {
    const capture = state.captures.get(c.req.param("id"));
    return reply(c, capture ? { status: 200, body: captureView(capture) } : notFound("capture"));
  });

  app.post("/v2/checkout/orders/:id/track", (c) =>
    idempotent(c, async () => {
      const order = state.orders.get(c.req.param("id"));
      if (!order) return notFound("order");
      const input = await readJson(c, TrackIn);
      if (isResult(input)) return input;
      if (order.captureId !== input.capture_id) {
        return unprocessable("INVALID_CAPTURE_ID", "capture_id does not belong to this order.");
      }
      const id = `${input.capture_id}-${input.tracking_number}`;
      if (!order.trackers.some((t) => t.id === id)) {
        order.trackers.push({
          id,
          captureId: input.capture_id,
          trackingNumber: input.tracking_number,
          carrier: input.carrier,
          createdAt: iso(),
        });
      }
      return { status: 200, body: orderView(order) };
    }),
  );

  app.get("/v1/shipping/trackers/:id", (c) => {
    const id = c.req.param("id");
    const tracker = [...state.orders.values()].flatMap((o) => o.trackers).find((t) => t.id === id);
    if (!tracker) return reply(c, notFound("tracker"));
    return c.json({
      transaction_id: tracker.captureId,
      tracking_number: tracker.trackingNumber,
      status: "SHIPPED",
      carrier: tracker.carrier,
      last_updated_time: tracker.createdAt,
      links: [{ href: `${baseUrl}/v1/shipping/trackers/${tracker.id}`, rel: "self", method: "GET" }],
    });
  });

  app.get("/v1/customer/disputes", (c) => {
    const query = new URL(c.req.url).searchParams;
    const unsupported = [...query.keys()].filter((k) => !["disputed_transaction_id", "page_size"].includes(k));
    if (unsupported.length) {
      return reply(c, fail(400, "INVALID_REQUEST", "The simulator supports only disputed_transaction_id and page_size.", "INVALID_PARAMETER_VALUE", unsupported.join(",")));
    }
    const txn = query.get("disputed_transaction_id");
    const limit = Number(query.get("page_size") ?? 50);
    const items = [...state.disputes.values()]
      .filter((d) => !txn || d.captureId === txn)
      .slice(0, limit)
      .map((d) => ({
        dispute_id: d.id,
        create_time: d.createdAt,
        update_time: d.updatedAt,
        status: d.status,
        reason: d.reason,
        dispute_amount: d.amount,
        disputed_transactions: [{ seller_transaction_id: d.captureId, buyer_transaction_id: d.buyerTransactionId }],
        links: [{ href: disputeUrl(d), rel: "self", method: "GET" }],
      }));
    return c.json({ items, links: [] });
  });

  app.get("/v1/customer/disputes/:id", (c) => {
    const d = state.disputes.get(c.req.param("id"));
    return reply(c, d ? { status: 200, body: disputeView(d) } : notFound("dispute"));
  });

  function action<T>(
    rel: string,
    read: (c: Context) => Promise<T | Result>,
    apply: (d: SimDispute, input: T) => Result | void,
  ) {
    app.post(`/v1/customer/disputes/:id/${ACTION_PATH[rel]}`, (c) =>
      idempotent(c, async () => {
        const d = state.disputes.get(c.req.param("id"));
        if (!d) return notFound("dispute");
        const input = await read(c);
        if (isResult(input)) return input;
        if (!relsFor(d).includes(rel)) {
          return unprocessable(
            "ACTION_NOT_ALLOWED_IN_CURRENT_STATE",
            `${rel} is not available while status is ${d.status} and stage is ${d.stage}`,
          );
        }
        const rejection = apply(d, input);
        if (rejection) return rejection;
        state.actionLog.push({ disputeId: d.id, rel, requestId: c.req.header("paypal-request-id") });
        touch(d);
        emit(d.status === "RESOLVED" ? "CUSTOMER.DISPUTE.RESOLVED" : "CUSTOMER.DISPUTE.UPDATED", d);
        return { status: 200, body: { links: linksFor(d) } };
      }),
    );
  }

  action(PAYPAL_REL.provideEvidence, (c) => readPart(c, "input", EvidenceIn), (d, input) => {
    for (const e of input.evidences) d.evidences.push({ ...e, source: "SUBMITTED_BY_SELLER", date: iso() });
    d.status = "UNDER_REVIEW";
  });

  action(PAYPAL_REL.makeOffer, (c) => readJson(c, OfferIn), (d, input) => {
    if (Number(input.offer_amount.value) > Number(d.amount.value) || input.offer_amount.currency_code !== d.amount.currency_code) {
      return unprocessable("INVALID_OFFER_AMOUNT", "offer_amount must be in the dispute currency and not exceed the disputed amount");
    }
    d.offer = { offer_type: input.offer_type, seller_offered_amount: input.offer_amount };
    d.status = "WAITING_FOR_BUYER_RESPONSE";
  });

  action(PAYPAL_REL.acceptClaim, (c) => readJson(c, AcceptIn), (d) => {
    resolve(d, "RESOLVED_BUYER_FAVOUR");
  });

  action(PAYPAL_REL.sendMessage, (c) => readJson(c, MessageIn), (d, input) => {
    d.messages.push({ posted_by: "SELLER", time_posted: iso(), content: input.message });
  });

  action(PAYPAL_REL.escalate, (c) => readJson(c, EscalateIn), (d) => {
    d.stage = "CHARGEBACK";
    d.status = "UNDER_REVIEW";
  });

  action(PAYPAL_REL.requireEvidence, (c) => readJson(c, RequireIn), (d, input) => {
    d.status = input.action === "SELLER_EVIDENCE" ? "WAITING_FOR_SELLER_RESPONSE" : "WAITING_FOR_BUYER_RESPONSE";
    d.dueDate = plusDays(10);
  });

  action(PAYPAL_REL.adjudicate, (c) => readJson(c, AdjudicateIn), (d, input) => {
    resolve(d, input.adjudication_outcome === "BUYER_FAVOR" ? "RESOLVED_BUYER_FAVOUR" : "RESOLVED_SELLER_FAVOUR");
  });

  app.post("/v1/notifications/verify-webhook-signature", async (c) => {
    const input = await readJson(c, VerifyIn);
    if (isResult(input)) return reply(c, input);
    const sent = state.transmissions.get(input.transmission_id);
    const genuine =
      sent !== undefined &&
      sent.sig === input.transmission_sig &&
      sent.time === input.transmission_time &&
      sent.algo === input.auth_algo &&
      isDeepStrictEqual(sent.event, input.webhook_event);
    return c.json({ verification_status: genuine ? "SUCCESS" : "FAILURE" });
  });

  // Buyer-side and test-only endpoints. None of these exist in PayPal.
  app.post("/_sim/orders/:id/approve", (c) => {
    const order = state.orders.get(c.req.param("id"));
    if (!order) return reply(c, notFound("order"));
    if (order.status === "CREATED") order.status = "APPROVED";
    return reply(c, { status: 200, body: orderView(order) });
  });

  app.post("/_sim/config", async (c) => {
    const body = z.object({ webhook_url: z.string().url().optional() }).parse(await c.req.json());
    webhookUrl = body.webhook_url;
    return c.json({ webhook_url: webhookUrl ?? null });
  });

  app.post("/_sim/disputes", async (c) => {
    const input = await readJson(c, SimDisputeIn);
    if (isResult(input)) return reply(c, input);
    const capture = state.captures.get(input.capture_id);
    if (!capture) return reply(c, notFound("capture"));
    const open = [...state.disputes.values()].find((d) => d.captureId === capture.id && d.status !== "RESOLVED");
    if (open) {
      return reply(c, fail(409, "RESOURCE_CONFLICT", "An unresolved dispute already exists for this transaction.", "DISPUTE_ALREADY_EXISTS", open.id));
    }
    const created = iso();
    const d: SimDispute = {
      id: `PP-D-${10000 + ++disputeCounter}`,
      reason: input.reason,
      status: "OPEN",
      stage: "INQUIRY",
      amount: capture.amount,
      captureId: capture.id,
      buyerTransactionId: pid(),
      createdAt: created,
      updatedAt: created,
      dueDate: plusDays(10),
      messages: [{ posted_by: "BUYER", time_posted: created, content: input.note }],
      evidences: [],
    };
    state.disputes.set(d.id, d);
    const event = emit("CUSTOMER.DISPUTE.CREATED", d);
    return c.json({ ...disputeView(d), event_id: event.id }, 201);
  });

  app.post("/_sim/disputes/:id/buyer-responds", (c) => {
    const d = state.disputes.get(c.req.param("id"));
    if (!d) return reply(c, notFound("dispute"));
    if (d.status !== "WAITING_FOR_BUYER_RESPONSE") {
      return reply(c, unprocessable("NOT_WAITING_FOR_BUYER", `status is ${d.status}`));
    }
    d.status = "UNDER_REVIEW";
    touch(d);
    emit("CUSTOMER.DISPUTE.UPDATED", d);
    return reply(c, { status: 200, body: disputeView(d) });
  });

  app.post("/_sim/webhooks/redeliver/:eventId", async (c) => {
    const event = state.events.get(c.req.param("eventId"));
    if (!event) return reply(c, notFound("event"));
    const listenerStatus = await send(event);
    return c.json({ event_id: event.id, listener_status: listenerStatus ?? null });
  });

  return {
    app,
    state,
    setWebhookUrl: (url: string | undefined) => {
      webhookUrl = url;
    },
    flushDeliveries: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export type Simulator = ReturnType<typeof createSimulator>;
