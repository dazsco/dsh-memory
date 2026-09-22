import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withDshHome, waitFor } from './helpers/tmp.mjs';
import { defaultMemorySettings } from '../lib/testing.js';

/**
 * E2E wiring test: apply() against a fake cordis Context (structural fakes for
 * the tools registry, event bus, and fiber timers) plus a fake live Config.
 * This verifies registration, tool execution, capture → inbox → Dream, brief
 * injection, and the global kill switch — without a live dsh host.
 *
 * The architecture is DSH 0.1.7's: the plugin's settings ARE its Config, read
 * through volatile references, and a committed edit reaches the owning fiber
 * as `loader/volatile-update`. `state.settings` is the plain value those
 * references resolve to, so a test flips a knob by assigning it.
 */
function makeFakeCtx(state) {
  const timers = {
    timeout: (fn, _ms) => {
      const t = setTimeout(fn, 0); // accelerated: debounce is immediate
      t.unref?.();
      return () => clearTimeout(t);
    },
    interval: (_fn, _ms) => () => undefined, // Dream tick: explicit tool runs only
  };
  const ctx = {
    ...timers,
    logger: (_name) => ({
      info: () => undefined,
      warn: (m) => state.warnings.push(String(m)),
      error: () => undefined,
    }),
    on(name, listener) {
      state.listeners.push([name, listener]);
    },
    get(name) {
      if (name === 'llm') return state.llm ?? undefined;
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash' }) };
      }
      if (name === 'tools') return { register(def) { state.tools.push(def); return () => undefined; } };
      if (name === 'systemPrompt') return { section(o) { state.sections.push(o); return () => undefined; } };
      return undefined;
    },
    inject(_names, cb) {
      cb(ctx);
    },
  };
  return ctx;
}

/** The volatile Config the Loader would hand `apply` (one ref per section). */
function fakeConfig(state) {
  return Object.fromEntries(
    Object.keys(defaultMemorySettings()).map((key) => [key, { get: () => state.settings[key] }]),
  );
}

function emit(ctx, state, name, ...args) {
  for (const [n, listener] of [...state.listeners]) {
    if (n === name) listener(...args);
  }
}

const exec = (id, cwd = null) => ({
  agent: {
    session: { id, header: { cwd, delegationDepth: 0 } },
  },
});

