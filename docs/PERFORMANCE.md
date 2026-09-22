# dsh-memory — performance & capacity notes

Everything here is measured, not estimated. Reproduce any row with:

```bash
npm run bench                # N = 2000 cards
npm run bench -- 3000        # larger store
npm run bench -- 1000 --old  # also run the PRE-0.4.0 shapes for comparison
```

`scripts/bench.mjs` runs against a throwaway `$DSH_HOME` under the OS temp
directory; it never touches a real store. Machine for the numbers below:
Windows 11, Node v24.15.0, local SSD.

## 1. Why memory made dsh slow (fixed in 0.4.0)

Every one of these ran **synchronously on the harness's own event loop**, so a
multi-second pass was indistinguishable from a freeze.

| # | Shape | Cost at N=1000 | Fix |
| - | ----- | -------------- | --- |
| 1 | `rankWithMmr` ran a greedy MMR over the **entire** candidate set and only then sliced to `k`; the inner loop also walked the selected set → **O(N³)**, on every recall | **124 282 ms** | bounded candidate pool (≥240 or 12·k) + stop after `k` picks → **4 ms** |
| 2 | Dream relink compared every card with every other card, building `new Set(tokens)` for **every pair** | 5 179 ms | tag inverted index (same semantics: ≥2 shared tags, top 5) → 330 ms |
| 3 | Dream dedup rebuilt **every** card's token set for **every** inbox entry | — | one token set per card per run + a token-length prefilter in `dedupDecide` |
| 4 | Every explicit write ran a full `rebuildIndex` (O(N) file reads + multi-MB JSON) | 153 ms / write | per-card incremental index delta → 34 ms |
| 5 | Index written **indented**, carrying every card's full token array | — | compact write, per-card `terms` cap (1024) |
| 6 | `inboxLineCount` read the whole inbox on every tick/status; `readAuditTail` parsed the whole audit log for its last 50 rows | — | (mtime,size)-memoized counts; real tail read |
| 7 | Unbounded growth: no live-card ceiling, an audit log never trimmed, an inbox bounded by lines alone (20 KB each) | — | `maintenance.*` ceilings + `memory_gc` / `/memory 清理` |
| 8 | Long passes never yielded | — | cooperative yield (≤1 per 8 ms) in every whole-corpus loop |
| 9 | The index delta copied `cards` + `df` on **every** write — O(cards + vocabulary) for a one-card change | 1 000-card store: dominated the write | in-place delta (O(changed card)) |
| 10 | A bulk sweep took one lock + one index update + one audit append **per card** | first Dream on an over-cap 3000-card store: 13.5 s | `archiveCards` + `auditMany` per 256 cards → 6.5 s |

The MMR shape was the freeze: at 1000 cards one ranking took over two minutes,
and recall runs on every `memory_recall` **and twice per session** for the brief.

## 2. Current cost profile (0.4.x)

| Operation | N=1000 | N=2000 | N=3000 |
| --------- | ------ | ------ | ------ |
| `rebuildIndex` | 89 ms | 331 ms | 465 ms |
| `core.recall` (k=8) | 8–15 ms | 22–47 ms | 27–53 ms |
| MMR bounded | 4 ms | 7 ms | 10 ms |
| `putCard` (incremental) | 34 ms | 35 ms | 62 ms |
| `rebuildIndex` (for comparison) | 153 ms | 598 ms | 402 ms |
| Dream, first run | 1.4 s | 2.9 s | 6.5 s¹ |
| Dream, steady state | 0.5 s | 2.7 s | 2.9 s |

¹ First run on a store past `maintenance.maxLiveCards` archives the excess and
writes the first 500 link sets; both are batched (one lock per 256 cards, one
index update, one audit append) and both are idempotent.

Two shapes remain **linear in the store size**, by design:

- `recall` scores every card in the requested stores (`cardCorpus()` + BM25).
  Linear, ~18 µs/card, and it is what the session brief and `memory_recall`
  pay.
- `updateIndex` rewrites the whole `index.json` (compact) even for one card.
  The delta *computation* is now O(changed card), but the *serialization* is
  O(index bytes).

## 3. Where the next wall is — and what would have to be true to act

The two linear shapes above are the whole remaining story. At the sizes seen in
practice (hundreds to a few thousand cards) they cost tens of milliseconds and
are not worth the regression risk of a data-structure change. They start to
matter around **10 000+ live cards**:

| Symptom | Approx. trigger | Design that removes it |
| ------- | --------------- | ---------------------- |
| `recall` > ~200 ms | ~10–20 k cards | inverted index (postings) |
| `putCard` > ~500 ms, `index.json` > ~10 MB | ~20–50 k cards | sharded index |
| Dream relink > ~10 s | ~10 k cards sharing a tag | hub-tag sampling |

