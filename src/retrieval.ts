/**
 * Local, dependency-free retrieval scoring.
 *
 * v1 relevance = BM25 (lexical, CJK-bigram aware) + tag boost. The composite
 * score follows the Generative-Agents shape: recency decay × importance,
 * reinforced by access history (strength). MMR keeps the top-k diverse.
 *
 * The `rel` component is an isolated seam: a future embedding backend can
 * plug in behind the same RecallHit interface without touching call sites.
 */
import type { CardMeta } from './types.ts';

/**
 * Tokenizer: ascii/number words (lowercased) + CJK character bigrams.
 * Deterministic and cheap; good enough for BM25 over short memory cards.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  const wordRe = /[a-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(lower)) !== null) out.push(m[0]);
  const cjk = lower.replace(/[^\u3400-\u9fff\uf900-\ufaff]/g, '');
  for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk.slice(i, i + 2));
  if (cjk.length === 1) out.push(cjk);
  return out;
}

/** Jaccard similarity over token sets. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** BM25 relevance of one doc against the query. */
export function bm25Score(
  queryTokens: readonly string[],
  docTokens: readonly string[],
  df: Record<string, number>,
  docCount: number,
  avgDocLen: number,
): number {
  if (docCount === 0 || queryTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const docLen = docTokens.length || 1;
  let score = 0;
  for (const q of new Set(queryTokens)) {
    const f = tf.get(q) ?? 0;
    if (f === 0) continue;
    const d = df[q] ?? 1;
    const idf = Math.log(1 + (docCount - d + 0.5) / (d + 0.5));
    score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / Math.max(1, avgDocLen))));
  }
  return score;
}

/** Recency: exponential decay from last access (half-life ≈ 5.8 days). */
export function cardRecency(lastAccessed: string, now: Date): number {
  const hours = Math.max(0, (now.getTime() - Date.parse(lastAccessed)) / 3_600_000);
  return Math.pow(0.995, hours);
}

/**
 * Strength: access reinforcement capped at 1, multiplied by slow time decay
 * from last update (Ebbinghaus-style forgetting pressure).
 */
export function cardStrength(accessCount: number, updated: string, now: Date): number {
  const days = Math.max(0, (now.getTime() - Date.parse(updated)) / 86_400_000);
  return Math.min(1, 0.5 + 0.1 * accessCount) * Math.pow(0.999, days);
}

/**
 * Composite score for one candidate (rel normalized to 0..1 by the caller).
 *
 * Shape: relevance dominates, then recency, then importance, then the
 * corroboration confidence the store has accumulated for the card. The whole
 * product is scaled by access strength (Ebbinghaus-style decay).
 */
export function compositeScore(
  rel: number,
  importance: number,
  recency: number,
  strength: number,
  confidence = 0.6,
): number {
  const conf = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6;
  return (0.45 * rel + 0.15 * (importance / 10) + 0.3 * recency + 0.1 * conf) * strength;
}

/** Structured recall filter applied to card metadata before scoring. */
export interface RecallFilter {
  /** Restrict to these memory kinds (empty/absent = all). */
  kinds?: ReadonlySet<string>;
  /** Require at least one of these tags (empty/absent = no tag constraint). */
  tags?: ReadonlySet<string>;
  /** Restrict to these store slugs (empty/absent = the caller's store set). */
  stores?: ReadonlySet<string>;
  /** Only cards updated at/after this ISO timestamp. */
  since?: string;
  /**
   * Include cards that were superseded (`validUntil !== null`). Default false:
   * a superseded card is history, not guidance.
   */
  includeSuperseded?: boolean;
  /** Minimum importance (1..10). */
  minImportance?: number;
}

/** One card's metadata as seen by {@link passesFilter}. */
export interface FilterableMeta {
  kind: string;
  tags: readonly string[];
  updated: string;
  validUntil: string | null;
  importance: number;
}

/** True when the card satisfies every active constraint of `filter`. */
export function passesFilter(meta: FilterableMeta, filter: RecallFilter | undefined): boolean {
  // Supersession is a read-path invariant, not an optional filter: a card with
  // validUntil set is history and is never served unless explicitly asked for.
  if (filter?.includeSuperseded !== true && meta.validUntil !== null) return false;
  if (filter === undefined) return true;
  if (filter.kinds !== undefined && filter.kinds.size > 0 && !filter.kinds.has(meta.kind)) return false;
  if (filter.minImportance !== undefined && meta.importance < filter.minImportance) return false;
  if (filter.since !== undefined && filter.since !== '') {
    // ISO-8601 UTC strings compare lexicographically; Date.parse guards junk.
    const since = Date.parse(filter.since);
    if (Number.isFinite(since) && Date.parse(meta.updated) < since) return false;
  }
  if (filter.tags !== undefined && filter.tags.size > 0) {
    const wanted = [...filter.tags].map((t) => t.trim().toLowerCase());
    const have = meta.tags.map((t) => t.toLowerCase());
    if (!wanted.some((t) => have.includes(t))) return false;
  }
  return true;
}


export interface ScoredCandidate {
  id: string;
  store: string;
  meta: CardMeta;
  tokens: string[];
  score: number;
}

/**
 * Candidate-pool bounds for MMR. Greedy MMR is O(pool × selected) jaccard
 * intersections; run over EVERY candidate and it becomes O(N²) with N growing
 * forever (the "memory got slow after a few hundred turns" failure). Only the
 * top-k are ever returned, so the pool is pre-cut by score: a multiple of k,
 * with a floor so a tiny k still has enough diversity to choose from.
 */
