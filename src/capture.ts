/**
 * Turn-end auto-capture: when a root (non-delegated) session's turn ends, the
 * tail of the turn text is scanned for memory candidates and staged into the
 * store inbox (gated BEFORE staging, so secrets never touch disk). Dream
 * consolidates them later.
 *
 * Two complementary passes:
 *   1. Heuristic — explicit memory-intent sentences (cheap, high precision).
 *   2. LLM — one budgeted auxiliary call (ctx.llm seam) that extracts
 *      implicit durable memories; degrades silently to heuristic-only when
 *      the service, route, or the call itself is unavailable (capture.useLlm
 *      / memory.llm.* settings).
 *
 * The 15s debounce lets a fast-follow turn extend the tail before extraction.
 */
import type { StoreLogger } from './store.ts';
import type { MemoryCore } from './core.ts';
import { gateCandidate } from './redact.ts';
import { emptyRules } from './rules.ts';
import type { MemorySettings } from './settings.ts';
import type { AuditVia, MemoryKind } from './types.ts';
import {
  buildCaptureLlmUserPrompt,
  callMemoryLlm,
  captureSystemPrompt,
  classifyLlmLine,
  parseLlmMemoryLines,
  type MemoryLlmDeps,
} from './llm.ts';

export interface SessionLike {
  id: string;
  header?: { cwd?: string; delegationDepth?: number } | null;
  deriveMessages?(): Array<{
    role: string;
    content: Array<{ type: string; text?: string }>;
    source?: { kind?: string; plugin?: string } | null;
  }>;
}

export interface IntentCandidate {
  content: string;
  kind: MemoryKind;
}

/** Explicit "remember this" intent — deliberately narrow (precision > recall). */
const INTENT_RE =
  /(记住|记一下|记下来|记到|别忘了|别忘|忘掉以前.*(改用|换成)|以后(都要|都得|必须|不要|别再|还是)|下次(记得|要|再|都)|长期(用|都)|统一(用|用)|永远(都|要)|默认(用|是)|always remember|\bremember that\b|\bremember to\b|from now on|going forward|always use|never use|stop using|my preference)/i;

/** Preference-shaped intent (kind classification). */
const PREFERENCE_RE = /(偏好|习惯|prefer|always|from now on|going forward|统一|固定|永远|默认|总是|始终)/i;

/**
 * Negation prefixes that flip a remember-verb into the opposite of an
 * intent: "不需要记住" / "不要记住" / "不用记…" state that something does
 * NOT need to be remembered. Checked against the text immediately before
 * each intent match; "别忘" (don't forget) stays positive by design.
 */
const NEGATED_INTENT_PREFIX = /(?:不需要|无需|不必|不用|不要|不想|没必要|不要再)\s*$/;

/** True when at least one intent occurrence is NOT negated. */
function hasPositiveIntent(s: string): boolean {
  const re = new RegExp(INTENT_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const before = s.slice(Math.max(0, m.index - 10), m.index);
    if (!NEGATED_INTENT_PREFIX.test(before)) return true;
  }
  return false;
}

const MIN_SENT = 6;
const MAX_SENT = 400;
const MAX_CANDIDATES = 5;

/**
 * Remove machine-injected `<system-reminder>` blocks (memory brief, skill
 * catalog, runtime context). Their boilerplate is never a user statement and
 * must not become a memory candidate.
 */
export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}

/**
 * Machine-injected content is never a user statement: any message whose
 * source is a plugin injection or a tool result is skipped, regardless of
 * which plugin produced it (dsh-memory brief, harness checkpoints that ride
 * plugin sources, ...). Unknown / merge-extensible source kinds are kept.
 */
function isMachineInjected(source: { kind?: string; plugin?: string } | null | undefined): boolean {
  return source?.kind === 'plugin' || source?.kind === 'tool';
}

/**
 * Harness checkpoint/compaction summaries arrive as user-role messages whose
 * body QUOTES earlier conversation (which may contain genuine intent words
 * like 记住 / "always use"). Machine-generated → skipped via their stable
 * opening marker.
 */
const CHECKPOINT_MARKER = 'This is an automatically generated checkpoint';

/** Split text into sentences (CJK + latin terminators). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])|(?<=[.!?;])\s+/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.length > 0);
}

export function extractIntentSentences(text: string, max = MAX_CANDIDATES): IntentCandidate[] {
  const out: IntentCandidate[] = [];
  const seen = new Set<string>();
  for (const s of splitSentences(text)) {
    if (s.length < MIN_SENT || s.length > MAX_SENT) continue;
    if (!hasPositiveIntent(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ content: s, kind: PREFERENCE_RE.test(s) ? 'preference' : 'fact' });
    if (out.length >= max) break;
  }
  return out;
}

interface CtxLike {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  /** Fiber-aware timer (dsh-timers); when absent, extraction runs immediately. */
  timeout?: (fn: () => void, delayMs: number) => () => void;
}

/**
 * Register the capture listener. Structural types keep this testable with a
 * fake ctx; every callback is failure-contained (never throws into the bus).
 */
