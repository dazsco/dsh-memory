/**
 * Testing/development surface: the plugin's internal API, re-exported for the
 * node:test suite and future tooling. Not part of the composition surface —
 * the host loader only ever imports lib/index.js (`apply`).
 */
export { MEMORY_SCHEMA_VERSION, MEMORY_KINDS, MemoryPolicyError, MemoryFsError } from './types.ts';
export type {
  MemoryCard,
  CardMeta,
  MemoryIndex,
  InboxEntry,
  AuditEntry,
  AuditOp,
  AuditVia,
  DreamState,
  RecallHit,
  StatusReport,
  StoreStatus,
  StoreMaintenanceResult,
  MaintainReport,
  MemoryExportBundle,
  MemoryExportStore,
  MemoryImportResult,
  MemoryImportStoreResult,
} from './types.ts';

export {
  readTextSafe,
  readJsonSafe,
  writeJsonAtomic,
  writeJsonCompactAtomic,
  appendJsonl,
  readJsonlLines,
  readJsonlLinesLenient,
  readTailText,
  countNonEmptyLines,
  createYielder,
  listFiles,
  mtimeMsSafe,
  sizeSafe,
  ensureDir,
} from './fsutil.ts';

export {
  makeCardId,
  parseCard,
  serializeCard,
  cardDigest,
  cardTokenCount,
  cardMetaOf,
  capTerms,
  INDEX_TERMS_CAP,
  cardIdFromFileName,
  isValidCardId,
  readCardFile,
  writeCardFile,
  assertRoundTrip,
} from './cards.ts';

export { SECRET_PATTERNS, scanSecrets, redactPii, gateCandidate } from './redact.ts';
export type { SecretScan, PiiMode, PiiResult } from './redact.ts';

export { parseMemorySection, mergeRules, emptyRules } from './rules.ts';
export type { MemoryRules } from './rules.ts';

export { tokenize, jaccard, bm25Score, cardRecency, cardStrength, compositeScore, rankWithMmr, mmrPool, MMR_POOL_MIN, MMR_POOL_FACTOR, makeSnippet, expandLinks, passesFilter } from './retrieval.ts';
export type { ScoredCandidate, RecallFilter, FilterableMeta } from './retrieval.ts';

export { dedupDecide, normalizeMemoryText, DEDUP_THRESHOLDS } from './dedup.ts';
export type { DedupDecision, DedupAction } from './dedup.ts';

export {
  maintainStore,
  maintenanceLimitsFrom,
  selectMaintenance,
  cardValue,
  DEFAULT_MAINTENANCE_LIMITS,
} from './maintain.ts';
export type { MaintenanceLimits, MaintenanceSelection, MaintainStoreOptions } from './maintain.ts';

export {
  memoryRoot,
  globalStoreRoot,
  projectsDir,
  projectStoreRoot,
  projectsRegistryPath,
  slugForPath,
  hash36,
  findProjectRoot,
  isValidStoreSlug,
  EXPLICIT_PROJECT_MARKER,
  PROJECT_ROOT_MARKERS,
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

export { healOrphanLock, isLockTimeout } from './lockheal.ts';

export { MemoryCore, normalizeTags } from './core.ts';
export type { RememberInput, RecallOptions, ForgetOptions, ForgetResult, CardRef } from './core.ts';

export { MemorySettingsSchema, defaultMemorySettings, readMemorySettings, MEMORY_NS } from './settings.ts';
export type { MemorySettings, MemoryConfig, CaptureSettings, DreamSettings, BriefSettings, RecallSettings, BudgetSettings, MaintenanceSettings, LlmSettings, RedactSettings, CommandsSettings } from './settings.ts';

export { buildBrief } from './brief.ts';
export type { BriefOptions } from './brief.ts';

export { DreamEngine, registerDream, attachDreamTimers } from './dream.ts';
export type { DreamLlm, DreamRunOptions, StoreDreamResult, DreamRunResult, DreamTimers } from './dream.ts';

export { registerCapture, extractIntentSentences, splitSentences, stripSystemReminders, extractSummaryText } from './capture.ts';
export type { SessionLike, IntentCandidate } from './capture.ts';

export { registerMemoryCommands, COMMAND_DESCRIPTION, COMMAND_HINT } from './commands.ts';
export type { CommandsService, CommandsCtx, CommandInvocation } from './commands.ts';

export {
  callMemoryLlm,
  parseLlmMemoryLines,
  classifyLlmLine,
  captureSystemPrompt,
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

export { makeBrowseHandlers, registerBrowseRoutes, MEMORY_BROWSE_PATHS, MEMORY_BROWSE_ROUTES } from './browse.ts';
export type {
  MemoryBrowseDeps,
  BrowseConnection,
  BrowseCtx,
  BrowseSummary,
  BrowseStoreSummary,
  BrowseCardSummary,
  BrowseCardList,
  BrowseCardDetail,
  BrowseInbox,
  BrowseArchivedCard,
  BrowseArchiveList,
  BrowseCardActionResult,
  BrowseAuditEntry,
  BrowseAuditList,
  BrowseDreamResult,
} from './browse.ts';

export { apply, Config } from './index.ts';
