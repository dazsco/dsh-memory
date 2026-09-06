# dsh-memory 复审报告 / Independent Review Report

- **Date**: 2026-09-06 (review round 1, task t3)
- **Reviewer**: reviewer (dsh-memory-audit-fix team)
- **Reviewed**: engineer 的 t2 实现（对 `docs/AUDIT.md` F1–F17 的修复 + browse WIP 完善），工作树 `D:\Repos\dsh\dsh-memory`（v0.2.0 WIP，git HEAD 仍为 `37101da` v0.1.1）
- **Verdict**: **pass** — 全部 blocker/high 已修复并经独立复核验证；typecheck/test/build 全部亲自重跑通过；文档/配置与最终代码一致；无削弱测试、未触碰 DSH 本体、无新建提交。

**方法**: 不复用 engineer/auditor 的结论，逐条读取 cited file:line 的代码、重跑全部验证命令、用 git diff 比对 tests/ 变更、对 `D:\Repos\deepseek-harness` 做只读洁净性检查。

---

## 1. 命令输出（复审工作树上亲自执行）

### `npm run typecheck`（→ `tsc --noEmit`）

```text
npm warn Unknown env config "manage-package-manager-versions". ...

> dsh-memory@0.2.0 typecheck
> tsc --noEmit
```

**PASS** — exit 0，零 TS 错误。

### `npm test`（→ `node --test "tests/**/*.test.mjs"`）

```text
ℹ tests 118
ℹ suites 0
ℹ pass 118
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1964.75
```

**PASS** — 118/118。build 之后复跑：仍 **118/118**（duration_ms 2205.1693）。
输出中可见点名回归用例：`F1: recall survives a corrupt card`、`F2: status pendingInbox counts only unconsumed lines (0 after Dream)`、`F3: remember honors redact.pii = warn (raw stored + names reported)`、`F7: putCard {rebuild:false} does not rewrite index.json`、`F8: concurrent registrations of colliding paths lose no entry`、`F10: forget rejects malformed and traversal ids (no-op, no throw)`。

### `npm run build`（→ `node build.mjs && tsc -p tsconfig.build.json`）

```text
> dsh-memory@0.2.0 build
> node build.mjs && tsc -p tsconfig.build.json

built lib/index.js (124539 bytes) for dsh-memory
built lib/testing.js (127707 bytes) for dsh-memory
built lib/client.js (85224 bytes) for dsh-memory
```

**PASS** — exit 0。构建产物抽查：`lib/index.js` 含全部 7 条 `/api/memory/*` 路由字面量、`quarantine` op、`waitMs: 1e4`（= 10 s store-lock，F14）；`lib/client.js` 含 `dshMemPage*` 类、`MemoryPageController`、`http://dsh.internal` fallback、`page.nav`。

---

## 2. 逐 finding 状态（F1–F17）

Severity 记号：H=high，M=medium，L=low。（审计中无 blocker。）

### F1（H）— 单张损坏卡片 brick 整个 store → **FIXED（已验证）**
- `src/cards.ts:199-215` `readCardFile` 现在 catch parse 失败并 **返回 null**，且每 (文件, mtime) 只告警一次（`corruptCardWarned` Map）。
- 全部调用方按 null 跳过：`store.ts:151-152`（rebuildIndex）、`store.ts:200-201`（cardCorpus → recall/Dream/browse cards 的公共路径）、`store.ts:244`（patchCard）、`store.ts:296-301`（restoreCard 拒绝复活损坏归档，独立回归测试覆盖）。
- 回归测试 3 条（`tests/store.test.mjs:133/157/190`）：recall 存活且不含坏卡、remember+Dream 存活、损坏归档条目不被 restore 复活。

### F2（M）— pendingInbox 无限增长 → **FIXED**
- `core.ts:496-499` status 计算 `pending = totalLines − inboxOffset`；`store.ts:348-353` `readInboxFrom` 按 offset（含坏行修正）只返回未消费尾部，`browse.ts:339-343` inbox 路由只服务 pending。
- 回归测试：`store.test.mjs:310`（Dream 后 pending=0）。

