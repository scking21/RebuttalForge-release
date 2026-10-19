import { recommendationFor, approvalBlockReason, executionBlockReason, canReassess } from "./format";
import { ACTION_REL } from "../../src/domain";
import type { Case, Evidence, GuardFailure } from "../../src/domain";
import { ApiError } from "./api-types";
import type { AuditEntry, Backend, CaseDetail, Health } from "./api-types";

const DAY = 86_400_000;
const at = (offsetDays: number): string => new Date(Date.now() + offsetDays * DAY).toISOString();

const ev = (
  id: string,
  source: Evidence["source"],
  label: string,
  fact: string,
  ref: string,
  observedDaysAgo = 0,
): Evidence => ({ id, source, label, fact, ref, observedAt: at(-observedDaysAgo) });

const ALL_RELS = Object.values(ACTION_REL);

const contestCase: Case = {
  disputeId: "PP-D-10482",
  status: "recommended",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  amount: { currency_code: "USD", value: "84.50" },
  sellerResponseDueDate: at(5),
  permittedRels: ALL_RELS,
  evidence: [
    ev("E1", "paypal.dispute", "Dispute reason", "Buyer says the skillet never arrived. Dispute opened 6 days ago.", "GET /v1/customer/disputes/PP-D-10482", 0),
    ev("E2", "paypal.order", "Order and ship-to address", "1 x Cast-iron skillet, 10 inch. Ship to 14 Alder Way, Portland OR 97205.", "GET /v2/checkout/orders/5O190127TN364715T", 0),
    ev("E3", "paypal.tracking", "Tracking added to the transaction", "USPS 9400111899223841000122, status DELIVERED, entered by the seller on Sep 30.", "GET /v1/shipping/trackers/5O190127TN364715T-9400111899223841000122", 0),
    ev("E4", "seller.record", "Carrier delivery scan", "USPS scan: delivered to front door, signed R. Okafor, Sep 30 at 2:12 PM.", "seller/shipping-log.csv#row-118", 8),
    ev("E5", "seller.record", "Buyer message", "On Oct 2 the buyer wrote that the box was left with a neighbour.", "seller/messages/2026-10-02.txt", 7),
  ],
  assessment: { kind: "actionable", recommendation: {
    action: "contest",
    confidence: "medium",
    summary: "Scripted interface example, not a current model decision. The seller log reports a signed delivery but gives no delivery address. The buyer reports the box was left with a neighbour; these records do not establish delivery to the buyer.",
    supports: [
      { text: "The USPS scan shows delivery with a signature on Sep 30.", evidenceIds: ["E4", "E3"] },
      { text: "The order records a ship-to address; the seller scan record does not provide a delivery address to compare.", evidenceIds: ["E2", "E4"] },
    ],
    contradicts: [
      { text: "The buyer says the box was left with a neighbour; the record does not identify the signer.", evidenceIds: ["E5"] },
    ],
    draft: {
      note:
        "If approved, we propose submitting the USPS tracking number (9400111899223841000122) and these notes: the seller log reports delivery on Sep 30 at 2:12 PM with a signature, but provides no delivery address. The buyer reports the box was left with a neighbour. No scan attachment is included.",
      evidenceType: "PROOF_OF_FULFILLMENT",
      tracking: { carrierName: "USPS", trackingNumber: "9400111899223841000122" },
    },
  } },
  guardFailures: [],
  updatedAt: at(0),
};

const concedeCase: Case = {
  disputeId: "PP-D-10517",
  status: "recommended",
  reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  amount: { currency_code: "USD", value: "19.99" },
  sellerResponseDueDate: at(1.2),
  permittedRels: ALL_RELS,
  evidence: [
    ev("E1", "paypal.dispute", "Dispute reason", "Buyer says the tote bag is black. The listing said navy.", "GET /v1/customer/disputes/PP-D-10517", 0),
    ev("E2", "paypal.order", "Order line", "1 x Canvas tote, colour: navy. Paid Sep 24.", "GET /v2/checkout/orders/8GH55120LM703310V", 0),
    ev("E3", "seller.record", "Stock note", "Navy was out of stock on Sep 22. A black tote was packed for this order with no message to the buyer.", "seller/stock-notes.md#2026-09-22", 15),
  ],
  assessment: { kind: "actionable", recommendation: {
    action: "concede",
    confidence: "high",
    summary: "The seller's own stock note shows the wrong colour was shipped. Contesting would have no evidence to cite.",
    supports: [
      { text: "The order was placed for navy.", evidenceIds: ["E2"] },
      { text: "The seller's stock note records a black tote packed in its place.", evidenceIds: ["E3"] },
    ],
    contradicts: [],
    draft: { note: "We shipped a black tote in place of the navy one ordered. We accept the claim and apologise for the mix-up." },
  } },
  guardFailures: [],
  updatedAt: at(0),
};

