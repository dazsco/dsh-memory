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
  CAPTURE_LLM_SYSTEM,
  classifyLlmLine,
  parseLlmMemoryLines,
  type MemoryLlmDeps,
} from './llm.ts';

export interface SessionLike {
  id: string;
  header?: { cwd?: string; delegationDepth?: number } | null;
  deriveMessages?(): Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
}

export interface IntentCandidate {
  content: string;
  kind: MemoryKind;
}

/** Explicit "remember this" intent — deliberately narrow (precision > recall). */
const INTENT_RE =
  /(记住|记一下|记下来|记到|别忘了|别忘|忘掉以前.*(改用|换成)|以后(都要|都得|必须|不要|别再|还是)|下次(记得|要|再|都)|长期(用|都)|统一(用|用)|永远(都|要)|默认(用|是)|always remember|remember that|remember to|from now on|going forward|always use|never use|stop using|switch to|my preference)/i;

/** Preference-shaped intent (kind classification). */
const PREFERENCE_RE = /(偏好|习惯|prefer|always|from now on|going forward|统一|固定|永远|默认|总是|始终)/i;

const MIN_SENT = 6;
const MAX_SENT = 400;
const MAX_CANDIDATES = 5;

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
    if (!INTENT_RE.test(s)) continue;
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
      const text = (m.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join(' ');
      if (text) tail = `${text}\n${tail}`;
    }
    tail = tail.slice(0, s.capture.turnTailChars);
    if (tail.trim().length < s.capture.minTurnContentChars) return;

    const candidates = extractIntentSentences(tail);
    const cwd = sess.header?.cwd;
    const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
    const llmLines = s.capture.useLlm && llmDeps !== null ? await runLlmPass(tail, candidates, llmDeps) : [];
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

/**
 * One budgeted LLM extraction call for this turn. Returns the parsed,
 * length-capped candidate lines; any failure (service, route, timeout,
 * provider error) is a warning and yields [] — the heuristic pass is
 * unaffected.
 */
async function runLlmPass(
  tail: string,
  heuristic: IntentCandidate[],
  llmDeps: MemoryLlmDeps,
): Promise<string[]> {
  if (llmDeps.llm === null) return [];
  try {
    const known = heuristic.map((c) => c.content);
    const result = await callMemoryLlm(llmDeps, {
      system: CAPTURE_LLM_SYSTEM,
      user: buildCaptureLlmUserPrompt(tail, known),
    });
    if (!result.ok) {
      llmDeps.logger?.warn?.(
        `[dsh-memory] capture LLM skipped (${result.reason}${result.message ? `: ${result.message}` : ''}); heuristic path unaffected`,
      );
      return [];
    }
    return parseLlmMemoryLines(result.text).slice(0, MAX_CANDIDATES);
  } catch (err) {
    llmDeps.logger?.warn?.(
      `[dsh-memory] capture LLM pass failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