### F3（M）— remember 路径忽略 redact.pii → **FIXED**
- `tools.ts:105` 传 `piiMode: st.redact.pii`；`core.ts:229` `gateCandidate(content, rules.denyKeywords, input.piiMode ?? 'redact')`；`core.ts:245,266-267` 卡片以 **gated.text** 建卡（redact 模式落盘脱敏文本），warnings 以 `piiWarnings` 回报（`tools.ts:116`）。
- 回归测试 4 条：`store.test.mjs:209/219/229`（off 原文 / warn 原文+类别名 / 默认 redact 脱敏）+ `tests/redact.test.mjs` 新增近失阴性用例。

### F4（M）— inbox 坏行永久卡死 Dream → **FIXED**
- `fsutil.ts:75-91` `readJsonlLinesLenient`（坏行跳过并报告 1-based 行号）；`store.ts:348-353` offset 与坏行位置对齐（含 ≤offset 坏行的移位修正）；`dream.ts:249-281` 按位置序视图逐行处理，坏行 → `op:'quarantine'` 审计（`via:'system'`，内容绝不上盘）+ `consumed++` 前移；access 日志坏行宽容跳过（`store.ts:397-400`）。`types.ts:131-132` `quarantine` 并入 AuditOp。
- 回归测试 3 条：`dream.test.mjs:196/236/257`（坏行隔离不卡死 + 审计断言、access 断行、**隔离后 offset 对齐不隐藏后续新条目**——engineer 自报的 offset 对齐 bug 有专门回归）。

### F5（M）— maxInboxLines 死旋钮 → **FIXED**
- `dream.ts:457-469` 每次运行后压缩：`drop = min(total − maxInboxLines, inboxOffset)`，`compactInbox`（`store.ts:367-378`，与 pushInbox 同一 inbox 锁）只丢已消费头部，offset 在**同一次 checkpoint 写**中同步减掉。README 两语言设置表已写明该语义。
- 回归测试：`dream.test.mjs:289`（压缩后 ≤ 上限、offset 同步、pending 尾部存活）。

### F6（M）— README 默认值/路由解析错误 → **FIXED**
- `README.md:121-122`、`README.zh.md:121-122`：`2000 / 60000`，三段式解析（本设置 → `agent-default-model` 会话默认 → 组合行兜底），与 `settings.ts:79-86`、`index.ts:119-148`、`llm.ts:4-9` 实际行为一致。

### F7（M）— Dream O(N²) 重建 → **FIXED**
- `store.ts:218-253` `putCard`/`patchCard` 支持 `{rebuild:false}`；`dream.ts` 全部 mutation（304/314/343/388/433）传 false，pass 5 单次 `rebuildIndex()`（455）。
- 回归测试：`store.test.mjs:335`（rebuild:false 不写 index.json，显式 rebuild 拾回）。

### F8（M）— 注册表 RMW 无锁 + 每次重注册 → **FIXED**
- `paths.ts:105-148` 整个 RMW 包在 `withFileLock(projects.json)` 内（含孤儿锁自愈重试，锁前 `ensureDir(memoryRoot())`）；`core.ts:139-142` root→slug 进程内缓存，重复 lookup 零重写。
- 回归测试 2 条：`store.test.mjs:257`（同 slug 碰撞并发注册双存活）、`store.test.mjs:284`（5 次 lookup 注册表 mtime 不变）。

### F9（L）— 无 LLM 时逐轮审计刷屏 → **FIXED**
- `capture.ts:214-237`：`llmDeps.llm === null` 时整段（pass + 审计行）跳过；有服务时保留 ok/skipped/error 审计。
- 回归测试 2 条：`capture.test.mjs:324/381`（3 轮零 `op:'llm'` 行 + 有服务恰好 1 条 ok）。

### F10（L）— 读路径无 id 校验 → **FIXED**
- `cards.ts:184-186` 导出 `isValidCardId`（`/^m-\d{8}-[a-z0-9]{4,10}$/`）；`core.ts:401` forget 畸形/穿越 id → 空操作；`browse.ts:320-323` GET card 畸形 id → 400（良构不存在仍 404）；两个 POST 路由经 `requireId`（`browse.ts:219-224`）。
- 回归测试：`store.test.mjs:242` + `browse.test.mjs` 400 用例（173、439 行）。

### F11（L）— 死代码 + 半成品 promotion → **FIXED**
- 全部移除：`promotionEligible`（dedup.ts）、`promoteSessions` 解析（rules.ts 现无此字段，`### 晋升` 段退化为 notes，有测试钉住）、`loadAgentRules`（rules.ts）、`export { fs as nodeFs }`（cards.ts）、未用的 `cardTokenCount` import（store.ts）、`SEP`（paths.ts）、`MEMORY_KINDS_LOCAL`（dream.ts 直接用 `types.ts` 的 `MEMORY_KINDS`）；`settings.ts:35` 注释更正为 "summarize/conflict"。

