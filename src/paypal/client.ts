import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Money } from "../domain.js";
import {
  ActionBodySchema,
  CaptureSchema,
  DisputeListSchema,
  DisputeSchema,
  OrderSchema,
  PayPalErrorBodySchema,
  TokenSchema,
  TrackerSchema,
  VerifySchema,
  type Capture,
  type Dispute,
  type DisputeList,
  type Order,
  type Tracker,
} from "./schemas.js";

export const DEFAULT_BASE_URL = "https://api-m.sandbox.paypal.com";
export const SIMULATOR_HEADER = "x-dispute-desk-simulator";

export interface PayPalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export function loadPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const { PAYPAL_BASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required (any value works against the simulator)");
  }
  return {
    baseUrl: PAYPAL_BASE_URL || DEFAULT_BASE_URL,
    clientId: PAYPAL_CLIENT_ID,
    clientSecret: PAYPAL_CLIENT_SECRET,
  };
}

// This project is sandbox only: any paypal.com host that is not *.sandbox.paypal.com is live.
export function assertSandboxOnly(baseUrl: string): void {
  const host = new URL(baseUrl).hostname;
  const isPayPal = host === "paypal.com" || host.endsWith(".paypal.com");
  if (isPayPal && !host.endsWith(".sandbox.paypal.com")) {
    throw new Error(`Refusing to start: ${host} is a live PayPal host. RebuttalForge is sandbox only.`);
  }
}

export function isSimulatorUrl(baseUrl: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
}

export function isSandboxOrSimulatorUrl(baseUrl: string): boolean {
  return isSimulatorUrl(baseUrl) || new URL(baseUrl).hostname.endsWith(".sandbox.paypal.com");
}

export class PayPalError extends Error {
  override readonly name: string;
  constructor(
    readonly status: number,
    name: string,
    message: string,
    readonly debugId: string | undefined,
    readonly body: unknown,
  ) {
    super(message);
    this.name = name;
  }
}

// One request/response pair as it crossed the wire, with credentials redacted.
export interface Exchange {
  at: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
}