export const MMR_POOL_MIN = 240;
export const MMR_POOL_FACTOR = 12;

/**
 * Keep the best `max(MMR_POOL_MIN, limit × MMR_POOL_FACTOR)` candidates by
 * score. Returns the input array unchanged when it already fits (no copy).
 */
export function mmrPool(candidates: ScoredCandidate[], limit: number): ScoredCandidate[] {
  const cap = Math.max(MMR_POOL_MIN, Math.max(1, limit) * MMR_POOL_FACTOR);
  if (candidates.length <= cap) return candidates;
  return [...candidates].sort((a, b) => b.score - a.score).slice(0, cap);
}

/**
 * Rank candidates across stores with MMR diversity penalty.
 *
 * `limit` bounds the greedy selection itself (not just the returned slice): the
 * loop stops after `limit` picks, so the cost is O(pool × limit) instead of
 * O(N²). Callers that need the full ranking pass the candidate count.
 */
export function rankWithMmr(candidates: ScoredCandidate[], mmrLambda = 0.3, limit = candidates.length): ScoredCandidate[] {
  const target = Math.max(0, Math.min(candidates.length, Math.floor(limit)));
  const selected: ScoredCandidate[] = [];
  if (target === 0) return selected;
  const pools = new Map<string, ScoredCandidate>(candidates.map((c) => [c.id, c]));
  // Token sets are materialized lazily: only candidates actually compared pay
  // for the Set construction, and each id's set is built at most once.
  const sets = new Map<string, Set<string>>();
  const setFor = (c: ScoredCandidate): Set<string> => {
    let s = sets.get(c.id);
    if (s === undefined) {
      s = new Set(c.tokens);
      sets.set(c.id, s);
    }
    return s;
  };
  while (pools.size > 0 && selected.length < target) {
    let best: ScoredCandidate | null = null;
    let bestScore = -Infinity;
    for (const c of pools.values()) {
      let bestOverlap = 0;
      const cSet = setFor(c);
      for (const s of selected) {
        const o = jaccard(cSet, setFor(s));
        if (o > bestOverlap) bestOverlap = o;
      }
      const mmr = mmrLambda * c.score - (1 - mmrLambda) * bestOverlap;
      if (mmr > bestScore) {
        bestScore = mmr;
        best = c;
      }
    }
    if (!best) break;
    selected.push(best);
    pools.delete(best.id);
  }
  return selected;
}

/**
 * One-hop graph expansion (A-MEM style). Every already-selected hit promotes
 * its `links` neighbours to `max(own score, parent score × decay)`, so a card
 * the lexical query missed but the graph connects to a strong hit can still
 * surface — without ever demoting an independently stronger candidate.
 *
 * @param ranked - the MMR-ranked selection.
 * @param pool - every filtered candidate (may include zero-lexical-score cards,
 *   which is exactly what link expansion is for).
 * @param limit - hard cap on the returned length.
 * @param opts - `decay` (default 0.5) and `hops` (default 1).
 * @returns a new array, re-sorted by score, containing at most `limit` items.
 */
export function expandLinks(
  ranked: readonly ScoredCandidate[],
  pool: ReadonlyMap<string, ScoredCandidate>,
  limit: number,
  opts: { decay?: number; hops?: number } = {},
): ScoredCandidate[] {
  const decay = opts.decay ?? 0.5;
  const hops = Math.max(0, opts.hops ?? 1);
  const byId = new Map<string, ScoredCandidate>(ranked.map((c) => [c.id, c]));
  const order: string[] = ranked.map((c) => c.id);
  let frontier: ScoredCandidate[] = [...ranked];
  for (let hop = 0; hop < hops; hop++) {
    const next: ScoredCandidate[] = [];
    for (const parent of frontier) {
      for (const id of parent.meta.links ?? []) {
        if (id === parent.id) continue;
        const neighbour = pool.get(id);
        if (neighbour === undefined) continue;
        const promoted = parent.score * decay;
        const existing = byId.get(id);
        if (existing !== undefined) {
          if (promoted > existing.score) {
            existing.score = promoted;
          }
          continue;
        }
        const admitted: ScoredCandidate = { ...neighbour, score: Math.max(neighbour.score, promoted) };
        byId.set(id, admitted);
        order.push(id);
        next.push(admitted);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return order
    .map((id) => byId.get(id))
    .filter((c): c is ScoredCandidate => c !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

/**
 * Build a short display snippet from title+body.
 *
 * Most cards are one-line: body repeats the title verbatim. Surfacing that
 * again would double every brief line, so when the body starts with the
 * title we return only the remainder (usually ''). Callers must skip an
 * empty snippet instead of rendering a duplicate.
 */
export function makeSnippet(title: string, body: string, maxChars = 120): string {
  const text = body.trim();
  // No body (one-line cards store body='') → no snippet: the brief line
  // already renders the title, so falling back to the title would repeat it.
  if (text.length === 0) return '';
  if (title.length > 0 && text.startsWith(title)) {
    const rest = text.slice(title.length).replace(/^[\s:：,，;；\-—]+/, '').trim();
    if (rest.length <= maxChars) return rest;
    return rest.slice(0, maxChars - 1) + '…';
  }
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}
