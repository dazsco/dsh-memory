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
import { listFiles, readTextSafe } from './fsutil.ts';
import { makeCardId } from './cards.ts';
import { gateCandidate } from './redact.ts';
import { emptyRules, parseMemorySection, mergeRules } from './rules.ts';
import type { MemoryRules } from './rules.ts';
import {
  bm25Score,
  cardRecency,
  cardStrength,
  compositeScore,
  makeSnippet,
  rankWithMmr,
  tokenize,
} from './retrieval.ts';
import { dedupDecide } from './dedup.ts';
import {
  MEMORY_SCHEMA_VERSION,
  MEMORY_KINDS,
  MemoryPolicyError,
  type AuditVia,
  type InboxEntry,
  type MemoryCard,
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
}

export interface RecallOptions {
  /** Include this project store (null/absent → global only for 'both' scope). */
  projectSlug?: string | null;
  scope?: 'global' | 'project' | 'both';
  k?: number;
  now?: Date;
}

export interface ForgetResult {
  removed: { slug: string; id: string; mode: 'archive' | 'hard-delete' }[];
}

const AGENTS_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;

export class MemoryCore {
  readonly root: string;
  readonly global: MemoryStore;
  private projects = new Map<string, MemoryStore>();
  private projectRootCache = new Map<string, string | null>();
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

  /** Resolve (and register on first sight) the project store for a cwd. */
  async projectStoreForCwd(cwd: string | null | undefined): Promise<MemoryStore | null> {
    if (!cwd) return null;
    let root: string | null;
    const cached = this.projectRootCache.get(cwd);
    if (cached !== undefined) {
      root = cached;
    } else {
      root = await findProjectRoot(cwd).catch(() => null);
      this.projectRootCache.set(cwd, root);
      if (root !== null) {
        const { slug, storeRoot } = await registerProjectPath(root);
        let store = this.projects.get(slug);
        if (store === undefined) {
          store = new MemoryStore('project', slug, storePathsFor(storeRoot), this.logger);
          await store.init();
          this.projects.set(slug, store);
        }
      }
    }
    if (root === null) return null;
    const { slug } = await registerProjectPath(root);
    return this.projects.get(slug) ?? null;
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
   */
  async rulesFor(slug: string): Promise<MemoryRules> {
    const home = dshHomePath();
    const layers: MemoryRules[] = [];
    for (const name of AGENTS_CANDIDATES) {
      const text = await readTextSafe(join(home, name)).catch(() => null);
      if (text === null) continue;
      const parsed = parseMemorySection(text);
      if (parsed) layers.push(parsed);
    }
    if (slug !== 'global') {
      const projectRoot = await this.projectPathOf(slug);
      if (projectRoot) {
        for (const name of AGENTS_CANDIDATES) {
          const text = await readTextSafe(join(projectRoot, name)).catch(() => null);
          if (text === null) continue;
          const parsed = parseMemorySection(text);
          if (parsed) {
            layers.push(parsed);
            break;
          }
        }
      }
    }
    return layers.length === 0 ? emptyRules() : mergeRules(layers);
  }

  // ── write path ──────────────────────────────────────────────────────────

  /**
   * Explicit remember (tool). Policy gate first (secrets block, rules deny,
   * PII policy), then atomic card write + audit.
   */
  async remember(input: RememberInput, via: AuditVia, sessionId?: string): Promise<{ card: MemoryCard; slug: string; path: string }> {
    const scope = (input.scope ?? 'auto') as 'project' | 'global' | 'auto';
    let store: MemoryStore;
    if (scope === 'global') {
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

    const content = String(input.content ?? '').trim();
    if (!content) throw new Error('memory content is empty');
    const maxBytes = input.maxBytes ?? 4096;
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new Error(`memory content exceeds ${maxBytes} bytes`);
    }

    const rules = await this.rulesFor(store.slug);
    const gated = gateCandidate(content, rules.denyKeywords, 'redact');
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

    const now = new Date().toISOString();
    const kind: MemoryKind =
      typeof input.kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(input.kind)
        ? (input.kind as MemoryKind)
        : 'fact';
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
      validUntil: null,
      supersedes: [],
      source: { session: sessionId ?? '', turn: null },
      links: [],
      title: firstLine(content),
      body: content === firstLine(content) ? '' : content.slice(firstLine(content).length).trim(),
    };
    await store.putCard(card);
    await store.audit({
      ts: now,
      store: store.slug,
      op: 'create',
      id: card.id,
      detail: card.title.slice(0, 80),
      via,
      session: sessionId,
    });
    return { card, slug: store.slug, path: join(store.paths.cards, `${card.id}.md`) };
  }

  /** Stage one capture in a store's inbox (auto-capture path). */
  async pushInbox(store: MemoryStore, entry: InboxEntry): Promise<void> {
    await store.pushInbox(entry);
  }

