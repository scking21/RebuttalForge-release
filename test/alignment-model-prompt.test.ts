import { expect, it, vi } from 'vitest';
import { AnthropicModel, SYSTEM_PROMPT, type ModelInput } from '../src/agent/model.js';
const input: ModelInput = {
  dispute: { disputeId: 'SYNTHETIC-ALIGNMENT', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', stage: 'INQUIRY', status: 'OPEN', amount: { currency_code: 'USD', value: '84.50' } },
  evidence: [], permittedActions: ['contest'],
};
it('passes the conditional-draft and conflict-hold rules in the actual mocked model request', async () => {
  const hold = { kind: 'hold', reason: 'CONFLICTING_EVIDENCE', summary: 'Synthetic conflict.', evidenceIds: [], reviewerNextStep: 'Review the records.' };
  const parse = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', parsed_output: hold });
  const model = new AnthropicModel({ apiKey: 'unused-synthetic-test-key', client: { messages: { parse } } as never });
  expect(await model.recommend(input)).toEqual(hold);
  expect(parse).toHaveBeenCalledOnce();
  expect(parse.mock.calls[0]![0].system).toBe(SYSTEM_PROMPT);
  expect(SYSTEM_PROMPT).toContain('For unresolved conflicting evidence return kind="hold", reason="CONFLICTING_EVIDENCE"');
  expect(SYSTEM_PROMPT).toContain('Use conditional language such as "If approved, we propose submitting ..."');
  expect(SYSTEM_PROMPT).toContain('Never claim that evidence was attached, submitted or sent');
  expect(SYSTEM_PROMPT).toContain('Do not invent attachments, delivery addresses, address matches or signer identities.');
  expect(SYSTEM_PROMPT).toContain('not independently verified carrier facts');
});
it('still rejects malformed structured assessments with the amended prompt', async () => {
  const parse = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', parsed_output: { kind: 'hold', reason: 'UNRECOGNIZED' } });
  const model = new AnthropicModel({ apiKey: 'unused-synthetic-test-key', client: { messages: { parse } } as never });
  await expect(model.recommend(input)).rejects.toThrow('invalid assessment');
});
