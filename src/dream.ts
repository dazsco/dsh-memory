/**
 * Dream: background memory consolidation (sleep-time compute, arXiv:2504.13171).
 *
 * Passes (all idempotent, checkpointed in dream/state.json):
 *   1. ingest    — fold inbox.jsonl captures into cards (Mem0-style ADD/UPDATE/NOOP)
 *   2. access    — fold the access log into card counters
 *   3. decay     — rule retention + observation floor → archive
 *   4. relink    — tag co-occurrence links (≥2 shared tags, top-5)
 *   4b. LLM      — budgeted auxiliary passes on the user's own route
 *                  (summarize → dream/summary.md; conflict → resolve
 *                  near-duplicate pairs the Jaccard band left open)
 *   5. reindex   — rebuild index.json (derived, always recomputable)
 *
 * LLM passes are best-effort: any unavailability (no service, route, budget,
 * or a failed call) degrades to the heuristic result; the run still succeeds.
 *
 * Trigger model: 60s tick × (enabled, intervalMinutes since last run, inbox
 * dirty) + a 30s startup sweep + a monotonic settings `dream.requestSeq`
 * ("Run now" from the GUI). One in-process `running` flag plus a per-store
 * file lock keep overlapping runs (and overlapping processes) safe.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { healOrphanLock, isLockTimeout } from './lockheal.ts';
import type { StoreLogger } from './store.ts';
import type { MemoryCore } from './core.ts';
import { MemoryStore } from './store.ts';
import { gateCandidate } from './redact.ts';
import { cardStrength, jaccard, tokenize } from './retrieval.ts';
import { dedupDecide, normalizeMemoryText } from './dedup.ts';
import { makeCardId } from './cards.ts';
import { listFiles } from './fsutil.ts';
import type { DreamState, InboxEntry, MemoryCard, MemoryKind } from './types.ts';
import type { MemorySettings } from './settings.ts';
import {
  buildConflictUserPrompt,
  buildSummarizeUserPrompt,
  callMemoryLlm,
  DREAM_CONFLICT_SYSTEM,
  DREAM_SUMMARIZE_SYSTEM,
  parseConflictDecisions,
  parseSummaryText,
  type DreamCardLine,
  type MemoryLlmDeps,
} from './llm.ts';

/** LLM seam: one bounded call (the user's own route). Null = unavailable. */
export interface DreamLlm {
  call(req: { system: string; user: string; maxTokens: number }): Promise<string | null>;
  /** Live call counter of this run's budget (exposed for run reports). */
  readonly calls: { n: number };
}

/** Build a budgeted DreamLlm adapter over the shared LLM seam. */
function makeDreamLlm(deps: MemoryLlmDeps, budget: { n: number; max: number }): DreamLlm {
  return {
    calls: budget,
    async call(req) {
      if (budget.n >= budget.max) return null;
      budget.n++;
      try {
        const r = await callMemoryLlm(deps, { system: req.system, user: req.user, maxOutputTokens: req.maxTokens });
        return r.ok ? r.text : null;
      } catch {
        return null;
      }
    },
  };
}

export interface DreamRunOptions {
  reason: string;
  llm?: DreamLlm | null;
  maxLlmCalls?: number;
  maxWallMs?: number;
  now?: () => Date;
}

export interface StoreDreamResult {
  slug: string;
  added: number;
  updated: number;
  noop: number;
  archived: number;
  blocked: number;
  relinked: number;
  notes: string[];
  error?: string;
}

export interface DreamRunResult {
  ts: string;
  reason: string;
  durationMs: number;
  llmCalls: number;
  stores: StoreDreamResult[];
  /** True when a concurrent run was already in flight and this call was skipped. */
  busy: boolean;
}

const DAY_MS = 86_400_000;
const KEEP_REPORTS = 10;
const TICK_MS = 60_000;
const STARTUP_SWEEP_MS = 30_000;

/**
 * In-process guard across DreamEngine instances that share one MemoryCore
 * (the per-store run.lock file provides cross-process serialization).
 */
const activeCores = new WeakSet<object>();

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / DAY_MS) : Infinity;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

export class DreamEngine {
  private running = false;
  private lastRunAt = 0;

