/**
 * Memory card (de)serialization.
 *
 * Cards are Markdown files with a YAML-subset frontmatter block. The subset is
 * strict and self-owned: scalar values are JSON-encoded (JSON is a valid YAML
 * flow subset), arrays/objects use JSON flow syntax. No external YAML
 * dependency, deterministic output, and parse errors fail loud.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { MemoryFsError, MEMORY_KINDS, type MemoryCard, type MemoryKind, type MemorySource } from './types.ts';
import { readTextSafe } from './fsutil.ts';
import { tokenize } from './retrieval.ts';

const FRONTMATTER_DELIM = '---';
const KEY_ORDER = [
  'id',
  'kind',
  'tags',
  'importance',
  'confidence',
  'created',
  'updated',
  'lastAccessed',
  'accessCount',
  'validSince',
  'validUntil',
  'supersedes',
  'source',
  'links',
] as const;

/** Mint a new card id: m-YYYYMMDD-<10 lowercase hex>. */
export function makeCardId(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const rand = randomBytes(5).toString('hex').slice(0, 10);
  return `m-${date}-${rand}`;
}

function assertIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new MemoryFsError(`card frontmatter: ${field} is not an ISO date: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"') || v.startsWith("'")) {
    try {
      return JSON.parse(v.startsWith("'") ? v.replace(/^'|'$/g, '"') : v);
    } catch {
      throw new MemoryFsError(`card frontmatter: bad quoted scalar: ${v}`);
    }
  }
  if (v.startsWith('[') || v.startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      throw new MemoryFsError(`card frontmatter: bad flow value: ${v}`);
    }
  }
  return v;
}

function encodeScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** Parse a card document; throws MemoryFsError on any shape violation. */
export function parseCard(text: string, expectedId?: string): MemoryCard {
  const lines = text.split('\n');
  if (lines[0] !== FRONTMATTER_DELIM) {
    throw new MemoryFsError('card: missing opening --- frontmatter delimiter');
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIM) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new MemoryFsError('card: missing closing --- frontmatter delimiter');

  const fields: Record<string, unknown> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || line.startsWith('#')) continue;
    const m = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(line);
    if (!m) throw new MemoryFsError(`card: bad frontmatter line: ${line}`);
    const key = m[1]!;
    fields[key] = m[2] === undefined ? null : parseScalar(m[2]);
  }

  const id = typeof fields.id === 'string' ? fields.id : '';
  if (!/^m-\d{8}-[a-z0-9]{4,10}$/.test(id)) {
    throw new MemoryFsError(`card: bad id: ${id}`);
  }
  if (expectedId && id !== expectedId) {
    throw new MemoryFsError(`card: id mismatch (file says ${expectedId}, frontmatter says ${id})`);
  }
  const kind = fields.kind;
  if (typeof kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(kind)) {
    throw new MemoryFsError(`card: bad kind: ${String(kind)}`);
  }
  const tags = Array.isArray(fields.tags) ? fields.tags : [];
  if (tags.some((t) => typeof t !== 'string')) throw new MemoryFsError('card: tags must be strings');
  const importance = clampInt(fields.importance, 1, 10, 5);
  const confidence = clampNum(fields.confidence, 0, 1, 0.6);
  const accessCount = clampInt(fields.accessCount, 0, 1_000_000, 0);
  const supersedes = Array.isArray(fields.supersedes) ? fields.supersedes.filter((s) => typeof s === 'string') : [];
  const links = Array.isArray(fields.links) ? fields.links.filter((s) => typeof s === 'string') : [];
  const sourceRaw = fields.source;
  const source: MemorySource =
    sourceRaw && typeof sourceRaw === 'object'
      ? {
          session: typeof (sourceRaw as MemorySource).session === 'string' ? (sourceRaw as MemorySource).session : '',
          turn: typeof (sourceRaw as MemorySource).turn === 'number' ? (sourceRaw as MemorySource).turn : null,
        }
      : { session: '', turn: null };

  const bodyLines = lines.slice(end + 1);
  // Skip leading blank lines.
  while (bodyLines.length > 0 && bodyLines[0]!.trim() === '') bodyLines.shift();
  const title = (bodyLines.shift() ?? '').trim();
  if (!title) throw new MemoryFsError('card: missing title (first body line)');
  const body = bodyLines.join('\n').trim();

  return {
    id,
    kind: kind as MemoryKind,
    tags: tags as string[],
    importance,
    confidence,
    created: assertIso(fields.created, 'created'),
    updated: assertIso(fields.updated, 'updated'),
    lastAccessed: assertIso(fields.lastAccessed, 'lastAccessed'),
    accessCount,
    validSince: assertIso(fields.validSince, 'validSince'),
    validUntil: fields.validUntil === null ? null : assertIso(fields.validUntil, 'validUntil'),
    supersedes,
    source,
    links,
    title,
    body,
  };
}

/** Serialize a card deterministically (stable key order, JSON-encoded scalars). */
export function serializeCard(card: MemoryCard): string {
  const out: string[] = [FRONTMATTER_DELIM];
  for (const key of KEY_ORDER) {
    out.push(`${key}: ${encodeScalar((card as unknown as Record<string, unknown>)[key])}`);
  }
  out.push(FRONTMATTER_DELIM, card.title);
  if (card.body) out.push('', card.body);
  return out.join('\n') + '\n';
}

/** sha1 over normalized content (title + body, frontmatter excluded). */
export function cardDigest(card: MemoryCard): string {
  return createHash('sha1').update(`${card.title}\n${card.body}`).digest('hex');
}

/** Rough token count for budgeting/index stats. */
export function cardTokenCount(card: MemoryCard): number {
  return tokenize(`${card.title}\n${card.body}`).length;
}

const CARD_FILE_RE = /^m-\d{8}-[a-z0-9]{4,10}\.md$/;

export function cardIdFromFileName(name: string): string | null {
  const m = CARD_FILE_RE.exec(name);
  return m ? name.slice(0, -3) : null;
}

/** Read + parse one card file; null when absent. */
export async function readCardFile(dir: string, id: string): Promise<MemoryCard | null> {
  const text = await readTextSafe(join(dir, `${id}.md`));
  if (text === null) return null;
  return parseCard(text, id);
}

/** Atomically write a card file (0600). */
export async function writeCardFile(dir: string, card: MemoryCard): Promise<void> {
  const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write');
  await writeFileAtomic(join(dir, `${card.id}.md`), serializeCard(card), { mode: 0o600 });
}

/** Round-trip helper (tests + repair). */
export function assertRoundTrip(card: MemoryCard): void {
  const back = parseCard(serializeCard(card), card.id);
  for (const key of KEY_ORDER) {
    const a = (card as unknown as Record<string, unknown>)[key];
    const b = (back as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new MemoryFsError(`card round-trip mismatch on ${key}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  }
  if (back.title !== card.title || back.body !== card.body) {
    throw new MemoryFsError('card round-trip mismatch on title/body');
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

export { fs as nodeFs };
