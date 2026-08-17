import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCardId,
  parseCard,
  serializeCard,
  cardDigest,
  cardIdFromFileName,
  assertRoundTrip,
} from '../lib/testing.js';

function sampleCard() {
  const now = '2026-08-17T10:00:00.000Z';
  return {
    id: makeCardId(new Date('2026-08-17T10:00:00.000Z')),
    kind: 'preference',
    tags: ['ui', 'zh'],
    importance: 7,
    confidence: 0.62,
    created: now,
    updated: now,
    lastAccessed: now,
    accessCount: 3,
    validSince: now,
    validUntil: null,
    supersedes: [],
    source: { session: 'sess-1', turn: 2 },
    links: [],
    title: '用 pnpm 管理依赖',
    body: '本项目依赖管理统一使用 pnpm，不要用 npm。',
  };
}

test('card id format', () => {
  const id = makeCardId(new Date('2026-08-17T10:00:00.000Z'));
  assert.match(id, /^m-20260817-[a-z0-9]{4,10}$/);
});

test('card id ↔ file name round-trip', () => {
  const id = makeCardId();
  assert.equal(cardIdFromFileName(`${id}.md`), id);
  assert.equal(cardIdFromFileName('notes.md'), null);
});

test('serialize → parse round-trip preserves every field', () => {
  const card = sampleCard();
  assertRoundTrip(card);
  const text = serializeCard(card);
  const back = parseCard(text, card.id);
  assert.deepEqual(back, card);
});

test('digest is stable over content and changes with edits', () => {
  const a = sampleCard();
  const b = sampleCard();
  assert.equal(cardDigest(a), cardDigest(b));
  b.body = 'changed';
  assert.notEqual(cardDigest(a), cardDigest(b));
});

test('parseCard rejects a mismatched id', () => {
  const card = sampleCard();
  const text = serializeCard(card);
  assert.throws(() => parseCard(text, 'm-19990101-aaaa'));
});
