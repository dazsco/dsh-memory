/**
 * The memory store: one directory tree (global or one project) holding cards,
 * archive, inbox, index, audit, access counters, and dream state.
 *
 * Concurrency model:
 *  - card files: atomic replacement (rename) — readers see old or new whole;
 *  - inbox/audit/access: append-only JSONL under a per-file lock — no lost
 *    lines under concurrent processes;
 *  - index.json: a derived artifact rebuilt under the store lock;
 *  - recall is lock-free (reads cached index + card files).
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { healOrphanLock, isLockTimeout } from './lockheal.ts';
import type {
  AuditEntry,
  CardMeta,
  DreamState,
  InboxEntry,
  MemoryCard,
  MemoryIndex,
  StorePaths,
} from './types.ts';
import { MEMORY_SCHEMA_VERSION } from './types.ts';
import {
  appendJsonl,
  ensureDir,
  listFiles,
  mtimeMsSafe,
  readJsonlLines,
  readTextSafe,
  writeJsonAtomic,
} from './fsutil.ts';
import { cardDigest, cardIdFromFileName, cardTokenCount, readCardFile, serializeCard, writeCardFile } from './cards.ts';
import { tokenize } from './retrieval.ts';

export interface StoreLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const EMPTY_STATE: DreamState = {
  schema: MEMORY_SCHEMA_VERSION,
  inboxOffset: 0,
  lastRun: null,
  lastResult: null,
  stats: { runs: 0, added: 0, updated: 0, archived: 0, blocked: 0 },
};

export class MemoryStore {
  readonly kind: 'global' | 'project';
  readonly slug: string;
  readonly paths: StorePaths;
  private indexCache: { mtime: number; index: MemoryIndex } | null = null;
  private logger: StoreLogger | null;

  constructor(
    kind: 'global' | 'project',
    slug: string,
    paths: StorePaths,
    logger?: StoreLogger | null,
  ) {
    this.kind = kind;
    this.slug = slug;
    this.paths = paths;
    this.logger = logger ?? null;
  }

  /** Create the store skeleton (idempotent). */
  async init(): Promise<void> {
    await ensureDir(this.paths.cards);
    await ensureDir(this.paths.archive);
    await ensureDir(this.paths.dream);
  }

  /**
   * Run `op` under a writer lock with orphan recovery: on a lock timeout,
   * if the blocking lock belongs to a dead process (provably orphaned),
   * remove it and retry once. A lock held by a live process still times
   * out as before (no stealing).
   */
  private async lockedOn<T>(lockBase: string, op: () => Promise<T>): Promise<T> {
    try {
      return await withFileLock(lockBase, op);
    } catch (err) {
      if (isLockTimeout(err) && (await healOrphanLock(`${lockBase}.lock`))) {
        return await withFileLock(lockBase, op);
      }
      throw err;
    }
  }

  /** Store-card writes: the per-store lock with orphan recovery. */
  private locked<T>(op: () => Promise<T>): Promise<T> {
    return this.lockedOn(this.paths.lock, op);
  }

  // ── index ────────────────────────────────────────────────────────────────

  /** Read the index, rebuilding it when missing (cached by mtime). */
  async readIndex(): Promise<MemoryIndex> {
    const mtime = await mtimeMsSafe(this.paths.index);
    if (mtime !== null && this.indexCache !== null && this.indexCache.mtime === mtime) {
      return this.indexCache.index;
    }
    const onDisk = await this.tryReadIndexFile();
    if (onDisk !== null && mtime !== null) {
      this.indexCache = { mtime, index: onDisk };
      return onDisk;
    }
    return await this.rebuildIndex();
  }

  private async tryReadIndexFile(): Promise<MemoryIndex | null> {
    const text = await readTextSafe(this.paths.index);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as MemoryIndex;
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.cards !== 'object') return null;
      return parsed;
    } catch (err) {
      this.logger?.warn(`[dsh-memory] ${this.slug}: corrupt index, rebuilding: ${(err as Error).message}`);
      return null;
    }
  }

  /** Rebuild index.json from the card files (under the store lock). */
  async rebuildIndex(): Promise<MemoryIndex> {
    return await this.locked(async () => {
      const names = await listFiles(this.paths.cards);
      const cards: Record<string, CardMeta> = {};
      const df: Record<string, number> = {};
      let totalTokens = 0;
      for (const name of names) {
        const id = cardIdFromFileName(name);
        if (id === null) continue;
        const card = await readCardFile(this.paths.cards, id);
        if (card === null) continue; // unreadable card: skip, keep the rest
        const tokens = tokenize(`${card.title}\n${card.body}`);
        totalTokens += tokens.length;
        for (const t of new Set(tokens)) df[t] = (df[t] ?? 0) + 1;
        cards[id] = {
          path: join(this.paths.cards, `${id}.md`),
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
          digest: cardDigest(card),
          tokens: tokens.length,
        };
      }
      const index: MemoryIndex = {
        schema: MEMORY_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        cards,
        bm25: {
          docCount: Object.keys(cards).length,
          avgDocLen: Object.keys(cards).length === 0 ? 0 : totalTokens / Object.keys(cards).length,
          df,
        },
      };
      await writeJsonAtomic(this.paths.index, index);
      this.indexCache = { mtime: (await mtimeMsSafe(this.paths.index)) ?? 0, index };
      return index;
    });
  }

  /** Invalidate the in-memory index cache (call after external changes). */
  invalidateIndexCache(): void {
    this.indexCache = null;
  }

  /** All card metadata + tokens, for scoring passes. */
  async cardCorpus(): Promise<Map<string, { meta: CardMeta; tokens: string[] }>> {
    const index = await this.readIndex();
    const out = new Map<string, { meta: CardMeta; tokens: string[] }>();
    for (const [id, meta] of Object.entries(index.cards)) {
      const card = await readCardFile(this.paths.cards, id);
      if (card === null) continue;
      out.set(id, { meta, tokens: tokenize(`${card.title}\n${card.body}`) });
    }
    return out;
  }

  // ── cards ────────────────────────────────────────────────────────────────

  async readCard(id: string): Promise<MemoryCard | null> {
    return await readCardFile(this.paths.cards, id);
  }

  /** Atomically write one card and refresh the index. */
  async putCard(card: MemoryCard): Promise<void> {
    await this.locked(async () => {
      await writeCardFile(this.paths.cards, card);
    });
    await this.rebuildIndex();
  }

  /** Patch mutable fields on an existing card; null when absent. */
  async patchCard(
    id: string,
    patch: Partial<
      Pick<
        MemoryCard,
        | 'updated'
        | 'confidence'
        | 'links'
        | 'validUntil'
        | 'supersedes'
        | 'importance'
        | 'accessCount'
        | 'lastAccessed'
      >
    >,
  ): Promise<MemoryCard | null> {
    const card = await this.locked(async () => {
      const existing = await readCardFile(this.paths.cards, id);
      if (existing === null) return null;
      Object.assign(existing, patch);
      await writeCardFile(this.paths.cards, existing);
      return existing;
    });
    // Same pattern as putCard: rebuild OUTSIDE the lock (rebuildIndex takes it).
    if (card !== null) await this.rebuildIndex();
    return card;
  }

  /** Move a card to archive/ (keeps the file, removes it from the index). */
  async archiveCard(id: string): Promise<boolean> {
    return await this.locked(async () => {
      const src = join(this.paths.cards, `${id}.md`);
      const text = await readTextSafe(src);
      if (text === null) return false;
      // Same bytes, atomic into archive/, then drop the live card.
      const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write');
      await writeFileAtomic(join(this.paths.archive, `${id}.md`), text, { mode: 0o600 });
      await fs.unlink(src);
      return true;
    });
  }

  async deleteCardHard(id: string): Promise<boolean> {
    const deleted = await this.locked(async () => {
      const src = join(this.paths.cards, `${id}.md`);
      try {
        await fs.unlink(src);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    });
    return deleted;
  }

  // ── inbox / audit / access ───────────────────────────────────────────────

  async pushInbox(entry: InboxEntry): Promise<void> {
    await appendJsonl(this.paths.inbox, [entry]);
  }

  async readInbox(fromLine = 0): Promise<InboxEntry[]> {
    const all = await readJsonlLines<InboxEntry>(this.paths.inbox);
    return all.slice(fromLine);
  }

  async inboxLineCount(): Promise<number> {
    const text = await readTextSafe(this.paths.inbox);
    if (text === null) return 0;
    return text.split('\n').filter((l) => l.trim() !== '').length;
  }

  async audit(entry: AuditEntry): Promise<void> {
    await appendJsonl(this.paths.audit, [entry]);
  }

  /** Cheap recall counter: append ids; Dream folds them into cards. */
  async noteAccess(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await appendJsonl(this.paths.access, [{ ts: new Date().toISOString(), ids }]);
  }

  async readAccessLog(): Promise<{ ts: string; ids: string[] }[]> {
    return await readJsonlLines<{ ts: string; ids: string[] }>(this.paths.access);
  }

  /** Truncate the access log (Dream consumes it). */
  async clearAccessLog(): Promise<void> {
    await this.lockedOn(this.paths.access, () => fs.writeFile(this.paths.access, '', 'utf8'));
  }

  // ── dream state ──────────────────────────────────────────────────────────

  async readState(): Promise<DreamState> {
    const text = await readTextSafe(this.paths.state);
    if (text === null) return { ...EMPTY_STATE, stats: { ...EMPTY_STATE.stats } };
    try {
      const parsed = JSON.parse(text) as DreamState;
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.inboxOffset !== 'number') {
        return { ...EMPTY_STATE, stats: { ...EMPTY_STATE.stats } };
      }
      return { ...EMPTY_STATE, ...parsed, stats: { ...EMPTY_STATE.stats, ...(parsed.stats ?? {}) } };
    } catch {
      return { ...EMPTY_STATE, stats: { ...EMPTY_STATE.stats } };
    }
  }

  async writeState(state: DreamState): Promise<void> {
    await writeJsonAtomic(this.paths.state, state);
  }

  async archivedCount(): Promise<number> {
    return (await listFiles(this.paths.archive)).length;
  }

  log(msg: string): void {
    this.logger?.info(msg);
  }
}
