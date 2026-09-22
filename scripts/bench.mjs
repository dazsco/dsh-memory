/**
 * dsh-memory benchmark (development only — not part of the published bundle).
 *
 *   npm run bench              # N = 2000 cards, current code
 *   npm run bench -- 3000      # larger store
 *   npm run bench -- 800 --old # also reproduce the PRE-0.4.0 hot shapes
 *
 * `--old` reimplements the shapes that made a grown store slow (the unbounded
 * MMR over the whole candidate set, the all-pairs relink scan) so the fix can
 * be measured rather than asserted. It is skipped above N = 1200 because the
 * unbounded MMR is effectively cubic: at 1000 cards it already takes minutes.
 *
 * The benchmark never touches your real store — it runs against a throwaway
 * $DSH_HOME under the OS temp directory. It imports `lib/testing.js`, so run
 * `npm run build` first.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 2000);
const withOld = args.includes('--old');
const OLD_LIMIT = 1200;
const runOld = withOld && N <= OLD_LIMIT;

const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-bench-'));
process.env.DSH_HOME = dir;
const T = await import('../lib/testing.js');

const iso = () => new Date().toISOString();

/** A realistic card: a CJK title/body pair (~60 tokens) plus a few tags. */
function card(i) {
  return {
    id: T.makeCardId(),
    kind: 'fact',
    tags: ['deploy', 'release', `group-${i % 6}`],
    importance: 5,
    confidence: 0.6,
    created: iso(),
    updated: iso(),
    lastAccessed: iso(),
    accessCount: 0,
    validSince: iso(),
    validUntil: null,
    supersedes: [],
    supersededBy: null,
    source: { session: 'bench', turn: null },
    links: [],
    title: `服务 ${i} 的部署流水线使用 GitHub Actions 与数据库连接池`,
    body: `该服务在第 ${i} 号环境运行，连接池大小 20，缓存 TTL 300 秒，发布窗口为每周五下午，健康检查路径 /health。`,
  };
}

const ms = (t) => `${Date.now() - t}ms`;
const rows = [];
const record = (label, value) => {
  rows.push([label, value]);
  console.log(`  ${label.padEnd(46)} ${value}`);
};

console.log(`\ndsh-memory benchmark — N=${N} cards${runOld ? ' (with pre-0.4.0 shapes)' : ''}\n`);

const core = await T.MemoryCore.create({ logger: null });
const store = core.global;
for (let i = 0; i < N; i++) await T.writeCardFile(store.paths.cards, card(i));

let t = Date.now();
await store.rebuildIndex();
record('rebuildIndex (O(N) card reads)', ms(t));

// ── recall: the read path the agent and the session brief hit ─────────────
const recalls = [];
for (let i = 0; i < 5; i++) {
  t = Date.now();
  const { hits } = await core.recall('部署流水线 数据库连接池', { scope: 'global', k: 8 });
  recalls.push(Date.now() - t);
  if (hits.length !== 8) throw new Error(`expected 8 hits, got ${hits.length}`);
}
record('core.recall ×5 (min…max)', `${Math.min(...recalls)}…${Math.max(...recalls)}ms`);

// ── the MMR shape: bounded pool+k vs the old full ranking ────────────────
const index = await store.readIndex();
const corpus = await store.cardCorpus();
const queryTokens = T.tokenize('部署流水线 数据库连接池');
const now = new Date();
const scored = [];
for (const [id, entry] of corpus) {
  const rel = T.bm25Score(queryTokens, entry.tokens, index.bm25.df, index.bm25.docCount, index.bm25.avgDocLen);
  scored.push({
    id,
    store: 'global',
    meta: entry.meta,
    tokens: entry.tokens,
    score: T.compositeScore(rel > 0 ? 1 : 0, entry.meta.importance, T.cardRecency(entry.meta.lastAccessed, now), T.cardStrength(entry.meta.accessCount, entry.meta.updated, now), entry.meta.confidence),
  });
}
t = Date.now();
T.rankWithMmr(T.mmrPool(scored, 8), 0.3, 8);
record('MMR bounded (pool + k rounds)', ms(t));
if (runOld) {
  t = Date.now();
  T.rankWithMmr(scored).slice(0, 8);
  record('MMR OLD (rank the whole corpus)', ms(t));
} else if (withOld) {
  record('MMR OLD (rank the whole corpus)', `skipped above N=${OLD_LIMIT}`);
}

// ── relink shape: tag inverted index vs the old all-pairs scan ───────────
const entries = [...corpus.entries()].filter(([, c]) => c.meta.validUntil === null);
const tokenSets = new Map(entries.map(([id, c]) => [id, new Set(c.tokens)]));
const byTag = new Map();
for (const [id, c] of entries) {
  for (const tag of c.meta.tags) {
    const list = byTag.get(tag);
    if (list === undefined) byTag.set(tag, [id]);
    else list.push(id);
  }
}
t = Date.now();
let newLinks = 0;
for (const [id, c] of entries) {
  const shared = new Map();
  for (const tag of c.meta.tags) {
    for (const oid of byTag.get(tag) ?? []) {
      if (oid === id) continue;
      shared.set(oid, (shared.get(oid) ?? 0) + 1);
    }
  }
  const cSet = tokenSets.get(id);
  newLinks += [...shared.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 64)
    .map(([oid, n]) => ({ oid, score: n * 10 + T.jaccard(cSet, tokenSets.get(oid)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5).length;
}
record('relink NEW (tag inverted index)', `${ms(t)} (${newLinks} links)`);
if (runOld) {
  t = Date.now();
  let oldLinks = 0;
  for (const [id, c] of entries) {
    oldLinks += entries
      .filter(([oid]) => oid !== id)
      .map(([oid, o]) => ({
        oid,
        shared: c.meta.tags.filter((tg) => o.meta.tags.includes(tg)).length,
        sim: T.jaccard(new Set(c.tokens), new Set(o.tokens)),
      }))
      .filter((x) => x.shared >= 2)
      .sort((a, b) => b.shared * 10 + b.sim - (a.shared * 10 + a.sim))
      .slice(0, 5).length;
  }
  record('relink OLD (all-pairs scan)', `${ms(t)} (${oldLinks} links)`);
} else if (withOld) {
  record('relink OLD (all-pairs scan)', `skipped above N=${OLD_LIMIT}`);
}

// ── write path: one explicit remember ────────────────────────────────────
t = Date.now();
await store.putCard(card(999_999));
record('putCard (incremental index write)', ms(t));
t = Date.now();
await store.rebuildIndex();
record('rebuildIndex again (for comparison)', ms(t));

// ── Dream: consolidation over the whole store ────────────────────────────
const engine = new T.DreamEngine(core, () => T.defaultMemorySettings(), null, null);
for (let run = 1; run <= 3; run++) {
  t = Date.now();
  const r = await engine.runNow({ reason: 'bench' });
  const g = r.stores[0];
  record(
    `Dream run #${run}`,
    `${ms(t)}  relinked=${g.relinked} archived=${g.archived} pruned=${g.pruned}`,
  );
}

const live = Object.keys((await store.readIndex()).cards).length;
record('live cards after maintenance', String(live));

console.log('\nnote: the first Dream writes every card\'s links once (capped per run) and\n' +
  'archives cards past maintenance.maxLiveCards; later runs are the steady state.\n');

await rm(dir, { recursive: true, force: true });