### F12（L）— 陈旧注释/文案 → **FIXED**（逐项核对）
- `index.ts:191-194` 与文件头：seven routes（5 GET + 2 POST）✓；`browse.ts:245-248` docstring "seven" ✓；`retrieval.ts:94` `maxRel` 已删 ✓；`retrieval.ts:65` half-life ≈ 5.8 days ✓；`tests/browse.test.mjs:215` 标题 "mounts 7 exact routes (5 GET + 2 POST)" ✓；locales `page.description` 不再声称只读（zh/en 均更新）✓；`README.md:133`/`README.zh.md:133` "browse + per-card archive/delete/restore" ✓；`tools.ts:70` kind 描述含 `summary` ✓。全仓 grep 无残留 "read-only Memory page" 类文案（仅存 settings 卡 `chrome.readOnly` 连接只读提示，属正当用途）。

### F13（L）— 超时路径重入迭代器 → **FIXED**
- `llm.ts:100` 单次显式 iterator，`llm.ts:131` 取消走同一 iterator 的 `return?.()`，注释明确不再重入。既有 stalled-stream 用例**加强**为断言 `iteratorCount === 1` 且 `returnCount === 1`（`llm.test.mjs:228-234`）——是加强不是削弱（diff 已核）。

### F14（L）— 2 s 锁等待 → **FIXED**
- `store.ts:57` `STORE_LOCK_WAIT_MS = 10_000`，`lockedOn` 两处均显式 `waitMs`；构建产物确认 `waitMs: 1e4`。

### F15（L）— 进程级增长（informational）→ **NOT ADDRESSED（合理延期）**
- 审计自身结论即 "none required for v1"；`injected` Set 仅用于单进程内去重。接受。

### F16（L）— 仓库卫生 → **FIXED（提交除外，属 captain 决策）**
- `pnpm-lock.yaml` 已删（`package-lock.json` 为规范，README 两语言声明一致）；`.gitattributes`（`* text=auto eol=lf` + 二进制例外）已加；WIP 保持未提交 —— 符合 "captain decides on committing" 的审计建议，且复审规则禁止 reviewer 提交。

### F17（M）— 测试覆盖缺口 → **FIXED**
- 缺口 1–6、8 全部落地（对应 F1/F4/F2/F3/F10/F5/F8 的回归用例，见上）；缺口 9 落地（redact 近失阴性 fixture）。缺口 7（React UI 单测）审计标注 "acceptable for v1"，未做 —— 与审计一致，非缺陷。
- **tests/ 未被削弱（git diff 核对）**：`7 files changed, 617 insertions(+), 7 deletions(-)`。删除行仅 3 类：① llm stalled-stream 用例旧 mock 的 `return:` 行（被加强版替换）；② rules 用例中 `promoteSessions` 断言（随 F11 功能删除而移除，替换为"不再解析"的**负面**断言）；③ simulate 一处 payload 字段调整。无任何行为测试被删除或放松。

---

## 3. browse WIP 完整性（端到端核验）

