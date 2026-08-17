/**
 * Memory roots and project→slug mapping.
 *
 *   $DSH_HOME/memory/
 *     global/                 ← global store
 *     projects/<slug>/        ← one store per project (NEVER inside the project)
 *     projects.json           ← slug registry (path ↔ slug, first/last seen)
 *
 * Project roots are discovered the same way dsh-agent-instructions does:
 * walk up from the session cwd looking for a `.git` marker. Nothing is ever
 * written into the project directory itself.
 */
import { promises as fs } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { ensureDir, readJsonSafe, writeJsonAtomic } from './fsutil.ts';
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

/** Deterministic filesystem-safe slug for an absolute project path. */
export function slugForPath(projectPath: string): string {
  const norm = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  let slug = norm.replace(/[\\/:*?"<>|.\s]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'root';
  if (slug.length > 48) slug = `${slug.slice(0, 32)}-${hash36(slug)}`;
  return slug;
}

/** Walk up from cwd to the nearest directory containing `.git`. Null when none. */
export async function findProjectRoot(cwd: string): Promise<string | null> {
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    try {
      await fs.access(join(dir, '.git'));
      return dir;
    } catch {
      // not here; walk up
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

export async function loadProjectsRegistry(): Promise<ProjectsRegistry> {
  const reg = await readJsonSafe<ProjectsRegistry>(projectsRegistryPath());
  if (reg && typeof reg === 'object' && reg.schema === MemorySchema && reg.projects) return reg;
  return { schema: MemorySchema, projects: {} };
}

export async function saveProjectsRegistry(reg: ProjectsRegistry): Promise<void> {
  await writeJsonAtomic(projectsRegistryPath(), reg);
}

/**
 * Register a project path and return its slug, creating the store skeleton
 * on first sight. Collisions (same slug, different path) get -2, -3, …
 */
export async function registerProjectPath(projectPath: string): Promise<{ slug: string; storeRoot: string; created: boolean }> {
  const reg = await loadProjectsRegistry();
  // Same path already registered?
  for (const entry of Object.values(reg.projects)) {
    if (entry.path === projectPath) {
      entry.lastSeen = new Date().toISOString();
      await saveProjectsRegistry(reg);
      await ensureStoreSkel(projectStoreRoot(entry.slug));
      return { slug: entry.slug, storeRoot: projectStoreRoot(entry.slug), created: false };
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
  const storeRoot = projectStoreRoot(slug);
  await ensureStoreSkel(storeRoot);
  return { slug, storeRoot, created: true };
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
  return entries.filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/i.test(e.name)).map((e) => e.name);
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

export const SEP = sep;
