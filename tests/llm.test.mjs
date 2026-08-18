import test from 'node:test';
import assert from 'node:assert/strict';
import { withDshHome } from './helpers/tmp.mjs';
import * as T from '../lib/testing.js';

// ── parsing (pure) ───────────────────────────────────────────────────────────

test('parseLlmMemoryLines: clean, marked, quoted, NONE, bounds, dedupe', () => {
  const text = [
    'NONE',
    '',
    '记住：网关端口是 8443。',
    '- 以后都要先跑回归测试再发布。',
    '3. 项目使用 pnpm 而不是 npm。',
    '「团队约定：PR 必须两个评审人批准。」',
    '短',
    'x'.repeat(500),
    '记住：网关端口是 8443。',
  ].join('\n');
  const lines = T.parseLlmMemoryLines(text);
  assert.deepEqual(lines, [
    '记住：网关端口是 8443。',
    '以后都要先跑回归测试再发布。',
    '项目使用 pnpm 而不是 npm。',
    '团队约定：PR 必须两个评审人批准。',
  ]);
});

test('parseLlmMemoryLines: empty and NONE-only replies', () => {
  assert.deepEqual(T.parseLlmMemoryLines(''), []);
  assert.deepEqual(T.parseLlmMemoryLines('NONE'), []);
  assert.deepEqual(T.parseLlmMemoryLines('  none  '), []);
});

test('classifyLlmLine: preference vs fact', () => {
  assert.equal(T.classifyLlmLine('我的偏好是使用 pnpm 管理依赖'), 'preference');
  assert.equal(T.classifyLlmLine('Always run the full test suite before release'), 'preference');
  assert.equal(T.classifyLlmLine('网关的生产端口是 8443'), 'fact');
});

test('parseSummaryText: trim, NONE, cap', () => {
  assert.equal(T.parseSummaryText('NONE'), null);
  assert.equal(T.parseSummaryText(''), null);
  assert.equal(T.parseSummaryText('  这是概览。  '), '这是概览。');
  const long = 'x'.repeat(2000);
  assert.equal(T.parseSummaryText(long, 100).length, 100);
});

test('parseConflictDecisions: valid a/b/both, malformed skipped', () => {
  const pairs = [
    { a: { id: 'ma', kind: 'fact', title: 'A', body: 'a', importance: 5 }, b: { id: 'mb', kind: 'fact', title: 'B', body: 'b', importance: 5 }, similarity: 0.5 },
    { a: { id: 'mc', kind: 'fact', title: 'C', body: 'c', importance: 5 }, b: { id: 'md', kind: 'fact', title: 'D', body: 'd', importance: 5 }, similarity: 0.5 },
  ];
  const d = T.parseConflictDecisions('G1 mb\nG2 both\n垃圾行\nG9 ma\nG1 ma', pairs);
  assert.equal(d.get(0), 'b');
  assert.equal(d.get(1), 'both');
  assert.equal(d.has(8), false);
  assert.equal(d.get(0), 'b', 'first decision for a group wins');
});

test('parseConflictDecisions: tolerant of live-model format drift', () => {
  const full = [
    { a: { id: 'm-20260818-1e496c5f28', kind: 'fact', title: 'A', body: 'a', importance: 5 }, b: { id: 'm-20260818-34956a94b9', kind: 'fact', title: 'B', body: 'b', importance: 5 }, similarity: 0.4 },
    { a: { id: 'm-20260818-0a5170c523', kind: 'fact', title: 'C', body: 'c', importance: 5 }, b: { id: 'm-20260818-b4dacbb0e1', kind: 'fact', title: 'D', body: 'd', importance: 5 }, similarity: 0.3 },
    { a: { id: 'm-20260818-cafef00d11', kind: 'fact', title: 'E', body: 'e', importance: 5 }, b: { id: 'm-20260818-deadbeef22', kind: 'fact', title: 'F', body: 'f', importance: 5 }, similarity: 0.35 },
  ];
  // prefix-less suffix id / colon + trailing punctuation / bare A letter
  const d = T.parseConflictDecisions('G1 1e496c5f28\nG2: b4dacbb0e1.\nG3 A', full);
  assert.equal(d.get(0), 'a', 'suffix id keeps A');
  assert.equal(d.get(1), 'b', 'colon + trailing dot still parses to B');
  assert.equal(d.get(2), 'a', 'bare A letter keeps A');
  // junk shorter than 8 chars must not alias any id
  const junk = T.parseConflictDecisions('G1 1e496c5\nG2 both', full);
  assert.equal(junk.has(0), false, '7-char junk does not match');
  assert.equal(junk.get(1), 'both');
});