- **Host 路由**（`src/browse.ts`）：7 条 exact 路由（summary/cards/card/inbox/archive GET + card/forget、card/restore POST），`requestBody:'buffered'`，`registerBrowseRoutes` 含 fiber 级 disposal + 注册失败部分回滚 + connection 缺失降级告警（428-461 行）。构建产物含全部 7 条路径。
- **失败契约**：400（坏参数/体/畸形 id）/ 404（未知 store/card）/ 500（泛化消息）；`safe()` 包装 + 4 KB body 上限；审计内容不下发。
- **v2 写路径**：forget/restore 走 `core.forgetCardIn` / `core.restoreCardIn` → 与 agent 工具同一 store 操作（锁内原子移动 + 审计 `via:'client'` + 索引重建），严格单库无回落。
- **Client**（`src/client/`）：`settings.section` 页（id `memory`, order 25, label 走 locale）+ `settings.plugin.item` 卡（key `memory`）在 `client/index.ts` 注册；`memory-page.tsx` 使用全部 7 条路由，两步确认、5 s 解除武装、200 ms 搜索防抖、6 s 错误提示，所有定时器在 effect teardown 清理（465-472 行 + cards effect 324-327 行）；`hostBase()` 用 `http://dsh.internal` null-origin fallback；`MemoryPageController.dreamNow` 复用 `dream.requestSeq` 触发。
- **i18n**：`locales.ts` zh/en 全量 `page.*`/`kind.*` 键齐全，`en: typeof zh` 使缺键成为编译错误（typecheck 通过即证明一致）。
- **样式**：`styles.ts` 含页面所用全部 `dshMemPage*`/`dshMemStore*`/`dshMemPane*`/`dshMemCard*`/`dshMemDetail*`/`dshMemInbox*`/`dshMemArchive*`/`dshMemAction*` 类（69 处定义核对）。
- **测试**：`tests/browse.test.mjs` 覆盖 summary/卡片排序分页/详情 404+400/inbox/归档/7 路由注册与解除/降级/回滚/v2 归档-恢复往返/硬删不可逆/严格单库（含 malformed id → 400）。118/118 通过。

**结论：browse 功能完整、内外一致、接线/文案/样式/测试齐全。**

## 4. 文档与配置一致性

- `package.json`：version 0.2.0；exports `.` + `./client` + `./package.json`（testing surface 刻意不导出，与审计 non-issues 一致）；`files`（lib/src/cordis.patch.yml/tsconfigs/READMEs/LICENSE）与 `dsh.bundle.patch`、`dsh.client.inject` 均与现状相符；LICENSE 存在；构建后 `lib/types/index.d.ts`、`lib/types/client/index.d.ts` 存在（exports types 目标真实）。
- `cordis.patch.yml`：单行 `dsh-memory`，`config.llm = deepseek/deepseek-v4-flash`，与 `index.ts:46` `DEFAULT_LLM_ROUTE` 一致；注释描述三段式路由解析，与代码一致。
- README/README.zh：设置表全部默认值与 `settings.ts` schema 逐项核对一致（含 F6 更正的 2000/60000 与 maxInboxLines 语义）；工具表 5 工具与 `tools.ts` 一致；三节验收记录（2026-08-17 / 2026-09-05 / 2026-09-06 韧性加固）与本次重跑证据吻合（118/118）。

## 5. 健壮性抽查

- **redact 无旁路**：`gateCandidate`（secrets 整条阻断 → 规则 deny → PII）在所有写路径执行且以 **gated.text** 落盘：remember（core.ts:229/245）、capture stage（capture.ts:244-260）、Dream ingest（dream.ts:284-293/323-340）。F3 修复反而堵上了原 remember 路径"闸门文本不落盘"的真 bug。`redact.ts` 本体未改动，模式集与 fail-closed 语义保持。
- **DSH 本体未动**：`git -C D:\Repos\deepseek-harness status --short` → 空（clean）。
- **无新建提交**：dsh-memory HEAD 仍为 `37101da`（2026-08-31），全部修复保持未提交工作树状态（符合任务约束）。
- **测试未被削弱**：见 §2 F17。

## 6. 残余风险（不阻断 pass）

1. **手动 GUI E2E 仍待做**：Settings → Memory 页面渲染 + 归档/删除/恢复点击流需 web profile 重启后人工确认（README 2026-09-05 验收记录第 4 条已如实标注；host 路由层与 client bundle 层已由测试/构建覆盖）。
2. **F15 未处理**：`injected` Set 与长会话事件扫描的进程级增长 —— 审计自身定性 informational、v1 无需处理，接受。
3. **WIP 未提交**：含版本 bump 的整个 v0.2.0 工作树未 commit，按审计建议留 captain 决策；若长时间搁置存在丢失风险（非代码缺陷）。
4. **打包分发的小细节**：`package.json files` 不含 `docs/`，packed 安装时 `docs/AUDIT.md`（README 有引用）不会随包发布；`link:` 安装不受影响。纯卫生项，可忽略。

---

## 判定

**pass** — 审计中唯一的 high（F1）及全部 medium/low 已按建议修复并逐条取得代码级证据；三项验证命令在复审工作树全部通过（有输出为证）；browse WIP 完整一致；README/README.zh/package.json/cordis.patch.yml 与最终代码一致；未修改 DSH 本体、无新提交、无测试削弱。不存在需要返工的未修复问题。
