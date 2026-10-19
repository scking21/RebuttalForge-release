import type { AuditEntry } from "../api-types";
import { formatDateTime } from "../format";

function detailText(detail: unknown): string | null {
  if (detail === undefined || detail === null || detail === "") return null;
  return typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
}

export function AuditTrail({ audit }: { audit: readonly AuditEntry[] }) {
  const ordered = [...audit].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <section className="audit" aria-labelledby="audit-heading">
      <h3 id="audit-heading">Audit trail</h3>
      {ordered.length === 0 ? (
        <p className="empty-line">Nothing has happened on this case yet.</p>
      ) : (
        <ol className="audit__list">
          {ordered.map((a, i) => {
            const text = detailText(a.detail);
            return (
              <li key={`${a.at}-${i}`}>
                <time dateTime={a.at}>{formatDateTime(a.at)}</time>
                <code className="audit__kind">{a.kind}</code>
                {text !== null && (
                  <details>
                    <summary>Detail</summary>
                    <pre>{text}</pre>
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
