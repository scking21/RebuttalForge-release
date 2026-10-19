import Anthropic from '@anthropic-ai/sdk';
import { expect, it } from 'vitest';
import { AnthropicModel, type ModelInput } from '../src/agent/model.js';
import { startSystem, sellOne, buyerOpensDispute } from './support/system.js';

// Real installed SDK, raw synthetic HTTP response, no external fetch or credentials.
const input: ModelInput = {
  dispute: { disputeId: 'SYNTHETIC', reason: 'NOT_RECEIVED', stage: 'INQUIRY', status: 'OPEN', amount: { currency_code: 'USD', value: '48.00' } },
  evidence: [], permittedActions: ['concede'],
};
const hold = { kind: 'hold', reason: 'MISSING_EVIDENCE', summary: 'Original records missing.', evidenceIds: [], reviewerNextStep: 'Review source records.' };
const actionable = { kind: 'actionable', recommendation: { action: 'concede', confidence: 'high', summary: 'Synthetic example.', supports: [], contradicts: [], draft: { note: 'Synthetic note' } } };
function rawModel(text: string | undefined, stopReason = 'end_turn') {
  let calls = 0;
  const client = new Anthropic({ apiKey: 'synthetic-test-key', maxRetries: 0, fetch: async () => {
    calls++;
    return Response.json({ id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: text === undefined ? [] : [{ type: 'text', text }], stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  return { model: new AnthropicModel({ apiKey: 'synthetic-test-key', client }), calls: () => calls };
}

for (const assessment of [hold, actionable]) {
  it(`parses valid ${assessment.kind} through the real installed SDK and original schema`, async () => {
    const sample = rawModel(JSON.stringify(assessment));
    expect(await sample.model.recommend(input)).toEqual(assessment);
    expect(sample.calls()).toBe(1);
  });
}

const failures = [
  { name: 'ordinary-text refusal', text: 'I cannot provide that response.', stop: 'refusal' },
  { name: 'truncated JSON', text: '{"kind":"actionable",', stop: 'max_tokens' },
  { name: 'malformed JSON', text: 'not JSON', stop: 'end_turn' },
  { name: 'schema-invalid discriminator', text: JSON.stringify({ ...hold, kind: 'unrecognized' }), stop: 'end_turn' },
  { name: 'no text', text: undefined, stop: 'end_turn' },
];
for (const fixture of failures) {
  it(`rejects ${fixture.name} via the real SDK and keeps downstream case on hold`, async () => {
    const sample = rawModel(fixture.text, fixture.stop);
    await expect(sample.model.recommend(input)).rejects.toBeInstanceOf(Error);
    const sys = startSystem({ model: sample.model });
    try {
      const { captureId } = await sellOne(sys, 'sdk-failure');
      sys.records[captureId] = [{ kind: 'not_shipped', label: 'Synthetic statement', fact: 'Never shipped', recordedAt: '2026-10-01T00:00:00Z' }];
      const { disputeId } = await buyerOpensDispute(sys, captureId);
      const c = sys.store.getCase(disputeId)!;
      expect(c.assessment).toMatchObject({ kind: 'hold', reason: 'MODEL_UNAVAILABLE' });
      expect(c.approvedSnapshot).toBeUndefined();
      const providerCallsBeforeActions = [...sys.fetchCalls];
      const approval = await sys.api('POST', `/api/cases/${disputeId}/approve`, { approvedBy: 'Synthetic reviewer' });
      expect(approval).toMatchObject({ status: 409, body: { error: 'not_approvable' } });
      const execution = await sys.api('POST', `/api/cases/${disputeId}/execute`);
      expect(execution).toMatchObject({ status: 409, body: { error: 'not_executable' } });
      expect(sys.fetchCalls).toEqual(providerCallsBeforeActions);
      expect(sys.sim.state.actionLog).toEqual([]);
      expect(sample.calls()).toBe(2);
    } finally { await sys.sim.flushDeliveries(); sys.store.close(); }
  });
}
