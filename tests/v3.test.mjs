/**
 * v3 capability tests: index v2 + self-heal, bitemporal supersede,
 * recall filters and link expansion, export/import, query-forget dry-run,
 * compaction-summary capture, the /memory command surface, and the new
 * browse routes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDshHome, waitFor } from './helpers/tmp.mjs';

const quietLogger = { info: () => {}, warn: () => {} };

function post(path, body) {
  return new Request(`http://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readAudit(home, slug) {
  const text = await readFile(join(home, 'memory', slug, 'audit.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

async function makeProject(home, name = 'fake-project') {
  const proj = join(home, name);
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, '.git'), 'fake');
  return proj;
}

// ── index v2 ───────────────────────────────────────────────────────────────

test('index v2: a v1 index (no terms) is rebuilt on first read', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await core.remember({ content: '索引格式升级测试：全局事实。', scope: 'global' }, 'tool', 's1');
    const store = core.global;
    const index = await store.rebuildIndex();
    assert.equal(index.schema, 2, 'rebuild writes schema 2');
    assert.ok(Array.isArray(index.cards[Object.keys(index.cards)[0]].terms), 'terms persisted');

    // Downgrade the on-disk index to the v1 shape.
    const raw = JSON.parse(await readFile(store.paths.index, 'utf8'));
    raw.schema = 1;
    for (const meta of Object.values(raw.cards)) {
      delete meta.terms;
      meta.tokens = 3;
    }
    await writeFile(store.paths.index, JSON.stringify(raw));
    store.invalidateIndexCache();

    const reloaded = await store.readIndex();
    assert.equal(reloaded.schema, 2, 'v1 index is upgraded by a rebuild, not served');
    assert.ok(Array.isArray(reloaded.cards[Object.keys(reloaded.cards)[0]].terms));
    const { hits } = await core.recall('索引格式升级', { scope: 'global', k: 3 });
    assert.equal(hits.length, 1, 'recall works from the rebuilt index');
    assert.ok(await readFile(store.paths.index, 'utf8').then((t) => t.includes('"terms"')));
    void home;
  });
});

test('index v2: corpus is index-backed and self-heals when a card file disappears', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card: a } = await core.remember({ content: '自愈测试：第一张卡片。', scope: 'global' }, 'tool', 's1');
    await core.remember({ content: '自愈测试：第二张卡片。', scope: 'global' }, 'tool', 's1');

    const first = await core.recall('自愈测试', { scope: 'global', k: 5 });
    assert.equal(first.counts.global, 2);

    const { rm } = await import('node:fs/promises');
    await rm(join(core.global.paths.cards, `${a.id}.md`));
    core.global.invalidateIndexCache();

    const store2 = core.storeList().find((s) => s.slug === 'global');
    const second = await core.recall('自愈测试', { scope: 'global', k: 5 });
    assert.equal(second.counts.global, 1, 'the vanished card is dropped by the disk-consistency check');
    assert.ok(!second.hits.some((h) => h.id === a.id));
    void store2;
  });
});

// ── bitemporal supersede ───────────────────────────────────────────────────

test('supersede: remember({supersedes}) stamps the old card and hides it from recall', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card: old } = await core.remember({ content: '网关生产端口是 8080。', scope: 'global' }, 'tool', 's1');
    const { card: next } = await core.remember(
      { content: '网关生产端口是 8443。', scope: 'global', supersedes: old.id },
      'tool',
      's1',
    );

    const stored = await core.global.readCard(old.id);
    assert.ok(stored.validUntil !== null, 'old card stamped validUntil');
    assert.equal(stored.supersededBy, next.id, 'old card back-links the replacement');
    assert.deepEqual(next.supersedes, [old.id], 'new card records what it supersedes');

    const { hits } = await core.recall('网关 生产端口', { scope: 'global', k: 5 });
    assert.ok(hits.some((h) => h.id === next.id), 'replacement is recalled');
    assert.ok(!hits.some((h) => h.id === old.id), 'superseded card is not recalled');

    const withHistory = await core.recall('网关 生产端口', {
      scope: 'global',
      k: 5,
      filter: { includeSuperseded: true },
    });
    assert.ok(withHistory.hits.some((h) => h.id === old.id), 'history is available on request');
    assert.equal(withHistory.hits.find((h) => h.id === old.id).supersededBy, next.id);

    const audit = await readAudit(home, 'global');
    assert.ok(audit.some((e) => e.op === 'supersede' && e.id === old.id && e.via === 'tool'));
  });
});

test('supersede: an unknown target aborts the write (nothing is stored)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await assert.rejects(
      () => core.remember({ content: '修正一个不存在的记忆。', scope: 'global', supersedes: 'm-20260101-deadbeef00' }, 'tool', 's1'),
      /supersede target not found/,
    );
    const { counts } = await core.recall('修正一个不存在的记忆', { scope: 'global', k: 5 });
    assert.equal(counts.global, 0, 'no card was written');
  });
});

test('updateCard: corrected content supersedes the original and is policy-gated', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card: original } = await core.remember(
      { content: '发布窗口是每周五下午。', kind: 'procedure', tags: ['release'], scope: 'global' },
      'tool',
      's1',
    );
    const out = await core.updateCard(
      'global',
      original.id,
      { content: '发布窗口改到每周二上午。', tags: ['release', 'schedule'], importance: 8 },
      'tool',
      's1',
      'off',
    );
    assert.ok(out !== null);
    assert.equal(out.card.kind, 'procedure', 'kind is inherited when not overridden');
    assert.equal(out.card.importance, 8);
    assert.deepEqual(out.card.tags, ['release', 'schedule']);
    const old = await core.global.readCard(original.id);
    assert.equal(old.supersededBy, out.card.id);

    const { hits } = await core.recall('发布 窗口', { scope: 'global', k: 5 });
    assert.ok(hits.some((h) => h.id === out.card.id));
    assert.ok(!hits.some((h) => h.id === original.id));

    // A blocked correction writes nothing at all.
    const { card: before } = await core.remember({ content: '密码轮换周期是 90 天。', scope: 'global' }, 'tool', 's1');
    await assert.rejects(
      () => core.updateCard('global', before.id, { content: 'password=SuperSecret123 记住它' }, 'tool', 's1', 'redact'),
      /policy violation/,
    );
    const untouched = await core.global.readCard(before.id);
    assert.equal(untouched.supersededBy, null, 'the target was not superseded');
    assert.equal(untouched.body, '', 'card body unchanged');
  });
});

// ── recall filters + link expansion ────────────────────────────────────────

test('recall filters: kind, tag, since, minImportance and includeSuperseded compose', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await core.remember({ content: '第一条：构建使用 esbuild。', kind: 'fact', tags: ['build'], importance: 3, scope: 'global' }, 'tool', 's1');
    await core.remember({ content: '第二条：部署走蓝绿发布。', kind: 'procedure', tags: ['deploy'], importance: 9, scope: 'global' }, 'tool', 's1');
    const all = await core.recall('', { scope: 'global', k: 10 });
    assert.equal(all.hits.length, 2, 'empty query ranks the whole store');

    const byKind = await core.recall('', { scope: 'global', k: 10, filter: { kinds: new Set(['procedure']) } });
    assert.equal(byKind.hits.length, 1);
    assert.equal(byKind.hits[0].kind, 'procedure');

    const byTag = await core.recall('', { scope: 'global', k: 10, filter: { tags: new Set(['deploy']) } });
    assert.equal(byTag.hits.length, 1);
    assert.deepEqual(byTag.hits[0].tags, ['deploy']);

    const byImportance = await core.recall('', { scope: 'global', k: 10, filter: { minImportance: 5 } });
    assert.equal(byImportance.hits.length, 1);
    assert.equal(byImportance.hits[0].importance, 9);

    const future = await core.recall('', { scope: 'global', k: 10, filter: { since: '2999-01-01T00:00:00.000Z' } });
    assert.equal(future.hits.length, 0, 'since filters out older cards');

    const byStore = await core.recall('', { scope: 'all', k: 10, filter: { stores: new Set(['global']) } });
    assert.equal(byStore.hits.length, 2);
    const noStore = await core.recall('', { scope: 'all', k: 10, filter: { stores: new Set(['nope']) } });
    assert.equal(noStore.hits.length, 0);
  });
});

test('recall: scope "all" reaches other project stores; the graph promotes linked cards', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const projA = await makeProject(home, 'proj-a');
    const projB = await makeProject(home, 'proj-b');
    const a = await core.projectStoreForCwd(projA);
    const b = await core.projectStoreForCwd(projB);
    await core.remember({ content: 'A 项目的构建命令是 pnpm build。', scope: 'project', cwd: projA }, 'tool', 's1');
    await core.remember({ content: 'B 项目的构建命令是 make release。', scope: 'project', cwd: projB }, 'tool', 's1');

    const scoped = await core.recall('构建命令', { scope: 'both', projectSlug: a.slug, k: 10 });
    assert.equal(scoped.hits.length, 1);
    const everything = await core.recall('构建命令', { scope: 'all', k: 10 });
    assert.equal(everything.hits.length, 2);
    assert.deepEqual(new Set(everything.hits.map((h) => h.store)), new Set([a.slug, b.slug]));

    // Graph promotion: a zero-lexical-match neighbour of a strong hit surfaces.
    const { card: seed } = await core.remember({ content: '索引重建入口是 rebuildIndex。', scope: 'global' }, 'tool', 's1');
    const { card: neighbour } = await core.remember({ content: '完全无关的说明文本，不含查询词。', scope: 'global' }, 'tool', 's1');
    await core.global.patchCard(seed.id, { links: [neighbour.id] });
    const linked = await core.recall('rebuildIndex', { scope: 'global', k: 5, expandLinks: true });
    assert.ok(linked.hits.some((h) => h.id === neighbour.id), 'linked neighbour promoted into the result');
    const unlinked = await core.recall('rebuildIndex', { scope: 'global', k: 1, expandLinks: false });
    assert.equal(unlinked.hits.length, 1, 'expansion off → only the lexical hit is ranked');
    assert.equal(unlinked.hits[0].id, seed.id);
  });
});

// ── export / import ────────────────────────────────────────────────────────

test('export/import: a bundle round-trips into a clean profile, idempotently', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const source = await T.MemoryCore.create({ logger: null });
    await source.remember({ content: '导出源：第一条记忆。', kind: 'fact', tags: ['export'], scope: 'global' }, 'tool', 's1');
    await source.remember({ content: '导出源：第二条记忆。', kind: 'commitment', scope: 'global' }, 'tool', 's1');
    const bundle = await source.exportBundle({});
    assert.equal(bundle.format, 'dsh-memory-export');
    assert.equal(bundle.schema, 2);
    assert.equal(bundle.stores.length, 1);
    assert.equal(bundle.stores[0].cards.length, 2);

    // A totally separate DSH home models a second machine.
    await withDshHome(async () => {
      const target = await T.MemoryCore.create({ logger: null });
      const first = await target.importBundle(bundle, 'user');
      assert.deepEqual(first.totals, { added: 2, skipped: 0, replaced: 0, rejected: 0 });
      const second = await target.importBundle(bundle, 'user');
      assert.deepEqual(second.totals, { added: 0, skipped: 2, replaced: 0, rejected: 0 }, 're-import is idempotent');
      const { hits } = await target.recall('导出源', { scope: 'global', k: 5 });
      assert.equal(hits.length, 2);
    });
  });
});

test('import: a bundle carrying a credential is rejected by the current policy', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const now = new Date().toISOString();
    const bundle = {
      format: 'dsh-memory-export',
      version: 1,
      exportedAt: now,
      schema: 1,
      stores: [
        {
          slug: 'global',
          kind: 'global',
          projectPath: null,
          archived: [],
          cards: [
            {
              id: 'm-20260101-aaaaaaaaaa',
              kind: 'fact',
              tags: [],
              importance: 5,
              confidence: 0.6,
              created: now,
              updated: now,
              lastAccessed: now,
              accessCount: 0,
              validSince: now,
              validUntil: null,
              supersedes: [],
              supersededBy: null,
              source: { session: 's', turn: null },
              links: [],
              title: 'deploy key',
              body: 'password=SuperSecret123',
            },
          ],
        },
      ],
    };
    const res = await core.importBundle(bundle, 'user');
    assert.equal(res.totals.rejected, 1);
    assert.match(res.stores[0].errors[0], /blocked/);
    const { counts } = await core.recall('deploy key', { scope: 'global', k: 5 });
    assert.equal(counts.global, 0, 'the credential never landed on disk');
  });
});

// ── forget safety ──────────────────────────────────────────────────────────

test('forget: a query is a dry run until confirm=true', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await core.remember({ content: '要忘记的卡片：旧部署流程说明。', scope: 'global' }, 'tool', 's1');
    const dry = await core.forget({ query: '旧部署流程' }, 'tool', 's1');
    assert.equal(dry.removed.length, 0, 'dry run removes nothing');
    assert.equal(dry.candidates.length, 1);
    assert.equal(typeof dry.candidates[0].title, 'string');
    const { counts } = await core.recall('旧部署流程', { scope: 'global', k: 5 });
    assert.equal(counts.global, 1, 'the card is still there after the dry run');

    const real = await core.forget({ query: '旧部署流程', confirm: true }, 'tool', 's1');
    assert.equal(real.removed.length, 1);
    assert.equal(real.removed[0].mode, 'archive');
  });
});

test('forget: an exact id never needs confirmation', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card } = await core.remember({ content: '按 id 删除的卡片。', scope: 'global' }, 'tool', 's1');
    const out = await core.forget({ id: card.id }, 'tool', 's1');
    assert.deepEqual(out.removed, [{ slug: 'global', id: card.id, mode: 'archive' }]);
  });
});

// ── status shape ───────────────────────────────────────────────────────────

test('status: reports totals, kind histogram and top tags without touching card files', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await core.remember({ content: '统计测试一。', kind: 'fact', tags: ['alpha', 'beta'], scope: 'global' }, 'tool', 's1');
    await core.remember({ content: '统计测试二。', kind: 'fact', tags: ['alpha'], scope: 'global' }, 'tool', 's1');
    const { card: old } = await core.remember({ content: '统计测试三。', kind: 'observation', scope: 'global' }, 'tool', 's1');
    await core.remember({ content: '统计测试四。', scope: 'global', supersedes: old.id }, 'tool', 's1');

    const report = await core.status(true);
    const g = report.stores.find((s) => s.slug === 'global');
    assert.equal(g.cards, 4, 'superseded cards still count as stored cards');
    assert.equal(g.superseded, 1);
    assert.equal(g.kinds.fact, 3, 'the replacement card is a third live fact');
    assert.equal(g.kinds.observation, undefined, 'a superseded card is not in the live histogram');
    assert.equal(g.topTags[0].tag, 'alpha');
    assert.equal(g.topTags[0].count, 2);
    assert.ok(g.bytes > 0);
    assert.equal(report.totals.cards, 4);
    assert.equal(report.totals.superseded, 1);
    assert.equal(report.schema, 2);
  });
});

// ── capture: compaction summaries + explicit mode ──────────────────────────

test('capture: a compaction summary is staged once as a summary candidate', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const listeners = new Map();
    const settings = T.defaultMemorySettings();
    T.registerCapture(
      { on: (name, fn) => listeners.set(name, fn) },
      core,
      () => settings,
      quietLogger,
      null,
    );
    const project = await makeProject(home, 'compaction-proj');
    const session = {
      id: 'sess-compact',
      header: { cwd: project, delegationDepth: 0 },
      deriveMessages: () => [],
    };
    const summary = '这是一段自动生成的会话压缩摘要，描述本次长会话的结论与后续步骤，长度足够被接受。';
    const emit = (data) => listeners.get('session/event')(session, { type: 'compaction/summary', turn: 3, data });

    emit({ summary: [{ type: 'text', text: summary }] });
    const inboxed = await waitFor(async () => (await core.projectStoreForCwd(project))?.inboxLineCount().then((n) => n >= 1), {
      timeoutMs: 5000,
    });
    assert.ok(inboxed, 'the summary reached the project inbox');

    // Identical summaries are deduped per session.
    emit({ summary: [{ type: 'text', text: summary }] });
    await new Promise((r) => setTimeout(r, 200));
    const store = await core.projectStoreForCwd(project);
    const entries = await store.readInbox(0);
    assert.equal(entries.length, 1, 'the repeat is suppressed');
    assert.equal(entries[0].kind, 'summary');
    assert.equal(entries[0].via, 'auto-compaction');
    assert.ok(entries[0].tags.includes('compaction'));

    // A DIFFERENT summary is staged.
    emit({ summary: [{ type: 'text', text: `${summary} 补充：第二阶段计划。` }] });
    await waitFor(async () => (await store.inboxLineCount()) >= 2, { timeoutMs: 5000 });
    assert.equal(await store.inboxLineCount(), 2);

    // Turning the knob off stops it.
    settings.capture.compaction = false;
    emit({ summary: [{ type: 'text', text: '第三段完全不同的压缩摘要，长度也足够被接受处理的文本内容。' }] });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await store.inboxLineCount(), 2, 'capture.compaction=false disables the path');
  });
});

test('capture: mode "explicit" never auto-captures turn text (regression)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const listeners = new Map();
    const settings = T.defaultMemorySettings();
    settings.capture.mode = 'explicit';
    T.registerCapture({ on: (name, fn) => listeners.set(name, fn) }, core, () => settings, quietLogger, null);
    const session = {
      id: 'sess-explicit',
      header: { cwd: null, delegationDepth: 0 },
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '记住：这条不该被自动捕获，因为模式是 explicit，内容也足够长。' }] },
      ],
    };
    listeners.get('session/event')(session, { type: 'turn/end', turn: 1 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await core.global.inboxLineCount(), 0, 'nothing staged in explicit mode');
  });
});

test('capture: the heuristic pass can be disabled while extraction still runs', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const listeners = new Map();
    const settings = T.defaultMemorySettings();
    settings.capture.heuristic = false;
    const llmText = '抽取出来的隐式记忆：部署流水线在每晚两点运行。';
    const llmDeps = {
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        stream() {
          const chunks = [
            { type: 'block-start', index: 0, blockType: 'text' },
            { type: 'text-delta', index: 0, text: llmText },
            { type: 'block-end', index: 0, block: { type: 'text', text: llmText } },
            { type: 'finish', reason: { kind: 'stop' } },
          ];
          let i = 0;
          return {
            [Symbol.asyncIterator]() {
              return { next: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) };
            },
          };
        },
      },
      logger: quietLogger,
      configRoute: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      route: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash', maxOutputTokens: 500, timeoutMs: 5000 }),
    };
    T.registerCapture({ on: (name, fn) => listeners.set(name, fn) }, core, () => settings, quietLogger, llmDeps);
    const session = {
      id: 'sess-heuristic-off',
      header: { cwd: null, delegationDepth: 0 },
      deriveMessages: () => [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '记住：这条会被启发式规则命中，但启发式已经关闭了，所以不应该出现。这段话故意写得很长，以便越过 capture.minTurnContentChars 的最小长度门槛（默认 120 个字符），让 LLM 抽取通道有机会运行。补充若干说明文字：本次会话讨论了部署流水线的调度方式、回滚策略、灰度发布的比例以及监控告警的阈值，这些内容仅用于把文本长度推过门槛，本身不承载额外的断言含义。',
            },
          ],
        },
      ],
    };
    listeners.get('session/event')(session, { type: 'turn/end', turn: 1 });
    const ok = await waitFor(async () => (await core.global.inboxLineCount()) >= 1, { timeoutMs: 5000 });
    assert.ok(ok, 'the LLM line was staged');
    const entries = await core.global.readInbox(0);
    assert.ok(entries.every((e) => e.via === 'auto-llm'), 'no heuristic candidates staged');
    assert.ok(entries.some((e) => e.content.includes('每晚两点')));
  });
});

// ── /memory command surface ────────────────────────────────────────────────

function makeCommandCtx(settings) {
  const registered = new Map();
  const ctx = {
    get: (name) =>
      name === 'commands'
        ? {
            register(def) {
              registered.set(def.name, def);
              return () => registered.delete(def.name);
            },
          }
        : undefined,
  };
  return { ctx, registered, settings };
}

test('commands: /memory exposes status, remember, recall, forget, dream and help', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const settings = T.defaultMemorySettings();
    const { ctx, registered } = makeCommandCtx(settings);
    const engine = new T.DreamEngine(core, () => settings, quietLogger, null);
    const dispose = T.registerMemoryCommands(ctx, core, () => settings, engine, quietLogger);
    assert.equal(typeof dispose, 'function');
    assert.deepEqual([...registered.keys()].sort(), ['memory', 'remember']);

    const invocation = { agent: { session: { id: 'sess-cmd', header: { cwd: null } } }, rawInput: '' };
    const help = await registered.get('memory').handler({ ...invocation, rawInput: 'help' });
    assert.equal(help.kind, 'success');
    assert.match(help.text, /recall/);

    const unknown = await registered.get('memory').handler({ ...invocation, rawInput: 'nope' });
    assert.equal(unknown.kind, 'error');

    const created = await registered.get('memory').handler({ ...invocation, rawInput: 'remember 命令面测试：发布窗口是周二。' });
    assert.equal(created.kind, 'success');
    assert.match(created.text, /Remembered in global/);

    const shortcut = await registered.get('remember').handler({ ...invocation, rawInput: ' 快捷方式写入的记忆内容。' });
    assert.equal(shortcut.kind, 'success');

    const recalled = await registered.get('memory').handler({ ...invocation, rawInput: 'recall 发布窗口' });
    assert.equal(recalled.kind, 'success');
    assert.match(recalled.text, /发布窗口/);

    const status = await registered.get('memory').handler({ ...invocation, rawInput: 'status' });
    assert.equal(status.kind, 'success');
    assert.match(status.text, /dsh-memory:/);

    const dream = await registered.get('memory').handler({ ...invocation, rawInput: 'dream' });
    assert.equal(dream.kind, 'success');
    assert.match(dream.text, /Dream finished/);

    const blocked = await registered.get('memory').handler({ ...invocation, rawInput: 'remember password=SuperSecret123' });
    assert.equal(blocked.kind, 'error');
    assert.match(blocked.text, /Blocked by policy/);
    assert.ok(!blocked.text.includes('SuperSecret123'), 'the command never echoes the secret');

    const empty = await registered.get('memory').handler({ ...invocation, rawInput: '' });
    assert.equal(empty.kind, 'success', 'bare /memory reports status');
    assert.match(empty.text, /dsh-memory:/);

    // forget by exact id archives
    const { card } = await core.remember({ content: '命令面遗忘目标记忆。', scope: 'global' }, 'tool', 's1');
    const forgotten = await registered.get('memory').handler({ ...invocation, rawInput: `forget ${card.id}` });
    assert.equal(forgotten.kind, 'success');
    assert.match(forgotten.text, /Archived/);

    dispose();
    assert.equal(registered.size, 0, 'disposal unregisters every command');
  });
});

test('commands: an absent commands service degrades to a warning', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const warnings = [];
    const settings = T.defaultMemorySettings();
    const engine = new T.DreamEngine(core, () => settings, quietLogger, null);
    const out = T.registerMemoryCommands(
      { get: () => undefined },
      core,
      () => settings,
      engine,
      { info: () => {}, warn: (m) => warnings.push(m) },
    );
    assert.equal(out, null);
    assert.match(warnings[0], /commands service unavailable/);
  });
});

// ── browse v3 routes ───────────────────────────────────────────────────────

test('browse v3: audit / export / remember / update / dream / import routes', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const settings = T.defaultMemorySettings();
    const engine = new T.DreamEngine(core, () => settings, quietLogger, null);
    const handlers = T.makeBrowseHandlers({
      core,
      isEnabled: () => true,
      logger: quietLogger,
      runDream: () => engine.runNow({ reason: 'client', llm: null }),
    });

    // create through the GUI route
    const created = await handlers.rememberCard(
      post('/api/memory/card/remember', { store: 'global', content: '界面创建的卡片内容。', kind: 'fact', tags: ['ui'], importance: 6 }),
    );
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.mode, 'create');

    // update → supersede
    const updated = await handlers.updateCard(
      post('/api/memory/card/update', { store: 'global', id: createdBody.id, content: '界面修正后的卡片内容。' }),
    );
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json();
    assert.equal(updatedBody.mode, 'update');
    assert.deepEqual(updatedBody.superseded, [createdBody.id]);
    const oldCard = await core.global.readCard(createdBody.id);
    assert.equal(oldCard.supersededBy, updatedBody.id);

    // update of an unknown card → 404; malformed id → 400
    assert.equal((await handlers.updateCard(post('/api/memory/card/update', { store: 'global', id: 'm-20260101-bbbbbbbbbb', content: 'x' }))).status, 404);
    assert.equal((await handlers.updateCard(post('/api/memory/card/update', { store: 'global', id: '../../etc', content: 'x' }))).status, 400);

    // policy-gated create → 400 with the pattern name, never the content
    const blocked = await handlers.rememberCard(post('/api/memory/card/remember', { store: 'global', content: 'token: ghp_abcdefghijklmnopqrstuvwx' }));
    assert.equal(blocked.status, 400);
    const blockedBody = await blocked.json();
    assert.ok(!JSON.stringify(blockedBody).includes('ghp_'), 'the secret is never echoed');

    // audit
    const audit = await handlers.audit(new Request('http://host/api/memory/audit?store=global&limit=10'));
    assert.equal(audit.status, 200);
    const auditBody = await audit.json();
    assert.ok(auditBody.entries.some((e) => e.op === 'supersede'));
    assert.ok(auditBody.entries.every((e) => typeof e.ts === 'string'));

    // export → import into the same store is idempotent
    const exported = await handlers.exportBundle(new Request('http://host/api/memory/export?store=global'));
    assert.equal(exported.status, 200);
    const bundle = await exported.json();
    assert.equal(bundle.format, 'dsh-memory-export');
    const imported = await handlers.importBundle(post('/api/memory/import', bundle));
    assert.equal(imported.status, 200);
    const importBody = await imported.json();
    assert.equal(importBody.totals.added, 0);
    assert.equal(importBody.totals.rejected, 0);
    assert.ok(importBody.totals.skipped >= 1);

    // a non-bundle body is a 400
    assert.equal((await handlers.importBundle(post('/api/memory/import', { hello: 'world' }))).status, 400);

    // dream
    const dream = await handlers.dream(post('/api/memory/dream', {}));
    assert.equal(dream.status, 200);
    const dreamBody = await dream.json();
    assert.equal(dreamBody.busy, false);

    // summary carries the v3 shape
    const summary = await handlers.summary(new Request('http://host/api/memory/summary'));
    const summaryBody = await summary.json();
    assert.equal(typeof summaryBody.totals.cards, 'number');
    assert.equal(typeof summaryBody.stores[0].superseded, 'number');
    assert.ok(Array.isArray(summaryBody.stores[0].topTags));
    assert.equal(typeof summaryBody.stores[0].bytes, 'number');
  });
});

test('browse v3: dream without a trigger degrades to 400, never a throw', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const handlers = T.makeBrowseHandlers({ core, isEnabled: () => true, logger: quietLogger });
    const res = await handlers.dream(post('/api/memory/dream', {}));
    assert.equal(res.status, 400);
  });
});

// ── rules cache ────────────────────────────────────────────────────────────

test('rules: the AGENTS.md Memory section is cached until the file changes', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const agents = join(home, 'AGENTS.md');

    const empty = await core.rulesFor('global');
    assert.deepEqual(empty.denyKeywords, []);

    await writeFile(agents, '# AGENTS\n\n## Memory\n\n### Never\n- salary\n', 'utf8');
    // Force a distinct mtime so the mtime-keyed cache cannot miss the change.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(agents, '# AGENTS\n\n## Memory\n\n### Never\n- salary\n- passport\n', 'utf8');
    const rules = await core.rulesFor('global');
    assert.deepEqual(rules.denyKeywords, ['salary', 'passport']);

    // Cached: a second call returns the same object identity.
    assert.equal(await core.rulesFor('global'), rules, 'rules are cached between calls');

    // The cache invalidates when the file changes again.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(agents, '# AGENTS\n\n## Memory\n\n### Never\n- salary\n', 'utf8');
    const again = await core.rulesFor('global');
    assert.notEqual(again, rules, 'new object after the file changed');
    assert.deepEqual(again.denyKeywords, ['salary']);
  });
});
