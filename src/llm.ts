/**
 * Budgeted auxiliary LLM seam for dsh-memory (capture + Dream passes).
 *
 * Route resolution (per-field, first non-empty wins):
 *   1. User settings override: `memory.llm.provider` / `memory.llm.model`
 *   2. The current session's default model (`agent-default-model` settings
 *      namespace, read live) — the route the agent itself runs on
 *   3. Plugin composition route (cordis row config; shipped default
 *      `deepseek` / `deepseek-v4-flash`)
 *
 * Every failure degrades to the heuristic path — this module never throws
 * into a capture or Dream run. One call = one `ctx.llm.stream()` request,
 * bounded by `maxOutputTokens`, a deadline (dsh-timeout), and the caller's
 * per-run budget counter.
 */
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm';
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout';
import type { StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm';

const TIMEOUT_CODE = 'MEMORY_LLM_TIMEOUT';

/** The subset of the `llm` service dsh-memory consumes. */
export interface MemoryLlmService {
  listProviders(): ReadonlyArray<{ id: string; name: string }>;
  stream(options: {
    provider: string;
    model: string;
    messages: UserMessage[];
    system?: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): AsyncIterable<StreamChunk>;
}

export interface MemoryLlmDeps {
  /** `ctx.get('llm')`; absent → every call degrades. */
  llm: MemoryLlmService | null;
  logger?: { warn(msg: string): void } | null;
  /** Route declared on the plugin composition row. */
  configRoute: { provider: string; model: string };
  /** Live settings route/budget (empty provider/model = use config route). */
  route: () => { provider: string; model: string; maxOutputTokens: number; timeoutMs: number };
}

export type LlmFailReason = 'no-service' | 'no-route' | 'unregistered' | 'timeout' | 'aborted' | 'max-tokens' | 'error';

export type LlmResult =
  | { ok: true; text: string; route: { provider: string; model: string }; truncated?: boolean }
  | { ok: false; reason: LlmFailReason; message?: string };

export interface MemoryLlmRequest {
  system: string;
  user: string;
  /** Per-call override of the settings budget (Dream passes use smaller outputs). */
  maxOutputTokens?: number;
}

/**
 * Run one auxiliary model call. Never throws: all failure classes (missing
 * service, unregistered route, timeout, provider error) become `ok: false`.
 */
export async function callMemoryLlm(deps: MemoryLlmDeps, request: MemoryLlmRequest): Promise<LlmResult> {
  const llm = deps.llm;
  if (llm === null) return { ok: false, reason: 'no-service' };
  const live = deps.route();
  const provider = live.provider !== '' ? live.provider : deps.configRoute.provider;
  const model = live.model !== '' ? live.model : deps.configRoute.model;
  if (provider === '' || model === '') return { ok: false, reason: 'no-route' };
  let ids: string[];
  try {
    ids = llm.listProviders().map((p) => p.id);
  } catch {
    return { ok: false, reason: 'no-service' };
  }
  if (!ids.includes(provider)) return { ok: false, reason: 'unregistered' };

  const messages: UserMessage[] = [
    createUserMessage({
      content: [{ type: 'text', text: request.user }],
      source: { kind: 'plugin', plugin: 'dsh-memory' },
    }),
  ];
  const callDeadline = deadline(undefined, live.timeoutMs, TIMEOUT_CODE);
  try {
    const options = deepFreeze({
      provider,
      model,
      messages,
      system: request.system,
      maxTokens: request.maxOutputTokens ?? live.maxOutputTokens,
      temperature: 0.2,
      signal: callDeadline.signal,
    });
    const assembler = new BlockAssembler();
    const stream = llm.stream(options);
    let streamDone = false;
    // A stalled stream (no chunks and no close — observed on the flaky
    // ztu-ai endpoint) would suspend the for-await forever even after the
    // deadline aborts the signal, because throwIfAborted only runs when a
    // chunk arrives. Race the drain against the deadline so this call is
    // always bounded by live.timeoutMs.
    await Promise.race([
      (async () => {
        for await (const chunk of stream) {
          callDeadline.signal.throwIfAborted();
          assembler.push(chunk);
        }
        streamDone = true;
      })(),
      new Promise<void>((resolve) => {
        if (callDeadline.signal.aborted) return resolve();
        callDeadline.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]);
    if (!streamDone) {
      // The deadline won: best-effort cancel of the stalled stream (not
      // awaited — cancelling may itself hang on the dead socket; the call is
      // already bounded) and report the coded timeout via the existing catch.
      void stream[Symbol.asyncIterator]().return?.().catch(() => undefined);
      callDeadline.signal.throwIfAborted();
    }
    const finish = assembler.finish;
    switch (finish.kind) {
      case 'stop': {
        const text = assembler
          .blocks()
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        return { ok: true, text, route: { provider, model } };
      }
      case 'aborted': {
        const timedOut = timeoutOf(callDeadline.signal, TIMEOUT_CODE) !== undefined;
        return { ok: false, reason: timedOut ? 'timeout' : 'aborted', message: finish.failure?.message };
      }
      case 'max-tokens': {
        // The reply was cut off at the output budget, but the text produced
        // so far usually still holds complete, parseable memory lines (the
        // model writes them top-down). Salvage those instead of discarding
        // the whole call — a truncated last line is cheaper than zero.
        const partial = assembler
          .blocks()
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        return { ok: true, text: partial, route: { provider, model }, truncated: true };
      }
      case 'tool-calls':
        return { ok: false, reason: 'error', message: 'model requested a tool; refused' };
      case 'error':
        return { ok: false, reason: 'error', message: finish.failure?.message };
      default:
        return { ok: false, reason: 'error', message: `unknown finish reason "${String((finish as { kind?: unknown }).kind ?? finish)}"` };
    }
  } catch (err) {
    const timedOut = timeoutOf(callDeadline.signal, TIMEOUT_CODE) !== undefined;
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    callDeadline[Symbol.dispose]();
  }
}

// ── output parsing ───────────────────────────────────────────────────────────

const LINE_MIN = 4;
const LINE_MAX = 400;
const MARKER_RE = /^\s*(?:[-*•]\s*|\d+[.)]\s*|【[^】]{1,12}】\s*)/;
const QUOTE_PAIRS: [string, string][] = [
  ['「', '」'],
  ['“', '"'],
  ['"', '"'],
  ["'", "'"],
];

/**
 * Parse one LLM extraction reply into candidate lines. Tolerant of list
 * markers, surrounding quote pairs, and a `NONE` reply. Empty input → [].
 */
export function parseLlmMemoryLines(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.length === 0) continue;
    if (/^none\b/i.test(line)) continue;
    line = line.replace(MARKER_RE, '').trim();
    for (const [o, c] of QUOTE_PAIRS) {
      if (line.startsWith(o) && line.endsWith(c) && line.length - o.length - c.length >= 2) {
        line = line.slice(o.length, line.length - c.length).trim();
        break;
      }
    }
    if (line.length < LINE_MIN || line.length > LINE_MAX) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

const PREFERENCE_RE = /(偏好|习惯|prefer|always|from now on|going forward|统一|固定|永远|默认|总是|始终|不要|别再|必须|都要)/i;

/** Classify a parsed line: preference-shaped → 'preference', else 'fact'. */
export function classifyLlmLine(line: string): 'fact' | 'preference' {
  return PREFERENCE_RE.test(line) ? 'preference' : 'fact';
}

/**
 * The extraction system prompt (bilingual, line-based output contract).
 * Scope-aware: a GLOBAL target gets strict user-level-only discipline (this
 * is where project facts, one-off data and meta chatter have leaked into),
 * a project target may take project facts but never meta/transient content.
 */
export type CaptureTarget = { kind: 'global' } | { kind: 'project'; slug: string };

export function captureSystemPrompt(target: CaptureTarget): string {
  const rules = [
    '你是记忆抽取助手。从给定的对话尾部中抽取值得长期记住的信息。',
    'You are a memory extractor. Pull durable memories from the conversation tail below.',
    'Rules / 规则:',
    '- Only output what is durable: stable facts, user preferences, decisions, procedures, commitments, project conventions.',
    '- 只输出值得长期记住的内容：稳定事实、用户偏好、决定、流程、承诺、项目约定。',
    '- One memory per line; plain text; no JSON, no markdown markers, no explanations.',
    '- Never output secrets (keys, tokens, passwords) — skip any line containing one.',
    '- Never invent; if nothing is worth remembering, output exactly: NONE',
    '- 不要编造；如果没有值得记住的，只输出：NONE',
    // Universal exclusions (both scopes) — the three observed leak classes:
    '- Never output anything about the memory system itself, the AI assistant, or the conversation itself (meta content). / 永不输出关于记忆系统本身、AI 助手或本次对话的内容（元内容一律不记）。',
    '- Never output one-off command outputs (a single command\'s counts, sizes, versions) or task artifact paths/sizes. / 不要输出一次性命令输出（某次命令的数量/大小/版本）或任务产物的路径/尺寸。',
    '- Each line must be a distilled durable statement, never a verbatim fragment of the conversation. / 每行必须是提炼后的持久陈述，绝不能照抄对话原文片段。',
  ];
  if (target.kind === 'global') {
    rules.push(
      'Target store: GLOBAL user-level memory (cross-project, cross-machine). / 目标库：全局用户级记忆（跨项目、跨机器）。',
      '- Output ONLY user-level content: the user\'s own working preferences and decisions, environment/tooling facts about the user\'s machine, cross-project procedures.',
      '- Do NOT output facts about any specific project (its code, file paths, commits, test counts, repo layout, task details). If the conversation is mainly about a specific project, output exactly: NONE',
      '- 只输出用户级内容：用户自己的工作偏好/决定、其机器上的环境与工具链事实、跨项目流程。任何特定项目的事实（代码/路径/提交/测试数/仓库结构/任务细节）都不要输出；对话主要在谈某个具体项目时，只输出 NONE。',
    );
  } else {
    rules.push(
      `Target store: project memory for "${target.slug}" — its code, conventions, commits and test facts are in scope. / 目标库：项目 "${target.slug}" 的记忆库，该项目的代码/约定/提交/测试事实可以输出。`,
    );
  }
  return rules.join('\n');
}

/**
 * Build the extraction user prompt. `known` are the heuristic candidates
 * already staged for this turn, so the model does not repeat them.
 */
export function buildCaptureLlmUserPrompt(tail: string, known: string[]): string {
  const body = tail.length > 0 ? tail : '(empty)';
  const knownSection = known.length > 0 ? `\nAlready captured (do not repeat) / 已捕获（勿重复）:\n${known.map((k) => `- ${k}`).join('\n')}\n` : '';
  return `Conversation tail / 对话尾部:${knownSection}\n---\n${body}`;
}

// ── Dream LLM passes ─────────────────────────────────────────────────────────

/** One card as presented to a Dream LLM pass (excerpt only, never full body). */
export interface DreamCardLine {
  id: string;
  kind: string;
  title: string;
  body: string;
  importance: number;
}

export const DREAM_SUMMARIZE_SYSTEM = [
  '你是记忆库整理助手。根据给定记忆卡片写一段简洁的记忆库概览（3-6 句中文），',
  '概括这个记忆库主要包含哪些主题、用户偏好、项目约定和重要决定。',
  'You are a memory-library organizer. Write a concise 3-6 sentence Chinese overview of these cards: the main topics, user preferences, project conventions, and key decisions.',
  '只输出概览文本本身；不要标题、编号或解释。',
  'Output only the overview text; no headings, numbering, or explanations.',
  '如果没有值得概括的内容，只输出：NONE',
].join('\n');

/** Build the summarize prompt. Cards are excerpted to 160 chars of body. */
export function buildSummarizeUserPrompt(slug: string, cards: DreamCardLine[]): string {
  const lines = cards.map((c) => `- ${c.id} | ${c.kind} | imp=${c.importance} | ${c.title}\n  ${c.body.slice(0, 160).replace(/\s+/g, ' ')}`);
  return `Store: ${slug}\nCards (${cards.length}):\n${lines.join('\n')}`;
}

/** Sanitize a summarize reply: trim, reject NONE/empty, cap length. */
export function parseSummaryText(text: string, maxChars = 800): string | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length === 0 || /^none$/i.test(t)) return null;
  return t.slice(0, maxChars);
}

export const DREAM_CONFLICT_SYSTEM = [
  '下面给出几组近似重复的记忆卡片（组号 G1、G2...，每组 A/B 两条）。',
  '判断每组应保留哪一条：内容相同（或一条包含另一条）的保留更完整/更新的一条；互补的都可保留。',
  '每组输出恰好一行，格式：G<编号> <保留的id>  或  G<编号> both',
  '保留的 id 必须逐字使用题目中给出的完整 id（以 m- 开头），不要缩写或改写。',
  '示例：G1 m-20260818-1a2b3c4d5e',
  '只输出这些行，不要任何解释或多余文字。',
  'Below are groups of near-duplicate memory cards. For each group output exactly one line:',
  'G<number> <kept-id>   or   G<number> both. The kept-id must be the full id (m-...) given in the prompt.',
  'Example: G1 m-20260818-1a2b3c4d5e. Output nothing else.',
].join('\n');

export interface ConflictPair {
  a: DreamCardLine;
  b: DreamCardLine;
  similarity: number;
}

/** Build the conflict-decision prompt from near-duplicate pairs. */
export function buildConflictUserPrompt(pairs: ConflictPair[]): string {
  const parts = pairs.map((p, i) => {
    const n = i + 1;
    return `G${n} (jaccard≈${p.similarity.toFixed(2)}):\n  A) ${p.a.id} :: ${p.a.title} — ${p.a.body.slice(0, 160).replace(/\s+/g, ' ')}\n  B) ${p.b.id} :: ${p.b.title} — ${p.b.body.slice(0, 160).replace(/\s+/g, ' ')}`;
  });
  return parts.join('\n\n');
}

export type ConflictDecision = 'a' | 'b' | 'both';

/**
 * Parse conflict replies. Each line must name a known group and a known card
 * id (or `both`); anything unparseable is skipped — the heuristic state is
 * never corrupted by a malformed model reply.
 */
export function parseConflictDecisions(text: string, pairs: ConflictPair[]): Map<number, ConflictDecision> {
  const out = new Map<number, ConflictDecision>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^G(\d+)\s*:?\s*(\S+)/.exec(raw.trim());
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    const pair = pairs[idx];
    if (!pair) continue;
    const val = m[2];
    if (val === undefined) continue;
    let d: ConflictDecision | null = null;
    if (/^both$/i.test(val)) d = 'both';
    else if (val === pair.a.id) d = 'a';
    else if (val === pair.b.id) d = 'b';
    // Tolerate live-model format drift: A/B letters, colon separators, and
    // id variants (dropped m-YYYYMMDD- prefix, trailing punctuation). A
    // suffix match only counts at ≥8 chars so junk can't alias a card.
    else if (/^a$/i.test(val)) d = 'a';
    else if (/^b$/i.test(val)) d = 'b';
    else {
      const bare = val.replace(/[.,;:!?，。；：！？]+$/g, '');
      if (bare.length >= 8 && (pair.a.id.endsWith(bare) || bare.endsWith(pair.a.id))) d = 'a';
      else if (bare.length >= 8 && (pair.b.id.endsWith(bare) || bare.endsWith(pair.b.id))) d = 'b';
    }
    if (d !== null && !out.has(idx)) out.set(idx, d);
  }
  return out;
}
