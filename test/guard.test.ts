import { describe, expect, it } from "vitest";
import type { Evidence, Recommendation } from "../src/domain.js";
import { checkRecommendation } from "../src/agent/guard.js";

const evidence: Evidence[] = ["E1", "E2"].map((id) => ({
  id,
  source: "paypal.dispute",
  label: id,
  fact: id,
  ref: "r",
  observedAt: "2026-10-09T00:00:00Z",
}));

const good: Recommendation = {
  action: "concede",
  confidence: "high",
  summary: "s",
  supports: [{ text: "a", evidenceIds: ["E1"] }],
  contradicts: [{ text: "b", evidenceIds: ["E1", "E2"] }],
  draft: { note: "ok" },
};
const now = new Date("2026-10-09T12:00:00Z");
const check = (rec: Recommendation, rels = ["accept_claim"], due: string | undefined = "2026-10-20T00:00:00Z") =>
  checkRecommendation(rec, evidence, rels, { currency_code: "USD", value: "40.00" }, due, now);

describe("checkRecommendation", () => {
  it("passes a fully cited, permitted, on-time recommendation", () => {
    expect(check(good)).toEqual([]);
  });

  it("flags a claim with no evidence in supports or contradicts", () => {
    const rec = { ...good, supports: [{ text: "bare", evidenceIds: [] }], contradicts: [{ text: "also bare", evidenceIds: [] }] };
    expect(check(rec)).toEqual([
      { code: "UNCITED_CLAIM", claim: "bare" },
      { code: "UNCITED_CLAIM", claim: "also bare" },
    ]);
  });

  it("flags each unknown evidence id once", () => {
    const rec = {
      ...good,
      supports: [{ text: "a", evidenceIds: ["E9", "E1"] }],
      contradicts: [{ text: "b", evidenceIds: ["E9", "E7"] }],
    };
    expect(check(rec)).toEqual([
      { code: "UNKNOWN_EVIDENCE", evidenceId: "E9" },
      { code: "UNKNOWN_EVIDENCE", evidenceId: "E7" },
    ]);
  });

  it("flags an action whose rel PayPal does not currently offer", () => {
    expect(check({ ...good, action: "contest" })).toEqual([
      { code: "ACTION_NOT_PERMITTED", action: "contest", rel: "provide_evidence" },
    ]);
  });

  it("allows a 2000 character note and flags 2001", () => {
    expect(check({ ...good, draft: { note: "x".repeat(2000) } })).toEqual([]);
    expect(check({ ...good, draft: { note: "x".repeat(2001) } })).toEqual([{ code: "NOTE_TOO_LONG", length: 2001 }]);
  });

  it("flags a passed due date, and ignores a missing one", () => {
    expect(check(good, ["accept_claim"], "2026-10-09T11:59:59Z")).toEqual([
      { code: "RESPONSE_OVERDUE", dueDate: "2026-10-09T11:59:59Z" },
    ]);
    expect(check(good, ["accept_claim"], undefined)).toEqual([]);
  });

  it("reports every failure together", () => {
    const rec: Recommendation = {
      ...good,
      action: "offer",
      supports: [{ text: "bare", evidenceIds: [] }],
      draft: { note: "x".repeat(2001) },
    };
    const codes = check(rec, [], "2020-01-01T00:00:00Z").map((f) => f.code);
    expect(codes).toEqual(["UNCITED_CLAIM", "ACTION_NOT_PERMITTED", "NOTE_TOO_LONG", "RESPONSE_OVERDUE"]);
  });

  it("rejects a tracking number no evidence item states", () => {
    const rec: Recommendation = {
      ...good,
      action: "contest",
      draft: { note: "ok", tracking: { carrierName: "UPS", trackingNumber: "1Z999" } },
    };
    expect(check(rec, ["provide_evidence"])).toEqual([{ code: "TRACKING_NOT_IN_EVIDENCE", trackingNumber: "1Z999" }]);
  });

  it("accepts the exact carrier and tracking pair on one cited fulfillment record for the capture", () => {
    const withScan: Evidence[] = [...evidence, {
      ...evidence[0]!, id: "E3", source: "seller.record", provenance: "directSellerAssertion", fact: "UPS 1Z999 delivered",
      ref: "seller-records/CAP-1.json#0", fulfillment: { kind: "seller_delivery_record", captureId: "CAP-1", carrierName: "UPS", trackingNumber: "1Z999" },
    }];
    const rec: Recommendation = {
      ...good,
      action: "contest",
      supports: [{ text: "The seller's record supplies this tracking pair.", evidenceIds: ["E3"] }],
      draft: { note: "ok", tracking: { carrierName: "UPS", trackingNumber: "1Z999" } },
    };
    expect(
      checkRecommendation(rec, withScan, ["provide_evidence"], { currency_code: "USD", value: "40.00" }, undefined, now, undefined, "CAP-1"),
    ).toEqual([]);
  });

  it("rejects an offer above the disputed amount or in another currency", () => {
    const offer = (currency_code: string, value: string): Recommendation => ({
      ...good,
      action: "offer",
      draft: { note: "ok", offer: { type: "REFUND", amount: { currency_code, value } } },
    });
    expect(check(offer("USD", "40.01"), ["make_offer"]).map((f) => f.code)).toEqual(["OFFER_EXCEEDS_DISPUTE"]);
    expect(check(offer("EUR", "10.00"), ["make_offer"]).map((f) => f.code)).toEqual(["OFFER_EXCEEDS_DISPUTE"]);
    expect(check(offer("USD", "40.00"), ["make_offer"])).toEqual([]);
  });
});

describe('currency-aware amount boundaries', () => {
  const run = (value: string, currency_code = 'USD', disputedValue = '40.00', disputedCurrency = currency_code) =>
    checkRecommendation({ ...good, action: 'offer', draft: { note: 'ok', offer: { type: 'REFUND', amount: { currency_code, value } } } }, evidence, ['make_offer'], { currency_code: disputedCurrency, value: disputedValue }, undefined, now);
  it.each(['-1.00', 'NaN', 'Infinity', 'abc', '', ' 1.00', '1e1', '+1', '1.001', '.50', '1.'])('rejects malformed or unsupported USD precision: %s', value => {
    expect(run(value).length).toBeGreaterThan(0);
  });
  it('fails closed on unknown currencies, mismatches and invalid dispute amounts', () => {
    expect(run('1', 'XXX', '40').length).toBeGreaterThan(0);
    expect(run('1', 'USD', '40', 'EUR').length).toBeGreaterThan(0);
    expect(run('1', 'USD', 'NaN').length).toBeGreaterThan(0);
  });
  it.each(['JPY', 'HUF', 'TWD'])('accepts whole %s amounts but refuses fractions', currency => {
    expect(run('40', currency, '40')).toEqual([]);
    expect(run('1.00', currency, '40').length).toBeGreaterThan(0);
  });
  it('compares exact minor units without float rounding', () => {
    expect(run('90071992547409.92', 'USD', '90071992547409.91').length).toBeGreaterThan(0);
    expect(run('0.00')).toEqual([]);
    expect(run('39.99')).toEqual([]);
  });
});
