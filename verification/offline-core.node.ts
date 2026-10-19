import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { snapshotForCase, assertApprovalCurrent, decisionFacts, ApprovalStale } from '../src/approval.js';
import { Store } from '../src/store.js';
import type { Case, Recommendation } from '../src/domain.js';
import type { Dispute } from '../src/paypal/schemas.js';

const now = () => new Date('2026-10-11T17:00:00Z');
const dispute = (): Dispute => ({
  dispute_id: 'D-OFFLINE', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  status: 'WAITING_FOR_SELLER_RESPONSE', dispute_life_cycle_stage: 'CLAIM',
  dispute_amount: { currency_code: 'USD', value: '48.00' },
  disputed_transactions: [{ seller_transaction_id: 'CAP-OFFLINE' }],
  seller_response_due_date: '2026-10-20T00:00:00Z',
  evidences: [], messages: [], allowed_response_options: { accept_claim: { accept_claim_types: ['REFUND'] } },
  links: [{ href: 'https://example.invalid/disputes/D-OFFLINE/accept-claim', rel: 'accept_claim', method: 'POST' }],
} as Dispute);
const recommendation = (): Recommendation => ({
  action: 'concede', confidence: 'high', summary: 'Seller records state the item was not shipped.',
  supports: [{ text: 'Seller records state the item was not shipped.', evidenceIds: ['E1'] }],
  contradicts: [], draft: { note: 'The seller reports this item was not shipped.' },
});
const actionable = (): Case => ({
  disputeId: 'D-OFFLINE', status: 'recommended', reason: dispute().reason,
  amount: dispute().dispute_amount, sellerResponseDueDate: dispute().seller_response_due_date,
  permittedRels: ['accept_claim'], evidence: [{ id: 'E1', source: 'seller.record', provenance: 'directSellerAssertion', label: 'Seller note', fact: 'Never shipped', ref: 'fixture:local', observedAt: now().toISOString() }],
  assessment: { kind: 'actionable', recommendation: recommendation() },
  recommendationRevision: 'REV-OFFLINE', decisionFacts: decisionFacts(dispute()),
  guardFailures: [], updatedAt: now().toISOString(),
});

test('actionable assessment can be snapshotted and verified without a legacy recommendation field', () => {
  const c = actionable();
  c.approvedSnapshot = snapshotForCase(c);
  c.status = 'approved';
  assert.doesNotThrow(() => assertApprovalCurrent(c, dispute(), now()));
  assert.equal(c.approvedSnapshot.revision, 'REV-OFFLINE');
});

test('a hold cannot be approved even if a legacy recommendation is present', () => {
  const c = { ...actionable(), recommendation: recommendation() };
  c.assessment = { kind: 'hold', reason: 'MISSING_EVIDENCE', summary: 'Missing delivery evidence.', evidenceIds: [], reviewerNextStep: 'Review the source records.' };
  assert.throws(() => snapshotForCase(c), ApprovalStale);
});

test('beginning reassessment removes the previous actionable assessment and its approval', () => {
  const store = new Store(':memory:', now);
  try {
    const c = actionable();
    store.saveCase({ ...c, status: 'received' });
    store.transition(c.disputeId, 'evidence_gathered');
    store.transition(c.disputeId, 'recommended');
    store.beginAssessment(c.disputeId);
    const refreshed = store.getCase(c.disputeId)!;
    assert.equal(refreshed.status, 'evidence_gathered');
    assert.equal(refreshed.assessment, undefined);
    assert.equal(refreshed.recommendationRevision, undefined);
    assert.equal(refreshed.approvedSnapshot, undefined);
  } finally { store.close(); }
});

function seedApproved(store: Store): Case {
  const c = actionable();
  store.saveCase({ ...c, status: 'received' });
  store.transition(c.disputeId, 'evidence_gathered');
  const recommended = store.transition(c.disputeId, 'recommended');
  return store.transition(c.disputeId, 'approved', { approvedBy: 'Synthetic reviewer', approvedSnapshot: snapshotForCase(recommended) });
}

const intentFor = (c: Case) => ({ requestId: 'REQ-OFFLINE', revision: c.recommendationRevision!, at: now().toISOString() });

test('durable execution claim excludes a second caller with the same approved snapshot', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.claimPendingAction(c, intentFor(c));
    assert.throws(() => store.claimPendingAction(c, intentFor(c)), /prior action|pending|reconcil/i);
    assert.equal(store.getCase(c.disputeId)?.pendingAction?.requestId, 'REQ-OFFLINE');
    assert.equal(store.auditTrail(c.disputeId).filter(e => e.kind === 'paypal.action.pending').length, 1);
  } finally { store.close(); }
});

