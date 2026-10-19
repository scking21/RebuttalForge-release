import { canonical, responsePolicy } from "./response-policy.js";
import { ApprovalStale, decisionFacts } from "./approval.js";
import { randomUUID } from "node:crypto";
import { ACTION_REL, type Action, type Case, type CaseStatus, type Assessment, type HoldAssessment } from "./domain.js";
import { gatherEvidence, UnsupportedTransaction } from "./agent/evidence.js";
import { checkRecommendation } from "./agent/guard.js";
import { AssessmentSchema, type Model } from "./agent/model.js";
import type { SellerRecordsLoader } from "./agent/seller-records.js";
import type { Dispute } from "./paypal/schemas.js";
import type { PayPalClient } from "./paypal/client.js";
import type { Store } from "./store.js";
import { AssessmentTimer, type AssessmentOutcome } from "./assessment-timing.js";

export interface PipelineDeps {
  client: PayPalClient;
  store: Store;
  model?: Model;
  sellerRecords: SellerRecordsLoader;
  now: () => Date;
  // Injectable for deterministic diagnostics tests; never use the wall clock for durations.
  monotonicNow?: () => number;
}

// Statuses in which new evidence or a new recommendation may still replace the old.
export const REFRESHABLE: CaseStatus[] = ["received", "evidence_gathered", "recommended", "failed"];

export const permittedActions = (rels: string[]): Action[] =>
  (Object.keys(ACTION_REL) as Action[]).filter((a) => rels.includes(ACTION_REL[a]));

// Serialises work per dispute so a webhook and an API call cannot interleave.
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

// A provider snapshot does not establish a safe new action after acknowledged execution.
export async function syncResolution(deps: PipelineDeps, disputeId: string): Promise<Case> {
  const found = deps.store.getCase(disputeId);
  if (!found) throw new Error(`No case for dispute ${disputeId}`);
  if (found.status === "resolved") return found;
  const dispute = await deps.client.getDispute(disputeId);
  if (dispute.dispute_id !== disputeId) throw new Error("Dispute identity mismatch");
  if (dispute.status === "RESOLVED") {
    return deps.store.transition(disputeId, "resolved", { outcome: dispute.dispute_outcome?.outcome_code, postExecutionReview: undefined });
  }
  if (found.pendingAction) return found;
  if (found.status === "approved") {
    let freshFacts;
    try {
      freshFacts = decisionFacts(dispute);
    } catch (error) {
      if (!(error instanceof ApprovalStale)) throw error;
      return assess(deps, disputeId, dispute);
    }
    if (found.assessment?.kind !== "actionable" || canonical(freshFacts) !== canonical(found.decisionFacts)) {
      return assess(deps, disputeId, dispute);
    }
  }
  if (found.status === "executed" && found.execution) {
    const needsReview = dispute.status === "WAITING_FOR_SELLER_RESPONSE" || found.postExecutionReview !== undefined;
    deps.store.saveCase({
      ...found,
      sellerResponseDueDate: dispute.seller_response_due_date,
      permittedRels: dispute.links.filter(link => link.method === "POST").map(link => link.rel),
      postExecutionReview: needsReview ? {
        reason: "Additional provider work needs manual review. This app cannot safely establish a new response cycle after an acknowledged action; no further action will be sent.",
        providerStatus: dispute.status,
        evidence: dispute.evidences,
        messages: dispute.messages,
        observedAt: deps.now().toISOString(),
      } : undefined,
    });
    if (needsReview) deps.store.audit(disputeId, "execution.followup_review", { providerStatus: dispute.status });
    return deps.store.getCase(disputeId)!;
  }
  return found;
}

// Creates the case from PayPal if it is new, otherwise refreshes its evidence and
// recommendation. Callers must have checked the case is in a refreshable status.
export async function assess(deps: PipelineDeps, disputeId: string, fetchedDispute?: Dispute): Promise<Case> {
  const timer = new AssessmentTimer(deps.monotonicNow);
  let outcome: AssessmentOutcome = "error";
  try {
    const result = await assessOnce(deps, disputeId, timer, fetchedDispute);
    outcome = result.status === "resolved" ? "resolved" : result.assessment?.kind === "actionable" ? "actionable" : "hold";
    return result;
  } finally {
    // Diagnostics must not change an assessment result or mask its original error.
    try { deps.store.audit(disputeId, "assessment.timing", timer.finish(outcome, fetchedDispute !== undefined)); }
    catch { console.warn("Assessment timing audit unavailable"); }
  }
}

