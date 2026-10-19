import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Case } from '../../../src/domain';
vi.mock('../api', () => ({ api: {} }));
import { ApprovalGate } from './ApprovalGate';
import { GuardPanel } from './GuardPanel';
import { RecommendationPanel } from './RecommendationPanel';

const sample = (patch: Partial<Case> = {}): Case => ({
  disputeId: 'CASE-A', status: 'approved', reason: 'NOT_RECEIVED', amount: { currency_code: 'USD', value: '48.00' },
  permittedRels: ['accept_claim'], evidence: [], guardFailures: [], recommendationRevision: 'v1', approvedBy: 'Seller', updatedAt: '2026-10-10T00:00:00Z',
  assessment: { kind: "actionable", recommendation: { action: 'concede', confidence: 'high', summary: 'No payment consequence mentioned', supports: [], contradicts: [], draft: { note: 'Model text does not name a refund' } } }, ...patch,
});
const gate = (c: Case) => renderToStaticMarkup(createElement(ApprovalGate, { c, onUpdated: () => {} }));
it('names the refund consequence using the displayed case and amount, independently of model text', () => {
  const a = gate(sample());
  expect(a).toContain('48.00 USD'); expect(a).toContain('CASE-A'); expect(a).toMatch(/buyer(?:&#x27;|')s favor/); expect(a).toMatch(/refund/i);
  const b = gate(sample({ disputeId: 'CASE-B', amount: { currency_code: 'EUR', value: '19.50' } }));
  expect(b).toContain('19.50 EUR'); expect(b).toContain('CASE-B'); expect(b).not.toContain('48.00 USD'); expect(b).not.toContain('CASE-A');
});
it('escapes case and seller text rather than generating markup', () => {
  const html = gate(sample({ disputeId: '<img src=x onerror=alert(1)>', approvedBy: '<script>bad()</script>' }));
  expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).not.toContain('<script>');
});
it.each([undefined, { currency_code: 'USD', value: 'NaN' }])('blocks execution when the case amount is missing or invalid', amount => {
  const html = gate(sample({ amount: amount as Case['amount'] }));
  expect(html).toMatch(/amount.*unavailable|invalid.*amount/i);
  expect(html).toMatch(/<button[^>]*disabled=""/);
});
it('requires human factual review and explains citation limits', () => {
  const c = sample();
  const guard = renderToStaticMarkup(createElement(GuardPanel, { c }));
  expect(guard).toMatch(/does not prove.*true/);
  const rec = renderToStaticMarkup(createElement(RecommendationPanel, { c, onUpdated: () => {}, knownIds: new Set<string>(), onHover: () => {}, onJump: () => {} }));
  expect(rec).toMatch(/Review every claim/);
});
