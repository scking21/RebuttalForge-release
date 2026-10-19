import { expect, it } from 'vitest';
import { ScriptedModel, scriptedBranch } from '../src/agent/test-double.js';
import type { HoldReason } from '../src/domain.js';
import { buyerOpensDispute, sellOne, startSystem } from './support/system.js';

const reasons: HoldReason[] = ['MISSING_EVIDENCE', 'CONFLICTING_EVIDENCE', 'UNSUPPORTED_TRANSACTION', 'UNSUPPORTED_RESPONSE', 'STALE_APPROVAL', 'MODEL_UNAVAILABLE'];

it.each(reasons)('persists a %s hold without an executable draft or revision', async reason => {
  const sys = startSystem({ model: new ScriptedModel(() => ({ kind: 'hold', reason, summary: 'Synthetic hold for review.', evidenceIds: [], reviewerNextStep: 'Review the source records before responding.' })) });
  try {
    const { captureId } = await sellOne(sys, `hold-${reason}`);
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    const c = sys.store.getCase(disputeId)!;
    expect(c.status).toBe('evidence_gathered');
    expect(c.assessment).toMatchObject({ kind: 'hold', reason });
    expect(c.assessment?.recommendation).toBeUndefined();
    expect(c.recommendationRevision).toBeUndefined();
    expect(c.approvedSnapshot).toBeUndefined();
    sys.fetchCalls.length = 0;
    expect((await sys.api('POST', `/api/cases/${disputeId}/approve`, { approvedBy: 'Synthetic reviewer' })).status).toBe(409);
    expect((await sys.api('POST', `/api/cases/${disputeId}/execute`)).status).toBe(409);
    expect(sys.fetchCalls.filter(x => x.startsWith('POST'))).toEqual([]);
  } finally { sys.store.close(); }
});

it('does not retain actionable advice after the model returns a hold with an unknown citation', async () => {
  let hold = false;
  const base = scriptedBranch('concede');
  const sys = startSystem({ model: new ScriptedModel(input => hold
    ? { kind: 'hold', reason: 'MISSING_EVIDENCE', summary: 'Review unknown evidence.', evidenceIds: ['NOT-PRESENT'], reviewerNextStep: 'Review.' }
    : base.recommend(input)) });
  try {
    const { captureId } = await sellOne(sys, 'hold-unknown-citation');
    sys.records[captureId] = [{ kind: 'not_shipped', label: 'Seller statement', fact: 'Never shipped', recordedAt: '2026-10-01T00:00:00Z' }];
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    expect(sys.store.getCase(disputeId)?.assessment?.kind).toBe('actionable');
    hold = true;
    const result = await sys.api('POST', `/api/cases/${disputeId}/reassess`);
    expect(result.status).toBe(200);
    expect(result.body.assessment).toMatchObject({ kind: 'hold', reason: 'MODEL_UNAVAILABLE' });
    expect(result.body.assessment.recommendation).toBeUndefined();
    expect(result.body.recommendationRevision).toBeUndefined();
  } finally { sys.store.close(); }
});
