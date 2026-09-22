import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { withDshHome } from './helpers/tmp.mjs';

const iso = (d = new Date()) => d.toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Minimal well-formed card for direct store writes. */
function card(over = {}) {
  const ts = iso();
  return {
    id: over.id ?? `m-20260101-${Math.random().toString(16).slice(2, 12)}`,
    kind: over.kind ?? 'fact',
    tags: over.tags ?? [],
    importance: over.importance ?? 5,
    confidence: over.confidence ?? 0.6,
    created: over.created ?? ts,
    updated: over.updated ?? ts,
    lastAccessed: over.lastAccessed ?? ts,
    accessCount: over.accessCount ?? 0,
    validSince: over.validSince ?? ts,
    validUntil: over.validUntil ?? null,
    supersedes: over.supersedes ?? [],
    supersededBy: over.supersededBy ?? null,
    source: over.source ?? { session: 's', turn: null },
    links: over.links ?? [],
    title: over.title ?? '测试记忆卡片',
    body: over.body ?? '',
  };
}

/** Meta row for the pure selection policy test. */
function meta(over = {}) {
  const ts = iso();
  return {
    path: '',
    title: 't',
    kind: 'fact',
    tags: [],
    importance: 5,
    confidence: 0.6,
    created: ts,
    updated: ts,
    lastAccessed: ts,
    accessCount: 0,
    validUntil: null,
    supersedes: [],
    supersededBy: null,
    links: [],
    digest: '',
    terms: [],
    bytes: 0,
    ...over,
  };
}

function tightLimits(T, over = {}) {
  return {
    ...T.DEFAULT_MAINTENANCE_LIMITS,
    staleDays: 30,
    staleMaxImportance: 6,
    maxLiveCards: 100,
    maxArchivedCards: 100,
    maxAuditLines: 100,
    maxAccessLines: 100,
    maxInboxBytes: 10_000_000,
    maxInboxLines: 1000,
    ...over,
  };
}

// ── selection policy (pure) ────────────────────────────────────────────────

test('maintain: the stale sweep spares important, standing and fresh cards', async () => {
  const T = await import('../lib/testing.js');
  const now = new Date();
  const sel = T.selectMaintenance(
    [
      ['old-fact', meta({ updated: daysAgo(90) })],
      ['old-important', meta({ updated: daysAgo(90), importance: 9 })],
      ['old-preference', meta({ updated: daysAgo(90), kind: 'preference' })],
      ['old-commitment', meta({ updated: daysAgo(90), kind: 'commitment' })],
      ['fresh-fact', meta({ updated: daysAgo(1) })],
    ],
    tightLimits(T),
    now,
  );
  assert.deepEqual(sel.stale, ['old-fact'], 'only the stale, non-standing, low-importance card');
  assert.deepEqual(sel.overBudget, [], 'under the live ceiling → no budget eviction');
  assert.equal(sel.liveCards, 5);
});

test('maintain: over the live ceiling the lowest-value cards go, standing kinds last', async () => {
  const T = await import('../lib/testing.js');
  const now = new Date();
  const limits = tightLimits(T, { staleDays: 0, maxLiveCards: 2 });
  const sel = T.selectMaintenance(
    [
      ['keep-high', meta({ importance: 10, lastAccessed: iso(now) })],
      ['drop-low', meta({ importance: 1, lastAccessed: daysAgo(300) })],
      ['mid', meta({ importance: 5, lastAccessed: iso(now) })],
    ],
    limits,
    now,
  );
  assert.deepEqual(sel.overBudget, ['drop-low'], 'the least valuable card is evicted first');

  const sel2 = T.selectMaintenance(
    [
      ['pref', meta({ kind: 'preference', importance: 1, lastAccessed: daysAgo(300) })],
      ['fact', meta({ kind: 'fact', importance: 1, lastAccessed: daysAgo(300) })],
    ],
    tightLimits(T, { staleDays: 0, maxLiveCards: 1 }),
    now,
  );
  assert.deepEqual(sel2.overBudget, ['fact'], 'a standing preference is evicted only after an ordinary fact');
});

test('maintain: staleDays=0 disables the stale sweep', async () => {
  const T = await import('../lib/testing.js');
  const sel = T.selectMaintenance(
    [['old', meta({ updated: daysAgo(9999), importance: 1 })]],
    tightLimits(T, { staleDays: 0 }),
    new Date(),
  );
  assert.deepEqual(sel.stale, []);
});

