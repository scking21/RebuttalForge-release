import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Case } from "../../src/domain";
import { PostExecutionReview } from "../src/components/PostExecutionReview";

it("shows refreshed requirements and deadline without an approval or action control", () => {
  const c = {
    sellerResponseDueDate: "2026-10-20T00:00:00Z",
    postExecutionReview: {
      reason: "Additional provider work needs manual review. No further action will be sent.",
      providerStatus: "WAITING_FOR_SELLER_RESPONSE",
      evidence: [{ source: "REQUESTED_FROM_SELLER", notes: "A newly requested document" }],
      messages: [], observedAt: "2026-10-11T00:00:00Z",
    },
  } as unknown as Case;
  const html = renderToStaticMarkup(createElement(PostExecutionReview, { c }));
  expect(html).toContain("manual review");
  expect(html).toContain("Respond by:");
  expect(html).toContain("A newly requested document");
  expect(html).toContain("previous reviewed response");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<form");
});
