/**
 * Mem0-style ADD/UPDATE/NOOP decision for one candidate against the current
 * store index. v1 is lexical (Jaccard over token sets); the LLM pass (round 2)
 * upgrades near-matches into merges/conflict detection on top of this gate.
 */
import { jaccard } from './retrieval.ts';

export type DedupAction = 'add' | 'update' | 'noop';

export interface DedupDecision {
  action: DedupAction;
  matchId?: string;
  similarity?: number;
}

export const DEDUP_THRESHOLDS = {
  /** ≥ this: the candidate is essentially already stored → NOOP (touch only). */
  noop: 0.85,
  /** ≥ this: same memory, different wording → UPDATE (merge metadata). */
  update: 0.6,
} as const;

export function dedupDecide(
  candidateTokens: ReadonlySet<string>,
  existing: readonly { id: string; tokens: ReadonlySet<string> }[],
): DedupDecision {
  let bestId: string | null = null;
  let bestSim = 0;
  for (const e of existing) {
    const sim = jaccard(candidateTokens, e.tokens);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = e.id;
    }
  }
  if (bestId === null || bestSim <= 0) return { action: 'add' };
  if (bestSim >= DEDUP_THRESHOLDS.noop) return { action: 'noop', matchId: bestId, similarity: bestSim };
  if (bestSim >= DEDUP_THRESHOLDS.update) return { action: 'update', matchId: bestId, similarity: bestSim };
  return { action: 'add' };
}

/**
 * Normalize captured memory text: collapse whitespace runs per line and drop
 * exact-duplicate lines (case-insensitive) that accumulate when the same
 * sentence is staged more than once before Dream runs.
 */
export function normalizeMemoryText(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Promotion gate: a project card is eligible for a global copy when its
 * confidence is high AND it was corroborated by at least `minSessions`
 * distinct source sessions (or a rule says otherwise).
 */
export function promotionEligible(
  meta: { confidence: number; sources: readonly string[] },
  minConfidence: number,
  minSessions: number,
): boolean {
  return meta.confidence >= minConfidence && new Set(meta.sources).size >= minSessions;
}
