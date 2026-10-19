import type { Draft, FulfillmentTracking } from "../domain.js";

// Carrier codes are case-normalized; tracking identifiers remain opaque and
// case-sensitive. Never extract either value from prose or combine records.
export function normalizedTracking(carrier: unknown, number: unknown): Draft["tracking"] {
  if (typeof carrier !== "string" || typeof number !== "string" || /[\u0000-\u001f\u007f]/.test(carrier + number)) return undefined;
  const carrierName = carrier.trim().toUpperCase();
  const trackingNumber = number.trim();
  return carrierName && trackingNumber ? { carrierName, trackingNumber } : undefined;
}

export function fulfillmentTracking(
  kind: FulfillmentTracking["kind"], captureId: string, carrier: unknown, number: unknown,
): FulfillmentTracking | undefined {
  const pair = normalizedTracking(carrier, number);
  if (!pair || !/^[A-Za-z0-9_-]+$/.test(captureId)) return undefined;
  return { kind, captureId, ...pair };
}
