# dsh-memory

Durable memory for DeepSeek Harness (DSH): **global memory + per-project memory + rules layer + background "Dream" consolidation**.
Production-grade: 63/63 tests green, end-to-end acceptance passed in the web profile. (中文说明见 [README.zh.md](README.zh.md))

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
- `redact.pii`: `off | warn (audit only) | redact (default, mask in stored text)`.
- Audit files are append-only and record card ids + actions, never content; every write is atomic (temp+rename); concurrent writes never lose data.

### Rules layer

- `## Memory` sections in the user-level `$DSH_HOME/AGENTS.md` and project-level `AGENTS.md`/`CLAUDE.md` may define deny rules (e.g. `deny: salary`). They stack on top of the policy gate and may only be stricter — they can never weaken the secret gate.

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
| `memory_remember` | Store one durable memory (fact/preference/decision/procedure/commitment), scope `project`/`global`/`auto` |
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
| `budget.maxCardBytes` / `maxInboxLines` | `4096` / `1000` | per-card byte cap / inbox line cap |
| `llm.provider` / `model` | `''` | empty = composition-row route; overrides provider/model |
| `llm.maxOutputTokens` / `timeoutMs` | `600` / `30000` | per auxiliary call: output cap / deadline |

## Development

```powershell
npm install
npm run build      # esbuild: lib/index.js (host) + lib/testing.js + lib/client.js (GUI settings card)
npm run typecheck
npm test           # node --test tests/*.test.mjs (63 tests)
```

- `src/` is the host plane (store/capture/recall/dream/tools/brief/settings); `src/client/` is the browser plane (settings card in the `settings.plugin.item` slot).
- All LLM work goes through the injected `llm` service with hard deadlines; **no LLM failure is ever fatal**; tools return anonymous JSON-safe literals.

## Acceptance record (web profile, 2026-08-17)

- Row mounted: `dsh --profile web --dump-config` shows the `dsh-memory` row (with LLM route).
- Client bundle: `GET /plugins/dsh-memory/client.js` → 200, full `__ModuleLoader__` envelope.
- Settings surface: `settings.describe` returns the `memory` namespace with full defaults; nested-path `settings.mutate` set/unset verified in both directions.
- Tools: a real session's `memory_status` returned live data for both stores (global + auto-registered project store `D-Repos-tanke`).
- Dream: `memory_dream` in the live process finished in 35 ms, wrote the `lastDream` checkpoint, idempotent.
- Secret gate: a fake key was blocked (`blocked:true`) and never persisted.
- Session brief: agent sessions in the fresh process received the memory `<system-reminder>` section.
