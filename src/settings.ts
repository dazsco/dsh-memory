/**
 * The `memory` settings namespace (live hot-reload). Every behavior knob is
 * user-configurable from the settings document or the GUI card; schema
 * defaults are the production defaults from the design plan.
 */
import z from '@deepseek-ai/schemastery';

export const MEMORY_NS = 'memory';

export const MemorySettingsSchema = z.object({
  /** Master switch: off → no capture, no injection, tools report disabled. */
  enabled: z.boolean().default(true),
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
    })
    .default({
      mode: 'auto',
      useLlm: true,
      turnTailChars: 20000,
      minTurnContentChars: 120,
      compaction: true,
      compactionMaxChars: 4000,
      heuristic: true,
    }),
  /** PII policy (the built-in secret gate is always on and cannot be configured). */
  redact: z.object({
    /** off | warn (audit only) | redact (mask in stored text). */
    pii: z.union([z.const('off'), z.const('warn'), z.const('redact')]).default('redact'),
  }).default({ pii: 'redact' }),
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
    .default({ enabled: true, useLlm: true, intervalMinutes: 30, maxLlmCalls: 40, maxWallMs: 600000, requestSeq: 0 }),
  /** Session-start memory brief. */
  brief: z
    .object({
      enabled: z.boolean().default(true),
      /** Total injected bytes cap. */
      maxBytes: z.natural().min(512).max(32768).default(4096),
      projectK: z.natural().max(50).default(12),
      globalK: z.natural().max(50).default(8),
    })
    .default({ enabled: true, maxBytes: 4096, projectK: 12, globalK: 8 }),
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
    .default({ k: 8, expandLinks: true, linkDecay: 0.5, briefIncludeSuperseded: false }),
  /** Human-facing slash-command surface (`/memory ...` in the composer). */
  commands: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  /** Write-path budgets. */
  budget: z
    .object({
      /** Max card content bytes (title+body). */
      maxCardBytes: z.natural().min(256).max(65536).default(4096),
      /** Max staged inbox lines per store. */
      maxInboxLines: z.natural().min(10).max(10000).default(1000),
    })
    .default({ maxCardBytes: 4096, maxInboxLines: 1000 }),
  /**
   * Auxiliary LLM route and per-call budget, shared by `capture.useLlm` and
   * the Dream LLM passes. Resolution per field, first non-empty wins:
   * (1) these explicit overrides, (2) the CURRENT SESSION's default model
   * (live `agent-default-model` settings — the model this agent runs on),
   * (3) the composition-row route as a last resort.
   */
  llm: z
    .object({
      /** Provider route override (empty = session model → composition route). */
      provider: z.string().max(128).default(''),
      /** Model id override (empty = session model → composition route). */
      model: z.string().max(128).default(''),
      /** Max output tokens per auxiliary call. 2000: field-measured
       *  extraction replies on 27B-class models run 1400–2100 tokens. */
      maxOutputTokens: z.natural().min(16).max(8000).default(2000),
      /** Per-call deadline (ms). 60s: session-model calls on long tails can
       *  exceed 30s on 27B-class models (field-observed 'skipped timeout'). */
      timeoutMs: z.natural().min(1000).max(120000).default(60000),
    })
    .default({ provider: '', model: '', maxOutputTokens: 2000, timeoutMs: 60000 }),
});

export type MemorySettings = Schemastery.TypeT<typeof MemorySettingsSchema>;

/** The production defaults as a plain value (tests, simulations, docs). */
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
    },
    redact: { pii: 'redact' },
    dream: { enabled: true, useLlm: true, intervalMinutes: 30, maxLlmCalls: 40, maxWallMs: 600000, requestSeq: 0 },
    brief: { enabled: true, maxBytes: 4096, projectK: 12, globalK: 8 },
    recall: { k: 8, expandLinks: true, linkDecay: 0.5, briefIncludeSuperseded: false },
    commands: { enabled: true },
    budget: { maxCardBytes: 4096, maxInboxLines: 1000 },
    llm: { provider: '', model: '', maxOutputTokens: 2000, timeoutMs: 60000 },
  };
}
