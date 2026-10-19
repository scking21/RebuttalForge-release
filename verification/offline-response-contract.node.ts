import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkResponsePolicy } from '../src/response-policy.js';
import type { Recommendation } from '../src/domain.js';

const contest = (carrierName: string): Recommendation => ({
  action: 'contest', confidence: 'low', summary: 'Synthetic contract fixture',
  supports: [{ text: 'Seller record provides tracking', evidenceIds: ['E1'] }], contradicts: [],
  draft: { note: 'Seller record states tracking was submitted.', evidenceType: 'PROOF_OF_FULFILLMENT', tracking: { carrierName, trackingNumber: '1Z-OFFLINE' } },
});
const policy = { status: 'WAITING_FOR_SELLER_RESPONSE', requestedEvidence: [], unclassifiedEvidence: [], offerTypes: null, acceptClaimTypes: null };

for (const carrier of ['OTHER', 'other', ' OTHER ']) {
  test(`carrier ${JSON.stringify(carrier)} requires manual review because carrier_name_other is unsupported`, () => {
    const failures = checkResponsePolicy(contest(carrier), policy);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.code, 'MANUAL_EVIDENCE_REVIEW');
    assert.match('reason' in failures[0]! ? failures[0].reason : '', /carrier_name_other/);
  });
}

test('ordinary carrier contract fixture keeps its existing policy result', () => {
  assert.deepEqual(checkResponsePolicy(contest('UPS'), policy), []);
});
