import { DatabaseSync } from "node:sqlite";
import { ApprovalStale, snapshotForCase } from "./approval.js";
import { canTransition, type Case, type CaseStatus, type Execution } from "./domain.js";

export interface AuditEntry {
  at: string;
  disputeId: string | null;
  kind: string;
  detail: unknown;
}

// Everything on a Case except the two fields only the store may change.
export type CasePatch = Partial<Omit<Case, "status" | "disputeId">>;

export class IllegalTransitionError extends Error {
  constructor(
    readonly disputeId: string,
    readonly from: CaseStatus,
    readonly to: CaseStatus,
  ) {
    super(`Illegal transition for ${disputeId}: ${from} -> ${to}`);
  }
}

export class ManualReconciliationRequired extends Error {
  constructor() { super("A prior action may have reached PayPal. Review its outcome manually before another action."); }
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(
    path = ":memory:",
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        dispute_id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS case_legacy_snapshots (
        dispute_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        json TEXT NOT NULL,
        migrated_at TEXT NOT NULL,
        PRIMARY KEY (dispute_id, version)
      );
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        dispute_id TEXT,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
        BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
        BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
    `);
    const columns = this.db.prepare("PRAGMA table_info(webhook_events)").all();
    if (!columns.some(column => column.name === "completed_at")) {
      this.db.exec("ALTER TABLE webhook_events ADD COLUMN completed_at TEXT");
    }
    try {
      this.migrateLegacyRecommendations();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrateLegacyRecommendations(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db.prepare("SELECT dispute_id, json FROM cases").all()) {
        const original = String(row.json);
        const parsed = JSON.parse(original) as Case & { recommendation?: unknown };
        if (!Object.hasOwn(parsed, "recommendation")) continue;
        if (parsed.disputeId !== String(row.dispute_id)) throw new Error("Legacy case identity mismatch; migration was not applied.");
        const { recommendation: _legacyRecommendation, ...current } = parsed;
        const version = Number(this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM case_legacy_snapshots WHERE dispute_id = ?").get(String(row.dispute_id))!.version);
        const at = this.now().toISOString();
        this.db.prepare("INSERT INTO case_legacy_snapshots (dispute_id, version, json, migrated_at) VALUES (?, ?, ?, ?)")
          .run(String(row.dispute_id), version, original, at);
        this.write({
          ...current,
          status: !current.pendingAction && !current.execution && ["recommended", "approved"].includes(current.status)
            ? "evidence_gathered" : current.status,
          assessment: {
            kind: "hold", reason: "STALE_APPROVAL", summary: "This saved case used an earlier recommendation format. Its old advice and approval are archived and cannot authorize a response.",
            evidenceIds: [], reviewerNextStep: current.pendingAction || current.execution
              ? "Review the recorded request outcome directly in PayPal. Do not send another response from this saved case."
              : "Reassess the current dispute and review a new recommendation before approving any response.",
          },
          recommendationRevision: undefined, approvedSnapshot: undefined, approvedBy: undefined,
          decisionFacts: undefined, updatedAt: at,
        });
        this.audit(current.disputeId, "case.legacy_migrated", { archiveVersion: version, previousStatus: current.status });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getCase(disputeId: string): Case | undefined {
    const row = this.db.prepare("SELECT json FROM cases WHERE dispute_id = ?").get(disputeId);
    return row ? (JSON.parse(String(row.json)) as Case) : undefined;
  }

  listCases(): Case[] {
    return this.db
      .prepare("SELECT json FROM cases")
      .all()
      .map((row) => JSON.parse(String(row.json)) as Case)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // Inserts a new case (always "received") or updates fields of an existing one.
  // Status changes go through transition() so the state machine cannot be skipped.
  saveCase(c: Case): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getCase(c.disputeId);
      if (existing?.pendingAction && JSON.stringify(existing.pendingAction) !== JSON.stringify(c.pendingAction)) {
        throw new ManualReconciliationRequired();
      }
      if (existing && existing.status !== c.status) throw new IllegalTransitionError(c.disputeId, existing.status, c.status);
      if (!existing && c.status !== "received") throw new IllegalTransitionError(c.disputeId, "received", c.status);
      this.write({ ...c, updatedAt: this.now().toISOString() });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  beginAssessment(disputeId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getCase(disputeId);
      if (current) {
        if (current.pendingAction || current.execution) throw new ManualReconciliationRequired();
        if (!["received", "evidence_gathered", "recommended", "approved", "failed"].includes(current.status)) {
          throw new IllegalTransitionError(disputeId, current.status, "evidence_gathered");
        }
        const status = ["recommended", "approved"].includes(current.status) ? "evidence_gathered" : current.status === "failed" ? "received" : current.status;
        this.write({
          ...current, status, assessment: undefined, recommendationRevision: undefined,
          executionHistory: current.execution ? [...(current.executionHistory ?? []), current.execution] : current.executionHistory,
          execution: undefined,
          approvedBy: undefined, approvedSnapshot: undefined, guardFailures: [], error: undefined,
          updatedAt: this.now().toISOString(),
        });
        this.audit(disputeId, "assessment.started", { previousRevision: current.recommendationRevision });
        if (status !== current.status) this.audit(disputeId, "case.transition", { from: current.status, to: status });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimPendingAction(expected: Case, intent: NonNullable<Case["pendingAction"]>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getCase(expected.disputeId);
      if (current?.pendingAction || current?.execution) throw new ManualReconciliationRequired();
      if (!current || current.status !== "approved" || !current.approvedSnapshot ||
          intent.revision !== current.recommendationRevision ||
          JSON.stringify(current.approvedSnapshot) !== JSON.stringify(expected.approvedSnapshot) ||
          JSON.stringify(current.approvedSnapshot) !== JSON.stringify(snapshotForCase(current))) {
        throw new ApprovalStale();
      }
      this.write({ ...current, pendingAction: intent, updatedAt: this.now().toISOString() });
      this.audit(current.disputeId, "paypal.action.pending", intent);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordExecution(disputeId: string, execution: Execution, permittedRels?: string[]): Case {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getCase(disputeId);
      if (!current) throw new Error(`No case for dispute ${disputeId}`);
      if (current.execution) {
        if (current.execution.requestId !== execution.requestId) throw new ManualReconciliationRequired();
        this.db.exec("COMMIT");
        return current;
      }
      if (current.pendingAction?.requestId !== execution.requestId) throw new ManualReconciliationRequired();
      if (current.status !== "approved" && current.status !== "resolved") {
        throw new IllegalTransitionError(disputeId, current.status, "executed");
      }
      const status = current.status === "resolved" ? "resolved" : "executed";
      const next: Case = {
        ...current, status, execution, pendingAction: undefined,
        ...(permittedRels ? { permittedRels } : {}), updatedAt: this.now().toISOString(),
      };
      this.write(next);
      this.audit(disputeId, "paypal.action", { action: execution.action, requestId: execution.requestId, httpStatus: execution.httpStatus });
      if (status !== current.status) this.audit(disputeId, "case.transition", { from: current.status, to: status });
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transition(disputeId: string, to: CaseStatus, patch: CasePatch = {}, pendingRequestId?: string): Case {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getCase(disputeId);
      if (!existing) throw new Error(`No case for dispute ${disputeId}`);
      if (!canTransition(existing.status, to)) throw new IllegalTransitionError(disputeId, existing.status, to);
      const next: Case = { ...existing, ...patch, status: to, updatedAt: this.now().toISOString() };
      if (existing.pendingAction && existing.pendingAction.requestId !== pendingRequestId &&
          (to === "failed" || JSON.stringify(existing.pendingAction) !== JSON.stringify(next.pendingAction))) {
        throw new ManualReconciliationRequired();
      }
      this.write(next);
      this.audit(disputeId, "case.transition", { from: existing.status, to });
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private write(c: Case): void {
    this.db
      .prepare("INSERT INTO cases (dispute_id, json) VALUES (?, ?) ON CONFLICT(dispute_id) DO UPDATE SET json = excluded.json")
      .run(c.disputeId, JSON.stringify(c));
  }

  startWebhook(eventId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO webhook_events (event_id, received_at) VALUES (?, ?)")
      .run(eventId, this.now().toISOString());
  }

  hasWebhook(eventId: string): boolean {
    return this.db.prepare("SELECT 1 FROM webhook_events WHERE event_id = ? AND completed_at IS NOT NULL").get(eventId) !== undefined;
  }

  completeWebhook(eventId: string): void {
    const result = this.db.prepare("UPDATE webhook_events SET completed_at = ? WHERE event_id = ?")
      .run(this.now().toISOString(), eventId);
    if (result.changes !== 1) throw new Error("Cannot complete an unstarted webhook");
  }

  audit(disputeId: string | null, kind: string, detail: unknown = {}): void {
    this.db
      .prepare("INSERT INTO audit (at, dispute_id, kind, detail) VALUES (?, ?, ?, ?)")
      .run(this.now().toISOString(), disputeId, kind, JSON.stringify(detail));
  }

  auditTrail(disputeId?: string): AuditEntry[] {
    const rows = disputeId
      ? this.db.prepare("SELECT * FROM audit WHERE dispute_id = ? ORDER BY id").all(disputeId)
      : this.db.prepare("SELECT * FROM audit ORDER BY id").all();
    return rows.map((r) => ({
      at: String(r.at),
      disputeId: r.dispute_id === null ? null : String(r.dispute_id),
      kind: String(r.kind),
      detail: JSON.parse(String(r.detail)),
    }));
  }

  close(): void {
    this.db.close();
  }
}