export function registerCapture(
  ctx: CtxLike,
  core: MemoryCore,
  getSettings: () => MemorySettings,
  logger: StoreLogger | null,
  llmDeps: MemoryLlmDeps | null = null,
): void {
  const pending = new Map<string, () => void>();

  ctx.on('session/event', (...args: unknown[]) => {
    const session = args[0] as SessionLike | undefined;
    const event = args[1] as { type?: string; turn?: number } | undefined;
    try {
      if (!event || event.type !== 'turn/end') return;
      if (!session || typeof session.id !== 'string') return;
      const s = getSettings();
      if (!s.enabled || s.capture.mode === 'off') return;
      if ((session.header?.delegationDepth ?? 0) > 0) return;
      scheduleExtraction(session);
    } catch (err) {
      logger?.warn(`[dsh-memory] capture event failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  function scheduleExtraction(sess: SessionLike): void {
    const run = () => {
      pending.delete(sess.id);
      void extractFor(sess).catch((err) =>
        logger?.warn(`[dsh-memory] capture failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    };
    if (typeof ctx.timeout === 'function') {
      pending.get(sess.id)?.();
      const dispose = ctx.timeout(run, 15_000);
      pending.set(sess.id, dispose);
    } else {
      void run();
    }
  }

  async function extractFor(sess: SessionLike): Promise<void> {
    const s = getSettings();
    if (!s.enabled || s.capture.mode === 'off') return;
    const messages = sess.deriveMessages?.() ?? [];
    let tail = '';
    for (let i = messages.length - 1; i >= 0 && tail.length < s.capture.turnTailChars; i--) {
      const m = messages[i];
      if (m === undefined) continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      // Skip machine-injected messages (any plugin/tool source): machine
      // context is never a user memory statement.
      if (isMachineInjected(m.source)) continue;
      const text = stripSystemReminders(
        (m.content ?? [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join(' '),
      ).trim();
      if (!text) continue;
      // Harness checkpoint summaries quote earlier turns (incl. intent words);
      // they are machine-generated, so skip them via their stable marker.
      if (m.role === 'user' && text.startsWith(CHECKPOINT_MARKER)) continue;
      tail = `${text}\n${tail}`;
    }
    tail = tail.slice(0, s.capture.turnTailChars);
    if (tail.trim().length < s.capture.minTurnContentChars) return;

    const candidates = extractIntentSentences(tail);
    const cwd = sess.header?.cwd;
    const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
    const targetStore = project ?? core.global;
    let llmLines: string[] = [];
    if (s.capture.useLlm && llmDeps !== null) {
      const system =
        targetStore === core.global
          ? captureSystemPrompt({ kind: 'global' })
          : captureSystemPrompt({ kind: 'project', slug: targetStore.slug });
      const pass = await runLlmPass(tail, candidates, llmDeps, system);
      llmLines = pass.lines;
      // Audit trail so the auxiliary-call path is observable (ok / skipped /
      // error) — previously a silent skip left no trace at all.
      await targetStore
        .audit({
          ts: new Date().toISOString(),
          store: targetStore.slug,
          op: 'llm',
          detail: pass.status === 'ok' ? `ok n=${llmLines.length}${pass.truncated ? ' truncated' : ''}` : `${pass.status}${pass.reason ? ` ${pass.reason}` : ''}`.slice(0, 160),
          via: 'auto',
          session: sess.id,
        })
        .catch(() => undefined);
    }
    if (candidates.length === 0 && llmLines.length === 0) return;

    const stage = (content: string, kind: MemoryKind, via: AuditVia) => {
      const store = project ?? core.global;
      return void (async () => {
        const rules = await core.rulesFor(store.slug).catch(() => emptyRules());
        const gated = gateCandidate(content, rules.denyKeywords, s.redact.pii);
        if (!gated.ok) {
          await store
            .audit({
              ts: new Date().toISOString(),
              store: store.slug,
              op: 'block',
              detail: gated.reasons.join(','),
              via,
              session: sess.id,
            })
            .catch(() => undefined);
          return;
        }
        await store.pushInbox({
          ts: new Date().toISOString(),
          content: gated.text,
          kind,
          via,
          source: { session: sess.id, turn: null },
        });
      })();
    };

    for (const cand of candidates) await stage(cand.content, cand.kind, 'auto-heuristic');
    for (const line of llmLines) await stage(line, classifyLlmLine(line), 'auto-llm');
  }
}

/** Outcome of one capture LLM pass (for the observability audit). */
export interface LlmPassResult {
  lines: string[];
  /** 'ok' | 'skipped' (no service / unregistered / call failed) | 'error' (threw). */
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
  /** The reply was cut off at the output budget; lines were salvaged. */
  truncated?: boolean;
}

/**
 * One budgeted LLM extraction call for this turn. Returns the parsed,
 * length-capped candidate lines plus a status for the audit trail; any
 * failure (service, route, timeout, provider error) is a warning and yields
 * [] — the heuristic pass is unaffected.
 */
async function runLlmPass(
  tail: string,
  heuristic: IntentCandidate[],
  llmDeps: MemoryLlmDeps,
  system: string,
): Promise<LlmPassResult> {
  if (llmDeps.llm === null) return { lines: [], status: 'skipped', reason: 'no-llm-service' };
  try {
    const known = heuristic.map((c) => c.content);
    const result = await callMemoryLlm(llmDeps, {
      system,
      user: buildCaptureLlmUserPrompt(tail, known),
    });
    if (!result.ok) {
      llmDeps.logger?.warn?.(
        `[dsh-memory] capture LLM skipped (${result.reason}${result.message ? `: ${result.message}` : ''}); heuristic path unaffected`,
      );
      return { lines: [], status: 'skipped', reason: result.reason };
    }
    return {
      lines: parseLlmMemoryLines(result.text).slice(0, MAX_CANDIDATES),
      status: 'ok',
      truncated: result.truncated === true,
    };
  } catch (err) {
    llmDeps.logger?.warn?.(
      `[dsh-memory] capture LLM pass failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { lines: [], status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}
