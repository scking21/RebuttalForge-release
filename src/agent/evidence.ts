import { canonical, responsePolicy } from "../response-policy.js";
import type { Evidence, Money } from "../domain.js";
import { PayPalClient, PayPalError } from "../paypal/client.js";
import type { Dispute, Order } from "../paypal/schemas.js";
import type { SellerRecordsLoader } from "./seller-records.js";
import { fulfillmentTracking } from "./tracking.js";

export class UnsupportedTransaction extends Error {}

export interface Gathered {
  dispute: Dispute;
  evidence: Evidence[];
}

type Draft = Omit<Evidence, "id" | "observedAt">;

const money = (m: Money) => `${m.value} ${m.currency_code}`;

function describeAddress(unit: Order["purchase_units"][number]): string | undefined {
  const shipping = unit.shipping;
  const addr = shipping?.address as Record<string, string> | undefined;
  if (!addr) return undefined;
  const parts = [
    shipping?.name?.full_name,
    addr.address_line_1,
    addr.address_line_2,
    addr.admin_area_2,
    [addr.admin_area_1, addr.postal_code].filter(Boolean).join(" "),
    addr.country_code,
  ].filter(Boolean);
  return parts.join(", ");
}

// Ids are positional (E1..En) in a fixed source order, so the same inputs always
// yield the same ids; a recommendation is re-made whenever evidence is re-gathered.
export async function gatherEvidence(
  client: PayPalClient,
  disputeId: string,
  sellerRecords: SellerRecordsLoader,
  now: Date = new Date(),
  fetchedDispute?: Dispute,
): Promise<Gathered> {
  const dispute = fetchedDispute ?? await client.getDispute(disputeId);
  if (dispute.dispute_id !== disputeId) throw new UnsupportedTransaction("Dispute identity mismatch");
  const disputePath = `GET /v1/customer/disputes/${dispute.dispute_id}`;
  const drafts: Draft[] = [
    {
      source: "paypal.dispute",
      label: "Dispute as filed",
      fact: `Reason ${dispute.reason}; stage ${dispute.dispute_life_cycle_stage}; status ${dispute.status}; disputed amount ${money(dispute.dispute_amount)}.`,
      ref: disputePath,
    },
  ];
  if (dispute.seller_response_due_date) {
    drafts.push({
      source: "paypal.dispute",
      label: "Seller response deadline",
      fact: `The seller must respond by ${dispute.seller_response_due_date}.`,
      ref: disputePath,
    });
  }

  const policy = responsePolicy(dispute);
  for (const request of [...policy.requestedEvidence, ...policy.unclassifiedEvidence]) {
    drafts.push({
      source: "paypal.dispute",
      label: "PayPal evidence response requirements",
      fact: canonical(request),
      ref: disputePath,
    });
  }

  if (dispute.disputed_transactions.length !== 1) throw new UnsupportedTransaction("Expected one disputed capture identity");
  const captureId = dispute.disputed_transactions[0]?.seller_transaction_id;
  if (!captureId) throw new UnsupportedTransaction("Missing disputed capture identity");
  const records = captureId ? sellerRecords(captureId) : [];
  if (captureId) {
    const capture = await client.getCapture(captureId);
    if (capture.id !== captureId) throw new UnsupportedTransaction("Capture identity mismatch");
    const capturePath = `GET /v2/payments/captures/${captureId}`;
    drafts.push({
      source: "paypal.order",
      label: "Payment capture",
      fact: `Capture ${capture.id} has status ${capture.status} for ${money(capture.amount)}.`,
      ref: capturePath,
    });

    const orderId = capture.supplementary_data?.related_ids?.order_id;
    if (!orderId) throw new UnsupportedTransaction("Missing order identity for disputed capture");
    const order = await client.getOrder(orderId);
    if (order.id !== orderId) throw new UnsupportedTransaction("Order identity mismatch");
    const matchingUnits = order.purchase_units.filter(unit => unit.payments?.captures?.some(c => c.id === captureId));
    if (matchingUnits.length !== 1) throw new UnsupportedTransaction("Expected exactly one purchase unit for disputed capture");
    const unit = matchingUnits[0]!;
    const orderPath = `GET /v2/checkout/orders/${orderId}`;
    const items = unit.items;
    if (items?.length) {
      drafts.push({
        source: "paypal.order",
        label: "Item purchased",
        fact: `Order lists: ${items.map((i) => `${i.name} x${i.quantity ?? "1"}`).join("; ")}.`,
        ref: orderPath,
      });
    }
    const address = describeAddress(unit);
    if (address) {
      drafts.push({
        source: "paypal.order",
        label: "Shipping address on the order",
        fact: `The order ships to: ${address}.`,
        ref: orderPath,
      });
    }

    const trackerId = unit.shipping?.trackers?.find(t => t.id.startsWith(`${captureId}-`))?.id;
    const trackingNumber = trackerId?.startsWith(`${captureId}-`)
      ? trackerId.slice(captureId.length + 1)
      : records.find((r) => r.trackingNumber)?.trackingNumber;
    drafts.push(await trackingEvidence(client, captureId, trackingNumber));
  }

  records.forEach((r, i) => {
    drafts.push({
      source: "seller.record",
      label: r.label,
      fact: `${r.fact} (recorded ${r.recordedAt})`,
      ref: `seller-records/${captureId}.json#${i}`,
      fulfillment: r.kind === "carrier_delivery_scan"
        ? fulfillmentTracking("seller_delivery_record", captureId, r.carrier, r.trackingNumber)
        : undefined,
    });
  });

  for (const m of dispute.messages) {
    drafts.push({
      source: "paypal.dispute",
      provenance: m.posted_by === "BUYER" ? "buyerStatement" : m.posted_by === "SELLER" ? "directSellerAssertion" : "providerMessage",
      label: `Dispute message from ${m.posted_by}`,
      fact: `${m.posted_by} wrote at ${m.time_posted}: "${m.content}"`,
      ref: disputePath,
    });
  }

  const observedAt = now.toISOString();
  return { dispute, evidence: drafts.map((d, i) => ({ ...d, provenance: d.provenance ?? (d.source === "seller.record" || d.source === "paypal.tracking" ? "directSellerAssertion" : "providerTransactionFact"), id: `E${i + 1}`, observedAt })) };
}

