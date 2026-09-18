import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { withDshHome, waitMs } from './helpers/tmp.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('remember → recall → forget lifecycle (global store)', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    assert.equal(core.global.slug, 'global');
    assert.ok(core.global.paths.root.startsWith(home), 'store lives under DSH_HOME, never in a project');

    const { card, slug, path } = await core.remember(
      { content: '部署流水线用 GitHub Actions。\n所有服务日志保留 30 天。', kind: 'procedure', tags: ['ci'], scope: 'global' },
      'tool',
      'sess-1',
    );
    assert.equal(slug, 'global');
    assert.ok(path.startsWith(home));
    assert.equal(card.title, '部署流水线用 GitHub Actions。');

    const { hits, counts } = await core.recall('GitHub Actions 部署', { k: 5 });
    assert.ok(hits.some((h) => h.id === card.id), 'recall finds the card');
    assert.equal(counts.global, 1);

    // audit trail records the create
    const audit = await T.readJsonlLines(join(home, 'memory/global/audit.jsonl'));
    assert.ok(audit.some((e) => e.op === 'create' && e.id === card.id && e.via === 'tool'));

    // archive (default forget)
    const f1 = await core.forget({ id: card.id }, 'tool', 'sess-1');
    assert.equal(f1.removed.length, 1);
    assert.equal(f1.removed[0].mode, 'archive');
    const after = await core.recall('GitHub Actions 部署', { k: 5 });
    assert.ok(!after.hits.some((h) => h.id === card.id), 'archived card no longer recalled');
    assert.equal(await core.global.archivedCount(), 1);

    // hard delete removes the file
    const f2 = await core.forget({ id: card.id, hard: true }, 'tool', 'sess-1');
    assert.equal(f2.removed.length, 0, 'archived card is out of the forget scope (cards dir only)');
  });
});

test('policy block leaves no card and audits the reason names', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await assert.rejects(
      () => core.remember({ content: 'password=SuperSecret123', scope: 'global' }, 'tool', 'sess-1'),
      T.MemoryPolicyError,
    );
    assert.equal(await core.global.readIndex().then((i) => Object.keys(i.cards).length), 0);
    const audit = await T.readJsonlLines(join(home, 'memory/global/audit.jsonl'));
    const block = audit.find((e) => e.op === 'block');
    assert.ok(block, 'block audited');
    assert.ok(block.detail.includes('credential-assignment'));
    assert.ok(!block.detail.includes('SuperSecret'), 'matched content never lands on disk');
  });
});

test('concurrent inbox appends in one process lose no lines', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.pushInbox({ ts: new Date().toISOString(), content: `line-${i}`, source: { session: '', turn: null }, via: 'test' }),
      ),
    );
    assert.equal(await store.inboxLineCount(), 8);
  });
});

test('concurrent inbox appends across processes lose no lines', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const storeRoot = core.global.paths.root;
    const worker = fileURLToPath(new URL('./helpers/inbox-worker.mjs', import.meta.url));
    const jobs = Array.from({ length: 4 }, (_, i) =>
      new Promise((resolve) => {
        const child = fork(worker, [storeRoot, '25'], { stdio: 'ignore' });
        child.on('close', (code) => resolve(code));
      }),
    );
    const codes = await Promise.all(jobs);
    assert.deepEqual(codes, [0, 0, 0, 0], 'workers exit 0');
    assert.equal(await core.global.inboxLineCount(), 100, '4 x 25 lines, zero loss');
  });
});

test('project store resolves via .git walk and registers the path', async () => {
  await withDshHome(async (home) => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const project = await mkdtemp(join(tmpdir(), 'dsh-memory-proj-'));
    try {
      await mkdir(join(project, 'src'), { recursive: true });
      await writeFile(join(project, '.git'), 'fake');
      const T = await import('../lib/testing.js');
      const core = await T.MemoryCore.create({ logger: null });
      const store = await core.projectStoreForCwd(join(project, 'src'));
      assert.ok(store, 'project store found');
      assert.ok(store.paths.root.startsWith(home), 'project store under DSH_HOME/memory/projects/');
      const { slug } = await core.remember({ content: '项目 X 的前端框架是 Vue3。', scope: 'project', cwd: project }, 'tool', 'sess-2');
      assert.equal(slug, store.slug);
      const reg = await T.loadProjectsRegistry();
      assert.ok(reg.projects[store.slug], 'registry entry created');
      assert.equal(reg.projects[store.slug].path, project);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

test('cwd outside any project → no project store', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = await core.projectStoreForCwd(join(home, 'no-project-here'));
    assert.equal(store, null);
  });
});

// ── F1: a single corrupt card file must not brick the store ────────────────

test('F1: recall survives a corrupt card (skips it, keeps the rest)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card: victimCard } = await core.remember({ content: '网关端口是 8443。', scope: 'global' }, 'tool', 's1');
    const { card: healthyCard } = await core.remember({ content: '部署流水线用 GitHub Actions。', scope: 'global' }, 'tool', 's1');

    const store = core.global;
    // corrupt exactly the victim's file
    await writeFile(join(store.paths.cards, `${victimCard.id}.md`), 'corrupted {{{ no frontmatter');

    // recall must not throw and must still return the healthy card
    const { hits, counts } = await core.recall('网关 部署', { k: 5 });
    assert.ok(hits.some((h) => h.id === healthyCard.id), 'the healthy card is still recalled');
    assert.ok(!hits.some((h) => h.id === victimCard.id), 'the corrupt card is not served');
    // The corpus is index-backed (v2): a card file corrupted IN PLACE keeps its
    // index row until a rebuild, so `counts` may still include it. What matters
    // is that the read path never serves it (asserted above) and that an
    // explicit rebuild drops it.
    assert.equal(counts.global, 2, 'corpus is index-backed and still reports both rows');

    // the index rebuild itself is resilient (used by status / browse) and
    // drops the corrupt entry for real.
    const index = await store.rebuildIndex();
    assert.equal(Object.keys(index.cards).length, 1);
    assert.ok(index.cards[healthyCard.id], 'index holds the healthy card');
    const after = await core.recall('网关 部署', { k: 5 });
    assert.equal(after.counts.global, 1, 'after a rebuild the corrupt card is out of the corpus');
    assert.ok(after.hits.some((h) => h.id === healthyCard.id), 'healthy card still recallable after rebuild');
  });
});

