import { recommendationFor, caseReviewLabel, reachedCaseSteps } from "../format";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTION_REL } from "../../../src/domain";
import type { Case } from "../../../src/domain";
import { api } from "../api";
import { prefersReducedMotion, useResource } from "../hooks";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  citationCounts,
  dueInfo,
  formatDate,
  formatMoney,
  humanReason,
  permittedActions,
  ACTION_LABEL,
} from "../format";
import { PostExecutionReview } from "./PostExecutionReview";
import { ApprovalGate } from "./ApprovalGate";
import { AuditTrail } from "./AuditTrail";
import { EvidenceList, evidenceDomId } from "./EvidenceList";
import { GuardPanel } from "./GuardPanel";
import { RecommendationPanel } from "./RecommendationPanel";
import { SandboxTools } from "./SandboxTools";
import { Chip, ErrorNote, Icon, Loading } from "./ui";
import type { IconName } from "./ui";

function Stepper({ c }: { c: Case }) {
  const reached = reachedCaseSteps(c);
  return (
    <ol className="stepper" aria-label="Case progress">
      {STATUS_ORDER.map((s) => {
        const state = s === c.status && reached.has(s) ? "current" : reached.has(s) ? "done" : "todo";
        const icon: IconName = state === "done" ? "check" : state === "current" ? "dot" : "ring";
        return (
          <li key={s} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <Icon name={icon} />
            {STATUS_LABEL[s]}
            <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (current step)" : " (not reached)"}</span>
          </li>
        );
      })}
    </ol>
  );
}

function CaseHeader({ c, headingRef }: { c: Case; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const due = dueInfo(c.sellerResponseDueDate);
  const actions = permittedActions(c);
  const closed = c.status === "resolved";
  return (
    <header className="case-head">
      <div className="case-head__title">
        <h2 id="case-heading" tabIndex={-1} ref={headingRef}>
          Dispute <span className="mono">{c.disputeId}</span>
        </h2>
        <Chip tone={c.pendingAction || c.assessment?.kind === "hold" ? "warn" : "neutral"}>{caseReviewLabel(c)}</Chip>
        <a className="link" href="#/">
          Close case
        </a>
      </div>
      <dl className="facts">
        <div>
          <dt>Reason</dt>
          <dd>{humanReason(c.reason)}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>{formatMoney(c.amount)}</dd>
        </div>
        <div>
          <dt>Respond by</dt>
          <dd>
            {formatDate(c.sellerResponseDueDate)}{" "}
            {!closed && due.state !== "none" && (
              <Chip tone={due.state === "overdue" ? "bad" : due.state === "soon" ? "warn" : "neutral"} icon={due.state === "ok" ? "clock" : "alert"}>
                {due.label}
              </Chip>
            )}
          </dd>
        </div>
        <div>
          <dt>PayPal allows now</dt>
          <dd>
            {actions.length === 0 ? (
              <span className="muted">No response action</span>
            ) : (
              <ul className="inline-list">
                {actions.map((a) => (
                  <li key={a}>
                    <Chip>{ACTION_LABEL[a]}</Chip>
                    <code className="rel">{ACTION_REL[a]}</code>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      <Stepper c={c} />
    </header>
  );
}

export function CaseView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useResource(() => api.caseDetail(id), id, 5000);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const loadedId = detail.data?.case.disputeId;

  useEffect(() => {
    if (!loadedId) return;
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [loadedId]);

  useEffect(() => {
    if (pinned === null) return;
    const t = setTimeout(() => setPinned(null), 2500);
    return () => clearTimeout(t);
  }, [pinned]);

  const jump = useCallback((evidenceId: string) => {
    setPinned(evidenceId);
    const el = document.getElementById(evidenceDomId(evidenceId));
    el?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    el?.focus({ preventScroll: true });
  }, []);

  const c = detail.data?.case;
  const citations = useMemo(() => citationCounts(recommendationFor(c), c?.evidence ?? []), [c]);
  const knownIds = useMemo(() => new Set(c?.evidence.map((e) => e.id)), [c]);

  if (detail.loading) return <Loading what="dispute" />;
  if (!detail.data || !c) {
    return <ErrorNote title={`Could not load dispute ${id}`} message={detail.error ?? "No data returned."} onRetry={detail.reload} />;
  }

  const onUpdated = (next: Case) => {
    detail.replace({ case: next, audit: detail.data?.audit ?? [] });
    detail.reload();
    onChanged();
  };

  return (
    <section className="case" aria-labelledby="case-heading">
      {detail.error !== undefined && <ErrorNote title="Could not refresh this case" message={`${detail.error} Showing the last loaded data.`} onRetry={detail.reload} />}
      <CaseHeader c={c} headingRef={headingRef} />
      <PostExecutionReview c={c} />
      <div className="case-grid">
        <div className="case-side">
          <EvidenceList evidence={c.evidence} citations={citations} activeId={hovered ?? pinned} />
          <SandboxTools c={c} onUpdated={onUpdated} />
        </div>
        <div className="case-main">
          <RecommendationPanel c={c} onUpdated={onUpdated} knownIds={knownIds} onHover={setHovered} onJump={jump} />
          <GuardPanel c={c} />
          <ApprovalGate c={c} onUpdated={onUpdated} />
          <AuditTrail audit={detail.data.audit} />
        </div>
      </div>
    </section>
  );
}