  constructor(
    private readonly core: MemoryCore,
    private readonly getSettings: () => MemorySettings,
    private readonly logger: StoreLogger | null,
    private readonly llmDeps: MemoryLlmDeps | null = null,
  ) {}

  isRunning(): boolean {
    return this.running || activeCores.has(this.core);
  }

  /**
   * The budgeted LLM seam for one run, or null when LLM passes are off
   * (settings `dream.useLlm`) or the service is absent. The budget comes
   * from `dream.maxLlmCalls` and is enforced per run.
   */
  llmForRun(): DreamLlm | null {
    const s = this.getSettings();
    if (!s.enabled || !s.dream.enabled || !s.dream.useLlm) return null;
    if (this.llmDeps === null || this.llmDeps.llm === null) return null;
    const budget = { n: 0, max: Math.max(1, s.dream.maxLlmCalls) };
    return makeDreamLlm(this.llmDeps, budget);
  }

  /** True when any store has unprocessed inbox lines. */
  async isDirty(): Promise<boolean> {
    for (const store of this.core.allStores()) {
      const state = await store.readState().catch(() => null);
      const lines = await store.inboxLineCount().catch(() => 0);
      if (lines > (state?.inboxOffset ?? 0)) return true;
    }
    return false;
  }

  /** Tick decision: enabled, not running, interval elapsed, something dirty. */
  async tick(): Promise<void> {
    const s = this.getSettings();
    if (!s.enabled || !s.dream.enabled) return;
    if (this.running) return;
    if (Date.now() - this.lastRunAt < s.dream.intervalMinutes * 60_000) return;
    if (!(await this.isDirty().catch(() => false))) return;
    const res = await this.runNow({ reason: 'interval', llm: this.llmForRun() });
    if (res.busy) return;
    this.logger?.info(`[dsh-memory] dream(interval) done in ${res.durationMs}ms: ${summarize(res)}`);
  }

  async runNow(opts: DreamRunOptions): Promise<DreamRunResult> {
    if (this.running || activeCores.has(this.core)) {
      return { ts: new Date().toISOString(), reason: opts.reason, durationMs: 0, llmCalls: 0, stores: [], busy: true };
    }
    this.running = true;
    activeCores.add(this.core);
    const now = opts.now ?? (() => new Date());
    const startedAt = Date.now();
    const s = this.getSettings();
    const maxWallMs = opts.maxWallMs ?? s.dream.maxWallMs;
    const deadline = startedAt + maxWallMs;
    const llmCalls: { n: number } = opts.llm ? opts.llm.calls : { n: 0 };
    const stores: StoreDreamResult[] = [];
    try {
      for (const store of this.core.allStores()) {
        stores.push(await this.runStore(store, opts, now, deadline, llmCalls));
      }
    } finally {
      this.running = false;
      activeCores.delete(this.core);
    }
    this.lastRunAt = Date.now();
    return {
      ts: now().toISOString(),
      reason: opts.reason,
      durationMs: Date.now() - startedAt,
      llmCalls: llmCalls.n,
      stores,
      busy: false,
    };
  }