test('execution claim rejects a changed recommendation after preflight', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    const altered = structuredClone(c);
    if (altered.assessment?.kind === 'actionable') altered.assessment.recommendation.draft.note = 'Changed after preflight';
    store.saveCase(altered);
    assert.throws(() => store.claimPendingAction(c, intentFor(c)), ApprovalStale);
    assert.equal(store.getCase(c.disputeId)?.pendingAction, undefined);
  } finally { store.close(); }
});

test('execution claim rejects an approval invalidated by reassessment', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.beginAssessment(c.disputeId);
    assert.throws(() => store.claimPendingAction(c, intentFor(c)), ApprovalStale);
    assert.equal(store.getCase(c.disputeId)?.pendingAction, undefined);
  } finally { store.close(); }
});

test('execution claim rejects intent revision that differs from reviewed snapshot', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    assert.throws(() => store.claimPendingAction(c, { ...intentFor(c), revision: 'WRONG' }), ApprovalStale);
    assert.equal(store.getCase(c.disputeId)?.pendingAction, undefined);
  } finally { store.close(); }
});


test('two independent SQLite connections admit only one claimant and preserve it after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rebuttalforge-claim-'));
  const file = join(dir, 'cases.sqlite');
  const first = new Store(file, now);
  const second = new Store(file, now);
  try {
    const c = seedApproved(first);
    const stale = second.getCase(c.disputeId)!;
    first.claimPendingAction(c, intentFor(c));
    assert.throws(() => second.claimPendingAction(stale, intentFor(stale)), /prior action|pending|reconcil/i);
    const restarted = new Store(file, now);
    try {
      assert.equal(restarted.getCase(c.disputeId)?.pendingAction?.requestId, 'REQ-OFFLINE');
      assert.throws(() => restarted.beginAssessment(c.disputeId), /prior action|pending|reconcil/i);
      assert.equal(restarted.auditTrail(c.disputeId).filter(e => e.kind === 'paypal.action.pending').length, 1);
    } finally { restarted.close(); }
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true }); }
});

test('a stale general save cannot erase a durable pending action', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.claimPendingAction(c, intentFor(c));
    assert.throws(() => store.saveCase({ ...c, error: 'Delayed refresh' }), /prior action|pending|reconcil/i);
    assert.equal(store.getCase(c.disputeId)?.pendingAction?.requestId, 'REQ-OFFLINE');
  } finally { store.close(); }
});

test('a delayed preflight failure cannot clear another caller pending marker', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.claimPendingAction(c, intentFor(c));
    assert.throws(() => store.transition(c.disputeId, 'failed', { error: 'Other caller preflight failed', pendingAction: undefined }), /prior action|pending|reconcil/i);
    assert.equal(store.getCase(c.disputeId)?.status, 'approved');
    assert.equal(store.getCase(c.disputeId)?.pendingAction?.requestId, 'REQ-OFFLINE');
  } finally { store.close(); }
});

test('only the execution claimant can clear its pending marker after a known rejection', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.claimPendingAction(c, intentFor(c));
    assert.throws(() => store.transition(c.disputeId, 'failed', { pendingAction: undefined }, 'WRONG'), /prior action|pending|reconcil/i);
    const failed = store.transition(c.disputeId, 'failed', { error: 'Known rejection', pendingAction: undefined }, 'REQ-OFFLINE');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.pendingAction, undefined);
  } finally { store.close(); }
});

test('a different caller cannot fail a claimed case even while preserving its pending marker', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.claimPendingAction(c, intentFor(c));
    assert.throws(() => store.transition(c.disputeId, 'failed', { error: 'Other caller approval stale' }), /prior action|pending|reconcil/i);
    assert.equal(store.getCase(c.disputeId)?.status, 'approved');
  } finally { store.close(); }
});

test('the claimant records an uncertain outcome without permitting reassessment or another claim', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.claimPendingAction(c, intentFor(c));
    const failed = store.transition(c.disputeId, 'failed', { error: 'Response never arrived' }, 'REQ-OFFLINE');
    assert.equal(failed.pendingAction?.requestId, 'REQ-OFFLINE');
    assert.throws(() => store.beginAssessment(c.disputeId), /prior action|pending|reconcil/i);
    assert.throws(() => store.claimPendingAction(c, intentFor(c)), /prior action|pending|reconcil/i);
  } finally { store.close(); }
});

