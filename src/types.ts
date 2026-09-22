/**
 * dsh-memory core data model.
 *
 * One memory = one atomic Markdown card (A-MEM style) with YAML-subset
 * frontmatter. Stores are plain directory trees under $DSH_HOME/memory so
 * everything stays human-readable, diffable, and exportable. Derived state
 * (index.json, dream state) is always recomputable from the cards.
 */

/**
 * Current on-disk schema version of index.json / dream state.
 *
 * v2 — `CardMeta.terms` carries the card's token array so recall/Dream score
 * from the derived index instead of re-reading every card file, and cards gain
 * the explicit `supersededBy` back-link of the bitemporal pair. A v1 index is
 * rebuilt on first read (the index is always recomputable); card files are
 * forward/backward tolerant because every v2 field has a defined absence.
 */
export const MEMORY_SCHEMA_VERSION = 2;

/** What kind of memory a card holds. */
export type MemoryKind =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'procedure'
  | 'commitment'
  | 'observation'
  | 'summary';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'fact',
  'preference',
  'decision',
  'procedure',
  'commitment',
  'observation',
  'summary',
];

/** Provenance of one card (which session and turn produced it). */
export interface MemorySource {
  session: string;
  turn: number | null;
}

/** Parsed memory card (frontmatter + body). */
export interface MemoryCard {
  id: string;
  kind: MemoryKind;
  tags: string[];
  /** 1..10, assigned at capture, adjustable by Dream. */
  importance: number;
  /** 0..1, raised by cross-session corroboration. */
  confidence: number;
  /** ISO-8601 UTC timestamps. */
  created: string;
  updated: string;
  lastAccessed: string;
  accessCount: number;
  /** Bitemporal validity (Zep style): validUntil !== null means superseded; the file is kept. */
  validSince: string;
  validUntil: string | null;
  /** Ids of cards this card supersedes. */
  supersedes: string[];
  /**
   * Id of the card that replaced this one (the inverse of `supersedes`).
   * null = this card is the live version. Written together with `validUntil`
   * by the supersede path; absent in v1 cards, which parse as null.
   */
  supersededBy: string | null;
  source: MemorySource;
  /** Related card ids (A-MEM style links). */
  links: string[];
  /** First line of the body. */
  title: string;
  /** Optional detail under the title (byte-capped). */
  body: string;
}

/** Derived per-card metadata stored in index.json. */
export interface CardMeta {
  path: string;
  title: string;
  kind: MemoryKind;
  tags: string[];
  importance: number;
  confidence: number;
  created: string;
  updated: string;
  lastAccessed: string;
  accessCount: number;
  validUntil: string | null;
  supersedes: string[];
  supersededBy: string | null;
  links: string[];
  /** sha1 over normalized card content — change detection without re-reading. */
  digest: string;
  /**
   * The card's token array (title+body), persisted so recall/Dream/jaccard
   * score straight from the index. Duplicates are preserved: BM25 needs term
   * frequency, Jaccard wraps it in a Set.
   */
  terms: string[];
  /** Serialized card size in bytes (drives status/stats without extra stats). */
  bytes: number;
}

/** BM25 corpus statistics maintained by index rebuilds. */
export interface Bm25Stats {
  docCount: number;
  avgDocLen: number;
  /**
   * Sum of every indexed card's term count (avgDocLen = totalTokens/docCount).
   * Persisted so an INCREMENTAL single-card index update keeps the average
   * exact without re-reading the corpus. Absent in an index written before
   * incremental updates existed — such an index is rebuilt on first write.
   */
  totalTokens?: number;
  /** Document frequency per token. */
  df: Record<string, number>;
}

/** Derived store index (index.json). Always rebuildable from cards. */
export interface MemoryIndex {
  schema: number;
  generatedAt: string;
  cards: Record<string, CardMeta>;
  bm25: Bm25Stats;
}

/** One staged capture in inbox.jsonl (policy-clean by construction). */
export interface InboxEntry {
  /** ISO-8601 UTC timestamp of capture. */
  ts: string;
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  importance?: number;
  source: MemorySource;
  /** 'explicit' (tool), 'auto-heuristic' (turn-scan), 'auto-llm' (extraction). */
  via: string;
}

/** Ops recorded in the append-only audit log. */
export type AuditOp =
  | 'create'
  | 'update'
  | 'archive'
  | 'delete'
  | 'block'
  | 'dream'
  | 'forget'
  | 'hard-delete'
  | /** GUI archive → cards inverse move (v2 per-card management). */
  'restore'
  | /** Auxiliary LLM path outcome for one turn capture (ok/skipped/error). */
  'llm'
  | /** A malformed (unparseable) inbox line skipped + advanced past by Dream. */
  'quarantine'
  | /** A card replaced by a newer version (bitemporal supersede). */
  'supersede'
  | /** A card restored from an imported bundle (memory.export/import). */
  'import'
  | /** A whole project store directory was dropped (final line before rm). */
  'drop-store'
  | /** One maintenance/GC pass summary (what it archived and pruned). */
  'maintain';

export type AuditVia =
  | 'tool'
  | 'auto'
  | 'auto-heuristic'
  | 'auto-llm'
  /** Harness compaction summary staged into the inbox. */
  | 'auto-compaction'
  | 'dream'
  | 'dream-llm'
  | 'user'
  | 'client'
  | 'command'
  | 'system'
  /** Capacity/GC pass (automatic Dream pass or an explicit memory_gc call). */
  | 'maintenance';

export interface AuditEntry {
  ts: string;
  /** Store slug ('global' or project slug). */
  store: string;
  op: AuditOp;
  id?: string;
  /** Free detail (NEVER contains blocked secret content — pattern names only). */
  detail?: string;
  via: AuditVia;
  session?: string;
}