  private async runStore(
    store: MemoryStore,
    opts: DreamRunOptions,
    now: () => Date,
    deadline: number,
    llmCalls: { n: number },
  ): Promise<StoreDreamResult> {
    const res: StoreDreamResult = {
      slug: store.slug,
      added: 0,
      updated: 0,
      noop: 0,
      archived: 0,
      blocked: 0,
      relinked: 0,
      notes: [],
    };
    const nowIso = () => now().toISOString();
    const runLockBase = join(store.paths.dream, 'run.lock');
    // Orphan recovery: a killed process can leave an old run.lock whose owner
    // PID is dead; withFileLock never steals, so clear a provably orphaned
    // lock and retry once (see lockheal.ts).
    const runUnderLock = async (op: () => Promise<void>): Promise<void> => {
      try {
        await withFileLock(runLockBase, op);
      } catch (err) {
        if (isLockTimeout(err) && (await healOrphanLock(`${runLockBase}.lock`))) {
          await withFileLock(runLockBase, op);
        } else {
          throw err;
        }
      }
    };
    try {
      await runUnderLock(async () => {
        const state = await store.readState();

        // ── pass 1: ingest staged captures ────────────────────────────────
        const entries = await store.readInbox(state.inboxOffset);
        const corpus = await store.cardCorpus();
        let consumed = 0;
        for (const entry of entries) {
          if (Date.now() > deadline) {
            res.notes.push('wall budget exhausted; inbox resumes next run');
            break;
          }
          const rules = await this.core.rulesFor(store.slug);
          const gated = gateCandidate(entry.content, rules.denyKeywords, this.getSettings().redact.pii);
          if (!gated.ok) {
            // Double safety: captures are gated before staging; a rule change
            // after staging can still refuse here. Names only, never content.
            res.blocked++;
            await store.audit({ ts: nowIso(), store: store.slug, op: 'block', detail: gated.reasons.join(','), via: 'dream', session: entry.source?.session });
            consumed++;
            continue;
          }
          const tokens = tokenize(gated.text);
          const tokenSet = new Set(tokens);
          const decision = dedupDecide(
            tokenSet,
            [...corpus.entries()].map(([id, e]) => ({ id, tokens: new Set(e.tokens) })),
          );
          if (decision.action === 'noop' && decision.matchId) {
            res.noop++;
            const meta = corpus.get(decision.matchId)?.meta;
            if (meta) {
              await store.patchCard(decision.matchId, { updated: nowIso(), confidence: Math.min(0.95, round2(meta.confidence + 0.02)) });
            }
            consumed++;
            continue;
          }
          if (decision.action === 'update' && decision.matchId) {
            res.updated++;
            const meta = corpus.get(decision.matchId)?.meta;
            if (meta) {
              await store.patchCard(decision.matchId, { updated: nowIso(), confidence: Math.min(0.95, round2(meta.confidence + 0.05)) });
            }
            res.notes.push(`update ${decision.matchId} (j≈${(decision.similarity ?? 0).toFixed(2)})`);
            await store.audit({ ts: nowIso(), store: store.slug, op: 'update', id: decision.matchId, detail: `dedup-jaccard ${decision.similarity?.toFixed(2)}`, via: 'dream' });
            consumed++;
            continue;
          }
          const ts = nowIso();
          const kind: MemoryKind = entry.kind && MEMORY_KINDS_LOCAL.has(entry.kind) ? entry.kind : 'fact';
          const normText = normalizeMemoryText(gated.text);
          const card: MemoryCard = {
            id: makeCardId(now()),
            kind,
            tags: (entry.tags ?? []).slice(0, 8),
            importance: entry.importance && Number.isFinite(entry.importance) ? Math.min(10, Math.max(1, Math.round(entry.importance))) : 5,
            confidence: 0.5,
            created: ts,
            updated: ts,
            lastAccessed: ts,
            accessCount: 0,
            validSince: ts,
            validUntil: null,
            supersedes: [],
            source: entry.source ?? { session: '', turn: null },
            links: [],
            title: firstLine(normText),
            body: normText,
          };
          await store.putCard(card);
          await store.audit({ ts, store: store.slug, op: 'create', id: card.id, detail: card.title.slice(0, 80), via: 'dream', session: entry.source?.session });
          const meta: import('./types.ts').CardMeta = {
            path: join(store.paths.cards, `${card.id}.md`),
            title: card.title,
            kind: card.kind,
            tags: card.tags,
            importance: card.importance,
            confidence: card.confidence,
            created: card.created,
            updated: card.updated,
            lastAccessed: card.lastAccessed,
            accessCount: card.accessCount,
            validUntil: card.validUntil,
            supersedes: card.supersedes,
            links: card.links,
            digest: '',
            tokens: tokens.length,
          };
          corpus.set(card.id, { meta, tokens });
          res.added++;
          consumed++;
        }
        state.inboxOffset += consumed;

        // ── pass 2: fold access log into counters ──────────────────────────
        const access = await store.readAccessLog();
        if (access.length > 0) {
          const counts = new Map<string, { n: number; last: string }>();
          for (const rec of access) {
            for (const id of rec.ids ?? []) {
              const c = counts.get(id) ?? { n: 0, last: rec.ts };
              c.n++;
              if (rec.ts > c.last) c.last = rec.ts;
              counts.set(id, c);
            }
          }
          const index = await store.readIndex();
          for (const [id, c] of counts) {
            const meta = index.cards[id];
            if (!meta) continue;
            await store.patchCard(id, { accessCount: meta.accessCount + c.n, lastAccessed: c.last });
          }
          await store.clearAccessLog();
        }

        // ── pass 3: decay & archive ────────────────────────────────────────
        const rules = await this.core.rulesFor(store.slug);
        const nowD = now();
        for (const [id, { meta }] of [...corpus.entries()]) {
          if (meta.validUntil !== null) continue;
          let why = '';
          const kindDays = rules.retention[meta.kind];
          if (kindDays !== undefined && daysSince(meta.updated, nowD) > kindDays) {
            why = `retention(${kindDays}d)`;
          } else if (
            meta.kind === 'observation' &&
            daysSince(meta.updated, nowD) > 14 &&
            cardStrength(meta.accessCount, meta.updated, nowD) < 0.3
          ) {
            why = 'observation-decay';
          }
          if (!why) continue;
          const ok = await store.archiveCard(id);
          if (!ok) continue;
          await store.audit({ ts: nowIso(), store: store.slug, op: 'archive', id, detail: why, via: 'dream' });
          corpus.delete(id);
          res.archived++;
          res.notes.push(`archive ${id} (${why})`);
        }

        // ── pass 4: relink by tag co-occurrence ────────────────────────────
        const corpusEntries = [...corpus.entries()];
        for (const [id, c] of corpusEntries) {
          const best = corpusEntries
            .filter(([oid]) => oid !== id)
            .map(([oid, o]) => {
              const shared = c.meta.tags.filter((t) => o.meta.tags.includes(t)).length;
              return { oid, shared, sim: jaccard(new Set(c.tokens), new Set(o.tokens)) };
            })
            .filter((x) => x.shared >= 2)
            .sort((a, b) => b.shared * 10 + b.sim - (a.shared * 10 + a.sim))
            .slice(0, 5)
            .map((x) => x.oid);
          if (JSON.stringify(best) !== JSON.stringify(c.meta.links)) {
            const patched = await store.patchCard(id, { links: best });
            if (patched) {
              c.meta.links = best;
              res.relinked++;
            }
          }
        }

        // ── pass 4b: LLM passes (best-effort, budgeted) ────────────────────
        const llm = opts.llm;
        if (llm !== null && llm !== undefined) {
          await this.runLlmSummarize(store, llm, corpus, res).catch((err) => {
            res.notes.push(`llm-summarize skipped: ${err instanceof Error ? err.message : String(err)}`);
          });
          await this.runLlmConflict(store, llm, corpus, res).catch((err) => {
            res.notes.push(`llm-conflict skipped: ${err instanceof Error ? err.message : String(err)}`);
          });
        }

        // ── pass 5: reindex (derived artifact) ─────────────────────────────
        await store.rebuildIndex();

        // ── checkpoint ─────────────────────────────────────────────────────
        state.lastRun = nowIso();
        state.lastResult = 'success';
        delete state.lastError;
        state.stats = {
          runs: (state.stats?.runs ?? 0) + 1,
          added: (state.stats?.added ?? 0) + res.added,
          updated: (state.stats?.updated ?? 0) + res.updated,
          archived: (state.stats?.archived ?? 0) + res.archived,
          blocked: (state.stats?.blocked ?? 0) + res.blocked,
        };
        await store.writeState(state);
        await store.audit({
          ts: nowIso(),
          store: store.slug,
          op: 'dream',
          detail: `+${res.added} ~${res.updated} =${res.noop} ↓${res.archived} ⊘${res.blocked} link=${res.relinked}`,
          via: 'dream',
        });

        await writeReport(store.paths.dream, { slug: store.slug, ts: nowIso(), res, notes: res.notes });
      });
    } catch (err) {
      res.error = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[dsh-memory] dream ${store.slug} failed: ${res.error}`);
      try {
        const state = await store.readState();
        state.lastResult = 'error';
        state.lastError = res.error;
        await store.writeState(state);
      } catch {
        // state write failed too; the inbox offset is untouched → safe resume
      }
    }
    return res;
  }

  /**
   * LLM pass 1 — store overview. One call; writes `dream/summary.md`
   * (atomic). Only runs on stores with ≥ SUMMARIZE_MIN_CARDS live cards.
   */
  private async runLlmSummarize(
    store: MemoryStore,
    llm: DreamLlm,
    corpus: Map<string, { meta: import('./types.ts').CardMeta; tokens: string[] }>,
    res: StoreDreamResult,
  ): Promise<void> {
    const ids = [...corpus.keys()];
    if (ids.length < SUMMARIZE_MIN_CARDS) return;
    const ranked = [...corpus.entries()]
      .sort((a, b) => b[1].meta.importance - a[1].meta.importance)
      .slice(0, SUMMARIZE_MAX_CARDS);
    const lines: DreamCardLine[] = [];
    for (const [id, { meta }] of ranked) {
      const card = await store.readCard(id).catch(() => null);
      if (card === null) continue;
      lines.push({ id: card.id, kind: card.kind, title: card.title, body: card.body, importance: card.importance });
      void meta;
    }
    if (lines.length < SUMMARIZE_MIN_CARDS) return;
    const text = await llm.call({
      system: DREAM_SUMMARIZE_SYSTEM,
      user: buildSummarizeUserPrompt(store.slug, lines),
      maxTokens: 400,
    });
    const summary = text === null ? null : parseSummaryText(text);
    if (summary === null) {
      res.notes.push(
        text === null
          ? 'llm-summarize: no reply (budget or failure)'
          : `llm-summarize: unparseable reply: ${JSON.stringify(text.slice(0, 160))}`,
      );
      return;
    }
    const md = `# Memory overview — ${store.slug}\n\nUpdated: ${new Date().toISOString()}\n\n${summary}\n`;
    await writeFileAtomic(join(store.paths.dream, 'summary.md'), md, { mode: 0o600 });
    res.notes.push('llm-summarize: overview written');
  }

  /**
   * LLM pass 2 — near-duplicate conflict resolution. One call for up to
   * CONFLICT_MAX_PAIRS pairs whose Jaccard similarity sits in the open band
   * [0.3, 0.85) (below the dedup merge threshold, above noise). A 'keep'
   * decision archives the loser; 'both' leaves the pair untouched.
   */
  private async runLlmConflict(
    store: MemoryStore,
    llm: DreamLlm,
    corpus: Map<string, { meta: import('./types.ts').CardMeta; tokens: string[] }>,
    res: StoreDreamResult,
  ): Promise<void> {
    const entries = [...corpus.entries()]
      .filter(([, { meta }]) => meta.validUntil === null)
      .map(([id, c]) => ({ id, meta: c.meta, tokens: c.tokens }));
    const pairs: { a: { id: string; meta: import('./types.ts').CardMeta; tokens: string[] }; b: { id: string; meta: import('./types.ts').CardMeta; tokens: string[] }; sim: number }[] = [];
    for (let i = 0; i < entries.length && pairs.length < CONFLICT_MAX_PAIRS; i++) {
      for (let j = i + 1; j < entries.length && pairs.length < CONFLICT_MAX_PAIRS; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a === undefined || b === undefined) continue;
        const sim = jaccard(new Set(a.tokens), new Set(b.tokens));
        if (sim >= CONFLICT_SIM_MIN && sim < CONFLICT_SIM_MAX) {
          pairs.push({ a, b, sim });
        }
      }
    }
    if (pairs.length === 0) return;
    const line = async (c: { id: string; meta: import('./types.ts').CardMeta }): Promise<DreamCardLine> => {
      const card = await store.readCard(c.id).catch(() => null);
      if (card !== null) return { id: card.id, kind: card.kind, title: card.title, body: card.body, importance: card.importance };
      return { id: c.id, kind: c.meta.kind, title: c.meta.title, body: c.meta.title, importance: c.meta.importance };
    };
    const conflictPairs = await Promise.all(
      pairs.map(async (p) => ({ a: await line(p.a), b: await line(p.b), similarity: p.sim })),
    );
    const text = await llm.call({
      system: DREAM_CONFLICT_SYSTEM,
      user: buildConflictUserPrompt(conflictPairs),
      maxTokens: 200,
    });
    if (text === null) {
      res.notes.push('llm-conflict: no reply (budget or failure)');
      return;
    }
    const decisions = parseConflictDecisions(text, conflictPairs);
    // Observability: the report is the only record of what the model decided.
    // Without this line a format drift stays invisible forever (see 2026-08-18
    // tanke run: pairs sent, replies parsed to zero decisions, no note).
    res.notes.push(
      `llm-conflict: ${conflictPairs.length} pair(s) → ${
        [...decisions.entries()].sort((x, y) => x[0] - y[0]).map(([i, dd]) => `G${i + 1}=${dd}`).join(' ') || 'no decision'
      } | reply=${JSON.stringify(text.slice(0, 240))}`,
    );
    for (const [idx, d] of decisions) {
      const pair = pairs[idx];
      if (pair === undefined || d === 'both') continue;
      const loserId = d === 'a' ? pair.b.id : pair.a.id;
      const ok = await store.archiveCard(loserId);
      if (!ok) continue;
      await store.audit({
        ts: new Date().toISOString(),
        store: store.slug,
        op: 'archive',
        id: loserId,
        detail: `llm-conflict(kept ${d === 'a' ? pair.a.id : pair.b.id})`,
        via: 'dream-llm',
      });
      corpus.delete(loserId);
      res.archived++;
      res.notes.push(`llm-conflict: archive ${loserId} (kept ${d === 'a' ? pair.a.id : pair.b.id})`);
    }
  }
}

