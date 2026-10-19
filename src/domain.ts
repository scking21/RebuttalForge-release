export type EvidenceSource =
  | "paypal.dispute"
  | "paypal.order"
  | "paypal.tracking"
  | "seller.record";

export interface FulfillmentTracking {
  kind: "seller_delivery_record" | "paypal_tracking_submission";
  captureId: string;
  carrierName: string;
  trackingNumber: string;
}

export interface Evidence {
  id: string;
  source: EvidenceSource;
  provenance?: "directSellerAssertion" | "buyerStatement" | "providerTransactionFact" | "providerMessage" | "lookupObservation";
  label: string;
  fact: string;
  // API path or seller file the fact was read from, so a reviewer can re-fetch it.
  ref: string;
  observedAt: string;
  // Paired fields retained by the collector from this one source record. This
  // is a seller assertion, not authenticated carrier or delivery verification.
  fulfillment?: FulfillmentTracking;
}

export type Action = "contest" | "offer" | "concede";

// The one place HATEOAS rel spellings live. They are unverified against the live
// sandbox: if a rel is spelled differently there, fix it here and nowhere else.
export const PAYPAL_REL = {
  provideEvidence: "provide_evidence",
  makeOffer: "make_offer",
  acceptClaim: "accept_claim",
  sendMessage: "send_message",
  escalate: "escalate",
  requireEvidence: "require_evidence",
  adjudicate: "adjudicate",
} as const;

// PayPal only permits an action when the dispute's HATEOAS links carry its rel.
export const ACTION_REL: Record<Action, string> = {
  contest: PAYPAL_REL.provideEvidence,
  offer: PAYPAL_REL.makeOffer,
  concede: PAYPAL_REL.acceptClaim,
};

export interface Claim {
  text: string;
  evidenceIds: string[];
}

export interface Draft {
  note: string;
  evidenceType?: string;
  tracking?: { carrierName: string; trackingNumber: string };
  offer?: { type: "REFUND"; amount: Money };
}

export interface Money {
  currency_code: string;
  value: string;
}

export interface Recommendation {
  action: Action;
  confidence: "low" | "medium" | "high";
  summary: string;
  supports: Claim[];
  contradicts: Claim[];
  draft: Draft;
}

export type HoldReason = "MISSING_EVIDENCE" | "CONFLICTING_EVIDENCE" | "UNSUPPORTED_TRANSACTION" | "UNSUPPORTED_RESPONSE" | "STALE_APPROVAL" | "MODEL_UNAVAILABLE";

export interface HoldAssessment {
  kind: "hold";
  reason: HoldReason;
  summary: string;
  evidenceIds: string[];
  reviewerNextStep: string;
  recommendation?: never;
}

export type Assessment = HoldAssessment | { kind: "actionable"; recommendation: Recommendation };

export type GuardFailure =
  | { code: "RESPONSE_SUBTYPE_NOT_PERMITTED"; action: Action; subtype: string }
  | { code: "SELLER_RESPONSE_NOT_REQUESTED" }
  | { code: "MANUAL_EVIDENCE_REVIEW"; reason: string }
  | { code: "NO_SUPPORTING_CLAIM" }
  | { code: "UNCITED_CLAIM"; claim: string }
  | { code: "UNKNOWN_EVIDENCE"; evidenceId: string }
  | { code: "ACTION_NOT_PERMITTED"; action: Action; rel: string }
  | { code: "NOTE_TOO_LONG"; length: number }
  | { code: "TRACKING_NOT_IN_EVIDENCE"; trackingNumber: string }
  | { code: "INVALID_MONEY"; field: "offer" | "disputed" }
  | { code: "OFFER_EXCEEDS_DISPUTE"; offered: Money; disputed: Money }
  | { code: "RESPONSE_OVERDUE"; dueDate: string };

export type CaseStatus =
  | "received"
  | "evidence_gathered"
  | "recommended"
  | "approved"
  | "executed"
  | "resolved"
  | "failed";

// A dispute can be resolved by PayPal or the buyer at any time, so every
// pre-execution status may jump to "resolved" (CUSTOMER.DISPUTE.RESOLVED).
export const CASE_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  received: ["evidence_gathered", "resolved", "failed"],
  evidence_gathered: ["recommended", "resolved", "failed"],
  recommended: ["approved", "recommended", "evidence_gathered", "resolved", "failed"],
  approved: ["evidence_gathered", "executed", "resolved", "failed"],
  executed: ["resolved", "failed"],
  resolved: [],
  failed: ["received"],
};

export interface SellerRequestState {
  status: string;
  requests: string[];
}

export interface Execution {
  action: Action;
  // Correlates one approved action. Provider deduplication is not assumed.
  requestId: string;
  beforeSellerRequest?: SellerRequestState;
  afterSellerRequest?: SellerRequestState;
  httpStatus: number;
  response: unknown;
  at: string;
}

export interface DecisionFacts {
  disputeId: string;
  captureId: string;
  currency: string;
  amountMinor: string;
  reason: string;
  stage: string;
  deadline: number | null;
  providerContextHash: string;
}

export interface ApprovalSnapshot {
  revision: string;
  facts: DecisionFacts;
  contentHash: string;
}

export interface Case {
  disputeId: string;
  status: CaseStatus;
  reason: string;
  amount: Money;
  sellerResponseDueDate?: string;
  permittedRels: string[];
  evidence: Evidence[];
  assessment?: Assessment;
  recommendationRevision?: string;
  decisionFacts?: DecisionFacts;
  approvedSnapshot?: ApprovalSnapshot;
  guardFailures: GuardFailure[];
  approvedBy?: string;
  execution?: Execution;
  executionHistory?: Execution[];
  postExecutionReview?: {
    reason: string;
    providerStatus: string;
    evidence: Record<string, unknown>[];
    messages: Record<string, unknown>[];
    observedAt: string;
  };
  pendingAction?: { requestId: string; revision: string; at: string };
  outcome?: string;
  error?: string;
  updatedAt: string;
}

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}
