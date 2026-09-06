/**
 * dsh-memory — browse + per-card management surface for the Web GUI.
 *
 * Seven exact fetch routes under /api/memory/* (registered on the `connection`
 * service, the same channel session-log-export and file-upload use):
 *
 *   GET  /api/memory/summary       store roster: counts, archived, pending, last Dream
 *   GET  /api/memory/cards         one store's cards; ?query= ranks, ?limit= pages
 *   GET  /api/memory/card          one card in full
 *   GET  /api/memory/inbox         one store's pending captures
 *   GET  /api/memory/archive       one store's archived cards (newest first)
 *   POST /api/memory/card/forget   {store,id,hard} — archive or hard-delete
 *   POST /api/memory/card/restore  {store,id} — archive → cards inverse move
 *
 * Design notes:
 *  - Single-writer discipline is preserved. The v2 mutation routes are NOT raw
 *    writes: they go through the same store ops the agent tools use
 *    (core.forgetCardIn → store.archiveCard/deleteCardHard; core.restoreCardIn
 *    → store.restoreCard), each under the store lock, each audited
 *    (op archive/hard-delete/restore, via 'client'). The Dream pipeline's
 *    invariants (atomic moves, rebuild-after-mutation, append-only audit)
 *    are untouched.
 *  - What is served is exactly what is stored: cards pass the secret gate
 *    and PII policy before landing on disk, and the session brief already
 *    injects card content into model context, so the GUI adds visibility
 *    without expanding exposure. Audit log content is NEVER served.
 *  - Failure contract: bad params/body → 400 {error}, unknown store/card →
 *    404, anything unexpected → 500 with a generic message (details are
 *    logged on the Host and never cross the wire).
 *  - Degrades to absent when the `connection` service is not composed
 *    (minimal/headless profiles): a single warning, no throw.
 */
// Type-only: cordis's `Effect` is the accepted effect-body result shape, so
// `BrowseCtx` stays assignable-compatible with the real `Context`.
import type { Effect } from '@deepseek-ai/cordis';
import { isValidCardId } from './cards.ts';
import type { MemoryCore } from './core.ts';
import type { MemoryStore } from './store.ts';
import type { StoreLogger } from './store.ts';
import { bm25Score, tokenize } from './retrieval.ts';
import type { CardMeta, InboxEntry, MemoryCard } from './types.ts';

// ── view types (single source for Host handlers and Client imports) ───────

/** One store row of the roster (StoreStatus minus the on-disk root). */
export interface BrowseStoreSummary {
  slug: string;
  kind: 'global' | 'project';
  projectPath: string | null;
  cards: number;
  archived: number;
  pendingInbox: number;
  lastDream: string | null;
}

export interface BrowseSummary {
  enabled: boolean;
  schema: number;
  lastDream: string | null;
  stores: BrowseStoreSummary[];
}

/** One card row of the browse list (CardMeta minus path/digest/tokens). */
export interface BrowseCardSummary {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  importance: number;
  confidence: number;
  created: string;
  updated: string;
  lastAccessed: string;
  accessCount: number;
  validUntil: string | null;
  supersedes: string[];
  links: string[];
  /** BM25+tag relevance when a query is active; null in recency order. */
  score: number | null;
}

export interface BrowseCardList {
  store: string;
  total: number;
  truncated: boolean;
  cards: BrowseCardSummary[];
}

export interface BrowseCardDetail {
  store: string;
  card: MemoryCard;
}

export interface BrowseInbox {
  store: string;
  count: number;
  truncated: boolean;
  /** File order (chronological); the Client may display newest first. */
  entries: InboxEntry[];
}

/** One archived card row (browse view; content stays on disk). */
export interface BrowseArchivedCard {
  id: string;
  title: string;
  kind: string;
  /** Archive time (archive file mtime, ISO). */
  archivedAt: string;
}

export interface BrowseArchiveList {
  store: string;
  total: number;
  truncated: boolean;
  cards: BrowseArchivedCard[];
}

/** Result of one per-card mutation (v2). */
export interface BrowseCardActionResult {
  store: string;
  id: string;
  mode: 'archive' | 'hard-delete' | 'restore';
}

