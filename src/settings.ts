/**
 * The memory plugin's live configuration.
 *
 * DSH 0.1.7 replaced the standalone settings-namespace registry with the
 * plugin's own Loader Config: the settings namespace IS the row id of the
 * running entry, `describe`/`update`/`mutate` address that entry, and only
 * fields a schema marks `.volatile()` are hot-reloadable and editable. So the
 * whole memory surface is declared here as ONE Cordis Config schema whose
 * top-level sections (and the `enabled` master switch) are volatile: a write
 * commits into the running fiber's references without remounting the row, and
 * `readMemorySettings` projects those references into the plain value every
 * consumer already takes.
 *
 * Layering (lowest first): schema defaults (the production defaults below) →
 * the composition row's `config:` block in a bundle/profile patch → the user
 * layer the GUI or `dsh` writes into the profile patch.
 */
import type { Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

/**
 * Settings namespace == the id of this plugin's Loader row. The bundle patch
 * inserts that row as `dsh-memory`, and the browser half binds the same string.
 */
export const MEMORY_NS = 'dsh-memory';

/** Turn-end auto-capture policy. */
export interface CaptureSettings {
  /** off: never capture; explicit: only memory_remember; auto: + turn-end extraction. */
  mode: 'off' | 'explicit' | 'auto';
  /** Use the user-configured LLM route for extraction. */
  useLlm: boolean;
  /** Tail of the turn text offered to extraction. */
  turnTailChars: number;
  /** Turns shorter than this are never captured. */
  minTurnContentChars: number;
  /** Stage the harness's own compaction summary into project memory. */
  compaction: boolean;
  /** Byte cap for one compaction summary candidate. */
  compactionMaxChars: number;
  /** Score the intent heuristic on user statements (cheap, high precision). */
  heuristic: boolean;
  /** Per-session ceiling on auxiliary extraction calls (0 = unlimited). */
  llmMaxCallsPerSession: number;
  /** Minimum spacing between two extraction calls in one session (ms; 0 = none). */
  llmMinIntervalMs: number;
}

/** PII policy (the built-in secret gate is always on and cannot be configured). */
export interface RedactSettings {
  /** off | warn (audit only) | redact (mask in stored text). */
  pii: 'off' | 'warn' | 'redact';
}

/** Background Dream consolidation. */
export interface DreamSettings {
  enabled: boolean;
  /** LLM passes (summarize/conflict) via the user's own route. */
  useLlm: boolean;
  /** Idle-tick cadence (minutes, min 5). */
  intervalMinutes: number;
  /** Budget of LLM calls per Dream run. */
  maxLlmCalls: number;
  /** Wall-clock budget per Dream run (ms). */
  maxWallMs: number;
  /** Monotonic client "run now" trigger (GUI writes, host watches). */
  requestSeq: number;
}

/** Session-start memory brief. */
export interface BriefSettings {
  enabled: boolean;
  /** Total injected bytes cap. */
  maxBytes: number;
  projectK: number;
  globalK: number;
}

/** Recall / ranking policy. */
export interface RecallSettings {
  /** Default max hits for one recall (1–50). */
  k: number;
  /** Promote 1-hop link-graph neighbours of the top hits (A-MEM). */
  expandLinks: boolean;
  /** Link-promotion factor for an admitted neighbour (0–1). */
  linkDecay: number;
  /** Include cards the agent already superseded in the session brief. */
  briefIncludeSuperseded: boolean;
}

/** Human-facing slash-command surface (`/memory ...` in the composer). */
export interface CommandsSettings {
  enabled: boolean;
}

/** Write-path budgets. */
export interface BudgetSettings {
  /** Max card content bytes (title+body). */
  maxCardBytes: number;
  /** Max staged inbox lines per store. */
  maxInboxLines: number;
}

/** Capacity maintenance (GC) ceilings, enforced at the end of every Dream run. */
export interface MaintenanceSettings {
  /** Master switch for the automatic end-of-Dream maintenance pass. */
  enabled: boolean;
  /** Archive a live card untouched for this many days (0 disables the sweep). */
  staleDays: number;
  /** Importance ceiling for the stale sweep (1–10). */
  staleMaxImportance: number;
  /** Live-card ceiling per store. */
  maxLiveCards: number;
  /** Archived-card ceiling per store. */
  maxArchivedCards: number;
  /** Audit-log line ceiling per store. */
  maxAuditLines: number;
  /** Access-log line ceiling per store. */
  maxAccessLines: number;
  /** Inbox byte ceiling per store. */
  maxInboxBytes: number;
}

/**
 * Auxiliary LLM route and per-call budget, shared by `capture.useLlm` and the
 * Dream LLM passes. Resolution per field, first non-empty wins: (1) these
 * explicit overrides, (2) the CURRENT SESSION's default model
 * (`ctx.agentDefaultModel`), (3) the shipped fallback route.
 */
export interface LlmSettings {
  /** Provider route override (empty = session model → shipped fallback). */
  provider: string;
  /** Model id override (empty = session model → shipped fallback). */
  model: string;
  /** Max output tokens per auxiliary call. */
  maxOutputTokens: number;
  /** Per-call deadline (ms). */
  timeoutMs: number;
}

/** The complete resolved memory configuration as consumers read it. */
export interface MemorySettings {
  /** Master switch: off → no capture, no injection, tools report disabled. */
  enabled: boolean;
  capture: CaptureSettings;
  redact: RedactSettings;
  dream: DreamSettings;
  brief: BriefSettings;
  recall: RecallSettings;
  commands: CommandsSettings;
  budget: BudgetSettings;
  maintenance: MaintenanceSettings;
  llm: LlmSettings;
}

/** The production defaults as plain values (schema defaults, tests, docs). */
export function defaultMemorySettings(): MemorySettings {
  return {
    enabled: true,
    capture: {
      mode: 'auto',
      useLlm: true,
      turnTailChars: 20000,
      minTurnContentChars: 120,
      compaction: true,
      compactionMaxChars: 4000,
      heuristic: true,
      llmMaxCallsPerSession: 20,
      llmMinIntervalMs: 30000,
    },
    redact: { pii: 'redact' },
    dream: { enabled: true, useLlm: true, intervalMinutes: 30, maxLlmCalls: 40, maxWallMs: 600000, requestSeq: 0 },
    brief: { enabled: true, maxBytes: 4096, projectK: 12, globalK: 8 },
    recall: { k: 8, expandLinks: true, linkDecay: 0.5, briefIncludeSuperseded: false },
    commands: { enabled: true },
    budget: { maxCardBytes: 4096, maxInboxLines: 1000 },
    maintenance: {
      enabled: true,
      staleDays: 180,
      staleMaxImportance: 6,
      maxLiveCards: 2000,
      maxArchivedCards: 2000,
      maxAuditLines: 4000,
      maxAccessLines: 4000,
      maxInboxBytes: 1000000,
    },
    llm: { provider: '', model: '', maxOutputTokens: 2000, timeoutMs: 60000 },
  };
}

/**
 * The plugin's Config schema.
 *
 * Every top-level field is volatile, so the settings form exposes each whole
 * section and a path edit inside one (`capture.useLlm`) stays live. DSH runs
 * one schema here; `volatileForm` derives the editable subset, and the loader
 * commits edits into the running references without remounting the row.
 */
export const MemorySettingsSchema = z.object({
  /** Master switch: off → no capture, no injection, tools report disabled. */
  enabled: z.boolean().default(true).volatile(),
  /** Turn-end auto-capture policy. */
  capture: z
    .object({
      /** off: never capture; explicit: only memory_remember; auto: + turn-end extraction. */
      mode: z.union([z.const('off'), z.const('explicit'), z.const('auto')]).default('auto'),
      /** Use the user-configured LLM route for extraction. */
      useLlm: z.boolean().default(true),
      /** Tail of the turn text offered to extraction. */
      turnTailChars: z.natural().max(200000).default(20000),
      /** Turns shorter than this are never captured. */
      minTurnContentChars: z.natural().default(120),
      /**
       * Stage the harness's OWN compaction summary into project memory as a
       * `summary`-kind candidate. A compacted session's durable outcome then
       * survives the compaction instead of being reduced to a checkpoint the
       * next Dream never sees.
       */
      compaction: z.boolean().default(true),
      /** Byte cap for one compaction summary candidate. */
      compactionMaxChars: z.natural().min(200).max(20000).default(4000),
      /** Score the intent heuristic on user statements (cheap, high precision). */
      heuristic: z.boolean().default(true),
      /**
       * Per-session ceiling on auxiliary extraction calls (0 = unlimited). The
       * extraction pass is an EXTRA model call on the same route the agent
       * uses, so an unthrottled turn-end capture competes with the user's own
       * turn for provider concurrency. Skipping is nearly lossless: the pass
       * re-reads the last `turnTailChars` of the conversation, so a skipped
       * turn is covered by the next call.
       */
      llmMaxCallsPerSession: z.natural().max(10000).default(20),
      /**
       * Minimum spacing between two extraction calls in one session (ms;
       * 0 = no spacing). 30 s collapses a fast back-and-forth conversation into
       * one call instead of one per turn.
       */
      llmMinIntervalMs: z.natural().max(3600000).default(30000),
    })
    .default({
      mode: 'auto',
      useLlm: true,
      turnTailChars: 20000,
      minTurnContentChars: 120,
      compaction: true,
      compactionMaxChars: 4000,
      heuristic: true,
      llmMaxCallsPerSession: 20,
      llmMinIntervalMs: 30000,
    })
    .volatile(),
  /** PII policy (the built-in secret gate is always on and cannot be configured). */
  redact: z
    .object({
      /** off | warn (audit only) | redact (mask in stored text). */
      pii: z.union([z.const('off'), z.const('warn'), z.const('redact')]).default('redact'),
    })
    .default({ pii: 'redact' })
    .volatile(),
  /** Background Dream consolidation. */
  dream: z
    .object({
      enabled: z.boolean().default(true),
      /** LLM passes (summarize/conflict) via the user's own route. */
      useLlm: z.boolean().default(true),
      /** Idle-tick cadence (minutes, min 5). */
      intervalMinutes: z.natural().min(5).default(30),
      /** Budget of LLM calls per Dream run. */
      maxLlmCalls: z.natural().max(500).default(40),
      /** Wall-clock budget per Dream run (ms). */
      maxWallMs: z.natural().min(5000).default(600000),
      /** Monotonic client "run now" trigger (GUI writes, host watches). */
      requestSeq: z.natural().default(0),
    })
    .default({ enabled: true, useLlm: true, intervalMinutes: 30, maxLlmCalls: 40, maxWallMs: 600000, requestSeq: 0 })
    .volatile(),
  /** Session-start memory brief. */
  brief: z
    .object({
      enabled: z.boolean().default(true),
      /** Total injected bytes cap. */
      maxBytes: z.natural().min(512).max(32768).default(4096),
      projectK: z.natural().max(50).default(12),
      globalK: z.natural().max(50).default(8),
    })
    .default({ enabled: true, maxBytes: 4096, projectK: 12, globalK: 8 })
    .volatile(),
  /** Recall / ranking policy. */
  recall: z
    .object({
      /** Default max hits for one recall (1–50). */
      k: z.natural().min(1).max(50).default(8),
      /** Promote 1-hop link-graph neighbours of the top hits (A-MEM). */
      expandLinks: z.boolean().default(true),
      /** Link-promotion factor for an admitted neighbour (0–1). */
      linkDecay: z.number().min(0).max(1).default(0.5),
      /**
       * Include cards the agent already superseded in the session brief.
       * Off (default): the brief shows the live version only.
       */
      briefIncludeSuperseded: z.boolean().default(false),
    })
    .default({ k: 8, expandLinks: true, linkDecay: 0.5, briefIncludeSuperseded: false })
    .volatile(),
  /** Human-facing slash-command surface (`/memory ...` in the composer). */
  commands: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true })
    .volatile(),
  /** Write-path budgets. */
  budget: z
    .object({
      /** Max card content bytes (title+body). */
      maxCardBytes: z.natural().min(256).max(65536).default(4096),
      /** Max staged inbox lines per store. */
      maxInboxLines: z.natural().min(10).max(10000).default(1000),
    })
    .default({ maxCardBytes: 4096, maxInboxLines: 1000 })
    .volatile(),
  /**
   * Capacity maintenance (GC): the ceilings that stop a store from growing
   * without bound. Enforced automatically at the end of every Dream run and on
   * demand via `memory_gc` / `/memory gc`. Card sweeps ARCHIVE (recoverable);
   * only the archive and log prunes are irreversible, and only past these
   * ceilings.
   */
  maintenance: z
    .object({
      /** Master switch for the automatic end-of-Dream maintenance pass. */
      enabled: z.boolean().default(true),
      /**
       * Archive a live card that has not been updated for this many days when
       * its importance is at or below `staleMaxImportance`. 0 disables the
       * stale sweep. Standing kinds (preference/commitment) are exempt.
       */
      staleDays: z.natural().max(3650).default(180),
      /** Importance ceiling for the stale sweep (1–10). */
      staleMaxImportance: z.natural().min(1).max(10).default(6),
      /** Live-card ceiling per store; the lowest-value cards are archived past it. */
      maxLiveCards: z.natural().min(50).max(100000).default(2000),
      /** Archived-card ceiling per store; the OLDEST are hard-deleted past it. */
      maxArchivedCards: z.natural().max(100000).default(2000),
      /** Audit-log line ceiling per store (newest lines are kept). */
      maxAuditLines: z.natural().min(100).max(1000000).default(4000),
      /** Access-log line ceiling per store (newest lines are kept). */
      maxAccessLines: z.natural().min(100).max(1000000).default(4000),
      /** Inbox byte ceiling per store (consumed head is dropped first). */
      maxInboxBytes: z.natural().min(10000).max(100000000).default(1000000),
    })
    .default({
      enabled: true,
      staleDays: 180,
      staleMaxImportance: 6,
      maxLiveCards: 2000,
      maxArchivedCards: 2000,
      maxAuditLines: 4000,
      maxAccessLines: 4000,
      maxInboxBytes: 1000000,
    })
    .volatile(),
  /**
   * Auxiliary LLM route and per-call budget, shared by `capture.useLlm` and
   * the Dream LLM passes. Resolution per field, first non-empty wins:
   * (1) these explicit overrides, (2) the CURRENT SESSION's default model
   * (live `agent-default-model` config — the model this agent runs on),
   * (3) the shipped fallback route.
   */
  llm: z
    .object({
      /** Provider route override (empty = session model → shipped fallback). */
      provider: z.string().max(128).default(''),
      /** Model id override (empty = session model → shipped fallback). */
      model: z.string().max(128).default(''),
      /** Max output tokens per auxiliary call. 2000: field-measured
       *  extraction replies on 27B-class models run 1400–2100 tokens. */
      maxOutputTokens: z.natural().min(16).max(8000).default(2000),
      /** Per-call deadline (ms). 60s: session-model calls on long tails can
       *  exceed 30s on 27B-class models (field-observed 'skipped timeout'). */
      timeoutMs: z.natural().min(1000).max(120000).default(60000),
    })
    .default({ provider: '', model: '', maxOutputTokens: 2000, timeoutMs: 60000 })
    .volatile(),
});

