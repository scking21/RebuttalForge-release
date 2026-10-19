import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { serve } from "@hono/node-server";
import { fileSellerRecords, type SellerRecord } from "../src/agent/seller-records.js";
import { modelFromEnv, type Model } from "../src/agent/model.js";
import { scriptedBranch } from "../src/agent/test-double.js";
import type { Case } from "../src/domain.js";
import {
  PayPalClient,
  PayPalError,
  SIMULATOR_HEADER,
  isSimulatorUrl,
  loadPayPalConfig,
  type Exchange,
} from "../src/paypal/client.js";
import { createApp } from "../src/server.js";
import { createSimulator } from "../src/simulator/app.js";
import { Store } from "../src/store.js";
import { OPERATOR_REQUEST_HEADERS } from "../src/request-integrity.js";

// A credential-free judge check must remain synthetic even with a configured shell or .env.
const simulatorOnly = process.argv.includes("--simulator");
if (simulatorOnly) {
  process.env.PAYPAL_BASE_URL = "http://127.0.0.1:4010";
  process.env.PAYPAL_CLIENT_ID = "rehearsal";
  process.env.PAYPAL_CLIENT_SECRET = "rehearsal";
  process.env.PAYPAL_WEBHOOK_ID = "WH-REHEARSAL";
  process.env.REHEARSAL_DATABASE_PATH = ":memory:";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_MODEL;
  delete process.env.AI_PROVIDER;
} else {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the process environment.
  }
}

type Branch = "contest" | "concede";
type Json = Record<string, any>;

interface StepResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
  at: string;
}

interface ApiExchange {
  via: "dispute-desk-api";
  at: string;
  method: string;
  path: string;
  status: number;
  responseBody: unknown;
}

interface RehearsalRecord {
  branch: Branch;
  startedAt: string;
  finishedAt?: string;
  paypalBaseUrl: string;
  simulator: boolean;
  model: { kind: string; note: string };
  ids: Json;
  sellerRecords: SellerRecord[];
  steps: StepResult[];
  exchanges: Array<Exchange | ApiExchange>;
  outcome?: "PASS" | "FAIL";
  failure?: unknown;
}

class StepFailure extends Error {
  constructor(
    message: string,
    readonly response?: unknown,
  ) {
    super(message);
  }
}

const check = (ok: unknown, message: string, response?: unknown): void => {
  if (!ok) throw new StepFailure(message, response);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Against real PayPal each probe is an API call, and polling is a cause PayPal names for rate limiting:
// four probes, 30 seconds apart. The in-process stand-in has no such cost.
async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const intervalMs = simulatorMode ? 100 : 30_000;
  const maxProbes = simulatorMode ? Math.ceil(timeoutMs / intervalMs) : 4;
  for (let n = 1; ; n++) {
    const found = await probe();
    if (found !== undefined) return found;
    if (n >= maxProbes) throw new StepFailure(`gave up after ${n} probes waiting for ${label}`);
    await sleep(intervalMs);
  }
}

const baseUrl = process.env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com";
const simulatorMode = isSimulatorUrl(baseUrl);
if (simulatorMode) {
  process.env.PAYPAL_CLIENT_ID ??= "rehearsal";
  process.env.PAYPAL_CLIENT_SECRET ??= "rehearsal";
}
const config = { ...loadPayPalConfig(), baseUrl };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runId = Date.now().toString(36);
const recordsDir = join("rehearsal", "records");
mkdirSync(recordsDir, { recursive: true });

const sellerDir = mkdtempSync(join(tmpdir(), "rebuttalforge-seller-"));
const realModel = modelFromEnv();
const modelNote = realModel
  ? `${realModel.provider} (${realModel.modelId})`
  : "no AI key: using scripted recommendations (test double)";
console.log(`PayPal base URL: ${baseUrl}`);
console.log(modelNote);

let current!: RehearsalRecord;
const newRecord = (branch: Branch): RehearsalRecord => ({
  branch,
  startedAt: new Date().toISOString(),
  paypalBaseUrl: baseUrl,
  simulator: simulatorMode,
  model: { kind: realModel?.provider ?? "scripted-test-double", note: modelNote },
  ids: {},
  sellerRecords: [],
  steps: [],
  exchanges: [],
});
const records: Record<Branch, RehearsalRecord> = { contest: newRecord("contest"), concede: newRecord("concede") };
current = records.contest;

