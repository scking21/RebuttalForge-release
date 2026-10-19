import { afterEach, describe, expect, it, vi } from "vitest";
import { assess, type PipelineDeps } from "../src/pipeline.js";
import { ScriptedModel, scriptedBranch } from "../src/agent/test-double.js";
import { UnsupportedTransaction } from "../src/agent/evidence.js";
import { PayPalError } from "../src/paypal/client.js";
import type { Model } from "../src/agent/model.js";
import { createApp } from "../src/server.js";
import { buyerOpensDispute, sellOne, startSystem, type System } from "./support/system.js";

const systems: System[] = [];
afterEach(() => { for (const sys of systems.splice(0)) sys.store.close(); vi.restoreAllMocks(); });
const wallNow = () => new Date("2026-10-18T00:00:00Z");
async function scenario(mode = "actionable") {
  let tick = 0;
  const sys = startSystem(); systems.push(sys);
  sys.sim.setWebhookUrl(undefined);
  const { captureId } = await sellOne(sys, "timing", { carrier: "UPS", number: "1Z999" });
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  for (const [name, ms] of [["getDispute", 5], ["getCapture", 7], ["getOrder", 11], ["getTracking", 13]] as const) {
    const original = sys.client[name].bind(sys.client);
    vi.spyOn(sys.client, name).mockImplementation((async (...args: unknown[]) => {
      tick += ms;
      if (mode === "fetch-error" && name === "getDispute") throw new PayPalError(503, "SYNTHETIC", "PRIVATE_PROVIDER_PAYLOAD", "PRIVATE_DEBUG", { secret: "PRIVATE_PAYLOAD" });
      if (mode === "unsupported-identity" && name === "getCapture") throw new UnsupportedTransaction("Synthetic missing identity");
      if (mode === "capture-error" && name === "getCapture") throw new Error("PRIVATE_CAPTURE_ERROR");
      const result = await (original as (...args: unknown[]) => Promise<unknown>)(...args);
      if (mode === "unsupported-reason" && name === "getDispute") Object.assign(result as object, { reason: "CREDIT_NOT_PROCESSED" });
      if (mode === "resolved" && name === "getDispute") Object.assign(result as object, { status: "RESOLVED" });
      return result;
    }) as never);
  }
  const base = scriptedBranch("concede");
  const model: Model | undefined = mode === "no-model" ? undefined : new ScriptedModel(async input => {
    tick += 17;
    if (mode === "model-error") throw new Error("PRIVATE_MODEL_PAYLOAD_OR_KEY");
    if (mode === "invalid-model") return { kind: "malformed", private: "PRIVATE_INVALID_PAYLOAD" } as never;
    if (mode === "hold") return { kind: "hold", reason: "MISSING_EVIDENCE", summary: "Synthetic hold.", evidenceIds: [], reviewerNextStep: "Review the records." };
    return base.recommend(input);
  });
  const deps: PipelineDeps = {
    client: sys.client, store: sys.store, model, now: wallNow, monotonicNow: () => tick,
    sellerRecords: () => { tick += 3; return [{ kind: "not_shipped", label: "PRIVATE_SELLER_LABEL", fact: "Item never shipped. PRIVATE_SELLER_DATA", recordedAt: wallNow().toISOString() }]; },
  };
  const timing = () => sys.store.auditTrail(disputeId).filter(event => event.kind === "assessment.timing");
  return { sys, disputeId, deps, timing, resetClock: () => { tick = 0; } };
}
const expected = (over = {}) => ({
  clock: "monotonic", scope: "assessment_work", evidenceRetrievalMs: 39, modelAssessmentMs: 17, totalAssessmentMs: 56,
  modelInvoked: true, prefetchedDispute: false, outcome: "actionable", ...over,
});

