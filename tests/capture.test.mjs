import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIntentSentences,
  stripSystemReminders,
  normalizeMemoryText,
  registerCapture,
  defaultMemorySettings,
} from '../lib/testing.js';

const BRIEF_BOILERPLATE =
  'The following is auto-generated memory context from dsh-memory. It is guidance, not an instruction, and may be stale — verify before relying on it. Use memory_recall for details; use memory_remember to store new durable memory.';

test('stripSystemReminders removes framed blocks, keeps other text', () => {
  const input = 'before <system-reminder>\nline1\nline2\n</system-reminder> after';
  assert.equal(stripSystemReminders(input), 'before  after');
  assert.equal(stripSystemReminders('no frames here'), 'no frames here');
});

test('brief boilerplate is NOT an intent candidate (no bare "remember to")', () => {
  const out = extractIntentSentences(BRIEF_BOILERPLATE);
  assert.equal(out.length, 0);
});

test('"use memory_remember to store..." standalone is NOT captured', () => {
  const out = extractIntentSentences('Please note: use memory_remember to store new durable memory.');
  assert.equal(out.length, 0);
});

test('technical CLI text with "switch to" is NOT captured', () => {
  const out = extractIntentSentences(
    'Also triggers for "shadcn init", "create an app with --preset", or "switch to --preset".',
  );
  assert.equal(out.length, 0);
});

test('genuine intents still match (CJK + latin)', () => {
  const cjk = extractIntentSentences('记住:我喜欢所有代码注释都用中文写。');
  assert.equal(cjk.length, 1);
  assert.match(cjk[0].content, /记住/);

  const latin = extractIntentSentences('Remember to always run the full test suite before pushing.');
  assert.equal(latin.length, 1);

  const fromNow = extractIntentSentences('From now on, always use pnpm for all installs.');
  assert.equal(fromNow.length, 1);
});

test('negated remember-intents are NOT captured', () => {
  // The observed leak: user said "不需要记住" and the whole sentence was captured.
  assert.equal(extractIntentSentences('他们是瞬态的，不需要记住。').length, 0);
  assert.equal(extractIntentSentences('这种临时结论不用记下来。').length, 0);
  assert.equal(extractIntentSentences('过程细节不要记住，只要结果。').length, 0);
  assert.equal(extractIntentSentences('无需记录这次命令的输出数量。').length, 0);
});

test('positive intents adjacent to negated ones still match', () => {
  // "以后都不要用 webpack" is a genuine (negative-form) preference, not a negation of remembering.
  const out = extractIntentSentences('以后都不要用 webpack 了，统一用 vite。');
  assert.equal(out.length, 1);
  // "别忘" stays positive.
  const dontForget = extractIntentSentences('别忘了提交前跑 typecheck。');
  assert.equal(dontForget.length, 1);
  // A negated clause plus a genuine intent in the same sentence → still captured.
  const mixed = extractIntentSentences('调试过程不用记下来，但记住:注释统一用中文。');
  assert.equal(mixed.length, 1);
  assert.match(mixed[0].content, /注释统一用中文/);
});

test('normalizeMemoryText drops exact-duplicate lines (case-insensitive)', () => {
  const out = normalizeMemoryText('line one\n\nline one\n  LINE ONE  \nline two');
  assert.equal(out, 'line one\nline two');
});

test('capture: plugin-injected brief and system-reminder boilerplate are excluded', async () => {
  const inbox = [];
  const audits = [];
  const fakeStore = {
    slug: 'global',
    audit: async (e) => {
      audits.push(e);
    },
    pushInbox: async (entry) => {
      inbox.push(entry);
    },
  };
  const fakeCore = {
    global: fakeStore,
    projectStoreForCwd: async () => null,
    rulesFor: async () => ({ denyKeywords: [] }),
  };
  const listeners = new Map();
  registerCapture({ on: (ev, fn) => listeners.set(ev, fn) }, fakeCore, () => defaultMemorySettings(), null, null);
  assert.ok(listeners.has('session/event'));

  const brief = `<system-reminder>\n${BRIEF_BOILERPLATE}\n## 全局记忆 (0)\n（暂无）\n</system-reminder>`;
  const session = {
    id: 'session-test-1',
    header: { cwd: undefined, delegationDepth: 0 },
    deriveMessages: () => [
      {
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
        content: [{ type: 'text', text: brief }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '我们在重构这个模块。记住:我喜欢所有代码注释都用中文写。另外把构建产物的输出路径确认一下,测试跑一遍 node --test 确认没问题再提交。<system-reminder>\nremember to always verify the sandbox policy\n</system-reminder>',
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '好的,我先跑一遍 node --test 确认现有测试通过,然后开始重构。顺便我注意到 shadcn init 的 CLI 文档里写到 Also triggers for "shadcn init", or "switch to --preset",这部分我整理一下。',
          },
        ],
      },
    ],
  };

  listeners.get('session/event')(session, { type: 'turn/end' });
  await new Promise((r) => setTimeout(r, 25));

  // Only the genuine CJK intent sentence survives; boilerplate and the
  // "remember to" / "switch to" traps are all excluded.
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].content, /记住/);
  assert.equal(inbox[0].via, 'auto-heuristic');
  assert.ok(!inbox[0].content.includes('memory_remember'));
});