const client = new PayPalClient(config, { onExchange: (e) => current.exchanges.push(e) });

const UPS_TRACKING = { carrierName: "UPS", trackingNumber: `1Z${runId.toUpperCase().padEnd(8, "0")}` };
const scripted: Record<Branch, Model> = {
  contest: scriptedBranch("contest", UPS_TRACKING),
  concede: scriptedBranch("concede"),
};
let activeBranch: Branch = "contest";
let modelCalls = 0;
const model: Model = {
  recommend(input) {
    modelCalls += 1;
    return (realModel ?? scripted[activeBranch]).recommend(input);
  },
};

const webhookId = process.env.PAYPAL_WEBHOOK_ID ?? "WH-REHEARSAL";
const store = new Store(process.env.REHEARSAL_DATABASE_PATH ?? ":memory:");
const app = createApp({
  client,
  store,
  model,
  sellerRecords: fileSellerRecords(sellerDir),
  webhookId,
});

const closers: Array<() => void> = [];
let settleSimulatorDeliveries: (() => Promise<void>) | undefined;

async function listenOnEphemeralPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    closers.push(() => server.close());
  });
}

async function startEmbeddedSimulatorIfNeeded(): Promise<string> {
  if (!simulatorMode) return "real PayPal sandbox";
  const port = Number(new URL(baseUrl).port || 80);
  const sim = createSimulator({ baseUrl });
  const outcome = await new Promise<"embedded" | "external">((resolve, reject) => {
    const server = serve({ fetch: sim.app.fetch, port, hostname: "127.0.0.1" }, () => resolve("embedded"));
    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && !simulatorOnly) resolve("external");
      else reject(e);
    });
    closers.push(() => server.close());
  });
  if (outcome === "embedded") settleSimulatorDeliveries = sim.flushDeliveries;
  return outcome === "embedded" ? "embedded simulator started" : "using the simulator already running on that port";
}

const base = (path: string) => `http://localhost:${listenerPort}${path}`;
let listenerPort = 0;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(base(path), {
    method,
    headers: { "content-type": "application/json", ...(method === "GET" ? {} : OPERATOR_REQUEST_HEADERS) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as Json;
  current.exchanges.push({ via: "dispute-desk-api", at: new Date().toISOString(), method, path, status: res.status, responseBody: parsed });
  return { status: res.status, body: parsed };
}

async function apiOk(method: string, path: string, body?: unknown): Promise<Json> {
  const res = await api(method, path, body);
  check(res.status === 200, `${method} ${path} answered ${res.status}, expected 200`, res.body);
  return res.body;
}

async function simPost(path: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json()) as Json;
  current.exchanges.push({
    at: new Date().toISOString(),
    method: "POST",
    url: `${baseUrl}${path}`,
    requestHeaders: {},
    requestBody: body,
    status: res.status,
    responseHeaders: Object.fromEntries(res.headers),
    responseBody: parsed,
  });
  check(res.status < 300, `simulator ${path} answered ${res.status}`, parsed);
  return parsed;
}

async function pressEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`${prompt}\nPress enter when done. `);
  rl.close();
}

async function step(n: string, name: string, fn: () => Promise<string | void>): Promise<void> {
  const label = `[${current.branch}] ${n}. ${name}`;
  try {
    const detail = (await fn()) ?? "";
    current.steps.push({ name: `${n}. ${name}`, status: "PASS", detail, at: new Date().toISOString() });
    console.log(`PASS ${label}${detail ? ` -- ${detail}` : ""}`);
  } catch (e) {
    const response = e instanceof PayPalError ? { status: e.status, name: e.name, debugId: e.debugId, body: e.body } : e instanceof StepFailure ? e.response : undefined;
    const message = e instanceof Error ? e.message : String(e);
    current.steps.push({ name: `${n}. ${name}`, status: "FAIL", detail: message, at: new Date().toISOString() });
    console.error(`FAIL ${label} -- ${message}`);
    if (response !== undefined) console.error(`Exact failing response:\n${JSON.stringify(response, null, 2)}`);
    current.outcome = "FAIL";
    current.failure = { message, response };
    finish();
    process.exit(1);
  }
}

