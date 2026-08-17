import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withDshHome, waitFor } from './helpers/tmp.mjs';
import { defaultMemorySettings } from '../lib/testing.js';

/**
 * E2E wiring test: apply() against a fake cordis Context (structural fakes for
 * the settings service, tools registry, event bus, and fiber timers). This
 * verifies registration, tool execution, capture → inbox → Dream, brief
 * injection, and the global kill switch — without a live dsh host.
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
  const settingsValue = { ...defaultMemorySettings() };
  let currentSettings = settingsValue;
  const settingsService = {
    register(ns, _schema, _opts) {
      state.registeredNamespace = ns;
      const scope = {
        get: () => currentSettings,
        watch(cb) {
          state.settingsWatchers.push(cb);
          return () => undefined;
        },
        update(patch) {
          const prev = currentSettings;
          currentSettings = { ...currentSettings, ...patch };
          for (const cb of [...state.settingsWatchers]) void cb(currentSettings, prev);
        },
        replace(section) {
          currentSettings = { ...section };
        },
      };
      state.settingsScope = scope;
      return scope;
    },
  };
  const ctx = {
    ...timers,
    settings: settingsService,
    logger: (_name) => ({
      info: () => undefined,
      warn: (m) => state.warnings.push(String(m)),
      error: () => undefined,
    }),
    on(name, listener) {
      state.listeners.push([name, listener]);
    },
    get(name) {
      if (name === 'settings') return settingsService;
      if (name === 'llm') return state.llm ?? undefined;
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
      settingsWatchers: [],
      injected: [],
      warnings: [],
      registeredNamespace: null,
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
    T.apply(ctx);

    // 1. registration settles (async core init)
    const ok = await waitFor(() => state.tools.length === 5, { timeoutMs: 8000 });
    assert.ok(ok, `expected 5 tools, got ${state.tools.length}: ${state.warnings.join(' | ')}`);
    assert.equal(typeof state.registeredNamespace, 'string');
    assert.ok(String(state.registeredNamespace).includes('memory'), 'settings namespace registered');
    const usage = state.sections.find((s) => s.name === 'memory:usage');
    assert.ok(usage, 'system-prompt usage section registered');
    assert.equal(usage.order, 150);

    const byName = new Map(state.tools.map((t) => [t.name, t]));
    const remember = byName.get('memory_remember');
    const recall = byName.get('memory_recall');
    const forget = byName.get('memory_forget');
    const status = byName.get('memory_status');
    const dream = byName.get('memory_dream');
    for (const name of ['memory_remember', 'memory_recall', 'memory_forget', 'memory_status', 'memory_dream']) {
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
        { role: 'user', content: [{ type: 'text', text: turnText }] },
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

    // 6. brief injection on agent start (deduped across both events)
    const agent = {
      id: 'agent-1',
      session: { id: 'sess-agent', header: { cwd: null } },
      inject: (msg) => state.injected.push(msg),
    };
    emit(ctx, state, 'agent/created', { agent });
    emit(ctx, state, 'agent/session-start', { agent, source: 'startup' });
    const injectedOk = await waitFor(() => state.injected.length === 1, { timeoutMs: 8000 });
    assert.ok(injectedOk, `expected exactly one injection (deduped), got ${state.injected.length}`);
    const msg = state.injected[0];
    assert.equal(msg.source.kind, 'plugin');
    assert.equal(msg.source.plugin, 'dsh-memory');
    assert.equal(msg.content[0].type, 'text');
    assert.ok(msg.content[0].text.startsWith('<system-reminder>'));
    assert.ok(msg.content[0].text.includes('8443'), 'brief carries the new memory');

    // 7. global kill switch: settings.enabled=false disables the write/dream tools
    state.settingsScope.update({ enabled: false });
    const rememberDisabled = remember.execute({ content: 'kill switch 测试内容，足够长的一段话而已。' }, exec('sess-tool'));
    await assert.rejects(() => rememberDisabled, /disabled/);
    const dreamDisabled = dream.execute({}, exec('sess-tool'));
    await assert.rejects(() => dreamDisabled, /disabled/);
    // status keeps working by design and reports the disabled state
    const stOff = await status.execute({}, exec('sess-tool'));
    assert.equal(stOff.enabled, false);
    // re-enable
    state.settingsScope.update({ enabled: true });
    const st2 = await status.execute({}, exec('sess-tool'));
    assert.equal(st2.enabled, true);

    // 8. store root sanity: everything under DSH_HOME/memory, nothing in projects
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(home);
    assert.ok(entries.includes('memory'), 'memory root under DSH_HOME');
  });
});
