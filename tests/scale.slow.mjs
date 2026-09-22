/**
 * Scale guards: the shapes that made memory feel progressively slower.
 *
 * These are deliberately generous on wall-clock time (they run on whatever
 * machine CI provides) — they exist to catch a return of the O(N²) shapes, not
 * to benchmark. The structural assertions are the strict part.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDshHome } from './helpers/tmp.mjs';

const iso = (d = new Date()) => d.toISOString();

function card(over = {}) {
  const ts = iso();
  return {
    id: over.id,
    kind: 'fact',
    tags: over.tags ?? [],
    importance: 5,
    confidence: 0.6,
    created: ts,
    updated: over.updated ?? ts,
    lastAccessed: over.lastAccessed ?? ts,
    accessCount: 0,
    validSince: ts,
    validUntil: null,
    supersedes: [],
    supersededBy: null,
    source: { session: 's', turn: null },
    links: [],
    title: over.title,
    body: over.body ?? '',
  };
}

test('scale: the MMR pool and selection loop are bounded by k', async () => {
  const T = await import('../lib/testing.js');
  const candidates = [];
  for (let i = 0; i < 3000; i++) {
    candidates.push({
      id: `c${i}`,
      store: 'global',
      meta: {},
      tokens: T.tokenize(`记忆条目 ${i} 部署流水线 数据库连接池 配置`),
      score: 1 - i / 4000,
    });
  }
  const pool = T.mmrPool(candidates, 8);
  assert.equal(pool.length, T.MMR_POOL_MIN, 'the ranking pool is cut to the bound');
  assert.equal(pool[0].id, 'c0', 'the cut keeps the best-scoring candidates');

  const ranked = T.rankWithMmr(pool, 0.3, 8);
  assert.equal(ranked.length, 8, 'the greedy loop stops after k selections');

  // The pre-existing contract (no limit) still ranks everything it is given.
  const all = T.rankWithMmr(candidates.slice(0, 40));
  assert.equal(all.length, 40);
});

test('scale: recall over a 1500-card store is bounded and still correct', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    const now = Date.now();
    for (let i = 0; i < 1500; i++) {
      await T.writeCardFile(
        store.paths.cards,
        card({
          id: T.makeCardId(),
          title: `扩展测试记忆 ${i}：服务 ${i} 的部署流水线使用 GitHub Actions 与数据库连接池`,
          body: `该服务在第 ${i} 号环境运行，连接池大小 20，缓存 TTL 300 秒，发布窗口为每周五下午。`,
          tags: ['deploy', `svc-${i % 20}`],
          updated: new Date(now - i * 3_600_000).toISOString(),
          lastAccessed: new Date(now - i * 3_600_000).toISOString(),
        }),
      );
    }
    await store.rebuildIndex();

    const t0 = Date.now();
    const { hits, counts } = await core.recall('部署流水线 数据库连接池', { scope: 'global', k: 8 });
    const ms = Date.now() - t0;
    assert.equal(counts.global, 1500);
    assert.equal(hits.length, 8, 'recall returns exactly k hits from a large corpus');
    assert.ok(hits.every((h) => h.title.length > 0));
    assert.ok(ms < 8000, `recall over 1500 cards took ${ms}ms`);
  });
});

test('scale: Dream over a 1000-card store relinks through shared tags within budget', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const store = core.global;
    const now = Date.now();
    // Every card shares `deploy` + `release`, i.e. every pair is a relink
    // candidate — the worst case the old all-pairs scan had to walk.
    for (let i = 0; i < 1000; i++) {
      await T.writeCardFile(
        store.paths.cards,
        card({
          id: T.makeCardId(),
          title: `集群记忆 ${i}：部署与发布流程`,
          body: `第 ${i} 号服务使用容器镜像发布，健康检查路径为 /health，回滚窗口十五分钟。`,
          tags: ['deploy', 'release', `group-${i % 6}`],
          updated: new Date(now - i * 60_000).toISOString(),
          lastAccessed: new Date(now - i * 60_000).toISOString(),
        }),
      );
    }
    await store.rebuildIndex();

    const settings = T.defaultMemorySettings();
    const t0 = Date.now();
    const engine = new T.DreamEngine(core, () => settings, null, null);
    const r = await engine.runNow({ reason: 'scale' });
    const ms = Date.now() - t0;
    const g = r.stores.find((s) => s.slug === 'global');
    assert.equal(g.error, undefined);
    assert.ok(g.relinked > 0, 'the relink pass ran');
    assert.ok(ms < 20_000, `Dream over 1000 cards took ${ms}ms`);

    const index = await store.readIndex();
    const live = Object.values(index.cards).filter((m) => m.validUntil === null);
    assert.equal(live.length, 1000);
    assert.ok(live.every((m) => m.links.length <= 5), 'links stay capped at 5 per card');
    // A link may only point at a live card (history never re-enters the graph).
    const liveIds = new Set(Object.keys(index.cards));
    assert.ok(live.every((m) => m.links.every((id) => liveIds.has(id))));
  });
});
