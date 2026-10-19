// New in-memory fixture contract checks. No provider requests are made.
import assert from 'node:assert/strict';
import { test } from 'node:test';
(globalThis as any).window = { location: { search: '?fixtures' } };
const { fixtureBackend: backend } = await import('../src/dev-fixtures.ts');

test('aligned: scripted copy does not invent model decisions, address matches or attachments', async () => {
  const c = (await backend.caseDetail('PP-D-10482')).case;
  assert.equal(c.assessment?.kind, 'actionable');
  if (c.assessment?.kind !== 'actionable') throw new Error('Expected scripted actionable fixture');
  const r = c.assessment.recommendation;
  assert.match(r.summary, /Scripted interface example, not a current model decision/);
  assert.match(r.summary, /gives no delivery address/);
  assert.match(r.supports[1].text, /does not provide a delivery address to compare/);
  assert.match(r.contradicts[0].text, /record does not identify the signer/);
  assert.match(r.draft.note, /^If approved, we propose submitting/);
  assert.match(r.draft.note, /No scan attachment is included/);
  assert.doesNotMatch(r.draft.note, /scan is attached|delivered .* to the address on the order/);
  assert.equal(c.approvedBy, undefined); assert.equal(c.execution, undefined);
});

test('aligned: unsupported-response hold matches its credit-not-processed fixture and evidence URL', async () => {
  const c = (await backend.caseDetail('PP-D-HOLD')).case;
  assert.equal(c.reason, 'CREDIT_NOT_PROCESSED');
  assert.deepEqual(c.assessment, { kind: 'hold', reason: 'UNSUPPORTED_RESPONSE', summary: 'This app only assesses item-not-received disputes.', evidenceIds: [], reviewerNextStep: 'Review this dispute and its response requirements directly in PayPal before the displayed deadline.' });
  assert.equal(c.evidence.find((e) => e.id === 'E1')?.ref, 'GET /v1/customer/disputes/PP-D-HOLD');
  assert.equal(c.recommendationRevision, undefined);
  await assert.rejects(backend.approve(c.disputeId, 'Synthetic reviewer', 'any'), /On hold/);
  await assert.rejects(backend.execute(c.disputeId), /on hold/);
});

test('new: fixture holds are readable and cannot approve or execute', async () => {
  const c = (await backend.caseDetail('PP-D-HOLD')).case;
  assert.equal(c.assessment?.kind, 'hold');
  assert.equal(c.recommendationRevision, undefined);
  await assert.rejects(backend.approve(c.disputeId, 'Seller', 'wrong'), /On hold/);
  await assert.rejects(backend.execute(c.disputeId), /on hold/);
  const refreshed = await backend.reassess(c.disputeId);
  assert.equal(refreshed.assessment?.kind, 'hold');
  assert.equal(refreshed.recommendationRevision, undefined);
});

test('new: fixture unknown and accepted outcomes survive reload and prohibit another response', async () => {
  for (const id of ['PP-D-UNKNOWN', 'PP-D-ACCEPTED']) {
    const c = (await backend.caseDetail(id)).case;
    assert.ok(c.pendingAction || c.execution);
    await assert.rejects(backend.approve(id, 'Seller', c.recommendationRevision!), /outcome|acknowledged/);
    await assert.rejects(backend.execute(id), /outcome|acknowledged/);
    await assert.rejects(backend.reassess(id), /cannot be reassessed/);
    const reloaded = (await backend.caseDetail(id)).case;
    assert.deepEqual(reloaded.pendingAction, c.pendingAction);
    assert.deepEqual(reloaded.execution, c.execution);
  }
});

test('new: fixture actionable assessment requires current revision and sends once after approval', async () => {
  const c = (await backend.caseDetail('PP-D-10482')).case;
  assert.equal(c.assessment?.kind, 'actionable');
  await assert.rejects(backend.execute(c.disputeId), /approval/);
  await assert.rejects(backend.approve(c.disputeId, 'Seller', 'obsolete'), /current recommendation/);
  const approved = await backend.approve(c.disputeId, 'Seller', c.recommendationRevision!);
  assert.equal(approved.approvedSnapshot?.revision, c.recommendationRevision);
  const sent = await backend.execute(c.disputeId);
  assert.equal(sent.execution?.httpStatus, 200);
  await assert.rejects(backend.execute(c.disputeId), /acknowledged/);
});
