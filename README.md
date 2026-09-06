# dsh-memory

Durable memory for DeepSeek Harness (DSH): **global memory + per-project memory + rules layer + background "Dream" consolidation**.
Production-grade: 118/118 tests green, end-to-end acceptance passed in the web profile. (中文说明见 [README.zh.md](README.zh.md))

## Design

Borrows the proven pieces from mainstream approaches, with deliberate trade-offs:

| Approach | Borrowed |
| --- | --- |
| [Generative Agents](https://arxiv.org/abs/2504.13171) (memory stream + reflection) | Memory cards + periodic reflection (Dream); recall scored by relevance / recency / importance |
| [Mem0](https://memo.d.foundation) / [Letta](https://docs.letta.com) (add/extract/consolidate pipeline) | Two-phase writes: auto-extraction → candidate pool (inbox) → background merge/dedupe/archive; write path decoupled from consolidation |
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
    index.json             # derived index (rebuildable at any time)
  projects/<slug>/         # one store per project (slug derived from the path)
  projects.json            # project path ↔ slug registry
```

### Recall & injection

- `memory_recall` tool: scored recall over the current project store + the global store (relevance / time decay / importance).
- **Session brief**: one budgeted `<system-reminder>` per agent session at startup (project Top-K=12 + global Top-K=8, total ≤ 4096 bytes) — keeps the KV-cache prefix stable.
- A `memory:usage` system-prompt section (order 150).

### Auto-capture (two-phase)

1. Turn-end event → heuristic extraction (intent/preference sentences) → candidates into `inbox.jsonl`;
2. When `capture.useLlm` is on, a second extraction/merge pass over the user-configured LLM route (failures warn only, never block).

The policy gate runs before anything is staged, so the candidate pool only ever contains allowed content.

### Background Dream consolidation (LLM passes on by default)

- Triggered on idle ticks (default 30 min, min 5) + a 30 s startup sweep + the GUI "Dream now" button (monotonic `dream.requestSeq`).
- **summarize**: when a store has ≥8 cards, the Top-40 produce/refresh `dream/summary.md`;
- **conflict**: candidate pairs with Jaccard similarity in 0.3–0.85 (max 4 pairs/run) are arbitrated by the LLM; the loser is archived and audited;
- Budgets: `maxLlmCalls` (40) and `maxWallMs` (600 s) per run, per-card checkpoints (`inboxOffset`) — **idempotent and crash-recoverable** (re-runs are side-effect-free).
- `dream.useLlm=false` degrades to heuristics only (decay / dedupe / archive).

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
- **Browsing**: every store (global + all projects, with card / pending / archived counts), per-store search (BM25 + tag boost, the same scoring as recall), full card detail (every front-matter field), the pending-capture inbox (only unconsumed lines — what the next Dream run will actually ingest), the archive listing, and Dream state + "Dream now" (reuses the `dream.requestSeq` trigger).
- **Per-card management (v2, strictly through the existing write paths)**: the detail panel offers "Archive" and "Delete" (two-step confirm; delete is labelled irreversible), and the archive tab offers "Restore". These mutations are NOT a new raw write path — they call the SAME store ops the agent tools use (`core.forgetCardIn` → `store.archiveCard` / `deleteCardHard`; `core.restoreCardIn` → `store.restoreCard`), each under the store lock as an atomic move, each audited (`op: archive/hard-delete/restore`, `via: 'client'`). The single-writer discipline and the Dream pipeline invariants are untouched.
- **Strict store scoping**: a GUI mutation only ever touches the store it names — no fall-through to global; unknown store/card → 404, malformed id/body → 400.
- **Transport**: the Host registers seven exact routes (`/api/memory/summary|cards|card|inbox|archive` GET + `/api/memory/card/forget|restore` POST) on the connection channel — the same mechanism as session-log-export and file-upload; the browser reaches them through the connection's auth. Without the `connection` service (headless profiles) the routes degrade to absent with a single warning.
- **Exposure**: only already-stored content is served (it passed the secret gate / PII policy before landing on disk, and the session brief already injects cards into model context); audit content is never served. Route failures: 400/404/500 + a generic message; details stay in the Host log.

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

## Tools (5)

| Tool | Purpose |
| --- | --- |
| `memory_remember` | Store one durable memory (fact/preference/decision/procedure/commitment/observation/summary), scope `project`/`global`/`auto`; honors the live `redact.pii` policy and reports masked categories as `piiWarnings` |
| `memory_recall` | Recall project + global memories for a query |
| `memory_forget` | Archive (default) or hard-delete by id or top-3 query match |
| `memory_status` | Store counts, archived count, inbox, last Dream run |
| `memory_dream` | Trigger background consolidation manually |

## Settings (namespace `memory`, GUI: Settings → Plugins → dsh-memory)

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; off → no capture, no injection, tools report disabled |
| `capture.mode` | `auto` | `off` never / `explicit` explicit-only / `auto` + turn-end extraction |
| `capture.useLlm` | `true` | extraction uses the user LLM route |
| `capture.turnTailChars` | `20000` | tail chars of a turn fed to extraction |
| `capture.minTurnContentChars` | `120` | turns shorter than this are never captured |
| `redact.pii` | `redact` | `off` / `warn` (audit only) / `redact` (mask) |
| `dream.enabled` | `true` | Dream switch |
| `dream.useLlm` | `true` | LLM passes (summarize/conflict); off = heuristics only |
| `dream.intervalMinutes` | `30` | idle-tick cadence (min 5) |
| `dream.maxLlmCalls` / `maxWallMs` | `40` / `600000` | per-run LLM call budget / wall-clock budget |
| `dream.requestSeq` | `0` | GUI "Dream now" monotonic trigger |
| `brief.enabled` / `maxBytes` | `true` / `4096` | session brief switch / injected byte cap |
| `brief.projectK` / `globalK` | `12` / `8` | max project / global memories injected |
| `budget.maxCardBytes` / `maxInboxLines` | `4096` / `1000` | per-card byte cap / inbox line cap (Dream compacts the **consumed** head after each run; the unconsumed tail is never dropped) |
| `llm.provider` / `model` | `''` | per-field override. Resolution order, first non-empty per field: ① this setting → ② the session's live default model (`agent-default-model` namespace, so the plugin rides the route the agent itself uses) → ③ the composition-row `llm:` route as last resort |
| `llm.maxOutputTokens` / `timeoutMs` | `2000` / `60000` | per auxiliary call: output cap / deadline |

## Development

```powershell
npm install
npm run build      # esbuild: lib/index.js (host) + lib/testing.js + lib/client.js (GUI settings card + Memory page)
npm run typecheck
npm test           # node --test tests/*.test.mjs (118 tests)
```

- `src/` is the host plane (store/capture/recall/dream/tools/brief/settings/browse); `src/client/` is the browser plane (settings card in the `settings.plugin.item` slot + the Memory page in the `settings.section` slot — browse + per-card archive/delete/restore).
- All LLM work goes through the injected `llm` service with hard deadlines; **no LLM failure is ever fatal** (a stalled stream is bounded by the per-call deadline and the single stream iterator is cancelled, never re-entered); tools return anonymous JSON-safe literals.
- npm is the canonical package manager (`package-lock.json`); line endings are pinned to LF by `.gitattributes`.

## Acceptance record (web profile, 2026-08-17)

- Row mounted: `dsh --profile web --dump-config` shows the `dsh-memory` row (with LLM route).
- Client bundle: `GET /plugins/dsh-memory/client.js` → 200, full `__ModuleLoader__` envelope.
- Settings surface: `settings.describe` returns the `memory` namespace with full defaults; nested-path `settings.mutate` set/unset verified in both directions.
- Tools: a real session's `memory_status` returned live data for both stores (global + auto-registered project store `D-Repos-tanke`).
- Dream: `memory_dream` in the live process finished in 35 ms, wrote the `lastDream` checkpoint, idempotent.
- Secret gate: a fake key was blocked (`blocked:true`) and never persisted.
- Session brief: agent sessions in the fresh process received the memory `<system-reminder>` section.

## Acceptance record (browse surface, 2026-09-05)

- Tests: 99/99 pass. 8 browse cases (summary dual-store counts / enabled does not gate reads / card recency order + query ranking + limit paging / detail + 404 + 400 / inbox count + truncation / 7-route registration and disposal / absent-connection degradation / failed-registration rollback) + 3 per-card cases (archive→restore round trip + audit via=client / hard-delete is unrecoverable + audit / strict store scoping + 404/400 rejections).
- Build: `lib/index.js` (host) + `lib/client.js` (settings card + Memory page) compile; `tsc --noEmit` clean.
- Routes: the seven `/api/memory/*` exact routes (5 GET + 2 POST) mount on the row fiber via `connection.fetch.register` and unload with it; an absent `connection` or a failed registration degrades to a warning and never throws into an agent turn.
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
