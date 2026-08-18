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
