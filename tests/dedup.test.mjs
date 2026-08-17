import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupDecide, DEDUP_THRESHOLDS } from '../lib/testing.js';

test('identical token sets → noop', () => {
  const tokens = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const d = dedupDecide(new Set(tokens), [{ id: 'a', tokens: new Set(tokens) }]);
  assert.equal(d.action, 'noop');
  assert.equal(d.matchId, 'a');
  assert.ok(d.similarity >= DEDUP_THRESHOLDS.noop);
});

test('partial overlap (≈0.67) → update', () => {
  // intersection 6, union 9 → 0.666
  const d = dedupDecide(
    new Set(['1', '2', '3', '4', '5', '6']),
    [{ id: 'x', tokens: new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9']) }],
  );
  assert.equal(d.action, 'update');
  assert.equal(d.matchId, 'x');
});

test('disjoint sets → add', () => {
  const d = dedupDecide(new Set(['p', 'q', 'r']), [{ id: 'x', tokens: new Set(['a', 'b', 'c']) }]);
  assert.equal(d.action, 'add');
  assert.equal(d.matchId, undefined);
});

test('empty existing corpus → add', () => {
  const d = dedupDecide(new Set(['x']), []);
  assert.equal(d.action, 'add');
});