// ── end-to-end maintenance ─────────────────────────────────────────────────

test('maintain: a dry run reports without changing anything; the apply archives and reindexes', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    for (let i = 0; i < 12; i++) {
      await store.putCard(
        card({ id: T.makeCardId(), title: `陈旧记忆 ${i}`, updated: daysAgo(400), lastAccessed: daysAgo(400), importance: 3 }),
        { rebuild: false },
      );
    }
    for (let i = 0; i < 2; i++) {
      await store.putCard(
        card({ id: T.makeCardId(), title: `重要记忆 ${i}`, importance: 10, updated: iso(), lastAccessed: iso() }),
        { rebuild: false },
      );
    }
    await store.rebuildIndex();
    const limits = tightLimits(T);

    const dry = await core.maintain({ limits, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.totals.staleArchived, 12, 'the dry run counts what it would archive');
    assert.equal((await store.readIndex()).bm25.docCount, 14, 'the dry run changed nothing on disk');
    assert.equal((await store.listArchived()).length, 0);

    const applied = await core.maintain({ limits });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.totals.staleArchived, 12);
    assert.equal((await store.listArchived()).length, 12);
    assert.equal((await store.readIndex()).bm25.docCount, 2, 'only the important cards stay live');

    // The incremental index the maintenance pass left behind equals a rebuild.
    const incremental = JSON.parse(JSON.stringify(await store.readIndex()));
    const rebuilt = await store.rebuildIndex();
    assert.deepEqual(incremental.cards, rebuilt.cards);
    assert.deepEqual(incremental.bm25, rebuilt.bm25);
  });
});

test('maintain: the archive, audit and access budgets are enforced (oldest first)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;

    // 20 live cards, all archived below (so the archive holds 20 entries).
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const id = T.makeCardId();
      ids.push(id);
      await store.putCard(card({ id, title: `归档预算 ${i}` }), { rebuild: false });
    }
    await store.rebuildIndex();
    for (const id of ids) await store.archiveCard(id, { rebuild: false });
    await store.rebuildIndex();
    assert.equal((await store.listArchived()).length, 20);

    // 60 audit lines and 40 access lines.
    for (let i = 0; i < 60; i++) {
      await store.audit({ ts: iso(), store: 'global', op: 'create', detail: `audit-${i}`, via: 'tool' });
    }
    await store.noteAccess(ids);
    await store.flushAccess();
    for (let i = 0; i < 40; i++) {
      await store.noteAccess([ids[i % ids.length]]);
      await store.flushAccess();
    }
    assert.equal(await store.auditLineCount(), 60);
    assert.equal(await store.accessLineCount(), 41);

    const limits = tightLimits(T, { maxArchivedCards: 5, maxAuditLines: 10, maxAccessLines: 4, staleDays: 0 });
    const res = await core.maintain({ limits });
    const g = res.stores.find((s) => s.slug === 'global');
    assert.equal(g.archivePruned, 15);
    assert.equal(g.auditPruned, 50);
    assert.equal(g.accessPruned, 37);
    assert.ok(g.bytesReclaimed > 0, 'bytes reclaimed are reported');

    assert.equal((await store.listArchived()).length, 5);
    // The prune keeps `maxAuditLines` lines; the maintenance summary line is
    // appended afterwards, hence the +1.
    assert.ok((await store.auditLineCount()) <= 11, 'audit bounded at the budget (+summary line)');
    assert.ok((await store.accessLineCount()) <= 4);
    // Newest audit lines survive (the pass appends its own summary line after).
    const audit = await T.readJsonlLines(join(store.paths.audit));
    const lastCreate = [...audit].reverse().find((e) => e.op === 'create');
    assert.equal(lastCreate.detail, 'audit-59');
    assert.equal(audit[audit.length - 1].op, 'maintain');
  });
});

