# dsh-memory

Durable memory for DeepSeek Harness (DSH): **global memory + per-project memory + rules layer + background "Dream" consolidation + a DSH-native `/memory` command + a GUI management surface**.

Production-grade: 138/138 tests green, typecheck and build clean, installable as a profile bundle. (中文说明见 [README.zh.md](README.zh.md))

## Design

Borrows the proven pieces from mainstream approaches, with deliberate trade-offs:

| Approach | Borrowed |
| --- | --- |
| [Generative Agents](https://arxiv.org/abs/2504.13171) (memory stream + reflection) | Memory cards + periodic reflection (Dream); recall scored by relevance / recency / importance / confidence; MMR diversity + 1-hop link expansion |
| [Mem0](https://memo.d.foundation) / [Letta](https://docs.letta.com) (add/extract/consolidate pipeline) | Two-phase writes: auto-extraction → candidate pool (inbox) → background merge/dedupe/archive; write path decoupled from consolidation |
| [Zep](https://arxiv.org/abs/2501.13956) bitemporal memory | Corrections never destroy history: the replaced card keeps its file and gains `validUntil` + `supersededBy`, so it leaves recall but stays auditable and restorable |
| Claude Code memory conventions (`AGENTS.md`/`CLAUDE.md`) | Rules layer: `## Memory` sections in `$DSH_HOME/AGENTS.md` and project `AGENTS.md`/`CLAUDE.md` may add stricter deny rules |

### Storage layout (everything under `$DSH_HOME/memory/`, never inside project directories)

```
$DSH_HOME/memory/
  global/                  # cross-project memory
    cards/<id>.md          # memory cards (markdown + front-matter metadata)
    inbox.jsonl            # candidate pool (policy-clean by construction)
    dream/summary.md       # Dream overview
    audit.jsonl            # append-only audit (ids + actions only, never content)
    archive/<id>.md        # archive (forget = move here, recoverable)
    index.json             # derived index v2 (terms + card metadata; rebuildable)
  projects/<slug>/         # one store per project (slug derived from the path)
  projects.json            # project path ↔ slug registry
```

`index.json` is schema **v2**: alongside each card's metadata it persists the card's token array (`terms`), so recall, the brief, Dream and the GUI all score from ONE cached JSON read instead of re-reading every card file. A v1 index is detected and rebuilt on first read; the index also self-heals when card files are added, removed or renamed outside the store (one `readdir` per cache miss).

### DSH integration (what the plugin actually plugs into)

| DSH capability | Used for |
| --- | --- |
| `settings` service | the live Config of this row (`dsh-memory` volatile fields; GUI + profile patch) |
| `tools` service | 9 model-facing tools |
| `commands` service | `/memory …` typed by the **human** in the composer (one command, Chinese subcommand aliases) |
| `connection` service | 13 exact `/api/memory/*` fetch routes served to the browser through the connection's auth |
| `timer` service | 60 s Dream tick + 30 s startup sweep (patched in whenever the service appears) |
| `systemPrompt` service | a static `memory:usage` section (order 150) |
| `session/event` (`turn/end`) | turn-end auto-capture (heuristic + optional LLM extraction) |
| `session/event` (`compaction/summary`) | the harness's own compaction summary is staged as a `summary` candidate, so a long session's durable outcome survives the compaction that replaced its history |
| `agent/created` | one budgeted `<system-reminder>` brief per session, durable-deduped against resumes |
| `llm` service | budgeted auxiliary calls (extraction, Dream summarize/conflict) on the agent's own route |

Every contribution is registered inside the service scope it needs, so any mount order works, an absent optional service degrades to one warning, and disposal unwinds with the fiber.

### Recall & injection

- `memory_recall` tool: scored recall over the current project store + the global store (`scope: "all"` widens it to every discovered project). Score = BM25 (CJK-bigram aware) + tag boost, normalized and combined with recency, importance and corroboration confidence, scaled by access strength; MMR keeps the top-k diverse and a 1-hop link expansion can promote graph neighbours the lexical query missed. Filters compose: `kind`, `tags`, `since`, `minImportance`, `store`.
- **Supersession is a read-path invariant**: a card with `validUntil` set is never served unless `includeSuperseded` is passed. Corrections therefore hide history by default without ever deleting it.
- **Session brief**: one budgeted `<system-reminder>` per agent session at startup (project Top-K=12 + global Top-K=8, total ≤ 4096 bytes) — keeps the KV-cache prefix stable.
- **Compaction capture**: when the harness compacts a session, the `compaction/summary` event's text is policy-gated and staged as a `summary` candidate (identical summaries are deduped per session) — long-session outcomes become durable project memory instead of vanishing into a checkpoint the next Dream never reads.
- A `memory:usage` system-prompt section (order 150).

### Auto-capture (two-phase)

1. Turn-end event → heuristic extraction (intent/preference sentences, disable with `capture.heuristic=false`) → candidates into `inbox.jsonl`;
2. When `capture.useLlm` is on, a second extraction/merge pass over the user-configured LLM route (failures warn only, never block).

`capture.mode` gates the whole path: `off` disables capture, `explicit` disables AUTO capture entirely (only `memory_remember` / `/memory remember` write), `auto` enables both passes. The policy gate runs before anything is staged, so the candidate pool only ever contains allowed content.

### Background Dream consolidation (LLM passes on by default)

- Triggered on idle ticks (default 30 min, min 5) + a 30 s startup sweep + an explicit run (`memory_dream`, `/memory dream`, or the GUI button's `POST /api/memory/dream`).
- **ingest**: inbox captures become cards (Mem0-style ADD/UPDATE/NOOP over Jaccard similarity); malformed lines are quarantined and the offset advances past them.
- **access**: the recall access log is folded into each card's counters.
- **decay**: rule retention (`retention:` in the AGENTS.md Memory section) plus an observation floor archive stale cards.
- **relink**: tag co-occurrence links (≥2 shared tags, top-5) over LIVE cards only.
- **summarize**: when a store has ≥8 live cards, the Top-40 produce/refresh `dream/summary.md`.
- **conflict**: candidate pairs with Jaccard similarity in 0.3–0.85 (max 4 pairs/run) are arbitrated by the LLM; the loser is **superseded** (file kept, `validUntil` + `supersededBy` stamped, winner records the forward link) rather than destroyed, and the decision is audited.
- Budgets: `maxLlmCalls` (40) and `maxWallMs` (600 s) per run, per-store checkpoints (`inboxOffset`) — **idempotent and crash-recoverable** (re-runs are side-effect-free). The whole run performs exactly ONE index rebuild (`rebuild: false` on every mutation).
- `dream.useLlm=false` degrades to heuristics only (ingest / dedupe / decay / relink).

### Secrets & privacy

- **The built-in secret gate is always on and cannot be configured**: API keys, passwords, tokens, private keys, etc. are blocked pre-write and returned as a structured `blocked` result (never persisted, never thrown, never echoed). Accepted live: a fake OpenAI-style key → `{"blocked":true,"reason":"openai-style-key"}`.
- `redact.pii`: `off | warn (audit only) | redact (default, mask in stored text)` — the policy covers every write path: auto-capture, Dream ingest **and** explicit `memory_remember` tool writes (the stored card text is the gated text).
- Audit files are append-only and record card ids + actions, never content; every write is atomic (temp+rename); concurrent writes never lose data.
- **Failure containment**: one corrupt card file is skipped (with a single warning) instead of bricking recall/status/Dream; a torn inbox or access-log line is skipped and — for the inbox — quarantined (audited `op: quarantine`, offset advances past it), so a kill -9 mid-append can never wedge the store.

### Rules layer

- `## Memory` sections in the user-level `$DSH_HOME/AGENTS.md` and project-level `AGENTS.md`/`CLAUDE.md` may define deny rules (e.g. `deny: salary`). They stack on top of the policy gate and may only be stricter — they can never weaken the secret gate.

### Memory page (GUI)

The agent tools can only see the current project + global store — other project stores are invisible to the tool path. The Memory page closes that gap:

- **Entry**: Settings → Memory (a standalone settings-nav page, the `settings.section` slot, order 25).
- **Overview**: totals (live / superseded / pending / archived / bytes) plus, per store, the kind histogram and top tags.
- **Browsing**: every store (global + all projects), per-store search (BM25 + tag boost, the same scoring as recall) with kind and tag filters, full card detail (every front-matter field), the pending-capture inbox (only unconsumed lines — what the next Dream run will actually ingest), the archive listing, and an **audit tab** (recent ops: time, op, via, id, detail).
- **Writing**: a "New memory" form and an inline editor on the card detail both go through the same policy gate and audit as the tools (`POST /api/memory/card/remember`, `POST /api/memory/card/update`); an edit writes a NEW card and marks the old one superseded, so nothing is silently overwritten.
- **Per-card management**: the detail panel offers Edit / Archive / Delete (two-step confirm; delete is labelled irreversible), and the archive tab offers Restore. These are NOT a separate raw write path — they call the SAME store ops the agent tools use (`core.forgetCardIn` → `store.archiveCard` / `deleteCardHard`; `core.restoreCardIn` → `store.restoreCard`; `core.updateCard` → `store.supersedeCard`), each under the store lock as an atomic move, each audited (`op: archive/hard-delete/restore/supersede`, `via: 'client'`). The single-writer discipline and the Dream pipeline invariants are untouched.
- **Dream now**: POSTs `/api/memory/dream` and renders the returned per-store deltas.
- **Export / Import**: download the selected store (or every store) as a JSON bundle, and import one back with a per-store added/skipped/replaced/rejected report.
- **Strict store scoping**: a GUI mutation only ever touches the store it names — no fall-through to global; unknown store/card → 404, malformed id/body → 400.
- **Transport**: the Host registers 13 exact routes (7 GET: `summary|cards|card|inbox|archive|audit|export`; 6 POST: `card/forget|card/restore|card/remember|card/update|dream|import`) on the connection channel — the same mechanism as session-log-export and file-upload; the browser reaches them through the connection's auth. Without the `connection` service (headless profiles) the routes degrade to absent with a single warning.
- **Exposure**: only already-stored content is served (it passed the secret gate / PII policy before landing on disk, and the session brief already injects cards into model context). Audit rows carry ids, ops and short titles — never matched secret content. Route failures: 400/404/500 + a generic message; details stay in the Host log.

## Install

```powershell
# link install (development) or package name
dsh plugin add link:D:/path/to/dsh-memory --profile web
# restart dsh web to pick it up
```

The composition row can override the auxiliary LLM route:

```yaml
# == dsh-memory
- id: dsh-memory
  name: dsh-memory
  llm:
    provider: deepseek
    model: deepseek-v4-flash
```

## Tools (9)

| Tool | Purpose |
| --- | --- |
| `memory_remember` | Store one durable memory (fact/preference/decision/procedure/commitment/observation/summary), scope `project`/`global`/`auto`; honors the live `redact.pii` policy and reports masked categories as `piiWarnings`. Pass `supersedes=<id>` to correct an older memory, `ttlDays` for a validity window. |
| `memory_recall` | Ranked recall (project + global by default; `scope: "all"` searches every known project store). Filters: `kind`, `tags`, `since`, `minImportance`, `store`, `includeSuperseded`; `expandLinks` promotes 1-hop graph neighbours. |
| `memory_get` | Read one card in full by exact id (body, metadata, link graph, supersede pointers). |
| `memory_update` | Write a corrected version of a card: the old one is kept on disk as history and stops being recalled (bitemporal supersede). Policy-gated like `memory_remember`. |
| `memory_forget` | Archive (default, recoverable) or hard-delete by exact id. Forget-by-query is a **dry run** unless `confirm=true`, so nothing destructive is ever implied by a fuzzy match. |
| `memory_gc` | Capacity cleanup: archive stale low-value cards, enforce the live-card ceiling, prune the oldest archived cards and the audit/access logs, compact the consumed inbox. **Dry run** unless `confirm=true`. |
| `memory_drop_store` | Permanently delete ONE project store (cards, archive, Dream history, inbox, index + its registry entry). Dry run unless `confirm=true`; the global store can never be dropped. |
| `memory_status` | Per-store card / archived / superseded counts, pending inbox, kind histogram, top tags, bytes, totals, last Dream run. Works when memory is disabled. |
| `memory_dream` | Trigger background consolidation (ingest, dedup, decay, relink, conflict, maintenance, reindex), or read its status. |

## Composer commands (DSH `commands`)

Typed by the human, executed on the Host without a model turn. **One command**, `/memory`, with subcommands — the row's description and input hint are Chinese because DSH renders a host command's copy verbatim (a third-party command gets no per-locale lookup), and Chinese subcommand aliases are accepted alongside the English tokens:

```
/memory                     store + Dream status (bare invocation)
/memory status   | 状态      per-store counts, pending captures, last Dream
/memory recall <query>  | 召回   ranked recall over this project + global
/memory search <query>  | 搜索   recall across every known store
/memory remember <text> | 写入   store a durable memory
/memory forget <id>     | 遗忘   archive one memory (recoverable)
/memory gc [confirm]    | 清理   capacity cleanup (dry run unless confirmed)
/memory dream           | 整理   run one Dream consolidation now
/memory help            | 帮助   usage
```

The policy gate covers the command path too: a blocked write returns `Blocked by policy: <pattern-names>` and never echoes the matched content.

No command icon: the composer menu takes a row's icon either from a client-side `CommandContribution` (`ui-commands`) or from the first-party `HOST_FACES` map, and a contribution may not share a name with a host command (the client throws `contribution /<name> collides with a host command`). An icon is therefore only reachable by moving `/memory` entirely to the client, which would lose typed subcommands, result text, and availability outside the Web client — not worth it.

## Settings (namespace `dsh-memory`, GUI: Plugins → dsh-memory → Configure)

DSH 0.1.7 projects a plugin's own `Config` through `ctx.settings`, and the form namespace is the **Loader row id** — for this bundle that is `dsh-memory` (the package name). Every section below is declared `.volatile()`, so a save commits into the running row's references without remounting it; the profile patch (`$DSH_PROFILE_DIR/cordis.patch.yml`) is the user layer, this bundle's `cordis.patch.yml` is the composition layer, and the schema defaults below are the last layer. The same values are readable/writable from the settings document, so `dsh` CLI and GUI edits are the same write.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; off → no capture, no injection, tools report disabled |
| `capture.mode` | `auto` | `off` never / `explicit` explicit-only (no auto-capture at all) / `auto` turn-end extraction |
| `capture.useLlm` | `true` | extraction uses the user LLM route |
| `capture.heuristic` | `true` | rule-based intent extraction on user statements |
| `capture.llmMaxCallsPerSession` | `20` | ceiling on auxiliary extraction calls per session (`0` = unlimited). The pass re-reads the conversation tail, so a skipped turn is covered by the next call |
| `capture.llmMinIntervalMs` | `30000` | minimum spacing between two extraction calls in one session (`0` = none); collapses a fast back-and-forth into one call instead of one per turn |
| `capture.turnTailChars` | `20000` | tail chars of a turn fed to extraction |
| `capture.minTurnContentChars` | `120` | turns shorter than this are never captured |
| `capture.compaction` | `true` | stage the harness's compaction summary as a `summary` candidate |
| `capture.compactionMaxChars` | `4000` | byte cap for one compaction-summary candidate |
| `redact.pii` | `redact` | `off` / `warn` (audit only) / `redact` (mask) |
| `dream.enabled` | `true` | Dream switch |
| `dream.useLlm` | `true` | LLM passes (summarize/conflict); off = heuristics only |
| `dream.intervalMinutes` | `30` | idle-tick cadence (min 5) |
| `dream.maxLlmCalls` / `maxWallMs` | `40` / `600000` | per-run LLM call budget / wall-clock budget |
| `dream.requestSeq` | `0` | GUI "Dream now" monotonic trigger: the form writes it and the row's `loader/volatile-update` listener fires the run (the Memory page prefers `POST /api/memory/dream` and falls back to this) |
| `brief.enabled` / `maxBytes` | `true` / `4096` | session brief switch / injected byte cap |
| `brief.projectK` / `globalK` | `12` / `8` | max project / global memories injected |
| `recall.k` | `8` | default result count for `memory_recall` / `/memory recall` |
| `recall.expandLinks` / `linkDecay` | `true` / `0.5` | 1-hop graph expansion of the ranking and its promotion factor |
| `recall.briefIncludeSuperseded` | `false` | include superseded cards in the session brief |
| `commands.enabled` | `true` | register `/memory` (the only command; subcommands cover the old `/remember`) |
| `budget.maxCardBytes` / `maxInboxLines` | `4096` / `1000` | per-card byte cap / inbox line cap (Dream compacts the **consumed** head after each run; the unconsumed tail is never dropped) |
| `maintenance.enabled` | `true` | run the capacity-maintenance pass at the end of every Dream run |
| `maintenance.staleDays` / `staleMaxImportance` | `180` / `6` | archive a live card untouched this long when its importance is ≤ the ceiling (`staleDays: 0` disables; `preference`/`commitment` are exempt) |
| `maintenance.maxLiveCards` | `2000` | live-card ceiling per store; past it the lowest-value cards are archived (standing kinds last) |
| `maintenance.maxArchivedCards` | `2000` | archived-card ceiling per store; the **oldest** are hard-deleted past it |
| `maintenance.maxAuditLines` / `maxAccessLines` | `4000` / `4000` | log line ceilings per store (newest lines are kept) |
| `maintenance.maxInboxBytes` | `1000000` | inbox byte ceiling per store (the consumed head is dropped first) |
| `llm.provider` / `model` | `''` | per-field override. Resolution order, first non-empty per field: ① this setting → ② the deployment's live default model (`ctx.agentDefaultModel.currentSelection()`, so the plugin rides the route the agent itself uses) → ③ this plugin's shipped fallback route (`deepseek` / `deepseek-v4-flash`). An empty setting inherits; the composition row may pin the route instead |
| `llm.maxOutputTokens` / `timeoutMs` | `2000` / `60000` | per auxiliary call: output cap / deadline |

## Capacity & cleanup

Memory that only ever grows makes every recall, Dream run and index write slower, so the plugin is **bounded** rather than cumulative:

- **Bounded hot paths.** Recall ranks a *capped* candidate pool and the greedy MMR loop stops after `k` picks (the old shape ranked the entire corpus on every call and was effectively cubic). Dream's dedup builds one token set per card instead of rebuilding them for every inbox entry; relinking is driven by a tag inverted index instead of an all-pairs scan; the conflict pass has a comparison ceiling. Every long pass yields to the event loop at most once per 8 ms, so a big consolidation never freezes the harness.
- **Incremental index.** `index.json` is updated per card — with exact `docCount` / `avgDocLen` / `df` maintenance — instead of re-reading every card file on every write. It is written compact (not pretty-printed), and each card's persisted token array is capped.
- **Automatic maintenance** (pass 6 of every Dream run, `maintenance.*`): stale low-importance cards are archived, the live-card ceiling is enforced by evicting the lowest-value cards, and the archive / audit / access / inbox budgets are pruned. The pass honours the run's wall-clock budget (a truncated sweep simply resumes next run) and every ceiling is editable in **Plugins → dsh-memory → Configure** (groups *Write budgets* and *Capacity & cleanup*).
- **Bounded write bursts.** A fresh large store changes every card's links at once; the relink pass writes at most 500 cards per run (idempotent, so the remainder converges on later runs), and the auxiliary extraction call is throttled per session (`capture.llmMaxCallsPerSession` / `llmMinIntervalMs`) so a long session no longer fires one extra model call per turn.
- **On demand**: the `memory_gc` tool and `/memory 清理 [slug] [confirm]`. Both are **dry runs** unless confirmed, and report exactly what would be archived, pruned and how many bytes that reclaims.
- **Full reset**: delete `$DSH_HOME/memory/projects/<slug>` (or `$DSH_HOME/memory/global`) to erase that store by hand; `memory_drop_store` / `/memory 删除库 <slug>` does it for one project store and cleans up the registry entry too.

Nothing is lost silently: card sweeps **archive** (the file moves to `archive/` and is restorable from Settings → Memory → Archive); only the archive/log prunes are irreversible, and only past their configured ceilings.

## Export & import

- **Export**: `GET /api/memory/export[?store=<slug>][&liveOnly=1]` returns a self-describing bundle (`{format:"dsh-memory-export", version, schema, stores:[{slug,kind,projectPath,cards,archived}]}`); the Memory page downloads it as a JSON file.
- **Import**: `POST /api/memory/import` with that bundle is **additive and idempotent** — a card already present with identical content is skipped, a same-id card with different content is replaced, and every incoming card is re-validated through the current secret/PII gate before it can reach disk (an imported bundle can never reintroduce a credential the current policy forbids). Malformed cards are counted as `rejected` with a reason, never written.


## Development

```powershell
npm install
npm run build      # esbuild: lib/index.js (host) + lib/testing.js + lib/client.js (GUI settings card + Memory page)
npm run typecheck
npm test           # fast suite (node --test tests/**/*.test.mjs)
npm run test:scale # scale guards (tests/**/*.slow.mjs) — slow; run before shipping
npm run bench      # measure recall / write / Dream cost; `-- 3000` and `--old` to compare shapes
```

- `docs/PERFORMANCE.md` records the measured hot paths, the remaining linear shapes, the ceilings, and the design sketches (postings, sharded index, hub tags) that are deliberately **not** implemented yet — with the trigger conditions that would justify them.

- `src/` is the host plane (store / core / capture / recall / dream / tools / commands / brief / settings / browse / llm); `src/client/` is the browser plane (the plugin's own configuration form in `plugins.bundle.config` + `plugins.row.config`, and the Memory page in `settings.section`).
- Every host contribution is registered inside the service scope it needs (`ctx.inject([...])`), so any mount order works, an absent optional service is one warning, and disposal unwinds with the fiber. The row config is validated by the exported `Config` schema at mount time, and the settings form is derived from that same schema (`volatileForm`).
- Recall, the brief, Dream and the GUI all score from the derived index (`index.json` v2 keeps each card's `terms`); no read path re-opens every card file. Rules files are cached behind their mtimes. `src/browse.ts` owns the route table (`MEMORY_BROWSE_ROUTES`), which is also what the tests assert against.
- All LLM work goes through the injected `llm` service with hard deadlines; **no LLM failure is ever fatal** (a stalled stream is bounded by the per-call deadline and the single stream iterator is cancelled, never re-entered); tools return anonymous JSON-safe literals.
- npm is the canonical package manager (`package-lock.json`); line endings are pinned to LF by `.gitattributes`.

## Acceptance record (web profile, 2026-08-17)

- Row mounted: `dsh --profile web --dump-config` shows the `dsh-memory` row (with LLM route).
- Client bundle: `GET /plugins/dsh-memory/client.js` → 200, full `__ModuleLoader__` envelope.
- Settings surface: `settings.describe` returns the `dsh-memory` namespace with full defaults; nested-path `settings.mutate` set/unset verified in both directions. (Superseded by the v0.5.0 record below, which uses the entry-id namespace.)
- Tools: a real session's `memory_status` returned live data for both stores (global + auto-registered project store `D-Repos-tanke`).
- Dream: `memory_dream` in the live process finished in 35 ms, wrote the `lastDream` checkpoint, idempotent.
- Secret gate: a fake key was blocked (`blocked:true`) and never persisted.
- Session brief: agent sessions in the fresh process received the memory `<system-reminder>` section.

## Acceptance record (browse surface, 2026-09-05)

- Tests: 99/99 pass. 8 browse cases (summary dual-store counts / enabled does not gate reads / card recency order + query ranking + limit paging / detail + 404 + 400 / inbox count + truncation / route registration and disposal / absent-connection degradation / failed-registration rollback) + 3 per-card cases (archive→restore round trip + audit via=client / hard-delete is unrecoverable + audit / strict store scoping + 404/400 rejections).
- Build: `lib/index.js` (host) + `lib/client.js` (settings card + Memory page) compile; `tsc --noEmit` clean.
- Routes: the `/api/memory/*` exact routes mount on the row fiber via `connection.fetch.register` and unload with it; an absent `connection` or a failed registration degrades to a warning and never throws into an agent turn.
- Write paths: archive / delete / restore all reuse the existing store ops (atomic move under the lock + audit + index rebuild); no new raw write. `restore` is a new audit op folded into the `AuditOp` union.
- End-to-end (Settings → Memory page rendering + live data + the archive/delete/restore click flow) needs a manual check after a web-profile restart; this record covers the host route layer and the client bundle layer.

## Acceptance record (resilience hardening, 2026-09-06)

Audit-driven fixes (see `docs/AUDIT.md`, findings F1–F17); no behavior outside the listed findings changed.

- Tests: 118/118 pass (99 baseline + 19 new regression cases: corrupt card ×3, malformed inbox quarantine ×2, quarantine offset alignment, inbox compaction, pending-inbox semantics, redact.pii modes ×4, forget id validation, registry race, registry no-rewrite, deferred index rebuild, no-LLM capture audit ×2, PII near-miss negatives; plus one existing stalled-stream case strengthened to assert the single iterator is cancelled exactly once).
- Hardening: corrupt card files skip with one warning (no bricking); torn JSONL lines skip; malformed inbox lines quarantine (audited, offset advances); `budget.maxInboxLines` enforced by compaction of the consumed head only; `pendingInbox` = unconsumed lines everywhere; `redact.pii` honored on explicit remember writes (stored text is the gated text); `forget`/browse reject malformed and traversal ids (400/no-op, never a filesystem probe); project registry RMW is lock-serialized with orphan-lock healing and the slug is cached per process (no rewrite storm); the capture LLM pass skips the per-turn audit line when the service is absent; stalled LLM streams are deadline-bounded on a single iterator; store locks wait 10 s (was 2 s) for the rebuild critical section.
- Dead code removed (F11): the unimplemented "promotion" feature (`promotionEligible`, `promoteSessions` rules, `op: 'promote'`, `loadAgentRules`) is gone; AGENTS.md `### 晋升` sections fall back to free-form notes. `AuditOp` gains `quarantine`.
- Docs: settings table corrected to the real defaults (`llm.maxOutputTokens` 2000, `timeoutMs` 60000) and the three-stage LLM route resolution; the Memory page copy no longer claims read-only.
- Hygiene: `pnpm-lock.yaml` removed (npm canonical), `.gitattributes` pins LF.
- `npm run typecheck` clean; `npm run build` → lib/index.js + lib/testing.js + lib/client.js.

## Acceptance record (v0.3.0 — DSH-native upgrade, 2026-09-17)

**Breaking changes** (all deliberate, all documented above): card/index schema v1 → v2 (`supersededBy`, index `terms`/`bytes`); Dream's LLM conflict pass supersedes the loser instead of archiving it; forget-by-query requires `confirm=true`; `capture.mode='explicit'` now really disables auto-capture; `StatusReport` gained `totals`/`kinds`/`topTags`/`superseded`/`bytes` (additive); the route table grew from 7 to 13.

- **Cordis lifecycle**: every contribution registers through `ctx.inject([service])` (tools / commands / connection / timer / systemPrompt), so mount order no longer matters and late-arriving optional services still bind. The row config is validated by an exported `Config` schema. Verified by the fake-ctx E2E (`apply()` against structural fakes).
- **Index v2 + self-heal**: `terms`/`bytes`/`supersededBy` in `index.json`; a v1 index is rebuilt on first read; a card file added/removed/renamed outside the store is detected by one `readdir` per cache miss and triggers a rebuild. Recall/Dream/brief/GUI no longer read every card file.
- **Bitemporal supersede**: `memory_remember{supersedes}`, `memory_update`, and Dream's conflict pass all go through `store.supersedeCard` (atomic `validUntil` + `supersededBy`, forward link on the winner, audit `op:supersede`); `passesFilter` makes supersession a read-path invariant, overridable with `includeSuperseded`.
- **New surfaces**: the `/memory` composer command (DSH `commands` service; one command with Chinese row copy and Chinese subcommand aliases); `compaction/summary` → `summary` candidate capture; 6 new fetch routes (audit, export, card/remember, card/update, dream, import).
- **Safety**: import re-validates every card through the current policy gate; forget-by-query is a dry run; malformed ids never reach a filesystem join.
- **Verification**: `npm run typecheck` clean; `npm run build` → lib/index.js + lib/testing.js + lib/client.js; `npm test` → **138/138** (118 baseline + 20 new v3 cases covering index migration, self-heal, supersede paths, filters, link expansion, export/import, dry-run forget, status shape, compaction capture, the command surface and the new routes; plus tool-boundary cases for `memory_get` / `memory_update` / filtered recall in the wiring E2E).
- **Live acceptance (web profile, upgraded in place)**: the bundle installed and activated as `include:dsh-memory` (`fiberPhase: active`), recorded in the profile's `dsh.profile.bundles` and `dependencies` so it survives a restart, with zero activation warnings. The plugin's own tools then ran against the REAL store: `memory_status` reported the new shape (`schema: 2`, `totals`, and per-store `superseded`/`kinds`/`topTags`/`bytes`) across **7 stores / 441 cards**, i.e. the v1→v2 index migration completed silently on existing data; `memory_recall` with `scope:"all"` searched every store and the `minImportance`/`scope` filters composed; `memory_get` returned a full pre-v2 card with `supersededBy: null`, proving backward compatibility on real files.
- **Environment note (not a plugin defect)**: this machine's sandbox silently swallows symbolic-link creation (`mklink /D` reports success, the link never appears; junctions work). pnpm therefore records the dependency but never materializes the top-level `node_modules` entry, so `plugin_manager install_bundle` fails resolution on the first attempt. Repair: create `…/profiles/web/node_modules/dsh-memory` as a **junction** to the repo, then re-run `plugin_manager install_bundle` — pnpm leaves the existing entry alone and activation proceeds. The Memory page and `/memory` command need a human in the browser/composer; this session had no browser control and every HTTP route is auth-gated (401), so those two surfaces are covered by the client bundle build + the host route/command tests, not by a click-through.

## Acceptance record (v0.4.0 — capacity & performance hardening, 2026-09-25)

**Problem**: memory only ever grew; once a project store reached hundreds-to-thousands of cards, dsh became visibly laggy.

**Root causes** (all of it ran synchronously on the harness's own event loop):

1. `rankWithMmr` ran a greedy MMR over the ENTIRE candidate set and only then did `slice(0, k)` — with the inner loop also walking the selected set, that is **O(N³)**, on every recall (and twice per session for the brief). Measured at 1000 cards: **130.8 s** for one ranking.
2. Dream's relink pass compared every card against every other card AND built `new Set(tokens)` for every pair — O(N²) set constructions.
3. Dream's dedup pass rebuilt every card's token set for EVERY inbox entry — O(entries × cards) set constructions.
4. Every explicit write (`remember`/`update`/`forget`/`restore`) ran a full `rebuildIndex` (O(N) file reads + a multi-MB JSON serialization).
5. Unbounded growth: no live-card ceiling (only `observation` decayed at 14 days), an audit log that was never trimmed, an access log cleared only by Dream, an inbox bounded by lines alone (each up to 20 KB), and an index carrying every card's `terms` and written **indented**.
6. Whole-file reads on hot paths: `inboxLineCount` on every tick/status; `readAuditTail` parsed the entire audit log to show its last 50 rows.

**Fixes**:

- **Bounded recall**: the candidate pool is cut by score (≥240 or 12×k) and MMR stops after k picks → O(pool·k). At 3000 cards MMR is 12 ms and `core.recall` is 36–52 ms end-to-end, essentially independent of N.
- **Bounded Dream**: one token set per card per run; relinking driven by a tag inverted index (same semantics: ≥2 shared tags, top 5 by shared count); the conflict pass gained a token-length prefilter and a 20 000-comparison ceiling; every long loop yields to the event loop at most once per 8 ms.
- **Incremental index**: per-card updates with exact `docCount`/`totalTokens`/`df` maintenance, compact (non-indented) writes, a per-card `terms` cap of 1024, and an automatic full-rebuild fallback for an index written without `bm25.totalTokens`.
- **Batching**: `patchCards` writes a whole batch under one lock; card file I/O runs 16-wide (3000-card rebuild 1.26 s → 0.48 s); recall counters are buffered in-process and flushed in batches (which also removed a floating promise racing store teardown).
- **In-place index delta & batched sweeps**: the per-card index update no longer copies `cards`/`df` (that was O(cards + vocabulary) *per write* — it now costs O(changed card)); `archiveCards` + `auditMany` move a bulk sweep under one lock / one index update / one audit append per 256 cards, which cut the first Dream on an over-cap 3000-card store from 13.5 s to **6.5 s**.
- **Bounded growth**: new `maintenance.*` ceilings enforced by Dream's pass 6; real tail reads and trimming for the audit/access logs; an inbox bounded by lines AND bytes; a ceiling on archived cards.
- **Bounded write bursts & per-turn cost**: Dream's wall-clock budget now reaches the decay/relink/maintenance passes (a truncated pass resumes next run) and the relink write phase is capped at 500 cards per run; the auxiliary capture call is throttled per session (budget + minimum interval) instead of firing once per turn; the scoring corpus is cached per index object so recall no longer rebuilds a Map of every card; and the `budget.*` / `maintenance.*` knobs are now editable in the GUI settings card.
- **Cleanup surfaces**: the `memory_gc` tool and `/memory 清理 [slug] [confirm]` (dry run by default, reporting per-store archivals, prunes and reclaimed bytes); card sweeps always ARCHIVE and stay restorable from the GUI archive tab.

**Measured** (local Windows, N=1000): MMR 124 282 ms → **4 ms**; relink 5 179 ms → 330 ms (≈16×); one write 153 ms (full rebuild) → 34 ms (incremental). At N=3000 recall is 27–53 ms and a steady-state Dream is **2.9 s**. Full profile, the remaining linear shapes, and the deferred design sketches are in `docs/PERFORMANCE.md`.

- **Breaking changes**: `StoreDreamResult` gained `pruned`; `StoreMaintenanceResult` gained `truncated`; `archiveCard`/`deleteCardHard`/`restoreCard` gained `opts.rebuild`; new `capture.llmMaxCallsPerSession`/`llmMinIntervalMs`, new `maintenance` settings section, new `memory_gc` tool, new `/memory 清理` subcommand; index schema stays 2 (new optional `bm25.totalTokens`).
- **Verification**: `npm run typecheck` clean; `npm run build` → lib/index.js + lib/testing.js + lib/client.js; `npm test` → **162/162** fast cases (147 baseline + 15 new: maintenance policy, dry run vs apply, archive/log budgets, inbox drops only the consumed head — by line and by byte — a deadline-truncated sweep, incremental index deep-equals a full rebuild, legacy-index upgrade, `memory_gc`, `/memory 清理`, capture-call throttling by budget/interval/session) plus `npm run test:scale` → **3/3** scale guards. `npm run bench` reproduces every number above.

## Acceptance record (v0.5.0 — DSH 0.1.7 adaptation, 2026-09-22)

The harness moved from the standalone settings-namespace registry to **the plugin's own Config** (`describe`/`update`/`mutate` address a Loader entry, only `.volatile()` fields are editable, and edits commit into the running fiber), and it retired the shared `{kind:'plugin'}` message source in favour of producer-owned kinds. This release adapts to both.

**Breaking changes**

- The settings namespace is the **row id** `dsh-memory`, not `memory`; the plugin's whole configuration is now its exported `Config` schema (`MemorySettingsSchema`), one volatile field per section. There is no `settings.register`/`scope.get()` any more, and the composition row no longer carries an `llm:` route — an empty `llm.provider`/`model` inherits from `ctx.agentDefaultModel` and then from the plugin's shipped fallback.
- Messages this plugin produces are attributed `{ kind: 'dsh-memory' }` (`form: 'recall'` for the session brief). The durable brief dedup still recognizes the two legacy spellings (`plugin:dsh-memory` as the session-format reader namespaces a released session, and a raw `{kind:'plugin', plugin:'dsh-memory'}`), so upgrading never re-briefs a resumed session.
- Capture classifies human text by `source.kind === 'user'` — the only source that means "a person typed this" in the producer-owned vocabulary — instead of blacklisting `plugin`/`tool`.
- The browser half registers the configuration form into the Plugins page's own seats (`plugins.bundle.config` keyed by package name and `plugins.row.config` keyed `dsh-memory#dsh-memory`) and reads it through `ctx.configForms.get('dsh-memory')`; the old `settings.plugins.tab` tab is gone. The card keeps its staged fields, its groups, and Save/Discard, and now renders inline (the page draws the title and one-liner) with a `view: 'summary'` one-liner for the row.

**Verification**

- `npm run typecheck` clean; `npm run build` → lib/index.js + lib/testing.js + lib/client.js; `npm test` → **173/173** fast cases (162 baseline, re-based onto the new fixtures: every genuine-user fixture now carries `{kind:'user'}`, the checkpoint marker case asserts the marker on a human-sourced message, and the wiring E2E drives a fake volatile Config; plus 7 settings-contract cases in `tests/v5.test.mjs` and 4 browser-half cases in `tests/client.test.mjs` that materialize the built bundle without a browser).
- **Live acceptance (web profile, upgraded in place)**: `plugin_manager install_bundle link:D:/Repos/dsh/dsh-memory` → `application: applied`, and the composed row reports `Config.listConfigs` entry `include:dsh-memory` with `status: schema` and the projected form showing all ten sections `x-cordis.volatile: true`. The row's nine tools (`Tool.listTools`) and the browser registrations (`Slots.listSubTree` → `settings.section` occupant `memory`, `plugins.row.config` occupant `dsh-memory#dsh-memory`, both `active`) are live in the running Host and page.
- **Live settings round-trip**: a composition-layer write into `$DSH_PROFILE_DIR/cordis.patch.yml` (`enabled: false`) flipped `memory_status` to `enabled:false` in the running process with no remount, and a `dream.requestSeq: 5` bump in the same config layer made the row's `loader/volatile-update` listener run Dream immediately (`lastDream` went from `""` to a real timestamp). The temporary override was removed afterwards, leaving the profile as found.
- **Not click-verified**: this session has no browser control and the Web route is auth-gated (401), so the rendered card and the Memory page were verified through the live Client slot ledger and the client bundle build, not by clicking. `fiberPhase`/slot `active` state and the Host-side Config round-trip are the evidence.
