# dsh-memory 审计报告 / Audit Report (v0.2.0 WIP)

- **Date**: 2026-09-06 20:05 (+08:00)
- **Auditor**: auditor (dsh-memory-audit-fix team, task t1)
- **Target**: `D:\Repos\dsh\dsh-memory` — DSH memory plugin, working tree at **v0.2.0** (git HEAD is v0.1.1, `37101da`); uncommitted WIP = browse feature (host routes + GUI Memory page + per-card v2 mutations + resume-dedup brief fix).
- **Environment**: Windows 10/11 (git 2.53.0.windows.3), Node v24.15.0, npm 11.14.1, tsc 5.8.3. Harness checkout `D:\Repos\deepseek-harness` (cordis 4.0.2, dsh-settings 0.1.3-alpha.1, dsh-llm 0.1.3-alpha.1) inspected **read-only**.
- **Working tree at audit time**: modified `README.md`, `README.zh.md`, `package.json`, `src/client/index.ts`, `src/client/locales.ts`, `src/client/styles.ts`, `src/core.ts`, `src/index.ts`, `src/store.ts`, `src/testing.ts`, `src/types.ts`, `tests/simulate.test.mjs`; untracked `src/browse.ts`, `src/client/memory-page.tsx`, `tests/browse.test.mjs`.

## Commands run (verbatim results)

### 1. `npm run typecheck` (→ `tsc --noEmit`)

```text
npm warn Unknown env config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> dsh-memory@0.2.0 typecheck
> tsc --noEmit
```

**PASS** — exit 0, zero TypeScript errors/warnings (the npm warn is an unrelated npmrc env-config notice, not a project diagnostic).

### 2. `node --test "tests/**/*.test.mjs"`

```text
ℹ tests 99
ℹ suites 0
ℹ pass 99
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1692.1335
```

**PASS** — 99/99. (Re-run after the build below: still 99/99, 1698.8093 ms.) Full test list: brief ×5, browse ×11 (incl. 3 v2 mutation cases), capture intent/exclusion ×7, normalizeMemoryText ×1, capture E2E ×5, llm deadline ×1, cards ×5, dedup ×4, dream ×7 (ingest idempotency, crash recovery, access fold, retention, wall budget, busy guard, cross-engine lock), llm parsing ×8, llm degrade/timeout ×8, dream-llm ×4, lockheal ×6, redact ×7, retrieval ×9, rules ×4, simulate E2E ×1 (incl. new resume-dedup 6b/6c cases), lifecycle/policy/concurrency ×5.

### 3. `npm run build` (→ `node build.mjs && tsc -p tsconfig.build.json`)

```text
> dsh-memory@0.2.0 build
> node build.mjs && tsc -p tsconfig.build.json

built lib/index.js (118496 bytes) for dsh-memory
built lib/testing.js (121322 bytes) for dsh-memory
built lib/client.js (85092 bytes) for dsh-memory
```

**PASS** — exit 0, no esbuild/tsc warnings.