test('maintain: inbox compaction drops only the consumed head', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    for (let i = 0; i < 20; i++) {
      await store.pushInbox({ ts: iso(), content: `收件箱条目 ${i}：唯一内容 ${i}。`, source: { session: 's', turn: null }, via: 'auto-heuristic' });
    }
    const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    await engine.runNow({ reason: 'test' });
    assert.equal((await store.readState()).inboxOffset, 20);

    // Five UNCONSUMED captures on top of the consumed head.
    for (let i = 0; i < 5; i++) {
      await store.pushInbox({ ts: iso(), content: `待整理条目 ${i}。`, source: { session: 's', turn: null }, via: 'auto-heuristic' });
    }
    assert.equal(await store.inboxLineCount(), 25);

    const res = await core.maintain({ limits: tightLimits(T, { staleDays: 0, maxInboxLines: 3, maxLiveCards: 10_000 }) });
    const g = res.stores.find((s) => s.slug === 'global');
    assert.equal(g.inboxDropped, 20, 'the drop is capped at the consumed offset');
    assert.equal(await store.inboxLineCount(), 5, 'pending captures survive');
    assert.equal((await store.readState()).inboxOffset, 0, 'the checkpoint follows the file');

    const status = await core.status(true);
    assert.equal(status.stores.find((s) => s.slug === 'global').pendingInbox, 5);
  });
});

test('dream: the inbox BYTE budget compacts the consumed head automatically', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    const big = '这是一条很长的捕获内容，用于把候选池推到字节上限之上。'.repeat(60);
    for (let i = 0; i < 6; i++) {
      await store.pushInbox({ ts: iso(), content: `${big} 编号 ${i}`, source: { session: 's', turn: null }, via: 'auto-heuristic' });
    }
    assert.ok((await store.inboxBytes()) > 10_000, 'inbox starts well over the byte budget');

    const settings = T.defaultMemorySettings();
    settings.maintenance = { ...settings.maintenance, maxInboxBytes: 2000, staleDays: 0, maxLiveCards: 100_000 };
    const engine = new T.DreamEngine(core, () => settings, null, null);
    await engine.runNow({ reason: 'test' });

    assert.equal((await store.readState()).inboxOffset, 0, 'the checkpoint follows the compaction');
    assert.ok((await store.inboxBytes()) <= 2000, `inbox bytes (${await store.inboxBytes()}) are under the budget`);

    // A pending capture staged after the compaction is still pending.
    await store.pushInbox({ ts: iso(), content: '待整理的小条目。', source: { session: 's', turn: null }, via: 'auto-heuristic' });
    const status = await core.status(true);
    assert.equal(status.stores.find((s) => s.slug === 'global').pendingInbox, 1);
  });
});

test('maintain: a wall-clock deadline truncates the sweep safely', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    for (let i = 0; i < 5; i++) {
      await store.putCard(card({ id: T.makeCardId(), title: `超时截断测试 ${i}`, updated: daysAgo(400), lastAccessed: daysAgo(400), importance: 2 }), { rebuild: false });
    }
    await store.rebuildIndex();
    const limits = tightLimits(T);

    const res = await core.maintain({ limits, deadline: Date.now() - 1 });
    const g = res.stores.find((s) => s.slug === 'global');
    assert.equal(g.truncated, true, 'the pass reports that it stopped early');
    assert.equal(g.staleArchived, 0, 'nothing was archived after the deadline');
    assert.equal((await store.readIndex()).bm25.docCount, 5, 'the store is untouched');
    assert.equal((await store.listArchived()).length, 0);

    // Without a deadline the same selection completes.
    const full = await core.maintain({ limits });
    assert.equal(full.stores.find((s) => s.slug === 'global').truncated, false);
    assert.equal(full.totals.staleArchived, 5);
  });
});

// ── incremental index ──────────────────────────────────────────────────────

test('index: incremental updates match a full rebuild across every mutation kind', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;

    const a = card({ id: T.makeCardId(), title: '增量索引甲：部署流水线', body: '数据库连接池大小为 20。', tags: ['deploy'] });
    const b = card({ id: T.makeCardId(), title: '增量索引乙：发布窗口', body: '发布窗口是周五下午。', tags: ['release'] });
    const c = card({ id: T.makeCardId(), title: '增量索引丙：待归档', tags: ['deploy'] });
    await store.putCard(a); // first write bootstraps the index (no base yet → rebuild)
    await store.putCard(b);
    await store.patchCard(b.id, { importance: 9, updated: iso() });
    await store.putCard(c);
    await store.supersedeCard(c.id, a.id, iso());
    await store.archiveCard(b.id);
    await store.deleteCardHard(c.id);
    await store.restoreCard(b.id);

    const incremental = JSON.parse(JSON.stringify(await store.readIndex()));
    const rebuilt = await store.rebuildIndex();
    assert.deepEqual(incremental.cards, rebuilt.cards, 'card rows agree');
    assert.deepEqual(incremental.bm25, rebuilt.bm25, 'bm25 stats (docCount/totalTokens/df) agree exactly');
    assert.equal(incremental.bm25.docCount, 2);
    assert.ok(Object.keys(incremental.bm25.df).length > 0);
    // The on-disk index is COMPACT (derived artifact, no indentation).
    const raw = await readFile(store.paths.index, 'utf8');
    assert.ok(!raw.includes('\n  '), 'index.json is written without pretty-printing');
  });
});

