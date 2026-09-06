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
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
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
  readJsonlLinesLenient,
  readTextSafe,
  writeJsonAtomic,
} from './fsutil.ts';
import { cardDigest, cardIdFromFileName, parseCard, readCardFile, serializeCard, writeCardFile } from './cards.ts';
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

/**
 * Store-lock wait budget. The dsh-atomic-write default is 2 s, which is tight
 * for the heaviest critical section here — a full index rebuild over hundreds
 * of cards on a cold FS. A lock held by a LIVE process is never stolen either
 * way; this only widens the window before a live-holder wait gives up.
 */
const STORE_LOCK_WAIT_MS = 10_000;

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
      return await withFileLock(lockBase, op, { waitMs: STORE_LOCK_WAIT_MS });
    } catch (err) {
      if (isLockTimeout(err) && (await healOrphanLock(`${lockBase}.lock`))) {
        return await withFileLock(lockBase, op, { waitMs: STORE_LOCK_WAIT_MS });
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

  /** One warning per corrupt card file version (the dedup lives in cards.ts). */
  private cardWarn = (msg: string): void => {
    this.logger?.warn(msg);
  };

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
        const card = await readCardFile(this.paths.cards, id, this.cardWarn);
        if (card === null) continue; // unreadable/corrupt card: skip, keep the rest
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
      const card = await readCardFile(this.paths.cards, id, this.cardWarn);
      if (card === null) continue;
      out.set(id, { meta, tokens: tokenize(`${card.title}\n${card.body}`) });
    }
    return out;
  }

  // ── cards ────────────────────────────────────────────────────────────────

  /**
   * Read one card; null when absent or corrupt. `rebuild: false` callers
   * (Dream passes) batch the index refresh into a single end-of-run rebuild.
   */
  async readCard(id: string): Promise<MemoryCard | null> {
    return await readCardFile(this.paths.cards, id, this.cardWarn);
  }

  /** Atomically write one card and (by default) refresh the index. */
  async putCard(card: MemoryCard, opts?: { rebuild?: boolean }): Promise<void> {
    await this.locked(async () => {
      await writeCardFile(this.paths.cards, card);
    });
    if (opts?.rebuild !== false) await this.rebuildIndex();
  }

  /** Patch mutable fields on an existing card; null when absent or corrupt. */
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
    opts?: { rebuild?: boolean },
  ): Promise<MemoryCard | null> {
    const card = await this.locked(async () => {
      const existing = await readCardFile(this.paths.cards, id, this.cardWarn);
      if (existing === null) return null;
      Object.assign(existing, patch);
      await writeCardFile(this.paths.cards, existing);
      return existing;
    });
    // Same pattern as putCard: rebuild OUTSIDE the lock (rebuildIndex takes it).
    if (card !== null && opts?.rebuild !== false) await this.rebuildIndex();
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

  /**
   * Move an archived card back to cards/ (inverse of {@link archiveCard}).
   * False when the archive entry is absent, fails to parse, or a live card
   * already occupies the id. The move is under the store lock; the caller
   * audits and rebuilds the index.
   */
  async restoreCard(id: string): Promise<boolean> {
    return await this.locked(async () => {
      const src = join(this.paths.archive, `${id}.md`);
      const dest = join(this.paths.cards, `${id}.md`);
      const text = await readTextSafe(src);
      if (text === null) return false;
      // Never promote a corrupt or id-mismatched file back to live.
      try {
        parseCard(text, id);
      } catch (err) {
        this.logger?.warn(`[dsh-memory] ${this.slug}: archive entry ${id} will not restore: ${(err as Error).message}`);
        return false;
      }
      const destExists = await mtimeMsSafe(dest);
      if (destExists !== null) return false; // live card already owns the id
      const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write');
      await writeFileAtomic(dest, text, { mode: 0o600 });
      await fs.unlink(src);
      return true;
    });
  }

  /** One archived card row for browsing: id + archive time (file mtime), newest first. */
  async listArchived(): Promise<{ id: string; archivedAt: string }[]> {
    const names = await listFiles(this.paths.archive);
    const out: { id: string; archivedAt: string }[] = [];
    for (const name of names) {
      const id = cardIdFromFileName(name);
      if (id === null) continue;
      const mtime = await mtimeMsSafe(join(this.paths.archive, name));
      if (mtime !== null) out.push({ id, archivedAt: new Date(mtime).toISOString() });
    }
    out.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0));
    return out;
  }

  /** Read one archived card (browse view); null when absent or corrupt. */
  async readArchivedCard(id: string): Promise<MemoryCard | null> {
    return await readCardFile(this.paths.archive, id, this.cardWarn);
  }

  // ── inbox / audit / access ───────────────────────────────────────────────

  async pushInbox(entry: InboxEntry): Promise<void> {
    await appendJsonl(this.paths.inbox, [entry]);
  }

  /**
   * Read inbox entries from an offset, leniently: a malformed line (a partial
   * JSON left by a killed append) is skipped and reported by its 1-based
   * non-empty line number, so the caller can quarantine it and still advance
   * the offset past it instead of the read throwing.
   *
   * The offset counts EVERY non-empty line (good + malformed), but the lenient
   * reader returns only the parseable ones — so the slice point is the offset
   * MINUS the malformed lines at-or-before it, otherwise an already-quarantined
   * bad line would shift the parseable array and make the next good line
   * invisible to ingest.
   */
  async readInboxFrom(fromLine: number): Promise<{ entries: InboxEntry[]; malformedLines: number[] }> {
    const { entries, malformedLines } = await readJsonlLinesLenient<InboxEntry>(this.paths.inbox);
    const malformedAtOrBefore = malformedLines.filter((n) => n <= fromLine).length;
    const skip = Math.max(0, fromLine - malformedAtOrBefore);
    return { entries: entries.slice(skip), malformedLines: malformedLines.filter((n) => n > fromLine) };
  }

  async readInbox(fromLine = 0): Promise<InboxEntry[]> {
    const { entries } = await this.readInboxFrom(fromLine);
    return entries;
  }

  /**
   * Drop the first `dropLines` non-empty lines (the consumed head) so the
   * file stays bounded at `budget.maxInboxLines`. Runs under the SAME lock as
   * `pushInbox` appends, so it cannot interleave with or lose a concurrent
   * append; callers must cap the drop at the consumed offset — pending lines
   * are never dropped.
   */
  async compactInbox(dropLines: number): Promise<void> {
    if (dropLines <= 0) return;
    await this.lockedOn(this.paths.inbox, async () => {
      const text = await readTextSafe(this.paths.inbox);
      if (text === null) return;
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      if (lines.length === 0) return;
      const kept = lines.slice(dropLines);
      if (kept.length === lines.length) return;
      await writeFileAtomic(this.paths.inbox, kept.length > 0 ? kept.join('\n') + '\n' : '', { mode: 0o600 });
    });
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

  /** Lenient: a torn access-log line must not fail a whole Dream run. */
  async readAccessLog(): Promise<{ ts: string; ids: string[] }[]> {
    const { entries } = await readJsonlLinesLenient<{ ts: string; ids: string[] }>(this.paths.access);
    return entries;
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
