import { OPERATOR_REQUEST_HEADERS } from "../src/request-integrity.js";
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { snapshotForCase } from '../src/approval.js';
import { scriptedBranch } from '../src/agent/test-double.js';
import { startSystem, sellOne, buyerOpensDispute } from './support/system.js';

async function setup() {
  const sys = startSystem({ model: scriptedBranch('concede') });
  const { captureId } = await sellOne(sys, 'parallel-api');
  sys.records[captureId] = [{ kind: 'not_shipped', label: 'Synthetic seller statement', fact: 'Never shipped', recordedAt: '2026-10-01T00:00:00Z' }];
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  const directory = mkdtempSync(join(tmpdir(), 'dd-parallel-api-'));
  const file = join(directory, 'cases.sqlite');
  const first = new Store(file);
  const second = new Store(file);
  first.saveCase({ ...sys.store.getCase(disputeId)!, status: 'received' });
  first.transition(disputeId, 'evidence_gathered');
  const recommendation = first.transition(disputeId, 'recommended');
  first.transition(disputeId, 'approved', { approvedBy: 'Synthetic reviewer', approvedSnapshot: snapshotForCase(recommendation) });
  const app = (store: Store) => createApp({ client: sys.client, store, model: scriptedBranch('concede'), sellerRecords: id => sys.records[id] ?? [] });
  const firstApp = app(first);
  const secondApp = app(second);
  const execute = (which = firstApp) => which.request(`/api/cases/${disputeId}/execute`, { method: 'POST', headers: OPERATOR_REQUEST_HEADERS });
  const close = async () => { await sys.sim.flushDeliveries(); first.close(); second.close(); sys.store.close(); rmSync(directory, { recursive: true }); };
  return { ...sys, disputeId, first, second, firstApp, secondApp, execute, app, file, close };
}

it('two independent API instances sharing SQLite dispatch only one approved action', async () => {
  const s = await setup();
  try {
    const read = s.client.getDispute.bind(s.client);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.client.getDispute = async id => {
      const result = await read(id);
      if (++reads <= 2) { if (reads === 2) release(); await gate; }
      return result;
    };
    const responses = await Promise.all([s.execute(), s.execute(s.secondApp)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(s.sim.state.actionLog.filter(action => action.rel === 'accept_claim')).toHaveLength(1);
    expect(s.first.auditTrail(s.disputeId).filter(event => event.kind === 'paypal.action.pending')).toHaveLength(1);
    expect(s.first.auditTrail(s.disputeId).filter(event => event.kind === 'paypal.action')).toHaveLength(1);
    expect(s.first.getCase(s.disputeId)?.pendingAction).toBeUndefined();
    expect(s.first.getCase(s.disputeId)?.execution?.action).toBe('concede');
  } finally { await s.close(); }
});

it('persists acknowledgement if another instance records resolution before the action reply arrives', async () => {
  const s = await setup();
  try {
    const accept = s.client.acceptClaim.bind(s.client);
    s.client.acceptClaim = async (...args) => {
      const result = await accept(...args);
      s.second.transition(s.disputeId, 'resolved', { outcome: 'SYNTHETIC_EARLY_RESOLUTION' });
      return result;
    };
    const response = await s.execute();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'resolved', outcome: 'SYNTHETIC_EARLY_RESOLUTION', execution: { action: 'concede', httpStatus: 200 } });
    expect(s.first.getCase(s.disputeId)?.pendingAction).toBeUndefined();
    expect((await s.execute(s.secondApp)).status).toBe(200);
    expect(s.sim.state.actionLog.filter(action => action.rel === 'accept_claim')).toHaveLength(1);
  } finally { await s.close(); }
});

it('an accepted-but-unacknowledged synthetic action stays blocked across a second API and restart', async () => {
  const s = await setup();
  try {
    const accept = s.client.acceptClaim.bind(s.client);
    s.client.acceptClaim = async (...args) => { await accept(...args); throw new TypeError('Synthetic connection ended before acknowledgement'); };
    expect((await s.execute()).status).toBe(502);
    expect((await s.execute(s.secondApp)).status).toBe(409);
    expect(s.first.getCase(s.disputeId)?.pendingAction?.requestId).toMatch(/^dd-/);
    const restarted = new Store(s.file);
    try {
      const app = s.app(restarted);
      expect((await s.execute(app)).status).toBe(409);
      expect((await app.request(`/api/cases/${s.disputeId}/reassess`, { method: 'POST', headers: OPERATOR_REQUEST_HEADERS })).status).toBe(409);
      expect(restarted.getCase(s.disputeId)?.pendingAction?.requestId).toMatch(/^dd-/);
    } finally { restarted.close(); }
    expect(s.sim.state.actionLog.filter(action => action.rel === 'accept_claim')).toHaveLength(1);
  } finally { await s.close(); }
});
