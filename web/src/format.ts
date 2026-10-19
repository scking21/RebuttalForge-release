import { minorUnits } from "../../src/money";
import { ACTION_REL } from "../../src/domain";
import type {
  Action,
  Case,
  CaseStatus,
  Evidence,
  EvidenceSource,
  GuardFailure,
  Money,
  Recommendation,
} from "../../src/domain";

export const STATUS_ORDER = [
  "received",
  "evidence_gathered",
  "recommended",
  "approved",
  "executed",
  "resolved",
] as const satisfies readonly CaseStatus[];

export const STATUS_LABEL: Record<CaseStatus, string> = {
  received: "Received",
  evidence_gathered: "Evidence gathered",
  recommended: "Recommended",
  approved: "Approved",
  executed: "Executed",
  resolved: "Resolved",
  failed: "Failed",
};

export const ACTION_LABEL: Record<Action, string> = {
  contest: "Contest",
  offer: "Offer refund",
  concede: "Accept claim and refund buyer",
};

export const CONFIDENCE_LEVEL: Record<Recommendation["confidence"], 1 | 2 | 3> = {
  low: 1,
  medium: 2,
  high: 3,
};

export interface SourceInfo {
  label: string;
  origin: "paypal" | "seller";
}

export const SOURCE_INFO: Record<EvidenceSource, SourceInfo> = {
  "paypal.dispute": { label: "PayPal dispute", origin: "paypal" },
  "paypal.order": { label: "PayPal order", origin: "paypal" },
  "paypal.tracking": { label: "PayPal tracking", origin: "paypal" },
  "seller.record": { label: "Seller record", origin: "seller" },
};

const REASON_LABEL: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  ITEM_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Item not as described",
  UNAUTHORISED: "Unauthorised transaction",
  UNAUTHORIZED: "Unauthorised transaction",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  DUPLICATE_TRANSACTION: "Duplicate transaction",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid by other means",
  CANCELED_RECURRING_BILLING: "Cancelled recurring billing",
  PROBLEM_WITH_REMITTANCE: "Problem with remittance",
  OTHER: "Other",
};

export function humanReason(reason: string): string {
  const known = REASON_LABEL[reason];
  if (known) return known;
  const words = reason.toLowerCase().replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function amountValue(m: Money): number {
  const n = Number(m.value);
  return Number.isFinite(n) ? n : 0;
}

export function formatMoney(m: Money): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency_code }).format(amountValue(m));
  } catch {
    return `${m.value} ${m.currency_code}`;
  }
}

const DAY_MS = 86_400_000;

export type DueState = "none" | "ok" | "soon" | "overdue";

export interface DueInfo {
  state: DueState;
  days: number;
  label: string;
}

