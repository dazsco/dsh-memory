/**
 * Capacity maintenance (GC): the bounded-growth half of the memory design.
 *
 * Recall quality degrades and every pass slows down as a store grows, so
 * "remember everything forever" is not a policy — it is a leak. This module
 * enforces the ceilings that keep a store's working set bounded:
 *
 *   1. stale sweep     — untouched low-importance cards are archived
 *   2. card budget     — over `maxLiveCards`, the lowest-value cards are archived
 *   3. archive budget  — the oldest archived cards are hard-deleted
 *   4. log budgets     — audit / access logs are truncated to their newest lines
 *   5. inbox budget    — the CONSUMED inbox head is dropped (lines and/or bytes)
 *
 * It is the single implementation behind both the automatic Dream pass and the
 * explicit `memory_gc` tool / `/memory gc` command, and it can run as a DRY RUN
 * that reports exactly what it would do without touching a byte.
 *
 * Nothing here destroys live memory: card sweeps ARCHIVE (the file moves to
 * `archive/` and stays restorable). Only the archive/log prunes are
 * irreversible, and only ever past their configured ceilings.
 */
import { createYielder } from './fsutil.ts';
import { cardRecency, cardStrength } from './retrieval.ts';
import type { MemorySettings } from './settings.ts';
import type { StoreLogger } from './store.ts';
import { MemoryStore } from './store.ts';
import type { CardMeta, StoreMaintenanceResult } from './types.ts';

/** Every ceiling one maintenance pass enforces. */
export interface MaintenanceLimits {
  /** Cards untouched for longer than this (days) may be archived. 0 = disabled. */
  staleDays: number;
  /** …but only when their importance is at or below this (1–10). */
  staleMaxImportance: number;
  /** Live-card ceiling per store. */
  maxLiveCards: number;
  /** Archived-card ceiling per store (oldest are hard-deleted past it). */
  maxArchivedCards: number;
  /** Audit-log line ceiling per store. */
  maxAuditLines: number;
  /** Access-log line ceiling per store. */
  maxAccessLines: number;
  /** Inbox byte ceiling per store. */
  maxInboxBytes: number;
  /** Inbox line ceiling per store. */
  maxInboxLines: number;
}

/** Conservative fallbacks (used when a caller has no settings view). */
export const DEFAULT_MAINTENANCE_LIMITS: MaintenanceLimits = {
  staleDays: 180,
  staleMaxImportance: 6,
  maxLiveCards: 2000,
  maxArchivedCards: 2000,
  maxAuditLines: 4000,
  maxAccessLines: 4000,
  maxInboxBytes: 1_000_000,
  maxInboxLines: 1000,
};

/**
 * The effective limits for one settings view. Defensive about a settings
 * document persisted before the `maintenance` section existed.
 */
export function maintenanceLimitsFrom(settings: MemorySettings): MaintenanceLimits {
  const m = settings.maintenance ?? DEFAULT_MAINTENANCE_LIMITS;
  return {
    staleDays: m.staleDays,
    staleMaxImportance: m.staleMaxImportance,
    maxLiveCards: m.maxLiveCards,
    maxArchivedCards: m.maxArchivedCards,
    maxAuditLines: m.maxAuditLines,
    maxAccessLines: m.maxAccessLines,
    maxInboxBytes: m.maxInboxBytes,
    maxInboxLines: settings.budget?.maxInboxLines ?? DEFAULT_MAINTENANCE_LIMITS.maxInboxLines,
  };
}

/**
 * Standing user instructions. They are never stale-swept and are evicted from
 * the card budget LAST (they are durable preferences/commitments, exactly the
 * memories a user expects to survive), which is why they sink in the ordering
 * rather than being exempt — the ceiling still holds even in the pathological
 * case where every card is a preference.
 */
const STANDING_KINDS: ReadonlySet<string> = new Set(['preference', 'commitment']);

const DAY_MS = 86_400_000;

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / DAY_MS) : Infinity;
}

/**
 * Disposability score of one card — LOWER means more expendable. Combines the
 * stored importance with how recently the card was used (recency) and how much
 * corroboration/usage it accumulated (strength, itself time-decayed), so a
 * card that is important AND recently recalled is never evicted before a
 * stale, never-recalled one.
 */
export function cardValue(meta: CardMeta, now: Date): number {
  const importance = Math.min(1, Math.max(0, meta.importance / 10));
  const recency = cardRecency(meta.lastAccessed, now);
  const strength = cardStrength(meta.accessCount, meta.updated, now);
  const confidence = Number.isFinite(meta.confidence) ? Math.min(1, Math.max(0, meta.confidence)) : 0.6;
  return importance * (0.4 + 0.6 * recency) * (0.5 + 0.5 * strength) * (0.5 + 0.5 * confidence);
}

