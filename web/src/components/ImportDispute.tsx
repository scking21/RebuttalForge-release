import { useState } from "react";
import type { Case } from "../../../src/domain";
import { api } from "../api";
import { useAction } from "../hooks";
import { ErrorNote } from "./ui";

/** Reconstructed from previously inspected corrected preview behavior. */
export function ImportDispute({ fixtures, onImported }: { fixtures: boolean; onImported: (c: Case) => void }) {
  const [disputeId, setDisputeId] = useState("");
  const action = useAction();
  const trimmedId = disputeId.trim();
  if (fixtures) return null;
  return (
    <section className="import-case" aria-labelledby="import-case-heading">
      <div className="import-case__copy">
        <h2 id="import-case-heading">Load a known dispute</h2>
        <p>Load a known PayPal dispute. Depending on its current state, the server refreshes provider data or runs the configured assessment. Changed facts can invalidate an earlier approval. This does not approve or send a response.</p>
      </div>
      <form className="import-case__form" onSubmit={async (event) => {
        event.preventDefault();
        if (!trimmedId || action.pending !== null) return;
        const imported = await action.run("import-case", () => api.reassess(trimmedId));
        if (imported) { setDisputeId(""); onImported(imported); }
      }}>
        <label className="field" htmlFor="import-dispute-id">
          <span>PayPal dispute ID</span>
          <input id="import-dispute-id" value={disputeId} onChange={(event) => setDisputeId(event.target.value)} disabled={action.pending !== null} autoComplete="off" spellCheck={false} />
        </label>
        <button className="btn btn--primary" type="submit" disabled={!trimmedId || action.pending !== null}>
          {action.pending ? "Importing or refreshing" : "Import or refresh"}
        </button>
      </form>
      {action.error !== undefined && <ErrorNote title="Import or refresh failed" message={action.error} />}
    </section>
  );
}
