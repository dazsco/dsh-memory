import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDshHome } from './helpers/tmp.mjs';

const quietLogger = { info: () => {}, warn: () => {} };

/** Read a store's audit log as entries (the layout is $DSH_HOME/memory/<slug>/audit.jsonl). */
async function readAudit(home, slug) {
  const text = await readFile(join(home, 'memory', slug, 'audit.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

function post(path, body) {
  return new Request(`http://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A fake project root (with .git) under the test $DSH_HOME: cleaned up with it. */
async function makeProject(home) {
  const proj = join(home, 'fake-project');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, '.git'), 'fake');
  return proj;
}

test('browse: summary lists every store with counts; enabled flag from settings', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const proj = await makeProject(home);
    const project = await core.projectStoreForCwd(proj);
    assert.ok(project, 'project store resolves via .git walk');
    await core.remember({ content: '全局事实一：测试记忆。', scope: 'global' }, 'tool', 's1');
    await core.remember({ content: '项目事实一：测试记忆。', scope: 'project', cwd: proj }, 'tool', 's1');

    const handlers = T.makeBrowseHandlers({ core, isEnabled: () => true, logger: quietLogger });
    const res = await handlers.summary(new Request('http://host/api/memory/summary'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.lastDream, null);
    assert.equal(body.stores.length, 2);
    const global = body.stores.find((s) => s.slug === 'global');
    assert.equal(global.kind, 'global');
    assert.equal(global.cards, 1);
    assert.equal(global.projectPath, null);
    const projRow = body.stores.find((s) => s.slug === project.slug);
    assert.equal(projRow.kind, 'project');
    assert.equal(projRow.cards, 1);
    assert.equal(projRow.projectPath, proj);
    assert.ok(!('root' in global), 'on-disk root is not served');
  });
});

test('browse: summary reports enabled=false but reads are not gated', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await core.remember({ content: '全局事实一：测试记忆。', scope: 'global' }, 'tool', 's1');
    const handlers = T.makeBrowseHandlers({ core, isEnabled: () => false, logger: quietLogger });
    const res = await handlers.summary(new Request('http://host/api/memory/summary'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, false);
    assert.equal(body.stores.length, 1);
    assert.equal(body.stores[0].cards, 1);
  });
});

test('browse: cards lists in recency order, ranks by query, and pages by limit', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const first = await core.remember(
      { content: '数据库连接串用 PostgreSQL。', tags: ['db'], scope: 'global' },
      'tool',
      's1',
    );
    const second = await core.remember(
      { content: 'CI 流水线用 GitHub Actions。', tags: ['ci'], scope: 'global' },
      'tool',
      's1',
    );

    const handlers = T.makeBrowseHandlers({ core, isEnabled: () => true, logger: quietLogger });

    // no query → recency order (newest updated first), score null
    const all = await handlers.cards(new Request('http://host/api/memory/cards?store=global'));
    assert.equal(all.status, 200);
    const body = await all.json();
    assert.equal(body.store, 'global');
    assert.equal(body.total, 2);
    assert.equal(body.truncated, false);
    assert.equal(body.cards.length, 2);
    assert.equal(body.cards[0].id, second.card.id);
    assert.equal(body.cards[0].score, null);
    assert.equal(body.cards[0].tags[0], 'ci');

    // query → only matching cards, ranked, score present
    const hit = await handlers.cards(
      new Request('http://host/api/memory/cards?store=global&query=PostgreSQL'),
    );
    const hitBody = await hit.json();
    assert.equal(hitBody.total, 1);
    assert.equal(hitBody.cards[0].id, first.card.id);
    assert.ok(hitBody.cards[0].score > 0, 'BM25+tag score is positive');

    // a tag word absent from the text still surfaces the card via the tag boost
    const tagHit = await handlers.cards(
      new Request('http://host/api/memory/cards?store=global&query=db'),
    );
    const tagBody = await tagHit.json();
    assert.equal(tagBody.total, 1);
    assert.equal(tagBody.cards[0].id, first.card.id, 'tag boost alone surfaces the card');
    assert.ok(tagBody.cards[0].score > 0);

    // no match → empty, not an error
    const none = await handlers.cards(
      new Request('http://host/api/memory/cards?store=global&query=zzzqqq'),
    );
    const noneBody = await none.json();
    assert.equal(none.status, 200);
    assert.equal(noneBody.total, 0);
    assert.equal(noneBody.cards.length, 0);

    // limit pages the result
    const paged = await handlers.cards(new Request('http://host/api/memory/cards?store=global&limit=1'));
    const pagedBody = await paged.json();
    assert.equal(pagedBody.cards.length, 1);
    assert.equal(pagedBody.total, 2);
    assert.equal(pagedBody.truncated, true);
  });
});

test('browse: card detail returns the full card; unknown targets 404; bad params 400', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card } = await core.remember(
      { content: '标题行：测试卡片。\n第二行是详情。', kind: 'decision', tags: ['t'], scope: 'global' },
      'tool',
      's1',
    );
    const handlers = T.makeBrowseHandlers({ core, isEnabled: () => true, logger: quietLogger });

    const res = await handlers.card(
      new Request(`http://host/api/memory/card?store=global&id=${encodeURIComponent(card.id)}`),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.store, 'global');
    assert.equal(body.card.id, card.id);
    assert.equal(body.card.kind, 'decision');
    assert.equal(body.card.title, '标题行：测试卡片。');
    assert.equal(body.card.body, '第二行是详情。');
    assert.ok(Array.isArray(body.card.tags));
    assert.ok(typeof body.card.importance === 'number');
    assert.ok(Array.isArray(body.card.supersedes));
    assert.ok(Array.isArray(body.card.links));

    // well-formed id that does not exist → 404
    assert.equal((await handlers.card(new Request('http://host/api/memory/card?store=global&id=m-20260101-abcdef1234'))).status, 404);
    // malformed id (junk / path traversal) → 400, never a filesystem probe
    assert.equal((await handlers.card(new Request('http://host/api/memory/card?store=global&id=nope'))).status, 400);
    assert.equal((await handlers.card(new Request(`http://host/api/memory/card?store=global&id=${encodeURIComponent('../escape')}`))).status, 400);
    assert.equal((await handlers.card(new Request('http://host/api/memory/card?store=global'))).status, 400);
    assert.equal((await handlers.cards(new Request('http://host/api/memory/cards?store=ghost'))).status, 404);
    assert.equal((await handlers.cards(new Request('http://host/api/memory/cards'))).status, 400);
    assert.equal((await handlers.cards(new Request('http://host/api/memory/cards?store=global&limit=zero'))).status, 400);
    assert.equal((await handlers.inbox(new Request('http://host/api/memory/inbox?store=ghost'))).status, 404);
  });
});

test('browse: inbox lists pending captures with count and truncation', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    for (let i = 0; i < 3; i += 1) {
      await core.global.pushInbox({
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        content: `候选条目 ${i}`,
        source: { session: '', turn: null },
        via: 'auto-heuristic',
      });
    }
    const handlers = T.makeBrowseHandlers({ core, isEnabled: () => true, logger: quietLogger });

    const res = await handlers.inbox(new Request('http://host/api/memory/inbox?store=global'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 3);
    assert.equal(body.truncated, false);
    assert.equal(body.entries.length, 3);
    assert.equal(body.entries[0].content, '候选条目 0', 'file (chronological) order');

    const paged = await handlers.inbox(new Request('http://host/api/memory/inbox?store=global&limit=2'));
    const pagedBody = await paged.json();
    assert.equal(pagedBody.count, 3);
    assert.equal(pagedBody.truncated, true);
    assert.equal(pagedBody.entries.length, 2);
    assert.equal(pagedBody.entries[1].content, '候选条目 2', 'the LAST two lines, in file order');
  });
});