export function dueInfo(due: string | undefined, now: number = Date.now()): DueInfo {
  if (!due) return { state: "none", days: Number.POSITIVE_INFINITY, label: "No deadline" };
  const ms = Date.parse(due) - now;
  if (Number.isNaN(ms)) return { state: "none", days: Number.POSITIVE_INFINITY, label: "No deadline" };
  if (ms < 0) {
    const days = Math.floor(-ms / DAY_MS);
    return { state: "overdue", days: -days, label: days === 0 ? "Overdue today" : `Overdue by ${plural(days, "day")}` };
  }
  const days = Math.ceil(ms / DAY_MS);
  return { state: days <= 2 ? "soon" : "ok", days, label: `${plural(days, "day")} left` };
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "Not set";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function permittedActions(c: Case): Action[] {
  return (Object.keys(ACTION_REL) as Action[]).filter((a) => c.permittedRels.includes(ACTION_REL[a]));
}

export function describeGuardFailure(f: GuardFailure): string {
  switch (f.code) {
    case "RESPONSE_SUBTYPE_NOT_PERMITTED":
      return `PayPal does not currently allow the ${f.subtype || "unspecified"} response for this action. Review its allowed response options.`;
    case "SELLER_RESPONSE_NOT_REQUESTED":
      return "PayPal is not currently waiting for seller evidence. Refresh the dispute before responding.";
    case "MANUAL_EVIDENCE_REVIEW":
      return `Manual evidence review required: ${f.reason}`;
    case "NO_SUPPORTING_CLAIM":
      return "The recommendation states no supporting claim, so nothing ties it to the evidence.";
    case "UNCITED_CLAIM":
      return `This claim cites no evidence: "${f.claim}"`;
    case "UNKNOWN_EVIDENCE":
      return `A claim cites ${f.evidenceId}, which is not in the evidence list.`;
    case "ACTION_NOT_PERMITTED":
      return `PayPal does not currently allow "${ACTION_LABEL[f.action]}" on this dispute. It needs the "${f.rel}" link, and the dispute does not carry it.`;
    case "NOTE_TOO_LONG":
      return `The draft note is ${f.length} characters, longer than PayPal accepts.`;
    case "TRACKING_NOT_IN_EVIDENCE":
      return `The draft carrier and tracking number ${f.trackingNumber} do not exactly match one cited fulfillment record for this capture. Source linkage does not prove the seller's assertion is true.`;
    case "INVALID_MONEY":
      return `The ${f.field} amount has an unsupported currency, invalid value or precision. Review it before approving.`;
    case "OFFER_EXCEEDS_DISPUTE":
      return `The draft offers ${f.offered.value} ${f.offered.currency_code}, more than the disputed ${f.disputed.value} ${f.disputed.currency_code}.`;
    case "RESPONSE_OVERDUE":
      return `The respond-by date (${formatDate(f.dueDate)}) has passed.`;
    default:
      return assertNever(f);
  }
}

function assertNever(x: never): never {
  throw new Error(`Unhandled guard failure: ${JSON.stringify(x)}`);
}

export function citationCounts(rec: Recommendation | undefined, evidence: readonly Evidence[]): Map<string, number> {
  const counts = new Map(evidence.map((e) => [e.id, 0]));
  if (!rec) return counts;
  for (const claim of [...rec.supports, ...rec.contradicts]) {
    for (const id of new Set(claim.evidenceIds)) {
      if (counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export function stepIndex(status: CaseStatus): number {
  return (STATUS_ORDER as readonly CaseStatus[]).indexOf(status);
}

// Legacy recommendation fields are intentionally ignored: only the current
// discriminated assessment may authorize an action in the review UI.
export function recommendationFor(c: Case | undefined): Recommendation | undefined {
  return c?.assessment?.kind === "actionable" ? c.assessment.recommendation : undefined;
}

export function responseLockReason(c: Case): string | null {
  if (c.pendingAction) return "A request was started and its outcome is not established. Check PayPal and reconcile it manually before any further response. Do not retry.";
  if (c.execution) return "PayPal already acknowledged a response. This app will not send another response for this case.";
  if (c.postExecutionReview) return "Additional provider work needs manual review in PayPal.";
  return null;
}

export function approvalBlockReason(c: Case): string | null {
  const locked = responseLockReason(c);
  if (locked) return locked;
  if (c.assessment?.kind === "hold") return `On hold: ${c.assessment.summary} ${c.assessment.reviewerNextStep}`;
  if (!recommendationFor(c)) return "There is no actionable assessment to approve. Review the evidence and run assessment.";
  if (c.status !== "recommended") return `Approval opens when the case is recommended. This case is ${STATUS_LABEL[c.status].toLowerCase()}.`;
  if (minorUnits(c.amount) === undefined) return "Case amount is unavailable or invalid. Reassess before approving.";
  if (!c.recommendationRevision) return "Reassess this case and review the new recommendation before approving.";
  if (c.guardFailures.length > 0) return "Guard issues must be fixed before approval. Review the issues and reassess.";
  return null;
}

export function executionBlockReason(c: Case): string | null {
  const locked = responseLockReason(c);
  if (locked) return locked;
  if (c.assessment?.kind === "hold") return "This case is on hold. No response can be sent.";
  if (!recommendationFor(c)) return "There is no actionable assessment to send.";
  if (c.status !== "approved") return "Seller approval is required before sending.";
  if (minorUnits(c.amount) === undefined) return "Case amount is unavailable or invalid. Reassess before executing.";
  if (!c.recommendationRevision || c.approvedSnapshot?.revision !== c.recommendationRevision) return "The current assessment has no matching approval. Refresh and review the case.";
  if (c.guardFailures.length > 0) return "Guard issues block execution.";
  return null;
}

export function canReassess(c: Case): boolean {
  return responseLockReason(c) === null && ["received", "evidence_gathered", "recommended", "failed"].includes(c.status);
}

export function caseReviewLabel(c: Case): string {
  if (c.pendingAction) return "Outcome unknown";
  if (c.status === "resolved") return "Resolved";
  if (c.postExecutionReview) return "Manual review";
  if (c.execution) return "Request accepted";
  if (c.assessment?.kind === "hold") return "On hold";
  return STATUS_LABEL[c.status];
}

export function reachedCaseSteps(c: Case): ReadonlySet<CaseStatus> {
  const reached = new Set<CaseStatus>(["received"]);
  if (c.evidence.length > 0 || c.assessment) reached.add("evidence_gathered");
  if (recommendationFor(c)) reached.add("recommended");
  if (c.approvedSnapshot && c.approvedBy) reached.add("approved");
  if (c.execution) reached.add("executed");
  if (c.status === "resolved") reached.add("resolved");
  return reached;
}
