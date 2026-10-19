// Newly authored regression tests; not recovered original navigation coverage.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as navigation from '../src/interaction.ts';

test('new: case navigation round-trips reserved characters and rejects invalid or empty hashes', () => {
  for (const id of ['CASE-A', 'CASE / with # and %', '買い手']) assert.equal(navigation.caseIdFromHash(navigation.caseHref(id)), id);
  for (const hash of ['#/', '', '#/case/', '#/case/%E0%A4%A', '#/other/CASE-A']) assert.equal(navigation.caseIdFromHash(hash), null);
});

test('new: repeated clicks before rendering invoke the action only once', async () => {
  const run = navigation.createSingleFlight();
  let release!: (n: number) => void;
  let calls = 0;
  const first = run(() => { calls++; return new Promise<number>(r => { release = r; }); });
  assert.equal(await run(async () => { calls++; return 2; }), undefined);
  assert.equal(calls, 1);
  release(1);
  assert.equal(await first, 1);
  assert.equal(await run(async () => 3), 3);
});

test('new: a failed action unlocks only after its promise settles', async () => {
  const run = navigation.createSingleFlight();
  await assert.rejects(run(async () => { throw new Error('test failure'); }), /test failure/);
  assert.equal(await run(async () => 'next'), 'next');
});

test('new: send attempt identity resets for another case or newly approved revision', () => {
  assert.equal(typeof navigation.sendAttemptKey, 'function', 'revision-scoped send identity is missing');
  const a = navigation.sendAttemptKey('CASE-A', 'r1');
  assert.equal(a, navigation.sendAttemptKey('CASE-A', 'r1'));
  assert.notEqual(a, navigation.sendAttemptKey('CASE-B', 'r1'));
  assert.notEqual(a, navigation.sendAttemptKey('CASE-A', 'r2'));
  assert.notEqual(navigation.sendAttemptKey('a:b', 'c'), navigation.sendAttemptKey('a', 'b:c'));
});
