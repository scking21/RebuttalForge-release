// @vitest-environment jsdom
// Synthetic DOM interaction coverage, not browser/screen-reader certification.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Case } from '../../src/domain';
import { snapshotForCase } from '../../src/approval';
const calls = vi.hoisted(() => ({ approve: vi.fn(), execute: vi.fn() }));
vi.mock('../src/api', () => ({ api: calls }));
import { ApprovalGate } from '../src/components/ApprovalGate';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.clearAllMocks(); });
const recommended = (): Case => ({
  disputeId: 'DOM-SYNTHETIC', status: 'recommended', reason: 'NOT_RECEIVED', amount: { currency_code: 'USD', value: '48.00' },
  decisionFacts: { disputeId: 'DOM-SYNTHETIC', captureId: 'SYNTHETIC-CAPTURE', currency: 'USD', amountMinor: '4800', reason: 'NOT_RECEIVED', stage: 'INQUIRY', deadline: null, providerContextHash: 'synthetic-hash' },
  permittedRels: ['accept_claim'], evidence: [], guardFailures: [], recommendationRevision: 'dom-revision', updatedAt: '2026-10-11T00:00:00Z',
  assessment: { kind: 'actionable', recommendation: { action: 'concede', confidence: 'high', summary: 'Synthetic', supports: [], contradicts: [], draft: { note: 'Synthetic draft' } } },
});
function mount(initial: Case) {
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  let current = initial;
  const render = (c: Case) => { current = c; root!.render(createElement(ApprovalGate, { c, onUpdated: render })); };
  return { container, render, current: () => current };
}

it('user approval focuses a non-action confirmation, does not execute, and polling does not refocus', async () => {
  const c = recommended();
  const approved: Case = { ...c, status: 'approved', approvedBy: 'Synthetic reviewer', approvedSnapshot: snapshotForCase(c) };
  calls.approve.mockResolvedValue(approved);
  const view = mount(c); await act(async () => view.render(c));
  const input = view.container.querySelector('input')!;
  input.focus();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Synthetic reviewer');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => view.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(calls.approve).toHaveBeenCalledExactlyOnceWith('DOM-SYNTHETIC', 'Synthetic reviewer', 'dom-revision');
  expect(calls.execute).not.toHaveBeenCalled();
  const confirmation = [...view.container.querySelectorAll('[role="status"]')].find(node => node.textContent === 'Approved; nothing sent to PayPal yet') as HTMLElement;
  expect(confirmation).toBeDefined();
  expect(document.activeElement).toBe(confirmation);
  expect(confirmation.tagName).toBe('P');
  expect(confirmation.getAttribute('aria-live')).toBe('polite');
  const elsewhere = document.createElement('button'); elsewhere.textContent = 'Other review'; document.body.append(elsewhere); elsewhere.focus();
  await act(async () => view.render({ ...view.current(), updatedAt: '2026-10-11T00:00:01Z' }));
  expect(document.activeElement).toBe(elsewhere);
  expect(calls.execute).not.toHaveBeenCalled();
});

it('an already approved case arriving from polling does not steal focus or announce a new approval', async () => {
  const c = recommended(); const approved: Case = { ...c, status: 'approved', approvedBy: 'Synthetic', approvedSnapshot: snapshotForCase(c) };
  const elsewhere = document.createElement('button'); document.body.append(elsewhere); elsewhere.focus();
  const view = mount(approved); await act(async () => view.render(approved));
  expect(document.activeElement).toBe(elsewhere);
  expect(view.container.textContent).not.toContain('Approved; nothing sent to PayPal yet');
  expect(calls.approve).not.toHaveBeenCalled();
  expect(calls.execute).not.toHaveBeenCalled();
});

it('removes nothing-sent confirmation on an attempted send and keeps unknown failures latched', async () => {
  const c = recommended();
  calls.approve.mockResolvedValue({ ...c, status: 'approved', approvedBy: 'Synthetic reviewer', approvedSnapshot: snapshotForCase(c) });
  let rejectSend!: (reason: Error) => void;
  calls.execute.mockImplementation(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
  const view = mount(c); await act(async () => view.render(c));
  const input = view.container.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Synthetic reviewer');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => view.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(view.container.textContent).toContain('Approved; nothing sent to PayPal yet');
  const send = [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Accept claim and refund'))!;
  await act(async () => send.click());
  expect(calls.execute).toHaveBeenCalledTimes(1);
  expect(view.container.textContent).not.toContain('Approved; nothing sent to PayPal yet');
  await act(async () => rejectSend(new Error('Synthetic unknown response')));
  expect(view.container.textContent).not.toContain('Approved; nothing sent to PayPal yet');
  expect(view.container.textContent).toContain('Execution was not confirmed');
  expect(view.container.textContent).toContain('Refresh the case');
  await act(async () => { send.click(); view.render({ ...view.current() }); });
  expect(calls.execute).toHaveBeenCalledTimes(1);
  expect(send.disabled).toBe(true);
});
