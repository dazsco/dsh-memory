/**
 * Testing/development surface: the plugin's internal API, re-exported for the
 * node:test suite and future tooling. Not part of the composition surface —
 * the host loader only ever imports lib/index.js (`apply`).
 */
export { MEMORY_SCHEMA_VERSION, MEMORY_KINDS, MemoryPolicyError, MemoryFsError } from './types.ts';
export type { MemoryCard, CardMeta, MemoryIndex, InboxEntry, AuditEntry, DreamState, RecallHit, StatusReport } from './types.ts';

export { readTextSafe, readJsonSafe, writeJsonAtomic, appendJsonl, readJsonlLines, listFiles, mtimeMsSafe, ensureDir } from './fsutil.ts';

export { makeCardId, parseCard, serializeCard, cardDigest, cardTokenCount, cardIdFromFileName, readCardFile, writeCardFile, assertRoundTrip } from './cards.ts';

export { SECRET_PATTERNS, scanSecrets, redactPii, gateCandidate } from './redact.ts';
export type { SecretScan, PiiMode, PiiResult } from './redact.ts';

export { parseMemorySection, mergeRules, emptyRules } from './rules.ts';
export type { MemoryRules } from './rules.ts';

export { tokenize, jaccard, bm25Score, cardRecency, cardStrength, compositeScore, rankWithMmr, makeSnippet } from './retrieval.ts';
export type { ScoredCandidate } from './retrieval.ts';

export { dedupDecide, normalizeMemoryText, promotionEligible, DEDUP_THRESHOLDS } from './dedup.ts';
export type { DedupDecision, DedupAction } from './dedup.ts';

export {
  memoryRoot,
  globalStoreRoot,
  projectsDir,
  projectStoreRoot,
  projectsRegistryPath,
  slugForPath,
  hash36,
  findProjectRoot,
  loadProjectsRegistry,
  saveProjectsRegistry,
  registerProjectPath,
  ensureStoreSkel,
  listProjectSlugs,
  storePathsFor,
} from './paths.ts';
export type { ProjectEntry, ProjectsRegistry } from './paths.ts';

export { MemoryStore } from './store.ts';
export type { StoreLogger } from './store.ts';

export { MemoryCore, normalizeTags } from './core.ts';
export type { RememberInput, RecallOptions, ForgetResult } from './core.ts';

export { MemorySettingsSchema, defaultMemorySettings, MEMORY_NS } from './settings.ts';
export type { MemorySettings } from './settings.ts';

export { buildBrief } from './brief.ts';
export type { BriefOptions } from './brief.ts';

export { DreamEngine, registerDream } from './dream.ts';
export type { DreamLlm, DreamRunOptions, StoreDreamResult, DreamRunResult } from './dream.ts';

export { registerCapture, extractIntentSentences, splitSentences, stripSystemReminders } from './capture.ts';
export type { SessionLike, IntentCandidate } from './capture.ts';

export {
  callMemoryLlm,
  parseLlmMemoryLines,
  classifyLlmLine,
  CAPTURE_LLM_SYSTEM,
  buildCaptureLlmUserPrompt,
  DREAM_SUMMARIZE_SYSTEM,
  buildSummarizeUserPrompt,
  parseSummaryText,
  DREAM_CONFLICT_SYSTEM,
  buildConflictUserPrompt,
  parseConflictDecisions,
} from './llm.ts';
export type { MemoryLlmDeps, MemoryLlmService, MemoryLlmRequest, LlmResult, LlmFailReason, DreamCardLine, ConflictPair, ConflictDecision } from './llm.ts';

export { registerMemoryTools } from './tools.ts';

export { apply } from './index.ts';
