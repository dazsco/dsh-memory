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
  countNonEmptyLines,
  createYielder,
  ensureDir,
  listFiles,
  mapConcurrent,
  mtimeMsSafe,
  readJsonlLinesLenient,
  readTailText,
  readTextSafe,
  sizeSafe,
  writeJsonAtomic,
  writeJsonCompactAtomic,
} from './fsutil.ts';
import { cardDigest, cardIdFromFileName, cardMetaOf, parseCard, readCardFile, writeCardFile } from './cards.ts';
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

/**
 * Bytes of the audit log read for a tail view. The audit log is append-only
 * and unbounded between maintenance passes; parsing the whole file just to
 * render the newest rows is what made the GUI's audit pane slow. 512 KB covers
 * far more than the 500-entry cap with typical entries.
 */
const AUDIT_TAIL_BYTES = 512 * 1024;

/** Ids buffered before an access-log append is flushed (see {@link noteAccess}). */
const ACCESS_FLUSH_IDS = 64;

/** Index entries processed between cooperative event-loop yields. */
const INDEX_YIELD_EVERY = 256;

/** In-flight card file operations (latency-bound, independent per file). */
const CARD_IO_CONCURRENCY = 16;

/** Cards per batched `patchCards` lock acquisition (bounds the lock hold). */
const PATCH_BATCH_CHUNK = 256;

export class MemoryStore {
  readonly kind: 'global' | 'project';
  readonly slug: string;
  readonly paths: StorePaths;
  private indexCache: { mtime: number; index: MemoryIndex } | null = null;
  /**
   * True once a card mutation deferred its index refresh (`rebuild: false`).
   * While deferred, {@link readIndex} serves the on-disk index as-is: the
   * caller (Dream) owns the single end-of-run rebuild, and re-running the
   * disk-consistency check on every intermediate read would turn one run back
   * into O(N) rebuilds.
   */
  private indexDeferred = false;
  /** Read-only corpus derived from one index object (see {@link cardCorpus}). */
  private corpusCache: { index: MemoryIndex; corpus: Map<string, { meta: CardMeta; tokens: string[] }> } | null = null;
  /** `inboxLineCount` memo keyed by (mtime, size) — a status burst re-reads nothing. */
  private lineCountCache = new Map<string, { key: string; count: number }>();
  /**
   * Pending access ids. Recall notes are appended to `access.jsonl`, but a
   * recall is a READ: doing a lock + append per recall made the read path pay
   * write latency and left an unawaited promise racing store teardown. Ids
   * accumulate here and are flushed in one append once the batch is worth it
   * (or on Dream / store teardown).
   */
  private accessBuffer: string[] = [];
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