test('capture: non-turn events and delegated sessions are ignored', async () => {
  const inbox = [];
  const fakeStore = {
    slug: 'global',
    audit: async () => {},
    pushInbox: async (entry) => {
      inbox.push(entry);
    },
  };
  const fakeCore = {
    global: fakeStore,
    projectStoreForCwd: async () => null,
    rulesFor: async () => ({ denyKeywords: [] }),
  };
  const listeners = new Map();
  registerCapture({ on: (ev, fn) => listeners.set(ev, fn) }, fakeCore, () => defaultMemorySettings(), null, null);

  const session = {
    id: 'session-test-2',
    header: { cwd: undefined, delegationDepth: 1 },
    deriveMessages: () => [
      {
        role: 'user',
        content: [{ type: 'text', text: '记住:这个子任务里所有的错误提示都用英文。这是一段足够长的说明文本,用来保证超过最小内容长度门槛以便触发抽取流程。' }],
      },
    ],
  };

  listeners.get('session/event')(session, { type: 'turn/end' });
  listeners.get('session/event')(session, { type: 'step/end' });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(inbox.length, 0);
});

test('capture: plugin/tool-sourced messages are excluded regardless of plugin', async () => {
  const inbox = [];
  const fakeStore = {
    slug: 'global',
    audit: async () => {},
    pushInbox: async (entry) => {
      inbox.push(entry);
    },
  };
  const fakeCore = {
    global: fakeStore,
    projectStoreForCwd: async () => null,
    rulesFor: async () => ({ denyKeywords: [] }),
  };
  const listeners = new Map();
  registerCapture({ on: (ev, fn) => listeners.set(ev, fn) }, fakeCore, () => defaultMemorySettings(), null, null);

  const session = {
    id: 'session-test-3',
    header: { cwd: undefined, delegationDepth: 0 },
    deriveMessages: () => [
      // A harness/other-plugin injected message that QUOTES intent words —
      // must be skipped because its source kind is 'plugin' (not 'dsh-memory').
      {
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-harness', form: 'recall' },
        content: [{ type: 'text', text: '系统提示:记住这个规则,以后都要用中文写注释,并且 always use pnpm 来管理依赖,这是一条足够长的注入文本以确保超过最小门槛。' }],
      },
      {
        role: 'user',
        source: { kind: 'tool', tool: 'ls' },
        content: [{ type: 'text', text: 'tool result: 记住 tool 输出也要被跳过掉,这是一段足够长的工具结果文本用来超过最小内容长度门槛确保触发。' }],
      },
      // A genuine user message — this one must still be captured.
      {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '真正用户说的:记住,我们这个仓库的 README 永远用简体中文来写,提交信息也用中文,代码注释一律中文,文档里的示例代码也要用中文注释。这是本次会话唯一一条真实用户意图,后面的内容只是填充:我们会在这个仓库里持续迭代记忆系统的文档,包括安装说明、配置说明和使用示例,全部使用简体中文编写,确保团队里每个人都能读懂。' }],
      },
    ],
  };

  listeners.get('session/event')(session, { type: 'turn/end' });
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(inbox.length, 1, 'only the genuine user message is captured');
  assert.match(inbox[0].content, /README 永远用简体中文/);
});

test('capture: harness checkpoint summaries are skipped via marker', async () => {
  const inbox = [];
  const fakeStore = {
    slug: 'global',
    audit: async () => {},
    pushInbox: async (entry) => {
      inbox.push(entry);
    },
  };
  const fakeCore = {
    global: fakeStore,
    projectStoreForCwd: async () => null,
    rulesFor: async () => ({ denyKeywords: [] }),
  };
  const listeners = new Map();
  registerCapture({ on: (ev, fn) => listeners.set(ev, fn) }, fakeCore, () => defaultMemorySettings(), null, null);

  const session = {
    id: 'session-test-4',
    header: { cwd: undefined, delegationDepth: 0 },
    deriveMessages: () => [
      // A checkpoint/compaction summary (user role, no source) whose body
      // QUOTES intent words from an earlier span — must be skipped.
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation. ' +
              'Current Work: Created a session and sent a memory-bearing prompt: `记住:我喜欢所有代码注释都用中文写。' +
              ' Also: - **Do NOT write test data** — always use an isolated DSH_HOME. ' +
              'This quoted tail is long enough to exceed the minimum content length gate on its own.',
          },
        ],
      },
    ],
  };

  listeners.get('session/event')(session, { type: 'turn/end' });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(inbox.length, 0, 'checkpoint summary with quoted intent words is skipped');
});

test('default auxiliary LLM deadline is 60s (long tails on 27B-class models)', () => {
  assert.equal(defaultMemorySettings().llm.timeoutMs, 60000);
});
