/**
 * Memory rules live in the industry-standard AGENTS.md files (user-global
 * $DSH_HOME/AGENTS.md + project AGENTS.md), inside a `## Memory` section. The
 * agent already reads those files via dsh-agent-instructions, so rules are
 * visible to the model and enforceable by the plugin from ONE source of truth.
 *
 * Built-in secrecy (the redact.ts credential gate) is ALWAYS on and cannot be
 * disabled or overridden by any rules file — rules can only add deny keywords.
 */
import type { MemoryKind } from './types.ts';
import { MEMORY_KINDS } from './types.ts';

export interface MemoryRules {
  /** From "never remember" bullets: substring deny rules (case-insensitive). */
  denyKeywords: string[];
  /** From "always remember" bullets: soft guidance (LLM-facing). */
  alwaysNotes: string[];
  /** Retention days per kind ("retention" section, e.g. `- observation: 30 天`). */
  retention: Partial<Record<MemoryKind, number>>;
  /** Sessions of corroboration required for project→global promotion. */
  promoteSessions: number | null;
  /** Other free-form lines in the Memory section (LLM-facing guidance). */
  notes: string[];
}

export function emptyRules(): MemoryRules {
  return { denyKeywords: [], alwaysNotes: [], retention: {}, promoteSessions: null, notes: [] };
}

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*)$/;

interface SectionRef {
  level: number;
  title: string;
}

/** Extract the Memory section of one AGENTS.md-style document. */
export function parseMemorySection(markdown: string): MemoryRules | null {
  const lines = markdown.split('\n');
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]!);
    if (!m) continue;
    const title = m[2]!.trim();
    if (/^(memory|记忆)\s*[:：]?\s*(rules?|规则)?\s*$/i.test(title)) {
      start = i;
      startLevel = m[1]!.length;
      break;
    }
  }
  if (start < 0) return null;

  // Section end: next heading with level <= startLevel.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]!);
    if (m && m[1]!.length <= startLevel) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);

  const rules = emptyRules();
  let bucket: 'deny' | 'always' | 'retention' | 'promotion' | 'notes' | null = null;
  for (const line of body) {
    const h = HEADING_RE.exec(line);
    if (h) {
      const t = h[2]!.trim().toLowerCase();
      if (/^(never|永远不记|禁止|不要记|不记|do not remember)/.test(t)) bucket = 'deny';
      else if (/^(always|总是|记住|应该记|remember)/.test(t)) bucket = 'always';
      else if (/^(retention|保留|保留期|过期)/.test(t)) bucket = 'retention';
      else if (/^(promotion|promote|晋升|提升)/.test(t)) bucket = 'promotion';
      else bucket = 'notes';
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const text = (bullet ? bullet[1]! : trimmed).trim();
    if (!text) continue;

    switch (bucket) {
      case 'deny':
        pushUnique(rules.denyKeywords, text);
        break;
      case 'always':
        pushUnique(rules.alwaysNotes, text);
        break;
      case 'retention': {
        // "- observation: 30 天" / "fact: 90"
        const kv = /^([a-z]+)\s*[:：]\s*(\d+)/i.exec(text);
        if (kv && (MEMORY_KINDS as readonly string[]).includes(kv[1]!.toLowerCase())) {
          rules.retention[kv[1]!.toLowerCase() as MemoryKind] = Number(kv[2]);
        }
        break;
      }
      case 'promotion': {
        const n = /(\d+)/.exec(text);
        if (n && rules.promoteSessions === null) rules.promoteSessions = Number(n[1]);
        break;
      }
      default:
        rules.notes.push(text);
    }
  }
  return rules;
}

/** Merge rule layers in order of increasing specificity (later wins). */
export function mergeRules(layers: MemoryRules[]): MemoryRules {
  const out = emptyRules();
  for (const layer of layers) {
    for (const kw of layer.denyKeywords) pushUnique(out.denyKeywords, kw);
    for (const n of layer.alwaysNotes) pushUnique(out.alwaysNotes, n);
    for (const [k, v] of Object.entries(layer.retention)) {
      out.retention[k as MemoryKind] = v as number;
    }
    if (layer.promoteSessions !== null) out.promoteSessions = layer.promoteSessions;
    for (const n of layer.notes) pushUnique(out.notes, n);
  }
  return out;
}

/**
 * Effective rules for one store: user-global AGENTS.md first, then the
 * project's AGENTS.md (falls back to CLAUDE.md, matching dsh-agent-instructions
 * candidates). Missing files contribute nothing.
 */
export async function loadAgentRules(readers: () => Promise<string[] | null>, projectFile?: string | null): Promise<MemoryRules> {
  const layers: MemoryRules[] = [];
  const userFiles = await readers();
  for (const file of userFiles ?? []) {
    const text = await readSafe(file);
    if (text === null) continue;
    const parsed = parseMemorySection(text);
    if (parsed) layers.push(parsed);
  }
  if (projectFile) {
    const text = await readSafe(projectFile);
    if (text !== null) {
      const parsed = parseMemorySection(text);
      if (parsed) layers.push(parsed);
    }
  }
  return mergeRules(layers);
}

async function readSafe(file: string): Promise<string | null> {
  try {
    const { readTextSafe } = await import('./fsutil.ts');
    return await readTextSafe(file);
  } catch {
    return null;
  }
}

function pushUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}