  /** stat with ENOENT → null (mtime + size together, for memo keys). */
  private async statOf(path: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const st = await fs.stat(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // ── index ────────────────────────────────────────────────────────────────

  /** Read the index, rebuilding it when missing or out of sync (cached by mtime). */
  async readIndex(): Promise<MemoryIndex> {
    const mtime = await mtimeMsSafe(this.paths.index);
    if (mtime !== null && this.indexCache !== null && this.indexCache.mtime === mtime) {
      return this.indexCache.index;
    }
    const onDisk = await this.tryReadIndexFile();
    if (onDisk !== null && mtime !== null) {
      // Self-heal: a card file added, removed or renamed outside this store's
      // write paths (hand edit, external tool, restored backup) must not leave
      // a phantom index. One `readdir` per cache miss is far cheaper than the
      // O(cards) rebuild it may trigger — and in-place content edits are
      // caught by the per-card digest/skip logic on the read paths.
      if (this.indexDeferred || (await this.indexMatchesDisk(onDisk))) {
        this.indexCache = { mtime, index: onDisk };
        return onDisk;
      }
      return await this.rebuildIndex();
    }
    return await this.rebuildIndex();
  }

  /** True when the set of card files on disk is exactly the index's key set. */
  private async indexMatchesDisk(index: MemoryIndex): Promise<boolean> {
    let names: string[];
    try {
      names = await listFiles(this.paths.cards);
    } catch {
      return true; // never block a read on a listing failure
    }
    let listed = 0;
    for (const name of names) {
      const id = cardIdFromFileName(name);
      if (id === null) continue;
      if (!Object.prototype.hasOwnProperty.call(index.cards, id)) return false;
      listed++;
    }
    return listed === Object.keys(index.cards).length;
  }

  private async tryReadIndexFile(): Promise<MemoryIndex | null> {
    const text = await readTextSafe(this.paths.index);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as MemoryIndex;
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.cards !== 'object') return null;
      // Schema gate: a v1 index has no persisted `terms`, so scoring from it
      // would silently degrade to empty corpora. The index is derived — fall
      // through to a rebuild instead of migrating in place.
      if (parsed.schema !== MEMORY_SCHEMA_VERSION) {
        this.logger?.info(`[dsh-memory] ${this.slug}: index schema ${String(parsed.schema)} → rebuilding (${MEMORY_SCHEMA_VERSION})`);
        return null;
      }
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
      const ids: string[] = [];
      for (const name of names) {
        const id = cardIdFromFileName(name);
        if (id !== null) ids.push(id);
      }
      // Reads are latency-bound and independent → bounded concurrency. The
      // FOLD below stays sequential in file order, so the result is identical
      // to the old one-at-a-time loop.
      const loaded = await mapConcurrent(ids, CARD_IO_CONCURRENCY, async (id) => {
        const card = await readCardFile(this.paths.cards, id, this.cardWarn);
        return card === null ? null : { id, card };
      });
      const cards: Record<string, CardMeta> = {};
      const df: Record<string, number> = {};
      let totalTokens = 0;
      const yieldNow = createYielder();
      let seen = 0;
      for (const row of loaded) {
        if (row === null) continue; // unreadable/corrupt card: skip, keep the rest
        const meta = cardMetaOf(row.card, this.paths.cards);
        totalTokens += meta.terms.length;
        for (const t of new Set(meta.terms)) df[t] = (df[t] ?? 0) + 1;
        cards[row.id] = meta;
        // A rebuild over thousands of cards is one long loop; yielding keeps
        // the harness responsive instead of freezing it for the whole pass.
        if (++seen % INDEX_YIELD_EVERY === 0) await yieldNow();
      }
      const docCount = Object.keys(cards).length;
      const index: MemoryIndex = {
        schema: MEMORY_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        cards,
        bm25: {
          docCount,
          avgDocLen: docCount === 0 ? 0 : totalTokens / docCount,
          totalTokens,
          df,
        },
      };
      await writeJsonCompactAtomic(this.paths.index, index);
      this.indexCache = { mtime: (await mtimeMsSafe(this.paths.index)) ?? 0, index };
      this.indexDeferred = false;
      return index;
    });
  }

  /**
   * The index an INCREMENTAL delta may be applied to: the in-memory cache when
   * it still matches the on-disk view, else the on-disk file — provided it was
   * written with `bm25.totalTokens` (without it the running average cannot be
   * maintained exactly) and still matches the card files on disk.
   *
   * Returns null when a full {@link rebuildIndex} is required instead.
   */
  private async indexForUpdate(): Promise<MemoryIndex | null> {
    // A deferred index is known-stale by construction (a batched mutation is
    // in flight); layering a delta on it would persist the staleness.
    if (this.indexDeferred) return null;
    const mtime = await mtimeMsSafe(this.paths.index);
    if (mtime !== null && this.indexCache !== null && this.indexCache.mtime === mtime) {
      return typeof this.indexCache.index.bm25.totalTokens === 'number' ? this.indexCache.index : null;
    }
    const onDisk = await this.tryReadIndexFile();
    if (onDisk === null) return null;
    if (typeof onDisk.bm25.totalTokens !== 'number') return null;
    // An index whose key set drifted from the card directory (hand edit,
    // external tool) must be rebuilt, never patched.
    return (await this.indexMatchesDisk(onDisk)) ? onDisk : null;
  }

  /**
   * Apply a single-card delta to index.json instead of re-reading every card.
   *
   * A full rebuild is O(cards) file reads + tokenization + a multi-MB JSON
   * write; the explicit write paths (remember / update / archive / restore /
   * forget) ran it on EVERY mutation, so a store with a few thousand cards
   * paid seconds of I/O for one new card — the cost curve that made memory
   * feel progressively slower. `meta: null` removes the id.
   *
   * Exactness: `docCount`, `totalTokens` and the per-token document frequency
   * are maintained by subtracting the previous entry and adding the new one,
   * so an incrementally maintained index is indistinguishable from a rebuild.
   * Falls back to a full rebuild whenever the base index is unusable.
   */
  async updateIndex(updates: readonly { id: string; meta: CardMeta | null }[]): Promise<void> {
    if (updates.length === 0) return;
    let needRebuild = false;
    await this.locked(async () => {
      const base = await this.indexForUpdate();
      if (base === null) {
        // Rebuild OUTSIDE this critical section: rebuildIndex takes the same
        // store lock, and withFileLock is not reentrant.
        needRebuild = true;
        return;
      }
      // IN-PLACE delta. Copying `cards` and `df` per write was O(cards +
      // vocabulary) — the dominant cost of an explicit remember once a store
      // had grown, and it scaled with the whole corpus rather than with the one
      // card that changed. The index object keeps its identity (readers already
      // iterate snapshots), so the derived corpus cache is dropped explicitly
      // instead of relying on a new object.
      const df = base.bm25.df;
      let docCount = base.bm25.docCount;
      let totalTokens = base.bm25.totalTokens ?? 0;
      for (const { id, meta } of updates) {
        const prev = base.cards[id];
        if (prev !== undefined) {
          docCount--;
          totalTokens -= prev.terms.length;
          for (const t of new Set(prev.terms)) {
            const n = (df[t] ?? 0) - 1;
            if (n <= 0) delete df[t];
            else df[t] = n;
          }
          delete base.cards[id];
        }
        if (meta !== null) {
          base.cards[id] = meta;
          docCount++;
          totalTokens += meta.terms.length;
          for (const t of new Set(meta.terms)) df[t] = (df[t] ?? 0) + 1;
        }
      }
      base.generatedAt = new Date().toISOString();
      base.bm25 = {
        docCount,
        avgDocLen: docCount === 0 ? 0 : totalTokens / docCount,
        totalTokens,
        df,
      };
      await writeJsonCompactAtomic(this.paths.index, base);
      // The cached corpus holds references to the PREVIOUS meta objects of the
      // changed cards; drop it so the next reader rebuilds from `base`.
      this.corpusCache = null;
      this.indexCache = { mtime: (await mtimeMsSafe(this.paths.index)) ?? 0, index: base };
      this.indexDeferred = false;
    });
    if (needRebuild) await this.rebuildIndex();
  }

  /** Invalidate the in-memory index cache (call after external changes). */
  invalidateIndexCache(): void {
    this.indexCache = null;
    this.indexDeferred = false;
    this.corpusCache = null;
  }

  /**
   * Defer the index refresh for a batched mutation: drop the cache but accept
   * the on-disk index as-is until the caller's single {@link rebuildIndex}.
   */
  private deferIndexCache(): void {
    this.indexCache = null;
    this.indexDeferred = true;
  }

  /**
   * The scoring corpus for a store: card metadata + token arrays straight from
   * the derived index. No card file is read here — the index is the single
   * source (v2 persists `terms`), which turns a recall/Dream scoring pass from
   * O(cards) filesystem reads into one cached JSON read.
   *
   * CACHED per index object: recall runs on every `memory_recall` and twice
   * per session brief, and rebuilding a Map of every card each time was pure
   * allocation churn on a grown store.
   *
   * The returned Map and its `meta` objects are SHARED and must be treated as
   * READ-ONLY. Callers that need to mutate metadata (Dream) use
   * {@link cardCorpusCopy}.
   */
  async cardCorpus(): Promise<Map<string, { meta: CardMeta; tokens: string[] }>> {
    const index = await this.readIndex();
    if (this.corpusCache !== null && this.corpusCache.index === index) return this.corpusCache.corpus;
    const corpus = new Map<string, { meta: CardMeta; tokens: string[] }>();
    for (const [id, meta] of Object.entries(index.cards)) {
      corpus.set(id, { meta, tokens: Array.isArray(meta.terms) ? meta.terms : [] });
    }
    this.corpusCache = { index, corpus };
    return corpus;
  }

  /**
   * A MUTABLE copy of {@link cardCorpus} for callers that patch metadata
   * in memory (Dream's run corpus). One clone per run is cheap; the read-only
   * cache stays untouched for concurrent readers.
   */
  async cardCorpusCopy(): Promise<Map<string, { meta: CardMeta; tokens: string[] }>> {
    const corpus = await this.cardCorpus();
    const copy = new Map<string, { meta: CardMeta; tokens: string[] }>();
    for (const [id, entry] of corpus) copy.set(id, { meta: { ...entry.meta }, tokens: entry.tokens });
    return copy;
  }

  // ── cards ────────────────────────────────────────────────────────────────

  /**
   * Read one card; null when absent or corrupt. `rebuild: false` callers
   * (Dream passes) batch the index refresh into a single end-of-run rebuild.
   */
  async readCard(id: string): Promise<MemoryCard | null> {
    return await readCardFile(this.paths.cards, id, this.cardWarn);
  }

  /** Atomically write one card and (by default) refresh its index entry. */
  async putCard(card: MemoryCard, opts?: { rebuild?: boolean }): Promise<void> {
    await this.locked(async () => {
      await writeCardFile(this.paths.cards, card);
    });
    if (opts?.rebuild === false) this.deferIndexCache();
    else await this.updateIndex([{ id: card.id, meta: cardMetaOf(card, this.paths.cards) }]);
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
    // Same pattern as putCard: the index update happens OUTSIDE the card lock
    // (updateIndex takes the lock itself).
    if (card === null) return null;
    if (opts?.rebuild === false) this.deferIndexCache();
    else await this.updateIndex([{ id, meta: cardMetaOf(card, this.paths.cards) }]);
    return card;
  }

  /**
   * Apply a patch to many cards in CHUNKED store-lock acquisitions. Dream's
   * relink and access-fold passes touch a large share of a grown store; one
   * lock (and one re-read) per card was the dominant cost of a run, while one
   * lock for the WHOLE batch would hold the store for the entire write phase
   * and time out a concurrent session's writes. A chunk bounds the hold to a
   * few hundred milliseconds.
   *
   * Returns how many cards were actually written.
   */
  async patchCards(
    updates: readonly {
      id: string;
      patch: Partial<Pick<MemoryCard, 'updated' | 'confidence' | 'links' | 'validUntil' | 'supersedes' | 'importance' | 'accessCount' | 'lastAccessed'>>;
    }[],
    opts?: { rebuild?: boolean },
  ): Promise<number> {
    if (updates.length === 0) return 0;
    const written: MemoryCard[] = [];
    for (let start = 0; start < updates.length; start += PATCH_BATCH_CHUNK) {
      const chunk = updates.slice(start, start + PATCH_BATCH_CHUNK);
      await this.locked(async () => {
        // The per-card read+write is latency-bound, so a small in-flight window
        // turns a chunk's sequential round trips into a few.
        const results = await mapConcurrent(chunk, CARD_IO_CONCURRENCY, async ({ id, patch }) => {
          const existing = await readCardFile(this.paths.cards, id, this.cardWarn);
          if (existing === null) return null;
          Object.assign(existing, patch);
          await writeCardFile(this.paths.cards, existing);
          return existing;
        });
        for (const card of results) if (card !== null) written.push(card);
      });
    }
    if (written.length === 0) return 0;
    if (opts?.rebuild === false) this.deferIndexCache();
    else await this.updateIndex(written.map((c) => ({ id: c.id, meta: cardMetaOf(c, this.paths.cards) })));
    return written.length;
  }

  /**
   * Move a card to archive/ (keeps the file, removes it from the index).
   * `rebuild: false` defers the index update to the caller's batched rebuild.
   */
  async archiveCard(id: string, opts?: { rebuild?: boolean }): Promise<boolean> {
    const moved = await this.locked(async () => {
      const src = join(this.paths.cards, `${id}.md`);
      const text = await readTextSafe(src);
      if (text === null) return false;
      // Same bytes, atomic into archive/, then drop the live card.
      const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write');
      await writeFileAtomic(join(this.paths.archive, `${id}.md`), text, { mode: 0o600 });
      await fs.unlink(src);
      return true;
    });
    if (!moved) return false;
    if (opts?.rebuild === false) this.deferIndexCache();
    else await this.updateIndex([{ id, meta: null }]);
    return true;
  }

  /**
   * Archive many cards in CHUNKED store-lock acquisitions (the batch form of
   * {@link archiveCard}), with ONE index update for the whole batch.
   *
   * A bulk sweep — the capacity maintenance pass over an over-cap store, or
   * Dream's retention pass — otherwise pays one lock, one file move and one
   * index update per card; on a store shedding a thousand cards that is
   * thousands of lock round trips. Returns the ids that actually moved (a
   * concurrent process may have archived some first).
   */
  async archiveCards(ids: readonly string[], opts?: { rebuild?: boolean }): Promise<string[]> {
    if (ids.length === 0) return [];
    const moved: string[] = [];
    const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write');
    for (let start = 0; start < ids.length; start += PATCH_BATCH_CHUNK) {
      const chunk = ids.slice(start, start + PATCH_BATCH_CHUNK);
      await this.locked(async () => {
        const results = await mapConcurrent(chunk, CARD_IO_CONCURRENCY, async (id) => {
          const src = join(this.paths.cards, `${id}.md`);
          const text = await readTextSafe(src);
          if (text === null) return null;
          // Same bytes, atomic into archive/, then drop the live card.
          await writeFileAtomic(join(this.paths.archive, `${id}.md`), text, { mode: 0o600 });
          await fs.unlink(src);
          return id;
        });
        for (const id of results) if (id !== null) moved.push(id);
      });
    }
    if (moved.length === 0) return moved;
    if (opts?.rebuild === false) this.deferIndexCache();
    else await this.updateIndex(moved.map((id) => ({ id, meta: null })));
    return moved;
  }

  async deleteCardHard(id: string, opts?: { rebuild?: boolean }): Promise<boolean> {
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
    if (!deleted) return false;
    if (opts?.rebuild === false) this.deferIndexCache();
    else await this.updateIndex([{ id, meta: null }]);
    return true;
  }

  /**
   * Move an archived card back to cards/ (inverse of {@link archiveCard}).
   * False when the archive entry is absent, fails to parse, or a live card
   * already occupies the id. The move is under the store lock; the index entry
   * is restored by default (`rebuild: false` defers it).
   */
  async restoreCard(id: string, opts?: { rebuild?: boolean }): Promise<boolean> {
    const restored = await this.locked(async () => {
      const src = join(this.paths.archive, `${id}.md`);
      const dest = join(this.paths.cards, `${id}.md`);
      const text = await readTextSafe(src);
      if (text === null) return null;
      // Never promote a corrupt or id-mismatched file back to live.
      let card: MemoryCard;
      try {
        card = parseCard(text, id);
      } catch (err) {
        this.logger?.warn(`[dsh-memory] ${this.slug}: archive entry ${id} will not restore: ${(err as Error).message}`);
        return null;
      }
      const destExists = await mtimeMsSafe(dest);
      if (destExists !== null) return null; // live card already owns the id
      const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write');
      await writeFileAtomic(dest, text, { mode: 0o600 });
      await fs.unlink(src);
      return card;
    });
    if (restored === null) return false;
    if (opts?.rebuild === false) this.deferIndexCache();
    else await this.updateIndex([{ id, meta: cardMetaOf(restored, this.paths.cards) }]);
    return true;
  }

  /** One archived card row for browsing: id + archive time (file mtime) + size, newest first. */
  async listArchived(): Promise<{ id: string; archivedAt: string; bytes: number }[]> {
    const names = await listFiles(this.paths.archive);
    const out: { id: string; archivedAt: string; bytes: number }[] = [];
    for (const name of names) {
      const id = cardIdFromFileName(name);
      if (id === null) continue;
      const st = await this.statOf(join(this.paths.archive, name));
      if (st !== null) out.push({ id, archivedAt: new Date(st.mtimeMs).toISOString(), bytes: st.size });
    }
    out.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0));
    return out;
  }

  /** Read one archived card (browse view); null when absent or corrupt. */
  async readArchivedCard(id: string): Promise<MemoryCard | null> {
    return await readCardFile(this.paths.archive, id, this.cardWarn);
  }

  /**
   * Bitemporal supersede: stamp `validUntil` and the `supersededBy` back-link
   * on one card in a single atomic write. The file stays on disk (history is
   * never destroyed by a correction) and the card drops out of recall, the
   * brief, and Dream scoring because every read path filters
   * `validUntil !== null`. Returns the updated card, or null when the target
   * is absent/corrupt.
   */
  async supersedeCard(id: string, byId: string, at: string, opts?: { rebuild?: boolean }): Promise<MemoryCard | null> {
    const card = await this.locked(async () => {
      const existing = await readCardFile(this.paths.cards, id, this.cardWarn);
      if (existing === null) return null;
      existing.validUntil = existing.validUntil ?? at;
      existing.supersededBy = byId;
      existing.updated = at;
      await writeCardFile(this.paths.cards, existing);
      return existing;
    });
    if (card === null) return null;
    if (opts?.rebuild === false) this.deferIndexCache();
    else await this.updateIndex([{ id, meta: cardMetaOf(card, this.paths.cards) }]);
    return card;
  }

  /**
   * One import row: write the card only when the id is free (added) or the
   * stored content differs (replaced). Identical content is a no-op so a
   * re-import of the same bundle is idempotent.
   */
  async importCard(card: MemoryCard): Promise<'added' | 'replaced' | 'skipped'> {
    const existing = await readCardFile(this.paths.cards, card.id, this.cardWarn);
    if (existing !== null && cardDigest(existing) === cardDigest(card)) return 'skipped';
    await this.putCard(card, { rebuild: false });
    return existing === null ? 'added' : 'replaced';
  }

  /** Every live card with full content (export / maintenance paths). */
  async readAllCards(): Promise<MemoryCard[]> {
    const out = await this.readAllFrom(this.paths.cards);
    out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
    return out;
  }

  /** Every archived card with full content (export path). */
  async readAllArchived(): Promise<MemoryCard[]> {
    return await this.readAllFrom(this.paths.archive);
  }

  /** Bounded-concurrency read of every card file in one directory. */
  private async readAllFrom(dir: string): Promise<MemoryCard[]> {
    const names = await listFiles(dir);
    const ids: string[] = [];
    for (const name of names) {
      const id = cardIdFromFileName(name);
      if (id !== null) ids.push(id);
    }
    const loaded = await mapConcurrent(ids, CARD_IO_CONCURRENCY, (id) => readCardFile(dir, id, this.cardWarn));
    return loaded.filter((card): card is MemoryCard => card !== null);
  }

  /**
   * Derived store shape for status/stats: live kind histogram, most frequent
   * tags, live/superseded split, and content bytes. Reads ONLY the cached
   * index plus the archive directory listing — no card file is opened.
   */
  async stats(): Promise<{
    cards: number;
    superseded: number;
    archived: number;
    bytes: number;
    kinds: Partial<Record<import('./types.ts').MemoryKind, number>>;
    topTags: { tag: string; count: number }[];
  }> {
    const index = await this.readIndex().catch(() => null);
    const kinds: Partial<Record<import('./types.ts').MemoryKind, number>> = {};
    const tagCounts = new Map<string, number>();
    let superseded = 0;
    let bytes = 0;
    let cards = 0;
    if (index !== null) {
      for (const meta of Object.values(index.cards)) {
        cards++;
        bytes += typeof meta.bytes === 'number' ? meta.bytes : 0;
        if (meta.validUntil !== null) {
          superseded++;
          continue;
        }
        kinds[meta.kind] = (kinds[meta.kind] ?? 0) + 1;
        for (const tag of meta.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const archivedNames = await listFiles(this.paths.archive).catch(() => []);
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));
    return {
      cards,
      superseded,
      archived: archivedNames.filter((n) => cardIdFromFileName(n) !== null).length,
      bytes,
      kinds,
      topTags,
    };
  }

  // ── inbox / audit / access ───────────────────────────────────────────────

  async pushInbox(entry: InboxEntry): Promise<void> {
    await appendJsonl(this.paths.inbox, [entry]);
    this.lineCountCache.delete(this.paths.inbox);
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
      this.lineCountCache.delete(this.paths.inbox);
    });
  }

  /**
   * Non-empty line count, memoized by (mtime, size). `isDirty()` asks every
   * store on every 60 s tick and `status()` asks on every GUI view; without the
   * memo each of those re-read the whole inbox file.
   */
  async inboxLineCount(): Promise<number> {
    return await this.lineCount(this.paths.inbox);
  }

  /** Non-empty audit line count (memoized) — drives the maintenance budget. */
  async auditLineCount(): Promise<number> {
    return await this.lineCount(this.paths.audit);
  }

  /** Non-empty access-log line count (memoized) — drives the maintenance budget. */
  async accessLineCount(): Promise<number> {
    return await this.lineCount(this.paths.access);
  }

  private async lineCount(path: string): Promise<number> {
    const st = await this.statOf(path);
    const key = st === null ? '-' : `${st.mtimeMs}:${st.size}`;
    const cached = this.lineCountCache.get(path);
    if (cached !== undefined && cached.key === key) return cached.count;
    const text = await readTextSafe(path);
    const count = text === null ? 0 : countNonEmptyLines(text);
    this.lineCountCache.set(path, { key, count });
    return count;
  }

  /** Inbox file size in bytes (0 when absent) — the byte-budget half of compaction. */
  async inboxBytes(): Promise<number> {
    return (await sizeSafe(this.paths.inbox)) ?? 0;
  }

  async audit(entry: AuditEntry): Promise<void> {
    await appendJsonl(this.paths.audit, [entry]);
  }

  /**
   * Append a batch of audit entries in ONE locked write. A bulk sweep emits one
   * entry per card; appending them individually took a file lock each time.
   */
  async auditMany(entries: readonly AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await appendJsonl(this.paths.audit, entries);
  }

  /**
   * The most recent `limit` audit entries, newest first. Reads only the tail of
   * the file (see {@link readTailText}): the audit log is append-only and can
   * grow to megabytes, and parsing all of it to render 50 rows was pure waste.
   * Lenient: a torn line is skipped (the audit log is a diagnostic surface,
   * never a hard failure path).
   */
  async readAuditTail(limit = 50): Promise<AuditEntry[]> {
    const n = Math.max(1, Math.min(500, limit));
    const text = await readTailText(this.paths.audit, AUDIT_TAIL_BYTES);
    if (text === '') return [];
    const entries: AuditEntry[] = [];
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue;
      try {
        entries.push(JSON.parse(raw) as AuditEntry);
      } catch {
        // torn/partial line: skip
      }
    }
    return entries.slice(Math.max(0, entries.length - n)).reverse();
  }

  /**
   * Keep only the newest `maxLines` audit entries. Returns how many lines and
   * bytes were reclaimed (0 when already within budget).
   */
  async compactAudit(maxLines: number): Promise<{ dropped: number; bytes: number }> {
    const { entries } = await readJsonlLinesLenient<AuditEntry>(this.paths.audit);
    if (entries.length <= maxLines) return { dropped: 0, bytes: 0 };
    const keep = entries.slice(entries.length - maxLines);
    const before = (await sizeSafe(this.paths.audit)) ?? 0;
    await this.lockedOn(this.paths.audit, () =>
      writeFileAtomic(this.paths.audit, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length > 0 ? '\n' : ''), { mode: 0o600 }),
    );
    const after = (await sizeSafe(this.paths.audit)) ?? 0;
    return { dropped: entries.length - keep.length, bytes: Math.max(0, before - after) };
  }

  /**
   * Cheap recall counter: buffer ids; Dream folds them into card counters. The
   * buffer is flushed in one append once it holds ACCESS_FLUSH_IDS ids, so a
   * recall no longer pays a file lock + append (and no longer leaves an
   * unawaited write racing store teardown).
   */
  async noteAccess(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) this.accessBuffer.push(id);
    if (this.accessBuffer.length >= ACCESS_FLUSH_IDS) await this.flushAccess();
  }

  /** Write the buffered access ids to the log now (no-op when empty). */
  async flushAccess(): Promise<void> {
    if (this.accessBuffer.length === 0) return;
    const ids = this.accessBuffer;
    this.accessBuffer = [];
    await appendJsonl(this.paths.access, [{ ts: new Date().toISOString(), ids }]);
  }

  /** Lenient: a torn access-log line must not fail a whole Dream run. */
  async readAccessLog(): Promise<{ ts: string; ids: string[] }[]> {
    const { entries } = await readJsonlLinesLenient<{ ts: string; ids: string[] }>(this.paths.access);
    return entries;
  }

  /** Truncate the access log (Dream consumes it). Buffered ids go with it. */
  async clearAccessLog(): Promise<void> {
    this.accessBuffer = [];
    await this.lockedOn(this.paths.access, () => fs.writeFile(this.paths.access, '', 'utf8'));
  }

  /** Keep only the newest `maxLines` access-log entries (bytes reclaimed reported). */
  async compactAccess(maxLines: number): Promise<{ dropped: number; bytes: number }> {
    const { entries } = await readJsonlLinesLenient<{ ts: string; ids: string[] }>(this.paths.access);
    if (entries.length <= maxLines) return { dropped: 0, bytes: 0 };
    const keep = entries.slice(entries.length - maxLines);
    const before = (await sizeSafe(this.paths.access)) ?? 0;
    await this.lockedOn(this.paths.access, () =>
      writeFileAtomic(this.paths.access, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length > 0 ? '\n' : ''), { mode: 0o600 }),
    );
    const after = (await sizeSafe(this.paths.access)) ?? 0;
    return { dropped: entries.length - keep.length, bytes: Math.max(0, before - after) };
  }

  /**
   * Hard-delete the OLDEST archived cards beyond `maxCards`. The archive holds
   * cards the user explicitly forgot; without a cap it grows forever and every
   * archive listing / export walks it. Superseded cards are NOT here — they
   * stay in `cards/` as history (bitemporal), so pruning never touches the
   * supersede chain.
   */
  async pruneArchived(maxCards: number): Promise<{ pruned: number; bytes: number }> {
    const names = (await listFiles(this.paths.archive)).filter((n) => cardIdFromFileName(n) !== null);
    if (names.length <= maxCards) return { pruned: 0, bytes: 0 };
    const rows: { name: string; mtimeMs: number; size: number }[] = [];
    for (const name of names) {
      const st = await this.statOf(join(this.paths.archive, name));
      if (st !== null) rows.push({ name, mtimeMs: st.mtimeMs, size: st.size });
    }
    rows.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = rows.slice(0, Math.max(0, rows.length - maxCards));
    let bytes = 0;
    for (const row of excess) {
      try {
        await fs.unlink(join(this.paths.archive, row.name));
        bytes += row.size;
      } catch {
        // already gone / locked: leave it for the next pass
      }
    }
    return { pruned: excess.length, bytes };
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
      return { ...EMPTY_STATE, ...parsed, schema: MEMORY_SCHEMA_VERSION, stats: { ...EMPTY_STATE.stats, ...(parsed.stats ?? {}) } };
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
