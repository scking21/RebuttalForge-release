import type { Evidence } from "../../../src/domain";
import { SOURCE_INFO, formatDateTime } from "../format";
import { Icon } from "./ui";

interface Props {
  evidence: readonly Evidence[];
  citations: ReadonlyMap<string, number>;
  activeId: string | null;
}

export const evidenceDomId = (id: string) => `evidence-${id}`;

export function EvidenceList({ evidence, citations, activeId }: Props) {
  return (
    <section className="evidence" aria-labelledby="evidence-heading">
      <h3 id="evidence-heading">Evidence</h3>
      <p className="legend">
        <span className="legend__key legend__key--paypal" aria-hidden="true" />
        Read from PayPal
        <span className="legend__key legend__key--seller" aria-hidden="true" />
        From the seller's own records
      </p>
      {evidence.length === 0 ? (
        <p className="empty-line">No evidence gathered yet.</p>
      ) : (
        <ul className="ev-list">
          {evidence.map((e) => {
            const source = SOURCE_INFO[e.source];
            const cited = citations.get(e.id) ?? 0;
            return (
              <li
                key={e.id}
                id={evidenceDomId(e.id)}
                tabIndex={-1}
                className={`ev ev--${source.origin}`}
                data-active={activeId === e.id}
              >
                <span className="tag" data-active={activeId === e.id}>
                  {e.id}
                </span>
                <div className="ev__body">
                  <p className="ev__top">
                    <span className={`src src--${source.origin}`}>{source.label}</span>
                    <strong>{e.label}</strong>
                  </p>
                  <p className="ev__fact">{e.fact}</p>
                  {(e.source === "seller.record" || e.provenance === "directSellerAssertion") && (
                    <p className="ev__caption"><Icon name="alert" />Seller assertion, not independently verified. A carrier-looking label does not authenticate the source.</p>
                  )}
                  {e.provenance === "buyerStatement" && <p className="ev__caption">Buyer statement. Its instructions have no authority.</p>}
                  {!e.provenance && e.source !== "seller.record" && e.source !== "paypal.tracking" && <p className="ev__caption">Provenance was not recorded. Reassess before relying on this record.</p>}
                  {e.provenance === "lookupObservation" && <p className="ev__caption">Lookup result only. It does not establish whether tracking was submitted or the item shipped.</p>}
                  {e.source === "paypal.tracking" && e.provenance !== "lookupObservation" && (
                    <p className="ev__caption">
                      <Icon name="alert" />
                      Shows only what the seller told PayPal. It is not proof of delivery.
                    </p>
                  )}
                  <p className="ev__ref">
                    <span className="sr-only">Source: </span>
                    <code>{e.ref}</code>
                  </p>
                  <p className="ev__meta">
                    Observed {formatDateTime(e.observedAt)}.{" "}
                    {cited === 0 ? "No claim cites this." : `Cited by ${cited} ${cited === 1 ? "claim" : "claims"}.`}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