// ── handlers ──────────────────────────────────────────────────────────────

/** Everything the handlers need; no live Cordis objects ride in the JSON. */
export interface MemoryBrowseDeps {
  core: MemoryCore;
  /** Live `memory.enabled` flag; reported in the summary, never gates reads. */
  isEnabled: () => boolean;
  logger: StoreLogger;
}

type Handler = (request: Request) => Promise<Response>;

/** Deliberate HTTP failure: the message is safe to send to the browser. */
class BrowseHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BrowseHttpError';
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function notFound(message: string): BrowseHttpError {
  return new BrowseHttpError(404, message);
}

function badRequest(message: string): BrowseHttpError {
  return new BrowseHttpError(400, message);
}

/** Wrap a handler: deliberate errors map to their status, the rest to 500. */
function safe(deps: MemoryBrowseDeps, inner: () => Promise<Response>): Promise<Response> {
  return Promise.resolve()
    .then(inner)
    .catch((err) => {
      if (err instanceof BrowseHttpError) return json({ error: err.message }, err.status);
      deps.logger.warn(`[dsh-memory] browse handler failed: ${err instanceof Error ? err.message : String(err)}`);
      return json({ error: 'internal error' }, 500);
    });
}

function requireStore(core: MemoryCore, params: URLSearchParams): MemoryStore {
  const slug = params.get('store');
  if (slug === null || slug.length === 0) throw badRequest('missing store parameter');
  const store = core.storeBySlug(slug);
  if (store === null) throw notFound(`unknown store: ${slug}`);
  return store;
}

/** POST bodies carry the store slug as a field, not a query parameter. */
function requireStoreBody(core: MemoryCore, body: Record<string, unknown>): MemoryStore {
  const slug = body.store;
  if (typeof slug !== 'string' || slug.length === 0) throw badRequest('missing store field');
  const store = core.storeBySlug(slug);
  if (store === null) throw notFound(`unknown store: ${slug}`);
  return store;
}

function limitOf(params: URLSearchParams, def = 50, max = 200): number {
  const raw = params.get('limit');
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest('limit must be a positive integer');
  return Math.min(max, n);
}

/** The mutation bodies are tiny; reject anything beyond this early. */
const MAX_MUTATION_BODY_BYTES = 4096;

