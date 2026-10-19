// TEST DOUBLE. Explicitly enabled for local demonstration or injected into tests.
// It returns canned recommendations without calling an AI provider.
import type { Action, Assessment, Evidence, Recommendation } from "../domain.js";
import type { Model, ModelInput } from "./model.js";

export class ScriptedModel implements Model {
  readonly calls: ModelInput[] = [];

  constructor(private readonly script: (input: ModelInput) => Recommendation | Assessment | Promise<Recommendation | Assessment>) {}

  async recommend(input: ModelInput): Promise<Assessment> {
    this.calls.push(input);
    const output = await this.script(input);
    return "kind" in output ? output : { kind: "actionable", recommendation: output };
  }
}

const idsOf = (evidence: Evidence[], pick: (e: Evidence) => boolean) => evidence.filter(pick).map((e) => e.id);

// Cites the evidence by source, ignoring permittedActions on purpose so the guard can be seen rejecting it.
export function scriptedBranch(
  action: Action,
  tracking?: { carrierName: string; trackingNumber: string },
): ScriptedModel {
  return new ScriptedModel(({ evidence, dispute }) => {
    const sellerRecords = idsOf(evidence, (e) => e.source === "seller.record");
    const buyerClaims = idsOf(evidence, (e) => e.label.startsWith("Dispute message from BUYER"));
    const paypalTracking = idsOf(evidence, (e) => e.source === "paypal.tracking");
    const filed = idsOf(evidence, (e) => e.label === "Dispute as filed");

    if (action === "concede") {
      return {
        action,
        confidence: "high",
        summary: "The seller's own record shows the item never shipped, so the buyer's claim stands.",
        supports: [{ text: "The seller's record says the item was never shipped.", evidenceIds: sellerRecords }],
        contradicts: [
          { text: "The cited record describes the tracking lookup and its limits; it is not independent proof of delivery.", evidenceIds: paypalTracking },
          { text: "The buyer reports the item never arrived.", evidenceIds: [...filed, ...buyerClaims] },
        ],
        draft: { note: "The seller’s record states the item was not shipped. If approved, we propose accepting the claim. No response has been sent." },
      };
    }
    return {
      action,
      confidence: "high",
      summary: "The seller’s record states the parcel was delivered. Review this unverified assertion against the buyer’s report.",
      supports: [
        { text: "The seller’s record states the carrier reported delivery.", evidenceIds: sellerRecords },
        { text: "The cited record describes the tracking lookup and its limits; it is not independent proof of delivery.", evidenceIds: paypalTracking },
      ],
      contradicts: [{ text: "The buyer says the item never arrived.", evidenceIds: [...filed, ...buyerClaims] }],
      draft: {
        note: `The seller’s record reports delivery for dispute ${dispute.disputeId}. If approved, we propose submitting the cited tracking details for review. This seller assertion is not independent delivery verification. No scan attachment is included.`,
        evidenceType: "PROOF_OF_FULFILLMENT",
        ...(tracking ? { tracking } : {}),
      },
    };
  });
}

// Picks the branch from the evidence so a local stand-in session can run without an AI key.
// It is canned logic, not a model: the server only uses it when DISPUTE_DESK_TEST_DOUBLE=1 and reports that in /api/health.
export function evidenceDrivenDouble(): ScriptedModel {
  return new ScriptedModel((input) => {
    const records = input.evidence.filter((e) => e.source === "seller.record");
    if (records.some((e) => /never shipped|not shipped/i.test(e.fact))) return scriptedBranch("concede").recommend(input);
    const scan = records.find(e => e.fulfillment?.kind === "seller_delivery_record")?.fulfillment;
    return scriptedBranch("contest", scan ? { carrierName: scan.carrierName, trackingNumber: scan.trackingNumber } : undefined).recommend(input);
  });
}