/** Dream checkpoint (dream/state.json) — the idempotent resume point. */
export interface DreamState {
  schema: number;
  /** Lines of inbox.jsonl already consumed. */
  inboxOffset: number;
  lastRun: string | null;
  lastResult: 'success' | 'error' | null;
  lastError?: string;
  stats: {
    runs: number;
    added: number;
    updated: number;
    archived: number;
    blocked: number;
  };
}

/** Resolved directory layout of one memory store. */
export interface StorePaths {
  /** Store root (e.g. $DSH_HOME/memory/projects/<slug>). */
  root: string;
  cards: string;
  archive: string;
  dream: string;
  /** Append-only staged capture log. */
  inbox: string;
  /** Derived index. */
  index: string;
  /** Append-only audit log. */
  audit: string;
  /** Consumed-on-dream access counters log. */
  access: string;
  /** Dream checkpoint. */
  state: string;
  /** Store-wide write lock file. */
  lock: string;
}

/** Recall hit returned by tools and brief assembly. */
export interface RecallHit {
  store: string;
  id: string;
  kind: MemoryKind;
  title: string;
  snippet: string;
  score: number;
  path: string;
  tags: string[];
  importance: number;
  updated: string;
  /** Id of the replacing card, null while the card is the live version. */
  supersededBy: string | null;
  /** 1-hop link ids (A-MEM graph), for graph-aware callers. */
  links: string[];
}

/** Per-store counts and derived shape reported by status/stats. */
export interface StoreStatus {
  slug: string;
  kind: 'global' | 'project';
  projectPath?: string;
  cards: number;
  archived: number;
  /** Live cards whose `validUntil` is set (kept, no longer served). */
  superseded: number;
  pendingInbox: number;
  lastDream: string | null;
  root: string;
  /** Live-card histogram per kind (only non-zero kinds). */
  kinds: Partial<Record<MemoryKind, number>>;
  /** Most frequent tags over live cards, descending (top 10). */
  topTags: { tag: string; count: number }[];
  /** Bytes of the store's card files (live + archive). */
  bytes: number;
}

export interface StatusReport {
  enabled: boolean;
  schema: number;
  stores: StoreStatus[];
  lastDream: string | null;
  /** Totals across every store. */
  totals: {
    stores: number;
    cards: number;
    archived: number;
    superseded: number;
    pendingInbox: number;
    bytes: number;
  };
}

/**
 * What one maintenance (GC) pass did — or WOULD do on a dry run. Every field
 * counts ACTIONS, not bytes, except `bytesReclaimed` which is the summed size
 * of the files/lines removed.
 */
export interface StoreMaintenanceResult {
  slug: string;
  kind: 'global' | 'project';
  dryRun: boolean;
  /** Live cards before the pass. */
  liveCards: number;
  /** Archived because they went untouched past `staleDays` at low importance. */
  staleArchived: number;
  /** Archived to bring the store back under `maxLiveCards`. */
  budgetArchived: number;
  /** Oldest archived cards hard-deleted past `maxArchivedCards`. */
  archivePruned: number;
  /** Audit lines dropped past `maxAuditLines`. */
  auditPruned: number;
  /** Access-log lines dropped past `maxAccessLines`. */
  accessPruned: number;
  /** Consumed inbox lines dropped (line and/or byte budget). */
  inboxDropped: number;
  /** Bytes reclaimed by the prunes above. */
  bytesReclaimed: number;
  /**
   * The caller's wall-clock deadline stopped the card sweep early. The
   * selection is recomputed from scratch next run, so a truncated pass is
   * simply a partial one — nothing is lost or left half-done.
   */
  truncated: boolean;
}

export interface MaintainReport {
  dryRun: boolean;
  stores: StoreMaintenanceResult[];
  totals: {
    staleArchived: number;
    budgetArchived: number;
    archivePruned: number;
    auditPruned: number;
    accessPruned: number;
    inboxDropped: number;
    bytesReclaimed: number;
  };
}

/** Portable export bundle (memory_export / GET /api/memory/export). */
export interface MemoryExportStore {
  slug: string;
  kind: 'global' | 'project';
  projectPath: string | null;
  /** Live cards, newest first. */
  cards: MemoryCard[];
  /** Archived cards included for a full backup; empty when `liveOnly`. */
  archived: MemoryCard[];
}

export interface MemoryExportBundle {
  format: 'dsh-memory-export';
  /** Bundle format version (independent of the store schema). */
  version: number;
  exportedAt: string;
  /** Store schema at export time (a mismatched import is still parsed leniently). */
  schema: number;
  stores: MemoryExportStore[];
}

/** Outcome of one import into one store. */
export interface MemoryImportStoreResult {
  slug: string;
  kind: 'global' | 'project';
  added: number;
  /** Cards already present with identical content (id + digest). */
  skipped: number;
  /** Same id, different content — the imported version replaces it. */
  replaced: number;
  /** Cards refused by the policy gate or malformed (never written). */
  rejected: number;
  errors: string[];
}

export interface MemoryImportResult {
  totals: { added: number; skipped: number; replaced: number; rejected: number };
  stores: MemoryImportStoreResult[];
}

/** Raised when a capture is refused by the policy stack (secrets/rules). */
export class MemoryPolicyError extends Error {
  constructor(
    public readonly reasons: string[],
  ) {
    super(`memory policy violation: ${reasons.join(', ')}`);
    this.name = 'MemoryPolicyError';
  }
}

/** File-level failure inside the memory stores. */
export class MemoryFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryFsError';
  }
}