/** Parse a small JSON object body; 400 on size overflow or malformed JSON. */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_MUTATION_BODY_BYTES) throw badRequest('body too large');
  if (buffer.byteLength === 0) throw badRequest('missing JSON body');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(buffer));
  } catch {
    throw badRequest('body must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function requireId(body: Record<string, unknown>): string {
  const id = body.id;
  if (typeof id !== 'string' || id.length === 0) throw badRequest('missing id field');
  if (!/^m-\d{8}-[a-z0-9]{4,10}$/.test(id)) throw badRequest('malformed id');
  return id;
}

function cardSummary(id: string, meta: CardMeta, score: number | null): BrowseCardSummary {
  return {
    id,
    title: meta.title,
    kind: meta.kind,
    tags: [...meta.tags],
    importance: meta.importance,
    confidence: meta.confidence,
    created: meta.created,
    updated: meta.updated,
    lastAccessed: meta.lastAccessed,
    accessCount: meta.accessCount,
    validUntil: meta.validUntil,
    supersedes: [...meta.supersedes],
    links: [...meta.links],
    score: score === null ? null : Math.round(score * 1000) / 1000,
  };
}

/**
 * Build the seven route handlers over one MemoryCore (5 GET + 2 POST).
 * @param deps - core, live enabled flag, and the logger.
 */
export function makeBrowseHandlers(deps: MemoryBrowseDeps): {
  summary: Handler;
  cards: Handler;
  card: Handler;
  inbox: Handler;
  archive: Handler;
  forgetCard: Handler;
  restoreCard: Handler;
} {
  const summary: Handler = (request) =>
    safe(deps, async () => {
      const enabled = deps.isEnabled();
      const report = await deps.core.status(enabled);
      const body: BrowseSummary = {
        enabled,
        schema: report.schema,
        lastDream: report.lastDream,
        stores: report.stores.map((s) => ({
          slug: s.slug,
          kind: s.kind,
          projectPath: s.projectPath ?? null,
          cards: s.cards,
          archived: s.archived,
          pendingInbox: s.pendingInbox,
          lastDream: s.lastDream,
        })),
      };
      return json(body);
    });

  const cards: Handler = (request) =>
    safe(deps, async () => {
      const url = new URL(request.url);
      const store = requireStore(deps.core, url.searchParams);
      const limit = limitOf(url.searchParams);
      const query = (url.searchParams.get('query') ?? '').trim();

      const index = await store.readIndex();
      const corpus = await store.cardCorpus();
      const rows: { id: string; meta: CardMeta; tokens: string[]; rel: number }[] = [];
      const queryTokens = tokenize(query);
      const queryTokenSet = new Set(queryTokens);
      const scored = queryTokens.length > 0;

      for (const [id, { meta, tokens }] of corpus) {
        const rel = scored
          ? bm25Score(queryTokens, tokens, index.bm25.df, index.bm25.docCount, index.bm25.avgDocLen) +
            0.3 * meta.tags.filter((t) => queryTokenSet.has(t.toLowerCase())).length
          : 0;
        if (scored && rel <= 0) continue;
        rows.push({ id, meta, tokens, rel });
      }
      if (scored) rows.sort((a, b) => b.rel - a.rel);
      else rows.sort((a, b) => (a.meta.updated < b.meta.updated ? 1 : -1));

      const total = rows.length;
      const page = rows.slice(0, limit);
      const body: BrowseCardList = {
        store: store.slug,
        total,
        truncated: total > page.length,
        cards: page.map((r) => cardSummary(r.id, r.meta, scored ? r.rel : null)),
      };
      return json(body);
    });

  const card: Handler = (request) =>
    safe(deps, async () => {
      const url = new URL(request.url);
      const store = requireStore(deps.core, url.searchParams);
      const id = url.searchParams.get('id');
      if (id === null || id.length === 0) throw badRequest('missing id parameter');
      // A malformed id (path separators, traversal, junk) is a 400, not a
      // 404: it can never be a card that merely does not exist.
      if (!isValidCardId(id)) throw badRequest('malformed id');
      const found = await store.readCard(id);
      if (found === null) throw notFound(`unknown card: ${id}`);
      const body: BrowseCardDetail = { store: store.slug, card: found };
      return json(body);
    });

  const inbox: Handler = (request) =>
    safe(deps, async () => {
      const url = new URL(request.url);
      const store = requireStore(deps.core, url.searchParams);
      const limit = limitOf(url.searchParams);
      // PENDING entries only — the unconsumed tail since the last Dream
      // offset. Consumed lines stay in the file (compactInbox trims it later)
      // but are no longer "candidate pool"; counting them made the tab's
      // number grow forever and never reach zero.
      const state = await store.readState();
      const all = await store.readInbox(state.inboxOffset);
      const count = all.length;
      const entries: InboxEntry[] = all.slice(Math.max(0, count - limit));
      const body: BrowseInbox = { store: store.slug, count, truncated: count > entries.length, entries };
      return json(body);
    });

  const archive: Handler = (request) =>
    safe(deps, async () => {
      const url = new URL(request.url);
      const store = requireStore(deps.core, url.searchParams);
      const limit = limitOf(url.searchParams);
      const rows = await store.listArchived();
      const page = rows.slice(0, limit);
      const cards: BrowseArchivedCard[] = [];
      for (const row of page) {
        const card = await store.readArchivedCard(row.id);
        if (card === null) continue; // unreadable archive entry: skip, keep the rest
        cards.push({ id: row.id, title: card.title, kind: card.kind, archivedAt: row.archivedAt });
      }
      const body: BrowseArchiveList = { store: store.slug, total: rows.length, truncated: rows.length > page.length, cards };
      return json(body);
    });

  const forgetCard: Handler = (request) =>
    safe(deps, async () => {
      const body = await readJsonBody(request);
      const store = requireStoreBody(deps.core, body);
      const id = requireId(body);
      const hard = body.hard === true;
      const result = await deps.core.forgetCardIn(store.slug, id, hard, 'client');
      if (result === null) throw notFound(`card not found in store: ${id}`);
      const out: BrowseCardActionResult = { store: store.slug, id, mode: hard ? 'hard-delete' : 'archive' };
      return json(out);
    });

  const restoreCard: Handler = (request) =>
    safe(deps, async () => {
      const body = await readJsonBody(request);
      const store = requireStoreBody(deps.core, body);
      const id = requireId(body);
      const ok = await deps.core.restoreCardIn(store.slug, id, 'client');
      if (!ok) throw notFound(`card not archived in store: ${id}`);
      const out: BrowseCardActionResult = { store: store.slug, id, mode: 'restore' };
      return json(out);
    });

  return { summary, cards, card, inbox, archive, forgetCard, restoreCard };
}

// ── route registration ────────────────────────────────────────────────────

/** The exact paths; query parameters carry the rest. */
export const MEMORY_BROWSE_PATHS = {
  summary: '/api/memory/summary',
  cards: '/api/memory/cards',
  card: '/api/memory/card',
  inbox: '/api/memory/inbox',
  archive: '/api/memory/archive',
  forget: '/api/memory/card/forget',
  restore: '/api/memory/card/restore',
} as const;

/** The `connection` service face needed for exact fetch routes. */
export interface BrowseConnection {
  fetch: {
    register(route: {
      path: string;
      methods: readonly string[];
      requestBody: 'buffered';
      fetch: Handler;
    }): () => Promise<void>;
  };
}

/** Structural ctx face: lenient service lookup + fiber-scoped effect. */
export interface BrowseCtx {
  get: (name: string) => unknown;
  effect: (setup: () => Effect, label?: string) => unknown;
}

/**
 * Register the browse routes for the row's fiber lifetime. Absent
 * `connection` degrades to a warning; a failed registration disposes whatever
 * was already registered and warns — the rest of the plugin keeps working.
 * @param ctx - the row context (lenient `get` + `effect`).
 * @param deps - core, enabled flag, logger.
 */
export function registerBrowseRoutes(ctx: BrowseCtx, deps: MemoryBrowseDeps): void {
  const connection = ctx.get('connection') as BrowseConnection | undefined;
  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    deps.logger.warn('[dsh-memory] connection service unavailable; memory browse routes not registered');
    return;
  }
  const handlers = makeBrowseHandlers(deps);
  const routes: { path: string; methods: readonly string[]; fetch: Handler }[] = [
    { path: MEMORY_BROWSE_PATHS.summary, methods: ['GET'], fetch: handlers.summary },
    { path: MEMORY_BROWSE_PATHS.cards, methods: ['GET'], fetch: handlers.cards },
    { path: MEMORY_BROWSE_PATHS.card, methods: ['GET'], fetch: handlers.card },
    { path: MEMORY_BROWSE_PATHS.inbox, methods: ['GET'], fetch: handlers.inbox },
    { path: MEMORY_BROWSE_PATHS.archive, methods: ['GET'], fetch: handlers.archive },
    { path: MEMORY_BROWSE_PATHS.forget, methods: ['POST'], fetch: handlers.forgetCard },
    { path: MEMORY_BROWSE_PATHS.restore, methods: ['POST'], fetch: handlers.restoreCard },
  ];
  const disposers: Array<() => Promise<void>> = [];
  try {
    for (const route of routes) {
      disposers.push(
        connection.fetch.register({ path: route.path, methods: route.methods, requestBody: 'buffered', fetch: route.fetch }),
      );
    }
    ctx.effect(
      () => async () => {
        for (const dispose of disposers.reverse()) await dispose();
      },
      'dsh-memory: browse routes',
    );
  } catch (err) {
    void Promise.allSettled(disposers.map((dispose) => dispose())).catch(() => undefined);
    disposers.length = 0;
    deps.logger.warn(`[dsh-memory] browse route registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
