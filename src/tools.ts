/**
 * The model-facing memory tools. All share the failure contract: a disabled
 * memory (settings) is a clear error, a policy block is a structured result
 * (never a thrown secret), and every store mutation is audited.
 *
 *   memory_remember — store one durable memory (optionally correcting an older one)
 *   memory_recall   — ranked search with scope/kind/tag/time filters
 *   memory_get      — read one card in full (id, body, links, history pointers)
 *   memory_update   — write a corrected version that supersedes the old card
 *   memory_forget   — archive (default) or hard-delete; query mode is dry-run first
 *   memory_status   — store counts, kind/tag shape, inbox, last Dream run
 *   memory_dream    — trigger background consolidation
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
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

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return out.length > 0 ? out : undefined;
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
        'Store one durable memory (fact, preference, decision, procedure, commitment, observation, summary) in project or global memory. Secrets are blocked automatically. One memory per call; keep it self-contained. Pass `supersedes` with an existing card id when this CORRECTS an earlier memory — the old card is kept as history but stops being recalled.',
      parameters: {
        content: { type: 'string', required: true, description: 'The memory content (1–3 sentences, self-contained)' },
        kind: { type: 'string', description: 'fact | preference | decision | procedure | commitment | observation | summary (default: fact)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags (max 8)' },
        scope: { type: 'string', description: 'auto | project | global (default: auto → project when the cwd is inside a project)' },
        importance: { type: 'integer', description: '1–10 (default 5)' },
        supersedes: { type: 'string', description: 'Card id this memory corrects (bitemporal supersede; the old card is kept but no longer recalled)' },
        ttlDays: { type: 'integer', description: 'Optional validity window in days; after it the memory drops out of recall' },
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
        const a = (args ?? {}) as {
          content?: unknown;
          kind?: unknown;
          tags?: unknown;
          scope?: unknown;
          importance?: unknown;
          supersedes?: unknown;
          ttlDays?: unknown;
        };
        try {
          const out = await core.remember(
            {
              content: typeof a.content === 'string' ? a.content : '',
              kind: typeof a.kind === 'string' ? a.kind : undefined,
              tags: Array.isArray(a.tags) ? a.tags : undefined,
              scope: typeof a.scope === 'string' ? a.scope : 'auto',
              cwd: cwdOf(exec),
              importance: typeof a.importance === 'number' ? a.importance : undefined,
              supersedes: typeof a.supersedes === 'string' ? a.supersedes : undefined,
              ttlDays: typeof a.ttlDays === 'number' ? a.ttlDays : undefined,
              maxBytes: st.budget.maxCardBytes,
              // Honor the live PII setting on the explicit path too (warn
              // mode stores raw, redact mode masks; names-only in warnings).
              piiMode: st.redact.pii,
            },
            'tool',
            sessionIdOf(exec),
          );
          return {
            id: out.card.id,
            store: out.slug,
            title: out.card.title,
            blocked: false,
            reason: '',
            ...(out.card.supersedes.length > 0 ? { superseded: out.card.supersedes } : {}),
            ...(out.card.validUntil !== null ? { validUntil: out.card.validUntil } : {}),
            ...(out.warnings.length > 0 ? { piiWarnings: out.warnings } : {}),
          };
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
        'Recall durable memories by query. Default scope: the current project store + global. Filters narrow the result (kind, tags, since, importance, store); `scope: "all"` searches every known project store. Use before answering long-term questions, resuming prior work, or when the user refers to earlier context.',
      parameters: {
        query: { type: 'string', required: true, description: 'Natural-language query' },
        k: { type: 'integer', description: 'Max results (default 8, max 50)' },
        scope: { type: 'string', description: 'both (default) | global | project | all (every project store)' },
        store: { type: 'string', description: 'Restrict to one store slug (default: current project + global)' },
        kind: { type: 'string', description: 'Restrict to one memory kind (fact/preference/decision/procedure/commitment/observation/summary)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Require at least one of these tags' },
        since: { type: 'string', description: 'Only memories updated at/after this ISO-8601 timestamp' },
        minImportance: { type: 'integer', description: 'Only memories with importance >= this (1–10)' },
        includeSuperseded: { type: 'boolean', description: 'Include cards already superseded by a correction (default false)' },
        expandLinks: { type: 'boolean', description: 'Promote 1-hop graph neighbours of the top hits (default: settings)' },
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
                  tags: { type: 'array', items: { type: 'string' } },
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
        const a = (args ?? {}) as Record<string, unknown>;
        const cwd = cwdOf(exec);
        const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
        const scope = typeof a.scope === 'string' ? a.scope : 'both';
        const kinds = typeof a.kind === 'string' && a.kind !== '' ? new Set([a.kind]) : undefined;
        const tags = stringsOf(a.tags);
        const storeSlug = typeof a.store === 'string' && a.store !== '' ? a.store : null;
        const { hits, counts } = await core.recall(typeof a.query === 'string' ? a.query : '', {
          projectSlug: project?.slug ?? null,
          scope: scope === 'all' || scope === 'global' || scope === 'project' ? scope : 'both',
          k: typeof a.k === 'number' ? a.k : st.recall.k,
          expandLinks: typeof a.expandLinks === 'boolean' ? a.expandLinks : st.recall.expandLinks,
          linkDecay: st.recall.linkDecay,
          filter: {
            kinds,
            tags: tags !== undefined ? new Set(tags) : undefined,
            stores: storeSlug !== null ? new Set([storeSlug]) : undefined,
            since: typeof a.since === 'string' ? a.since : undefined,
            minImportance: typeof a.minImportance === 'number' ? a.minImportance : undefined,
            includeSuperseded: a.includeSuperseded === true,
          },
        });
        return {
          hits: hits.map((h) => ({
            store: h.store,
            id: h.id,
            kind: h.kind,
            title: h.title,
            snippet: h.snippet,
            score: h.score,
            tags: h.tags,
            importance: h.importance,
            updated: h.updated,
            path: h.path,
            ...(h.supersededBy !== null ? { supersededBy: h.supersededBy } : {}),
          })),
          counts,
        };
      },
    }),
  );

  // ── memory_get ───────────────────────────────────────────────────────────
  tools.register(
    defineTool({
      name: 'memory_get',
      description:
        'Read one memory card in full by exact id (body, metadata, link graph, supersede history). Use after memory_recall when the snippet is not enough, or to follow a link id.',
      parameters: {
        id: { type: 'string', required: true, description: 'Exact card id (m-YYYYMMDD-…)' },
        store: { type: 'string', description: 'Store slug (default: search every store)' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            store: { type: 'string' },
            card: { type: 'object', additionalProperties: true },
          },
          additionalProperties: true,
        },
        render: jsonRender,
      },
      async execute(args: unknown) {
        const st = getSettings();
        if (!st.enabled) throw disabledError();
        const a = (args ?? {}) as { id?: unknown; store?: unknown };
        const id = typeof a.id === 'string' ? a.id : '';
        const ref = await core.getCard(typeof a.store === 'string' && a.store !== '' ? a.store : null, id);
        if (ref === null) return { found: false, store: '', card: {}, reason: 'not found' };
        return {
          found: true,
          store: ref.store,
          reason: '',
          // The card is JSON by construction (frontmatter scalars + arrays of
          // strings); the cast supplies the index signature the tool output
          // schema (additionalProperties: true) demands.
          card: { ...ref.card, path: ref.meta?.path ?? '' } as unknown as Record<string, JsonValue>,
        };
      },
    }),
  );

  // ── memory_update ────────────────────────────────────────────────────────
  tools.register(
    defineTool({
      name: 'memory_update',
      description:
        'Correct an existing memory: writes a NEW card with the given content and marks the old one superseded (kept on disk as history, no longer recalled). Use this instead of forget+remember whenever a stored fact changed.',
      parameters: {
        id: { type: 'string', required: true, description: 'Exact id of the card to correct' },
        content: { type: 'string', required: true, description: 'The corrected memory content (1–3 sentences)' },
        kind: { type: 'string', description: 'Optional new kind (default: keep the old kind)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional replacement tags' },
        importance: { type: 'integer', description: 'Optional new importance (1–10)' },
        store: { type: 'string', description: 'Store slug (default: the store that owns the id)' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            updated: { type: 'boolean' },
            id: { type: 'string' },
            superseded: { type: 'string' },
            store: { type: 'string' },
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
        const a = (args ?? {}) as { id?: unknown; content?: unknown; kind?: unknown; tags?: unknown; importance?: unknown; store?: unknown };
        const id = typeof a.id === 'string' ? a.id : '';
        const explicitStore = typeof a.store === 'string' && a.store !== '' ? a.store : null;
        const ref = await core.getCard(explicitStore, id);
        if (ref === null) return { updated: false, id, superseded: '', store: '', blocked: false, reason: 'not found' };
        try {
          const out = await core.updateCard(
            ref.store,
            id,
            {
              content: typeof a.content === 'string' ? a.content : '',
              kind: typeof a.kind === 'string' ? a.kind : undefined,
              tags: Array.isArray(a.tags) ? a.tags : undefined,
              importance: typeof a.importance === 'number' ? a.importance : undefined,
            },
            'tool',
            sessionIdOf(exec),
            st.redact.pii,
            st.budget.maxCardBytes,
          );
          if (out === null) return { updated: false, id, superseded: '', store: ref.store, blocked: false, reason: 'not found' };
          return {
            updated: true,
            id: out.card.id,
            superseded: id,
            store: ref.store,
            blocked: false,
            reason: '',
            title: out.card.title,
            ...(out.warnings.length > 0 ? { piiWarnings: out.warnings } : {}),
          };
        } catch (err) {
          if (err instanceof MemoryPolicyError) {
            return { updated: false, id, superseded: '', store: ref.store, blocked: true, reason: err.reasons.join(', ') };
          }
          throw err;
        }
      },
    }),
  );

  // ── memory_forget ────────────────────────────────────────────────────────
  tools.register(
    defineTool({
      name: 'memory_forget',
      description:
        'Forget a memory: archive (default, recoverable from archive/) or hard-delete (irreversible). Target by exact card id, or by query — a query forget is a DRY RUN unless confirm=true: it first returns the top-3 matches so you can decide.',
      parameters: {
        id: { type: 'string', description: 'Exact card id to forget' },
        query: { type: 'string', description: 'Or a query; forgets the top-3 matching memories when confirm=true' },
        hard: { type: 'boolean', description: 'Hard delete instead of archive (default: archive)' },
        confirm: { type: 'boolean', description: 'Required to actually delete query matches (default false = report candidates only)' },
        store: { type: 'string', description: 'Store slug to search/forget in (default: current project + global)' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            removed: { type: 'array', items: { type: 'object', additionalProperties: true } },
            candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          additionalProperties: true,
        },
        render: jsonRender,
      },
      async execute(args: unknown, exec: unknown) {
        const st = getSettings();
        if (!st.enabled) throw disabledError();
        const a = (args ?? {}) as { id?: unknown; query?: unknown; hard?: unknown; confirm?: unknown; store?: unknown };
        const cwd = cwdOf(exec);
        const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
        const slug = typeof a.store === 'string' && a.store !== '' ? a.store : (project?.slug ?? null);
        const out = await core.forget(
          {
            id: typeof a.id === 'string' ? a.id : undefined,
            query: typeof a.query === 'string' ? a.query : undefined,
            hard: a.hard === true,
            confirm: a.confirm === true,
            projectSlug: slug,
          },
          'tool',
          sessionIdOf(exec),
        );
        return {
          removed: out.removed.map((r) => ({ slug: r.slug, id: r.id, mode: r.mode })),
          ...(out.candidates !== undefined ? { candidates: out.candidates, note: 'dry run: re-issue with confirm=true to forget these' } : {}),
        };
      },
    }),
  );

  // ── memory_status ────────────────────────────────────────────────────────
  tools.register(
    defineTool({
      name: 'memory_status',
      description:
        'Show memory state: per-store card / archived / superseded counts, pending inbox, memory kinds and top tags, last Dream run. Works even when memory is disabled.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            schema: { type: 'number' },
            lastDream: { type: 'string' },
            totals: { type: 'object', additionalProperties: true },
            stores: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
          totals: report.totals,
          stores: report.stores.map((s) => ({
            slug: s.slug,
            kind: s.kind,
            projectPath: s.projectPath ?? '',
            cards: s.cards,
            archived: s.archived,
            superseded: s.superseded,
            pendingInbox: s.pendingInbox,
            kinds: s.kinds,
            topTags: s.topTags,
            bytes: s.bytes,
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
        'Background memory consolidation (Dream): ingest captures, dedup, decay, relink, resolve near-duplicate conflicts, reindex. Default: status only. Pass run=true to trigger a run now.',
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
            stores: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
          superseded: s.superseded,
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
              superseded: s.superseded,
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
