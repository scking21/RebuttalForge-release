import { createHash } from "node:crypto";
import type { GuardFailure, Recommendation, SellerRequestState } from "./domain.js";
import type { Dispute } from "./paypal/schemas.js";

export interface ResponsePolicy {
  status: string;
  requestedEvidence: Record<string, unknown>[];
  unclassifiedEvidence: Record<string, unknown>[];
  offerTypes: string[] | null;
  acceptClaimTypes: string[] | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function types(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(v => typeof v === "string" && v.length > 0)
    ? [...new Set(value as string[])].sort() : null;
}

export function responsePolicy(dispute: Dispute): ResponsePolicy {
  const options = record(dispute.allowed_response_options);
  return {
    status: dispute.status,
    requestedEvidence: dispute.evidences.filter(e => e.source === "REQUESTED_FROM_SELLER"),
    unclassifiedEvidence: dispute.evidences.filter(e => ![
      "REQUESTED_FROM_SELLER", "REQUESTED_FROM_BUYER", "SUBMITTED_BY_SELLER", "SUBMITTED_BY_BUYER", "SUBMITTED_BY_PARTNER",
    ].includes(String(e.source))),
    offerTypes: types(record(options?.make_offer)?.offer_types),
    acceptClaimTypes: types(record(options?.accept_claim)?.accept_claim_types),
  };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort().filter(k => object[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function providerContextHash(dispute: Dispute): string {
  return createHash("sha256").update(canonical({
    status: dispute.status,
    evidences: [...new Set(dispute.evidences.map(canonical))].sort(),
    messages: dispute.messages,
    allowed_response_options: normalizedOptions(dispute.allowed_response_options),
    links: dispute.links.map(l => ({ rel: l.rel, method: l.method })).sort((a, b) => canonical(a).localeCompare(canonical(b))),
  })).digest("hex");
}

function requestedForAction(request: Record<string, unknown>, rec: Recommendation): "applies" | "unrelated" | "unknown" {
  if (request.action_info === undefined) return rec.action === "contest" ? "applies" : "unrelated";
  const info = record(request.action_info);
  if (!info) return "unknown";
  if (info.mandatory === false) return "unrelated";
  if (![
    "ACKNOWLEDGE_RETURN_ITEM", "ACCEPT_CLAIM", "PROVIDE_EVIDENCE", "APPEAL", "CANCEL", "CHANGE_REASON", "ESCALATE",
  ].includes(String(info.action))) return "unknown";
  const action = { contest: "PROVIDE_EVIDENCE", concede: "ACCEPT_CLAIM", offer: "MAKE_OFFER" }[rec.action];
  if (info.action !== action) return "unrelated";
  if (info.response_option !== undefined && (typeof info.response_option !== "string" || !/^[A-Z_]{1,255}$/.test(info.response_option))) return "unknown";
  if (rec.action === "concede" && info.response_option !== undefined && info.response_option !== "REFUND") return "unrelated";
  return info.mandatory === true ? "applies" : "unknown";
}

export function checkResponsePolicy(rec: Recommendation, policy: ResponsePolicy): GuardFailure[] {
  const failures: GuardFailure[] = [];
  if (policy.unclassifiedEvidence.length) {
    failures.push({ code: "MANUAL_EVIDENCE_REVIEW", reason: "Some PayPal evidence has an absent or unsupported source; its response obligations need review." });
  }
  const applicable = policy.requestedEvidence.filter(request => requestedForAction(request, rec) !== "unrelated");
  if (rec.action === "offer" || rec.action === "concede") {
    if (applicable.length) failures.push({ code: "MANUAL_EVIDENCE_REVIEW", reason: "This response may require supporting evidence that this client cannot attach." });
    const subtype = rec.action === "offer" ? rec.draft.offer?.type ?? "" : "REFUND";
    const allowed = rec.action === "offer" ? policy.offerTypes : policy.acceptClaimTypes;
    if (!allowed?.includes(subtype)) failures.push({ code: "RESPONSE_SUBTYPE_NOT_PERMITTED", action: rec.action, subtype });
    return failures;
  }
  if (policy.status !== "WAITING_FOR_SELLER_RESPONSE") failures.push({ code: "SELLER_RESPONSE_NOT_REQUESTED" });
  const evidenceType = rec.draft.evidenceType ?? "PROOF_OF_FULFILLMENT";
  if (evidenceType !== "PROOF_OF_FULFILLMENT" || !rec.draft.tracking?.carrierName.trim() || !rec.draft.tracking.trackingNumber.trim()) {
    failures.push({ code: "MANUAL_EVIDENCE_REVIEW", reason: "Only tracking-backed PROOF_OF_FULFILLMENT is supported." });
  }
  if (rec.draft.tracking?.carrierName.trim().toUpperCase() === "OTHER") {
    failures.push({ code: "MANUAL_EVIDENCE_REVIEW", reason: "Carrier OTHER requires carrier_name_other, which this client cannot safely submit. Review the carrier directly in PayPal." });
  }
  for (const request of applicable) {
    const unsupported = Object.keys(request).some(key => !["source", "evidence_type", "date", "dispute_life_cycle_stage"].includes(key));
    if (request.evidence_type !== "PROOF_OF_FULFILLMENT" || unsupported) {
      failures.push({ code: "MANUAL_EVIDENCE_REVIEW", reason: "PayPal requested evidence or constraints this client cannot safely submit." });
      break;
    }
  }
  return failures;
}

function normalizedOptions(value: unknown): unknown {
  const options = record(value);
  if (!options) return value ?? null;
  return Object.fromEntries(Object.entries(options).map(([action, detail]) => {
    const fields = record(detail);
    if (!fields) return [action, detail];
    return [action, Object.fromEntries(Object.entries(fields).map(([key, values]) => [
      key, ["offer_types", "accept_claim_types", "acknowledgement_types"].includes(key) ? types(values) ?? values : values,
    ]))];
  }));
}

export function sellerRequestState(dispute: Dispute): SellerRequestState {
  return {
    status: dispute.status,
    requests: [...new Set(responsePolicy(dispute).requestedEvidence.map(canonical))].sort(),
  };
}
