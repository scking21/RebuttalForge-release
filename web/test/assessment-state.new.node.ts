// New regression coverage, written for the reconstructed candidate on 2026-10-11.
// This is not a restoration of the unavailable original navigation tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as format from '../src/format.ts';
import type { Case } from '../../src/domain.ts';

const rec = { action: 'contest', confidence: 'medium', summary: 'Review', supports: [], contradicts: [], draft: { note: 'Evidence supplied' } } as const;
const sample = (patch: Partial<Case> = {}): Case => ({
  disputeId: 'CASE-A', status: 'recommended', reason: 'NOT_RECEIVED', amount: { currency_code: 'USD', value: '48.00' },
  permittedRels: ['provide_evidence'], evidence: [], guardFailures: [], recommendationRevision: 'v1', updatedAt: '2026-10-11T00:00:00Z',
  assessment: { kind: 'actionable', recommendation: structuredClone(rec) }, ...patch,
} as Case);
const helpers = format as Record<string, any>;

test('new: actionable assessment is the only source of a recommendation', () => {
  assert.equal(typeof helpers.recommendationFor, 'function', 'assessment-aware recommendation helper is missing');
  assert.equal(helpers.recommendationFor(sample())?.action, 'contest');
  assert.equal(helpers.recommendationFor(sample({ assessment: undefined })), undefined);
  const held = sample({ assessment: { kind: 'hold', reason: 'MISSING_EVIDENCE', summary: 'Need order record', evidenceIds: [], reviewerNextStep: 'Upload records and reassess' } });
  assert.equal(helpers.recommendationFor({ ...held, recommendation: rec }), undefined, 'legacy field must never override a hold');
});

test('new: hold, absent assessment, and guards block approval and execution', () => {
  assert.equal(typeof helpers.approvalBlockReason, 'function', 'assessment-aware gate is missing');
  assert.equal(helpers.approvalBlockReason(sample()), null);
  for (const assessment of [undefined, { kind: 'hold', reason: 'MISSING_EVIDENCE', summary: 'Need order record', evidenceIds: [], reviewerNextStep: 'Review records' }]) {
    const c = sample({ assessment: assessment as Case['assessment'] });
    assert.notEqual(helpers.approvalBlockReason(c), null);
    assert.notEqual(helpers.executionBlockReason({ ...c, status: 'approved' }), null);
  }
  assert.notEqual(helpers.executionBlockReason(sample({ status: 'approved', guardFailures: [{ code: 'NO_SUPPORTING_CLAIM' }] })), null);
});

test('new: durable pending and accepted states block all new response actions regardless of status', () => {
  assert.equal(typeof helpers.canReassess, 'function', 'durable reassessment gate is missing');
  for (const status of ['recommended', 'approved', 'failed'] as const) {
    for (const durable of [
      { pendingAction: { requestId: 'pending-1', revision: 'v1', at: '2026-10-11T00:00:00Z' } },
      { execution: { action: 'contest', requestId: 'accepted-1', httpStatus: 200, response: {}, at: '2026-10-11T00:00:00Z' } },
      { postExecutionReview: { reason: 'New requirement', providerStatus: 'WAITING_FOR_SELLER_RESPONSE', evidence: [], messages: [], observedAt: '2026-10-11T00:00:00Z' } },
    ]) {
      const c = sample({ status, ...durable } as Partial<Case>);
      assert.notEqual(helpers.approvalBlockReason(c), null);
      assert.notEqual(helpers.executionBlockReason(c), null);
      assert.equal(helpers.canReassess(c), false);
    }
  }
});

test('new: inbox labels distinguish held, unknown and accepted requests from case resolution', () => {
  assert.equal(typeof helpers.caseReviewLabel, 'function', 'durable review labels are missing');
  assert.equal(helpers.caseReviewLabel(sample()), 'Recommended');
  assert.equal(helpers.caseReviewLabel(sample({ assessment: { kind: 'hold', reason: 'MODEL_UNAVAILABLE', summary: 'No model', evidenceIds: [], reviewerNextStep: 'Review manually' } })), 'On hold');
  assert.equal(helpers.caseReviewLabel(sample({ pendingAction: { requestId: 'p', revision: 'v1', at: '' } })), 'Outcome unknown');
  assert.equal(helpers.caseReviewLabel(sample({ execution: { action: 'contest', requestId: 'a', httpStatus: 200, response: {}, at: '' } })), 'Request accepted');
  assert.equal(helpers.caseReviewLabel(sample({ status: 'resolved' })), 'Resolved');
});

test('new: resolved status alone does not invent approval or execution milestones', () => {
  assert.equal(typeof helpers.reachedCaseSteps, 'function', 'evidence-based progress helper is missing');
  const steps = helpers.reachedCaseSteps(sample({ status: 'resolved', assessment: undefined }));
  assert.equal(steps.has('resolved'), true);
  assert.equal(steps.has('approved'), false);
  assert.equal(steps.has('executed'), false);
  assert.equal(steps.has('recommended'), false);
});
