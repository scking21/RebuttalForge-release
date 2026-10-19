import { sendAttemptKey } from "../interaction";
import { useEffect, useRef, useState } from "react";
import type { Case } from "../../../src/domain";
import { minorUnits } from "../../../src/money";
import { api } from "../api";
import { useAction } from "../hooks";
import { ACTION_LABEL, formatDateTime, recommendationFor, approvalBlockReason, executionBlockReason, responseLockReason } from "../format";
import { ErrorNote, Icon } from "./ui";
import type { IconName } from "./ui";

type StepState = "done" | "current" | "blocked" | "todo";

interface GateStep {
  title: string;
  state: StepState;
  text: string;
}

const STEP_ICON: Record<StepState, IconName> = { done: "check", current: "dot", blocked: "cross", todo: "ring" };
function gateSteps(c: Case): GateStep[] {
  const rec = recommendationFor(c);
  const blocked = responseLockReason(c) !== null || c.assessment?.kind === "hold";
  const guard: GateStep = blocked
    ? { title: "Guard check", state: "blocked", text: "No further action is available" }
    : !rec
      ? { title: "Guard check", state: "todo", text: "Waiting for an actionable assessment" }
      : c.guardFailures.length > 0
        ? { title: "Guard check", state: "blocked", text: "Guard issues must be reviewed" }
        : { title: "Guard check", state: "done", text: "Reference and action checks passed; factual review still required" };
  const approval: GateStep = c.approvedBy && c.approvedSnapshot
    ? { title: "Seller approval", state: "done", text: `Approved by ${c.approvedBy}` }
    : approvalBlockReason(c) === null
      ? { title: "Seller approval", state: "current", text: "Waiting for you" }
      : { title: "Seller approval", state: "todo", text: "Not open yet" };
  const send: GateStep = c.pendingAction
    ? { title: "PayPal request", state: "blocked", text: "Outcome not established; manual reconciliation required" }
    : c.execution
      ? { title: "PayPal request", state: "done", text: `HTTP ${c.execution.httpStatus} acknowledged; this is not the dispute outcome` }
      : executionBlockReason(c) === null
        ? { title: "PayPal request", state: "current", text: "Ready to send" }
        : { title: "PayPal request", state: "todo", text: "No acknowledged request" };
  return [guard, approval, send];
}

