import { ACTION_REL, type Evidence, type GuardFailure, type Money, type Recommendation } from "../domain.js";

import { checkResponsePolicy, type ResponsePolicy } from "../response-policy.js";
import { minorUnits } from "../money.js";
import { normalizedTracking } from "./tracking.js";

export const MAX_NOTE_LENGTH = 2000;

export function checkTrackingEvidence(rec: Recommendation, evidence: Evidence[], captureId?: string): GuardFailure[] {
  const draft = rec.draft.tracking;
  if (!draft) return [];
  const pair = normalizedTracking(draft.carrierName, draft.trackingNumber);
  const supportedIds = new Set(rec.supports.flatMap(claim => claim.evidenceIds));
  const match = captureId && pair && draft.carrierName === pair.carrierName && draft.trackingNumber === pair.trackingNumber && evidence.some(item => {
    const fields = item.fulfillment;
    if (!fields || !supportedIds.has(item.id) || evidence.filter(other => other.id === item.id).length !== 1 ||
        item.provenance !== "directSellerAssertion" || typeof item.ref !== "string" || fields.captureId !== captureId ||
        fields.carrierName !== pair.carrierName || fields.trackingNumber !== pair.trackingNumber) return false;
    if (item.source === "paypal.tracking" && fields.kind === "paypal_tracking_submission") {
      return item.ref === `GET /v1/shipping/trackers/${captureId}-${pair.trackingNumber}`;
    }
    if (item.source === "seller.record" && fields.kind === "seller_delivery_record") {
      const prefix = `seller-records/${captureId}.json#`;
      return item.ref.startsWith(prefix) && /^(0|[1-9]\d*)$/.test(item.ref.slice(prefix.length));
    }
    return false;
  });
  return match ? [] : [{ code: "TRACKING_NOT_IN_EVIDENCE", trackingNumber: draft.trackingNumber }];
}

export function checkRecommendation(
  rec: Recommendation,
  evidence: Evidence[],
  permittedRels: string[],
  disputed: Money,
  dueDate: string | undefined,
  now: Date,
  policy?: ResponsePolicy,
  captureId?: string,
): GuardFailure[] {
  const failures: GuardFailure[] = policy ? checkResponsePolicy(rec, policy) : [];
  const known = new Set(evidence.map((e) => e.id));

  if (rec.supports.length === 0) failures.push({ code: "NO_SUPPORTING_CLAIM" });

  const reportedUnknown = new Set<string>();
  for (const claim of [...rec.supports, ...rec.contradicts]) {
    if (claim.evidenceIds.length === 0) failures.push({ code: "UNCITED_CLAIM", claim: claim.text });
    for (const id of claim.evidenceIds) {
      if (!known.has(id) && !reportedUnknown.has(id)) {
        reportedUnknown.add(id);
        failures.push({ code: "UNKNOWN_EVIDENCE", evidenceId: id });
      }
    }
  }

  const rel = ACTION_REL[rec.action];
  if (!permittedRels.includes(rel)) failures.push({ code: "ACTION_NOT_PERMITTED", action: rec.action, rel });

  if (rec.draft.note.length > MAX_NOTE_LENGTH) failures.push({ code: "NOTE_TOO_LONG", length: rec.draft.note.length });

  failures.push(...checkTrackingEvidence(rec, evidence, captureId));
  const { offer } = rec.draft;

  const disputedMinor = minorUnits(disputed);
  if (disputedMinor === undefined) failures.push({ code: "INVALID_MONEY", field: "disputed" });
  if (offer) {
    const offeredMinor = minorUnits(offer.amount);
    if (offeredMinor === undefined) failures.push({ code: "INVALID_MONEY", field: "offer" });
    else if (offer.amount.currency_code !== disputed.currency_code || (disputedMinor !== undefined && offeredMinor > disputedMinor)) {
      failures.push({ code: "OFFER_EXCEEDS_DISPUTE", offered: offer.amount, disputed });
    }
  }

  if (dueDate && new Date(dueDate).getTime() < now.getTime()) failures.push({ code: "RESPONSE_OVERDUE", dueDate });

  return failures;
}
