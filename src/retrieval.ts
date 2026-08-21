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

/** Recency: exponential decay from last access (half-life ≈ 14 days). */
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

/** Composite score for one candidate (rel normalized to 0..1 by the caller). */
export function compositeScore(rel: number, importance: number, recency: number, strength: number): number {
  return (0.5 * rel + 0.2 * (importance / 10) + 0.3 * recency) * strength;
}

export interface ScoredCandidate {
  id: string;
  store: string;
  meta: CardMeta;
  tokens: string[];
  score: number;
}

/**
 * Rank candidates across stores with MMR diversity penalty.
 * @param maxRel normalizes relevance into 0..1 (0 when all zero).
 */
export function rankWithMmr(candidates: ScoredCandidate[], mmrLambda = 0.3): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  const pools = new Map<string, ScoredCandidate>(candidates.map((c) => [c.id, c]));
  const sets = new Map<string, Set<string>>(
    candidates.map((c) => [c.id, new Set(c.tokens)]),
  );
  while (pools.size > 0) {
    let best: ScoredCandidate | null = null;
    let bestScore = -Infinity;
    for (const c of pools.values()) {
      let mmr = c.score;
      let bestOverlap = 0;
      for (const s of selected) {
        const o = jaccard(sets.get(c.id)!, sets.get(s.id)!);
        if (o > bestOverlap) bestOverlap = o;
      }
      mmr = mmrLambda * c.score - (1 - mmrLambda) * bestOverlap;
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
