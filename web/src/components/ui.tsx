import type { ReactNode } from "react";
import type { CaseStatus } from "../../../src/domain";
import { STATUS_LABEL } from "../format";

export type IconName = "check" | "cross" | "alert" | "dot" | "ring" | "clock";

const PATHS: Record<IconName, ReactNode> = {
  check: <path d="M3 8.5l3.2 3.2L13 4.8" />,
  cross: <path d="M4 4l8 8M12 4l-8 8" />,
  alert: (
    <>
      <path d="M8 2.2l6.2 11H1.8z" />
      <path d="M8 6.6v3.2M8 11.6v.1" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
  ring: <circle cx="8" cy="8" r="4.5" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.3 1.4" />
    </>
  ),
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

export type Tone = "neutral" | "info" | "ok" | "bad" | "warn";

export function Chip({ tone = "neutral", icon, children }: { tone?: Tone; icon?: IconName; children: ReactNode }) {
  return (
    <span className={`chip chip--${tone}`}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

const STATUS_CHIP: Record<CaseStatus, { tone: Tone; icon: IconName }> = {
  received: { tone: "neutral", icon: "ring" },
  evidence_gathered: { tone: "neutral", icon: "dot" },
  recommended: { tone: "info", icon: "dot" },
  approved: { tone: "info", icon: "check" },
  executed: { tone: "info", icon: "check" },
  resolved: { tone: "ok", icon: "check" },
  failed: { tone: "bad", icon: "cross" },
};

export function StatusChip({ status }: { status: CaseStatus }) {
  const { tone, icon } = STATUS_CHIP[status];
  return (
    <Chip tone={tone} icon={icon}>
      {STATUS_LABEL[status]}
    </Chip>
  );
}

export function ErrorNote({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="note note--bad" role="alert">
      <Icon name="alert" />
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
        {onRetry && (
          <button type="button" className="btn btn--small" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      Loading {what}
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function ConfidenceMeter({ level, label }: { level: 0 | 1 | 2 | 3; label: string }) {
  return (
    <span className="meter">
      <span className="meter__bars" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} data-on={i <= level} />
        ))}
      </span>
      {label}
    </span>
  );
}