export function ApprovalGate({ c, onUpdated }: { c: Case; onUpdated: (c: Case) => void }) {
  const [name, setName] = useState("");
  const [approvalConfirmationKey, setApprovalConfirmationKey] = useState<string | null>(null);
  const approvalConfirmation = useRef<HTMLParagraphElement>(null);
  const focusedConfirmationKey = useRef<string | null>(null);
  const [attemptedKey, setAttemptedKey] = useState<string | null>(null);
  const currentAttemptKey = sendAttemptKey(c.disputeId, c.recommendationRevision);
  useEffect(() => {
    if (attemptedKey === currentAttemptKey || approvalConfirmationKey !== currentAttemptKey || c.status !== "approved" || c.pendingAction || c.execution) return;
    if (focusedConfirmationKey.current === approvalConfirmationKey) return;
    approvalConfirmation.current?.focus();
    focusedConfirmationKey.current = approvalConfirmationKey;
  }, [approvalConfirmationKey, attemptedKey, currentAttemptKey, c.status, c.pendingAction, c.execution]);
  const approve = useAction();
  const execute = useAction();
  const blocked = approvalBlockReason(c);
  const executionBlocked = attemptedKey === currentAttemptKey ? "A send was attempted. Refresh the case and verify its recorded outcome before any further action." : executionBlockReason(c);
  const rec = recommendationFor(c);
  const lockReason = responseLockReason(c);
  const trimmed = name.trim();
  const validAmount = minorUnits(c.amount) !== undefined;
  const refundLabel = validAmount ? `${c.amount.value} ${c.amount.currency_code}` : undefined;
  const approved = c.status === "approved" || c.status === "executed" || c.status === "resolved" || !!c.execution || !!c.pendingAction;

  return (
    <section className="gate" aria-labelledby="gate-heading">
      <h3 id="gate-heading">Approval gate</h3>
      {rec?.action === "concede" && (
        <p className="note note--plain">
          {refundLabel
            ? `Accepting claim ${c.disputeId} closes it in the buyer's favor and refunds ${refundLabel} to the buyer. Approval records your decision; Execute sends the refund-causing request to PayPal.`
            : "Case amount is unavailable or invalid. Reassess before approving or executing."}
        </p>
      )}
      <ol className="gate__steps">
        {gateSteps(c).map((s) => (
          <li key={s.title} data-state={s.state}>
            <Icon name={STEP_ICON[s.state]} />
            <span>
              <strong>{s.title}.</strong> {s.text}
            </span>
          </li>
        ))}
      </ol>

      {lockReason && <p className="note note--plain" role="status">{lockReason}</p>}
      {c.pendingAction && <p>Request id: <code>{c.pendingAction.requestId}</code>. Started {formatDateTime(c.pendingAction.at)}.</p>}

      {c.status === "failed" && <ErrorNote title="This case failed" message={c.error ?? "No error message was recorded."} />}

      {!approved && c.assessment?.kind === "actionable" && (
        <form
          className="gate__form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (blocked || !trimmed || !c.recommendationRevision) return;
            const updated = await approve.run("approve", () => api.approve(c.disputeId, trimmed, c.recommendationRevision!));
            if (updated) {
              if (updated.status === "approved") setApprovalConfirmationKey(sendAttemptKey(updated.disputeId, updated.recommendationRevision));
              onUpdated(updated);
            }
          }}
        >
          <label className="field">
            <span>Your name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              disabled={blocked !== null}
              aria-describedby="approve-reason"
              required
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={blocked !== null || !trimmed || approve.pending !== null}>
            {approve.pending ? "Approving" : "Approve as seller"}
          </button>
          <p id="approve-reason" className="hint">
            {blocked ??
              (trimmed
                ? "Approving records your name against this recommendation and its draft note. Nothing is sent to PayPal yet."
                : "Enter your name to approve. Nothing is sent to PayPal yet.")}
          </p>
        </form>
      )}
      <p ref={approvalConfirmation} tabIndex={-1} role="status" aria-live="polite" className="hint">
        {attemptedKey !== currentAttemptKey && approvalConfirmationKey === currentAttemptKey && c.status === "approved" && !c.pendingAction && !c.execution
          ? "Approved; nothing sent to PayPal yet" : ""}
      </p>
      {approve.error !== undefined && <ErrorNote title="Approval refused" message={approve.error} />}

      {c.status === "approved" && rec && !lockReason && c.assessment?.kind === "actionable" && (
        <div className="gate__execute">
          <p>
            Approved by <strong>{c.approvedBy}</strong>. Executing sends one <strong>{ACTION_LABEL[rec.action]}</strong> request to
            PayPal. The server checks the current permitted action before sending and records the response. An unknown outcome requires review before retrying.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={executionBlocked !== null || execute.pending !== null}
            aria-describedby="execute-reason"
            onClick={async () => {
              if (executionBlocked !== null) return;
              setAttemptedKey(currentAttemptKey);
              const updated = await execute.run("execute", () => api.execute(c.disputeId));
              if (updated) onUpdated(updated);
            }}
          >
            {execute.pending ? "Sending to PayPal" : rec.action === "concede" ? `Accept claim and refund ${refundLabel ?? "(amount unavailable)"}` : "Execute on PayPal"}
          </button>
          <p id="execute-reason" className="hint">{executionBlocked ?? "Execution sends the approved response once. Verify the case and refund amount before continuing."}</p>
        </div>
      )}
      {execute.error !== undefined && <ErrorNote title="Execution was not confirmed" message={`${execute.error} Refresh the case before taking another action.`} />}

      {c.status === "resolved" && !c.pendingAction && (
        <div className="gate__result">
          <h4>Dispute outcome</h4>
          <p>{c.outcome ? `Dispute resolved: ${c.outcome}` : "Dispute resolved; outcome details unavailable"}</p>
          <p className="hint">This case status does not establish an acknowledged request or completed refund.</p>
        </div>
      )}

      {c.execution && (
        <div className="gate__result">
          <h4>PayPal response</h4>
          <dl className="kv">
            <div>
              <dt>Action sent</dt>
              <dd>{ACTION_LABEL[c.execution.action]}</dd>
            </div>
            <div>
              <dt>HTTP status</dt>
              <dd>
                <strong>{c.execution.httpStatus}</strong> {c.execution.httpStatus >= 200 && c.execution.httpStatus < 300 ? "request accepted; dispute outcome is separate" : "response recorded; review required"}
              </dd>
            </div>
            <div>
              <dt>Request id</dt>
              <dd>
                <code>{c.execution.requestId}</code>
              </dd>
            </div>
            <div>
              <dt>Sent at</dt>
              <dd>{formatDateTime(c.execution.at)}</dd>
            </div>
          </dl>
          <details>
            <summary>Raw response body</summary>
            <pre>{JSON.stringify(c.execution.response, null, 2)}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