// ── callMemoryLlm (fake service, real assembler) ─────────────────────────────

function textChunks(text, finish = { kind: 'stop' }) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: finish },
  ];
}

function fakeLlm(chunksFor, record) {
  return {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    stream(options) {
      record?.(options);
      const provider = Promise.resolve(chunksFor(options));
      return {
        [Symbol.asyncIterator]() {
          let chunks = null;
          let i = 0;
          return {
            async next() {
              if (chunks === null) chunks = await provider;
              if (i >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: chunks[i++] };
            },
          };
        },
      };
    },
  };
}

const baseDeps = {
  configRoute: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  route: () => ({ provider: '', model: '', maxOutputTokens: 300, timeoutMs: 5000 }),
};

test('callMemoryLlm: no-service degrades', async () => {
  const r = await T.callMemoryLlm({ ...baseDeps, llm: null }, { system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-service');
});

test('callMemoryLlm: unregistered provider degrades', async () => {
  const deps = {
    ...baseDeps,
    route: () => ({ provider: 'openai', model: 'gpt', maxOutputTokens: 300, timeoutMs: 5000 }),
    llm: fakeLlm(() => textChunks('x')),
  };
  const r = await T.callMemoryLlm(deps, { system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unregistered');
});

test('callMemoryLlm: settings route overrides the composition route', async () => {
  let seen = null;
  const deps = {
    ...baseDeps,
    route: () => ({ provider: 'deepseek', model: 'deepseek-v4-pro', maxOutputTokens: 222, timeoutMs: 5000 }),
    llm: fakeLlm(() => textChunks('记住：测试。'), (o) => {
      seen = o;
    }),
  };
  const r = await T.callMemoryLlm(deps, { system: 'sys', user: 'user' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '记住：测试。');
  assert.equal(r.route.model, 'deepseek-v4-pro');
  assert.equal(seen.maxTokens, 222);
  assert.equal(seen.system, 'sys');
  assert.ok(seen.signal instanceof AbortSignal);
});

test('callMemoryLlm: error finish becomes a failure', async () => {
  const deps = {
    ...baseDeps,
    llm: fakeLlm(() => textChunks('', { kind: 'error', failure: { message: 'boom', code: 'E500' } })),
  };
  const r = await T.callMemoryLlm(deps, { system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
  assert.match(r.message, /boom/);
});

test('callMemoryLlm: max-tokens finish salvages the partial text', async () => {
  const partial = '第一条记忆行：团队约定用 pnpm。\n第二条记忆行被截';
  const deps = {
    ...baseDeps,
    llm: fakeLlm(() => textChunks(partial, { kind: 'max-tokens' })),
  };
  const r = await T.callMemoryLlm(deps, { system: 's', user: 'u' });
  assert.equal(r.ok, true, 'truncated reply is salvageable, not a failure');
  assert.equal(r.truncated, true);
  assert.equal(r.text, partial);
  // The salvage path keeps producing parseable candidate lines.
  const lines = T.parseLlmMemoryLines(r.text);
  assert.ok(lines.length >= 1, 'at least the complete leading line is recovered');
  assert.match(lines[0], /pnpm/);
});

test('callMemoryLlm: deadline abort maps to timeout', async () => {
  const deps = {
    ...baseDeps,
    route: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash', maxOutputTokens: 100, timeoutMs: 40 }),
    llm: fakeLlm((options) =>
      new Promise((resolve) => {
        const t = setInterval(() => {
          if (options.signal.aborted) {
            clearInterval(t);
            resolve(textChunks('', { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } }));
          }
        }, 5);
      }),
    ),
  };
  const r = await T.callMemoryLlm(deps, { system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
});

test('callMemoryLlm: stalled stream (no chunks, no close, signal ignored) is still bounded', async () => {
  // The observed production failure: the ztu-ai endpoint dropped mid-stream;
  // the for-await then suspended forever because throwIfAborted only runs
  // when a chunk arrives. The drain must race against the deadline.
  const started = Date.now();
  const deps = {
    ...baseDeps,
    route: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash', maxOutputTokens: 100, timeoutMs: 40 }),
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise(() => {}), // never resolves: no chunks, no close
              return: () => Promise.resolve({ done: true, value: undefined }),
            };
          },
        };
      },
    },
  };
  const r = await T.callMemoryLlm(deps, { system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.ok(Date.now() - started < 2000, `stalled stream must be bounded by the deadline, took ${Date.now() - started}ms`);
});

test('callMemoryLlm: per-request maxOutputTokens override wins', async () => {
  let seen = null;
  const deps = {
    ...baseDeps,
    llm: fakeLlm(() => textChunks('x'), (o) => {
      seen = o;
    }),
  };
  await T.callMemoryLlm(deps, { system: 's', user: 'u', maxOutputTokens: 77 });
  assert.equal(seen.maxTokens, 77);
});

// ── Dream LLM passes (real engine + store, fake Llm) ─────────────────────────

// Eight mutually disjoint filler sentences (pairwise Jaccard < 0.3), so a
// store of these plus a dedicated pair yields exactly ONE conflict pair.
const FILLER_BODIES = [
  '数据库连接池上限设为两百个。',
  '缓存层默认采用本地内存模式。',
  '部署脚本需要先在 staging 环境演练。',
  '监控告警阈值调整到百分之九十五。',
  '日志保留周期为三十天滚动删除。',
  '密钥轮换周期是九十天自动执行。',
  '测试数据生成器使用固定随机种子。',
  '接口幂等键由客户端提供。',
];

function makeCard(i, body) {
  const ts = new Date().toISOString();
  return {
    id: T.makeCardId(new Date()),
    kind: 'fact',
    tags: ['gw', `t${i}`],
    importance: 6,
    confidence: 0.5,
    created: ts,
    updated: ts,
    lastAccessed: ts,
    accessCount: 0,
    validSince: ts,
    validUntil: null,
    supersedes: [],
    source: { session: 'test', turn: null },
    links: [],
    title: `记忆卡片 ${i}`,
    body,
  };
}

function cardTokens(c) {
  return new Set(T.tokenize(`${c.title}\n${c.body}`));
}

test('dream llm: summarize pass writes summary.md (budget 1 call)', async () => {
  await withDshHome(async (home) => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const core = await T.MemoryCore.create({ logger: null });
    const cards = FILLER_BODIES.map((b, i) => makeCard(i, b));
    for (const c of cards) await core.global.putCard(c);
    await core.global.rebuildIndex();
    // fixture sanity: no accidental conflict pair among fillers
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const jacc = T.jaccard(cardTokens(cards[i]), cardTokens(cards[j]));
        assert.ok(jacc < 0.3, `filler ${i}/${j} unexpectedly similar (${jacc.toFixed(2)})`);
      }
    }

    const s = T.defaultMemorySettings();
    s.dream.maxLlmCalls = 1;
    const engine = new T.DreamEngine(core, () => s, null);
    let calls = 0;
    const fakeLlm = {
      calls: { n: 0 },
      async call(req) {
        calls++;
        fakeLlm.calls.n++;
        if (req.system === T.DREAM_SUMMARIZE_SYSTEM) return '  这是记忆库概览：网关配置与团队约定。  ';
        return 'G1 both';
      },
    };
    const res = await engine.runNow({ reason: 'test', llm: fakeLlm });
    assert.equal(res.busy, false);
    assert.equal(res.stores[0].error, undefined);
    assert.equal(calls, 1, 'summarize only (no conflict pairs)');
    assert.equal(res.llmCalls, 1);
    const sumPath = join(home, 'memory', 'global', 'dream', 'summary.md');
    const sum = readFileSync(sumPath, 'utf8');
    assert.ok(sum.includes('这是记忆库概览'), 'summary file carries the model text');
    assert.ok(res.stores[0].notes.some((n) => n.includes('llm-summarize: overview written')));
  });
});

test('dream llm: conflict pass archives the loser on keep decision', async () => {
  await withDshHome(async (home) => {
    const { join } = await import('node:path');
    const core = await T.MemoryCore.create({ logger: null });
    // two cards with Jaccard in the open [0.3, 0.85) band (only 8443/9000 differ)
    const cardA = makeCard(1, 'API 网关生产端口是 8443，使用 TLS 终结。');
    const cardB = makeCard(2, 'API 网关生产端口是 9000，使用 TLS 终结。');
    const j = T.jaccard(cardTokens(cardA), cardTokens(cardB));
    assert.ok(j >= 0.3 && j < 0.85, `fixture pair out of band (${j.toFixed(2)})`);
    await core.global.putCard(cardA);
    await core.global.putCard(cardB);
    // six disjoint fillers so the store has 8 cards and exactly one conflict pair
    for (let i = 10; i < 16; i++) await core.global.putCard(makeCard(i, FILLER_BODIES[i - 10]));
    await core.global.rebuildIndex();

    const s = T.defaultMemorySettings();
    s.dream.maxLlmCalls = 4;
    const engine = new T.DreamEngine(core, () => s, null);
    const fakeLlm = {
      calls: { n: 0 },
      async call(req) {
        fakeLlm.calls.n++;
        if (req.system === T.DREAM_SUMMARIZE_SYSTEM) return '概览文本。';
        // keep cardA, archive cardB
        return `G1 ${cardA.id}`;
      },
    };
    const res = await engine.runNow({ reason: 'test', llm: fakeLlm });
    assert.equal(res.stores[0].error, undefined);
    assert.equal(res.stores[0].archived, 1, 'conflict loser archived');
    const { existsSync } = await import('node:fs');
    const { readFile } = await import('node:fs/promises');
    const cardAfter = await core.global.readCard(cardB.id);
    assert.equal(cardAfter, null, 'loser removed from live cards');
    assert.ok(existsSync(join(home, 'memory', 'global', 'archive', `${cardB.id}.md`)), 'loser moved to archive/');
    const audit = await readFile(join(home, 'memory', 'global', 'audit.jsonl'), 'utf8');
    assert.ok(audit.includes('"via":"dream-llm"'), 'audit records dream-llm via');
    assert.ok(res.stores[0].notes.some((n) => n.startsWith('llm-conflict: archive ')));
  });
});

test('dream llm: budget exhaustion stops further passes', async () => {
  await withDshHome(async () => {
    const core = await T.MemoryCore.create({ logger: null });
    const cardA = makeCard(1, 'API 网关生产端口是 8443，使用 TLS 终结。');
    const cardB = makeCard(2, 'API 网关生产端口是 9000，使用 TLS 终结。');
    const j = T.jaccard(cardTokens(cardA), cardTokens(cardB));
    assert.ok(j >= 0.3 && j < 0.85, `fixture pair out of band (${j.toFixed(2)})`);
    await core.global.putCard(cardA);
    await core.global.putCard(cardB);
    for (let i = 10; i < 16; i++) await core.global.putCard(makeCard(i, FILLER_BODIES[i - 10]));
    await core.global.rebuildIndex();

    const deps = {
      llm: fakeLlm(() => textChunks('x')),
      logger: null,
      configRoute: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      route: () => ({ provider: '', model: '', maxOutputTokens: 100, timeoutMs: 5000 }),
    };
    const s = T.defaultMemorySettings();
    s.dream.maxLlmCalls = 1;
    const engine = new T.DreamEngine(core, () => s, null, deps);
    const adapter = engine.llmForRun();
    assert.ok(adapter !== null, 'adapter present when useLlm is on');
    const res = await engine.runNow({ reason: 'test', llm: adapter });
    assert.equal(res.stores[0].error, undefined);
    assert.equal(res.llmCalls, 1, 'only the first pass fits the budget');
    assert.ok(res.stores[0].notes.some((n) => n.includes('llm-conflict: no reply')), 'second pass saw an exhausted budget');
  });
});

test('dream llm: useLlm off or missing service → null adapter', async () => {
  await withDshHome(async () => {
    const core = await T.MemoryCore.create({ logger: null });
    const s = T.defaultMemorySettings();
    const deps = {
      llm: null,
      logger: null,
      configRoute: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      route: () => ({ provider: '', model: '', maxOutputTokens: 100, timeoutMs: 5000 }),
    };
    const engine = new T.DreamEngine(core, () => s, null, deps);
    assert.equal(engine.llmForRun(), null, 'no service → null');
    const s2 = T.defaultMemorySettings();
    s2.dream.useLlm = false;
    const engine2 = new T.DreamEngine(core, () => s2, null, { ...deps, llm: fakeLlm(() => textChunks('x')) });
    assert.equal(engine2.llmForRun(), null, 'useLlm off → null');
  });
});