const guardedCase: Case = {
  disputeId: "PP-D-10533",
  status: "recommended",
  reason: "UNAUTHORISED",
  amount: { currency_code: "USD", value: "312.00" },
  sellerResponseDueDate: at(-1.4),
  permittedRels: ["send_message"],
  evidence: [
    ev("E1", "paypal.dispute", "Dispute reason", "Buyer says they did not make this purchase.", "GET /v1/customer/disputes/PP-D-10533", 0),
    ev("E2", "paypal.order", "Order and ship-to address", "2 x Studio headphones. Ship to a freight forwarder address in Newark NJ.", "GET /v2/checkout/orders/3MN04418AB291077K", 0),
    ev("E3", "paypal.tracking", "Tracking added to the transaction", "FedEx 794644790138, status SHIPPED, entered by the seller on Oct 1.", "GET /v1/shipping/trackers/3MN04418AB291077K-794644790138", 0),
  ],
  assessment: { kind: "actionable", recommendation: {
    action: "contest",
    confidence: "low",
    summary: "The order shipped, but nothing here shows the account holder placed it.",
    supports: [
      { text: "The package was shipped and tracked.", evidenceIds: ["E3"] },
      { text: "The buyer has bought from this shop before.", evidenceIds: [] },
      { text: "The device used at checkout matches the buyer's previous orders.", evidenceIds: ["E9"] },
    ],
    contradicts: [{ text: "The ship-to address is a freight forwarder, not the account's home address.", evidenceIds: ["E2"] }],
    draft: { note: "The order shipped via FedEx on Oct 1 and the buyer is a returning customer.", evidenceType: "PROOF_OF_FULFILLMENT" },
  } },
  guardFailures: [
    { code: "UNCITED_CLAIM", claim: "The buyer has bought from this shop before." },
    { code: "UNKNOWN_EVIDENCE", evidenceId: "E9" },
    { code: "ACTION_NOT_PERMITTED", action: "contest", rel: ACTION_REL.contest },
    { code: "RESPONSE_OVERDUE", dueDate: at(-1.4) },
  ] satisfies GuardFailure[],
  updatedAt: at(0),
};

const gatheredCase: Case = {
  disputeId: "PP-D-10561",
  status: "evidence_gathered",
  reason: "CREDIT_NOT_PROCESSED",
  amount: { currency_code: "USD", value: "42.00" },
  sellerResponseDueDate: at(9),
  permittedRels: ALL_RELS,
  evidence: [
    ev("E1", "paypal.dispute", "Dispute reason", "Buyer says a refund promised on Sep 28 never arrived.", "GET /v1/customer/disputes/PP-D-10561", 0),
    ev("E2", "seller.record", "Refund log", "No refund is recorded for order 8841 in the seller's refund log.", "seller/refunds.csv", 1),
  ],
  guardFailures: [],
  updatedAt: at(0),
};

const heldCase: Case = {
  ...gatheredCase, disputeId: "PP-D-HOLD", status: "evidence_gathered",
  evidence: gatheredCase.evidence.map((e) => e.id === "E1" ? { ...e, ref: "GET /v1/customer/disputes/PP-D-HOLD" } : e),
  assessment: { kind: "hold", reason: "UNSUPPORTED_RESPONSE", summary: "This app only assesses item-not-received disputes.", evidenceIds: [], reviewerNextStep: "Review this dispute and its response requirements directly in PayPal before the displayed deadline." },
};
const unknownCase: Case = {
  ...contestCase, disputeId: "PP-D-UNKNOWN", status: "failed",
  pendingAction: { requestId: "fixture-unknown-request", revision: "fixture-revision", at: at(0) },
  error: "The provider response was interrupted. Its outcome is unknown.",
};
const acceptedCase: Case = {
  ...contestCase, disputeId: "PP-D-ACCEPTED", status: "executed",
  execution: { action: "contest", requestId: "fixture-accepted-request", httpStatus: 200, response: { status: "UNDER_REVIEW" }, at: at(0) },
};