test('browse: registerBrowseRoutes mounts 7 exact routes (5 GET + 2 POST) on the fiber and disposes them', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await core.remember({ content: '全局事实一：测试记忆。', scope: 'global' }, 'tool', 's1');

    const registered = [];
    const connection = {
      fetch: {
        register(route) {
          registered.push(route);
          return () => {
            const i = registered.indexOf(route);
            if (i >= 0) registered.splice(i, 1);
            return Promise.resolve();
          };
        },
      },
    };
    let effectDisposer = null;
    const ctx = {
      get: (name) => (name === 'connection' ? connection : undefined),
      effect: (setup) => {
        effectDisposer = setup();
      },
    };

    T.registerBrowseRoutes(ctx, { core, isEnabled: () => true, logger: quietLogger });
    assert.equal(registered.length, 7);
    assert.deepEqual(
      registered.map((r) => r.path),
      [
        T.MEMORY_BROWSE_PATHS.summary,
        T.MEMORY_BROWSE_PATHS.cards,
        T.MEMORY_BROWSE_PATHS.card,
        T.MEMORY_BROWSE_PATHS.inbox,
        T.MEMORY_BROWSE_PATHS.archive,
        T.MEMORY_BROWSE_PATHS.forget,
        T.MEMORY_BROWSE_PATHS.restore,
      ],
    );
    assert.ok(registered.every((r) => r.requestBody === 'buffered'));
    assert.equal(registered.filter((r) => r.methods.join(',') === 'GET').length, 5);
    assert.equal(registered.filter((r) => r.methods.join(',') === 'POST').length, 2);

    // the mounted handler serves the live core
    const res = await registered[0].fetch(new Request('http://host/api/memory/summary'));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).stores.length, 1);

    // the effect disposer unwinds every registration
    assert.equal(typeof effectDisposer, 'function');
    await effectDisposer();
    assert.equal(registered.length, 0, 'fiber disposal removed all routes');
  });
});