export interface MaintenanceSelection {
  /** Live cards to archive because they went stale. */
  stale: string[];
  /** Live cards to archive to get back under `maxLiveCards`. */
  overBudget: string[];
  /** Live cards before the pass. */
  liveCards: number;
}

/**
 * Pure selection step: which live cards the limits would retire, without
 * touching the store. Exported so tests (and a dry run) can assert the policy
 * directly.
 */
export function selectMaintenance(
  entries: readonly (readonly [string, CardMeta])[],
  limits: MaintenanceLimits,
  now: Date,
): MaintenanceSelection {
  const live = entries.filter(([, meta]) => meta.validUntil === null);
  const stale: string[] = [];
  const staleSet = new Set<string>();
  if (limits.staleDays > 0) {
    for (const [id, meta] of live) {
      if (STANDING_KINDS.has(meta.kind)) continue;
      if (meta.importance > limits.staleMaxImportance) continue;
      if (daysSince(meta.updated, now) <= limits.staleDays) continue;
      stale.push(id);
      staleSet.add(id);
    }
  }
  const remaining = live.filter(([id]) => !staleSet.has(id));
  const excess = remaining.length - Math.max(0, limits.maxLiveCards);
  const overBudget: string[] = [];
  if (excess > 0) {
    const ordered = [...remaining].sort((a, b) => {
      const ap = STANDING_KINDS.has(a[1].kind) ? 1 : 0;
      const bp = STANDING_KINDS.has(b[1].kind) ? 1 : 0;
      if (ap !== bp) return ap - bp; // standing kinds are evicted last
      return cardValue(a[1], now) - cardValue(b[1], now);
    });
    for (const [id] of ordered.slice(0, excess)) overBudget.push(id);
  }
  return { stale, overBudget, liveCards: live.length };
}

export interface MaintainStoreOptions {
  limits: MaintenanceLimits;
  /** Report only — compute the same selection but change nothing on disk. */
  dryRun?: boolean;
  /** Clock override (tests). */
  now?: Date;
  logger?: StoreLogger | null;
  /**
   * Rebuild the index at the end when cards were archived. Dream passes false:
   * it owns a single end-of-run rebuild, and a second one would double the
   * heaviest I/O of the run.
   */
  rebuildIndex?: boolean;
  /**
   * Live-card metadata to sweep, when the caller already holds it (Dream holds
   * its run corpus, which is AHEAD of the on-disk index mid-run). Defaults to
   * reading the store index.
   */
  entries?: readonly (readonly [string, CardMeta])[];
  /**
   * Leave the inbox alone. Dream sets this: it owns the inbox offset
   * checkpoint for its run, and a second writer computing a drop from its own
   * stale copy of that offset could drop unconsumed lines.
   */
  skipInbox?: boolean;
  /**
   * Wall-clock deadline (ms since epoch) for the card sweep. Past it the sweep
   * stops early and reports `truncated` — the selection is recomputed next run,
   * so a partial pass is safe.
   */
  deadline?: number;
}

/**
 * Enforce every limit on one store. Never throws for a policy reason; file
 * errors propagate to the caller (which contains them per store).
 */
