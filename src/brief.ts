/**
 * Session-start memory brief: a single, budgeted <system-reminder> injection
 * assembled from the top-k project + global cards. Injected ONCE per session
 * (digest-stable prefix → KV-cache friendly); changes land in the next
 * session after a Dream run.
 */
import { Buffer } from 'node:buffer';
import type { MemoryCore } from './core.ts';
import type { RecallHit } from './types.ts';

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

  const formatLine = (h: RecallHit): string => {
    // One-line cards: makeSnippet returns '' when the body duplicates the
    // title, so render the title once instead of repeating it.
    const mid = h.snippet ? ` — ${escapeFrame(h.snippet)}` : '';
    return `- [${h.kind}] ${escapeFrame(h.title)}${mid} (${h.id})`;
  };

  const gLines: string[] = globalHits.map(formatLine);
  const pLines: string[] = projectHits.map(formatLine);

  const render = (): string[] => {
    const parts: string[] = [header];
    if (gLines.length > 0) {
      parts.push(`## 全局记忆 (${gLines.length})`, ...gLines);
    } else if (globalHits.length === 0) {
      parts.push('## 全局记忆 (0)', '（暂无）');
    }
    if (opts.projectSlug) {
      if (pLines.length > 0) {
        parts.push(`## 项目记忆 ${opts.projectSlug} (${pLines.length})`, ...pLines);
      } else if (projectHits.length === 0) {
        parts.push(`## 项目记忆 ${opts.projectSlug} (0)`, '（暂无）');
      }
      // A section whose lines were ALL budget-dropped is omitted entirely:
      // a bare header with a stale "(8)" count reads as "injected but empty".
    }
    return parts;
  };

  const framed = (parts: string[]): string => `${FRAME_OPEN}\n${parts.join('\n')}\n${FRAME_CLOSE}`;
  const over = (parts: string[]): boolean => Buffer.byteLength(framed(parts), 'utf8') > opts.maxBytes;

  // Hard byte budget measured on the FRAMED output. When over budget,
  // sacrifice GLOBAL lines first (lowest ranked first), then project lines:
  // in a project session the project's own memory is the primary context and
  // must not be squeezed out by a bloated global section.
  let parts = render();
  while (over(parts) && gLines.length > 0) {
    gLines.pop();
    parts = render();
  }
  while (over(parts) && pLines.length > 0) {
    pLines.pop();
    parts = render();
  }

  return framed(parts);
}
