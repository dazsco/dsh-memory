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
 *   6. maintain  — capacity ceilings: archive stale/over-budget cards and
 *                  prune the archive/audit/access budgets (runs BEFORE the
 *                  reindex so its archivals land in the same rebuild)
 *   5. reindex   — rebuild index.json (derived, always recomputable)
 *   7. inbox     — compact the consumed head (line + byte budgets)
 *
 * Every long pass yields to the event loop (see createYielder) so a large
 * consolidation never freezes the harness it shares.
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
import { createYielder, listFiles } from './fsutil.ts';
import { maintainStore, maintenanceLimitsFrom } from './maintain.ts';
import { MEMORY_KINDS } from './types.ts';
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
  /** Cards replaced by a newer version (bitemporal supersede, file kept). */
  superseded: number;
  blocked: number;
  relinked: number;
  /** Archive/log lines removed by the capacity-maintenance pass. */
  pruned: number;
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
      superseded: 0,
      blocked: 0,
      relinked: 0,
      pruned: 0,
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
        // Lenient read: a malformed line (torn append) is reported, not fatal —
        // quarantined in-line below so one bad line can never wedge the store's
        // Dream. The offset counts EVERY non-empty line (good + malformed), so
        // the parseable entries and the malformed line numbers are merged into
        // one position-ordered view; the offset advances by the number of view
        // items actually processed.
        const { entries, malformedLines } = await store.readInboxFrom(state.inboxOffset);
        const malformedSet = new Set(malformedLines);
        const inboxTotalLines = await store.inboxLineCount();
        const view: Array<{ kind: 'entry'; entry: InboxEntry } | { kind: 'malformed'; lineNo: number }> = [];
        {
          let e = 0;
          for (let p = state.inboxOffset + 1; p <= inboxTotalLines; p++) {
            if (malformedSet.has(p)) view.push({ kind: 'malformed', lineNo: p });
            else view.push({ kind: 'entry', entry: entries[e++]! });
          }
        }
        const corpus = await store.cardCorpusCopy();
        // Token sets are materialized ONCE per run and kept in lockstep with
        // `corpus`. The previous shape rebuilt a Set for EVERY card for EVERY
        // inbox entry — O(inbox × cards) Set constructions, which was the
        // dominant CPU cost of a Dream run on a store that had accumulated a
        // few hundred cards (and it ran on the harness's own event loop).
        const tokenSets = new Map<string, Set<string>>();
        for (const [id, e] of corpus) tokenSets.set(id, new Set(e.tokens));
        const EMPTY_TOKENS: ReadonlySet<string> = new Set<string>();
        let dedupPool: { id: string; tokens: ReadonlySet<string> }[] | null = null;
        const dedupCandidates = (): { id: string; tokens: ReadonlySet<string> }[] => {
          if (dedupPool === null) {
            dedupPool = [...corpus.keys()].map((id) => ({ id, tokens: tokenSets.get(id) ?? EMPTY_TOKENS }));
          }
          return dedupPool;
        };
        const yieldNow = createYielder();
        let consumed = 0;
        for (const item of view) {
          if (Date.now() > deadline) {
            res.notes.push('wall budget exhausted; inbox resumes next run');
            break;
          }
          // Long ingest batches must not monopolize the event loop: yield at
          // most once per 8 ms so the harness keeps answering while Dream runs.
          await yieldNow();
          if (item.kind === 'malformed') {
            // A partial JSON line (kill -9 mid-append): quarantine — audit it
            // and advance past it so the next run resumes after it. No content
            // of the line is ever persisted.
            res.notes.push(`quarantined inbox line ${item.lineNo} (unparseable)`);
            await store.audit({
              ts: nowIso(),
              store: store.slug,
              op: 'quarantine',
              detail: `inbox line ${item.lineNo} unparseable; skipped`,
              via: 'system',
            });
            consumed++;
            continue;
          }
          const entry = item.entry;
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
          const decision = dedupDecide(tokenSet, dedupCandidates());
          if (decision.action === 'noop' && decision.matchId) {
            res.noop++;
            const meta = corpus.get(decision.matchId)?.meta;
            if (meta) {
              // rebuild: false — pass 5 rebuilds the index once for the run.
              await store.patchCard(decision.matchId, { updated: nowIso(), confidence: Math.min(0.95, round2(meta.confidence + 0.02)) }, { rebuild: false });
            }
            consumed++;
            continue;
          }
          if (decision.action === 'update' && decision.matchId) {
            res.updated++;
            const meta = corpus.get(decision.matchId)?.meta;
            if (meta) {
              // rebuild: false — pass 5 rebuilds the index once for the run.
              await store.patchCard(decision.matchId, { updated: nowIso(), confidence: Math.min(0.95, round2(meta.confidence + 0.05)) }, { rebuild: false });
            }
            res.notes.push(`update ${decision.matchId} (j≈${(decision.similarity ?? 0).toFixed(2)})`);
            await store.audit({ ts: nowIso(), store: store.slug, op: 'update', id: decision.matchId, detail: `dedup-jaccard ${decision.similarity?.toFixed(2)}`, via: 'dream' });
            consumed++;
            continue;
          }
          const ts = nowIso();
          const kind: MemoryKind = entry.kind && (MEMORY_KINDS as readonly string[]).includes(entry.kind) ? entry.kind : 'fact';
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
            supersededBy: null,
            source: entry.source ?? { session: '', turn: null },
            links: [],
            title: firstLine(normText),
            body: normText,
          };
          // rebuild: false — pass 5 rebuilds the index once for the run.
          await store.putCard(card, { rebuild: false });
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
            supersededBy: card.supersededBy,
            links: card.links,
            digest: '',
            terms: tokens,
            bytes: Buffer.byteLength(`${card.title}\n${card.body}`, 'utf8'),
          };
          corpus.set(card.id, { meta, tokens });
          tokenSets.set(card.id, tokenSet);
          dedupPool = null; // the new card must join the dedup candidate pool
          res.added++;
          consumed++;
        }
        // The offset advances by exactly the view items processed (good lines
        // ingested + malformed lines quarantined); anything past a wall-budget
        // break stays for the next run.
        state.inboxOffset += consumed;

        // ── pass 2: fold access log into counters ──────────────────────────
        // Recall notes are buffered in-process (one append per batch instead of
        // one per recall); flush them before reading so this run folds every
        // count the process is holding.
        await store.flushAccess();
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
          // Corpus metadata, not the on-disk index: pass 1 may have added cards
          // with `rebuild:false`, so the index file is deliberately stale here.
          // One batched write: folding access into hundreds of cards used to
          // take one lock + read + write per card.
          const accessPatches: { id: string; patch: { accessCount: number; lastAccessed: string } }[] = [];
          for (const [id, c] of counts) {
            const meta = corpus.get(id)?.meta;
            if (!meta) continue;
            accessPatches.push({ id, patch: { accessCount: meta.accessCount + c.n, lastAccessed: c.last } });
          }
          if (accessPatches.length > 0) {
            // rebuild: false — pass 5 rebuilds the index once for the run.
            await store.patchCards(accessPatches, { rebuild: false });
            for (const p of accessPatches) {
              const meta = corpus.get(p.id)?.meta;
              if (meta !== undefined) {
                meta.accessCount = p.patch.accessCount;
                meta.lastAccessed = p.patch.lastAccessed;
              }
            }
          }
          await store.clearAccessLog();
        }

        // ── pass 3: decay & archive ────────────────────────────────────────
        const rules = await this.core.rulesFor(store.slug);
        const nowD = now();
        const decayed: { id: string; why: string }[] = [];
        for (const [id, { meta }] of [...corpus.entries()]) {
          if (meta.validUntil !== null) continue;
          if (Date.now() > deadline) {
            res.notes.push('wall budget exhausted during decay; resumes next run');
            break;
          }
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
          decayed.push({ id, why });
        }
        if (decayed.length > 0) {
          // One batched archive + one audit append: a retention sweep can touch
          // hundreds of cards, and doing that per card took a lock each time.
          const moved = new Set(await store.archiveCards(decayed.map((d) => d.id), { rebuild: false }));
          const rows: import('./types.ts').AuditEntry[] = [];
          let noted = 0;
          for (const d of decayed) {
            if (!moved.has(d.id)) continue;
            corpus.delete(d.id);
            res.archived++;
            rows.push({ ts: nowIso(), store: store.slug, op: 'archive', id: d.id, detail: d.why, via: 'dream' });
            if (noted < 10) {
              res.notes.push(`archive ${d.id} (${d.why})`);
              noted++;
            }
          }
          if (moved.size > noted) res.notes.push(`…and ${moved.size - noted} more retention archive(s)`);
          await store.auditMany(rows).catch(() => undefined);
        }

        // ── pass 4: relink by tag co-occurrence ────────────────────────────
        // Only LIVE cards participate: linking to a superseded card would
        // promote history back into recall through the graph.
        //
        // Semantics are unchanged (a link needs ≥2 shared tags; the top 5 by
        // shared-tag count, then Jaccard), but the scan is driven by a tag
        // inverted index instead of comparing every card against every other
        // card. The old shape was O(N²) tag scans AND O(N²) `new Set(tokens)`
        // constructions — the worst freeze in a long-lived store.
        const corpusEntries = [...corpus.entries()].filter(([, c]) => c.meta.validUntil === null);
        const liveIds = new Set(corpusEntries.map(([id]) => id));
        const byTag = new Map<string, string[]>();
        for (const [id, c] of corpusEntries) {
          for (const tag of c.meta.tags) {
            const list = byTag.get(tag);
            if (list === undefined) byTag.set(tag, [id]);
            else list.push(id);
          }
        }
        const relinkChanges: { id: string; patch: { links: string[] } }[] = [];
        let relinkDeadlineHit = false;
        for (const [id, c] of corpusEntries) {
          await yieldNow();
          if (Date.now() > deadline) {
            relinkDeadlineHit = true;
            break;
          }
          const shared = new Map<string, number>();
          for (const tag of c.meta.tags) {
            for (const oid of byTag.get(tag) ?? []) {
              if (oid === id) continue;
              shared.set(oid, (shared.get(oid) ?? 0) + 1);
            }
          }
          const cSet = tokenSets.get(id) ?? EMPTY_TOKENS;
          const best = [...shared.entries()]
            .filter(([, n]) => n >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, RELINK_CANDIDATE_CAP)
            .map(([oid, n]) => ({ oid, score: n * 10 + jaccard(cSet, tokenSets.get(oid) ?? EMPTY_TOKENS) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, RELINK_LINKS)
            .map((x) => x.oid);
          const current = (c.meta.links ?? []).filter((linkId) => liveIds.has(linkId));
          if (JSON.stringify(best) !== JSON.stringify(current)) relinkChanges.push({ id, patch: { links: best } });
        }
        if (relinkDeadlineHit) {
          res.notes.push('wall budget exhausted during relink; the remaining links resume next run');
        }
        if (relinkChanges.length > RELINK_WRITE_CAP) {
          // A fresh large store changes EVERY card's links at once (a ~20 s
          // write burst measured at 3000 cards). Cap the burst: written cards
          // become stable, so the next run only sees the unwritten remainder
          // and the whole store converges over a few runs instead of stalling
          // one.
          res.notes.push(
            `relink: writing ${RELINK_WRITE_CAP}/${relinkChanges.length} changed card(s) this run (rest resume next run)`,
          );
          relinkChanges.length = RELINK_WRITE_CAP;
        }
        if (relinkChanges.length > 0) {
          // rebuild: false — pass 5 rebuilds the index once for the run. One
          // batched write instead of one lock + read + write per card.
          const applied = await store.patchCards(relinkChanges, { rebuild: false });
          for (const change of relinkChanges) {
            const entry = corpus.get(change.id);
            if (entry !== undefined) entry.meta.links = change.patch.links;
          }
          res.relinked += applied;
        }

        // ── pass 4b: LLM passes (best-effort, budgeted) ────────────────────
        const llm = opts.llm;
        if (llm !== null && llm !== undefined) {
          await this.runLlmSummarize(store, llm, corpus, res).catch((err) => {
            res.notes.push(`llm-summarize skipped: ${err instanceof Error ? err.message : String(err)}`);
          });
          await this.runLlmConflict(store, llm, corpus, tokenSets, res).catch((err) => {
            res.notes.push(`llm-conflict skipped: ${err instanceof Error ? err.message : String(err)}`);
          });
        }

        // ── pass 6: capacity maintenance (bounded growth) ───────────────────
        // The ceilings that stop a store from growing forever: stale/low-value
        // cards are archived, and the archive/audit/access budgets are pruned.
        // The run corpus is handed over directly (it is AHEAD of the on-disk
        // index mid-run), and the inbox is left to the checkpoint below, which
        // owns this run's offset.
        const maint = this.getSettings().maintenance;
        if (maint === undefined || maint.enabled) {
          try {
            const mres = await maintainStore(store, {
              limits: maintenanceLimitsFrom(this.getSettings()),
              entries: [...corpus.entries()].map(([id, c]) => [id, c.meta] as const),
              logger: this.logger,
              rebuildIndex: false, // pass 5 rebuilds once for the run
              skipInbox: true,
              now: nowD,
              deadline,
            });
            res.archived += mres.staleArchived + mres.budgetArchived;
            res.pruned += mres.archivePruned + mres.auditPruned + mres.accessPruned;
            if (mres.staleArchived + mres.budgetArchived > 0) {
              res.notes.push(
                `maintenance: archived ${mres.staleArchived} stale + ${mres.budgetArchived} over-budget card(s)`,
              );
            }
            if (mres.archivePruned + mres.auditPruned + mres.accessPruned > 0) {
              res.notes.push(
                `maintenance: pruned archive=${mres.archivePruned} audit=${mres.auditPruned} access=${mres.accessPruned} (~${mres.bytesReclaimed}B)`,
              );
            }
            if (mres.truncated) res.notes.push('maintenance: wall budget exhausted; the card sweep resumes next run');
          } catch (err) {
            res.notes.push(`maintenance skipped: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // ── pass 5: reindex (derived artifact) ─────────────────────────────
        // Single rebuild for the whole run (every mutation above passed
        // rebuild: false), so the run's index I/O is O(N), not O(N²).
        await store.rebuildIndex();

        // ── inbox compaction (line + byte budget) ──────────────────────────
        // Keep the inbox file bounded: drop the CONSUMED head once it grows
        // past either cap. Pending (unconsumed) lines are never dropped — the
        // drop is capped at the offset — and the offset is adjusted in the
        // SAME checkpoint write below, so the pair can never disagree.
        const maxInboxLines = this.getSettings().budget.maxInboxLines;
        const maxInboxBytes = this.getSettings().maintenance?.maxInboxBytes ?? 0;
        const totalLines = await store.inboxLineCount();
        let dropLines = Math.min(Math.max(0, totalLines - maxInboxLines), state.inboxOffset);
        if (maxInboxBytes > 0 && totalLines > 0) {
          const bytes = await store.inboxBytes();
          if (bytes > maxInboxBytes) {
            const avgLine = bytes / totalLines;
            const forBytes = Math.ceil((bytes - maxInboxBytes) / Math.max(1, avgLine));
            dropLines = Math.min(Math.max(dropLines, forBytes), state.inboxOffset);
          }
        }
        if (dropLines > 0) {
          await store.compactInbox(dropLines);
          state.inboxOffset -= dropLines;
          res.notes.push(`inbox compacted: dropped ${dropLines} consumed line(s)`);
        }

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
          detail: `+${res.added} ~${res.updated} =${res.noop} ↓${res.archived} ⊃${res.superseded} ⊘${res.blocked} link=${res.relinked} gc=${res.pruned}`,
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
    const live = [...corpus.entries()].filter(([, c]) => c.meta.validUntil === null);
    if (live.length < SUMMARIZE_MIN_CARDS) return;
    const ranked = live.sort((a, b) => b[1].meta.importance - a[1].meta.importance).slice(0, SUMMARIZE_MAX_CARDS);
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
    tokenSets: ReadonlyMap<string, Set<string>>,
    res: StoreDreamResult,
  ): Promise<void> {
    const entries = [...corpus.entries()]
      .filter(([, { meta }]) => meta.validUntil === null)
      .map(([id, c]) => ({ id, meta: c.meta, tokens: c.tokens }));
    const pairs: { a: { id: string; meta: import('./types.ts').CardMeta; tokens: string[] }; b: { id: string; meta: import('./types.ts').CardMeta; tokens: string[] }; sim: number }[] = [];
    const yieldNow = createYielder();
    let evals = 0;
    let capped = false;
    for (let i = 0; i < entries.length && pairs.length < CONFLICT_MAX_PAIRS; i++) {
      for (let j = i + 1; j < entries.length && pairs.length < CONFLICT_MAX_PAIRS; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a === undefined || b === undefined) continue;
        const sa = tokenSets.get(a.id);
        const sb = tokenSets.get(b.id);
        if (sa === undefined || sb === undefined) continue;
        // jaccard ≤ min/max, so a pair whose token sets differ wildly in size
        // cannot reach the band's lower bound. Cheap integer check before the
        // expensive intersection.
        const min = Math.min(sa.size, sb.size);
        const max = Math.max(sa.size, sb.size);
        if (max === 0 || min / max < CONFLICT_SIM_MIN) continue;
        if (++evals > CONFLICT_MAX_EVALS) {
          capped = true;
          break;
        }
        await yieldNow();
        const sim = jaccard(sa, sb);
        if (sim >= CONFLICT_SIM_MIN && sim < CONFLICT_SIM_MAX) {
          pairs.push({ a, b, sim });
        }
      }
      if (capped) break;
    }
    if (capped) res.notes.push(`llm-conflict: pair scan capped at ${CONFLICT_MAX_EVALS} comparisons`);
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
      const winnerId = d === 'a' ? pair.a.id : pair.b.id;
      const ts = new Date().toISOString();
      // Bitemporal resolution: the loser keeps its file and gains the
      // validUntil/supersededBy pair, so it leaves recall while the reason it
      // disappeared stays auditable and reversible. The winner records the
      // forward link.
      const superseded = await store.supersedeCard(loserId, winnerId, ts, { rebuild: false });
      if (superseded === null) continue;
      const winnerMeta = corpus.get(winnerId)?.meta;
      const forward = [...new Set([...(winnerMeta?.supersedes ?? []), loserId])];
      await store.patchCard(winnerId, { supersedes: forward, updated: ts }, { rebuild: false });
      if (winnerMeta !== undefined) {
        winnerMeta.supersedes = forward;
        winnerMeta.updated = ts;
      }
      await store.audit({
        ts,
        store: store.slug,
        op: 'supersede',
        id: loserId,
        detail: `llm-conflict(kept ${winnerId})`,
        via: 'dream-llm',
      });
      corpus.delete(loserId);
      res.superseded++;
      res.notes.push(`llm-conflict: supersede ${loserId} (kept ${winnerId})`);
    }
  }
}

const SUMMARIZE_MIN_CARDS = 8;
const SUMMARIZE_MAX_CARDS = 40;
const CONFLICT_SIM_MIN = 0.3;
const CONFLICT_SIM_MAX = 0.85;
const CONFLICT_MAX_PAIRS = 4;
/**
 * Ceiling on pair comparisons for the best-effort conflict pass. The scan is
 * inherently pairwise; a cap (plus the token-length prefilter) keeps it from
 * becoming an O(N²) freeze as a store grows. Reaching it only means some pairs
 * are not considered this run — the pass is advisory, never a correctness gate.
 */
const CONFLICT_MAX_EVALS = 20_000;
/** Max links written per card by the relink pass. */
const RELINK_LINKS = 5;
/**
 * How many shared-tag candidates get the (more expensive) Jaccard comparison.
 * Shared-tag count dominates the ranking by construction (×10 vs a 0..1
 * similarity), so the top-5 can only come from the top of this list.
 */
const RELINK_CANDIDATE_CAP = 64;
/**
 * Max link rewrites per Dream run. Writing every changed card in one run is a
 * multi-second burst on a fresh large store; the pass is idempotent, so the
 * remainder simply converges on later runs.
 */
const RELINK_WRITE_CAP = 500;

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  const line = (idx < 0 ? text : text.slice(0, idx)).trim();
  return line.length > 0 ? line : text.trim().slice(0, 120);
}

async function writeReport(dreamDir: string, r: { slug: string; ts: string; res: StoreDreamResult; notes: string[] }): Promise<void> {
  const md = [
    `# Dream report — ${r.slug}`,
    '',
    `- time: ${r.ts}`,
    `- added: ${r.res.added}`,
    `- updated: ${r.res.updated}`,
    `- noop: ${r.res.noop}`,
    `- archived: ${r.res.archived}`,
    `- superseded: ${r.res.superseded ?? 0}`,
    `- blocked: ${r.res.blocked}`,
    `- relinked: ${r.res.relinked}`,
    `- pruned: ${r.res.pruned ?? 0}`,
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

/** The timer face Dream needs (cordis TimerService, or a structural fake). */
export interface DreamTimers {
  interval?: (fn: () => void, delayMs: number) => () => void;
  timeout?: (fn: () => void, delayMs: number) => () => void;
}

/**
 * Attach the 60 s tick + 30 s startup sweep to an existing engine. Separate
 * from engine construction so the row can build the engine immediately (tools
 * and commands need it) and attach timers only once the OPTIONAL timer service
 * is present — in any mount order.
 *
 * @returns the timer disposers. cordis TimerService owns its timers on ITS own
 *   fiber, so the caller must attach these to an effect to guarantee teardown.
 */
export function attachDreamTimers(timers: DreamTimers, engine: DreamEngine, logger: StoreLogger | null): (() => void)[] {
  const disposers: (() => void)[] = [];
  const safeTick = () => {
    void engine.tick().catch((err) => logger?.warn(`[dsh-memory] dream tick failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  try {
    const startup = timers.timeout?.(safeTick, STARTUP_SWEEP_MS);
    if (startup !== undefined) disposers.push(startup);
    const tick = timers.interval?.(safeTick, TICK_MS);
    if (tick !== undefined) disposers.push(tick);
  } catch (err) {
    logger?.warn(`[dsh-memory] dream tick registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof timers.timeout !== 'function' && typeof timers.interval !== 'function') {
    logger?.warn('[dsh-memory] timer services unavailable; Dream runs only on explicit triggers (tool / command / client)');
  }
  return disposers;
}

/**
 * Register the Dream tick on the host context: 60s interval + a 30s startup
 * sweep. Returns the engine so callers (tools, settings watch) can trigger
 * runs. All side effects belong to the caller's fiber.
 */
export function registerDream(
  ctx: DreamTimers,
  core: MemoryCore,
  getSettings: () => MemorySettings,
  logger: StoreLogger | null,
  llmDeps: MemoryLlmDeps | null = null,
): DreamEngine {
  const engine = new DreamEngine(core, getSettings, logger, llmDeps);
  attachDreamTimers(ctx, engine, logger);
  return engine;
}
