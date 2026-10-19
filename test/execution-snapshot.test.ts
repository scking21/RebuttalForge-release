import { expect, it } from 'vitest';
import { scriptedBranch } from '../src/agent/test-double.js';
import { startSystem, sellOne, buyerOpensDispute } from './support/system.js';

async function ready() {
  const sys = startSystem({ model: scriptedBranch('concede') });
  const { captureId } = await sellOne(sys, 'snapshot');
  sys.records[captureId] = [{ kind: 'not_shipped', label: 'Seller note', fact: 'Never shipped', recordedAt: '2026-10-01T00:00:00Z' }];
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  const reviewed = (await sys.api('GET', `/api/cases/${disputeId}`)).body;
  expect((await sys.api('POST', `/api/cases/${disputeId}/approve`, { approvedBy: 'Seller', recommendationRevision: reviewed.recommendationRevision })).status).toBe(200);
  sys.fetchCalls.length = 0;
  return { sys, disputeId };
}
it.each(['amount', 'currency', 'capture', 'deadline', 'identity', 'legacy', 'draft', 'expired', 'missing-amount', 'missing-snapshot', 'reason', 'stage'])('refuses execution after %s changes without a PayPal action', async change => {
  const { sys, disputeId } = await ready();
  try {
    if (change === 'legacy' || change === 'draft' || change === 'missing-snapshot') {
      const c = sys.store.getCase(disputeId)!;
      if (change === 'legacy') c.recommendationRevision = undefined;
      else if (change === 'missing-snapshot') c.approvedSnapshot = undefined;
      else {
        if (c.assessment?.kind !== 'actionable') throw new Error('Expected actionable approved case');
        c.assessment.recommendation.draft.note = 'Unreviewed change';
      }
      sys.store.saveCase(c);
    } else {
      const get = sys.client.getDispute.bind(sys.client);
      sys.client.getDispute = async id => {
        const d = await get(id);
        if (change === 'amount') d.dispute_amount.value = '49.00';
        if (change === 'currency') d.dispute_amount.currency_code = 'EUR';
        if (change === 'capture') d.disputed_transactions[0]!.seller_transaction_id = 'OTHER';
        if (change === 'deadline') d.seller_response_due_date = '2099-01-01T00:00:00Z';
        if (change === 'expired') d.seller_response_due_date = '2000-01-01T00:00:00Z';
        if (change === 'identity') d.dispute_id = 'OTHER';
        if (change === 'reason') d.reason = 'OTHER_REASON';
        if (change === 'stage') d.dispute_life_cycle_stage = 'ARBITRATION';
        if (change === 'missing-amount') d.dispute_amount = undefined as never;
        return d;
      };
    }
    const response = await sys.api('POST', `/api/cases/${disputeId}/execute`);
    expect(response.status).toBe(409);
    expect(sys.store.getCase(disputeId)?.status).toBe('failed');
    expect(sys.fetchCalls.filter(x => x.startsWith('POST'))).toEqual([]);
    expect(sys.store.auditTrail(disputeId).some(x => x.kind === 'approval.invalidated')).toBe(true);
    expect((await sys.api('POST', `/api/cases/${disputeId}/execute`)).status).toBe(409);
  } finally { sys.store.close(); }
});
it('executes once for concurrent unchanged requests', async () => {
  const { sys, disputeId } = await ready();
  try {
    const responses = await Promise.all([sys.api('POST', `/api/cases/${disputeId}/execute`), sys.api('POST', `/api/cases/${disputeId}/execute`)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(sys.fetchCalls.filter(x => x.endsWith('/accept-claim'))).toHaveLength(1);
  } finally { sys.store.close(); }
});

it('requires reassessment and fresh approval after stale execution, keeping the original audit', async () => {
  const { sys, disputeId } = await ready();
  try {
    const get = sys.client.getDispute.bind(sys.client);
    sys.client.getDispute = async id => ({ ...await get(id), dispute_amount: { currency_code: 'USD', value: '49.00' } });
    expect((await sys.api('POST', `/api/cases/${disputeId}/execute`)).status).toBe(409);
    sys.client.getDispute = get;
    const c = (await sys.api('POST', `/api/cases/${disputeId}/reassess`)).body;
    expect((await sys.api('POST', `/api/cases/${disputeId}/execute`)).status).toBe(409);
    expect((await sys.api('POST', `/api/cases/${disputeId}/approve`, { approvedBy: 'Seller', recommendationRevision: c.recommendationRevision })).status).toBe(200);
    expect((await sys.api('POST', `/api/cases/${disputeId}/execute`)).status).toBe(200);
    expect(sys.store.auditTrail(disputeId).filter(x => x.kind === 'approved')).toHaveLength(2);
    expect(sys.store.auditTrail(disputeId).filter(x => x.kind === 'approval.invalidated')).toHaveLength(1);
  } finally { sys.store.close(); }
});