test('browse: absent connection degrades to a warning, never throws', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const warnings = [];
    const ctx = {
      get: () => undefined,
      effect: () => {
        throw new Error('effect must not be used without a connection');
      },
    };
    assert.doesNotThrow(() =>
      T.registerBrowseRoutes(ctx, { core, isEnabled: () => true, logger: { info: () => {}, warn: (m) => warnings.push(m) } }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /connection service unavailable/);
  });
});

test('browse: a failing registration disposes partial work and warns', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const registered = [];
    const warnings = [];
    let call = 0;
    const connection = {
      fetch: {
        register(route) {
          call += 1;
          registered.push(route);
          if (call === 2) throw new Error('simulated duplicate path');
          return () => Promise.resolve();
        },
      },
    };
    const ctx = {
      get: () => connection,
      effect: () => {
        throw new Error('effect must not be registered after a failed batch');
      },
    };
    assert.doesNotThrow(() =>
      T.registerBrowseRoutes(ctx, {
        core,
        isEnabled: () => true,
        logger: { info: () => {}, warn: (m) => warnings.push(m) },
      }),
    );
    assert.equal(registered.length, 2, 'registration stopped at the failure');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /browse route registration failed/);
  });
});

test('browse v2: archive then restore round-trips, auditing via client', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card } = await core.remember(
      { content: '待归档的卡片内容。', kind: 'fact', scope: 'global' },
      'tool',
      's1',
    );
    const handlers = T.makeBrowseHandlers({ core, isEnabled: () => true, logger: quietLogger });

    // archive it
    const forgot = await handlers.forgetCard(post(T.MEMORY_BROWSE_PATHS.forget, { store: 'global', id: card.id, hard: false }));
    assert.equal(forgot.status, 200);
    assert.deepEqual(await forgot.json(), { store: 'global', id: card.id, mode: 'archive' });

    // gone from the live list; the roster now counts one archived
    const after = await (await handlers.cards(new Request('http://host/api/memory/cards?store=global'))).json();
    assert.equal(after.total, 0);
    const roster = await (await handlers.summary(new Request('http://host/api/memory/summary'))).json();
    assert.equal(roster.stores[0].archived, 1);

    // listed in the archive view with title/kind/time
    const arch = await (await handlers.archive(new Request('http://host/api/memory/archive?store=global'))).json();
    assert.equal(arch.total, 1);
    assert.equal(arch.truncated, false);
    assert.equal(arch.cards[0].id, card.id);
    assert.equal(arch.cards[0].title, '待归档的卡片内容。');
    assert.equal(arch.cards[0].kind, 'fact');
    assert.ok(arch.cards[0].archivedAt, 'archive time present');

    // restore it
    const restored = await handlers.restoreCard(post(T.MEMORY_BROWSE_PATHS.restore, { store: 'global', id: card.id }));
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), { store: 'global', id: card.id, mode: 'restore' });

    const back = await (await handlers.cards(new Request('http://host/api/memory/cards?store=global'))).json();
    assert.equal(back.total, 1);
    assert.equal(back.cards[0].id, card.id);
    const archAfter = await (await handlers.archive(new Request('http://host/api/memory/archive?store=global'))).json();
    assert.equal(archAfter.total, 0);
    const rosterAfter = await (await handlers.summary(new Request('http://host/api/memory/summary'))).json();
    assert.equal(rosterAfter.stores[0].archived, 0);

    // the full card content survived the round trip (single-line content lives in the title)
    const detail = await (await handlers.card(new Request(`http://host/api/memory/card?store=global&id=${card.id}`))).json();
    assert.equal(detail.card.title, '待归档的卡片内容。');

    // audit carries both ops, both via the client
    const audit = await readAudit(home, 'global');
    const byOp = new Map(audit.map((e) => [e.op, e]));
    assert.equal(byOp.get('archive')?.id, card.id);
    assert.equal(byOp.get('archive')?.via, 'client');
    assert.equal(byOp.get('restore')?.id, card.id);
    assert.equal(byOp.get('restore')?.via, 'client');
  });
});

