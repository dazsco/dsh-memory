import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  jaccard,
  bm25Score,
  cardRecency,
  cardStrength,
  compositeScore,
  rankWithMmr,
  makeSnippet,
} from '../lib/testing.js';

test('tokenizer emits ascii words and CJK bigrams', () => {
  const t = tokenize('Remember 记住 this 部署');
  assert.ok(t.includes('remember'), 'ascii word');
  assert.ok(t.includes('this'), 'ascii word 2');
  assert.ok(t.includes('记住'), 'CJK bigram 1');
  assert.ok(t.includes('部署'), 'CJK bigram 2');
});

test('tokenize is deterministic and case-insensitive', () => {
  assert.deepEqual(tokenize('ABC'), tokenize('abc'));
  assert.deepEqual(tokenize('x'), tokenize('x'));
});

test('jaccard: identical=1, disjoint=0, partial in between', () => {
  const a = new Set(['x', 'y', 'z']);
  assert.equal(jaccard(a, new Set(['x', 'y', 'z'])), 1);
  assert.equal(jaccard(a, new Set(['p', 'q'])), 0);
  const b = new Set(['x', 'y', 'z', 'w']);
  const sim = jaccard(a, b);
  assert.ok(sim > 0.6 && sim < 1);
});

test('bm25 ranks documents containing the query term higher', () => {
  const df = { deploy: 2, 部署: 2, ci: 1 };
  const docCount = 3;
  const avgDocLen = 6;
  const query = tokenize('deploy 部署 pipeline');
  const s1 = bm25Score(query, tokenize('deploy pipeline ci'), df, docCount, avgDocLen);
  const s2 = bm25Score(query, tokenize('lunch menu'), df, docCount, avgDocLen);
  assert.ok(s1 > s2);
});

test('recency decays from 1 with elapsed hours', () => {
  const now = new Date('2026-08-17T12:00:00Z');
  const fresh = cardRecency('2026-08-17T12:00:00Z', now);
  const day = cardRecency('2026-08-16T12:00:00Z', now);
  const week = cardRecency('2026-08-10T12:00:00Z', now);
  assert.equal(fresh, 1);
  assert.ok(day < 1 && day > week);
});

test('strength grows with access count and decays with age', () => {
  const now = new Date('2026-08-17T12:00:00Z');
  const fresh = cardStrength(0, '2026-08-17T12:00:00Z', now);
  const accessed = cardStrength(5, '2026-08-17T12:00:00Z', now);
  const old = cardStrength(0, '2026-01-01T00:00:00Z', now);
  assert.ok(accessed > fresh);
  assert.ok(old < fresh);
  assert.ok(fresh <= 1);
});

test('compositeScore: higher rel/importance/recency/strength → higher score', () => {
  const base = compositeScore(0.5, 5, 0.5, 0.5);
  const better = compositeScore(0.9, 8, 0.9, 0.9);
  assert.ok(better > base);
});

test('rankWithMmr diversifies near-duplicates', () => {
  const tokensA = tokenize('数据库连接串走环境变量 database connection env');
  const candidates = [
    { id: 'a1', store: 'global', meta: {}, tokens: tokensA, score: 0.9 },
    { id: 'a2', store: 'global', meta: {}, tokens: tokenize('数据库连接串走环境变量 database connection env vars'), score: 0.88 },
    { id: 'b1', store: 'global', meta: {}, tokens: tokenize('发布窗口是周五 release window friday'), score: 0.8 },
  ];
  const ranked = rankWithMmr(candidates);
  assert.equal(ranked[0].id, 'a1');
  assert.equal(ranked[1].id, 'b1', 'diverse doc should outrank the near-duplicate');
});

test('makeSnippet truncates with an ellipsis', () => {
  const long = 'x'.repeat(300);
  const s = makeSnippet('t', long, 120);
  assert.ok(s.length <= 120);
  assert.ok(s.endsWith('…'));
  assert.equal(makeSnippet('t', 'short', 120), 'short');
});
