/**
 * dsh-memory core data model.
 *
 * One memory = one atomic Markdown card (A-MEM style) with YAML-subset
 * frontmatter. Stores are plain directory trees under $DSH_HOME/memory so
 * everything stays human-readable, diffable, and exportable. Derived state
 * (index.json, dream state) is always recomputable from the cards.
 */

/** Current on-disk schema version of index.json / dream state. */
export const MEMORY_SCHEMA_VERSION = 1;

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
  links: string[];
  /** sha1 over normalized card content — change detection without re-reading. */
  digest: string;
  /** Token count of title+body (rough, from the shared tokenizer). */
  tokens: number;
}

/** BM25 corpus statistics maintained by index rebuilds. */
export interface Bm25Stats {
  docCount: number;
  avgDocLen: number;
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
  | 'promote'
  | 'dream'
  | 'forget'
  | 'hard-delete'
  | /** Auxiliary LLM path outcome for one turn capture (ok/skipped/error). */
  'llm';

export type AuditVia = 'tool' | 'auto' | 'auto-heuristic' | 'auto-llm' | 'dream' | 'dream-llm' | 'user' | 'client' | 'system';

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
}

/** Per-store counts reported by status. */
export interface StoreStatus {
  slug: string;
  kind: 'global' | 'project';
  projectPath?: string;
  cards: number;
  archived: number;
  pendingInbox: number;
  lastDream: string | null;
  root: string;
}

export interface StatusReport {
  enabled: boolean;
  schema: number;
  stores: StoreStatus[];
  lastDream: string | null;
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
