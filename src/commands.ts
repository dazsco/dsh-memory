/**
 * dsh-memory — the human-facing slash-command surface.
 *
 * DSH's `commands` service owns plugin-contributed composer commands; the
 * agent tools are model-facing, and the Memory page is the GUI surface. This
 * module adds the third: `/memory …`, typed by the HUMAN in the composer and
 * executed on the Host without a model turn.
 *
 *   /memory                     store + Dream status
 *   /memory status              same
 *   /memory recall <query>      ranked recall over project + global
 *   /memory search <query>      recall across EVERY known store
 *   /memory remember <text>     store a durable memory (project when applicable)
 *   /memory forget <id>         archive one memory (recoverable)
 *   /memory dream               run one Dream consolidation now
 *   /memory help                usage
 *
 * `/remember <text>` is registered as a shortcut for `remember`.
 *
 * No runtime import of the commands package: the service is resolved through
 * the lenient `ctx.get('commands')` and consumed structurally, so the plugin
 * still loads in a composition without it (a single warning).
 */
import type { StoreLogger } from './store.ts';
import type { MemoryCore } from './core.ts';
import type { MemorySettings } from './settings.ts';
import type { DreamEngine } from './dream.ts';
import { MemoryPolicyError } from './types.ts';

/** Command outcome shape accepted by the commands registry. */
type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string };

/** The `commands` service face dsh-memory consumes. */
export interface CommandsService {
  register(definition: {
    name: string;
    description: string;
    input?: { hint: string };
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
  }): () => void;
}

/** Agent/session context the registry hands to one invocation. */
export interface CommandInvocation {
  agent?: {
    id?: string;
    session?: {
      id?: string;
      header?: { cwd?: string };
    };
  } | null;
  readonly rawInput: string;
}

export interface CommandsCtx {
  get: (name: string) => unknown;
}

const HELP = [
  '/memory status — store counts, pending captures, last Dream',
  '/memory recall <query> — search this project + global memory',
  '/memory search <query> — search every known store',
  '/memory remember <text> — store a durable memory',
  '/memory forget <id> — archive one memory (recoverable)',
  '/memory dream — run one Dream consolidation now',
].join('\n');

/** Trim the leading separator and surrounding whitespace off raw input. */
function payload(rawInput: string): string {
  return rawInput.replace(/^[\s:：]+/, '').trim();
}

/** First word (lowercased) + remainder of one command line. */
function splitVerb(input: string): { verb: string; rest: string } {
  const trimmed = input.trim();
  if (trimmed === '') return { verb: '', rest: '' };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (match === null) return { verb: '', rest: '' };
  return { verb: (match[1] ?? '').toLowerCase(), rest: (match[2] ?? '').trim() };
}

