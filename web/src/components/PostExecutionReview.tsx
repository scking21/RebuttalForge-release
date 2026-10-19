import type { Case } from "../../../src/domain";
import { formatDate } from "../format";

export function PostExecutionReview({ c }: { c: Case }) {
  const review = c.postExecutionReview;
  if (!review) return null;
  return (
    <section className="note note--plain" aria-label="Additional provider work needs manual review">
      <h3>Additional provider work needs manual review</h3>
      <p>{review.reason}</p>
      <p>Current PayPal status: {review.providerStatus}. Respond by: {formatDate(c.sellerResponseDueDate)}.</p>
      <p>The recommendation and action below are the previous reviewed response. Review the current requirements in PayPal before responding there.</p>
      <details>
        <summary>Current provider evidence and messages</summary>
        <pre>{JSON.stringify({ evidence: review.evidence, messages: review.messages }, null, 2)}</pre>
      </details>
    </section>
  );
}
