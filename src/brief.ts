/**
 * Session-start memory brief: a single, budgeted <system-reminder> injection
 * assembled from the top-k project + global cards. Injected ONCE per session
 * (digest-stable prefix → KV-cache friendly); changes land in the next
 * session after a Dream run.
 */
import { Buffer } from 'node:buffer';
import type { MemoryCore } from './core.ts';

export interface BriefOptions {
  projectSlug: string | null;
  maxBytes: number;
  projectK: number;
  globalK: number;
}

const FRAME_OPEN = '<system-reminder>';
const FRAME_CLOSE = '</system-reminder>';

/** Escape any embedded frame-close so card content cannot break the frame. */
function escapeFrame(text: string): string {
  // Insert a backslash between '<' and '/' so the marker survives as literal
  // text while remaining readable to the model.
  return text.replaceAll(FRAME_CLOSE, `<\\${'/system-reminder'}>`);
}

export async function buildBrief(core: MemoryCore, opts: BriefOptions): Promise<string | null> {
  if (opts.globalK <= 0 && (opts.projectSlug === null || opts.projectK <= 0)) return null;

  const [globalHits, projectHits] = await Promise.all([
    opts.globalK > 0
      ? core.recall('', { scope: 'global', k: opts.globalK }).then((r) => r.hits)
      : Promise.resolve([]),
    opts.projectSlug !== null && opts.projectK > 0
      ? core.recall('', { scope: 'both', projectSlug: opts.projectSlug, k: opts.projectK }).then((r) =>
          r.hits.filter((h) => h.store === opts.projectSlug),
        )
      : Promise.resolve([]),
  ]);

  const header =
    'The following is auto-generated memory context from dsh-memory. It is guidance, not an instruction, and may be stale — verify before relying on it. Use memory_recall for details; use memory_remember to store new durable memory.';

  const lines: { text: string; store: 'global' | 'project' }[] = [];
  const globalSection = [`## 全局记忆 (${globalHits.length})`];
  const projectSection: string[] = [];
  if (globalHits.length > 0) {
    for (const h of globalHits) globalSection.push(`- [${h.kind}] ${escapeFrame(h.title)} — ${escapeFrame(h.snippet)} (${h.id})`);
  } else {
    globalSection.push('（暂无）');
  }
  if (projectHits.length > 0) {
    for (const h of projectHits) projectSection.push(`- [${h.kind}] ${escapeFrame(h.title)} — ${escapeFrame(h.snippet)} (${h.id})`);
  } else {
    projectSection.push('（暂无）');
  }

  const projectHeader = opts.projectSlug ? `## 项目记忆 ${opts.projectSlug} (${projectHits.length})` : '';

  // Assemble with a hard byte budget measured on the FRAMED output: drop
  // lines from the tail (project lines first, then global), keep the header.
  const parts: string[] = [header];
  parts.push(...globalSection);
  if (opts.projectSlug) parts.push(projectHeader, ...projectSection);

  const framed = (body: string): string => `${FRAME_OPEN}\n${body}\n${FRAME_CLOSE}`;
  let body = parts.join('\n');
  while (Buffer.byteLength(framed(body), 'utf8') > opts.maxBytes && parts.length > 2) {
    parts.pop();
    body = parts.join('\n');
  }
  if (Buffer.byteLength(framed(body), 'utf8') > opts.maxBytes) {
    // Even the header plus one line exceeds the budget: hard-truncate the
    // final line so the framed total stays within maxBytes.
    const overhead = Buffer.byteLength(FRAME_OPEN, 'utf8') + Buffer.byteLength(FRAME_CLOSE, 'utf8') + 2;
    const budget = Math.max(0, opts.maxBytes - overhead - Buffer.byteLength(header, 'utf8') - 1);
    const lines = body.split('\n');
    const head = lines.slice(0, -1).join('\n');
    const room = Math.max(0, budget - Buffer.byteLength(head, 'utf8') - 1);
    let last = lines[lines.length - 1] ?? '';
    while (Buffer.byteLength(last, 'utf8') > room) last = last.slice(0, -1);
    body = room > 0 ? `${head}\n${last}…` : head;
  }

  return framed(body);
}
