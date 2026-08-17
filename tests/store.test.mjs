import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
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