// PayPal's tracker record is what the seller told PayPal. It never proves delivery,
// so the label and fact both say so. Local seller records are also unverified assertions.
async function trackingEvidence(client: PayPalClient, captureId: string, trackingNumber?: string): Promise<Draft> {
  const label = "Tracking submitted to PayPal by the seller (not proof of delivery)";
  if (!trackingNumber) {
    return {
      source: "paypal.tracking",
      provenance: "lookupObservation",
      label: "Tracking not established by the supported lookup",
      fact: "The supported lookup did not establish a usable tracking number from the matched order or supplied seller records. Tracking may be absent, unrecognized or unsupported; this does not establish whether tracking was submitted or the item shipped.",
      ref: `GET /v2/checkout/orders (trackers) for capture ${captureId}`,
    };
  }
  const ref = `GET /v1/shipping/trackers/${captureId}-${trackingNumber}`;
  try {
    const t = await client.getTracking(captureId, trackingNumber);
    if (t.tracking_number !== trackingNumber || t.transaction_id !== captureId) {
      throw new UnsupportedTransaction("Tracking response identity does not match the requested capture and tracking number");
    }
    return {
      source: "paypal.tracking",
      label,
      fact: `The seller told PayPal that tracking number ${t.tracking_number} (${t.carrier ?? "carrier unknown"}) has status ${t.status}. This records the seller's own submission to PayPal; it does not show the parcel was delivered.`,
      ref,
      fulfillment: fulfillmentTracking("paypal_tracking_submission", captureId, t.carrier, t.tracking_number),
    };
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) {
      return { source: "paypal.tracking", provenance: "lookupObservation", label: "Numbered tracking lookup returned not found", fact: `The numbered lookup for capture ${captureId} and tracking number ${trackingNumber} returned HTTP 404. This does not establish whether other tracking was submitted or whether the item shipped.`, ref };
    }
    throw e;
  }
}