test('an accepted action cannot be reopened by reassessment or claim', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.claimPendingAction(c, intentFor(c));
    const completed = store.transition(c.disputeId, 'executed', {
      pendingAction: undefined,
      execution: { action: 'concede', requestId: 'REQ-OFFLINE', httpStatus: 200, response: { accepted: true }, at: now().toISOString() },
    }, 'REQ-OFFLINE');
    assert.equal(completed.pendingAction, undefined);
    assert.equal(completed.execution?.requestId, 'REQ-OFFLINE');
    assert.throws(() => store.beginAssessment(c.disputeId), /prior action|pending|reconcil/i);
    assert.throws(() => store.claimPendingAction(c, intentFor(c)), /prior action|pending|reconcil/i);
  } finally { store.close(); }
});


test('simultaneous independent workers cannot both claim one SQLite approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rebuttalforge-parallel-'));
  try {
    for (let round = 0; round < 10; round++) {
      const file = join(dir, `cases-${round}.sqlite`);
      const store = new Store(file, now);
      const expected = seedApproved(store);
      const gate = new SharedArrayBuffer(4);
      const view = new Int32Array(gate);
      let ready = 0;
      const results = await Promise.all([0, 1].map(() => new Promise<{ claimed: boolean; error?: string }>((resolve, reject) => {
        const worker = new Worker(new URL('./claim-worker.ts', import.meta.url), { workerData: { file, expected, gate, intent: intentFor(expected) } });
        worker.on('error', reject);
        worker.on('message', message => {
          if (message.ready) {
            if (++ready === 2) { Atomics.store(view, 0, 1); Atomics.notify(view, 0); }
          } else resolve(message);
        });
        worker.on('exit', code => { if (code !== 0) reject(new Error(`Claim worker exited ${code}`)); });
      })));
      try {
        assert.equal(results.filter(result => result.claimed).length, 1, `Round ${round}: ${JSON.stringify(results)}`);
        assert.match(results.find(result => !result.claimed)!.error!, /prior action|pending|reconcil/i);
        assert.equal(store.auditTrail(expected.disputeId).filter(e => e.kind === 'paypal.action.pending').length, 1);
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true }); }
});


for (const state of ['approved', 'uncertain', 'accepted'] as const) {
  test(`legacy ${state} records lose executable advice while their original bytes remain archived`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuttalforge-legacy-'));
    const file = join(dir, 'cases.sqlite');
    const initializer = new Store(file, now);
    const legacy = { ...seedApproved(initializer), recommendation: recommendation() } as Record<string, unknown>;
    delete legacy.assessment;
    if (state === 'uncertain') legacy.pendingAction = { requestId: 'LEGACY-PENDING', revision: 'REV-OFFLINE', at: now().toISOString() };
    if (state === 'accepted') {
      legacy.status = 'executed';
      legacy.execution = { action: 'concede', requestId: 'LEGACY-ACCEPTED', httpStatus: 200, response: { accepted: true }, at: now().toISOString() };
    }
    const original = JSON.stringify(legacy);
    initializer.close();
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE cases SET json = ? WHERE dispute_id = ?').run(original, 'D-OFFLINE');
    raw.close();
    let store = new Store(file, now);
    try {
      const migrated = store.getCase('D-OFFLINE')!;
      assert.equal(Object.hasOwn(migrated, 'recommendation'), false);
      assert.equal(migrated.assessment?.kind, 'hold');
      assert.equal(migrated.recommendationRevision, undefined);
      assert.equal(migrated.approvedSnapshot, undefined);
      assert.throws(() => snapshotForCase(migrated), ApprovalStale);
      if (state === 'approved') assert.equal(migrated.status, 'evidence_gathered');
      if (state === 'uncertain') {
        assert.equal(migrated.pendingAction?.requestId, 'LEGACY-PENDING');
        assert.throws(() => store.beginAssessment('D-OFFLINE'), /prior action|pending|reconcil/i);
      }
      if (state === 'accepted') assert.equal(migrated.execution?.requestId, 'LEGACY-ACCEPTED');
      store.close();
      store = new Store(file, now);
      assert.equal(store.auditTrail('D-OFFLINE').filter(e => e.kind === 'case.legacy_migrated').length, 1);
      const verification = new DatabaseSync(file);
      try {
        const snapshots = verification.prepare('SELECT json FROM case_legacy_snapshots WHERE dispute_id = ?').all('D-OFFLINE');
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0]!.json, original);
      } finally { verification.close(); }
    } finally { store.close(); rmSync(dir, { recursive: true }); }
  });
}

