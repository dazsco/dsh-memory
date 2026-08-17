import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemorySection, mergeRules } from '../lib/testing.js';

test('parses a Chinese AGENTS.md Memory section', () => {
  const md = [
    '# Rules',
    '',
    '## Memory',
    '- 项目用 pnpm 管理依赖',
    '',
    '### 总是记住',
    '- 用中文回复',
    '',
    '### 永远不记',
    '- 密码',
    '- 内网 IP',
    '',
    '### 保留期',
    '- observation: 30 天',
    '',
    '### 晋升',
    '- 需要 2 个会话',
    '',
    '## Other',
    '- 不应被读取',
  ].join('\n');
  const r = parseMemorySection(md);
  assert.ok(r, 'section parsed');
  assert.deepEqual([...r.denyKeywords].sort(), ['内网 IP', '密码']);
  assert.deepEqual(r.alwaysNotes, ['用中文回复']);
  assert.equal(r.retention.observation, 30);
  assert.equal(r.promoteSessions, 2);
  assert.ok(!JSON.stringify(r).includes('不应被读取'), 'content outside the section is ignored');
});

test('parses an English AGENTS.md Memory section', () => {
  const md = [
    '## Memory: rules',
    '- Always use spaces',
    '',
    '### Always remember',
    '- Tabs are banned',
    '',
    '### Never remember',
    '- credentials',
  ].join('\n');
  const r = parseMemorySection(md);
  assert.ok(r, 'section parsed');
  assert.deepEqual(r.denyKeywords, ['credentials']);
  assert.deepEqual(r.alwaysNotes, ['Tabs are banned']);
});

test('no Memory section → null', () => {
  assert.equal(parseMemorySection('# A\n- x\n'), null);
});

test('mergeRules unions deny keywords; later retention wins; null promote does not override', () => {
  const a = { denyKeywords: ['x'], alwaysNotes: [], retention: { observation: 30 }, promoteSessions: 1, notes: [] };
  const b = { denyKeywords: ['y'], alwaysNotes: [], retention: { observation: 10 }, promoteSessions: null, notes: [] };
  const m = mergeRules([a, b]);
  assert.deepEqual([...m.denyKeywords].sort(), ['x', 'y']);
  assert.equal(m.retention.observation, 10);
  assert.equal(m.promoteSessions, 1);
});