function skip(n: string, name: string, reason: string): void {
  current.steps.push({ name: `${n}. ${name}`, status: "SKIP", detail: reason, at: new Date().toISOString() });
  console.log(`SKIP [${current.branch}] ${n}. ${name} -- ${reason}`);
}

const writtenFiles: string[] = [];
function finish(): void {
  for (const r of Object.values(records)) {
    if (r.steps.length === 0) continue;
    r.finishedAt = new Date().toISOString();
    r.outcome ??= "PASS";
    const file = join(recordsDir, `${stamp}-${r.branch}.json`);
    writeFileSync(file, JSON.stringify(r, null, 2));
    if (!writtenFiles.includes(file)) writtenFiles.push(file);
  }
}

const rels = (d: { links: Array<{ rel: string }> }) => d.links.map((l) => l.rel).filter((r) => r !== "self");

async function caseOf(disputeId: string): Promise<Json | undefined> {
  const res = await api("GET", `/api/cases/${disputeId}`);
  return res.status === 200 ? res.body : undefined;
}

// With webhooks the server refreshes itself; without them, ask it to re-read PayPal.
async function awaitCase(disputeId: string, label: string, ok: (c: Json) => boolean): Promise<Json> {
  if (!simulatorMode) await api("POST", `/api/cases/${disputeId}/reassess`);
  return waitFor(label, async () => {
    const c = await caseOf(disputeId);
    return c && ok(c) ? c : undefined;
  });
}