test('an accepted action remains non-repeatable if later processing marks its case failed', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.claimPendingAction(c, intentFor(c));
    store.transition(c.disputeId, 'executed', {
      pendingAction: undefined,
      execution: { action: 'concede', requestId: 'REQ-OFFLINE', httpStatus: 200, response: { accepted: true }, at: now().toISOString() },
    }, 'REQ-OFFLINE');
    store.transition(c.disputeId, 'failed', { error: 'Later processing failed' });
    assert.throws(() => store.beginAssessment(c.disputeId), /prior action|pending|reconcil/i);
    assert.equal(store.getCase(c.disputeId)?.execution?.requestId, 'REQ-OFFLINE');
  } finally { store.close(); }
});

for (const corruption of ['identity', 'json'] as const) {
  test(`legacy migration rolls back all case and archive changes on ${corruption} corruption`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuttalforge-corruption-'));
    const file = join(dir, 'cases.sqlite');
    const initializer = new Store(file, now);
    initializer.close();
    const raw = new DatabaseSync(file);
    const legacy = { ...actionable(), disputeId: 'D-ONE', status: 'approved', recommendation: recommendation() } as Record<string, unknown>;
    delete legacy.assessment;
    const originalOne = JSON.stringify(legacy);
    const originalTwo = corruption === 'identity' ? JSON.stringify({ ...legacy, disputeId: 'D-ONE', reason: 'Would overwrite another case' }) : '{not valid JSON';
    raw.prepare('INSERT INTO cases (dispute_id, json) VALUES (?, ?)').run('D-ONE', originalOne);
    raw.prepare('INSERT INTO cases (dispute_id, json) VALUES (?, ?)').run('D-TWO', originalTwo);
    const before = raw.prepare('SELECT * FROM cases ORDER BY dispute_id').all();
    try {
      if (corruption === 'identity') assert.throws(() => new Store(file, now), /case identity mismatch/i);
      else assert.throws(() => new Store(file, now), SyntaxError);
      assert.deepEqual(raw.prepare('SELECT * FROM cases ORDER BY dispute_id').all(), before);
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM case_legacy_snapshots').get()!.count, 0);
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM audit WHERE kind = 'case.legacy_migrated'").get()!.count, 0);
    } finally { raw.close(); rmSync(dir, { recursive: true }); }
  });
}

const acceptedExecution = () => ({ action: 'concede' as const, requestId: 'REQ-OFFLINE', httpStatus: 200, response: { accepted: true }, at: now().toISOString() });

for (const resolvedFirst of [false, true]) {
  test(`acknowledged action is durably recorded ${resolvedFirst ? 'after' : 'before'} a resolution webhook`, () => {
    const store = new Store(':memory:', now);
    try {
      const c = seedApproved(store);
      store.claimPendingAction(c, intentFor(c));
      if (resolvedFirst) store.transition(c.disputeId, 'resolved', { outcome: 'SYNTHETIC_RESOLVED' });
      const result = store.recordExecution(c.disputeId, acceptedExecution(), []);
      assert.equal(result.status, resolvedFirst ? 'resolved' : 'executed');
      assert.equal(result.execution?.requestId, 'REQ-OFFLINE');
      assert.equal(result.pendingAction, undefined);
      if (resolvedFirst) assert.equal(result.outcome, 'SYNTHETIC_RESOLVED');
      assert.equal(store.auditTrail(c.disputeId).filter(e => e.kind === 'paypal.action').length, 1);
      assert.deepEqual(store.recordExecution(c.disputeId, acceptedExecution(), []), JSON.parse(JSON.stringify(result)));
      assert.equal(store.auditTrail(c.disputeId).filter(e => e.kind === 'paypal.action').length, 1);
    } finally { store.close(); }
  });
}

test('an acknowledgement cannot overwrite another pending action identity', () => {
  const store = new Store(':memory:', now);
  try {
    const c = seedApproved(store);
    store.claimPendingAction(c, intentFor(c));
    assert.throws(() => store.recordExecution(c.disputeId, { ...acceptedExecution(), requestId: 'WRONG' }, []), /prior action|pending|reconcil/i);
    assert.equal(store.getCase(c.disputeId)?.pendingAction?.requestId, 'REQ-OFFLINE');
    assert.equal(store.getCase(c.disputeId)?.execution, undefined);
  } finally { store.close(); }
});