const SUMMARIZE_MIN_CARDS = 8;
const SUMMARIZE_MAX_CARDS = 40;
const CONFLICT_SIM_MIN = 0.3;
const CONFLICT_SIM_MAX = 0.85;
const CONFLICT_MAX_PAIRS = 4;

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  const line = (idx < 0 ? text : text.slice(0, idx)).trim();
  return line.length > 0 ? line : text.trim().slice(0, 120);
}

const MEMORY_KINDS_LOCAL = new Set(['fact', 'preference', 'decision', 'procedure', 'commitment', 'observation', 'summary']);

async function writeReport(dreamDir: string, r: { slug: string; ts: string; res: StoreDreamResult; notes: string[] }): Promise<void> {
  const md = [
    `# Dream report — ${r.slug}`,
    '',
    `- time: ${r.ts}`,
    `- added: ${r.res.added}`,
    `- updated: ${r.res.updated}`,
    `- noop: ${r.res.noop}`,
    `- archived: ${r.res.archived}`,
    `- blocked: ${r.res.blocked}`,
    `- relinked: ${r.res.relinked}`,
    r.res.error ? `- **error**: ${r.res.error}` : '',
    '',
    r.notes.length > 0 ? '## Notes\n' + r.notes.map((n) => `- ${n}`).join('\n') : 'No notes.',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  const file = join(dreamDir, `report-${stamp(new Date(r.ts))}.md`);
  await writeFileAtomic(file, md, { mode: 0o600 });
  // Keep the last KEEP_REPORTS reports.
  const names = (await listFiles(dreamDir).catch(() => []))
    .filter((n) => n.startsWith('report-') && n.endsWith('.md'))
    .sort();
  while (names.length > KEEP_REPORTS) {
    const old = names.shift();
    if (old === undefined) break;
    await fs.unlink(join(dreamDir, old)).catch(() => undefined);
  }
}

function summarize(r: DreamRunResult): string {
  return r.stores.map((s) => `${s.slug}(+${s.added}/~${s.updated}/↓${s.archived})`).join(' ');
}

/**
 * Register the Dream tick on the host context: 60s interval + a 30s startup
 * sweep. Returns the engine so callers (tools, settings watch) can trigger
 * runs. All side effects belong to the caller's fiber.
 */
export function registerDream(
  ctx: {
    interval?: (fn: () => void, delayMs: number) => () => void;
    timeout?: (fn: () => void, delayMs: number) => () => void;
  },
  core: MemoryCore,
  getSettings: () => MemorySettings,
  logger: StoreLogger | null,
  llmDeps: MemoryLlmDeps | null = null,
): DreamEngine {
  const engine = new DreamEngine(core, getSettings, logger, llmDeps);
  const safeTick = () => {
    void engine.tick().catch((err) => logger?.warn(`[dsh-memory] dream tick failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  try {
    ctx.timeout?.(safeTick, STARTUP_SWEEP_MS);
    ctx.interval?.(safeTick, TICK_MS);
  } catch (err) {
    logger?.warn(`[dsh-memory] dream tick registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof ctx.timeout !== 'function' && typeof ctx.interval !== 'function') {
    logger?.warn('[dsh-memory] timer services unavailable; Dream runs only on explicit triggers (tool / client)');
  }
  return engine;
}