/** The live Config value handed to `apply` (one immutable reference per section). */
export type MemoryConfig = Schemastery.TypeT<typeof MemorySettingsSchema>;

/** Read one volatile reference, falling back when it is absent or unreadable. */
function read<T>(ref: Volatile<T> | undefined, fallback: T): T {
  try {
    if (ref === undefined || typeof (ref as { get?: unknown }).get !== 'function') return fallback;
    return ref.get() as T;
  } catch {
    return fallback;
  }
}

/**
 * Project the live Config references into the plain value every consumer
 * takes. Sections are shallow-copied so callers never hold the runtime's
 * frozen snapshot; a reference that cannot be read degrades to its production
 * default instead of throwing into an agent turn. Never throws.
 * @param config - the resolved Config `apply` received (absent on a bare mount).
 * @returns the effective memory settings.
 */
export function readMemorySettings(config: MemoryConfig | undefined | null): MemorySettings {
  const d = defaultMemorySettings();
  if (config === undefined || config === null) return d;
  return {
    enabled: read(config.enabled, d.enabled),
    capture: { ...read(config.capture, d.capture) },
    redact: { ...read(config.redact, d.redact) },
    dream: { ...read(config.dream, d.dream) },
    brief: { ...read(config.brief, d.brief) },
    recall: { ...read(config.recall, d.recall) },
    commands: { ...read(config.commands, d.commands) },
    budget: { ...read(config.budget, d.budget) },
    maintenance: { ...read(config.maintenance, d.maintenance) },
    llm: { ...read(config.llm, d.llm) },
  };
}
