import { expect, it } from "vitest";
import { evidenceDrivenDouble, scriptedBranch } from "../src/agent/test-double.js";
import type { ModelInput } from "../src/agent/model.js";

const input: ModelInput = {
  dispute: { disputeId: "SYNTHETIC-COPY", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", stage: "INQUIRY", status: "OPEN", amount: { currency_code: "USD", value: "48.00" } },
  evidence: [{ id: "E4", source: "seller.record", provenance: "directSellerAssertion", label: "Seller record", fact: "UPS scan: delivered. Tracking 1Z123", ref: "synthetic-record", observedAt: "2026-10-18T00:00:00Z" }],
  permittedActions: ["contest", "concede"],
};

it("scripted contest remains a conditional draft without an invented attachment", async () => {
  const result = await scriptedBranch("contest", { carrierName: "UPS", trackingNumber: "1Z123" }).recommend(input);
  expect(result.kind).toBe("actionable");
  if (result.kind !== "actionable") throw new Error("Expected scripted assessment");
  expect(result.recommendation.draft.note).toContain("If approved, we propose submitting");
  expect(result.recommendation.draft.note).toContain("not independent delivery verification");
  expect(result.recommendation.draft.note).toContain("No scan attachment is included");
  expect(result.recommendation.draft.note).not.toMatch(/see the attached|we attached|we submitted/i);
});

it("scripted concession does not assert approval, execution or a completed refund", async () => {
  const result = await scriptedBranch("concede").recommend(input);
  expect(result.kind).toBe("actionable");
  if (result.kind !== "actionable") throw new Error("Expected scripted assessment");
  expect(result.recommendation.draft.note).toContain("If approved, we propose accepting");
  expect(result.recommendation.draft.note).toContain("No response has been sent");
  expect(result.recommendation.draft.note).not.toMatch(/we accept the claim|has been refunded/i);
});

it.each(["UPS scan: delivered. Tracking 1Z123", "Item was never shipped"])("server-selected scripted branch preserves conditional wording: %s", async (fact) => {
  const result = await evidenceDrivenDouble().recommend({ ...input, evidence: [{ ...input.evidence[0]!, fact }] });
  expect(result.kind).toBe("actionable");
  if (result.kind !== "actionable") throw new Error("Expected scripted assessment");
  expect(result.recommendation.draft.note).toContain("If approved, we propose");
  expect(result.recommendation.draft.note).not.toContain("see the attached tracking");
});
