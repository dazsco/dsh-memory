/**
 * Memory roots and project→slug mapping.
 *
 *   $DSH_HOME/memory/
 *     global/                 ← global store
 *     projects/<slug>/        ← one store per project (NEVER inside the project)
 *     projects.json           ← slug registry (path ↔ slug, first/last seen)
 *
 * Project roots are discovered by walking up from the session cwd: an
 * explicit `.dsh-memory.json` first, then a `.git` marker (the
 * dsh-agent-instructions convention), then — for non-git projects — a
 * conventional root marker such as `pyproject.toml`/`package.json`. Nothing
 * is ever written into the project directory itself.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { ensureDir, mtimeMsSafe, readJsonSafe, writeJsonAtomic } from './fsutil.ts';
import { healOrphanLock, isLockTimeout } from './lockheal.ts';
import { MemorySchema } from './schema.ts';

export function memoryRoot(): string {
  return dshHomePath('memory');
}

export function globalStoreRoot(): string {
  return join(memoryRoot(), 'global');
}

export function projectsDir(): string {
  return join(memoryRoot(), 'projects');
}

export function projectStoreRoot(slug: string): string {
  return join(projectsDir(), slug);
}

export function projectsRegistryPath(): string {
  return join(memoryRoot(), 'projects.json');
}

/** Short djb2 hash base36 (slug shortening on collision). */
export function hash36(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Deterministic filesystem-safe slug for an absolute project path.
 *
 * The slug keeps Unicode letters/digits (a Chinese project name stays
 * readable), `_`, and `-`; every other character (separators, spaces, dots,
 * `~`, `#`, …) becomes `-`. The charset is EXACTLY what {@link isValidStoreSlug}
 * accepts — the two must stay in lockstep or a store disappears from
 * {@link listProjectSlugs} (the `xuefou_actify` incident: `_` in the slug,
 * rejected by the discovery filter, 38 cards invisible).
 */
export function slugForPath(projectPath: string): string {
  const norm = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  let slug = norm.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'root';
  if (slug.length > 48) slug = `${slug.slice(0, 32)}-${hash36(slug)}`;
  return slug;
}

/**
 * Whether a directory name is a valid store slug (see {@link slugForPath}).
 * Used to filter `projects/` and to validate import bundles.
 */
export function isValidStoreSlug(slug: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(slug);
}

/**
 * Explicit project declaration: a `.dsh-memory.json` file anywhere in the
 * project marks THAT directory as the project root, even without `.git`.
 * Content is optional (`{}` works) — the file's presence is the marker.
 */
export const EXPLICIT_PROJECT_MARKER = '.dsh-memory.json';

/**
 * Conventional root markers for NON-git projects (checked only when no
 * `.git` exists anywhere in the cwd chain, nearest directory first).
 * Deliberately conservative: each must sit at a project root to count.
 * (`.dsh` is NOT a marker — the DSH home itself is a `.dsh` directory, and
 * a home-dir session must not become a "project".)
 */
export const PROJECT_ROOT_MARKERS: readonly string[] = [
  'pyproject.toml',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'setup.py',
];

async function hasEntry(dir: string, name: string): Promise<boolean> {
  try {
    await fs.access(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** Case-insensitive directory equality (Windows paths). */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '').replace(/\\/g, '/');
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/**
 * Resolve the project root for a session cwd, walking up at most 12 levels.
 *
 * Priority (deepest match wins within a phase):
 *   1. an explicit `.dsh-memory.json` — a declared root beats everything;
 *   2. the nearest `.git` (file or directory) — the original convention;
 *   3. only when NO `.git` exists anywhere in the chain: the nearest
 *      directory carrying a conventional root marker (see
 *      {@link PROJECT_ROOT_MARKERS}). The USER HOME is exempt from phase 2:
 *      a stray `package.json` in the home directory must not turn every
 *      home-based session into one giant "project".
 *
 * Returns null when nothing matches — memory then falls back to the global
 * store (the caller must say so instead of degrading silently).
 */
export async function findProjectRoot(cwd: string): Promise<string | null> {
  // Phase 1: explicit declaration, else the nearest .git.
  let firstGit: string | null = null;
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    if (await hasEntry(dir, EXPLICIT_PROJECT_MARKER)) return dir;
    if (firstGit === null && (await hasEntry(dir, '.git'))) firstGit = dir;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  if (firstGit !== null) return firstGit;
  // Phase 2: no git anywhere in the chain → nearest conventional marker.
  const home = homedir();
  dir = cwd;
  for (let i = 0; i < 12; i++) {
    if (!sameDir(dir, home)) {
      for (const marker of PROJECT_ROOT_MARKERS) {
        if (await hasEntry(dir, marker)) return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

export interface ProjectEntry {
  path: string;
  slug: string;
  firstSeen: string;
  lastSeen: string;
}

export interface ProjectsRegistry {
  schema: number;
  projects: Record<string, ProjectEntry>;
}

/**
 * In-process registry cache. `projects.json` is read on every status row and
 * every rules lookup; the file only ever changes through this module, so the
 * cached copy is authoritative and `saveProjectsRegistry` refreshes it. An
 * mtime guard still catches an external edit (or another process).
 */
let registryCache: { mtime: number; reg: ProjectsRegistry } | null = null;

export async function loadProjectsRegistry(): Promise<ProjectsRegistry> {
  const file = projectsRegistryPath();
  const mtime = (await mtimeMsSafe(file)) ?? -1;
  if (registryCache !== null && registryCache.mtime === mtime) return registryCache.reg;
  const reg = await readJsonSafe<ProjectsRegistry>(file);
  const loaded: ProjectsRegistry =
    reg && typeof reg === 'object' && reg.projects && typeof reg.projects === 'object'
      ? { schema: MemorySchema, projects: reg.projects }
      : { schema: MemorySchema, projects: {} };
  registryCache = { mtime, reg: loaded };
  return loaded;
}

export async function saveProjectsRegistry(reg: ProjectsRegistry): Promise<void> {
  const file = projectsRegistryPath();
  await writeJsonAtomic(file, reg);
  registryCache = { mtime: (await mtimeMsSafe(file)) ?? -1, reg };
}

/** Drop the in-process registry cache (tests, external edits). */
export function invalidateRegistryCache(): void {
  registryCache = null;
}

/**
 * Register a project path and return its slug, creating the store skeleton
 * on first sight. Collisions (same slug, different path) get -2, -3, …
 *
 * The whole read-modify-write runs under the registry lock (with orphan
 * recovery): without it, two processes registering colliding paths at once
 * would each read the old registry and last-writer-wins would lose the other
 * entry — splitting one project's memory across two slugs.
 */
export async function registerProjectPath(projectPath: string): Promise<{ slug: string; storeRoot: string; created: boolean }> {
  // The registry's lock sibling needs the memory root to exist (withFileLock
  // does not create parent directories).
  await ensureDir(memoryRoot());
  const lockBase = projectsRegistryPath();
  const register = async (): Promise<{ slug: string; created: boolean }> => {
    const reg = await loadProjectsRegistry();
    // Same path already registered?
    for (const entry of Object.values(reg.projects)) {
      if (entry.path === projectPath) {
        entry.lastSeen = new Date().toISOString();
        await saveProjectsRegistry(reg);
        return { slug: entry.slug, created: false };
      }
    }
    let base = slugForPath(projectPath);
    let slug = base;
    let n = 2;
    while (
      reg.projects[slug] !== undefined &&
      reg.projects[slug]!.path !== projectPath
    ) {
      slug = `${base}-${n++}`;
    }
    const now = new Date().toISOString();
    reg.projects[slug] = { path: projectPath, slug, firstSeen: now, lastSeen: now };
    await saveProjectsRegistry(reg);
    return { slug, created: true };
  };
  let slug: string;
  let created: boolean;
  try {
    ({ slug, created } = await withFileLock(lockBase, register));
  } catch (err) {
    if (isLockTimeout(err) && (await healOrphanLock(`${lockBase}.lock`))) {
      ({ slug, created } = await withFileLock(lockBase, register));
    } else {
      throw err;
    }
  }
  const storeRoot = projectStoreRoot(slug);
  await ensureStoreSkel(storeRoot);
  return { slug, storeRoot, created };
}

/** Create the fixed subdirectories of a store (idempotent). */
export async function ensureStoreSkel(storeRoot: string): Promise<void> {
  await ensureDir(join(storeRoot, 'cards'));
  await ensureDir(join(storeRoot, 'archive'));
  await ensureDir(join(storeRoot, 'dream'));
}

/** List existing project store slugs under one memory root (default: $DSH_HOME/memory). */
export async function listProjectSlugs(root?: string): Promise<string[]> {
  const dir = join(root ?? memoryRoot(), 'projects');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && isValidStoreSlug(e.name)).map((e) => e.name);
}

/** Store-level path set for one store root. */
export function storePathsFor(storeRoot: string) {
  return {
    root: storeRoot,
    cards: join(storeRoot, 'cards'),
    archive: join(storeRoot, 'archive'),
    dream: join(storeRoot, 'dream'),
    inbox: join(storeRoot, 'inbox.jsonl'),
    index: join(storeRoot, 'index.json'),
    audit: join(storeRoot, 'audit.jsonl'),
    access: join(storeRoot, 'access.jsonl'),
    state: join(storeRoot, 'dream', 'state.json'),
    lock: join(storeRoot, '.store.lock'),
  };
}
