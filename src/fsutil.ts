/**
 * Filesystem primitives for the memory stores.
 *
 * All mutations go through @deepseek-ai/dsh-atomic-write so readers observe
 * either the old or the new complete content, and concurrent processes are
 * serialized with per-file locks. This is what makes multi-session writes and
 * crash-recovery safe (rename on the same filesystem, wx temp, mode on the
 * fresh inode).
 */
import { promises as fs, type Stats } from 'node:fs';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { MemoryFsError } from './types.ts';

/** Read a UTF-8 text file; ENOENT resolves to null. */
export async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** Read a JSON file; ENOENT → null; corrupt JSON throws MemoryFsError. */
export async function readJsonSafe<T>(path: string): Promise<T | null> {
  const text = await readTextSafe(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new MemoryFsError(`corrupt JSON at ${path}: ${(err as Error).message}`);
  }
}

/** Atomically write one JSON document (0600 on POSIX; parent dirs created). */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/**
 * Atomically write one JSON document WITHOUT indentation. For large derived
 * artifacts (the store index, whose `cards`/`bm25.df` objects grow with the
 * whole corpus) pretty-printing roughly doubles both the serialization CPU and
 * the bytes written/parsed — and the file is machine-only, so the readability
 * that justifies indentation elsewhere is worthless here.
 */
export async function writeJsonCompactAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value), { mode: 0o600 });
}

/**
 * Append JSONL lines under the file's lock so concurrent processes never
 * interleave or lose lines. No-op for an empty batch.
 */
export async function appendJsonl(file: string, entries: readonly object[]): Promise<void> {
  if (entries.length === 0) return;
  const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  await withFileLock(file, () => fs.appendFile(file, text, 'utf8'));
}

/** Read all JSONL lines; ENOENT → []. Malformed lines throw MemoryFsError. */
export async function readJsonlLines<T>(file: string): Promise<T[]> {
  const text = await readTextSafe(file);
  if (text === null) return [];
  const out: T[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      throw new MemoryFsError(`malformed JSONL ${file}:${i + 1}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Lenient JSONL read: ENOENT → empty; a malformed line is SKIPPED and
 * reported by its 1-based non-empty line number instead of failing the read.
 * A killed append can leave a half line (JSONL lines are newline-terminated,
 * so a torn write leaves exactly one partial line); offset-tracking callers
 * (Dream) quarantine those lines and advance past them.
 */
export async function readJsonlLinesLenient<T>(file: string): Promise<{ entries: T[]; malformedLines: number[] }> {
  const text = await readTextSafe(file);
  if (text === null) return { entries: [], malformedLines: [] };
  const entries: T[] = [];
  const malformedLines: number[] = [];
  let no = 0; // 1-based non-empty line number
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    no++;
    try {
      entries.push(JSON.parse(raw) as T);
    } catch {
      malformedLines.push(no);
    }
  }
  return { entries, malformedLines };
}

/** List file names in a directory; ENOENT → []. */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/** mtime in ms; ENOENT → null. */
export async function mtimeMsSafe(path: string): Promise<number | null> {
  try {
    const st: Stats = await fs.stat(path);
    return st.mtimeMs;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** File size in bytes; ENOENT → null. */
export async function sizeSafe(path: string): Promise<number | null> {
  try {
    const st: Stats = await fs.stat(path);
    return st.size;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** Count non-empty lines in a text buffer (the JSONL line unit). */
export function countNonEmptyLines(text: string): number {
  let n = 0;
  for (const raw of text.split('\n')) if (raw.trim() !== '') n++;
  return n;
}

/**
 * Read at most the last `maxBytes` bytes of a text file, dropping a possibly
 * truncated first line. ENOENT → ''. This is what keeps an append-only
 * diagnostic log (audit) cheap to TAIL: reading a 20 MB log to show its last
 * 50 rows would otherwise cost a full read + parse on every GUI view.
 */
export async function readTailText(path: string, maxBytes: number): Promise<string> {
  let handle: import('node:fs/promises').FileHandle | null = null;
  try {
    handle = await fs.open(path, 'r');
    const st = await handle.stat();
    const start = Math.max(0, st.size - Math.max(0, maxBytes));
    const length = st.size - start;
    if (length <= 0) return '';
    const buf = Buffer.allocUnsafe(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    // The window may begin mid-line: drop the partial head.
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } catch (err) {
    if (isEnoent(err)) return '';
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Cooperative yield: returns a function that awaits a macrotask turn at most
 * once per `budgetMs`. Long synchronous loops over the whole corpus (index
 * rebuild, Dream relink/conflict, maintenance sweeps) run on the SAME event
 * loop as the harness — without yielding, a multi-second pass reads as "dsh
 * froze". Callers `await yieldNow()` once per iteration; the budget makes the
 * common fast path free (no timer churn).
 */
export function createYielder(budgetMs = 8): () => Promise<void> {
  let last = Date.now();
  return async () => {
    const now = Date.now();
    if (now - last < budgetMs) return;
    last = now;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight, preserving the
 * result order. Bulk card I/O (index rebuild reads, batched link updates) is
 * latency-bound on per-file open/write, so a small window turns thousands of
 * sequential awaits into a handful of round trips.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/** Create a directory tree (idempotent). */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
