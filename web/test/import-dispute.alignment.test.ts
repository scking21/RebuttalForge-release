// @vitest-environment jsdom
// Synthetic DOM/API mocks only; no provider calls.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Case } from '../../src/domain';
const calls = vi.hoisted(() => ({ reassess: vi.fn(), approve: vi.fn(), execute: vi.fn() }));
vi.mock('../src/api', () => ({ api: calls }));
import { ImportDispute } from '../src/components/ImportDispute';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.clearAllMocks(); });
async function mount(fixtures = false) {
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const onImported = vi.fn();
  await act(async () => root!.render(createElement(ImportDispute, { fixtures, onImported })));
  return { container, onImported };
}
async function input(container: HTMLElement, value: string) {
  const field = container.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
function submit(container: HTMLElement) { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
const held = { disputeId: 'CASE-ALIGNED', status: 'evidence_gathered', assessment: { kind: 'hold' } } as Case;
it('hides the importer in fixture mode', async () => {
  const view = await mount(true); expect(view.container.textContent).toBe(''); expect(view.container.querySelector('form')).toBeNull(); expect(calls.reassess).not.toHaveBeenCalled();
});
it('rejects empty and whitespace-only IDs without requests', async () => {
  const view = await mount(); expect(view.container.querySelector('button')!.disabled).toBe(true);
  await input(view.container, '   '); await act(async () => submit(view.container));
  expect(calls.reassess).not.toHaveBeenCalled(); expect(view.onImported).not.toHaveBeenCalled();
});
it('trims IDs, limits refresh to one in-flight call and never approves or executes', async () => {
  let finish!: (c: Case) => void;
  calls.reassess.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = await mount(); await input(view.container, '  CASE-ALIGNED  ');
  await act(async () => { submit(view.container); submit(view.container); });
  expect(calls.reassess).toHaveBeenCalledExactlyOnceWith('CASE-ALIGNED'); expect(view.container.querySelector('button')!.disabled).toBe(true);
  await act(async () => finish(held));
  expect(view.onImported).toHaveBeenCalledExactlyOnceWith(held); expect(view.container.querySelector('input')!.value).toBe('');
  expect(calls.approve).not.toHaveBeenCalled(); expect(calls.execute).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain('Changed facts can invalidate an earlier approval.');
  expect(view.container.textContent).toContain('This does not approve or send a response.');
});
it('shows a refresh failure, retains the ID and allows a later retry', async () => {
  calls.reassess.mockRejectedValueOnce(new Error('Synthetic response unavailable')).mockResolvedValueOnce(held);
  const view = await mount(); await input(view.container, 'CASE-ALIGNED'); await act(async () => submit(view.container));
  expect(view.container.textContent).toContain('Import or refresh failed'); expect(view.container.textContent).toContain('Synthetic response unavailable');
  expect(view.container.querySelector('input')!.value).toBe('CASE-ALIGNED'); expect(view.onImported).not.toHaveBeenCalled();
  await act(async () => submit(view.container)); expect(calls.reassess).toHaveBeenCalledTimes(2); expect(view.onImported).toHaveBeenCalledOnce();
  expect(calls.approve).not.toHaveBeenCalled(); expect(calls.execute).not.toHaveBeenCalled();
});