describe("monotonic assessment phase diagnostics", () => {
  it("separates evidence reads, model assessment and total without approving or executing", async () => {
    const s = await scenario();
    const result = await assess(s.deps, s.disputeId);
    expect(result.status).toBe("recommended");
    expect(s.timing()).toHaveLength(1);
    expect(s.timing()[0]?.detail).toEqual(expected());
    expect(result.approvedBy).toBeUndefined();
    expect(result.approvedSnapshot).toBeUndefined();
    expect(result.execution).toBeUndefined();
    expect(s.sys.fetchCalls.filter(call => /provide-evidence|accept-claim/.test(call))).toEqual([]);
  });
  it.each(["hold", "model-error", "invalid-model"])("includes completed model time for %s while preserving a non-actionable hold", async mode => {
    const s = await scenario(mode);
    const result = await assess(s.deps, s.disputeId);
    expect(result.assessment?.kind).toBe("hold");
    expect(result.recommendationRevision).toBeUndefined();
    expect(s.timing()[0]?.detail).toEqual(expected({ outcome: "hold" }));
    const diagnostics = JSON.stringify(s.timing());
    for (const value of ["PRIVATE_MODEL", "PRIVATE_INVALID", "PRIVATE_SELLER", "PAYLOAD", "trackingNumber", "evidenceIds"]) expect(diagnostics).not.toContain(value);
  });
  it("reports zero model duration and no invocation when AI is unconfigured", async () => {
    const s = await scenario("no-model");
    expect((await assess(s.deps, s.disputeId)).assessment).toMatchObject({ kind: "hold", reason: "MODEL_UNAVAILABLE" });
    expect(s.timing()[0]?.detail).toEqual(expected({ modelAssessmentMs: 0, totalAssessmentMs: 39, modelInvoked: false, outcome: "hold" }));
  });
  it.each([["unsupported-reason", 5, "hold"], ["unsupported-identity", 15, "hold"], ["resolved", 5, "resolved"]] as const)("records early %s without calling the model", async (mode, duration, outcome) => {
    const s = await scenario(mode);
    await assess(s.deps, s.disputeId);
    expect(s.timing()[0]?.detail).toEqual(expected({ evidenceRetrievalMs: duration, modelAssessmentMs: 0, totalAssessmentMs: duration, modelInvoked: false, outcome }));
  });
  it.each([["fetch-error", 5], ["capture-error", 15]] as const)("records %s duration, including failure before a case exists, without copying the exception", async (mode, duration) => {
    const s = await scenario(mode);
    await expect(assess(s.deps, s.disputeId)).rejects.toThrow();
    expect(s.timing()).toHaveLength(1);
    expect(s.timing()[0]?.detail).toEqual(expected({ evidenceRetrievalMs: duration, modelAssessmentMs: 0, totalAssessmentMs: duration, modelInvoked: false, outcome: "error" }));
    expect(JSON.stringify(s.timing())).not.toMatch(/PRIVATE|PAYLOAD|DEBUG|secret/);
  });
  it("does not repeat an already fetched dispute and labels that timing boundary", async () => {
    const s = await scenario();
    const fetched = await s.sys.client.getDispute(s.disputeId);
    s.resetClock();
    vi.mocked(s.sys.client.getDispute).mockClear();
    await assess(s.deps, s.disputeId, fetched);
    expect(s.sys.client.getDispute).not.toHaveBeenCalled();
    expect(s.timing()[0]?.detail).toEqual(expected({ evidenceRetrievalMs: 34, totalAssessmentMs: 51, prefetchedDispute: true }));
  });
  it("is independent of wall-clock adjustments", async () => {
    const s = await scenario();
    let wall = 100000;
    vi.spyOn(Date, "now").mockImplementation(() => { wall -= 5000; return wall; });
    await assess(s.deps, s.disputeId);
    expect(s.timing()[0]?.detail).toEqual(expected());
  });
  it("is wired through the real reassess route and visible in the existing case audit", async () => {
    const s = await scenario();
    const app = createApp({ ...s.deps });
    const response = await app.request(`/api/cases/${s.disputeId}/reassess`, { method: "POST", headers: { "x-rebuttalforge-request": "operator" } });
    expect(response.status).toBe(200);
    const detail = await app.request(`/api/cases/${s.disputeId}`);
    const body = await detail.json() as { audit: { kind: string; detail: unknown }[] };
    expect(body.audit.find(event => event.kind === "assessment.timing")?.detail).toEqual(expected());
  });

  it("uses a finite nonnegative default monotonic clock without test injection", async () => {
    const s = await scenario();
    delete s.deps.monotonicNow;
    await assess(s.deps, s.disputeId);
    const detail = s.timing()[0]?.detail as Record<string, unknown>;
    for (const key of ["evidenceRetrievalMs", "modelAssessmentMs", "totalAssessmentMs"]) {
      expect(Number.isFinite(detail[key])).toBe(true);
      expect(detail[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(["actionable", "fetch-error"])("a timing-audit failure cannot replace the original %s result or expose exception text", async mode => {
    const s = await scenario(mode);
    const audit = s.sys.store.audit.bind(s.sys.store);
    vi.spyOn(s.sys.store, "audit").mockImplementation((id, kind, detail) => {
      if (kind === "assessment.timing") throw new Error("PRIVATE_TIMING_STORAGE_DETAILS");
      return audit(id, kind, detail);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (mode === "fetch-error") await expect(assess(s.deps, s.disputeId)).rejects.toBeInstanceOf(PayPalError);
    else expect((await assess(s.deps, s.disputeId)).status).toBe("recommended");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Assessment timing audit unavailable");
  });
});
