import { describe, expect, it } from "vitest";
import { describeGuardFailure } from "../src/format";

describe("response policy review explanations", () => {
  it("explains an unavailable response subtype", () => {
    expect(describeGuardFailure({ code: "RESPONSE_SUBTYPE_NOT_PERMITTED", action: "concede", subtype: "REFUND" })).toContain("REFUND");
  });
  it("explains a missing seller evidence request", () => {
    expect(describeGuardFailure({ code: "SELLER_RESPONSE_NOT_REQUESTED" })).toContain("not currently waiting");
  });
  it("shows the reason manual evidence review is needed", () => {
    expect(describeGuardFailure({ code: "MANUAL_EVIDENCE_REVIEW", reason: "Document required" })).toContain("Document required");
  });
});