export interface PayPalClientOptions {
  fetch?: typeof fetch;
  onExchange?: (exchange: Exchange) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface OrderInput {
  intent: "CAPTURE";
  purchase_units: Array<{
    reference_id?: string;
    description?: string;
    amount: Money & { breakdown?: unknown };
    items?: Array<{ name: string; quantity: string; unit_amount: Money }>;
    shipping?: { name?: { full_name: string }; address?: Record<string, string> };
  }>;
  payment_source?: Record<string, unknown>;
}

export interface WebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export function webhookHeaders(get: (name: string) => string | undefined): WebhookHeaders | undefined {
  const h = {
    authAlgo: get("paypal-auth-algo"),
    certUrl: get("paypal-cert-url"),
    transmissionId: get("paypal-transmission-id"),
    transmissionSig: get("paypal-transmission-sig"),
    transmissionTime: get("paypal-transmission-time"),
  };
  return Object.values(h).every((v) => v) ? (h as WebhookHeaders) : undefined;
}

export type OfferType = "REFUND";

export interface ActionResponse {
  httpStatus: number;
  body: z.infer<typeof ActionBodySchema>;
}

interface CallOptions {
  query?: Record<string, string>;
  json?: unknown;
  multipart?: { part: string; value: unknown };
  requestId?: string;
}

function encodeMultipartJson(part: string, value: unknown): { body: string; contentType: string } {
  const boundary = `----RebuttalForge${randomUUID().replaceAll("-", "")}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${part}"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(value)}\r\n` +
    `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const seg = encodeURIComponent;

export class PayPalClient {
  readonly baseUrl: string;
  private token?: { value: string; expiresAt: number };
  private tokenInFlight?: Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: PayPalConfig,
    private readonly options: PayPalClientOptions = {},
  ) {
    assertSandboxOnly(config.baseUrl);
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  get simulator(): boolean {
    return isSimulatorUrl(this.baseUrl);
  }

  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return Promise.resolve(this.token.value);
    this.tokenInFlight ??= this.fetchToken().finally(() => {
      this.tokenInFlight = undefined;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const { data } = await this.send("POST", "/v1/oauth2/token", TokenSchema, {
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      rawBody: "grant_type=client_credentials",
    });
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  private async call<T>(method: string, path: string, schema: z.ZodType<T>, opts: CallOptions = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      Accept: "application/json",
    };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
    let rawBody: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      rawBody = JSON.stringify(opts.json);
    } else if (opts.multipart) {
      const encoded = encodeMultipartJson(opts.multipart.part, opts.multipart.value);
      headers["Content-Type"] = encoded.contentType;
      rawBody = encoded.body;
    }
    const query = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
    return this.send(method, path + query, schema, { headers, rawBody });
  }

  private async send<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    req: { headers: Record<string, string>; rawBody?: string },
  ): Promise<{ status: number; data: T }> {
    const url = this.baseUrl + path;
    // PayPal publishes no limits and answers 429 with Retry-After. The same PayPal-Request-Id is resent.
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(url, { method, headers: req.headers, body: req.rawBody });
      const text = await res.text();
      let parsed: unknown = text;
      if (text === "") parsed = {};
      else {
        try {
          parsed = JSON.parse(text);
        } catch {
          // Non-JSON bodies are kept verbatim as the raw string.
        }
      }
      // Recorded per attempt, so limited calls count toward measured usage.
      this.options.onExchange?.({
        at: new Date().toISOString(),
        method,
        url,
        requestHeaders: { ...req.headers, ...(req.headers.Authorization ? { Authorization: "REDACTED" } : {}) },
        requestBody: req.rawBody === undefined ? undefined : tryJson(req.rawBody),
        status: res.status,
        responseHeaders: Object.fromEntries(res.headers),
        responseBody: redactToken(parsed),
      });
      const waitSeconds = Number(res.headers.get("Retry-After")) || DEFAULT_RETRY_AFTER_SECONDS;
      // A wait longer than the cap is surfaced, never shortened: retrying early is what PayPal limits.
      if (res.status === 429 && attempt < RATE_LIMIT_ATTEMPTS && waitSeconds <= MAX_RETRY_AFTER_SECONDS) {
        await (this.options.sleep ?? defaultSleep)(waitSeconds * 1000);
        continue;
      }
      if (!res.ok) throw toPayPalError(res, parsed);
      return { status: res.status, data: schema.parse(parsed) };
    }
  }

  async createOrder(input: OrderInput, requestId: string): Promise<Order> {
    return (await this.call("POST", "/v2/checkout/orders", OrderSchema, { json: input, requestId })).data;
  }

  async captureOrder(orderId: string, requestId: string): Promise<Order> {
    const path = `/v2/checkout/orders/${seg(orderId)}/capture`;
    const captured = (await this.call("POST", path, OrderSchema, { json: {}, requestId })).data;
    if (captured.id !== orderId) throw new Error("Capture response order identity mismatch");
    if (captured.purchase_units.some(unit => unit.payments?.captures?.some(capture => capture.id))) return captured;
    const detailed = await this.getOrder(orderId);
    if (detailed.id !== orderId) throw new Error("Capture detail order identity mismatch");
    if (!detailed.purchase_units.some(unit => unit.payments?.captures?.some(capture => capture.id))) {
      throw new Error("Capture was acknowledged, but capture identity is unavailable. Review the order; do not repeat the capture request.");
    }
    return detailed;
  }

  async getOrder(orderId: string): Promise<Order> {
    return (await this.call("GET", `/v2/checkout/orders/${seg(orderId)}`, OrderSchema)).data;
  }

  async getCapture(captureId: string): Promise<Capture> {
    return (await this.call("GET", `/v2/payments/captures/${seg(captureId)}`, CaptureSchema)).data;
  }

  async addTracking(
    orderId: string,
    t: { captureId: string; trackingNumber: string; carrier: string; notifyPayer: boolean },
    requestId: string,
  ): Promise<Order> {
    const json = {
      capture_id: t.captureId,
      tracking_number: t.trackingNumber,
      carrier: t.carrier,
      notify_payer: t.notifyPayer,
    };
    const path = `/v2/checkout/orders/${seg(orderId)}/track`;
    return (await this.call("POST", path, OrderSchema, { json, requestId })).data;
  }

  async getTracking(captureId: string, trackingNumber: string): Promise<Tracker> {
    const path = `/v1/shipping/trackers/${seg(captureId)}-${seg(trackingNumber)}`;
    return (await this.call("GET", path, TrackerSchema)).data;
  }

  async listDisputes(query?: Record<string, string>): Promise<DisputeList> {
    return (await this.call("GET", "/v1/customer/disputes", DisputeListSchema, { query })).data;
  }

  async getDispute(disputeId: string): Promise<Dispute> {
    return (await this.call("GET", `/v1/customer/disputes/${seg(disputeId)}`, DisputeSchema)).data;
  }

  private async disputeAction(disputeId: string, action: string, opts: CallOptions): Promise<ActionResponse> {
    const path = `/v1/customer/disputes/${seg(disputeId)}/${action}`;
    const { status, data } = await this.call("POST", path, ActionBodySchema, opts);
    return { httpStatus: status, body: data };
  }

  provideEvidence(
    disputeId: string,
    e: { evidenceType: string; tracking?: { carrierName: string; trackingNumber: string }; notes: string },
    requestId: string,
  ): Promise<ActionResponse> {
    const evidence = {
      evidence_type: e.evidenceType,
      ...(e.tracking && {
        evidence_info: {
          tracking_info: [{ carrier_name: e.tracking.carrierName, tracking_number: e.tracking.trackingNumber }],
        },
      }),
      notes: e.notes,
    };
    return this.disputeAction(disputeId, "provide-evidence", {
      multipart: { part: "input", value: { evidences: [evidence] } },
      requestId,
    });
  }

  makeOffer(
    disputeId: string,
    o: { note: string; offerType: OfferType; amount: Money },
    requestId: string,
  ): Promise<ActionResponse> {
    if (o.offerType !== "REFUND") throw new Error("Only REFUND offers are supported by this client.");
    const json = { note: o.note, offer_type: o.offerType, offer_amount: o.amount };
    return this.disputeAction(disputeId, "make-offer", { json, requestId });
  }

  acceptClaim(
    disputeId: string,
    a: { note: string; acceptClaimType?: string },
    requestId: string,
  ): Promise<ActionResponse> {
    const value = { note: a.note, accept_claim_type: a.acceptClaimType ?? "REFUND" };
    return this.disputeAction(disputeId, "accept-claim", {
      json: value,
      requestId,
    });
  }

  sendMessage(disputeId: string, message: string, requestId: string): Promise<ActionResponse> {
    return this.disputeAction(disputeId, "send-message", {
      json: { message },
      requestId,
    });
  }

  escalate(disputeId: string, note: string, requestId: string): Promise<ActionResponse> {
    return this.disputeAction(disputeId, "escalate", { json: { note }, requestId });
  }

  requireEvidence(
    disputeId: string,
    action: "SELLER_EVIDENCE" | "BUYER_EVIDENCE",
    requestId: string,
  ): Promise<ActionResponse> {
    return this.disputeAction(disputeId, "require-evidence", { json: { action }, requestId });
  }

  adjudicate(
    disputeId: string,
    outcome: "BUYER_FAVOR" | "SELLER_FAVOR",
    requestId: string,
  ): Promise<ActionResponse> {
    return this.disputeAction(disputeId, "adjudicate", {
      json: { adjudication_outcome: outcome },
      requestId,
    });
  }

  async verifyWebhookSignature(input: {
    headers: WebhookHeaders;
    webhookId: string;
    event: unknown;
  }): Promise<boolean> {
    const json = {
      auth_algo: input.headers.authAlgo,
      cert_url: input.headers.certUrl,
      transmission_id: input.headers.transmissionId,
      transmission_sig: input.headers.transmissionSig,
      transmission_time: input.headers.transmissionTime,
      webhook_id: input.webhookId,
      webhook_event: input.event,
    };
    const { data } = await this.call("POST", "/v1/notifications/verify-webhook-signature", VerifySchema, { json });
    return data.verification_status === "SUCCESS";
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toPayPalError(res: Response, body: unknown): PayPalError {
  const parsed = PayPalErrorBodySchema.safeParse(body);
  const b = parsed.success ? parsed.data : {};
  return new PayPalError(
    res.status,
    b.name ?? b.error ?? `HTTP_${res.status}`,
    b.message ?? b.error_description ?? res.statusText,
    b.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined,
    body,
  );
}

// Recorded exchanges are written to disk by the rehearsal, so the bearer token must not be in them.
function redactToken(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "access_token" in body) return { ...body, access_token: "REDACTED" };
  return body;
}

const RATE_LIMIT_ATTEMPTS = 3;
// PayPal's own sample falls back to 30 seconds when the header is missing.
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 120;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
