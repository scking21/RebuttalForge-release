import { recommendationFor } from "../format";
import type { Case } from "../../../src/domain";
import { describeGuardFailure } from "../format";
import { Icon } from "./ui";

export function GuardPanel({ c }: { c: Case }) {
  const n = c.guardFailures.length;
  return (
    <section className="guard" aria-labelledby="guard-heading">
      <h3 id="guard-heading">Guard</h3>
      {c.assessment?.kind === "hold" ? (
        <div className="note note--plain">
          <Icon name="alert" />
          <div><p>This assessment is on hold. Approval and execution are blocked.</p>
          {n > 0 && <ul>{c.guardFailures.map((failure, i) => <li key={i}>{describeGuardFailure(failure)}</li>)}</ul>}</div>
        </div>
      ) : !recommendationFor(c) ? (
        <p className="note note--plain">
          <Icon name="ring" />
          The guard checks a recommendation. There is none yet.
        </p>
      ) : n === 0 ? (
        <p className="note note--ok">
          <Icon name="check" />
          Cited evidence IDs exist and the action appeared in the last PayPal response. This does not prove the claims are true. Review every claim against its cited evidence and read the draft before approving.
        </p>
      ) : (
        <div className="note note--bad">
          <Icon name="alert" />
          <div>
            <strong>
              {n} {n === 1 ? "issue blocks" : "issues block"} approval
            </strong>
            <ul>
              {c.guardFailures.map((f, i) => (
                <li key={i}>
                  {describeGuardFailure(f)} <code className="code">{f.code}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
