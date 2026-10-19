import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../src/paypal/client.ts', import.meta.url), 'utf8');
const captureMethod = source.match(/^  async captureOrder\([^]*?^  }/m)?.[0];
assert.ok(captureMethod, 'Cannot locate exact captureOrder method for isolated contract check');
const isolated = stripTypeScriptTypes(`class AdapterMethod {\n${captureMethod}\n}`, { mode: 'transform' });
const AdapterMethod = new Function('OrderSchema', 'seg', `${isolated}; return AdapterMethod;`)(Object.freeze({ fixtureSchema: true }), encodeURIComponent);

function adapter(capture: unknown, order: unknown) {
  const instance = new AdapterMethod();
  const calls: { method: string; path: string; options?: unknown }[] = [];
  instance.call = async (method: string, path: string, _schema: unknown, options: unknown) => {
    calls.push({ method, path, options });
    return { data: capture };
  };
  instance.getOrder = async (id: string) => { calls.push({ method: 'GET', path: `/v2/checkout/orders/${id}` }); return order; };
  return { instance, calls };
}

const full = { id: 'ORDER-1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE-1' }] } }] };

test('documented minimal capture response leads to one read-only detail lookup, never another capture POST', async () => {
  const { instance, calls } = adapter({ id: 'ORDER-1', status: 'COMPLETED', purchase_units: [] }, full);
  assert.deepEqual(await instance.captureOrder('ORDER-1', 'CAPTURE-REQUEST-1'), full);
  assert.deepEqual(calls.map(x => `${x.method} ${x.path}`), ['POST /v2/checkout/orders/ORDER-1/capture', 'GET /v2/checkout/orders/ORDER-1']);
});

test('complete capture representation needs no redundant detail read', async () => {
  const { instance, calls } = adapter(full, undefined);
  assert.deepEqual(await instance.captureOrder('ORDER-1', 'CAPTURE-REQUEST-1'), full);
  assert.equal(calls.length, 1);
});

test('capture detail lookup that still lacks capture identity is explicitly incomplete without a repeat POST', async () => {
  const minimal = { id: 'ORDER-1', status: 'COMPLETED', purchase_units: [] };
  const { instance, calls } = adapter(minimal, minimal);
  await assert.rejects(instance.captureOrder('ORDER-1', 'CAPTURE-REQUEST-1'), /acknowledged.*capture.*unavailable|capture.*identity.*unavailable/i);
  assert.equal(calls.filter(x => x.method === 'POST').length, 1);
});

for (const where of ['capture', 'detail']) {
  test(`rejects mismatched order identity in ${where} response`, async () => {
    const { instance } = where === 'capture'
      ? adapter({ ...full, id: 'WRONG' }, full)
      : adapter({ id: 'ORDER-1', status: 'COMPLETED', purchase_units: [] }, { ...full, id: 'WRONG' });
    await assert.rejects(instance.captureOrder('ORDER-1', 'CAPTURE-REQUEST-1'), /order identity mismatch/i);
  });
}

const offerMethod = source.match(/^  makeOffer\([^]*?^  }/m)?.[0];
assert.ok(offerMethod, 'Cannot locate exact makeOffer method for isolated contract check');
const isolatedOffer = stripTypeScriptTypes(`class OfferMethod {\n${offerMethod}\n}`, { mode: 'transform' });
const OfferMethod = new Function(`${isolatedOffer}; return OfferMethod;`)();

for (const offerType of ['REFUND_WITH_RETURN', 'REFUND_WITH_REPLACEMENT', 'REPLACEMENT_WITHOUT_REFUND']) {
  test(`unsupported offer ${offerType} is rejected before dispatch`, () => {
    const instance = new OfferMethod();
    let dispatches = 0;
    instance.disputeAction = () => { dispatches++; return Promise.resolve({ httpStatus: 200 }); };
    assert.throws(() => instance.makeOffer('D-OFFLINE', { note: 'Synthetic', offerType, amount: { value: '10.00', currency_code: 'USD' } }, 'R-OFFLINE'), /only.*REFUND|unsupported.*offer/i);
    assert.equal(dispatches, 0);
  });
}

test('supported REFUND offer keeps amount and request identity', async () => {
  const instance = new OfferMethod();
  let dispatched: unknown[] | undefined;
  instance.disputeAction = (...args: unknown[]) => { dispatched = args; return Promise.resolve({ httpStatus: 200 }); };
  await instance.makeOffer('D-OFFLINE', { note: 'Synthetic', offerType: 'REFUND', amount: { value: '10.00', currency_code: 'USD' } }, 'R-OFFLINE');
  assert.deepEqual(dispatched, ['D-OFFLINE', 'make-offer', { json: { note: 'Synthetic', offer_type: 'REFUND', offer_amount: { value: '10.00', currency_code: 'USD' } }, requestId: 'R-OFFLINE' }]);
});