function cwdOf(invocation: CommandInvocation): string | null {
  const cwd = invocation.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

function sessionIdOf(invocation: CommandInvocation): string | undefined {
  const id = invocation.agent?.session?.id ?? invocation.agent?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** One compact hit line for command output. */
function hitLine(hit: { store: string; id: string; kind: string; title: string; snippet: string; score: number }): string {
  const snippet = hit.snippet !== '' ? ` — ${hit.snippet}` : '';
  return `- [${hit.kind}] ${hit.title}${snippet} (${hit.id} · ${hit.store} · ${hit.score})`;
}

/**
 * Register the slash commands for the caller's fiber lifetime. Absent
 * `commands` service degrades to a warning; a registration throw is contained.
 */
export function registerMemoryCommands(
  ctx: CommandsCtx,
  core: MemoryCore,
  getSettings: () => MemorySettings,
  engine: DreamEngine,
  logger: StoreLogger | null,
): (() => void) | null {
  const commands = ctx.get('commands') as CommandsService | undefined;
  if (!commands || typeof commands.register !== 'function') {
    logger?.warn('[dsh-memory] commands service unavailable; /memory command not registered');
    return null;
  }

  /** Execute one parsed `/memory` line. Never throws: errors become `kind:'error'`. */
  const run = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const st = getSettings();
    const { verb, rest } = splitVerb(payload(invocation.rawInput ?? ''));
    try {
      switch (verb === '' ? 'status' : verb) {
        case 'help':
          return { kind: 'success', text: HELP };
        case 'status': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          const report = await core.status(true);
          const lines = report.stores.map(
            (s) =>
              `- ${s.slug} (${s.kind}): ${s.cards} cards · ${s.superseded} superseded · ${s.pendingInbox} pending · ${s.archived} archived`,
          );
          return {
            kind: 'success',
            text: [
              `dsh-memory: ${report.totals.cards} live cards across ${report.totals.stores} store(s), ${report.totals.pendingInbox} pending capture(s).`,
              `Last Dream: ${report.lastDream ?? 'never'}.`,
              ...lines,
            ].join('\n'),
          };
        }
        case 'recall':
        case 'search': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          if (rest === '') return { kind: 'error', text: `usage: /memory ${verb} <query>` };
          const cwd = cwdOf(invocation);
          const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
          const { hits } = await core.recall(rest, {
            projectSlug: project?.slug ?? null,
            scope: verb === 'search' ? 'all' : 'both',
            k: st.recall.k,
            expandLinks: st.recall.expandLinks,
            linkDecay: st.recall.linkDecay,
          });
          if (hits.length === 0) return { kind: 'success', text: `No memory matches “${rest}”.` };
          return { kind: 'success', text: [`${hits.length} memory match(es) for “${rest}”:`, ...hits.map(hitLine)].join('\n') };
        }
        case 'remember': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          if (rest === '') return { kind: 'error', text: 'usage: /memory remember <text>' };
          const out = await core.remember(
            {
              content: rest,
              scope: 'auto',
              cwd: cwdOf(invocation),
              maxBytes: st.budget.maxCardBytes,
              piiMode: st.redact.pii,
            },
            'command',
            sessionIdOf(invocation),
          );
          const warns = out.warnings.length > 0 ? ` (redacted: ${out.warnings.join(', ')})` : '';
          return { kind: 'success', text: `Remembered in ${out.slug}: ${out.card.title} (${out.card.id})${warns}` };
        }
        case 'forget': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          if (rest === '') return { kind: 'error', text: 'usage: /memory forget <card-id> (archives; recoverable)' };
          const named = rest.split(/\s+/)[0] ?? '';
          const cwd = cwdOf(invocation);
          const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
          if (/^m-\d{8}-[a-z0-9]{4,10}$/.test(named)) {
            const out = await core.forget({ id: named, projectSlug: project?.slug ?? null }, 'command', sessionIdOf(invocation));
            if (out.removed.length === 0) return { kind: 'error', text: `No card with id ${named} in this project or global memory.` };
            return { kind: 'success', text: `Archived ${out.removed.map((r) => `${r.id} (${r.slug})`).join(', ')}. Restore it from Settings → Memory → Archive.` };
          }
          const out = await core.forget({ query: rest, confirm: false, projectSlug: project?.slug ?? null }, 'command', sessionIdOf(invocation));
          const candidates = out.candidates ?? [];
          if (candidates.length === 0) return { kind: 'success', text: `No memory matches “${rest}”.` };
          return {
            kind: 'success',
            text: [
              `Dry run — would archive:`,
              ...candidates.map((c) => `- ${c.title} (${c.id} · ${c.slug} · ${c.score})`),
              'Re-run with an exact id: /memory forget <id>',
            ].join('\n'),
          };
        }
        case 'dream': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          if (!st.dream.enabled) return { kind: 'error', text: 'Dream is disabled (settings: memory.dream.enabled=false).' };
          const res = await engine.runNow({ reason: 'command', llm: engine.llmForRun() });
          if (res.busy) return { kind: 'success', text: 'A Dream run is already in flight.' };
          const lines = res.stores.map((s) => `- ${s.slug}: +${s.added} ~${s.updated} =${s.noop} ↓${s.archived} ⊃${s.superseded} ⊘${s.blocked} link=${s.relinked}`);
          return { kind: 'success', text: [`Dream finished in ${res.durationMs} ms (llm calls: ${res.llmCalls}).`, ...lines].join('\n') };
        }
        default:
          return { kind: 'error', text: `Unknown /memory subcommand “${verb}”.\n${HELP}` };
      }
    } catch (err) {
      if (err instanceof MemoryPolicyError) return { kind: 'error', text: `Blocked by policy: ${err.reasons.join(', ')}` };
      return { kind: 'error', text: `memory command failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const disposers: (() => void)[] = [];
  try {
    if (getSettings().commands.enabled) {
      disposers.push(
        commands.register({
          name: 'memory',
          description: 'dsh-memory: status, recall, remember, forget, dream',
          input: { hint: 'status | recall <query> | remember <text> | forget <id> | dream' },
          handler: run,
        }),
      );
      disposers.push(
        commands.register({
          name: 'remember',
          description: 'dsh-memory: store one durable memory (shortcut for /memory remember)',
          input: { hint: '<text>' },
          handler: (invocation) => {
            const text = payload(invocation.rawInput ?? '');
            return run({ ...invocation, rawInput: `remember ${text}` });
          },
        }),
      );
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // disposal must never throw during fiber teardown
        }
      }
    };
  } catch (err) {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // ignore a partial rollback failure
      }
    }
    logger?.warn(`[dsh-memory] command registration failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