test('F1: writes and Dream still work with a corrupt card present', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const first = await core.remember({ content: '第一条记忆内容。', scope: 'global' }, 'tool', 's1');
    const second = await core.remember({ content: '第二条记忆内容。', scope: 'global' }, 'tool', 's1');
    const store = core.global;
    // poison exactly one card; the other must stay fully functional
    await writeFile(join(store.paths.cards, `${first.card.id}.md`), 'broken');

    // a new remember still lands (the corrupt file does not block putCard)
    const third = await core.remember({ content: '第三条记忆内容。', scope: 'global' }, 'tool', 's1');
    assert.ok(third.card.id);

    // recall still finds the healthy card
    const { hits } = await core.recall('第二条记忆内容', { k: 5 });
    assert.ok(hits.some((h) => h.id === second.card.id), 'healthy card still recalled');

    // Dream ingests a new capture and succeeds despite the corrupt card
    await store.pushInbox({ ts: new Date().toISOString(), content: 'Dream 期间新增的捕获。', source: { session: 's', turn: null }, via: 'auto-heuristic' });
    const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    const r = await engine.runNow({ reason: 'test' });
    const g = r.stores.find((s) => s.slug === 'global');
    assert.equal(g.error, undefined, 'dream run succeeds with a corrupt card on disk');
    assert.ok(g.added >= 1, 'new capture ingested');

    // the index holds only parseable cards
    const index = await store.readIndex();
    assert.equal(index.cards[first.card.id], undefined, 'corrupt card excluded from index');
    assert.ok(index.cards[second.card.id], 'healthy card still indexed');
  });
});

test('F1: corrupt archive entry is skipped, not resurrected by restore', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card } = await core.remember({ content: '待归档的记忆。', scope: 'global' }, 'tool', 's1');
    await core.forget({ id: card.id }, 'tool', 's1');
    // corrupt the archived copy
    await writeFile(join(core.global.paths.archive, `${card.id}.md`), 'garbage');
    // restore refuses to promote a corrupt file
    assert.equal(await core.restoreCardIn('global', card.id, 'tool'), false);
    // the archive listing still works (skips the unreadable entry)
    const rows = await core.global.listArchived();
    assert.ok(rows.some((r) => r.id === card.id), 'row remains listed by name');
    assert.equal(await core.global.readArchivedCard(card.id), null, 'corrupt archive entry reads as null');
  });
});

// ── F3: redact.pii is honored on the explicit remember path ────────────────

test('F3: remember honors redact.pii = off (raw stored)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const out = await core.remember({ content: '联系我邮箱 bob@example.com。', scope: 'global', piiMode: 'off' }, 'tool', 's1');
    assert.equal(out.warnings.length, 0, 'off mode reports nothing');
    assert.equal(await core.global.readCard(out.card.id).then((c) => c.body + c.title), '联系我邮箱 bob@example.com。');
  });
});

test('F3: remember honors redact.pii = warn (raw stored + names reported)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const out = await core.remember({ content: '联系我邮箱 bob@example.com。', scope: 'global', piiMode: 'warn' }, 'tool', 's1');
    assert.deepEqual(out.warnings, ['email'], 'warn reports the category name, not the content');
    assert.equal((await core.global.readCard(out.card.id)).title, '联系我邮箱 bob@example.com。', 'warn mode does not mask');
  });
});

test('F3: remember defaults to redact (mask) when no piiMode is given', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const out = await core.remember({ content: '联系我邮箱 bob@example.com。', scope: 'global' }, 'tool', 's1');
    assert.deepEqual(out.warnings, ['email'], 'masked categories are still named');
    const card = await core.global.readCard(out.card.id);
    assert.ok(!`${card.title} ${card.body}`.includes('bob@example.com'), 'default mode masks the email');
  });
});

