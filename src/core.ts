/**
 * MemoryCore: the façade over the global store + all project stores.
 *
 * Stores live ONLY under $DSH_HOME/memory (global/ + projects/<slug>/) —
 * nothing is ever written into a project directory. Project roots are
 * discovered by walking up from the session cwd to the nearest `.git`, the
 * same convention dsh-agent-instructions uses for AGENTS.md scopes.
 */
import { join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import type { StoreLogger } from './store.ts';
import { MemoryStore } from './store.ts';
import {
  findProjectRoot,
  globalStoreRoot,
  listProjectSlugs,
  memoryRoot,
  registerProjectPath,
  storePathsFor,
} from './paths.ts';
import { readTextSafe, mtimeMsSafe } from './fsutil.ts';
import { isValidCardId, makeCardId } from './cards.ts';
import { gateCandidate, type PiiMode } from './redact.ts';
import { emptyRules, parseMemorySection, mergeRules } from './rules.ts';
import type { MemoryRules } from './rules.ts';
import {
  bm25Score,
  cardRecency,
  cardStrength,
  compositeScore,
  expandLinks,
  makeSnippet,
  passesFilter,
  rankWithMmr,
  tokenize,
  type RecallFilter,
  type ScoredCandidate,
} from './retrieval.ts';
import { dedupDecide, normalizeMemoryText } from './dedup.ts';
import {
  MEMORY_SCHEMA_VERSION,
  MEMORY_KINDS,
  MemoryPolicyError,
  type AuditVia,
  type CardMeta,
  type InboxEntry,
  type MemoryCard,
  type MemoryExportBundle,
  type MemoryExportStore,
  type MemoryImportResult,
  type MemoryImportStoreResult,
  type MemoryKind,
  type RecallHit,
  type StatusReport,
  type StoreStatus,
} from './types.ts';

export interface RememberInput {
  content: string;
  kind?: string;
  tags?: unknown;
  /** project | global | auto (default). */
  scope?: string;
  /** Session cwd for project resolution (scope auto/project). */
  cwd?: string | null;
  importance?: number;
  /** Card content byte cap (settings budget). */
  maxBytes?: number;
  /**
   * PII policy for THIS write (settings `redact.pii`). Defaults to 'redact' so
   * direct core callers without a settings view keep the safe default; the
   * tool path always passes the live setting.
   */
  piiMode?: PiiMode;
  /**
   * Card id this new memory corrects. The target is marked superseded
   * (bitemporal: `validUntil` + `supersededBy`) in the same operation, so the
   * corrected card leaves recall while its history stays on disk.
   */
  supersedes?: string;
  /** Optional validity window: validUntil = now + ttlDays. */
  ttlDays?: number;
  /**
   * Write to this EXACT store slug, bypassing scope/cwd resolution (GUI and
   * import paths). Unknown slug → an error.
   */
  targetSlug?: string;
}

export interface RecallOptions {
  /** Include this project store (null/absent → global only for 'both' scope). */
  projectSlug?: string | null;
  /**
   * 'global' | 'project' | 'both' (default: current project + global) |
   * 'all' (every discovered project store as well).
   */
  scope?: 'global' | 'project' | 'both' | 'all';
  k?: number;
  now?: Date;
  /** Structured metadata filter (kind / tag / store / since / superseded). */
  filter?: RecallFilter;
  /** Expand the ranking through the 1-hop link graph (A-MEM). Default true. */
  expandLinks?: boolean;
  /** Link-promotion factor, 0..1 (default 0.5). */
  linkDecay?: number;
}

export interface ForgetOptions {
  id?: string;
  query?: string;
  hard?: boolean;
  projectSlug?: string | null;
  /**
   * Query-mode safety: without `confirm`, a query forget returns the top
   * matches as candidates instead of destroying them. An exact-id forget
   * never needs confirmation.
   */
  confirm?: boolean;
}

export interface ForgetResult {
  removed: { slug: string; id: string; mode: 'archive' | 'hard-delete' }[];
  /** Query mode without `confirm`: what the call WOULD have forgotten. */
  candidates?: { slug: string; id: string; title: string; score: number }[];
}

/** One resolved card plus its store (returns of {@link MemoryCore.getCard}). */
export interface CardRef {
  store: string;
  kind: 'global' | 'project';
  card: MemoryCard;
  meta: CardMeta | null;
}

const AGENTS_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** Cache key for the rules layers of one store (file mtimes, in order). */
interface RulesCacheEntry {
  key: string;
  rules: MemoryRules;
}

export class MemoryCore {
  readonly root: string;
  readonly global: MemoryStore;
  private projects = new Map<string, MemoryStore>();
  private projectRootCache = new Map<string, string | null>();
  /** Root → registered slug, so repeat calls never rewrite the registry. */
  private projectSlugCache = new Map<string, string>();
  /** Slug → rules, keyed by the mtimes of the AGENTS.md layers behind it. */
  private rulesCache = new Map<string, RulesCacheEntry>();
  private logger: StoreLogger | null;

  private constructor(root: string, logger: StoreLogger | null) {
    this.root = root;
    this.logger = logger;
    this.global = new MemoryStore('global', 'global', storePathsFor(globalStoreRoot()), logger);
  }

  /** Create the core and discover existing stores on disk. */
  static async create(opts: { root?: string; logger?: StoreLogger | null } = {}): Promise<MemoryCore> {
    const root = opts.root ?? memoryRoot();
    const logger = opts.logger ?? null;
    const core = new MemoryCore(root, logger);
    await core.global.init();
    const slugs = await listProjectSlugs(root);
    for (const slug of slugs) {
      const store = new MemoryStore('project', slug, storePathsFor(join(root, 'projects', slug)), logger);
      await store.init();
      core.projects.set(slug, store);
    }
    return core;
  }

  allStores(): MemoryStore[] {
    return [this.global, ...this.projects.values()];
  }

  storeBySlug(slug: string): MemoryStore | null {
    if (slug === 'global') return this.global;
    return this.projects.get(slug) ?? null;
  }

  /**
   * Resolve (and register ONCE per process, on first sight) the project store
   * for a cwd. The registry read-modify-write is expensive and racy across
   * processes, so the root→slug mapping is cached: after the first
   * registration for a root, every recall/remember hits this cache instead
   * of rewriting projects.json.
   */
  async projectStoreForCwd(cwd: string | null | undefined): Promise<MemoryStore | null> {
    if (!cwd) return null;
    let root: string | null;
    const cached = this.projectRootCache.get(cwd);
    if (cached !== undefined) {
      root = cached;
    } else {
      root = await findProjectRoot(cwd).catch(() => null);
      this.projectRootCache.set(cwd, root);
    }
    if (root === null) return null;
    const cachedSlug = this.projectSlugCache.get(root);
    if (cachedSlug !== undefined) return this.projects.get(cachedSlug) ?? null;
    const { slug, storeRoot } = await registerProjectPath(root);
    this.projectSlugCache.set(root, slug);
    let store = this.projects.get(slug);
    if (store === undefined) {
      store = new MemoryStore('project', slug, storePathsFor(storeRoot), this.logger);
      await store.init();
      this.projects.set(slug, store);
    }
    return store;
  }

  /** Project path behind a store (from the registry). */
  async projectPathOf(slug: string): Promise<string | null> {
    const store = this.projects.get(slug);
    if (store === undefined) return null;
    const { loadProjectsRegistry } = await import('./paths.ts');
    const reg = await loadProjectsRegistry();
    return reg.projects[slug]?.path ?? null;
  }

  /**
   * Effective rules for one store: user-global AGENTS.md + project AGENTS.md
   * (CLAUDE.md fallback), most specific last.
   *
   * Cached per slug behind an mtime key: rules are re-read only when one of
   * the backing files actually changed. Dream calls this once per inbox entry,
   * so without the cache a busy capture queue re-read and re-parsed AGENTS.md
   * hundreds of times per run.
   */
  async rulesFor(slug: string): Promise<MemoryRules> {
    const home = dshHomePath();
    const candidates: { file: string; project: boolean }[] = [];
    for (const name of AGENTS_CANDIDATES) candidates.push({ file: join(home, name), project: false });
    if (slug !== 'global') {
      const projectRoot = await this.projectPathOf(slug);
      if (projectRoot) for (const name of AGENTS_CANDIDATES) candidates.push({ file: join(projectRoot, name), project: true });
    }
    const key = (await Promise.all(candidates.map((c) => mtimeMsSafe(c.file).catch(() => null))))
      .map((v) => (v === null ? '-' : String(v)))
      .join('|');
    const cached = this.rulesCache.get(slug);
    if (cached !== undefined && cached.key === key) return cached.rules;

    const parsed: MemoryRules[] = [];
    let projectLayerTaken = false;
    for (const { file, project } of candidates) {
      const text = await readTextSafe(file).catch(() => null);
      if (text === null) continue;
      // First project-level AGENTS.md/CLAUDE.md that carries a Memory section
      // wins; the user-level layers all stack, least specific first.
      if (project && projectLayerTaken) continue;
      const section = parseMemorySection(text);
      if (section === null) continue;
      parsed.push(section);
      if (project) projectLayerTaken = true;
    }
    const rules = parsed.length === 0 ? emptyRules() : mergeRules(parsed);
    this.rulesCache.set(slug, { key, rules });
    return rules;
  }

  // ── write path ──────────────────────────────────────────────────────────

  /**
   * Explicit remember (tool). Policy gate first (secrets block, rules deny,
   * PII policy), then atomic card write + audit. `warnings` carries the PII
   * category NAMES detected by the gate (warn mode: stored raw; redact mode:
   * stored masked) — never the matched content.
   */
  async remember(
    input: RememberInput,
    via: AuditVia,
    sessionId?: string,
  ): Promise<{ card: MemoryCard; slug: string; path: string; warnings: string[] }> {
    const scope = (input.scope ?? 'auto') as 'project' | 'global' | 'auto';
    let store: MemoryStore;
    if (typeof input.targetSlug === 'string' && input.targetSlug !== '') {
      const exact = this.storeBySlug(input.targetSlug);
      if (exact === null) throw new Error(`unknown memory store: ${input.targetSlug}`);
      store = exact;
    } else if (scope === 'global') {
      store = this.global;
    } else {
      const project = await this.projectStoreForCwd(input.cwd);
      if (project === null) {
        if (scope === 'project') throw new Error('no project memory: cwd has no project root (.git)');
        store = this.global;
      } else {
        store = project;
      }
    }

    const content = normalizeMemoryText(String(input.content ?? '').trim());
    if (!content) throw new Error('memory content is empty');
    const maxBytes = input.maxBytes ?? 4096;
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new Error(`memory content exceeds ${maxBytes} bytes`);
    }

    const rules = await this.rulesFor(store.slug);
    // The explicit remember path honors the live `redact.pii` setting too —
    // previously it was hard-coded to 'redact' while capture/dream used the
    // setting, so the GUI knob silently did not cover tool writes.
    const gated = gateCandidate(content, rules.denyKeywords, input.piiMode ?? 'redact');
    if (!gated.ok) {
      await store.audit({
        ts: new Date().toISOString(),
        store: store.slug,
        op: 'block',
        detail: gated.reasons.join(','),
        via,
        session: sessionId,
      });
      throw new MemoryPolicyError(gated.reasons);
    }

    // The card is built from the GATED text: in redact mode this is the
    // masked version (building from `content` would store the raw PII the
    // gate was supposed to remove).
    const safe = gated.text;
    const now = new Date().toISOString();
    const kind: MemoryKind =
      typeof input.kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(input.kind)
        ? (input.kind as MemoryKind)
        : 'fact';
    const ttlDays = typeof input.ttlDays === 'number' && Number.isFinite(input.ttlDays) && input.ttlDays > 0 ? input.ttlDays : null;
    const card: MemoryCard = {
      id: makeCardId(),
      kind,
      tags: normalizeTags(input.tags),
      importance: clampImportance(input.importance),
      confidence: 0.6,
      created: now,
      updated: now,
      lastAccessed: now,
      accessCount: 0,
      validSince: now,
      validUntil: ttlDays === null ? null : new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
      supersedes: [],
      supersededBy: null,
      source: { session: sessionId ?? '', turn: null },
      links: [],
      title: firstLine(safe),
      body: safe === firstLine(safe) ? '' : safe.slice(firstLine(safe).length).trim(),
    };
    // Bitemporal correction: the new card is written first, then the target is
    // stamped — a crash between the two leaves a duplicate live card (harmless,
    // dedupable) rather than an orphaned history hole.
    if (typeof input.supersedes === 'string' && isValidCardId(input.supersedes)) {
      const target = await store.readCard(input.supersedes);
      if (target === null) throw new Error(`supersede target not found in ${store.slug}: ${input.supersedes}`);
      card.supersedes = [input.supersedes];
      await store.putCard(card, { rebuild: false });
      await store.supersedeCard(input.supersedes, card.id, now, { rebuild: false });
      await store.audit({
        ts: now,
        store: store.slug,
        op: 'supersede',
        id: input.supersedes,
        detail: `→ ${card.id}`,
        via,
        session: sessionId,
      });
      await store.rebuildIndex();
    } else {
      await store.putCard(card);
    }
    await store.audit({
      ts: now,
      store: store.slug,
      op: 'create',
      id: card.id,
      detail: card.title.slice(0, 80),
      via,
      session: sessionId,
    });
    return { card, slug: store.slug, path: join(store.paths.cards, `${card.id}.md`), warnings: gated.warnings };
  }

  /** Stage one capture in a store's inbox (auto-capture path). */
  async pushInbox(store: MemoryStore, entry: InboxEntry): Promise<void> {
    await store.pushInbox(entry);
  }

  // ── read path ───────────────────────────────────────────────────────────

  /**
   * Rank cards across the requested stores.
   *
   * Score shape: BM25 relevance (with a tag-hit bonus) normalized by the
   * best candidate, then composite-scored with recency/importance/confidence
   * and access strength. MMR keeps the top-k diverse; an optional one-hop
   * link expansion (A-MEM) then promotes graph neighbours of the winners.
   *
   * @param query - free-text query; empty ranks by score shape alone.
   * @param opts - scope, k, filters, link expansion, clock.
   */
  async recall(query: string, opts: RecallOptions = {}): Promise<{ hits: RecallHit[]; counts: Record<string, number> }> {
    const now = opts.now ?? new Date();
    const k = Math.min(50, Math.max(1, opts.k ?? 8));
    const scope = opts.scope ?? 'both';
    const stores: MemoryStore[] = [];
    const addStore = (store: MemoryStore | null | undefined): void => {
      if (store && !stores.includes(store)) stores.push(store);
    };
    if (scope === 'global' || scope === 'both' || scope === 'all') addStore(this.global);
    if (scope === 'project' || scope === 'both' || scope === 'all') {
      addStore(opts.projectSlug ? this.projects.get(opts.projectSlug) : null);
    }
    if (scope === 'all') for (const store of this.projects.values()) addStore(store);
    if (opts.filter?.stores !== undefined && opts.filter.stores.size > 0) {
      for (let i = stores.length - 1; i >= 0; i--) {
        const slug = stores[i]?.slug;
        if (slug === undefined || !opts.filter.stores.has(slug)) stores.splice(i, 1);
      }
    }

    const queryTokens = tokenize(query);
    const queryTagSet = new Set(queryTokens);
    interface Candidate {
      store: MemoryStore;
      id: string;
      title: string;
      kind: MemoryKind;
      meta: CardMeta;
      tokens: string[];
      rel: number;
    }
    const candidates: Candidate[] = [];
    const counts: Record<string, number> = {};

    for (const store of stores) {
      const index = await store.readIndex();
      const corpus = await store.cardCorpus();
      counts[store.slug] = corpus.size;
      for (const [id, entry] of corpus) {
        if (!passesFilter(entry.meta, opts.filter)) continue;
        const rel =
          bm25Score(queryTokens, entry.tokens, index.bm25.df, index.bm25.docCount, index.bm25.avgDocLen) +
          0.3 * entry.meta.tags.filter((t) => queryTagSet.has(t.toLowerCase())).length;
        candidates.push({
          store,
          id,
          title: entry.meta.title,
          kind: entry.meta.kind,
          meta: entry.meta,
          tokens: entry.tokens,
          rel,
        });
      }
    }

    const maxRel = Math.max(0, ...candidates.map((c) => c.rel));
    // One pool keyed by card id. The full pool (including zero-relevance
    // cards) is what link expansion may draw from; only the *ranking* input is
    // filtered to score > 0. Cards carry their owning store so the winner is
    // always resolved against the store it was admitted from.
    const pool = new Map<string, ScoredCandidate & { memStore: MemoryStore }>();
    const scored: (ScoredCandidate & { memStore: MemoryStore })[] = [];
    for (const c of candidates) {
      const entry: ScoredCandidate & { memStore: MemoryStore } = {
        id: c.id,
        store: c.store.slug,
        memStore: c.store,
        meta: c.meta,
        tokens: c.tokens,
        score: compositeScore(
          maxRel === 0 ? 0 : c.rel / maxRel,
          c.meta.importance,
          cardRecency(c.meta.lastAccessed, now),
          cardStrength(c.meta.accessCount, c.meta.updated, now),
          c.meta.confidence,
        ),
      };
      const existing = pool.get(c.id);
      if (existing === undefined || entry.score > existing.score) pool.set(c.id, entry);
      if (entry.score > 0) scored.push(entry);
    }

    const mmr = rankWithMmr(scored).slice(0, k);
    const ranked: readonly (ScoredCandidate & { memStore?: MemoryStore })[] =
      opts.expandLinks === false
        ? mmr
        : expandLinks(mmr, pool, k, { decay: opts.linkDecay ?? 0.5, hops: 1 });

    const hits: RecallHit[] = [];
    const touched = new Map<string, string[]>();
    for (const r of ranked) {
      const memStore = pool.get(r.id)?.memStore ?? this.storeBySlug(r.store);
      if (memStore === undefined || memStore === null) continue;
      const card = await memStore.readCard(r.id);
      if (card === null) continue; // deleted/corrupt between index read and now
      hits.push({
        store: memStore.slug,
        id: r.id,
        kind: card.kind,
        title: card.title,
        snippet: makeSnippet(card.title, card.body),
        score: Math.round(r.score * 1000) / 1000,
        path: join(memStore.paths.cards, `${r.id}.md`),
        tags: [...card.tags],
        importance: card.importance,
        updated: card.updated,
        supersededBy: card.supersededBy,
        links: [...card.links],
      });
      const arr = touched.get(memStore.slug) ?? [];
      arr.push(r.id);
      touched.set(memStore.slug, arr);
    }
    // Access counters are cheap appends; Dream folds them into card fields.
    for (const [slug, ids] of touched) {
      const store = this.storeBySlug(slug);
      void store?.noteAccess(ids).catch(() => undefined);
    }
    return { hits, counts };
  }

  /** Read one exact card (with its store and derived meta) by id. */
  async getCard(slug: string | null, id: string): Promise<CardRef | null> {
    if (!isValidCardId(id)) return null;
    const stores = slug !== null ? [this.storeBySlug(slug)] : this.allStores();
    for (const store of stores) {
      if (store === null || store === undefined) continue;
      const card = await store.readCard(id);
      if (card === null) continue;
      const index = await store.readIndex().catch(() => null);
      return { store: store.slug, kind: store.kind, card, meta: index?.cards[id] ?? null };
    }
    return null;
  }

  /** Every known store (global + discovered projects). */
  storeList(): MemoryStore[] {
    return this.allStores();
  }

  /**
   * Recent audit entries for one store, newest first. The audit log is
   * append-only and content-free by construction (ids, ops, short titles).
   */
  async auditTail(slug: string, limit = 50): Promise<import('./types.ts').AuditEntry[]> {
    const store = this.storeBySlug(slug);
    if (store === null) return [];
    return store.readAuditTail(limit);
  }

  // ── forget ──────────────────────────────────────────────────────────────

  async forget(
    args: ForgetOptions,
    via: AuditVia,
    sessionId?: string,
  ): Promise<ForgetResult> {
    const hard = Boolean(args.hard);
    const removed: ForgetResult['removed'] = [];
    if (args.id) {
      // Defense in depth: a malformed id (path separators, traversal, junk)
      // is treated as "not found" — it can never reach a filesystem join.
      if (!isValidCardId(args.id)) return { removed };
      const stores = [
        this.projects.get(args.projectSlug ?? '') ?? null,
        this.global,
      ].filter((s): s is MemoryStore => s !== null);
      for (const store of stores) {
        const card = await store.readCard(args.id);
        if (card === null) continue;
        if (hard) {
          const ok = await store.deleteCardHard(args.id);
          if (ok) {
            removed.push({ slug: store.slug, id: args.id, mode: 'hard-delete' });
            await store.audit({ ts: new Date().toISOString(), store: store.slug, op: 'hard-delete', id: args.id, via, session: sessionId });
            await store.rebuildIndex();
          }
        } else {
          const ok = await store.archiveCard(args.id);
          if (ok) {
            removed.push({ slug: store.slug, id: args.id, mode: 'archive' });
            await store.audit({ ts: new Date().toISOString(), store: store.slug, op: 'archive', id: args.id, via, session: sessionId });
            await store.rebuildIndex();
          }
        }
        break;
      }
      return { removed };
    }
    if (args.query) {
      // Safety: a query forget is destructive and fuzzy, so without an explicit
      // `confirm` it only REPORTS what it would remove. The agent (or human)
      // sees the candidates and re-issues with confirm — never a blind top-3.
      const { hits } = await this.recall(args.query, {
        k: 3,
        projectSlug: args.projectSlug ?? null,
        scope: 'both',
      });
      if (args.confirm !== true) {
        return {
          removed: [],
          candidates: hits.map((h) => ({ slug: h.store, id: h.id, title: h.title, score: h.score })),
        };
      }
      for (const hit of hits) {
        const out = await this.forget({ id: hit.id, hard, projectSlug: hit.store }, via, sessionId);
        removed.push(...out.removed);
      }
      return { removed };
    }
    return { removed };
  }

  /**
   * Replace one card's content with a corrected version (bitemporal). The new
   * version carries `supersedes: [id]`; the old card is stamped
   * `validUntil`/`supersededBy` and stays on disk as history. Policy-gated
   * exactly like {@link remember}: a blocked correction writes nothing.
   */
  async updateCard(
    slug: string,
    id: string,
    patch: { content?: string; kind?: string; tags?: unknown; importance?: number },
    via: AuditVia,
    sessionId?: string,
    piiMode: PiiMode = 'redact',
    maxBytes = 4096,
  ): Promise<{ card: MemoryCard; warnings: string[] } | null> {
    const store = this.storeBySlug(slug);
    if (store === null) return null;
    const existing = await store.readCard(id);
    if (existing === null) return null;
    const content = normalizeMemoryText(String(patch.content ?? `${existing.title}\n${existing.body}`.trim()).trim());
    if (!content) throw new Error('memory content is empty');
    if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new Error(`memory content exceeds ${maxBytes} bytes`);
    const rules = await this.rulesFor(store.slug);
    const gated = gateCandidate(content, rules.denyKeywords, piiMode);
    if (!gated.ok) throw new MemoryPolicyError(gated.reasons);

    const now = new Date().toISOString();
    const safe = gated.text;
    const title = firstLine(safe);
    const kind: MemoryKind =
      typeof patch.kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(patch.kind)
        ? (patch.kind as MemoryKind)
        : existing.kind;
    const next: MemoryCard = {
      ...existing,
      id: makeCardId(),
      kind,
      tags: patch.tags !== undefined ? normalizeTags(patch.tags) : [...existing.tags],
      importance: patch.importance !== undefined ? clampImportance(patch.importance) : existing.importance,
      created: now,
      updated: now,
      lastAccessed: now,
      accessCount: 0,
      validSince: now,
      validUntil: null,
      supersedes: [id],
      supersededBy: null,
      source: { session: sessionId ?? existing.source.session, turn: existing.source.turn },
      links: [...existing.links],
      title,
      body: safe === title ? '' : safe.slice(title.length).trim(),
    };
    await store.putCard(next, { rebuild: false });
    await store.supersedeCard(id, next.id, now, { rebuild: false });
    await store.audit({ ts: now, store: store.slug, op: 'supersede', id, detail: `→ ${next.id}`, via, session: sessionId });
    await store.audit({ ts: now, store: store.slug, op: 'create', id: next.id, detail: title.slice(0, 80), via, session: sessionId });
    await store.rebuildIndex();
    return { card: next, warnings: gated.warnings };
  }

  /**
   * Export one or every store as a portable bundle. Archived cards are
   * included unless `liveOnly`; card content is served exactly as stored
   * (already policy-clean on disk).
   */
  async exportBundle(opts: { slugs?: readonly string[]; liveOnly?: boolean } = {}): Promise<MemoryExportBundle> {
    const wanted = opts.slugs !== undefined && opts.slugs.length > 0 ? new Set(opts.slugs) : null;
    const stores: MemoryExportStore[] = [];
    for (const store of this.allStores()) {
      if (wanted !== null && !wanted.has(store.slug)) continue;
      // Skip empty, never-registered project stores so a bundle stays small.
      const live = await store.readAllCards();
      const archived = opts.liveOnly === true ? [] : await store.readAllArchived();
      if (live.length === 0 && archived.length === 0) continue;
      stores.push({
        slug: store.slug,
        kind: store.kind,
        projectPath: store.kind === 'project' ? await this.projectPathOf(store.slug) : null,
        cards: live,
        archived,
      });
    }
    return {
      format: 'dsh-memory-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      schema: MEMORY_SCHEMA_VERSION,
      stores,
    };
  }

  /**
   * Import a bundle (additive, idempotent). Each card is re-validated through
   * the policy gate before it can land on disk, so an imported bundle can
   * never reintroduce a credential that the current policy forbids. A store
   * named in the bundle that does not exist locally is created for project
   * slugs (global always exists).
   */
  async importBundle(
    bundle: MemoryExportBundle,
    via: AuditVia = 'user',
    sessionId?: string,
  ): Promise<MemoryImportResult> {
    const stores: MemoryImportStoreResult[] = [];
    const totals = { added: 0, skipped: 0, replaced: 0, rejected: 0 };
    for (const incoming of bundle.stores ?? []) {
      const slug = typeof incoming.slug === 'string' ? incoming.slug : '';
      if (slug === '') continue;
      let store = this.storeBySlug(slug);
      if (store === null) {
        if (incoming.kind !== 'project' || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
          stores.push({ slug, kind: incoming.kind ?? 'project', added: 0, skipped: 0, replaced: 0, rejected: 0, errors: ['unknown store'] });
          continue;
        }
        // When the bundle carries the ORIGINAL project path, register it so the
        // store is rediscovered after a restart and the path↔slug mapping is
        // real (a collision renames the slug, and that local identity wins).
        let effectiveSlug = slug;
        let storeRoot = join(this.root, 'projects', slug);
        if (typeof incoming.projectPath === 'string' && incoming.projectPath !== '') {
          const registered = await registerProjectPath(incoming.projectPath).catch(() => null);
          if (registered !== null) {
            effectiveSlug = registered.slug;
            storeRoot = registered.storeRoot;
          }
        }
        store = new MemoryStore('project', effectiveSlug, storePathsFor(storeRoot), this.logger);
        await store.init();
        this.projects.set(effectiveSlug, store);
      }
      const result: MemoryImportStoreResult = {
        slug: store.slug,
        kind: store.kind,
        added: 0,
        skipped: 0,
        replaced: 0,
        rejected: 0,
        errors: [],
      };
      const rules = await this.rulesFor(store.slug).catch(() => emptyRules());
      for (const raw of [...(incoming.cards ?? []), ...(incoming.archived ?? [])]) {
        const card = raw as MemoryCard | null;
        if (card === null || typeof card !== 'object') continue;
        if (!isValidCardId(String(card.id ?? ''))) {
          result.rejected++;
          result.errors.push(`malformed card id: ${String((card as { id?: unknown }).id)}`);
          continue;
        }
        const text = `${String(card.title ?? '')}\n${String(card.body ?? '')}`.trim();
        if (text === '') {
          result.rejected++;
          result.errors.push(`${card.id}: empty content`);
          continue;
        }
        const gated = gateCandidate(text, rules.denyKeywords, 'redact');
        if (!gated.ok) {
          result.rejected++;
          result.errors.push(`${card.id}: blocked (${gated.reasons.join(',')})`);
          continue;
        }
        // Store the GATED text (PII masked), exactly like the remember/update
        // paths — accepting the raw body here would smuggle PII past the gate.
        const safe = gated.text;
        const title = firstLine(safe);
        const normalized: MemoryCard = {
          ...card,
          tags: normalizeTags(card.tags),
          importance: clampImportance(card.importance),
          supersedes: Array.isArray(card.supersedes) ? card.supersedes.filter((s) => typeof s === 'string' && isValidCardId(s)) : [],
          supersededBy: typeof card.supersededBy === 'string' && isValidCardId(card.supersededBy) ? card.supersededBy : null,
          links: Array.isArray(card.links) ? card.links.filter((s) => typeof s === 'string' && isValidCardId(s)) : [],
          source: {
            session: typeof card.source?.session === 'string' ? card.source.session : '',
            turn: typeof card.source?.turn === 'number' ? card.source.turn : null,
          },
          title,
          body: safe === title ? '' : safe.slice(title.length).trim(),
        };
        try {
          const outcome = await store.importCard(normalized);
          if (outcome === 'added') result.added++;
          else if (outcome === 'replaced') result.replaced++;
          else result.skipped++;
          if (outcome !== 'skipped') {
            await store.audit({
              ts: new Date().toISOString(),
              store: store.slug,
              op: 'import',
              id: normalized.id,
              detail: outcome,
              via,
              session: sessionId,
            });
          }
        } catch (err) {
          result.rejected++;
          result.errors.push(`${normalized.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (result.added + result.replaced > 0) await store.rebuildIndex();
      totals.added += result.added;
      totals.skipped += result.skipped;
      totals.replaced += result.replaced;
      totals.rejected += result.rejected;
      stores.push(result);
    }
    return { totals, stores };
  }

  /**
   * Forget one exact card in one exact store (GUI path, v2). Strictly
   * store-scoped — unlike {@link forget} it never falls through to another
   * store. False when the store or the card is unknown.
   */
  async forgetCardIn(
    slug: string,
    id: string,
    hard: boolean,
    via: AuditVia,
    sessionId?: string,
  ): Promise<'archived' | 'hard-deleted' | null> {
    const store = this.storeBySlug(slug);
    if (store === null) return null;
    const card = await store.readCard(id);
    if (card === null) return null;
    if (hard) {
      const ok = await store.deleteCardHard(id);
      if (ok) {
        await store.audit({ ts: new Date().toISOString(), store: store.slug, op: 'hard-delete', id, via, session: sessionId });
        await store.rebuildIndex();
        return 'hard-deleted';
      }
      return null;
    }
    const ok = await store.archiveCard(id);
    if (ok) {
      await store.audit({ ts: new Date().toISOString(), store: store.slug, op: 'archive', id, via, session: sessionId });
      await store.rebuildIndex();
      return 'archived';
    }
    return null;
  }

  /**
   * Restore one archived card to its store (GUI path, v2). False when the
   * store is unknown, the card is not archived there, or a live card already
   * occupies its id.
   */
  async restoreCardIn(slug: string, id: string, via: AuditVia, sessionId?: string): Promise<boolean> {
    const store = this.storeBySlug(slug);
    if (store === null) return false;
    const ok = await store.restoreCard(id);
    if (!ok) return false;
    await store.audit({ ts: new Date().toISOString(), store: store.slug, op: 'restore', id, via, session: sessionId });
    await store.rebuildIndex();
    return true;
  }

  // ── status ──────────────────────────────────────────────────────────────

  async status(enabled: boolean): Promise<StatusReport> {
    const stores: StoreStatus[] = [];
    let lastDream: string | null = null;
    for (const store of this.allStores()) {
      const state = await store.readState().catch(() => null);
      // PENDING inbox = lines not yet consumed by Dream (the file is never
      // cleaned, so the raw line count would grow forever after each run).
      const totalLines = await store.inboxLineCount().catch(() => 0);
      const pending = Math.max(0, totalLines - (state?.inboxOffset ?? 0));
      const stats = await store
        .stats()
        .catch(() => ({ cards: 0, superseded: 0, archived: 0, bytes: 0, kinds: {}, topTags: [] }));
      const projectPath = store.kind === 'project' ? await this.projectPathOf(store.slug) : undefined;
      stores.push({
        slug: store.slug,
        kind: store.kind,
        projectPath: projectPath ?? undefined,
        cards: stats.cards,
        archived: stats.archived,
        superseded: stats.superseded,
        pendingInbox: pending,
        lastDream: state?.lastRun ?? null,
        root: store.paths.root,
        kinds: stats.kinds,
        topTags: stats.topTags,
        bytes: stats.bytes,
      });
      if (state?.lastRun && (lastDream === null || state.lastRun > lastDream)) lastDream = state.lastRun;
    }
    const totals = {
      stores: stores.length,
      cards: stores.reduce((n, s) => n + s.cards, 0),
      archived: stores.reduce((n, s) => n + s.archived, 0),
      superseded: stores.reduce((n, s) => n + s.superseded, 0),
      pendingInbox: stores.reduce((n, s) => n + s.pendingInbox, 0),
      bytes: stores.reduce((n, s) => n + s.bytes, 0),
    };
    return { enabled, schema: MEMORY_SCHEMA_VERSION, stores, lastDream, totals };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const clean = t.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= 8) break;
  }
  return out;
}

function clampImportance(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 5;
  return Math.min(10, Math.max(1, n));
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  const line = (idx < 0 ? text : text.slice(0, idx)).trim();
  return line.length > 0 ? line : text.trim().slice(0, 120);
}
