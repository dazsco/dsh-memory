/**
 * The five model-facing tools. All share the failure contract: a disabled
 * memory (settings) is a clear error, a policy block is a structured result
 * (never a thrown secret), and every store mutation is audited.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { StoreLogger } from './store.ts';
import type { MemoryCore } from './core.ts';
import { MemoryPolicyError } from './types.ts';
import type { MemorySettings } from './settings.ts';
import type { DreamEngine } from './dream.ts';

type ToolsService = { register: (definition: unknown) => () => void };

/** Structural view of the tool execution context (agent → session → header). */
interface ExecLike {
  agent?: {
    id?: string;
    session?: {
      id?: string;
      header?: { cwd?: string };
    };
  };
}

const textBlock = (s: string): ContentBlock => ({ type: 'text', text: s });
const jsonRender = (_args: unknown, value: unknown): ContentBlock[] => [textBlock(JSON.stringify(value))];

function disabledError(): Error {
  const e = new Error('dsh-memory is disabled (settings: memory.enabled=false). Enable it in settings to use memory tools.');
  (e as Error & { code?: string }).code = 'MEMORY_DISABLED';
  return e;
}

/** cwd of the calling session, when the registry attached the agent. */
function cwdOf(exec: unknown): string | null {
  const a = (exec as ExecLike | undefined)?.agent;
  const cwd = a?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

function sessionIdOf(exec: unknown): string | undefined {
  const a = (exec as ExecLike | undefined)?.agent;
  const id = a?.session?.id ?? a?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function registerMemoryTools(
  ctx: { get: (name: string) => unknown },
  core: MemoryCore,
  getSettings: () => MemorySettings,
  engine: DreamEngine,
  logger: StoreLogger | null,
): void {
  const tools = ctx.get('tools') as ToolsService | undefined;
  if (!tools || typeof tools.register !== 'function') {
    logger?.warn('[dsh-memory] tools service unavailable; memory tools not registered');
    return;
  }

  // ── memory_remember ──────────────────────────────────────────────────────
  tools.register(
    defineTool({
      name: 'memory_remember',
      description:
        'Store one durable memory (fact, preference, decision, procedure, or commitment) in project or global memory. Secrets are blocked automatically. One memory per call; keep it self-contained.',
      parameters: {
        content: { type: 'string', required: true, description: 'The memory content (1–3 sentences, self-contained)' },
        kind: { type: 'string', description: 'fact | preference | decision | procedure | commitment | observation (default: fact)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags (max 8)' },
        scope: { type: 'string', description: 'auto | project | global (default: auto → project when the cwd is inside a project)' },
        importance: { type: 'integer', description: '1–10 (default 5)' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            store: { type: 'string' },
            title: { type: 'string' },
            blocked: { type: 'boolean' },
            reason: { type: 'string' },
          },
          additionalProperties: true,
        },
        render: jsonRender,
      },
      async execute(args: unknown, exec: unknown) {
        const st = getSettings();
        if (!st.enabled) throw disabledError();
        const a = (args ?? {}) as { content?: unknown; kind?: unknown; tags?: unknown; scope?: unknown; importance?: unknown };
        try {
          const out = await core.remember(
            {
              content: typeof a.content === 'string' ? a.content : '',
              kind: typeof a.kind === 'string' ? a.kind : undefined,
              tags: Array.isArray(a.tags) ? a.tags : undefined,
              scope: typeof a.scope === 'string' ? a.scope : 'auto',
              cwd: cwdOf(exec),
              importance: typeof a.importance === 'number' ? a.importance : undefined,
              maxBytes: st.budget.maxCardBytes,
            },
            'tool',
            sessionIdOf(exec),
          );
          return { id: out.card.id, store: out.slug, title: out.card.title, blocked: false, reason: '' };
        } catch (err) {
          if (err instanceof MemoryPolicyError) {
            return { id: '', store: '', title: '', blocked: true, reason: err.reasons.join(', ') };
          }
          throw err;
        }
      },
    }),
  );

  // ── memory_recall ────────────────────────────────────────────────────────
  tools.register(
    defineTool({
      name: 'memory_recall',
      description:
        'Recall durable memories (current project + global) by query. Use before answering long-term questions, resuming prior work, or when the user refers to earlier context.',
      parameters: {
        query: { type: 'string', required: true, description: 'Natural-language query' },
        k: { type: 'integer', description: 'Max results (default 8)' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            hits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  store: { type: 'string' },
                  id: { type: 'string' },
                  kind: { type: 'string' },
                  title: { type: 'string' },
                  snippet: { type: 'string' },
                  score: { type: 'number' },
                  path: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
            counts: { type: 'object', additionalProperties: true },
          },
          additionalProperties: true,
        },
        render: jsonRender,
      },
      async execute(args: unknown, exec: unknown) {
        const st = getSettings();
        if (!st.enabled) throw disabledError();
        const a = (args ?? {}) as { query?: unknown; k?: unknown };
        const cwd = cwdOf(exec);
        const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
        const { hits, counts } = await core.recall(typeof a.query === 'string' ? a.query : '', {
          projectSlug: project?.slug ?? null,
          k: typeof a.k === 'number' ? a.k : 8,
        });
        return {
          hits: hits.map((h) => ({
            store: h.store,
            id: h.id,
            kind: h.kind,
            title: h.title,
            snippet: h.snippet,
            score: h.score,
            path: h.path,
          })),
          counts,
        };
      },
    }),
  );

  // ── memory_forget ────────────────────────────────────────────────────────
  tools.register(
    defineTool({
      name: 'memory_forget',
      description:
        'Forget a memory: archive (default, recoverable in archive/) or hard-delete (irreversible). Target by exact card id, or by query (forgets the top-3 matches).',
      parameters: {
        id: { type: 'string', description: 'Exact card id to forget' },
        query: { type: 'string', description: 'Or a query; forgets the top-3 matching memories' },
        hard: { type: 'boolean', description: 'Hard delete instead of archive (default: archive)' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            removed: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  id: { type: 'string' },
                  mode: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
        render: jsonRender,
      },
      async execute(args: unknown, exec: unknown) {
        const st = getSettings();
        if (!st.enabled) throw disabledError();
        const a = (args ?? {}) as { id?: unknown; query?: unknown; hard?: unknown };
        const cwd = cwdOf(exec);
        const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
        const { removed } = await core.forget(
          {
            id: typeof a.id === 'string' ? a.id : undefined,
            query: typeof a.query === 'string' ? a.query : undefined,
            hard: a.hard === true,
            projectSlug: project?.slug ?? null,
          },
          'tool',
          sessionIdOf(exec),
        );
        return { removed: removed.map((r) => ({ slug: r.slug, id: r.id, mode: r.mode })) };
      },
    }),
  );

  // ── memory_status ────────────────────────────────────────────────────────
  tools.register(
    defineTool({
      name: 'memory_status',
      description: 'Show memory state: per-store card counts, pending inbox, last Dream run. Works even when memory is disabled.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            schema: { type: 'number' },
            lastDream: { type: 'string' },
            stores: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  kind: { type: 'string' },
                  projectPath: { type: 'string' },
                  cards: { type: 'number' },
                  archived: { type: 'number' },
                  pendingInbox: { type: 'number' },
                  lastDream: { type: 'string' },
                  root: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
        render: jsonRender,
      },
      async execute() {
        const report = await core.status(getSettings().enabled);
        return {
          enabled: report.enabled,
          schema: report.schema,
          lastDream: report.lastDream ?? '',
          stores: report.stores.map((s) => ({
            slug: s.slug,
            kind: s.kind,
            projectPath: s.projectPath ?? '',
            cards: s.cards,
            archived: s.archived,
            pendingInbox: s.pendingInbox,
            lastDream: s.lastDream ?? '',
            root: s.root,
          })),
        };
      },
    }),
  );

  // ── memory_dream ─────────────────────────────────────────────────────────
  tools.register(
    defineTool({
      name: 'memory_dream',
      description:
        'Background memory consolidation (Dream): ingest captures, dedup, decay, relink, reindex. Default: status only. Pass run=true to trigger a run now.',
      parameters: {
        run: { type: 'boolean', description: 'true → trigger a Dream run now (default false = status only)' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            started: { type: 'boolean' },
            busy: { type: 'boolean' },
            ts: { type: 'string' },
            durationMs: { type: 'number' },
            enabled: { type: 'boolean' },
            schema: { type: 'number' },
            lastDream: { type: 'string' },
            stores: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  kind: { type: 'string' },
                  projectPath: { type: 'string' },
                  cards: { type: 'number' },
                  archived: { type: 'number' },
                  pendingInbox: { type: 'number' },
                  lastDream: { type: 'string' },
                  root: { type: 'string' },
                  added: { type: 'number' },
                  updated: { type: 'number' },
                  noop: { type: 'number' },
                  blocked: { type: 'number' },
                  relinked: { type: 'number' },
                  error: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
        render: jsonRender,
      },
      async execute(args: unknown) {
        const st = getSettings();
        if (!st.enabled) throw disabledError();
        const a = (args ?? {}) as { run?: unknown };
        const report = await core.status(st.enabled);
        const statusStores = report.stores.map((s) => ({
          slug: s.slug,
          kind: s.kind,
          projectPath: s.projectPath ?? '',
          cards: s.cards,
          archived: s.archived,
          pendingInbox: s.pendingInbox,
          lastDream: s.lastDream ?? '',
          root: s.root,
          added: 0,
          updated: 0,
          noop: 0,
          blocked: 0,
          relinked: 0,
          error: '',
        }));
        const base = {
          enabled: report.enabled,
          schema: report.schema,
          lastDream: report.lastDream ?? '',
        };
        if (a.run === true) {
          const res = await engine.runNow({ reason: 'tool', llm: engine.llmForRun() });
          return {
            started: !res.busy,
            busy: res.busy,
            ts: res.ts,
            durationMs: res.durationMs,
            ...base,
            stores: res.stores.map((s) => ({
              slug: s.slug,
              added: s.added,
              updated: s.updated,
              noop: s.noop,
              archived: s.archived,
              blocked: s.blocked,
              relinked: s.relinked,
              error: s.error ?? '',
            })),
          };
        }
        return {
          started: false,
          busy: false,
          ts: '',
          durationMs: 0,
          ...base,
          stores: statusStores,
        };
      },
    }),
  );
}
