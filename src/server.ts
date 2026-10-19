import { catalogRouter, type CatalogService } from "./catalog/index.js";
import { ApprovalStale, snapshotForCase } from "./approval.js";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { ExecutionBlocked, IncompleteDraft, UnknownOutcome, executeApproved } from "./agent/execute.js";
import type { Model } from "./agent/model.js";
import type { SellerRecordsLoader } from "./agent/seller-records.js";
import {
  PayPalError,
  isSandboxOrSimulatorUrl,
  webhookHeaders,
  type PayPalClient,
} from "./paypal/client.js";
import { KeyedLock, REFRESHABLE, assess, syncResolution } from "./pipeline.js";
import { PAYPAL_REL } from "./domain.js";
import { ManualReconciliationRequired, type CasePatch, type Store } from "./store.js";
import { mutationRequestFailure, trustedBrowserOrigins } from "./request-integrity.js";
import { checkTrackingEvidence } from "./agent/guard.js";

export interface AppDeps {
  catalog?: CatalogService;
  client: PayPalClient;
  store: Store;
  model?: Model;
  // True when `model` is the canned test double rather than a real AI model.
  testDouble?: boolean;
  sellerRecords: SellerRecordsLoader;
  webhookId?: string;
  // When set, every /api route except /api/health needs "Authorization: Bearer <token>".
  operatorToken?: string;
  now?: () => Date;
  monotonicNow?: () => number;
  // Exact trusted frontend origin, replacing the two default local UI origins.
  corsOrigin?: string;
}

const EventSchema = z
  .object({
    id: z.string(),
    event_type: z.string(),
    resource: z.object({ dispute_id: z.string() }).passthrough(),
  })
  .passthrough();

const ApproveSchema = z.object({ approvedBy: z.string().trim().min(1), recommendationRevision: z.string().optional() });
const RequireEvidenceSchema = z.object({ action: z.enum(["SELLER_EVIDENCE", "BUYER_EVIDENCE"]).default("SELLER_EVIDENCE") });
const AdjudicateSchema = z.object({ outcome: z.enum(["BUYER_FAVOR", "SELLER_FAVOR"]) });