async function runBranch(branch: Branch): Promise<void> {
  current = records[branch];
  activeBranch = branch;
  const ids = current.ids;
  const contest = branch === "contest";

  await step("2", "create + capture an order" + (contest ? ", add tracking" : ""), async () => {
    const order = await client.createOrder(
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: `dd-${runId}-${branch}`,
            description: "RebuttalForge rehearsal",
            amount: { currency_code: "USD", value: "48.00" },
            items: [{ name: "Ceramic pour-over set", quantity: "1", unit_amount: { currency_code: "USD", value: "48.00" } }],
            shipping: {
              name: { full_name: "Sam Buyer" },
              address: { address_line_1: "1 Main St", admin_area_2: "Austin", admin_area_1: "TX", postal_code: "78701", country_code: "US" },
            },
          },
        ],
        ...(simulatorMode ? {} : { payment_source: { paypal: { experience_context: { return_url: "https://example.com/return", cancel_url: "https://example.com/cancel" } } } }),
      },
      `dd-${runId}-${branch}-order`,
    );
    ids.orderId = order.id;
    if (simulatorMode) {
      await simPost(`/_sim/orders/${order.id}/approve`);
    } else {
      const approve = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
      console.log(`Approve the order as the sandbox personal (buyer) account: ${approve?.href ?? "(no approval link returned)"}`);
      await pressEnter("Approve the order in the browser.");
      await waitFor("order APPROVED", async () => ((await client.getOrder(order.id)).status === "APPROVED" ? true : undefined), 60_000);
    }
    const captured = await client.captureOrder(order.id, `dd-${runId}-${branch}-capture`);
    const capture = captured.purchase_units[0]?.payments?.captures?.[0];
    check(capture?.status === "COMPLETED", `capture status was ${capture?.status}`, captured);
    ids.captureId = capture!.id;
    if (contest) {
      await client.addTracking(
        order.id,
        { captureId: capture!.id, trackingNumber: UPS_TRACKING.trackingNumber, carrier: "UPS", notifyPayer: false },
        `dd-${runId}-${branch}-track`,
      );
      const tracker = await client.getTracking(capture!.id, UPS_TRACKING.trackingNumber);
      check(tracker.status === "SHIPPED", `tracker status was ${tracker.status}`, tracker);
      return `order ${order.id}, capture ${capture!.id}, tracking ${tracker.tracking_number} (${tracker.status})`;
    }
    return `order ${order.id}, capture ${capture!.id}, no tracking (the item was never shipped)`;
  });

  const sellerRecord: SellerRecord = contest
    ? {
        kind: "carrier_delivery_scan",
        label: "Carrier delivery scan (UPS)",
        fact: `UPS scan: delivered to front door, signed S. BUYER. Tracking ${UPS_TRACKING.trackingNumber}.`,
        recordedAt: new Date().toISOString(),
        carrier: "UPS",
        trackingNumber: UPS_TRACKING.trackingNumber,
      }
    : {
        kind: "not_shipped",
        label: "Seller fulfilment note",
        fact: "Item was out of stock and never shipped. No label was purchased and no carrier received a parcel.",
        recordedAt: new Date().toISOString(),
      };
  current.sellerRecords = [sellerRecord];
  writeFileSync(join(sellerDir, `${ids.captureId}.json`), JSON.stringify([sellerRecord], null, 2));

  await step("3", "buyer opens a dispute; webhook arrives, signature verifies, transaction id correlates", async () => {
    if (simulatorMode) {
      const opened = await simPost("/_sim/disputes", {
        capture_id: ids.captureId,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        note: "My parcel never arrived.",
      });
      ids.disputeId = opened.dispute_id;
      ids.createdEventId = opened.event_id;
    } else {
      console.log(`Open a dispute as the sandbox personal account in Resolution Center for capture ${ids.captureId}, reason "item not received".`);
      await pressEnter("Open the dispute.");
      const found = await waitFor("the dispute to appear in listDisputes", async () => {
        const list = await client.listDisputes({ disputed_transaction_id: ids.captureId });
        return list.items[0]?.dispute_id;
      }, 120_000);
      ids.disputeId = found;
    }

    const dispute = await client.getDispute(ids.disputeId);
    const seller = dispute.disputed_transactions[0]?.seller_transaction_id;
    check(seller === ids.captureId, `dispute lists seller_transaction_id ${seller}, expected capture ${ids.captureId}`, dispute);

    if (simulatorMode) {
      const c = await awaitCase(ids.disputeId, "the CREATED webhook to produce a case", () => true);
      const verify = current.exchanges.find((e) => "url" in e && e.url.endsWith("/v1/notifications/verify-webhook-signature"));
      check(
        verify && "responseBody" in verify && (verify.responseBody as Json).verification_status === "SUCCESS",
        "PayPal did not report verification_status SUCCESS for the delivered webhook",
        verify,
      );
      const received = (c.audit as Json[]).filter((a) => a.kind === "webhook.received");
      check(received.length === 1 && received[0]?.detail.eventId === ids.createdEventId, "case audit does not show the CREATED event received once", c.audit);
      return `dispute ${ids.disputeId}, seller_transaction_id ${seller} matches capture, webhook ${ids.createdEventId} verified SUCCESS`;
    }
    await apiOk("POST", `/api/cases/${ids.disputeId}/reassess`);
    return `dispute ${ids.disputeId}, seller_transaction_id ${seller} matches capture (webhook not exercised: needs a public URL registered in the developer dashboard)`;
  });

  await step("4", contest ? "inspect links; reach the evidence-eligible state" : "inspect links; confirm accept_claim is offered", async () => {
    let dispute = await client.getDispute(ids.disputeId);
    const first = rels(dispute);
    if (!contest) {
      check(first.includes("accept_claim"), `accept_claim missing from links: ${first.join(", ")}`, dispute.links);
      return `links ${first.join(", ")}`;
    }
    const trail = [`links ${first.join(", ")}`];
    if (!first.includes("provide_evidence")) {
      check(first.includes("escalate"), `neither provide_evidence nor escalate is offered: ${first.join(", ")}`, dispute.links);
      await client.escalate(ids.disputeId, "Seller disputes the claim and will provide delivery evidence.", `dd-${runId}-escalate`);
      dispute = await client.getDispute(ids.disputeId);
      trail.push(`after escalate: ${dispute.status}/${dispute.dispute_life_cycle_stage}, links ${rels(dispute).join(", ")}`);
    }
    if (!rels(dispute).includes("provide_evidence")) {
      check(rels(dispute).includes("require_evidence"), `provide_evidence is not reachable: ${rels(dispute).join(", ")}`, dispute.links);
      const res = await apiOk("POST", `/api/sandbox/disputes/${ids.disputeId}/require-evidence`, { action: "SELLER_EVIDENCE" });
      check(res.simulated_resolution === true, "sandbox helper response lacks simulated_resolution", res);
      dispute = await client.getDispute(ids.disputeId);
      trail.push(`after require-evidence: ${dispute.status}, links ${rels(dispute).join(", ")}`);
    }
    check(rels(dispute).includes("provide_evidence"), "provide_evidence never became available", dispute.links);
    ids.statusBeforeEvidence = dispute.status;
    await awaitCase(ids.disputeId, "the case to see provide_evidence", (c) => c.permittedRels.includes("provide_evidence") && c.guardFailures.length === 0 && c.assessment?.recommendation !== undefined);
    return trail.join("; ");
  });

  await step(contest ? "5" : "6", contest ? "contest: recommend -> approve -> provide-evidence -> verify persisted" : "concede: recommend -> approve -> accept-claim -> verify refund", async () => {
    const c = (await caseOf(ids.disputeId)) as Case & Json;
    const expected = contest ? "contest" : "concede";
    check(c.assessment?.recommendation?.action === expected, `recommendation was ${c.assessment?.recommendation?.action}, expected ${expected}`, c.assessment?.recommendation);
    const rec = c.assessment?.recommendation!;
    check(c.guardFailures.length === 0, "guard reports failures", c.guardFailures);
    const sellerEvidence = c.evidence.filter((e) => e.source === "seller.record").map((e) => e.id);
    check(sellerEvidence.length > 0, "case evidence has no seller.record item", c.evidence);
    const cited = rec.supports.some((s) => s.evidenceIds.some((id) => sellerEvidence.includes(id)));
    check(cited, "no supporting claim cites the seller record", rec.supports);
    console.log(`  recommendation: ${rec.action} (${rec.confidence}) -- ${rec.summary}`);

    await apiOk("POST", `/api/cases/${ids.disputeId}/approve`, { approvedBy: "rehearsal-seller", recommendationRevision: c.recommendationRevision });
    const executed = await apiOk("POST", `/api/cases/${ids.disputeId}/execute`);
    check(executed.execution?.httpStatus === 200, `PayPal answered ${executed.execution?.httpStatus}`, executed.execution);

    const after = await client.getDispute(ids.disputeId);
    if (contest) {
      check(after.status !== ids.statusBeforeEvidence, `status did not change from ${ids.statusBeforeEvidence}`, after);
      const persisted = JSON.stringify(after.evidences);
      check(after.evidences.length >= 1 && persisted.includes(UPS_TRACKING.trackingNumber), "submitted evidence is not on the re-fetched dispute", after.evidences);
      return `status ${ids.statusBeforeEvidence} -> ${after.status}, ${after.evidences.length} evidence item(s) persisted with tracking ${UPS_TRACKING.trackingNumber}`;
    }
    check(after.status === "RESOLVED", `dispute status ${after.status}, expected RESOLVED`, after);
    check(/BUYER/.test(after.dispute_outcome?.outcome_code ?? ""), `outcome ${after.dispute_outcome?.outcome_code} is not in the buyer's favour`, after.dispute_outcome);
    const order = await client.getOrder(ids.orderId);
    const refunds = order.purchase_units[0]?.payments?.refunds ?? [];
    check(refunds.length === 1, `expected exactly one refund on the capture, found ${refunds.length}`, order.purchase_units[0]?.payments);
    const refundCalls = current.exchanges.filter((e) => "url" in e && /refund/i.test(e.url) && e.method !== "GET");
    check(refundCalls.length === 0, "the client issued a separate refund call", refundCalls);
    const acceptCalls = current.exchanges.filter((e) => "url" in e && e.url.endsWith("/accept-claim"));
    check(acceptCalls.length === 1, `expected one accept-claim call, found ${acceptCalls.length}`, acceptCalls);
    return `RESOLVED ${after.dispute_outcome?.outcome_code}; 1 refund on capture ${ids.captureId} made by PayPal itself; 1 accept-claim, 0 refund calls`;
  });

  if (!contest) return;

  if (simulatorMode) await step("7a", "redeliver the CREATED webhook; the case is not processed twice", async () => {
    // Settle earlier action webhooks before measuring only this redelivery.
    await settleSimulatorDeliveries?.();
    const before = (await caseOf(ids.disputeId))!;
    const callsBefore = modelCalls;
    const res = await simPost(`/_sim/webhooks/redeliver/${ids.createdEventId}`);
    check(res.listener_status === 200, `listener answered ${res.listener_status} to the redelivery`, res);
    const after = (await caseOf(ids.disputeId))!;
    const received = (after.audit as Json[]).filter((a) => a.kind === "webhook.received" && a.detail.eventId === ids.createdEventId);
    const duplicate = (after.audit as Json[]).filter((a) => a.kind === "webhook.duplicate" && a.detail.eventId === ids.createdEventId);
    check(received.length === 1, `event processed ${received.length} times`, after.audit);
    check(duplicate.length >= 1, "no webhook.duplicate audit entry", after.audit);
    check(modelCalls === callsBefore, "the model was called again for a duplicate event");
    check(after.updatedAt === before.updatedAt, "the case changed on a duplicate event", { before: before.updatedAt, after: after.updatedAt });
    return `event ${ids.createdEventId} received once, ${duplicate.length} duplicate(s) acknowledged, no new model call`;
  });
  else skip("7a", "redeliver the CREATED webhook", "the real sandbox cannot be told to redeliver from here; use Resend in the developer dashboard");

  await step("7b", "adjudicate branch A (sandbox helper)", async () => {
    const res = await apiOk("POST", `/api/sandbox/disputes/${ids.disputeId}/adjudicate`, { outcome: "SELLER_FAVOR" });
    check(res.simulated_resolution === true, "response lacks simulated_resolution: true", res);
    console.log("  NOTE: this adjudication is a caller-chosen simulation. This script picked SELLER_FAVOR; it proves nothing about how good the evidence was.");
    const final = await awaitCase(ids.disputeId, "the case to resolve", (c) => c.status === "resolved");
    const dispute = await client.getDispute(ids.disputeId);
    check(dispute.status === "RESOLVED", `dispute status ${dispute.status}`, dispute);
    return `dispute RESOLVED, case ${final.status} (${final.outcome}); outcome chosen by the caller, not earned`;
  });
}

