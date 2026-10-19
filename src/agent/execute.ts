import { createHash } from "node:crypto";
import { ManualReconciliationRequired } from "../store.js";
import { checkResponsePolicy, responsePolicy, sellerRequestState } from "../response-policy.js";
import { assertApprovalCurrent } from "../approval.js";
import { ACTION_REL, type Action, type Case, type Execution, type Recommendation } from "../domain.js";
import { PayPalError, type PayPalClient } from "../paypal/client.js";
import type { Dispute } from "../paypal/schemas.js";
import { checkTrackingEvidence } from "./guard.js";

export class ExecutionBlocked extends Error {
  constructor(
    readonly disputeId: string,
    readonly rel: string,
    readonly status: string,
  ) {
    super(`PayPal no longer permits ${rel} on ${disputeId} (status ${status})`);
  }
}

export class IncompleteDraft extends Error {}

// The action request left this process but no response came back, so PayPal may or may not have applied it.
export class UnknownOutcome extends Error {
  constructor(readonly disputeId: string, readonly action: Action, cause: unknown) {
    super(`The ${action} request for ${disputeId} got no response, so its outcome is unknown. Manually reconcile it with PayPal; this app will not automatically resubmit or clear the pending action.`, { cause });
  }
}

// Concede is accept-claim only: PayPal refunds the buyer itself, so the client has no refund call to misuse.
export type ExecutorClient = Pick<PayPalClient, "getDispute" | "provideEvidence" | "makeOffer" | "acceptClaim">;

export interface ExecutionResult {
  execution: Execution;
  // Absent when PayPal accepted the action but the follow-up read failed.
  after?: Dispute;
}

export const requestIdFor = (disputeId: string, action: Action, revision: string) =>
  `dd-${createHash("sha256").update(JSON.stringify([disputeId, action, revision])).digest("hex").slice(0, 32)}`;

export function summarize(d: Dispute) {
  return {
    status: d.status,
    stage: d.dispute_life_cycle_stage,
    outcome: d.dispute_outcome?.outcome_code,
    evidenceCount: d.evidences.length,
    rels: d.links.map((l) => l.rel),
  };
}

export async function executeApproved(
  c: Case,
  client: ExecutorClient,
  now: () => Date = () => new Date(),
  beforeAction?: (intent: NonNullable<Case["pendingAction"]>) => void,
): Promise<ExecutionResult> {
  if (c.execution) return { execution: c.execution, after: await client.getDispute(c.disputeId) };
  if (c.pendingAction) throw new ManualReconciliationRequired();
  const rec = c.assessment?.kind === "actionable" ? c.assessment.recommendation : undefined;
  if (c.status !== "approved" || !rec) throw new Error(`Case ${c.disputeId} is not approved (status ${c.status})`);

  const before = await client.getDispute(c.disputeId);
  assertApprovalCurrent(c, before, now());
  const rel = ACTION_REL[rec.action];
  if (before.status === "RESOLVED" || before.status === "OTHER" || !before.links.some((l) => l.rel === rel && l.method === "POST")) throw new ExecutionBlocked(c.disputeId, rel, before.status);

  const policyFailures = [...checkResponsePolicy(rec, responsePolicy(before)), ...checkTrackingEvidence(rec, c.evidence, c.decisionFacts?.captureId)];
  if (policyFailures.length) throw new IncompleteDraft(`Manual review required: ${policyFailures.map(f => f.code).join(", ")}`);

  const requestId = requestIdFor(c.disputeId, rec.action, c.recommendationRevision!);
  beforeAction?.({ requestId, revision: c.recommendationRevision!, at: now().toISOString() });
  let res;
  try {
    res = await act(c.disputeId, rec, client, requestId);
  } catch (e) {
    if ((e instanceof PayPalError && e.status < 500 && e.status !== 408) || e instanceof IncompleteDraft) throw e;
    throw new UnknownOutcome(c.disputeId, rec.action, e);
  }

  // PayPal has acted by now, so a failed read below must not lose the record of it.
  let after: Dispute | undefined;
  let afterSummary: unknown;
  try {
    const fetched = await client.getDispute(c.disputeId);
    if (fetched.dispute_id !== c.disputeId) throw new Error("Dispute identity mismatch after action");
    after = fetched;
    afterSummary = summarize(after);
  } catch (e) {
    afterSummary = { unavailable: e instanceof Error ? e.message : String(e) };
  }
  const execution: Execution = {
    action: rec.action,
    requestId,
    beforeSellerRequest: sellerRequestState(before),
    afterSellerRequest: after ? sellerRequestState(after) : undefined,
    httpStatus: res.httpStatus,
    response: { paypal: res.body, after: afterSummary },
    at: now().toISOString(),
  };
  return { execution, after };
}

function act(disputeId: string, rec: Recommendation, client: ExecutorClient, requestId: string) {
  const { draft } = rec;
  switch (rec.action) {
    case "contest": {
      const evidenceType = draft.evidenceType ?? "PROOF_OF_FULFILLMENT";
      if (evidenceType === "PROOF_OF_FULFILLMENT" && !draft.tracking) {
        throw new IncompleteDraft("A PROOF_OF_FULFILLMENT contest needs a carrier and tracking number in the draft");
      }
      return client.provideEvidence(disputeId, { evidenceType, tracking: draft.tracking, notes: draft.note }, requestId);
    }
    case "offer": {
      if (!draft.offer) throw new IncompleteDraft("An offer needs an amount in the draft");
      return client.makeOffer(disputeId, { note: draft.note, offerType: draft.offer.type, amount: draft.offer.amount }, requestId);
    }
    case "concede":
      return client.acceptClaim(disputeId, { note: draft.note, acceptClaimType: "REFUND" }, requestId);
  }
}