const health: Health = {
  paypalBaseUrl: "https://api-m.sandbox.paypal.com",
  simulator: true,
  aiConfigured: !new URLSearchParams(window.location.search).has("noai"),
};

const store = new Map<string, CaseDetail>(
  [contestCase, concedeCase, guardedCase, gatheredCase, heldCase, unknownCase, acceptedCase].map((c) => [
    c.disputeId,
    {
      case: c,
      audit: [
        { at: at(-0.2), kind: "case.received", detail: { disputeId: c.disputeId } },
        { at: at(-0.19), kind: "evidence.gathered", detail: { count: c.evidence.length } },
        ...(recommendationFor(c)
          ? [{ at: at(-0.18), kind: "recommendation.created", detail: { action: recommendationFor(c)!.action, guardFailures: c.guardFailures.length } }]
          : []),
      ] satisfies AuditEntry[],
    },
  ]),
);

const delay = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), 120));

function mustGet(id: string): CaseDetail {
  const found = store.get(id);
  if (!found) throw new ApiError(`No dispute ${id}`, 404);
  return found;
}

function update(id: string, kind: string, detail: unknown, patch: Partial<Case>): Case {
  const entry = mustGet(id);
  entry.case = { ...entry.case, ...patch, updatedAt: new Date().toISOString() };
  entry.audit.push({ at: new Date().toISOString(), kind, detail });
  return entry.case;
}

for (const entry of store.values()) {
  if (recommendationFor(entry.case)) entry.case.recommendationRevision = crypto.randomUUID();
}

export const fixtureBackend: Backend = {
  health: () => delay(health),
  cases: () => delay([...store.values()].map((d) => d.case)),
  caseDetail: (id) => delay(mustGet(id)),
  reassess: (id) => {
    const c = mustGet(id).case;
    if (!canReassess(c)) return Promise.reject(new ApiError("This case cannot be reassessed", 409));
    return delay(update(id, "case.reassessed", {}, { recommendationRevision: recommendationFor(c) ? crypto.randomUUID() : undefined }));
  },
  approve: (id, approvedBy, recommendationRevision) => {
    const c = mustGet(id).case;
    const blocked = approvalBlockReason(c);
    if (blocked) return Promise.reject(new ApiError(blocked, 409));
    if (!c.recommendationRevision || recommendationRevision !== c.recommendationRevision) return Promise.reject(new ApiError("Refresh and review the current recommendation before approving", 409));
    if (c.guardFailures.length > 0) return Promise.reject(new ApiError("Guard failures block approval", 409));
    return delay(update(id, "case.approved", { approvedBy }, { status: "approved", approvedBy,
      approvedSnapshot: { revision: recommendationRevision, contentHash: "fixture-only", facts: { disputeId: c.disputeId, captureId: "fixture-only", currency: c.amount.currency_code, amountMinor: "0", reason: c.reason, stage: "fixture-only", deadline: null, providerContextHash: "fixture-only" } },
    }));
  },
  execute: (id) => {
    const c = mustGet(id).case;
    const blocked = executionBlockReason(c);
    if (blocked) return Promise.reject(new ApiError(blocked, 409));
    const execution = {
      action: recommendationFor(c)!.action,
      requestId: crypto.randomUUID(),
      httpStatus: 200,
      response: { id: c.disputeId, status: "UNDER_REVIEW" },
      at: new Date().toISOString(),
    };
    return delay(update(id, "paypal.executed", { action: execution.action, httpStatus: 200 }, { status: "executed", execution }));
  },
  requireEvidence: (id) =>
    delay({ simulated_resolution: true as const, case: update(id, "sandbox.require_evidence", {}, {}) }),
  adjudicate: (id, outcome) =>
    delay({
      simulated_resolution: true as const,
      case: update(id, "sandbox.adjudicate", { outcome }, { status: "resolved", outcome }),
    }),
};
