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

/** Create a directory tree (idempotent). */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
