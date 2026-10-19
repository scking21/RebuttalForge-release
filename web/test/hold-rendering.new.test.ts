// New component regression coverage for the reconstructed candidate.
// These are server-render checks, not browser navigation or accessibility certification.
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Case, HoldReason } from '../../src/domain';
vi.mock('../src/api', () => ({ api: {} }));
import { ApprovalGate } from '../src/components/ApprovalGate';
import { RecommendationPanel } from '../src/components/RecommendationPanel';
import { GuardPanel } from '../src/components/GuardPanel';

const held = (reason: HoldReason = 'MISSING_EVIDENCE'): Case => ({
  disputeId: 'CASE-HOLD', status: 'evidence_gathered', reason: 'NOT_RECEIVED',
  amount: { currency_code: 'USD', value: '48.00' }, permittedRels: ['provide_evidence'], evidence: [], guardFailures: [],
  assessment: { kind: 'hold', reason, summary: 'Original order record missing', evidenceIds: ['E1'], reviewerNextStep: 'Review source records before the deadline' },
  updatedAt: '2026-10-11T00:00:00Z',
});
const gate = (c: Case) => renderToStaticMarkup(createElement(ApprovalGate, { c, onUpdated: () => {} }));

describe('new: hold presentation', () => {
  it.each(['MISSING_EVIDENCE', 'CONFLICTING_EVIDENCE', 'UNSUPPORTED_TRANSACTION', 'UNSUPPORTED_RESPONSE', 'STALE_APPROVAL', 'MODEL_UNAVAILABLE'] as HoldReason[])('explains %s and omits draft and approval controls', reason => {
    const c = held(reason);
    const panel = renderToStaticMarkup(createElement(RecommendationPanel, { c, onUpdated: () => {}, knownIds: new Set(['E1']), onHover: () => {}, onJump: () => {} }));
    expect(panel).toContain('Original order record missing');
    expect(panel).toContain('Review source records before the deadline');
    expect(panel).toContain('aria-label="Evidence E1"');
    expect(panel).not.toContain('Draft note');
    expect(gate(c)).not.toContain('<form');
    expect(gate({ ...c, status: 'approved' })).not.toContain('Execute on PayPal');
    expect(renderToStaticMarkup(createElement(GuardPanel, { c }))).toContain('on hold');
  });
  it('shows unknown request correlation and never offers another action', () => {
    const c = { ...held(), status: 'failed', pendingAction: { requestId: 'request-unknown', revision: 'r1', at: '2026-10-11T00:00:00Z' } } as Case;
    expect(gate(c)).toContain('request-unknown');
    expect(gate(c)).toContain('Do not retry');
    expect(gate(c)).not.toContain('<form');
    expect(gate(c)).not.toContain('<button');
  });
  it('does not infer a sent request or approval from resolved status alone', () => {
    const html = gate({ ...held(), status: 'resolved' });
    expect(html).toContain('No acknowledged request');
    expect(html).not.toContain('Approved by');
    expect(html).not.toContain('Ready to send');
  });
});


it('shows resolved outcome independently of an application execution receipt', () => {
  const html = gate({ ...held(), status: 'resolved', outcome: 'RESOLVED_SELLER_FAVOUR' });
  expect(html).toContain('Dispute resolved: RESOLVED_SELLER_FAVOUR');
  expect(html).toContain('No acknowledged request');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('<form');
  expect(html).not.toContain('request accepted;');
});

it('labels a resolved case with missing outcome details without inventing an outcome', () => {
  expect(gate({ ...held(), status: 'resolved' })).toContain('Dispute resolved; outcome details unavailable');
});

it('preserves pending request uncertainty ahead of a later resolved case status', () => {
  const html = gate({ ...held(), status: 'resolved', outcome: 'RESOLVED_BUYER_FAVOUR', pendingAction: { requestId: 'pending-1', revision: 'r1', at: '2026-10-11T00:00:00Z' } });
  expect(html).toContain('Outcome not established; manual reconciliation required');
  expect(html).toContain('Do not retry.');
  expect(html).not.toContain('Dispute resolved:');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('<form');
});

it('retains a static evidence focus-visible outline after the transient highlight rule', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const focus = css.match(/\.ev:focus-visible\s*\{([^}]+)\}/);
  expect(focus).not.toBeNull();
  expect(focus![1]).toContain('outline: 3px solid var(--ink)');
  expect(css.indexOf('.ev:focus-visible')).toBeGreaterThan(css.indexOf('.ev:focus {'));
});


it.each(['recommended', 'approved', 'failed'] as const)('uses state-neutral draft wording for %s', status => {
  const c: Case = { ...held(), status, assessment: { kind: 'actionable', recommendation: { action: 'concede', confidence: 'high', summary: 'Synthetic', supports: [], contradicts: [], draft: { note: 'Synthetic draft' } } }, ...(status === 'failed' ? { pendingAction: { requestId: 'unknown', revision: 'r1', at: '2026-10-11T00:00:00Z' } } : {}) };
  const html = renderToStaticMarkup(createElement(RecommendationPanel, { c, onUpdated: () => {}, knownIds: new Set<string>(), onHover: () => {}, onJump: () => {} }));
  expect(html).toContain('Draft note for PayPal, verbatim');
  expect(html).not.toContain('Draft note sent to PayPal');
});
