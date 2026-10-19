import { describe, expect, it } from "vitest";
import type { Case } from "../src/domain.js";
import { IllegalTransitionError, Store } from "../src/store.js";

const newCase = (over: Partial<Case> = {}): Case => ({
  disputeId: "PP-D-1",
  status: "received",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  amount: { currency_code: "USD", value: "48.00" },
  permittedRels: [],
  evidence: [],
  guardFailures: [],
  updatedAt: "2026-10-09T00:00:00.000Z",
  ...over,
});

describe("Store", () => {
  it("round-trips a case and lists newest first", () => {
    let tick = 0;
    const store = new Store(":memory:", () => new Date(Date.UTC(2026, 9, 9, 0, 0, tick++)));
    store.saveCase(newCase({ disputeId: "A" }));
    store.saveCase(newCase({ disputeId: "B" }));
    expect(store.getCase("A")).toMatchObject({ disputeId: "A", status: "received" });
    expect(store.listCases().map((c) => c.disputeId)).toEqual(["B", "A"]);
  });

  it("walks legal transitions, applies the patch, and audits each move", () => {
    const store = new Store();
    store.saveCase(newCase());
    const next = store.transition("PP-D-1", "evidence_gathered", { permittedRels: ["accept_claim"] });
    expect(next).toMatchObject({ status: "evidence_gathered", permittedRels: ["accept_claim"] });
    store.transition("PP-D-1", "recommended");
    store.transition("PP-D-1", "recommended");
    expect(store.auditTrail("PP-D-1").map((a) => a.detail)).toEqual([
      { from: "received", to: "evidence_gathered" },
      { from: "evidence_gathered", to: "recommended" },
      { from: "recommended", to: "recommended" },
    ]);
  });

  it("throws on an illegal transition and leaves the case untouched", () => {
    const store = new Store();
    store.saveCase(newCase());
    expect(() => store.transition("PP-D-1", "executed")).toThrow(IllegalTransitionError);
    expect(store.getCase("PP-D-1")?.status).toBe("received");
    store.transition("PP-D-1", "resolved");
    expect(() => store.transition("PP-D-1", "received")).toThrow(/resolved -> received/);
  });

  it("refuses to change status through saveCase or to create a case past received", () => {
    const store = new Store();
    expect(() => store.saveCase(newCase({ status: "approved" }))).toThrow(IllegalTransitionError);
    store.saveCase(newCase());
    expect(() => store.saveCase(newCase({ status: "approved" }))).toThrow(IllegalTransitionError);
    store.saveCase(newCase({ error: "AI not configured" }));
    expect(store.getCase("PP-D-1")?.error).toBe("AI not configured");
  });

  it("acknowledges only completed webhook processing", () => {
    const store = new Store();
    store.startWebhook("WH-1");
    expect(store.hasWebhook("WH-1")).toBe(false);
    store.startWebhook("WH-1");
    expect(store.hasWebhook("WH-1")).toBe(false);
    store.completeWebhook("WH-1");
    expect(store.hasWebhook("WH-1")).toBe(true);
  });

  it("keeps the audit log append-only", () => {
    const store = new Store();
    store.audit("PP-D-1", "note", { a: 1 });
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    expect(() => db.exec("UPDATE audit SET kind = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit")).toThrow(/append-only/);
    expect(store.auditTrail()).toHaveLength(1);
  });
});

it('rolls back assessment invalidation and preserves audit if its audit write fails', () => {
  const store = new Store();
  try {
    store.saveCase(newCase({ recommendationRevision: 'old' }));
    store.transition('PP-D-1', 'evidence_gathered'); store.transition('PP-D-1', 'recommended');
    const before = store.getCase('PP-D-1');
    const auditBefore = store.auditTrail('PP-D-1');
    const audit = store.audit.bind(store);
    store.audit = () => { throw new Error('simulated audit write failure'); };
    expect(() => store.beginAssessment('PP-D-1')).toThrow('simulated audit write failure');
    expect(store.getCase('PP-D-1')).toEqual(before);
    expect(store.auditTrail('PP-D-1')).toEqual(auditBefore);
    store.audit = audit;
    store.beginAssessment('PP-D-1');
    expect(store.getCase('PP-D-1')).toMatchObject({ status: 'evidence_gathered' });
    expect(store.getCase('PP-D-1')?.recommendationRevision).toBeUndefined();
    expect(store.auditTrail('PP-D-1').slice(0, auditBefore.length)).toEqual(auditBefore);
  } finally { store.close(); }
});
