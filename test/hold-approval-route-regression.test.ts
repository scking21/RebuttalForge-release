import { expect, it } from 'vitest';
import { startSystem } from './support/system.js';

it('classifies a recommended-status held record as not approvable before revision checks', async () => {
  const sys = startSystem();
  try {
    const disputeId = 'SYNTHETIC-HELD-RECOMMENDED';
    sys.store.saveCase({
      disputeId, status: 'received', reason: 'NOT_RECEIVED',
      amount: { currency_code: 'USD', value: '48.00' },
      permittedRels: ['accept_claim'], evidence: [], guardFailures: [],
      assessment: { kind: 'hold', reason: 'MISSING_EVIDENCE', summary: 'Source records missing.', evidenceIds: [], reviewerNextStep: 'Review original records.' },
      updatedAt: '2026-10-11T00:00:00Z',
    });
    sys.store.transition(disputeId, 'evidence_gathered');
    sys.store.transition(disputeId, 'recommended');
    const result = await sys.api('POST', `/api/cases/${disputeId}/approve`, { approvedBy: 'Synthetic reviewer' });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('not_approvable');
    expect(sys.store.getCase(disputeId)?.approvedSnapshot).toBeUndefined();
    expect(sys.store.auditTrail(disputeId).filter(event => event.kind === 'approved')).toEqual([]);
    expect(sys.fetchCalls).toEqual([]);
  } finally { sys.store.close(); }
});
