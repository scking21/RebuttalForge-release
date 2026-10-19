import { expect, it } from 'vitest';
import { scriptedBranch } from '../src/agent/test-double.js';
import { startSystem, sellOne, buyerOpensDispute } from './support/system.js';

it('rejects missing and stale approval revisions, then approves exactly the refreshed draft', async () => {
  let note = 'reviewed draft';
  const base = scriptedBranch('concede');
  const sys = startSystem({ model: { recommend: async input => {
    const assessment = await base.recommend(input);
    if (assessment.kind !== 'actionable') throw new Error('Expected actionable scripted assessment');
    return { kind: 'actionable', recommendation: { ...assessment.recommendation, draft: { note } } };
  } } });
  try {
    const { captureId } = await sellOne(sys, 'revision');
    sys.records[captureId] = [{ kind: 'not_shipped', label: 'Seller note', fact: 'Never shipped', recordedAt: '2026-10-01T00:00:00Z' }];
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    const viewed = (await sys.api('GET', `/api/cases/${disputeId}`)).body;
    note = 'replacement draft';
    const refreshed = (await sys.api('POST', `/api/cases/${disputeId}/reassess`)).body;
    for (const revision of [undefined, viewed.recommendationRevision]) {
      const result = await sys.api('POST', `/api/cases/${disputeId}/approve`, { approvedBy: 'Seller', recommendationRevision: revision });
      expect(result.status).toBe(409);
      expect(sys.store.getCase(disputeId)?.status).toBe('recommended');
    }
    expect(refreshed.recommendationRevision).toEqual(expect.any(String));
    expect(refreshed.recommendationRevision).not.toBe(viewed.recommendationRevision);
    const approved = await sys.api('POST', `/api/cases/${disputeId}/approve`, { approvedBy: 'Seller', recommendationRevision: refreshed.recommendationRevision });
    expect(approved.status).toBe(200);
    expect(approved.body.assessment?.recommendation.draft.note).toBe('replacement draft');
    expect(sys.store.auditTrail(disputeId).find(x => x.kind === 'approved')?.detail).toMatchObject({ recommendationRevision: refreshed.recommendationRevision });
  } finally { sys.store.close(); }
});

it('invalidates earlier approval eligibility when refreshed evidence identity fails', async () => {
  const sys = startSystem({ model: scriptedBranch('concede') });
  try {
    const { captureId } = await sellOne(sys, 'identity-refresh');
    sys.records[captureId] = [{ kind: 'not_shipped', label: 'Seller note', fact: 'Never shipped', recordedAt: '2026-10-01T00:00:00Z' }];
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    const viewed = (await sys.api('GET', `/api/cases/${disputeId}`)).body;
    const getOrder = sys.client.getOrder.bind(sys.client);
    sys.client.getOrder = async id => ({ ...await getOrder(id), id: 'WRONG' });
    await sys.api('POST', `/api/cases/${disputeId}/reassess`).catch(() => {});
    const approval = await sys.api('POST', `/api/cases/${disputeId}/approve`, { approvedBy: 'Seller', recommendationRevision: viewed.recommendationRevision });
    expect(approval.status).toBe(409);
    expect(sys.store.getCase(disputeId)?.assessment?.recommendation).toBeUndefined();
  } finally { sys.store.close(); }
});
