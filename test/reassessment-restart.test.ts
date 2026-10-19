import { OPERATOR_REQUEST_HEADERS } from "../src/request-integrity.js";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scriptedBranch } from '../src/agent/test-double.js';
import { startSystem, sellOne, buyerOpensDispute } from './support/system.js';
import { assess } from '../src/pipeline.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

it.each(['before evidence', 'after evidence', 'legacy after evidence'])('invalidates approval durably when interrupted %s and safely recovers', async phase => {
  const sys = startSystem({ model: scriptedBranch('concede') });
  const dir = mkdtempSync(join(tmpdir(), 'dd-restart-')); const path = join(dir, 'case.sqlite');
  let durable = new Store(path);
  try {
    const { captureId } = await sellOne(sys, 'restart');
    sys.records[captureId] = [{ kind: 'not_shipped', label: 'Seller note', fact: 'Never shipped', recordedAt: '2026-10-01T00:00:00Z' }];
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    const reviewed = sys.store.getCase(disputeId)!;
    if (phase.startsWith('legacy')) reviewed.recommendationRevision = undefined;
    durable.saveCase({ ...reviewed, status: 'received' });
    durable.transition(disputeId, 'evidence_gathered'); durable.transition(disputeId, 'recommended');
    durable.audit(disputeId, 'reviewed.before.restart', { amount: reviewed.amount });
    const get = sys.client.getDispute.bind(sys.client);
    let entered!: () => void; const paused = new Promise<void>(r => entered = r);
    const never = () => new Promise<never>(() => {});
    sys.client.getDispute = async id => {
      if (phase === 'before evidence') { entered(); return never(); }
      return { ...await get(id), dispute_amount: { currency_code: 'USD', value: '49.00' } };
    };
    void assess({ client: sys.client, store: durable, sellerRecords: id => sys.records[id] ?? [], now: () => new Date(), model: { recommend: async () => { entered(); return never(); } } }, disputeId);
    await paused;
    durable.close(); durable = new Store(path);
    const interrupted = durable.getCase(disputeId)!;
    expect(interrupted.recommendationRevision).toBeUndefined();
    expect(interrupted.assessment?.recommendation).toBeUndefined();
    expect(interrupted.status).not.toBe('recommended');
    expect(interrupted.amount.value).toBe(phase === 'before evidence' ? '48.00' : '49.00');
    sys.client.getDispute = get;
    const app = createApp({ client: sys.client, store: durable, model: scriptedBranch('concede'), sellerRecords: id => sys.records[id] ?? [] });
    const post = (suffix: string, body = {}) => app.request(`/api/cases/${disputeId}/${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR_REQUEST_HEADERS }, body: JSON.stringify(body) });
    sys.fetchCalls.length = 0;
    expect((await post('approve', { approvedBy: 'Seller', recommendationRevision: reviewed.recommendationRevision })).status).toBe(409);
    expect((await post('execute')).status).toBe(409);
    expect(sys.fetchCalls.filter(x => x.startsWith('POST'))).toEqual([]);
    const refreshed = await (await post('reassess')).json();
    expect((await post('execute')).status).toBe(409);
    expect((await post('approve', { approvedBy: 'Seller', recommendationRevision: refreshed.recommendationRevision })).status).toBe(200);
    expect((await post('execute')).status).toBe(200);
    expect((await post('execute')).status).toBe(200);
    expect(sys.fetchCalls.filter(x => x.endsWith('/accept-claim'))).toHaveLength(1);
    expect(durable.auditTrail(disputeId).some(x => x.kind === 'reviewed.before.restart')).toBe(true);
  } finally { durable.close(); sys.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(['gather rejection', 'model rejection', 'queued approval'])('keeps durable safe state after %s', async phase => {
  const sys = startSystem({ model: scriptedBranch('concede') });
  const dir = mkdtempSync(join(tmpdir(), 'dd-failure-')); const path = join(dir, 'case.sqlite');
  let durable = new Store(path);
  try {
    const { captureId } = await sellOne(sys, 'restart-failure');
    sys.records[captureId] = [{ kind: 'not_shipped', label: 'Seller note', fact: 'Never shipped', recordedAt: '2026-10-01T00:00:00Z' }];
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    const reviewed = sys.store.getCase(disputeId)!;
    durable.saveCase({ ...reviewed, status: 'received' });
    durable.transition(disputeId, 'evidence_gathered'); durable.transition(disputeId, 'recommended');
    let entered!: () => void; const paused = new Promise<void>(r => entered = r);
    let release!: () => void; const resume = new Promise<void>(r => release = r);
    const base = scriptedBranch('concede');
    const model = { recommend: async (input: Parameters<typeof base.recommend>[0]) => {
      if (phase === 'model rejection') throw new Error('model failed');
      if (phase === 'queued approval') { entered(); await resume; }
      return base.recommend(input);
    } };
    if (phase === 'gather rejection') sys.client.getDispute = async () => { throw new Error('fetch failed'); };
    const app = createApp({ client: sys.client, store: durable, model, sellerRecords: id => sys.records[id] ?? [] });
    const post = (suffix: string, body = {}) => app.request(`/api/cases/${disputeId}/${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR_REQUEST_HEADERS }, body: JSON.stringify(body) });
    const reassessing = post('reassess');
    if (phase === 'queued approval') {
      await paused;
      const pendingApproval = post('approve', { approvedBy: 'Seller', recommendationRevision: reviewed.recommendationRevision });
      release(); await reassessing;
      expect((await pendingApproval).status).toBe(409);
    } else await reassessing;
    durable.close(); durable = new Store(path);
    const recovered = durable.getCase(disputeId)!;
    expect(recovered.recommendationRevision).not.toBe(reviewed.recommendationRevision);
    expect(recovered.approvedSnapshot).toBeUndefined();
    expect(recovered.status).toBe(phase === 'queued approval' ? 'recommended' : phase === 'gather rejection' ? 'failed' : 'evidence_gathered');
    if (phase !== 'queued approval') expect(recovered.assessment?.recommendation).toBeUndefined();
    expect(durable.auditTrail(disputeId).some(x => x.kind === 'assessment.started')).toBe(true);
  } finally { durable.close(); sys.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