async function assessOnce(deps: PipelineDeps, disputeId: string, timer: AssessmentTimer, fetchedDispute?: Dispute): Promise<Case> {
  const { client, store, model, sellerRecords, now } = deps;
  store.beginAssessment(disputeId);
  let gathered;
  let fetched = fetchedDispute;
  const persistHold = (assessment: HoldAssessment): Case => {
    const current = store.getCase(disputeId)!;
    const patch = { assessment, recommendationRevision: undefined, approvedBy: undefined, approvedSnapshot: undefined, decisionFacts: undefined, guardFailures: [], error: undefined };
    store.audit(disputeId, "assessment.held", { reason: assessment.reason });
    if (current.status === "received") return store.transition(disputeId, "evidence_gathered", patch);
    store.saveCase({ ...current, ...patch });
    return store.getCase(disputeId)!;
  };
  let verifiedDecisionFacts;
  timer.begin("evidenceRetrievalMs");
  try {
    fetched ??= await client.getDispute(disputeId);
    if (fetched.dispute_id !== disputeId) throw new Error("Dispute identity mismatch");
    const current = store.getCase(disputeId);
    const providerFacts = {
      reason: fetched.reason, amount: fetched.dispute_amount,
      sellerResponseDueDate: fetched.seller_response_due_date,
      permittedRels: fetched.links.filter(l => l.method === "POST").map(l => l.rel), evidence: [],
    };
    if (!current) {
      store.saveCase({ disputeId, status: "received", ...providerFacts, guardFailures: [], updatedAt: now().toISOString() });
      store.audit(disputeId, "case.created", { reason: fetched.reason, amount: fetched.dispute_amount });
    } else store.saveCase({ ...current, ...providerFacts });
    if (fetched.status === "RESOLVED") return store.transition(disputeId, "resolved", { outcome: fetched.dispute_outcome?.outcome_code });
    if (fetched.reason !== "MERCHANDISE_OR_SERVICE_NOT_RECEIVED") return persistHold({
      kind: "hold", reason: "UNSUPPORTED_RESPONSE", summary: "This app only assesses item-not-received disputes.", evidenceIds: [],
      reviewerNextStep: "Review this dispute and its response requirements directly in PayPal before the displayed deadline.",
    });
    gathered = await gatherEvidence(client, disputeId, sellerRecords, now(), fetched);
    verifiedDecisionFacts = decisionFacts(gathered.dispute);
  } catch (error) {
    if (error instanceof UnsupportedTransaction && store.getCase(disputeId)) return persistHold({
      kind: "hold", reason: "UNSUPPORTED_TRANSACTION", summary: `Evidence retrieval could not establish the supported single-capture Orders v2 identity: ${error.message}. This says nothing about the buyer's claim.`, evidenceIds: [],
      reviewerNextStep: "Review the transaction identity and records directly in PayPal. Reassess once the supported capture and order can be linked; the response deadline still applies.",
    });
    const existing = store.getCase(disputeId);
    if (existing && REFRESHABLE.includes(existing.status)) {
      const patch = {
        assessment: undefined, recommendationRevision: undefined, guardFailures: [],
        error: error instanceof Error ? error.message : String(error),
      };
      if (existing.status === "failed") store.saveCase({ ...existing, ...patch });
      else store.transition(disputeId, "failed", patch);
    }
    throw error;
  } finally {
    timer.end("evidenceRetrievalMs");
  }
  const { dispute, evidence } = gathered;
  const permittedRels = dispute.links.filter(l => l.method === "POST").map((l) => l.rel);
  const facts = {
    decisionFacts: verifiedDecisionFacts,
    approvedSnapshot: undefined,
    reason: dispute.reason,
    amount: dispute.dispute_amount,
    sellerResponseDueDate: dispute.seller_response_due_date,
    permittedRels,
    evidence,
  };

  let current = store.getCase(disputeId);
  if (!current) {
    store.saveCase({ disputeId, status: "received", ...facts, guardFailures: [], updatedAt: now().toISOString() });
    store.audit(disputeId, "case.created", { reason: dispute.reason, amount: dispute.dispute_amount });
    current = store.getCase(disputeId)!;
  }
  if (current.status === "failed") current = store.transition(disputeId, "received", { error: undefined });
  if (current.status === "received") current = store.transition(disputeId, "evidence_gathered", facts);
  else store.saveCase({ ...current, ...facts });
  store.audit(disputeId, "evidence.gathered", { count: evidence.length, permittedRels });

  if (dispute.status === "RESOLVED") {
    return store.transition(disputeId, "resolved", { outcome: dispute.dispute_outcome?.outcome_code });
  }

  const actions = permittedActions(permittedRels);
  // Evidence was just replaced, so earlier advice no longer applies to it.
  let assessment: Assessment | undefined;
  let error: string | undefined;
  if (actions.length === 0) assessment = { kind: "hold", reason: "UNSUPPORTED_RESPONSE", summary: `No supported seller action is currently permitted (dispute status ${dispute.status}).`, evidenceIds: [], reviewerNextStep: "Review the current response requirements directly in PayPal; check the displayed deadline." };
  else if (!model) error = "AI not configured";
  else {
    timer.begin("modelAssessmentMs");
    try {
      assessment = AssessmentSchema.parse(await model.recommend({
        dispute: {
          disputeId,
          reason: dispute.reason,
          stage: dispute.dispute_life_cycle_stage,
          status: dispute.status,
          amount: dispute.dispute_amount,
          sellerResponseDueDate: dispute.seller_response_due_date,
          responsePolicy: responsePolicy(dispute),
        },
        evidence,
        permittedActions: actions,
      }));
    } catch (e) {
      error = `AI error: ${e instanceof Error ? e.message : String(e)}`;
      store.audit(disputeId, "recommendation.error", { error });
    } finally {
      timer.end("modelAssessmentMs");
    }
  }

  const recommendation = assessment?.kind === "actionable" ? assessment.recommendation : undefined;
  if (assessment?.kind === "hold" && assessment.evidenceIds.some(id => !evidence.some(e => e.id === id))) {
    assessment = undefined;
    error = "AI error: hold cites unknown evidence";
  }
  if (!assessment) assessment = { kind: "hold", reason: "MODEL_UNAVAILABLE", summary: error ?? "No assessment available.", evidenceIds: [], reviewerNextStep: "Review the source records and retry assessment. Check the response deadline in PayPal." };
  const guardFailures = recommendation
    ? checkRecommendation(recommendation, evidence, permittedRels, dispute.dispute_amount, dispute.seller_response_due_date, now(), responsePolicy(dispute), verifiedDecisionFacts.captureId)
    : [];
  if (recommendation && guardFailures.length > 0) {
    assessment = { kind: "hold", reason: "UNSUPPORTED_RESPONSE", summary: "The proposed response failed the local reference or response checks. No draft is available to approve or send.", evidenceIds: [], reviewerNextStep: "Review the guard issues and source records below. Correct missing or unsupported evidence and reassess, or respond directly in PayPal before the deadline." };
  }
  if (recommendation && assessment.kind === "actionable") {
    store.audit(disputeId, "recommendation.checked", {
      action: recommendation.action,
      guardFailures: guardFailures.map((f) => f.code),
    });
    return store.transition(disputeId, "recommended", { ...facts, assessment, recommendationRevision: randomUUID(), guardFailures, error });
  }
  store.audit(disputeId, "assessment.held", { reason: assessment.kind === "hold" ? assessment.reason : undefined, guardFailures: guardFailures.map(f => f.code) });
  const stale = store.getCase(disputeId)!;
  if (stale.status === "recommended") return store.transition(disputeId, "evidence_gathered", { assessment, recommendationRevision: undefined, guardFailures, error });
  store.saveCase({ ...stale, assessment, recommendationRevision: undefined, guardFailures, error });
  return store.getCase(disputeId)!;
}