> **Transparency note (required by the task's read-only rule)**: `lib/` is **gitignored** (`.gitignore: lib/`) and is a derived artifact. At audit start the host bundles were **already built from the current WIP** — evidenced by the 99/99 test pass *before* the build, since every test file imports from `lib/testing.js`/`lib/index.js` (including the 14 browse cases). The protocol-required `npm run build` therefore performed a deterministic rebuild from unchanged sources (esbuild + tsc, same inputs); no tracked file was touched. Post-build consistency verified: the test suite (which imports `lib/*.js`) still passes 99/99, `lib/client.js` contains the new Memory page (`dshMemPage*` ×52, `MemoryPageController`, `page.nav`, `dsh.internal` fallback) and `lib/index.js` contains the seven `/api/memory/*` routes.

---

## Findings

Severity scale: **blocker** (release-shipping / data loss / security hole) > **high** (functionality broken for a plausible input) > **medium** (incorrect behavior, dead documented feature, or robustness gap with bounded blast radius) > **low** (hygiene, docs, perf, defense-in-depth).

### F1 — A single corrupt card file bricks recall, brief, writes, and Dream for the whole store
- **Severity**: high
- **Location**: `src/cards.ts:185-189` (`readCardFile`), callers: `src/store.ts:139` (`rebuildIndex`), `src/store.ts:187` (`cardCorpus`), `src/core.ts:290` (`recall`), `src/core.ts:336`, `src/dream.ts` ingest pass 1 (`cardCorpus`), `src/browse.ts:229` (cards route)
- **Problem**: `readCardFile` returns `null` **only when the file is absent**; a present-but-unparseable card (bad frontmatter) makes `parseCard` throw `MemoryFsError`. Callers, however, code to the assumption "null when unreadable, skip and keep the rest":
  - `store.ts:138-139` — `const card = await readCardFile(...); if (card === null) continue; // unreadable card: skip, keep the rest` → in fact **throws**, so `rebuildIndex` fails, and with it `putCard`/`patchCard` (both end in `rebuildIndex`) → **every write to that store fails** (memory_remember, archive/restore, Dream ingest).
  - `core.recall` → `cardCorpus()` iterates `readCardFile` per card → throws → **memory_recall tool errors and the session-start brief is lost** for all new sessions in that store.
  - Dream ingest pass 1 calls `cardCorpus()` → throws → the store run errors, `state.inboxOffset` is not advanced, `isDirty()` stays true → **the same failure repeats every 60 s tick forever** until the file is fixed by hand.
  - Browse `GET /api/memory/cards` → 500.
  The README explicitly markets cards as "human-readable, diffable, and exportable" (`README.md` Design), so a bad manual edit is a realistic trigger, and the README's repair story is "fix the file" — with no indication that one bad file freezes the store.
- **Evidence** (code):
  ```ts
  // cards.ts
  export async function readCardFile(dir: string, id: string): Promise<MemoryCard | null> {
    const text = await readTextSafe(join(dir, `${id}.md`));
    if (text === null) return null;
    return parseCard(text, id);          // ← throws MemoryFsError on bad frontmatter
  }
  // store.ts (rebuildIndex)
  const card = await readCardFile(this.paths.cards, id);
  if (card === null) continue;           // comment says "skip", behavior is "throw"
  ```
  No test exercises a corrupt card (grep `corrupt` in `tests/` → 0 matches).
- **Recommended fix**: make corrupt-card handling explicit and total — either `readCardFile` catches parse errors and returns `null` (with a one-time warn + optional `op:'block'`-style audit note), or each caller wraps the read in try/catch and skips+warns. Add regression tests: corrupt card present → recall still returns the healthy cards, remember still works, dream run succeeds with a warning.

### F2 — "Pending inbox" counts include long-consumed entries (unbounded over-count + unbounded file)
- **Severity**: medium
- **Location**: `src/store.ts:323-327` (`inboxLineCount`), consumers: `src/core.ts:466` (`status()` → memory_status tool), `src/browse.ts` summary handler + `GET /api/memory/inbox`, `src/client/memory-page.tsx` (待整理 badge, 候选池 tab)
- **Problem**: Dream consumes the inbox by advancing `state.inboxOffset` but **never truncates** `inbox.jsonl`. `inboxLineCount()` counts *all* non-empty lines, so:
  - `memory_status` `pendingInbox` grows forever and is **never 0 after a successful Dream** (it reports cumulative history, not work remaining).
  - The GUI summary "待整理" badge and the inbox tab "候选池 (N)" show the same cumulative number; the inbox tab lists entries that were folded into cards days ago.
  - `inbox.jsonl` (and `GET /api/memory/inbox` responses) grow without bound.
- **Evidence**: `dream.ts` ingest does `state.inboxOffset += consumed` and then `writeState` — no file rewrite; `fsutil.readJsonlLines`/`inboxLineCount` read the whole file; `dream.ts:155` `isDirty()` correctly uses `lines > inboxOffset` (proving the offset is the pending boundary the display side forgot).
- **Recommended fix**: compute pending as `totalLines - state.inboxOffset` in `status()` and the browse summary; serve only unconsumed entries (or label consumed ones) from the inbox route; optionally compact the file (drop the consumed head) after successful runs once it exceeds a size threshold. Add a test: remember → dream → status shows `pendingInbox: 0`.

### F3 — `memory.redact.pii` setting is ignored by the explicit `memory_remember` path
- **Severity**: medium
- **Location**: `src/core.ts:206` (hardcoded `'redact'`) vs `src/capture.ts:240` (`s.redact.pii`) and `src/dream.ts:251` (`this.getSettings().redact.pii`)
- **Problem**: The PII policy knob (`memory.redact.pii`: `off | warn | redact`, default `redact`) is exposed in the GUI settings card (`settings-card.tsx` "PII 策略") and documented in both READMEs as *the* PII policy. But `core.remember()` — the explicit tool path — hardcodes `gateCandidate(content, rules.denyKeywords, 'redact')`. With `pii=off` or `warn` a user who stores a memory via `memory_remember` still gets PII masked (or, with `warn`, gets no audit signal at all), while auto-capture honors the setting. The behavior is fail-closed (safe direction) but contradicts the documented contract and the visible GUI control.
- **Evidence**:
  ```ts
  // core.ts:206
  const gated = gateCandidate(content, rules.denyKeywords, 'redact');
  // capture.ts:240
  const gated = gateCandidate(content, rules.denyKeywords, s.redact.pii);
  ```
- **Recommended fix**: thread the live setting into the write path — e.g. add `piiMode` to `RememberInput` and have `tools.ts` pass `st.redact.pii` (it already holds `st`). Add a test: with `pii=off`, `remember` stores the raw email; with `pii=warn` it stores raw + reports hits.

### F4 — One malformed inbox line wedges Dream ingest for the store permanently
- **Severity**: medium
- **Location**: `src/fsutil.ts:51-66` (`readJsonlLines` throws on a malformed line), `src/dream.ts` ingest pass 1 (`store.readInbox(state.inboxOffset)`)
- **Problem**: If any line of `inbox.jsonl` is malformed, `readInbox` throws `MemoryFsError`, the whole store run fails, and `state.inboxOffset` is not advanced (it is only persisted on success). `isDirty()` then stays true (`lines > offset`), so **every subsequent tick re-reads the file and fails again — indefinitely**. A realistic trigger: `appendFile` is not atomic, so a process killed mid-append (the exact scenario `lockheal.ts`'s docstring is written for) can leave a partial JSON line at the end of the file.
- **Evidence**: `dream.test.mjs` covers "crash recovery: a failed run leaves the inbox offset untouched" (correct semantics) but has no case for a *persistently malformed* line; the failure loop is the missing piece.
- **Recommended fix**: make ingest resilient per-line: read raw lines, quarantine (skip + warn + optional audit `via:'system'`, or move to a `<store>/quarantine.jsonl`) any line that fails to parse, and advance `inboxOffset` past it. Add a test: append a corrupt line → dream run succeeds for the healthy lines and the offset moves past the bad one.

### F5 — `budget.maxInboxLines` is a dead settings knob (documented, defined, never enforced)
- **Severity**: medium
- **Location**: `src/settings.ts:63` (schema) — no other references in `src/` (grep: only `settings.ts` matches); documented in `README.md` settings table ("maxInboxLines — 候选池保留行数上限 (每库)")
- **Problem**: The knob is user-visible in the settings schema (and would surface in any settings surface that renders the schema), documented in the README, but nothing reads it. The inbox is therefore unbounded (compounding F2).
- **Recommended fix**: either enforce it in `pushInbox`/ingest (e.g. once total lines exceed the cap, compact/evict the oldest *consumed* lines, and warn+stop staging new lines when the *pending* tail exceeds it) or remove the field from schema + README. Prefer enforcing, since F2's compaction needs a cap anyway.

### F6 — README (both languages) states wrong `memory.llm.*` defaults and an incomplete route-resolution order
- **Severity**: medium
- **Location**: `README.md:119-121`, `README.zh.md:119-121`
- **Problem**: The settings table claims `llm.maxOutputTokens` / `timeoutMs` defaults are **`600` / `30000`**; the actual schema defaults are **`2000` / `60000`** (`settings.ts:81,84`, with comments explaining exactly why — field-measured extraction replies of 1400–2100 tokens and 60 s deadlines on 27B-class models). Also, the README's `llm.provider`/`model` row ("empty = use composition row route") omits the real intermediate step: resolution is **settings override → current session default model (`agent-default-model`) → composition row** (`settings.ts:66-72`, `llm.ts:4-9`, `index.ts:119-147`).
- **Evidence**:
  ```md
  | `llm.maxOutputTokens` / `timeoutMs` | `600` / `30000` | 单次辅助调用输出上限 / 超时 |
  ```
  vs
  ```ts
  maxOutputTokens: z.natural().min(16).max(8000).default(2000),
  timeoutMs: z.natural().min(1000).max(120000).default(60000),
  ```
- **Recommended fix**: update both README tables to `2000` / `60000` and document the three-step resolution order.

### F7 — Dream performs one full index rebuild per card mutation (O(N) rebuild × O(N) run)
- **Severity**: medium (performance)
- **Location**: `src/store.ts:201-206` (`putCard`), `src/store.ts:225-234` (`patchCard`) — both call `rebuildIndex()`; `src/dream.ts` passes 1/2/4 mutate many cards per run, then pass 5 (`dream.ts:412`) rebuilds *again*
- **Problem**: `rebuildIndex()` re-reads, re-parses and re-tokenizes **every** card in the store. A Dream run that adds P cards, folds A access rows, and relinks L cards therefore performs ≈ P + A + L full rebuilds plus the final one — O(N·(P+A+L)) file I/O per run (N = store size). The in-run rebuilds are pure waste: pass 5 already reindexes the store after all passes, and the index is a derived artifact (never served mid-run).
- **Evidence**: `putCard`/`patchCard` both end with `await this.rebuildIndex()` (store.ts:205, 233); dream.ts pass 1 calls `putCard` per new card, pass 2 `patchCard` per accessed id, pass 4 `patchCard` per relinked card, then `await store.rebuildIndex()` at pass 5 (line 412).
- **Recommended fix**: add a store-level "index dirty" mode for bulk runs (e.g. `putCard(card, {rebuild:false})` / an explicit `flushIndex()`), have Dream flush once at pass 5; keep the single-mutation rebuild for the tool path. (This also shrinks the lock window, see F14.)

### F8 — Project registry read-modify-write is unlocked; re-run on every cwd call → cross-process slug split + write churn
- **Severity**: medium
- **Location**: `src/paths.ts:98-124` (`registerProjectPath`: `loadProjectsRegistry` → mutate → `saveProjectsRegistry`, no lock), `src/core.ts:134` (unconditional re-registration on every `projectStoreForCwd` call, even on cache hit)
- **Problem**: Two concurrent DSH processes discovering *different* project paths both load `projects.json`, mutate, and atomically write — **last writer wins, the other's entry is silently lost**. The collision-suffix loop (paths.ts:112-117) evaluated against the stale registry can then assign `X-2` to a path whose entry was clobbered, so one project can end up with **two slugs over time and its memory split across two stores**. Aggravator: `core.projectStoreForCwd` calls `registerProjectPath(root)` on *every* call (line 134, even when `this.projects` already holds the slug), so every `memory_remember`/`memory_recall` with a cwd rewrites `projects.json` (lastSeen update) — constant cross-process write churn and a wide race window.
- **Evidence**:
  ```ts
  // core.ts:133-135
  if (root === null) return null;
  const { slug } = await registerProjectPath(root);   // full registry RMW on every call
  return this.projects.get(slug) ?? null;
  ```
  `saveProjectsRegistry` is a bare `writeJsonAtomic` — no `withFileLock`.
- **Recommended fix**: (1) skip the registry RMW when the store is already in `this.projects` (return the cached slug; at most a periodic lastSeen touch); (2) wrap the register RMW in `withFileLock(join(memoryRoot(), 'projects.json'))` for the cross-process case. Add a single-process concurrency test: two different paths colliding on the same base slug registered in parallel must both keep their entries.

### F9 — Per-turn audit spam when the LLM service is absent
- **Severity**: low
- **Location**: `src/index.ts:111-117` (always builds non-null `llmDeps` with `llm: null`), `src/capture.ts:291` (`runLlmPass` → `skipped no-llm-service`), `extractFor` audit write (`op: 'llm'`)
- **Problem**: `registerCapture` always receives a non-null `llmDeps`, so with default settings (`capture.mode=auto`, `capture.useLlm=true`) **every turn end of every root session appends an `op:'llm'` audit line `skipped no-llm-service`** when the `llm` service is not composed — unbounded, zero-information growth of `audit.jsonl` (absence is already warned once at init, index.ts:110).
- **Recommended fix**: skip the per-turn audit line when `llmDeps.llm === null` (keep auditing real outcomes: ok/error/timeout, and at most a single "no service" line per session).

### F10 — No card-id validation on the read paths (forget-by-id, browse card detail)
- **Severity**: low (defense-in-depth; no data leak proven)
- **Location**: `src/core.ts:376-377` (`forget` → `store.readCard(args.id)`), `src/browse.ts:318-323` (`GET /api/memory/card?id=`)
- **Problem**: Raw user-supplied ids reach `join(cards, `${id}.md`)`. A traversal id (e.g. `../../projects/foo/cards/m-20260101-abcd`) reads a card file outside the store; the subsequent frontmatter-id check in `parseCard` then fails (the id regex forbids `/`, so it can never equal a traversal string) → `MemoryFsError` → tool error / HTTP **500** instead of a clean 400. Content exfiltration is not possible (a successful parse would require the frontmatter id to equal the traversal string), but the error semantics are wrong and the missing validation is a standing gap the mutation routes already close (`requireId`, browse.ts).
- **Recommended fix**: validate `/^m-\d{8}-[a-z0-9]{4,10}$/` at the boundary (`core.forget` → treat as not-found; browse `card` handler → 400) and add tests for `id=../../…` on both paths.

### F11 — Dead code and a half-implemented "promotion" feature
- **Severity**: low
- **Location**: `src/dedup.ts:66-72` (`promotionEligible` — exported for tests only), `src/rules.ts:131-148` (`loadAgentRules` — never called; `core.rulesFor` reimplements the layer walk), `src/cards.ts:222` (`export { fs as nodeFs }` — unused, and an odd re-export of `node:fs`), `src/store.ts:35` (unused import `cardTokenCount`), `src/paths.ts:161` (unused `SEP` export), `src/dream.ts` (`MEMORY_KINDS_LOCAL` duplicates `MEMORY_KINDS` from `types.ts:23`)
- **Problem**: besides plain dead code, the **promotion rule surface is parsed but has no effect**: `## Promotion` sections in AGENTS.md are parsed into `rules.promoteSessions` (rules.ts:74,101) which nothing consumes; the `promote` audit op (types.ts:124) is never written; `settings.ts:35` advertises the LLM passes as "summarize/promote/conflict" when only summarize + conflict exist. A user who authors a Promotion section gets a silent no-op.
- **Recommended fix**: decide — implement project→global promotion in Dream (using `promotionEligible` + `promoteSessions`) or delete the parsing, the dead exports, and the `promote` op, and fix the settings.ts comment. Either way, remove `nodeFs`, `loadAgentRules`, `SEP`, the unused import, and the duplicated kinds constant.

### F12 — Stale in-code comments, docstrings, and UI/docs copy
- **Severity**: low
- **Location** (all verified against current behavior):
  - `src/index.ts:190-192` — "GUI browse surface (v1: read-only). Registers four exact … routes" → now **seven** routes, **v2** with mutations.
  - `src/browse.ts:97` docstring — "Build the four route handlers" → seven.
  - `src/retrieval.ts:95-96` — `rankWithMmr` docstring mentions `@param maxRel` which no longer exists in the signature.
  - `src/retrieval.ts:65` — "half-life ≈ 14 days": `0.995^h = 0.5` ⇒ h ≈ 138.6 h ≈ **5.8 days**, not 14.
  - `tests/browse.test.mjs:211` — test title "mounts 4 GET routes" (the assertions themselves correctly expect 7 routes: 5 GET + 2 POST).
  - `src/client/locales.ts` `page.description` (zh: "只读浏览…不做任何编辑" / en equivalent) — the page now offers Archive/Delete/Restore (v2).
  - `README.md:133` — layout bullet "the read-only Memory page in the `settings.section` slot" (the GUI section above it correctly describes v2; this bullet lags).
  - `src/tools.ts` `memory_remember` `kind` description lists "fact | preference | decision | procedure | commitment | observation" but omits `summary` (a valid `MEMORY_KINDS` value that `core.remember` accepts).
- **Recommended fix**: one pass updating each item to match v2 reality.

### F13 — Deadline-cancel path re-iterates the LLM stream
- **Severity**: low
- **Location**: `src/llm.ts:121` — `void stream[Symbol.asyncIterator]().return?.().catch(() => undefined);`
- **Problem**: the for-await already consumed the iterable; calling `[Symbol.asyncIterator]()` again is safe **iff** the adapter's `stream()` is an async-generator instance (re-iteration returns the same generator, whose `.return()` cancels the request). If a future adapter returns a *fresh* iterable per call, this line would start a second provider request and immediately cancel it — bounded but wrong.
- **Recommended fix**: restructure to keep the explicit iterator (`const it = stream[Symbol.asyncIterator]();` loop with `it.next()`, then `it.return?.()` on timeout) so cancellation never depends on re-iteration semantics.

### F14 — 2 s default lock wait can surface raw lock-timeout tool errors on large stores
- **Severity**: low
- **Location**: harness `packages/util/atomic-write/src/index.ts:126` (`DEFAULT_LOCK_WAIT_MS = 2_000`), plugin `src/store.ts:83-97` (`locked`/`lockedOn` use the default), `src/fsutil.ts:47` (`appendJsonl`)
- **Problem**: store-lock operations include full `rebuildIndex` (O(N) card reads + tokenize). With N large enough that a rebuild approaches 2 s, a concurrent writer (Dream vs. `memory_remember`, or two sessions) can time out, and `lockheal` only rescues *dead* owners — a live holder yields a raw `timed out waiting for the writer lock at …` error to the model. F7's fix (fewer rebuilds, shorter critical sections) mitigates this; optionally pass a larger `waitMs` for store-lock ops or retry once.
- **Recommended fix**: after F7, re-measure; if rebuilds can still exceed ~1 s at realistic store sizes, raise `waitMs` for `locked()`/`lockedOn()` (e.g. 10 s) — the lock protocol's own doc comment endorses explicit waits for long operations.

### F15 — Process-lifetime growth and worst-case scans (informational)
- **Severity**: low
- **Location**: `src/index.ts:263` (`injected` Set grows with every agent id forever), `src/index.ts:229-247` (`hasPersistedBrief` scans the full persisted event log per session start — O(1) typical via early exit, O(N) for very long sessions)
- **Recommended fix**: none required for v1; if the host runs for months with high agent churn, consider bounding `injected` (it only needs to dedupe double-fire within one process lifetime).

### F16 — Repo hygiene: dual lockfiles, line-ending warnings, uncommitted WIP
- **Severity**: low
- **Location**: `package-lock.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml` coexist; git warns `LF will be replaced by CRLF` on every WIP file (autocrlf); working tree v0.2.0 vs HEAD v0.1.1
- **Problem**: nothing broken — `pnpm-workspace.yaml` uses `allowBuilds: { esbuild: true }`, the **valid** pnpm ≥10 shape (matches the harness root `pnpm-workspace.yaml` and the CLI's own error hint), and `dsh plugin` installs forward to pnpm in the *profile* dir where its own workspace file governs. The dual-lockfile situation just invites drift. The whole browse WIP (including the version bump and peer bump) is uncommitted.
- **Recommended fix**: keep one lockfile authoritative (npm for this repo per README, or drop `package-lock.json` if pnpm is canonical); add a `.gitattributes` (`*.ts text eol=lf`) if CRLF warnings annoy; commit the WIP (captain's call — this audit must not commit).

### F17 — Test coverage gaps
- **Severity**: medium
- **Location**: `tests/`
- **Problem** (specific, each maps to a finding above):
  1. **Corrupt card file** (F1) — no test; current behavior is uncaught `MemoryFsError` in `rebuildIndex`/`cardCorpus`/`recall`/Dream.
  2. **Malformed inbox line** (F4) — no test; Dream wedges indefinitely.
  3. **`pendingInbox` after Dream** (F2) — no test; status/summary over-count.
  4. **PII mode on explicit remember** (F3) — `redact.test.mjs` covers `redactPii` in `redact`/`off` but **never `warn`**, and never the remember-path wiring.
  5. **Id validation / traversal** (F10) — no test for `forget({id:'../../…'})` or `GET /api/memory/card?id=../../…`.
  6. **`budget.maxInboxLines`** (F5) — untested because unenforced.
  7. **Client side** — no unit tests for the staged-form model (`settings-form.ts` CardForm path ops/parse) or the Memory page component; host routes are well covered, the React UI is not (acceptable for v1, note for later).
  8. **Registry concurrency** (F8) — a single-process parallel `registerProjectPath` on colliding slugs would catch the last-writer-wins regression.
  9. **Secret-gate negative fixtures** — only 10 happy-path credential fixtures; no near-miss/bypass pins (short values, query-string tokens, encoded forms). The gate is intentionally pattern-based, but 2–3 negative fixtures would pin intent.
- **Recommended fix**: add the tests in priority order 1→6, 8; treat 7/9 as nice-to-have.

---

## WIP state assessment (browse feature)

**Complete and internally consistent** — verified end to end:
- Host: 7 exact routes (`5 GET + 2 POST`) on `connection.fetch.register` with `requestBody:'buffered'` — the exact shape `HostConnectionService` validates (`rpc-host.ts:292-303`, segment pattern accepts all `/api/memory/*` paths); fiber-scoped disposal with partial-rollback on failed registration; absent-connection degradation. All covered by `tests/browse.test.mjs` (11 cases incl. v2 archive/restore round-trip, hard-delete irreversibility, strict store scoping, 400/404/500 contract).
- Client: `settings.section` page (id `memory`, order 25 — lands after shipped sections: general 0 / models 10 / plugins 15 / agent-presets 20) + `settings.plugin.item` card (key `memory`); every `t('page.*')` key exists in **both** dictionaries (key set is type-derived); every `dshMemPage*`/`dshMemArchive*` class is present in `styles.ts`; `hostBase()` uses the established `http://dsh.internal` null-origin fallback (same convention as file-upload, session-log-export, gateway); `MemoryPageController.dreamNow` reuses the existing `dream.requestSeq` path.
- The built `lib/client.js` contains the page (verified post-build: `dshMemPage*` ×52, `MemoryPageController`, `page.nav`, `dsh.internal`); runtime requires of the bundle are only `react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-store` — all shell seed words, so no graph-row risk.
- `package.json`: version 0.2.0 (bump appropriate for the feature), peer `@deepseek-ai/dsh-settings ^0.1.3-alpha.1` satisfied by the linked checkout (0.1.3-alpha.1), `cordis ^4.0.1` satisfied (4.0.2); `dsh.bundle.patch` → `cordis.patch.yml` whose row config (`deepseek`/`deepseek-v4-flash`) matches `DEFAULT_LLM_ROUTE`.
- `tests/simulate.test.mjs` adds strong E2E for the resume-dedup brief fix (persisted-log check + legacy-session first-resume case).

**Still open in the WIP**:
1. Manual GUI E2E (Settings → Memory page rendering + archive/delete/restore click flow) — the README's own 2026-09-05 acceptance record says it "needs a manual check after a web-profile restart".
2. Findings F2, F3 (behavior), F6, F12 (copy) — the WIP is functionally coherent but not doc/behavior-consistent yet.

---

## Priority plan (findings → implementation work)

**P0 — correctness/robustness (do first, each with a regression test):**
1. **F1** corrupt-card resilience (`readCardFile` null-on-parse-failure or caller-level catch + warn + audit; tests: recall/remember/dream survive a corrupt card).
2. **F4** quarantine malformed inbox lines (skip+advance+audit; test: bad line no longer wedges Dream).
3. **F2** fix `pendingInbox` semantics (`totalLines - inboxOffset` in status + browse summary; inbox tab shows pending; optional compaction; test: post-dream pending = 0).
4. **F8** lock the registry RMW + stop per-call re-registration (cache slug; concurrency test).

**P1 — behavior/docs consistency:**
5. **F3** honor `redact.pii` in the remember path (+ warn/off tests).
6. **F6** README (both languages): correct llm defaults (2000/60000) + 3-step route resolution.
7. **F5** enforce `maxInboxLines` (tie to F2 compaction) or delete it from schema + README.
8. **F10** validate card ids on read paths (400 / not-found; traversal tests).
9. **F17** land the remaining test-gap items 4–6, 8.

**P2 — performance/hygiene:**
10. **F7** single index rebuild per Dream run (dirty-flag/`flushIndex`).
11. **F9** suppress per-turn `op:'llm'` audit lines when the service is absent.
12. **F11** remove dead code; decide promotion (implement or document-not-implemented; fix settings.ts comment).
13. **F12** stale comments/copy pass (index.ts:190, browse.ts docstring, locales `page.description`, README "read-only Memory page", test title, `kind` description, retrieval comments).
14. **F13** explicit iterator in `llm.ts` cancel path.
15. **F14** (after F7) evaluate raising store-lock `waitMs`.
16. **F16** pick one lockfile; `.gitattributes`; captain decides on committing the WIP (this audit must not commit).

**After implementation (review/t3 or user):** manual GUI E2E on a live web profile (page render + click flow), per the README's pending acceptance item.

---

## Non-issues / verified OK (do not re-litigate)

**Commands**: typecheck exit 0 (no TS diagnostics); 99/99 tests pass (pre- and post-build); build exit 0, all three bundles emitted, declaration files emitted to `lib/types/`.

**Verified against the harness checkout (read-only), where the plugin's assumptions could have been wrong:**
- **Lock protocol** (`@deepseek-ai/dsh-atomic-write`): lock is a `wx`-created `<file>.lock` sibling containing the owner PID (`index.ts:162-167`) — matches `lockheal.ts` parsing; timeout message `atomic-write: timed out waiting for the writer lock at …` matches `isLockTimeout`'s regex; `healOrphanLock`'s grace/alive/unparseable behavior is fully unit-tested.
- **`dsh-timeout`**: `deadline(upstream, timeoutMs, code)` returns `{signal, [Symbol.dispose]}`; `timeoutOf(signal, code)` code-matching — exactly as used in `llm.ts`.
- **`dsh-llm`**: root index re-exports `message.ts` (so `createUserMessage` from the bare specifier is real); `GenerateOptions.system?: string` is a genuine field ("adapters map to the provider's system slot", types.ts:419-420) — the extraction system prompts do reach the model; `MessageSourceMap.plugin` accepts `form: 'recall'`.
- **`dsh-settings` (host)**: `register(ns, schema, {applies:'live'})` → scope with `get()`/`watch()`; `settings.get('agent-default-model')` returns `undefined` when unregistered (handled by try/catch + undefined check); the `memory` namespace name is a valid lowercase-hyphenated identifier.
- **Events/agent API**: `agent/created`, `agent/session-start`, `agent/inbox/spliced` all exist with the payloads the plugin consumes; `agent.inject(message: UserMessage)` exists (runtime-types.ts:187); the resume-dedup check matches how spliced events persist `source`.
- **`connection` service (host)**: `connection.fetch.register({path, methods, requestBody:'buffered', fetch})` matches `HostConnectionService` exactly; route validation (`/api` prefix + segment pattern) accepts all seven paths; route ownership is the connection service's fiber with a returned disposer — dsh-memory's `ctx.effect` teardown disposes it, so both unload orders (dsh-memory first / connection first) leak nothing. (session-log-export ignores its disposer; dsh-memory is more careful.)
- **Client conventions**: `http://dsh.internal` null-origin fallback is the established pattern (file-upload `runtime.ts:311`, session-log-export `controller.ts:50`, gateway, connection rpc); `dsh.client.inject` edges are explicitly *informational* ("loading/prefetch metadata, never apply sequencing" — ui-workspace comment) and the bundle's actual runtime requires (react, react/jsx-runtime, dsh-client-store) are shell seed words; `settings.section` (list slot) and `settings.plugin.item` (keyed by edited namespace) are the correct seats, used the same way by ui-settings-* packages.
- **Manifest/CLI**: `dsh.bundle.patch` is the real composer field (`app-boot/src/profile.ts:832`); the README install command `dsh plugin add link:… --profile web` parses correctly (commander `requiredOption('--profile')` + variadic args without `enablePositionalOptions` — options are collected from anywhere; the canonical order is `dsh plugin --profile web add …`, both work); `allowBuilds` in `pnpm-workspace.yaml` is the valid pnpm ≥10 shape.
- **Peer deps**: cordis 4.0.2 satisfies `^4.0.1`; dsh-settings 0.1.3-alpha.1 satisfies `^0.1.3-alpha.1`.

**Code-quality checks that came back clean:**
- No `TODO`/`FIXME`/`HACK` markers anywhere in `src/`.
- Secret gate: 10 built-in patterns, whole-candidate block, pattern-names-only audit (tested), gate runs **before** staging on every path (remember / heuristic capture / LLM capture / dream ingest); PII default `redact` — fail-closed.
- Brief: byte budget measured on the *framed* output; global lines sacrificed before project lines; embedded `</system-reminder>` escaped; one-line title/snippet dedup; two-layer dedup (in-process set + persisted-log scan) — all tested, including the new resume/legacy cases.
- Dream: idempotent ingest with checkpointed `inboxOffset`; busy guard (instance flag + cross-engine `WeakSet`) + per-store `run.lock` for cross-process; wall-clock budget; per-store error containment (one bad store never fails the run); LLM budget (`maxLlmCalls`) + graceful degradation (all tested).
- Error containment at every ctx hook: nothing in `apply()` throws into an agent turn (verified by code reading; simulate E2E exercises the wiring).
- `memory-page.tsx` timers (5 s armed-action reset, 200 ms search debounce, refresh) are all cleaned up in effect teardowns — no leaked timers.
- Browse failure contract holds: bad params/body → 400, unknown store/card → 404, unexpected → 500 with generic message; audit content is never served; mutation bodies size-capped (4 KB).
- `restoreCard` re-parses before promoting an archive entry to live and refuses when the live id is occupied — no corrupt-card resurrection path.
- `files`/`exports` in package.json are coherent for a `link:`-installed local plugin (lib + src + patch + docs; `./client` subpath; testing surface deliberately not exported).
