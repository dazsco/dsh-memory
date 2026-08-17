import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { withDshHome } from './helpers/tmp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const iso = (d = new Date()) => d.toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

test('dream ingests the inbox, is idempotent, and checkpoints state', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;

    await store.pushInbox({ ts: iso(), content: '部署流水线用 GitHub Actions。', kind: 'procedure', source: { session: 's1', turn: null }, via: 'auto-heuristic' });
    await store.pushInbox({ ts: iso(), content: '部署流水线使用 GitHub Actions。', kind: 'procedure', source: { session: 's2', turn: null }, via: 'auto-heuristic' });
    await store.pushInbox({ ts: iso(), content: '用户偏好使用中文回复。', kind: 'preference', source: { session: 's3', turn: null }, via: 'auto-heuristic' });

    const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    const r1 = await engine.runNow({ reason: 'test' });
    assert.equal(r1.busy, false);
    const g1 = r1.stores.find((s) => s.slug === 'global');
    assert.ok(g1);
    assert.equal(g1.added + g1.updated + g1.noop, 3, 'all three captures accounted for');
    assert.ok(g1.added >= 1);

    // idempotent second run: inbox is empty now
    const r2 = await engine.runNow({ reason: 'test' });
    const g2 = r2.stores.find((s) => s.slug === 'global');
    assert.equal(g2.added, 0);
    assert.equal(g2.updated, 0);
    assert.equal(g2.noop, 0);
    assert.equal(g2.archived, 0);

    // checkpoint
    const state = await store.readState();
    assert.equal(state.inboxOffset, 3);
    assert.equal(state.lastResult, 'success');
    assert.equal(state.stats.runs, 2);

    // index + report
    const index = await store.readIndex();
    assert.ok(Object.keys(index.cards).length >= 1);
    const reports = await T.listFiles(store.paths.dream);
    assert.ok(reports.some((n) => n.startsWith('report-') && n.endsWith('.md')));

    // audit dream entry
    const audit = await T.readJsonlLines(join(home, 'memory/global/audit.jsonl'));
    assert.ok(audit.some((e) => e.op === 'dream' && e.via === 'dream'));
    void home;
  });
});

test('crash recovery: a failed run leaves the inbox offset untouched', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    await store.pushInbox({ ts: iso(), content: '恢复测试的第一条。', source: { session: 's1', turn: null }, via: 'auto-heuristic' });
    await store.pushInbox({ ts: iso(), content: '恢复测试的第二条。', source: { session: 's2', turn: null }, via: 'auto-heuristic' });

    const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    // Force a failure after ingest: poison a card file so the index rebuild fails.
    const originalRebuild = store.rebuildIndex.bind(store);
    store.rebuildIndex = async () => {
      await originalRebuild();
      throw new Error('simulated crash');
    };
    const r = await engine.runNow({ reason: 'test' });
    const g = r.stores.find((s) => s.slug === 'global');
    assert.ok(g.error, 'error surfaced in the result');
    const state = await store.readState();
    assert.equal(state.inboxOffset, 0, 'offset not advanced after a failed run');
    assert.equal(state.lastResult, 'error');
    // recovery run (healthy) consumes everything
    store.rebuildIndex = originalRebuild;
    const r2 = await engine.runNow({ reason: 'test' });
    const g2 = r2.stores.find((s) => s.slug === 'global');
    assert.equal(g2.error, undefined);
    assert.equal(g2.added + g2.updated + g2.noop, 2);
    const state2 = await store.readState();
    assert.equal(state2.inboxOffset, 2);
    assert.equal(state2.lastResult, 'success');
  });
});

test('dream folds the access log into card counters', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    const { card } = await core.remember({ content: '访问计数测试卡片。', scope: 'global' }, 'tool', 's1');
    await store.noteAccess([card.id]);
    await store.noteAccess([card.id]);
    const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    await engine.runNow({ reason: 'test' });
    const after = await store.readCard(card.id);
    assert.equal(after.accessCount, 2);
    const access = await store.readAccessLog();
    assert.equal(access.length, 0, 'access log consumed');
  });
});

test('rule retention archives stale cards (AGENTS.md Memory section)', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    await writeFile(
      join(home, 'AGENTS.md'),
      ['## Memory', '', '### 保留期', '- observation: 7 天', '', '### 永远不记', '- 密码'].join('\n'),
      'utf8',
    );
    const { card } = await core.remember({ content: '一次临时观察：缓存命中率偏低。', kind: 'observation', scope: 'global' }, 'tool', 's1');
    // backdate 10 days
    await store.patchCard(card.id, { updated: daysAgo(10), lastAccessed: daysAgo(10) });
    const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    const r = await engine.runNow({ reason: 'test' });
    const g = r.stores.find((s) => s.slug === 'global');
    assert.equal(g.archived, 1);
    assert.ok((await T.listFiles(store.paths.archive)).some((n) => n.includes(card.id)));
  });
});

test('dream honors the wall budget and resumes the inbox next run', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    for (let i = 0; i < 5; i++) {
      await store.pushInbox({ ts: iso(), content: `预算测试卡片 编号 ${i}。`, source: { session: 's', turn: null }, via: 'auto-heuristic' });
    }
    const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    // Tiny wall budget: the run should stop early (deadline reached) or finish;
    // either way, the second run must consume the rest to completion.
    const r1 = await engine.runNow({ reason: 'test', maxWallMs: 5000 });
    assert.equal(r1.stores.find((s) => s.slug === 'global').error, undefined);
    const s1 = await store.readState();
    const r2 = await engine.runNow({ reason: 'test' });
    const g2 = r2.stores.find((s) => s.slug === 'global');
    assert.equal(g2.error, undefined);
    const s2 = await store.readState();
    assert.equal(s2.inboxOffset, 5, 'all lines eventually consumed');
    assert.ok(s2.inboxOffset >= s1.inboxOffset);
  });
});

test('busy guard: a concurrent runNow is reported busy', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    const p1 = engine.runNow({ reason: 'a' });
    const r2 = await engine.runNow({ reason: 'b' });
    assert.equal(r2.busy, true);
    await p1;
  });
});

test('concurrent engines on the same store do not double-ingest (file lock)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    // Four genuinely distinct captures (no dedup overlap ≥0.6).
    const lines = [
      '并发测试甲：网关的生产端口是 8443。',
      '并发测试乙：数据库快照每周日凌晨生成。',
      '并发测试丙：发布窗口安排在周五下午。',
      '并发测试丁：代码评审需要两名批准人。',
    ];
    for (const content of lines) {
      await store.pushInbox({ ts: iso(), content, source: { session: 's', turn: null }, via: 'auto-heuristic' });
    }
    // Two engines share the store; the in-process guard makes the second busy,
    // and the per-store file lock serializes cross-process runs.
    const e1 = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    const e2 = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    const [r1, r2] = await Promise.all([e1.runNow({ reason: 'x' }), e2.runNow({ reason: 'y' })]);
    const done = r1.busy ? r2 : r1;
    const skipped = r1.busy ? r1 : r2;
    assert.equal(skipped.busy, true);
    assert.equal(done.stores.find((s) => s.slug === 'global').error, undefined);
    const state = await store.readState();
    assert.equal(state.inboxOffset, 4);
    const index = await store.readIndex();
    assert.equal(Object.keys(index.cards).length, 4, 'each capture ingested exactly once');
  });
});