  // ── read path ───────────────────────────────────────────────────────────

  async recall(query: string, opts: RecallOptions = {}): Promise<{ hits: RecallHit[]; counts: Record<string, number> }> {
    const now = opts.now ?? new Date();
    const k = Math.min(20, Math.max(1, opts.k ?? 8));
    const scope = opts.scope ?? 'both';
    const stores: MemoryStore[] = [];
    if (scope === 'global' || scope === 'both') stores.push(this.global);
    if (scope === 'project' || scope === 'both') {
      const project = opts.projectSlug ? this.projects.get(opts.projectSlug) : null;
      if (project) stores.push(project);
    }

    const queryTokens = tokenize(query);
    const queryTagSet = new Set(queryTokens);
    interface Candidate {
      store: MemoryStore;
      id: string;
      title: string;
      body: string;
      kind: MemoryKind;
      meta: import('./types.ts').CardMeta;
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
        if (entry.meta.validUntil !== null) continue;
        const rel =
          bm25Score(queryTokens, entry.tokens, index.bm25.df, index.bm25.docCount, index.bm25.avgDocLen) +
          0.3 * entry.meta.tags.filter((t) => queryTagSet.has(t.toLowerCase())).length;
        candidates.push({
          store,
          id,
          title: entry.meta.title,
          body: '',
          kind: entry.meta.kind,
          meta: entry.meta,
          tokens: entry.tokens,
          rel,
        });
      }
    }

    const maxRel = Math.max(0, ...candidates.map((c) => c.rel));
    const scored = candidates
      .map((c) => ({
        id: c.id,
        store: c.store.slug,
        memStore: c.store,
        meta: c.meta,
        tokens: c.tokens,
        title: c.title,
        kind: c.kind,
        body: c.body,
        score: compositeScore(
          maxRel === 0 ? 0 : c.rel / maxRel,
          c.meta.importance,
          cardRecency(c.meta.lastAccessed, now),
          cardStrength(c.meta.accessCount, c.meta.updated, now),
        ),
      }))
      .filter((c) => c.score > 0);

    const ranked = rankWithMmr(scored).slice(0, k);
    const byId = new Map(scored.map((s) => [s.id, s] as const));
    const hits: RecallHit[] = [];
    for (const r of ranked) {
      const full = byId.get(r.id);
      if (full === undefined) continue;
      const card = await full.memStore.readCard(r.id);
      const body = card?.body ?? '';
      hits.push({
        store: r.store,
        id: r.id,
        kind: r.meta.kind,
        title: r.meta.title,
        snippet: makeSnippet(r.meta.title, body),
        score: Math.round(r.score * 1000) / 1000,
        path: r.meta.path,
      });
    }
    // Access counters are cheap appends; Dream folds them into card fields.
    const byStore = new Map<string, string[]>();
    for (const r of ranked) {
      const arr = byStore.get(r.store) ?? [];
      arr.push(r.id);
      byStore.set(r.store, arr);
    }
    for (const [slug, ids] of byStore) {
      const store = this.storeBySlug(slug);
      void store?.noteAccess(ids).catch(() => undefined);
    }
    return { hits, counts };
  }

  // ── forget ──────────────────────────────────────────────────────────────

  async forget(
    args: { id?: string; query?: string; hard?: boolean; projectSlug?: string | null },
    via: AuditVia,
    sessionId?: string,
  ): Promise<ForgetResult> {
    const hard = Boolean(args.hard);
    const removed: ForgetResult['removed'] = [];
    if (args.id) {
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
      const { hits } = await this.recall(args.query, { k: 3, projectSlug: args.projectSlug ?? null });
      for (const hit of hits) {
        const out = await this.forget({ id: hit.id, hard, projectSlug: hit.store }, via, sessionId);
        removed.push(...out.removed);
      }
      return { removed };
    }
    return { removed };
  }

  // ── status ──────────────────────────────────────────────────────────────

  async status(enabled: boolean): Promise<StatusReport> {
    const stores: StoreStatus[] = [];
    let lastDream: string | null = null;
    for (const store of this.allStores()) {
      const index = await store.readIndex().catch(() => null);
      const state = await store.readState().catch(() => null);
      const pending = await store.inboxLineCount().catch(() => 0);
      const archived = await store.archivedCount().catch(() => 0);
      const projectPath = store.kind === 'project' ? await this.projectPathOf(store.slug) : undefined;
      stores.push({
        slug: store.slug,
        kind: store.kind,
        projectPath: projectPath ?? undefined,
        cards: index ? Object.keys(index.cards).length : 0,
        archived,
        pendingInbox: pending,
        lastDream: state?.lastRun ?? null,
        root: store.paths.root,
      });
      if (state?.lastRun && (lastDream === null || state.lastRun > lastDream)) lastDream = state.lastRun;
    }
    return { enabled, schema: MEMORY_SCHEMA_VERSION, stores, lastDream };
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
