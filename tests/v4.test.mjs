import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withDshHome } from './helpers/tmp.mjs';

/**
 * v0.4 fixes (2026-09-20, diagnosed from the taunix incident):
 *   V1 project-root discovery beyond `.git` (root markers + explicit
 *      `.dsh-memory.json`, user-home exempt from marker matching)
 *   V2 slug charset lockstep (underscore/CJK store dirs must be discoverable)
 *   V3 store-level deletion (core.dropStore + registry cleanup)
 *   V4 orphan registry GC on core create
 *   V5 explicit fallback instead of silent global degradation
 */

const fsPromises = async () => import('node:fs/promises');
const osAsync = async () => import('node:os');

// ── V2: slug charset lockstep ────────────────────────────────────────────

test('V2: slugForPath keeps _ and CJK; stable for the current registry', async () => {
  const T = await import('../lib/testing.js');
  assert.equal(T.slugForPath('D:\\Repos\\ztu-adminet'), 'D-Repos-ztu-adminet');
  assert.equal(T.slugForPath('D:\\Repos\\dsh\\dsh-auto-continue'), 'D-Repos-dsh-dsh-auto-continue');
  assert.equal(T.slugForPath('D:\\Repos\\xuefou_actify'), 'D-Repos-xuefou_actify', 'underscore survives');
  assert.equal(T.slugForPath('D:\\昭通学院'), 'D-昭通学院', 'CJK survives');
  assert.equal(T.slugForPath('D:\\Repos\\proj.a b'), T.slugForPath('D:\\Repos\\proj a.b'), 'collision fixture preserved');
  assert.equal(T.slugForPath('D:\\Repos\\foo~bar'), 'D-Repos-foo-bar', '~ normalizes to -');

  for (const ok of ['D-Repos-xuefou_actify', 'D-昭通学院', 'root', 'a1-b2_c3']) {
    assert.equal(T.isValidStoreSlug(ok), true, `${ok} is a valid slug`);
  }
  for (const bad of ['-leading', '..', 'a b', 'D-Repos/x', '', 'has.dot']) {
    assert.equal(T.isValidStoreSlug(bad), false, `${JSON.stringify(bad)} is rejected`);
  }
});

test('V2: listProjectSlugs discovers underscore and CJK store dirs', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const { mkdir, stat } = await fsPromises();
    const projects = join(home, 'memory', 'projects');
    await mkdir(projects, { recursive: true });
    const under = 'D-Repos-xuefou_actify';
    const cjk = 'D-昭通学院';
    await T.ensureStoreSkel(join(projects, under));
    await T.ensureStoreSkel(join(projects, cjk));

    const slugs = await T.listProjectSlugs();
    assert.ok(slugs.includes(under), 'underscore slug visible');
    assert.ok(slugs.includes(cjk), 'CJK slug visible');

    const core = await T.MemoryCore.create({ logger: null });
    const store = core.storeBySlug(under);
    assert.ok(store, 'MemoryCore loads the underscore store');
    assert.ok(store.paths.root.startsWith(home));
    const report = await core.status(true);
    assert.ok(report.stores.some((s) => s.slug === under), 'status lists the underscore store');
    await stat(store.paths.cards); // skeleton intact
  });
});

// ── V1: root discovery beyond .git ───────────────────────────────────────