export async function maintainStore(store: MemoryStore, opts: MaintainStoreOptions): Promise<StoreMaintenanceResult> {
  const { limits } = opts;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? new Date();
  const yieldNow = createYielder();

  const entries: readonly (readonly [string, CardMeta])[] =
    opts.entries ?? (Object.entries((await store.readIndex()).cards) as [string, CardMeta][]);
  const selection = selectMaintenance(entries, limits, now);
  const staleSet = new Set(selection.stale);

  const result: StoreMaintenanceResult = {
    slug: store.slug,
    kind: store.kind,
    dryRun,
    liveCards: selection.liveCards,
    staleArchived: selection.stale.length,
    budgetArchived: selection.overBudget.length,
    archivePruned: 0,
    auditPruned: 0,
    accessPruned: 0,
    inboxDropped: 0,
    bytesReclaimed: 0,
    truncated: false,
  };

  // ── archive budget (counted on a dry run, applied otherwise) ─────────────
  const archived = await store.listArchived(); // newest first
  const archiveExcess = Math.max(0, archived.length - Math.max(0, limits.maxArchivedCards));
  if (archiveExcess > 0) {
    result.archivePruned = archiveExcess;
    // Exact byte count for the dry run; the applied path replaces it with what
    // the prune actually reclaimed (so it is never double counted).
    if (dryRun) for (const row of archived.slice(archived.length - archiveExcess)) result.bytesReclaimed += row.bytes;
  }

  // ── log budgets ──────────────────────────────────────────────────────────
  const auditLines = await store.auditLineCount();
  const auditExcess = Math.max(0, auditLines - Math.max(0, limits.maxAuditLines));
  const accessLines = await store.accessLineCount();
  const accessExcess = Math.max(0, accessLines - Math.max(0, limits.maxAccessLines));
  result.auditPruned = auditExcess;
  result.accessPruned = accessExcess;

  // ── inbox budget (lines and bytes; only CONSUMED head lines) ─────────────
  let dropLines = 0;
  let state: Awaited<ReturnType<MemoryStore['readState']>> | null = null;
  if (opts.skipInbox !== true) {
    const inboxLines = await store.inboxLineCount();
    const inboxBytes = await store.inboxBytes();
    state = await store.readState();
    dropLines = Math.min(Math.max(0, inboxLines - Math.max(0, limits.maxInboxLines)), state.inboxOffset);
    if (limits.maxInboxBytes > 0 && inboxBytes > limits.maxInboxBytes && inboxLines > 0) {
      const avgLine = inboxBytes / inboxLines;
      const forBytes = Math.ceil((inboxBytes - limits.maxInboxBytes) / Math.max(1, avgLine));
      dropLines = Math.min(Math.max(dropLines, forBytes), state.inboxOffset);
    }
    result.inboxDropped = dropLines;
    if (dropLines > 0) result.bytesReclaimed += Math.round((dropLines / Math.max(1, inboxLines)) * inboxBytes);
  }

  if (dryRun) return result;

  // ── apply: card sweeps (archive, never delete) ───────────────────────────
  // Collected first, then archived as ONE batch with ONE audit append: a sweep
  // that sheds a thousand cards otherwise pays a lock per card for both.
  const selected: { id: string; why: string; stale: boolean }[] = [];
  for (const id of [...selection.stale, ...selection.overBudget]) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) {
      result.truncated = true;
      break;
    }
    const isStale = staleSet.has(id);
    selected.push({
      id,
      why: isStale ? `stale(${limits.staleDays}d)` : `budget(maxLiveCards=${limits.maxLiveCards})`,
      stale: isStale,
    });
  }
  const movedIds = new Set(await store.archiveCards(selected.map((s) => s.id), { rebuild: false }));
  // Only cards that actually moved are counted/audited (a concurrent process
  // may have archived one already). The counts start from zero here: the values
  // set above are the SELECTION and are only what a dry run reports.
  result.staleArchived = 0;
  result.budgetArchived = 0;
  const auditRows = [];
  for (const entry of selected) {
    if (!movedIds.has(entry.id)) continue;
    if (entry.stale) result.staleArchived++;
    else result.budgetArchived++;
    auditRows.push({
      ts: now.toISOString(),
      store: store.slug,
      op: 'archive' as const,
      id: entry.id,
      detail: entry.why,
      via: 'maintenance' as const,
    });
  }
  await store.auditMany(auditRows).catch(() => undefined);
  await yieldNow();

  // ── apply: irreversible prunes ───────────────────────────────────────────
  if (result.archivePruned > 0) {
    const pruned = await store.pruneArchived(limits.maxArchivedCards);
    result.archivePruned = pruned.pruned;
    result.bytesReclaimed += pruned.bytes;
  }
  if (result.auditPruned > 0) {
    const compacted = await store.compactAudit(limits.maxAuditLines);
    result.auditPruned = compacted.dropped;
    result.bytesReclaimed += compacted.bytes;
  }
  if (result.accessPruned > 0) {
    const compacted = await store.compactAccess(limits.maxAccessLines);
    result.accessPruned = compacted.dropped;
    result.bytesReclaimed += compacted.bytes;
  }
  if (dropLines > 0 && state !== null) {
    await store.compactInbox(dropLines);
    // The offset counts the same lines that were just dropped: decrement it in
    // the same breath so the checkpoint and the file can never disagree.
    state.inboxOffset = Math.max(0, state.inboxOffset - dropLines);
    await store.writeState(state);
  }

  if (movedIds.size > 0 && opts.rebuildIndex !== false) await store.rebuildIndex();

  if (movedIds.size > 0 || result.archivePruned > 0 || result.auditPruned > 0 || result.accessPruned > 0 || dropLines > 0) {
    await store
      .audit({
        ts: now.toISOString(),
        store: store.slug,
        op: 'maintain',
        detail:
          `stale=${result.staleArchived} budget=${result.budgetArchived} archive=${result.archivePruned} ` +
          `audit=${result.auditPruned} access=${result.accessPruned} inbox=${result.inboxDropped} ` +
          `freed≈${result.bytesReclaimed}B${result.truncated ? ' truncated' : ''}`,
        via: 'maintenance',
      })
      .catch(() => undefined);
  }
  opts.logger?.info(
    `[dsh-memory] maintain ${store.slug}: archived ${movedIds.size} (stale ${result.staleArchived}/budget ${result.budgetArchived}), ` +
      `pruned archive ${result.archivePruned} audit ${result.auditPruned} access ${result.accessPruned} inbox ${result.inboxDropped} (~${result.bytesReclaimed}B)`,
  );
  return result;
}