// ── F10: forget with a malformed / traversal id is a no-op, not a crash ────

test('F10: forget rejects malformed and traversal ids (no-op, no throw)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card } = await core.remember({ content: '受保护的记忆。', scope: 'global' }, 'tool', 's1');
    for (const id of ['../../etc/passwd', '../global', 'nope', 'm-bad', `${card.id}.md`]) {
      const out = await core.forget({ id }, 'tool', 's1');
      assert.deepEqual(out.removed, [], `id ${JSON.stringify(id)} is a no-op`);
    }
    assert.ok(await core.global.readCard(card.id), 'the real card is untouched');
  });
});

// ── F8: registry RMW is locked + the slug is cached per process ────────────

test('F8: concurrent registrations of colliding paths lose no entry', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    // Two DIFFERENT project paths that slug to the SAME base (collision).
    // Without the registry lock, parallel RMWs would last-writer-wins and
    // drop one entry (splitting one project's memory across two slugs).
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const base = await mkdtemp(join(tmpdir(), 'dsh-mem-reg-'));
    try {
      // Force a slug collision: slugForPath maps both "." and " " to "-", so
      // these two DISTINCT paths slug to the SAME base.
      const p1 = join(base, 'proj.a b');
      const p2 = join(base, 'proj a.b');
      assert.equal(T.slugForPath(p1), T.slugForPath(p2), 'fixture sanity: same base slug');
      const [r1, r2] = await Promise.all([T.registerProjectPath(p1), T.registerProjectPath(p2)]);
      assert.notEqual(r1.slug, r2.slug, 'colliding paths get distinct slugs');
      const reg = await T.loadProjectsRegistry();
      assert.equal(reg.projects[r1.slug].path, p1, 'first entry kept (no last-writer-wins loss)');
      assert.equal(reg.projects[r2.slug].path, p2, 'second entry kept (no last-writer-wins loss)');
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(base, { recursive: true, force: true });
    }
  });
});

test('F8: projectStoreForCwd registers once, then never rewrites the registry', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const proj = join(home, 'fake-project');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, '.git'), 'fake');

    const s1 = await core.projectStoreForCwd(proj);
    assert.ok(s1);
    const regPath = T.projectsRegistryPath();
    const mtimeAfterFirst = (await stat(regPath)).mtimeMs;

    // N more lookups (the recall/remember hot path) must not touch the file
    for (let i = 0; i < 5; i += 1) {
      const s = await core.projectStoreForCwd(join(proj, 'sub', 'dir'));
      assert.equal(s?.slug, s1.slug, 'same store via a nested cwd');
    }
    await waitMs(20);
    const mtimeAfterN = (await stat(regPath)).mtimeMs;
    assert.equal(mtimeAfterN, mtimeAfterFirst, 'registry not rewritten on repeat lookups');
  });
});

// ── F2: pending inbox = unconsumed lines only ──────────────────────────────

test('F2: status pendingInbox counts only unconsumed lines (0 after Dream)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    for (let i = 0; i < 3; i += 1) {
      await store.pushInbox({ ts: new Date().toISOString(), content: `捕获 ${i}`, source: { session: 's', turn: null }, via: 'auto-heuristic' });
    }
    const before = await core.status(true);
    assert.equal(before.stores[0].pendingInbox, 3, '3 staged → 3 pending');

    const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null);
    await engine.runNow({ reason: 'test' });

    const after = await core.status(true);
    assert.equal(after.stores[0].pendingInbox, 0, 'consumed by Dream → 0 pending (file lines stay on disk)');
    // one more capture → pending goes back up
    await store.pushInbox({ ts: new Date().toISOString(), content: '再来一条。', source: { session: 's', turn: null }, via: 'auto-heuristic' });
    const again = await core.status(true);
    assert.equal(again.stores[0].pendingInbox, 1);
  });
});

// ── F7: putCard/patchCard can defer the index rebuild ──────────────────────

test('F7: putCard {rebuild:false} does not rewrite index.json; explicit rebuild picks it up', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    await core.remember({ content: '初始卡片。', scope: 'global' }, 'tool', 's1');
    const mtimeBefore = (await stat(store.paths.index)).mtimeMs;

    const card = {
      id: T.makeCardId(new Date()),
      kind: 'fact',
      tags: [],
      importance: 5,
      confidence: 0.5,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      accessCount: 0,
      validSince: new Date().toISOString(),
      validUntil: null,
      supersedes: [],
      source: { session: 's', turn: null },
      links: [],
      title: '延迟重建的卡片。',
      body: '',
    };
    await store.putCard(card, { rebuild: false });
    await waitMs(15);
    assert.equal((await stat(store.paths.index)).mtimeMs, mtimeBefore, 'no index rewrite without rebuild');
    // the card file exists even though the index is stale
    assert.ok(await core.global.readCard(card.id), 'card is readable');

    const index = await store.rebuildIndex();
    assert.ok(index.cards[card.id], 'explicit rebuild picks the deferred card up');
  });
});
