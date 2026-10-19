import type { Case } from "../../../src/domain";
import { api } from "../api";
import type { SandboxOutcome } from "../api-types";
import { useAction } from "../hooks";
import { Chip, ErrorNote } from "./ui";

export function SandboxTools({ c, onUpdated }: { c: Case; onUpdated: (c: Case) => void }) {
  const tool = useAction();
  const closed = c.status === "resolved";

  const call = async (name: string, fn: () => Promise<{ case: Case }>) => {
    const res = await tool.run(name, fn);
    if (res) onUpdated(res.case);
  };
  const settle = (outcome: SandboxOutcome) => call(outcome, () => api.adjudicate(c.disputeId, outcome));

  return (
    <section className="sandbox" aria-labelledby="sandbox-heading">
      <div className="sec-head">
        <h3 id="sandbox-heading">Sandbox tools</h3>
        <Chip tone="warn" icon="alert">
          Sandbox only
        </Chip>
      </div>
      <p className="hint">Stand-ins for the buyer and PayPal's reviewers. They do not exist on live PayPal.</p>

      <div className="sandbox__row">
        <button type="button" className="btn" disabled={closed || tool.pending !== null} onClick={() => call("evidence", () => api.requireEvidence(c.disputeId))}>
          {tool.pending === "evidence" ? "Requesting" : "Request seller evidence"}
        </button>
        <p className="hint">Makes the dispute ask the seller for evidence, as PayPal would.</p>
      </div>

      <div className="sandbox__row">
        <div className="btn-group" role="group" aria-label="Settle dispute">
          <button type="button" className="btn" disabled={closed || tool.pending !== null} onClick={() => settle("BUYER_FAVOR")}>
            {tool.pending === "BUYER_FAVOR" ? "Settling" : "Settle for buyer"}
          </button>
          <button type="button" className="btn" disabled={closed || tool.pending !== null} onClick={() => settle("SELLER_FAVOR")}>
            {tool.pending === "SELLER_FAVOR" ? "Settling" : "Settle for seller"}
          </button>
        </div>
        <p className="hint">This picks the winner by hand. It simulates PayPal's decision and says nothing about the evidence.</p>
      </div>
      {closed && <p className="hint">This dispute is already resolved.</p>}
      {tool.error !== undefined && <ErrorNote title="Sandbox call failed" message={tool.error} />}
    </section>
  );
}