test('full wiring E2E against a fake ctx', async () => {
  await withDshHome(async (home) => {
    const T = await import('../lib/testing.js');
    const state = {
      listeners: [],
      tools: [],
      sections: [],
      injected: [],
      warnings: [],
      // The plain value the fake volatile Config references resolve to.
      settings: defaultMemorySettings(),
    };
    const ctx = makeFakeCtx(state);
    // Fake auxiliary LLM: returns one implicit memory line for every call.
    const llmText = '测试环境的数据库快照每天凌晨三点自动生成。';
    state.llm = {
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
    };
    T.apply(ctx, fakeConfig(state));

    // 1. registration settles (async core init)
    const ok = await waitFor(() => state.tools.length === 9, { timeoutMs: 8000 });
    assert.ok(ok, `expected 9 tools, got ${state.tools.length}: ${state.warnings.join(' | ')}`);
    // The settings namespace is the Loader row id this bundle inserts; the
    // Host serves the same string to the browser half's config form.
    assert.equal(T.MEMORY_NS, 'dsh-memory', 'settings namespace is the row id');
    const usage = state.sections.find((s) => s.name === 'memory:usage');
    assert.ok(usage, 'system-prompt usage section registered');
    assert.equal(usage.order, 150);

    const byName = new Map(state.tools.map((t) => [t.name, t]));
    const remember = byName.get('memory_remember');
    const recall = byName.get('memory_recall');
    const forget = byName.get('memory_forget');
    const status = byName.get('memory_status');
    const dream = byName.get('memory_dream');
    for (const name of [
      'memory_remember',
      'memory_recall',
      'memory_get',
      'memory_update',
      'memory_forget',
      'memory_gc',
      'memory_drop_store',
      'memory_status',
      'memory_dream',
    ]) {
      assert.ok(byName.has(name), `tool ${name} registered`);
    }

    // 2. remember → recall round-trip through the tools
    const created = await remember.execute(
      { content: '团队约定：PR 必须两个评审人批准。', kind: 'commitment', tags: ['review'], scope: 'global' },
      exec('sess-tool'),
    );
    assert.equal(created.blocked, false);
    assert.ok(created.id);
    const found = await recall.execute({ query: 'PR 评审人 批准' }, exec('sess-tool'));
    assert.ok(found.hits.some((h) => h.id === created.id), 'recall finds the stored card');

    // 2b. memory_get returns the full card; a malformed id is a miss, not a throw
    const get = byName.get('memory_get');
    const fetched = await get.execute({ id: created.id }, exec('sess-tool'));
    assert.equal(fetched.found, true);
    assert.equal(fetched.card.id, created.id);
    assert.ok(fetched.card.body.includes('PR') || fetched.card.title.includes('PR'));
    const missing = await get.execute({ id: '../../etc/passwd' }, exec('sess-tool'));
    assert.equal(missing.found, false);

    // 2c. memory_update supersedes the original and the replacement is recalled
    const update = byName.get('memory_update');
    const corrected = await update.execute(
      { id: created.id, content: '团队约定（修订）：PR 必须两个评审人批准，且 CI 必须全绿。' },
      exec('sess-tool'),
    );
    assert.equal(corrected.updated, true);
    assert.equal(corrected.superseded, created.id);
    const recalledAfter = await recall.execute({ query: 'PR 评审人 批准' }, exec('sess-tool'));
    assert.ok(recalledAfter.hits.some((h) => h.id === corrected.id), 'replacement is recalled');
    assert.ok(!recalledAfter.hits.some((h) => h.id === created.id), 'superseded card is not recalled');
    // filter through the tool boundary
    const filtered = await recall.execute({ query: 'PR', kind: 'commitment' }, exec('sess-tool'));
    assert.ok(filtered.hits.every((h) => h.kind === 'commitment'));

    // 2d. query forget is a dry run through the tool boundary
    const dryRun = await forget.execute({ query: 'PR 评审人' }, exec('sess-tool'));
    assert.equal(dryRun.removed.length, 0);
    assert.ok(Array.isArray(dryRun.candidates) && dryRun.candidates.length >= 1);
    assert.match(String(dryRun.note), /confirm=true/);

    // 3. secrets are blocked by the tool path too (names only in the reason)
    const blocked = await remember.execute({ content: 'password=SuperSecret123 记住' }, exec('sess-tool'));
    assert.equal(blocked.blocked, true);
    assert.ok(blocked.reason.includes('credential-assignment'));
    assert.ok(!blocked.reason.includes('SuperSecret'));

    // 4. status + dream tool
    const st = await status.execute({}, exec('sess-tool'));
    assert.equal(st.enabled, true);
    assert.ok(st.stores.some((s) => s.slug === 'global'));
    const dreamRes = await dream.execute({ run: true }, exec('sess-tool'));
    assert.equal(dreamRes.busy, false);

    // 5. turn-end capture → inbox → Dream → recall
    const turnText = [
      '这次部署失败排查花了大约两个小时，把网关日志和流水线日志都翻了一遍才定位到根因，是镜像标签写错了。',
      '记住：API 网关的生产端口是 8443，不是 8080，配置里出现过混淆。',
      '以后都要先跑一遍完整回归测试再改网关配置并重新发布。',
      '另外测试环境的数据库快照每天凌晨三点自动生成，排查前先看快照时间。',
    ].join('\n');
    const session = {
      id: 'sess-capture',
      header: { cwd: null, delegationDepth: 0 },
      deriveMessages: () => [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: turnText }] },
        { role: 'assistant', content: [{ type: 'text', text: '好的，我会先核对网关配置。' }] },
      ],
    };
    emit(ctx, state, 'session/event', session, { type: 'turn/end', turn: 1 });
    const coreProbe = await T.MemoryCore.create({ logger: null });
    const inboxed = await waitFor(async () => (await coreProbe.global.inboxLineCount()) >= 3, { timeoutMs: 8000 });
    if (!inboxed) {
      console.error('DEBUG warnings:', JSON.stringify(state.warnings));
      const { readFile } = await import('node:fs/promises');
      const { join: jp } = await import('node:path');
      const auditText = await readFile(jp(home, 'memory', 'global', 'audit.jsonl'), 'utf8').then((t) => t, () => 'no-audit');
      console.error('DEBUG audit:', JSON.stringify(auditText));
      const inboxText = await readFile(jp(home, 'memory', 'global', 'inbox.jsonl'), 'utf8').then((t) => t, () => 'no-inbox');
      console.error('DEBUG inbox:', JSON.stringify(inboxText));
    }
    assert.ok(inboxed, 'capture staged intent sentences + LLM line into the inbox');
    const { readJsonlLines } = await import('../lib/testing.js');
    const inboxEntries = await readJsonlLines(join(home, 'memory', 'global', 'inbox.jsonl'));
    assert.ok(inboxEntries.some((e) => e.via === 'auto-heuristic'), 'heuristic candidates staged');
    assert.ok(inboxEntries.some((e) => e.via === 'auto-llm' && e.content.includes('数据库快照')), 'LLM line staged with auto-llm attribution');

    await dream.execute({ run: true }, exec('sess-tool'));
    const found2 = await recall.execute({ query: 'API 网关 生产端口 8443' }, exec('sess-tool'));
    assert.ok(
      found2.hits.some((h) => h.id !== created.id && (h.title.includes('8443') || h.snippet.includes('8443'))),
      'captured fact is recallable after Dream',
    );

    // 6. brief injection on agent start. agent/created is the single start
    // event now (startup/resume/clear/compact, carried in payload.source).
    const agent = {
      id: 'agent-1',
      // A fresh session's persisted log is empty at agent start.
      session: { id: 'sess-agent', header: { cwd: null }, snapshotEvents: () => [] },
      inject: (msg) => state.injected.push(msg),
    };
    emit(ctx, state, 'agent/created', { agent, source: 'startup' });
    const injectedOk = await waitFor(() => state.injected.length === 1, { timeoutMs: 8000 });
    assert.ok(injectedOk, `expected exactly one injection (deduped), got ${state.injected.length}`);
    const msg = state.injected[0];
    // Producer-owned attribution: the brief names this plugin and declares the
    // recalled form, exactly as the new message-source vocabulary requires.
    assert.equal(msg.source.kind, 'dsh-memory');
    assert.equal(msg.source.form, 'recall');
    assert.equal(msg.content[0].type, 'text');
    assert.ok(msg.content[0].text.startsWith('<system-reminder>'));
    assert.ok(msg.content[0].text.includes('8443'), 'brief carries the new memory');

    // 6b. resume after a host restart must NOT re-inject the brief: for a
    // new agent id the in-process set is empty, so only the durable
    // persisted-log check (a spliced dsh-memory message already in the
    // session history) can stop the double injection.
    const persistedSplice = {
      type: 'agent/inbox/spliced',
      seq: 3,
      data: {
        target: 'next-step',
        start: 0,
        inserted: [
          {
            role: 'user',
            content: [{ type: 'text', text: '<system-reminder>\nresumed brief\n</system-reminder>' }],
            source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
          },
        ],
      },
    };
    const resumedAgent = {
      id: 'agent-1-resumed',
      session: {
        id: 'sess-agent',
        header: { cwd: null },
        snapshotEvents: () => [
          { type: 'permission/preset', seq: 0, data: { preset: 'danger-full-access' } },
          persistedSplice,
        ],
      },
      inject: (m) => state.injected.push(m),
    };
    emit(ctx, state, 'agent/created', { agent: resumedAgent, source: 'resume' });
    // Give a (buggy) async injection path time to fire; the persisted check
    // must prevent it synchronously.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(state.injected.length, 1, 'resumed session with persisted brief is not re-injected');

    // 6c. legacy session (persisted log WITHOUT any dsh-memory brief, e.g.
    // created before the plugin existed) is still briefed on first resume.
    const legacyAgent = {
      id: 'agent-legacy',
      session: {
        id: 'sess-legacy',
        header: { cwd: null },
        snapshotEvents: () => [
          { type: 'user/message', seq: 0, data: {} },
          { type: 'turn/end', seq: 1, data: { reason: 'stop' } },
        ],
      },
      inject: (m) => state.injected.push(m),
    };
    emit(ctx, state, 'agent/created', { agent: legacyAgent, source: 'resume' });
    const legacyOk = await waitFor(() => state.injected.length === 2, { timeoutMs: 8000 });
    assert.ok(legacyOk, `legacy session briefed on first resume (got ${state.injected.length})`);
    assert.equal(state.injected[1].source.kind, 'dsh-memory');

    // 7. global kill switch: settings.enabled=false disables the write/dream tools
    state.settings.enabled = false;
    const rememberDisabled = remember.execute({ content: 'kill switch 测试内容，足够长的一段话而已。' }, exec('sess-tool'));
    await assert.rejects(() => rememberDisabled, /disabled/);
    const dreamDisabled = dream.execute({}, exec('sess-tool'));
    await assert.rejects(() => dreamDisabled, /disabled/);
    // status keeps working by design and reports the disabled state
    const stOff = await status.execute({}, exec('sess-tool'));
    assert.equal(stOff.enabled, false);
    // re-enable
    state.settings.enabled = true;
    const st2 = await status.execute({}, exec('sess-tool'));
    assert.equal(st2.enabled, true);

    // 8. store root sanity: everything under DSH_HOME/memory, nothing in projects
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(home);
    assert.ok(entries.includes('memory'), 'memory root under DSH_HOME');
  });
});