export function createApp(deps: AppDeps): Hono {
  const { client, store, model } = deps;
  const now = deps.now ?? (() => new Date());
  const pipeline = { client, store, model, sellerRecords: deps.sellerRecords, now, monotonicNow: deps.monotonicNow };
  const lock = new KeyedLock();
  const eventLock = new KeyedLock();
  const app = new Hono();

  const browserOrigins = trustedBrowserOrigins(deps.corsOrigin);
  app.use("/api/*", cors({ origin: browserOrigins }));

  const { operatorToken } = deps;
  if (operatorToken) {
    const expected = Buffer.from(`Bearer ${operatorToken}`);
    app.use("/api/*", async (c, next) => {
      if (c.req.method === "OPTIONS" || c.req.path === "/api/health") return next();
      const given = Buffer.from(c.req.header("authorization") ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return c.json({ error: "unauthorized", message: "Operator token required" }, 401);
      }
      return next();
    });
  }

  // Response CORS headers alone do not prevent a simple POST from executing.
  // Apply this before every API mutation, including bodyless execution, sandbox
  // helpers and catalog requests. PayPal webhooks use signature verification.
  app.use("/api/*", async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const failure = mutationRequestFailure(c.req.raw, browserOrigins);
    if (failure) return c.json(failure, 403);
    return next();
  });

  app.route("/api/catalog", catalogRouter(deps.catalog, Boolean(operatorToken)));

  const status = (code: number) => code as ContentfulStatusCode;

  function paypalFailure(c: Context, e: PayPalError, extra: object = {}) {
    const code = e.status === 404 ? 404 : e.status === 422 ? 409 : 502;
    const paypal = { status: e.status, name: e.name, message: e.message, debugId: e.debugId, body: e.body };
    return c.json({ error: "paypal_error", paypal, ...extra }, status(code));
  }

  async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S> | undefined> {
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    return parsed.success ? parsed.data : undefined;
  }

  app.get("/api/health", (c) =>
    c.json({ paypalBaseUrl: client.baseUrl, simulator: client.simulator, aiConfigured: model !== undefined && !deps.testDouble,
      operatorAuth: operatorToken !== undefined,
      testDouble: deps.testDouble === true,
    }),
  );

  app.get("/api/cases", (c) => c.json(store.listCases()));

  app.get("/api/cases/:id", (c) => {
    const found = store.getCase(c.req.param("id"));
    if (!found) return c.json({ error: "case_not_found" }, 404);
    return c.json({ ...found, audit: store.auditTrail(found.disputeId) });
  });

  app.post("/api/cases/:id/reassess", (c) => {
    const id = c.req.param("id");
    return lock.run(id, async () => {
      const existing = store.getCase(id);
      try {
        if (existing && !REFRESHABLE.includes(existing.status)) return c.json(await syncResolution(pipeline, id));
        return c.json(await assess(pipeline, id));
      } catch (e) {
        if (e instanceof ManualReconciliationRequired) return c.json({ error: "manual_reconciliation_required", message: e.message }, 409);
        if (e instanceof PayPalError) return paypalFailure(c, e);
        throw e;
      }
    });
  });

  app.post("/api/cases/:id/approve", async (c) => {
    const id = c.req.param("id");
    const input = await body(c, ApproveSchema);
    if (!input) return c.json({ error: "invalid_body", message: "approvedBy is required" }, 400);
    return lock.run(id, async () => {
      const found = store.getCase(id);
      if (!found) return c.json({ error: "case_not_found" }, 404);
      if (found.status !== "recommended" || found.assessment?.kind !== "actionable") {
        return c.json({ error: "not_approvable", message: `Case is ${found.status}` }, 409);
      }
      const trackingFailures = checkTrackingEvidence(found.assessment.recommendation, found.evidence, found.decisionFacts?.captureId);
      if (found.guardFailures.length > 0 || trackingFailures.length > 0) {
        return c.json({ error: "guard_failures", guardFailures: [...found.guardFailures, ...trackingFailures] }, 409);
      }
      if (!found.recommendationRevision || input.recommendationRevision !== found.recommendationRevision) {
        return c.json({ error: "stale_recommendation", message: "Recommendation changed or has no revision. Refresh and review it before approving." }, 409);
      }
      let approvedSnapshot;
      try { approvedSnapshot = snapshotForCase(found); }
      catch (e) {
        if (e instanceof ApprovalStale) return c.json({ error: "stale_recommendation", message: e.message }, 409);
        throw e;
      }
      const approved = store.transition(id, "approved", { approvedBy: input.approvedBy, approvedSnapshot });
      store.audit(id, "approved", { approvedBy: input.approvedBy, action: found.assessment.recommendation.action, recommendationRevision: found.recommendationRevision, approvedSnapshot });
      return c.json(approved);
    });
  });

  app.post("/api/cases/:id/execute", (c) => {
    const id = c.req.param("id");
    return lock.run(id, async () => {
      const found = store.getCase(id);
      if (!found) return c.json({ error: "case_not_found" }, 404);
      if (found.execution) return c.json(found);
      if (found.pendingAction) return c.json({ error: "manual_reconciliation_required", message: new ManualReconciliationRequired().message }, 409);
      if (found.status !== "approved" || found.assessment?.kind !== "actionable") {
        return c.json({ error: "not_executable", message: `Case is ${found.status}; approve it first` }, 409);
      }
      let claimedRequestId: string | undefined;
      const failCase = (patch: CasePatch): boolean => {
        try {
          store.transition(id, "failed", patch, claimedRequestId);
          return true;
        } catch (error) {
          if (error instanceof ManualReconciliationRequired) return false;
          throw error;
        }
      };
      const reconciliationRequired = () => c.json({ error: "manual_reconciliation_required", message: new ManualReconciliationRequired().message }, 409);
      try {
        const { execution, after } = await executeApproved(found, client, now, intent => {
          store.claimPendingAction(found, intent);
          claimedRequestId = intent.requestId;
        });
        let updated = store.recordExecution(id, execution, after?.links.filter(link => link.method === "POST").map(link => link.rel));
        if (after?.status === "RESOLVED" && updated.status !== "resolved") {
          updated = store.transition(id, "resolved", { outcome: after.dispute_outcome?.outcome_code });
        }
        return c.json(updated);
      } catch (e) {
        if (e instanceof ManualReconciliationRequired) return c.json({ error: "manual_reconciliation_required", message: e.message }, 409);
        if (e instanceof ApprovalStale) {
          store.audit(id, "approval.invalidated", { reason: e.message, approvedSnapshot: found.approvedSnapshot });
          if (!failCase({ error: e.message, approvedBy: undefined, approvedSnapshot: undefined, recommendationRevision: undefined })) return reconciliationRequired();
          return c.json({ error: "approval_stale", message: e.message }, 409);
        }
        if (e instanceof ExecutionBlocked || e instanceof IncompleteDraft) {
          if (!failCase({ error: e.message, pendingAction: undefined })) return reconciliationRequired();
          return c.json({ error: "execution_blocked", message: e.message }, 409);
        }
        if (e instanceof UnknownOutcome) {
          if (!failCase({ error: e.message })) return reconciliationRequired();
          return c.json({ error: "unknown_outcome", message: e.message }, 502);
        }
        if (e instanceof PayPalError) {
          if (!failCase({ error: `${e.name}: ${e.message} (PayPal debug id ${e.debugId ?? "none"})`, pendingAction: undefined })) return reconciliationRequired();
          return paypalFailure(c, e);
        }
        throw e;
      }
    });
  });

  const sandboxOnly = async (c: Context, next: () => Promise<void>) => {
    if (!isSandboxOrSimulatorUrl(client.baseUrl)) return c.json({ error: "sandbox_only" }, 403);
    await next();
  };
  app.use("/api/sandbox/*", sandboxOnly);

  app.post("/api/sandbox/disputes/:id/require-evidence", async (c) => {
    const input = await body(c, RequireEvidenceSchema);
    if (!input) return c.json({ error: "invalid_body" }, 400);
    const id = c.req.param("id");
    try {
      // PayPal only asks for evidence on a claim, so an inquiry is escalated first.
      const dispute = await client.getDispute(id);
      if (dispute.links.some((l) => l.rel === PAYPAL_REL.escalate)) {
        await client.escalate(id, "Escalated to a claim for sandbox testing.", `sbx-${crypto.randomUUID()}`);
      }
      const res = await client.requireEvidence(id, input.action, `sbx-${crypto.randomUUID()}`);
      return c.json({ simulated_resolution: true, httpStatus: res.httpStatus, paypal: res.body });
    } catch (e) {
      if (e instanceof PayPalError) return paypalFailure(c, e, { simulated_resolution: true });
      throw e;
    }
  });

  app.post("/api/sandbox/disputes/:id/adjudicate", async (c) => {
    const input = await body(c, AdjudicateSchema);
    if (!input) return c.json({ error: "invalid_body", message: "outcome must be BUYER_FAVOR or SELLER_FAVOR" }, 400);
    try {
      const res = await client.adjudicate(c.req.param("id"), input.outcome, `sbx-${crypto.randomUUID()}`);
      return c.json({
        simulated_resolution: true,
        note: "The caller chose this outcome. It says nothing about the quality of the evidence.",
        httpStatus: res.httpStatus,
        paypal: res.body,
      });
    } catch (e) {
      if (e instanceof PayPalError) return paypalFailure(c, e, { simulated_resolution: true });
      throw e;
    }
  });

  app.post("/webhooks/paypal", async (c) => {
    if (!deps.webhookId) return c.json({ error: "PAYPAL_WEBHOOK_ID is not configured" }, 503);
    const headers = webhookHeaders((name) => c.req.header(name));
    if (!headers) return c.json({ error: "missing paypal-* transmission headers" }, 400);
    const rawEvent: unknown = await c.req.json().catch(() => undefined);
    const event = EventSchema.safeParse(rawEvent);
    if (!event.success) return c.json({ error: "malformed webhook event" }, 400);
    const { id: eventId, event_type: type } = event.data;
    const disputeId = event.data.resource.dispute_id;

    // PayPal redelivers up to 25 times over 3 days, so a known event is acknowledged without another
    // verification call. Answering 200 to a forged copy of a processed id changes nothing.
    if (store.hasWebhook(eventId)) {
      store.audit(disputeId, "webhook.duplicate", { eventId, type });
      return c.json({ duplicate: true });
    }

    try {
      const genuine = await client.verifyWebhookSignature({ headers, webhookId: deps.webhookId, event: rawEvent });
      if (!genuine) {
        store.audit(disputeId, "webhook.rejected", { eventId, type });
        return c.json({ error: "signature verification failed" }, 401);
      }
    } catch (e) {
      if (e instanceof PayPalError) return paypalFailure(c, e);
      throw e;
    }

    return eventLock.run(eventId, async () => {
      if (store.hasWebhook(eventId)) {
        store.audit(disputeId, "webhook.duplicate", { eventId, type });
        return c.json({ duplicate: true });
      }
      store.startWebhook(eventId);
      store.audit(disputeId, "webhook.received", { eventId, type });
      try {
        await lock.run(disputeId, () => handleEvent(type, disputeId, eventId));
        store.completeWebhook(eventId);
        return c.json({ ok: true });
      } catch (e) {
        store.audit(disputeId, "webhook.error", { eventId, error: e instanceof Error ? e.message : String(e) });
        return c.json({ error: "processing failed; safe to redeliver" }, 500);
      }
    });
  });

  async function handleEvent(type: string, disputeId: string, eventId: string): Promise<void> {
    const existing = store.getCase(disputeId);
    if (type === "CUSTOMER.DISPUTE.CREATED" || type === "CUSTOMER.DISPUTE.UPDATED") {
      if (!existing || REFRESHABLE.includes(existing.status)) await assess(pipeline, disputeId);
      else if (existing.status !== "resolved") await syncResolution(pipeline, disputeId);
      else store.audit(disputeId, "webhook.ignored", { eventId, reason: `case is ${existing.status}` });
      return;
    }
    if (type === "CUSTOMER.DISPUTE.RESOLVED") {
      if (!existing) return store.audit(disputeId, "webhook.ignored", { eventId, reason: "no case for this dispute" });
      if (existing.status === "resolved") return;
      const dispute = await client.getDispute(disputeId);
      if (dispute.dispute_id !== disputeId) throw new Error("Dispute identity mismatch");
      if (dispute.status !== "RESOLVED") throw new Error("Resolution notification is not confirmed by current PayPal state");
      if (existing.status === "failed") store.transition(disputeId, "received");
      store.transition(disputeId, "resolved", { outcome: dispute.dispute_outcome?.outcome_code, postExecutionReview: undefined });
      return;
    }
    store.audit(disputeId, "webhook.ignored", { eventId, reason: `unhandled event type ${type}` });
  }

  return app;
}