async function main(): Promise<void> {
  const simNote = await startEmbeddedSimulatorIfNeeded();
  listenerPort = await listenOnEphemeralPort();
  console.log(`RebuttalForge listener on http://localhost:${listenerPort}; ${simNote}`);
  if (simulatorMode) await simPost("/_sim/config", { webhook_url: `http://localhost:${listenerPort}/webhooks/paypal` });

  current = records.contest;
  await step("1", "auth + base URL", async () => {
    await client.listDisputes({ page_size: "1" });
    const tokenCall = current.exchanges.find((e) => "url" in e && e.url.endsWith("/v1/oauth2/token")) as Exchange | undefined;
    check(tokenCall?.status === 200, `token request answered ${tokenCall?.status}`, tokenCall?.responseBody);
    const header = tokenCall!.responseHeaders[SIMULATOR_HEADER] === "true";
    check(header === simulatorMode, `simulator header ${header} disagrees with base URL host (simulator=${simulatorMode})`);
    const label = header ? "SIMULATOR (X-Dispute-Desk-Simulator: true), not the real PayPal sandbox" : "real PayPal sandbox";
    return `${baseUrl} is the ${label}`;
  });

  await runBranch("contest");
  await runBranch("concede");

  finish();
  console.log("");
  for (const f of writtenFiles) console.log(`record: ${f}`);
  console.log(modelNote);
  console.log(simulatorMode ? "Result: PASS against the SIMULATOR. This says nothing about the real PayPal sandbox." : "Result: PASS against the PayPal sandbox.");
  for (const close of closers) close();
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error("FAIL rehearsal crashed outside a step:", e instanceof Error ? e.message : e);
  if (e instanceof StepFailure && e.response !== undefined) console.error(`Exact failing response:\n${JSON.stringify(e.response, null, 2)}`);
  current.outcome = "FAIL";
  current.failure = { message: e instanceof Error ? e.message : String(e) };
  finish();
  process.exit(1);
});