test('browse v2: hard delete is permanent (not recoverable) and audits', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const { card } = await core.remember({ content: '将被删除的内容。', scope: 'global' }, 'tool', 's1');
    const handlers = T.makeBrowseHandlers({ core, isEnabled: () => true, logger: quietLogger });

    const gone = await handlers.forgetCard(post(T.MEMORY_BROWSE_PATHS.forget, { store: 'global', id: card.id, hard: true }));
    assert.equal(gone.status, 200);
    assert.deepEqual(await gone.json(), { store: 'global', id: card.id, mode: 'hard-delete' });

    const live = await (await handlers.cards(new Request('http://host/api/memory/cards?store=global'))).json();
    assert.equal(live.total, 0);
    const arch = await (await handlers.archive(new Request('http://host/api/memory/archive?store=global'))).json();
    assert.equal(arch.total, 0, 'hard delete leaves nothing to restore');

    // restoring a hard-deleted card is a 404
    assert.equal(
      (await handlers.restoreCard(post(T.MEMORY_BROWSE_PATHS.restore, { store: 'global', id: card.id }))).status,
      404,
    );

    const audit = await readAudit(home, 'global');
    const byOp = new Map(audit.map((e) => [e.op, e]));
    assert.equal(byOp.get('hard-delete')?.id, card.id);
    assert.equal(byOp.get('hard-delete')?.via, 'client');
    assert.equal(byOp.get('restore'), undefined, 'no restore op was recorded');
  });
});

test('browse v2: mutations are strictly store-scoped and reject bad input', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const handlers = T.makeBrowseHandlers({ core, isEnabled: () => true, logger: quietLogger });
    const { card } = await core.remember({ content: '全局卡片。', scope: 'global' }, 'tool', 's1');

    // unknown card (well-formed id) → 404, no fall-through to other stores
    assert.equal(
      (await handlers.forgetCard(post(T.MEMORY_BROWSE_PATHS.forget, { store: 'global', id: 'm-00000000-aaaaaaaa' }))).status,
      404,
    );
    // a global card addressed against the ghost store → 404 (strict scoping)
    assert.equal(
      (await handlers.forgetCard(post(T.MEMORY_BROWSE_PATHS.forget, { store: 'ghost', id: card.id }))).status,
      404,
    );
    // restore of a LIVE card (never archived) → 404
    assert.equal(
      (await handlers.restoreCard(post(T.MEMORY_BROWSE_PATHS.restore, { store: 'global', id: card.id }))).status,
      404,
    );
    // bad bodies → 400
    assert.equal((await handlers.forgetCard(post(T.MEMORY_BROWSE_PATHS.forget, { store: 'global' }))).status, 400, 'missing id');
    assert.equal((await handlers.forgetCard(post(T.MEMORY_BROWSE_PATHS.forget, { store: 'global', id: 'nope' }))).status, 400, 'malformed id');
    assert.equal((await handlers.forgetCard(post(T.MEMORY_BROWSE_PATHS.forget, 'not json'))).status, 400, 'non-JSON body');
    assert.equal((await handlers.forgetCard(post(T.MEMORY_BROWSE_PATHS.forget, ''))).status, 400, 'empty body');
    assert.equal((await handlers.restoreCard(post(T.MEMORY_BROWSE_PATHS.restore, '["arr"]'))).status, 400, 'array body');
    // unknown store on the archive listing → 404
    assert.equal((await handlers.archive(new Request('http://host/api/memory/archive?store=ghost'))).status, 404);
    // the original card survived all the failed attempts
    const live = await (await handlers.cards(new Request('http://host/api/memory/cards?store=global'))).json();
    assert.equal(live.total, 1);
    assert.equal(live.cards[0].id, card.id);
  });
});