### 3.1 Inverted index (postings)

`index.json` already stores `df` but no postings, so recall cannot skip cards
that share no query token.

Sketch that avoids the write-cost trap — postings as a **separate, derived**
structure with a delta overlay (LSM-ish):

- `postings.json` — `{ schema, builtAt, postings: { token → ids }, tags: { tag → ids } }`,
  written by `rebuildIndex` (i.e. once per Dream run).
- `postings-delta.jsonl` — appended on every card write (`{ id, terms, tags }`).
  One small append, so the write path is unchanged.
- Recall: `candidates = ∪ postings[q] ∪ delta[q]` for query tokens and tags.
  The delta covers cards written since the last build; removals need no
  tracking because a removed id is simply absent from `index.cards`.

Correctness traps (all three are load-bearing, all three are covered by
existing tests):

1. **Tag-only matches.** Today recall considers every card, so a card whose
   *tags* match the query (the `+0.3 · tagHits` term) can be admitted with zero
   lexical score. A postings-only candidate set would drop those → the tag
   postings above are required, not optional.
2. **Link expansion.** `expandLinks` draws neighbours from the full candidate
   pool; a neighbour that is not itself a candidate must be added explicitly
   after the top-k selection, or A-MEM promotion silently stops working.
   (`recall: scope "all" … the graph promotes linked cards` pins this.)
3. **Staleness must never change a score.** Stale postings may only produce
   *extra* candidates: every candidate is still scored from its current tokens,
   and `score > 0` filters the leftovers. An id whose terms changed may linger
   under its old tokens — wasted work, never a wrong result.

### 3.2 Sharded index

Replace `index.json` with `index/meta.json` (tiny: `docCount`, `totalTokens`,
`shards`) plus `index/shard-<k>.json` (`{ cards, df, postings }`), sharded
deterministically from the card id. A one-card write then reads/writes ~1/16 of
the index instead of all of it, and `df` becomes a per-shard sum.

Cost: `readIndex()` must assemble a view (cache it by the `index/` directory
mtime — atomic writes rename, so the directory mtime is a valid invalidation
signal), `indexMatchesDisk` must compare the union of shard keys, and a legacy
`index.json` needs a one-way migration (rebuild from card files). This is the
reason it is deferred: it is a cache-invalidation refactor of the layer that
everything else depends on, and it buys nothing below ~20 k cards.

### 3.3 Hub tags in relink

`shared` counts are built by iterating every tag's posting list, so a tag shared
by the whole store makes relink O(N²) again. Options, in order of preference:
sample a hub tag's postings to a bounded size (keeps links, bounded work);
or skip tags above a size threshold (bounds work, drops links between cards
whose only common ground is a non-discriminative tag). The Dream wall-clock
budget already bounds the damage today.

## 4. Invariants a change must not break

These are pinned by tests; run both suites before and after any change here.

- `npm test` — fast suite (~3 s), 162 cases.
- `npm run test:scale` — scale guards (~10 s), 3 cases.
- The **incremental index must deep-equal a full rebuild** after every mutation
  kind (`index: incremental updates match a full rebuild…`). This is the single
  most valuable assertion in the repo: it catches any delta-maintenance bug in
  `df` / `docCount` / `avgDocLen`.
- **A dry-run maintenance pass must change nothing on disk** and must report
  exactly what an apply would do.
- **Pending inbox lines are never dropped** — a compaction may only drop the
  consumed head, and the checkpoint must move with it.
- **Recall semantics**: supersession is a read-path invariant; tag-only matches
  and link expansion must keep working (see the traps in §3.1).
- The pre-existing `rankWithMmr(candidates)` contract (no limit → full ranking)
  is used by the retrieval unit test; the bounded path is
  `rankWithMmr(mmrPool(pool, k), 0.3, k)`.

## 5. Change checklist

1. Add the shape to `scripts/bench.mjs` (`--old` reproduces it) and record the
   before/after numbers in the commit or the acceptance record.
2. Prefer bounding an existing loop over adding a new data structure; prefer a
   derived artifact over a schema change (derived state is always rebuildable).
3. Never block the event loop for more than ~10 ms: `await yieldNow()` in any
   whole-corpus loop, and keep lock holds chunked (`PATCH_BATCH_CHUNK`).
4. Keep write bursts bounded and idempotent so a partial run resumes next run
   (the relink cap and the Dream wall-clock budget are the model).
5. Anything destructive gets a dry run and a ceiling (`memory_gc`).