test('index: a legacy index without bm25.totalTokens is upgraded by a rebuild, not patched', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    await store.putCard(card({ id: T.makeCardId(), title: '旧索引升级测试' }));
    const raw = JSON.parse(await readFile(store.paths.index, 'utf8'));
    delete raw.bm25.totalTokens;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(store.paths.index, JSON.stringify(raw));
    store.invalidateIndexCache();

    await store.putCard(card({ id: T.makeCardId(), title: '第二张卡片' }));
    const index = await store.readIndex();
    assert.equal(index.bm25.docCount, 2);
    assert.equal(typeof index.bm25.totalTokens, 'number');
    const rebuilt = await store.rebuildIndex();
    assert.deepEqual(index.cards, rebuilt.cards);
    assert.deepEqual(index.bm25, rebuilt.bm25);
  });
});

// ── surfaces: memory_gc tool + /memory 清理 ─────────────────────────────────

function makeToolsCtx() {
  const registered = new Map();
  const ctx = {
    get: (name) =>
      name === 'tools'
        ? {
            register(def) {
              registered.set(def.name, def);
              return () => registered.delete(def.name);
            },
          }
        : undefined,
  };
  return { ctx, registered };
}

test('memory_gc: dry run by default, applies with confirm=true', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    for (let i = 0; i < 6; i++) {
      await store.putCard(card({ id: T.makeCardId(), title: `GC 工具测试 ${i}`, updated: daysAgo(400), lastAccessed: daysAgo(400), importance: 2 }), { rebuild: false });
    }
    await store.rebuildIndex();
    const settings = T.defaultMemorySettings();
    settings.maintenance = { ...settings.maintenance, staleDays: 30, staleMaxImportance: 6, maxLiveCards: 100 };
    const engine = new T.DreamEngine(core, () => settings, null, null);
    const { ctx, registered } = makeToolsCtx();
    T.registerMemoryTools(ctx, core, () => settings, engine, null);
    const gc = registered.get('memory_gc');
    assert.ok(gc, 'memory_gc registered');

    const dry = await gc.execute({}, {});
    assert.equal(dry.dryRun, true);
    assert.equal(dry.totals.staleArchived, 6);
    assert.equal((await store.readIndex()).bm25.docCount, 6, 'dry run left the store alone');

    const applied = await gc.execute({ confirm: true }, {});
    assert.equal(applied.dryRun, false);
    assert.equal((await store.readIndex()).bm25.docCount, 0);
  });
});

test('commands: /memory 清理 is a dry run until confirm', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    for (let i = 0; i < 4; i++) {
      await store.putCard(card({ id: T.makeCardId(), title: `命令清理测试 ${i}`, updated: daysAgo(400), lastAccessed: daysAgo(400), importance: 2 }), { rebuild: false });
    }
    await store.rebuildIndex();
    const settings = T.defaultMemorySettings();
    settings.maintenance = { ...settings.maintenance, staleDays: 30, staleMaxImportance: 6, maxLiveCards: 100 };
    const registered = new Map();
    const ctx = {
      get: (name) =>
        name === 'commands'
          ? { register: (def) => (registered.set(def.name, def), () => registered.delete(def.name)) }
          : undefined,
    };
    const engine = new T.DreamEngine(core, () => settings, null, null);
    T.registerMemoryCommands(ctx, core, () => settings, engine, null);
    const run = (rawInput) => registered.get('memory').handler({ agent: { session: { id: 's', header: { cwd: null } } }, rawInput });

    const dry = await run('清理');
    assert.equal(dry.kind, 'success');
    assert.match(dry.text, /试算/);
    assert.equal((await store.readIndex()).bm25.docCount, 4);

    const applied = await run('gc confirm');
    assert.equal(applied.kind, 'success');
    assert.match(applied.text, /完成/);
    assert.equal((await store.readIndex()).bm25.docCount, 0);
  });
});