test('V1: findProjectRoot — markers, explicit declaration, .git priority, null', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await fsPromises();
  const { tmpdir } = await osAsync();
  const base = await mkdtemp(join(tmpdir(), 'dsh-mem-v1-'));
  try {
    const T = await import('../lib/testing.js');

    // a non-git project: pyproject.toml at the root
    const proj = join(base, 'non-git-proj');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, 'pyproject.toml'), '[project]\nname = "taunix"\n');
    assert.equal(await T.findProjectRoot(proj), proj);
    assert.equal(await T.findProjectRoot(join(proj, 'src', 'deep')), proj, 'discovered from a nested cwd');

    // .git still beats a deeper manifest (original convention unchanged)
    const gitProj = join(base, 'git-proj');
    await mkdir(join(gitProj, 'pkg'), { recursive: true });
    await writeFile(join(gitProj, '.git'), 'fake');
    await writeFile(join(gitProj, 'pkg', 'package.json'), '{}');
    assert.equal(await T.findProjectRoot(join(gitProj, 'pkg')), gitProj, '.git wins over a deeper manifest');

    // an explicit .dsh-memory.json at cwd beats a shallower marker
    const parent = join(base, 'explicit-parent');
    const child = join(parent, 'child');
    await mkdir(child, { recursive: true });
    await writeFile(join(parent, 'pyproject.toml'), '[project]\n');
    await writeFile(join(child, T.EXPLICIT_PROJECT_MARKER), '{}');
    assert.equal(await T.findProjectRoot(child), child, 'explicit declaration wins');
    assert.equal(await T.findProjectRoot(parent), parent, 'parent marker resolves for the parent cwd');

    // nothing in the chain (user home is exempt from marker matching) → null
    const bare = join(base, 'bare');
    await mkdir(bare, { recursive: true });
    assert.equal(await T.findProjectRoot(bare), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('V1: end-to-end — a non-git project resolves, registers and recalls', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const { mkdtemp, mkdir, writeFile, rm } = await fsPromises();
    const { tmpdir } = await osAsync();
    const base = await mkdtemp(join(tmpdir(), 'dsh-mem-v1e2e-'));
    try {
      const proj = join(base, 'taunix-like');
      await mkdir(join(proj, 'src'), { recursive: true });
      await writeFile(join(proj, 'pyproject.toml'), '[project]\nname = "taunix"\n');

      const core = await T.MemoryCore.create({ logger: null });
      const store = await core.projectStoreForCwd(join(proj, 'src'));
      assert.ok(store, 'marker-based root resolves to a project store');
      assert.ok(store.paths.root.startsWith(home), 'store under DSH_HOME, not the project');

      const { slug } = await core.remember(
        { content: 'taunix 是 Python 项目，入口是 main.py。', scope: 'project', cwd: proj },
        'tool',
        's1',
      );
      assert.equal(slug, store.slug);
      const reg = await T.loadProjectsRegistry();
      assert.equal(reg.projects[store.slug].path, proj, 'registry entry created');

      const { hits } = await core.recall('taunix 入口', { k: 5, projectSlug: store.slug, scope: 'both' });
      assert.ok(hits.some((h) => h.store === store.slug), 'cards recalled from the marker project');

      // a fresh core (simulating a new process) discovers the store from disk
      const core2 = await T.MemoryCore.create({ logger: null });
      assert.ok(core2.storeBySlug(store.slug), 'new core discovers the store');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

test('V2: end-to-end — an underscore project path round-trips and stays visible', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const { mkdtemp, mkdir, writeFile, rm } = await fsPromises();
    const { tmpdir } = await osAsync();
    const base = await mkdtemp(join(tmpdir(), 'dsh-mem-v2e2e-'));
    try {
      const proj = join(base, 'xuefou_actify');
      await mkdir(join(proj, 'src'), { recursive: true });
      await writeFile(join(proj, '.git'), 'fake');

      const core = await T.MemoryCore.create({ logger: null });
      const store = await core.projectStoreForCwd(join(proj, 'src'));
      assert.ok(store, 'underscore project resolves to a store');
      const { slug } = await core.remember(
        { content: 'actify 的构建脚本是 build.mjs。', scope: 'project', cwd: proj },
        'tool',
        's1',
      );
      assert.equal(slug, store.slug);

      // the incident: the store existed on disk but was filtered out of
      // discovery by the slug regex — a fresh core must see it
      const core2 = await T.MemoryCore.create({ logger: null });
      assert.ok(core2.storeBySlug(slug), 'slug is discoverable by a fresh core');
      const { hits } = await core2.recall('actify 构建', { k: 5, projectSlug: slug, scope: 'both' });
      assert.ok(hits.some((h) => h.store === slug), 'cards recalled from the underscore store');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── V3: store-level deletion ─────────────────────────────────────────────

test('V3: dropStore removes dir + registry entry; global protected; re-register works', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const { mkdtemp, mkdir, writeFile, rm, access, stat } = await fsPromises();
    const { tmpdir } = await osAsync();
    const base = await mkdtemp(join(tmpdir(), 'dsh-mem-v3-'));
    try {
      const proj = join(base, 'doomed');
      await mkdir(join(proj, '.git'), { recursive: true });
      const core = await T.MemoryCore.create({ logger: null });
      const store = await core.projectStoreForCwd(proj);
      assert.ok(store);

      const a = await core.remember({ content: '第一张卡。', scope: 'project', cwd: proj }, 'tool', 's1');
      const b = await core.remember({ content: '第二张卡。', scope: 'project', cwd: proj }, 'tool', 's1');
      const f = await core.forget({ id: b.card.id, projectSlug: store.slug }, 'tool', 's1');
      assert.equal(f.removed.length, 1, 'one card archived');

      await assert.rejects(() => core.dropStore('global'), /global store cannot be dropped/);
      await assert.rejects(() => core.dropStore('nope'), /unknown memory store/);

      const res = await core.dropStore(store.slug, 'tool', 's1');
      assert.equal(res.liveCards, 1);
      assert.equal(res.archivedCards, 1);
      assert.equal(res.registryRemoved, true);
      await assert.rejects(() => access(store.paths.root), 'store directory is gone');
      assert.equal(core.storeBySlug(store.slug), null);
      const reg = await T.loadProjectsRegistry();
      assert.equal(reg.projects[store.slug], undefined, 'registry entry removed');
      await stat(core.global.paths.root); // global store untouched

      // a later session in the same project re-registers a FRESH store at
      // the same (deterministic) slug
      const store2 = await core.projectStoreForCwd(proj);
      assert.ok(store2, 're-registration after drop');
      assert.equal(store2.slug, store.slug, 'same deterministic slug');
      const reg2 = await T.loadProjectsRegistry();
      assert.equal(reg2.projects[store2.slug].path, proj);
      const a2 = await core.remember({ content: '重建后的新卡。', scope: 'project', cwd: proj }, 'tool', 's2');
      assert.equal(a2.slug, store2.slug);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── V4: orphan registry GC ───────────────────────────────────────────────

test('V4: orphan registry entries are garbage-collected on core create', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const { mkdtemp, mkdir, rm } = await fsPromises();
    const { tmpdir } = await osAsync();
    const base = await mkdtemp(join(tmpdir(), 'dsh-mem-v4-'));
    try {
      const keep = join(base, 'keepme');
      const drop = join(base, 'dropme');
      await mkdir(join(keep, '.git'), { recursive: true });
      await mkdir(join(drop, '.git'), { recursive: true });

      const core = await T.MemoryCore.create({ logger: null });
      const sa = await core.projectStoreForCwd(keep);
      const sb = await core.projectStoreForCwd(drop);
      assert.ok(sa && sb);

      // simulate the user deleting a store folder by hand
      await rm(sb.paths.root, { recursive: true, force: true });
      const regBefore = await T.loadProjectsRegistry();
      assert.ok(regBefore.projects[sb.slug], 'orphan entry present before gc');

      const core2 = await T.MemoryCore.create({ logger: null });
      const regAfter = await T.loadProjectsRegistry();
      assert.equal(regAfter.projects[sb.slug], undefined, 'orphan entry removed');
      assert.equal(regAfter.projects[sa.slug]?.path, keep, 'live entry untouched');
      assert.ok(core2.storeBySlug(sa.slug), 'live store still loaded');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── V5: explicit fallback ────────────────────────────────────────────────

test('V5: auto-scope fallback to global is explicit; project scope still throws', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const bareCwd = join(home, 'no-root-here');

    const out = await core.remember({ content: '这条会落到全局。', scope: 'auto', cwd: bareCwd }, 'tool', 's1');
    assert.equal(out.slug, 'global');
    assert.match(out.note ?? '', /global store/, 'fallback is reported, not silent');

    await assert.rejects(
      () => core.remember({ content: '这条应该失败。', scope: 'project', cwd: bareCwd }, 'tool', 's1'),
      /dsh-memory\.json/,
      'explicit project scope throws with a remediation hint',
    );
  });
});

test('V5: brief carries the unresolved-project note only when requested', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const withNote = await T.buildBrief(core, {
      projectSlug: null,
      projectUnresolved: true,
      maxBytes: 4096,
      projectK: 5,
      globalK: 5,
    });
    assert.ok(withNote, 'brief rendered');
    assert.match(withNote, /未识别到项目根/);
    assert.match(withNote, /\.dsh-memory\.json/);

    const without = await T.buildBrief(core, {
      projectSlug: null,
      maxBytes: 4096,
      projectK: 5,
      globalK: 5,
    });
    assert.ok(without === null || !without.includes('未识别到项目根'), 'no note without the flag');
  });
});
