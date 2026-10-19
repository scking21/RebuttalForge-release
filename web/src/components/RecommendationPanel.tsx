import type { Case, Claim, Draft } from "../../../src/domain";
import { api } from "../api";
import { useAction } from "../hooks";
import { ACTION_LABEL, CONFIDENCE_LEVEL, formatMoney, recommendationFor, canReassess, responseLockReason } from "../format";
import { ConfidenceMeter, Empty, ErrorNote, Icon } from "./ui";

interface CitationHandlers {
  knownIds: ReadonlySet<string>;
  onHover: (id: string | null) => void;
  onJump: (id: string) => void;
}

function Citation({ id, handlers }: { id: string; handlers: CitationHandlers }) {
  if (!handlers.knownIds.has(id)) {
    return (
      <span className="tag tag--missing" title={`${id} is not in the evidence list`}>
        {id}
        <span className="sr-only"> (not in the evidence list)</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="tag tag--link"
      aria-label={`Evidence ${id}`}
      onMouseEnter={() => handlers.onHover(id)}
      onMouseLeave={() => handlers.onHover(null)}
      onFocus={() => handlers.onHover(id)}
      onBlur={() => handlers.onHover(null)}
      onClick={() => handlers.onJump(id)}
    >
      {id}
    </button>
  );
}

function ClaimList({ title, claims, kind, handlers }: { title: string; claims: readonly Claim[]; kind: "supports" | "contradicts"; handlers: CitationHandlers }) {
  return (
    <div className={`claims claims--${kind}`}>
      <h4>
        <Icon name={kind === "supports" ? "check" : "cross"} />
        {title} ({claims.length})
      </h4>
      {claims.length === 0 ? (
        <p className="empty-line">No claims.</p>
      ) : (
        <ul>
          {claims.map((c, i) => (
            <li key={i}>
              <p>{c.text}</p>
              <p className="cites">
                <span className="sr-only">Cites </span>
                {c.evidenceIds.length === 0 ? (
                  <span className="cites__none">
                    <Icon name="alert" />
                    No evidence cited
                  </span>
                ) : (
                  c.evidenceIds.map((id) => <Citation key={id} id={id} handlers={handlers} />)
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function draftDetails(d: Draft): [string, string][] {
  const rows: [string, string][] = [];
  if (d.evidenceType) rows.push(["Evidence type", d.evidenceType]);
  if (d.tracking) rows.push(["Carrier", d.tracking.carrierName], ["Tracking number", d.tracking.trackingNumber]);
  if (d.offer) rows.push(["Refund offered", formatMoney(d.offer.amount)]);
  return rows;
}


interface Props extends CitationHandlers {
  c: Case;
  onUpdated: (c: Case) => void;
}

export function RecommendationPanel({ c, onUpdated, ...handlers }: Props) {
  const reassess = useAction();
  const rec = recommendationFor(c);
  const hold = c.assessment?.kind === "hold" ? c.assessment : undefined;
  const reassessmentAllowed = canReassess(c);

  return (
    <section className="recommendation" aria-labelledby="rec-heading">
      <div className="sec-head">
        <h3 id="rec-heading">Recommendation</h3>
        <button
          type="button"
          className="btn btn--small"
          disabled={!reassessmentAllowed || reassess.pending !== null}
          onClick={async () => {
            if (!reassessmentAllowed) return;
            const updated = await reassess.run("reassess", () => api.reassess(c.disputeId));
            if (updated) onUpdated(updated);
          }}
        >
          {reassess.pending ? "Reassessing" : rec ? "Reassess" : "Run assessment"}
        </button>
      </div>
      {!reassessmentAllowed && <p className="hint">{responseLockReason(c) ?? "Locked after approval so the approved text cannot change."}</p>}
      {reassess.error !== undefined && <ErrorNote title="Reassess failed" message={reassess.error} />}

      {hold ? (
        <div className="note note--plain" role="status">
          <Icon name="alert" />
          <div>
            <h4>On hold: {hold.reason.toLowerCase().replaceAll("_", " ")}</h4>
            <p>{hold.summary}</p>
            <p><strong>Next step:</strong> {hold.reviewerNextStep}</p>
            <p>No response is available to approve or send.</p>
            {hold.evidenceIds.length > 0 && <p className="cites">Related evidence: {hold.evidenceIds.map(id => <Citation key={id} id={id} handlers={handlers} />)}</p>}
          </div>
        </div>
      ) : !rec ? (
        <Empty title="No recommendation yet">The agent has not proposed contest, offer or concede for this dispute.</Empty>
      ) : (
        <>
          <div className="rec-head">
            <p className="rec-action">
              <span className="sr-only">Recommended action: </span>
              {ACTION_LABEL[rec.action]}
            </p>
            <ConfidenceMeter level={CONFIDENCE_LEVEL[rec.confidence]} label={`${rec.confidence} confidence`} />
          </div>
          <p className="hint">Review every claim against its cited evidence. The model can be wrong; citations and confidence do not establish factual accuracy.</p>
          <p className="rec-summary">{rec.summary}</p>
          <div className="claims-grid">
            <ClaimList title="Supports" kind="supports" claims={rec.supports} handlers={handlers} />
            <ClaimList title="Contradicts" kind="contradicts" claims={rec.contradicts} handlers={handlers} />
          </div>
          <figure className="draft">
            <figcaption>
              Draft note for PayPal, verbatim <span className="draft__count">{rec.draft.note.length} characters</span>
            </figcaption>
            <pre className="draft__note">{rec.draft.note}</pre>
            {draftDetails(rec.draft).length > 0 && (
              <dl className="draft__facts">
                {draftDetails(rec.draft).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </figure>
        </>
      )}
    </section>
  );
}
