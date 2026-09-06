# dsh-memory

DeepSeek Harness (DSH) 的持久记忆插件: **全局记忆 + 项目独立记忆 + 规则层 + 后台 Dream 整理**。
生产级实现, 118/118 测试通过, 已在 web profile 完成端到端验收。

## 设计要点

参考了主流方案的成熟做法并做了取舍:

| 方案 | 借鉴 |
| --- | --- |
| [Generative Agents](https://arxiv.org/abs/2504.13171) (memory stream + reflection) | 记忆卡片 + 周期性反思整理 (Dream), 按相关性/时间/重要性三因子打分召回 |
| [Mem0](https://memo.d.foundation) / [Letta](https://docs.letta.com) (add/extract/consolidate 管线) | 自动抽取 → 候选池 (inbox) → 后台合并/去重/归档的两段式写入, 写入路径与整理路径解耦 |
| Claude Code 记忆惯例 (`CLAUDE.md`/`AGENTS.md` 规则) | 规则层: `$DSH_HOME/AGENTS.md` 与项目 `AGENTS.md`/`CLAUDE.md` 中的 `## Memory` 段落可追加更严格的拒绝规则 |

### 存储布局 (全部在 `$DSH_HOME/memory/`, 绝不写进项目目录)

```
$DSH_HOME/memory/
  global/                  # 跨项目全局记忆
    cards/<id>.md          # 记忆卡片 (markdown, front-matter 元数据)
    inbox.jsonl            # 候选池 (策略已清洗, 只含允许内容)
    dream/summary.md       # Dream 概览
    audit.jsonl            # 追加式审计 (只记 id 与动作, 不记内容)
    archive/<id>.md        # 归档区 (遗忘 = 移入, 可恢复)
    index.json             # 派生索引 (可随时重建)
  projects/<slug>/         # 每个项目一个独立存储 (slug 由路径确定性生成)
  projects.json            # 项目路径 ↔ slug 注册表
```

### 召回与注入

- `memory_recall` 工具: 对当前项目 + 全局库做打分召回 (相关性/时间衰减/重要性, 见 `recall.ts`)。
- **会话简报**: 每个 agent 会话启动时注入一次预算内的 `<system-reminder>` (项目 Top-K=12 + 全局 Top-K=8, 总字节 ≤ 4096), 保证 KV-cache 前缀稳定。
- 系统提示追加 `memory:usage` 使用段 (order 150)。

### 自动捕获 (两段式)

1. 轮次结束事件 → 启发式抽取 (意图句/偏好句) → 候选写入 `inbox.jsonl`;
2. 若 `capture.useLlm` 开启, 再经用户配置的 LLM 路由做一轮抽取/合并 (失败只告警, 绝不阻断)。

策略闸门在落盘前执行, 候选池天然只含允许内容。

### Dream 后台整理 (默认 LLM 通道开启)

- 空闲周期触发 (默认 30 分钟, 最小 5) + 启动 30s 巡检 + GUI「立即 Dream」(`dream.requestSeq` 单调递增触发)。
- **summarize**: 库 ≥8 卡时取 Top-40 生成/更新 `dream/summary.md`;
- **conflict**: Jaccard 0.3–0.85 的疑似冲突对 (每次最多 4 对) 由 LLM 仲裁, 败者归档并写审计;
- 预算: 每次运行 `maxLlmCalls`(40) / `maxWallMs`(600s) 双限, 逐卡检查点 (`inboxOffset`), **幂等且可崩溃恢复** (重复运行零副作用)。
- `dream.useLlm=false` 时退化为纯启发式 (衰减/去重/归档)。

### 密钥与隐私

- **内置密钥闸门恒开、不可配置**: API key、密码、token、私钥等模式在写入前拦截, 返回结构化 `blocked` 结果 (不落盘、不抛异常、不泄漏原文)。已验收: 伪造 OpenAI 风格 key → `{"blocked":true,"reason":"openai-style-key"}`。
- `redact.pii`: `off | warn(仅审计) | redact`(默认, 在存储文本中脱敏) — 策略覆盖所有写路径: 自动捕获、Dream 摄取**以及**显式 `memory_remember` 工具写入 (落盘的卡片文本即闸门处理后的文本)。
- 审计文件追加式、只记卡片 id 与动作, 不记内容; 所有写入原子 (temp+rename), 并发零丢失。
- **故障隔离**: 单张损坏卡片被跳过 (仅告警一次) 而不拖垮召回/状态/Dream; 被截断的 inbox / access 行被跳过 —— inbox 的行还会被隔离 (审计 `op: quarantine`, offset 前移), 因此写入中途 kill -9 绝不会把库卡死。

### 规则层

- 用户层 `$DSH_HOME/AGENTS.md`、项目层 `AGENTS.md`/`CLAUDE.md` 的 `## Memory` 段落可定义拒绝规则 (如 `deny: 薪酬`), 在策略闸门之上叠加, 只允许更严、不允许放宽密钥闸门。

### 记忆管理页 (GUI)

agent 工具只能看「当前项目 + 全局」, 其他项目库对工具路径永远不可见; 管理页补齐这个缺口:

- **入口**: Settings → 记忆 (settings 导航独立页面, `settings.section` 槽, order 25)。
- **浏览**: 全部库 (全局 + 所有项目, 含卡片/待整理/归档计数)、按库搜索 (BM25 + 标签加权, 与召回同一套打分)、卡片全文详情 (front-matter 全字段)、待处理候选池 (只列未消费的行 —— 即下次 Dream 真正会摄取的部分)、归档列表、Dream 状态 + 「立即 Dream」(复用 `dream.requestSeq` 触发器)。
- **单卡管理 (v2, 严格复用既有写路径)**: 详情页可「归档」与「删除」(两步确认, 删除标注不可恢复), 归档 tab 可「恢复」。这三条改动**不是**新的裸写路径 —— 它们走的是与 agent 工具完全相同的 store 操作 (`core.forgetCardIn` → `store.archiveCard`/`deleteCardHard`; `core.restoreCardIn` → `store.restoreCard`), 每次都在 store 锁内原子移动, 追加审计 (`op: archive/hard-delete/restore`, `via: 'client'`), 单写者纪律与 Dream 管线不变量原封不动。
- **严格单库**: GUI 的写操作只作用于显式指定的库 (store), 绝不回落到全局; 未知库/卡 → 404, 畸形 id/请求体 → 400。
- **传输**: host 在 connection 通道注册 7 条 exact 路由 (`/api/memory/summary|cards|card|inbox|archive` GET + `/api/memory/card/forget|restore` POST), 与 session-log-export / file-upload 同一机制; 浏览器经连接鉴权访问。`connection` 服务缺失 (headless profile) 时静默降级, 仅告警。
- **暴露面**: 只下发已落盘内容 (落盘前已过密钥闸门/PII 脱敏, 且简报本就会把卡片注入模型上下文), 不下发审计内容; 路由失败契约: 400/404/500 + 通用错误信息, 详情只记 host 日志。

## 安装

```powershell
# 链接安装 (开发) 或包名安装
dsh plugin add link:D:/path/to/dsh-memory --profile web
# 重启 dsh web 生效
```

组合行可覆盖辅助 LLM 路由:

```yaml
# == dsh-memory
- id: dsh-memory
  name: dsh-memory
  llm:
    provider: deepseek
    model: deepseek-v4-flash
```

## 工具 (5 个)

| 工具 | 说明 |
| --- | --- |
| `memory_remember` | 存一条持久记忆 (fact/preference/decision/procedure/commitment/observation/summary), scope `project`/`global`/`auto`; 遵循实时 `redact.pii` 策略, 被脱敏的类别以 `piiWarnings` 回报 |
| `memory_recall` | 按查询召回 项目+全局 记忆 |
| `memory_forget` | 按 id 或 Top-3 查询归档 (默认) / 硬删除 |
| `memory_status` | 各库卡片数、归档数、候选池、上次 Dream |
| `memory_dream` | 手动触发后台整理 |

## 设置 (namespace `memory`, GUI Settings → Plugins → dsh-memory)

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关; 关闭后不捕获/不注入, 工具报 disabled |
| `capture.mode` | `auto` | `off` 不捕获 / `explicit` 仅显式 / `auto` +轮次抽取 |
| `capture.useLlm` | `true` | 抽取走用户 LLM 路由 |
| `capture.turnTailChars` | `20000` | 送入抽取的轮次尾部字符数 |
| `capture.minTurnContentChars` | `120` | 短于该长度的轮次不捕获 |
| `redact.pii` | `redact` | `off`/`warn`(仅审计)/`redact`(脱敏) |
| `dream.enabled` | `true` | Dream 开关 |
| `dream.useLlm` | `true` | LLM 通道 (概览/冲突仲裁); 关 = 纯启发式 |
| `dream.intervalMinutes` | `30` | 空闲触发周期 (≥5) |
| `dream.maxLlmCalls` / `maxWallMs` | `40` / `600000` | 单次运行 LLM 调用数 / 墙钟预算 |
| `dream.requestSeq` | `0` | GUI「立即 Dream」单调触发器 |
| `brief.enabled` / `maxBytes` | `true` / `4096` | 会话简报开关 / 注入字节上限 |
| `brief.projectK` / `globalK` | `12` / `8` | 项目/全局注入条数上限 |
| `budget.maxCardBytes` / `maxInboxLines` | `4096` / `1000` | 单卡字节上限 / 候选池行数上限 (Dream 每次运行后压缩**已消费**头部; 未消费尾部永不丢弃) |
| `llm.provider` / `model` | `''` | 逐字段覆盖。解析顺序 (每字段取首个非空): ① 本设置 → ② 会话实时默认模型 (`agent-default-model` 命名空间, 插件随 agent 自身路由走) → ③ 组合行 `llm:` 路由兜底 |
| `llm.maxOutputTokens` / `timeoutMs` | `2000` / `60000` | 单次辅助调用输出上限 / 超时 |

## 开发

```powershell
npm install
npm run build      # esbuild: lib/index.js (host) + lib/testing.js + lib/client.js (GUI 设置卡片 + 记忆页)
npm run typecheck
npm test           # node --test tests/*.test.mjs (118 tests)
```

- `src/` host 平面 (store/capture/recall/dream/tools/brief/settings/browse), `src/client/` 浏览器平面 (设置卡片 `settings.plugin.item` 槽 + 记忆页 `settings.section` 槽 —— 浏览 + 单卡归档/删除/恢复)。
- LLM 全部走注入的 `llm` 服务 + 硬超时, **任何 LLM 失败都不可致命** (卡死流受单次调用超时约束, 单一迭代器被取消而非重入); 工具返回匿名 JSON 安全字面量。
- npm 为规范包管理器 (`package-lock.json`); `.gitattributes` 将换行固定为 LF。

## 验收记录 (web profile, 2026-08-17)

- 组合行挂载: `dsh --profile web --dump-config` 出现 `dsh-memory` 行 (含 llm 路由)。
- 客户端 bundle: `GET /plugins/dsh-memory/client.js` 200, `__ModuleLoader__` 包装完整。
- 设置面: `settings.describe` 返回 `memory` 命名空间全量默认值; 嵌套路径 `settings.mutate` set/unset 双向验证通过。
- 工具: 真实会话中 `memory_status` 返回双库实况 (全局 + `D-Repos-tanke` 项目库自动注册)。
- Dream: 真实进程 `memory_dream` 35ms 完成, `lastDream` 检查点写入, 幂等。
- 密钥闸门: 伪造 key 被拦截 (`blocked:true`), 未落盘。
- 会话简报: 新进程 agent 会话收到 `<system-reminder>` 记忆段 (0 条时显示占位)。

## 验收记录 (浏览面 + 单卡管理, 2026-09-05)

- 测试: 99/99 通过。浏览面 8 条 (summary 双库计数 / enabled 不挡读 / 卡片时间序+查询排序+limit 分页 / 详情+404+400 / inbox 计数+截断 / 7 路由注册与解除 / connection 缺失降级 / 注册失败回滚); 单卡管理 3 条 (归档→恢复往返 + 审计 via=client / 硬删不可恢复 + 审计 / 严格单库 + 404/400 拒绝)。
- 构建: `lib/index.js` (host) + `lib/client.js` (设置卡 + 记忆页) 编译通过, `tsc --noEmit` 无错。
- 路由: 7 条 `/api/memory/*` exact 路由 (5 GET + 2 POST) 经 `connection.fetch.register` 挂载到 row fiber, 随 fiber 卸载; `connection` 缺失或注册失败均降级为告警, 不抛入 agent 轮次。
- 写路径: 归档/删除/恢复全部复用 store 既有操作 (锁内原子移动 + 审计 + 索引重建), 无新裸写; `restore` 新增审计 op 已并入 `AuditOp` 联合类型。
- 端到端 (Settings → 记忆 页面渲染 + 真实数据 + 归档/删除/恢复点击流) 需在 web profile 重启后人工确认; 本记录覆盖到 host 路由层与客户端 bundle 层。

## 验收记录 (韧性加固, 2026-09-06)

按审计 (`docs/AUDIT.md`, F1–F17) 落实修复; 清单之外的行为未变。

- 测试: 118/118 通过 (99 基线 + 19 条新回归: 损坏卡片 ×3、inbox 坏行隔离 ×2、隔离 offset 对齐、inbox 压缩、pending 语义、redact.pii 模式 ×4、forget id 校验、注册表竞态、注册表不重写、延迟索引重建、无 LLM 捕获审计 ×2、PII 近失阴性; 另加强 1 条既有卡死流用例, 断言单一迭代器只被取消一次)。
- 加固: 损坏卡片文件跳过并只告警一次 (不再拖垮整个库); 截断的 JSONL 行跳过; inbox 坏行隔离 (审计 + offset 前移); `budget.maxInboxLines` 通过仅压缩已消费头部来强制; 各处 `pendingInbox` = 未消费行数; 显式 remember 写遵循 `redact.pii` (落盘文本即脱敏文本); `forget`/browse 拒绝畸形与穿越 id (400/空操作, 绝不探文件系统); 项目注册表 RMW 加锁 + 孤儿锁自愈, slug 进程内缓存 (不再反复重写); 无 LLM 服务时捕获不再逐轮写审计; 卡死的 LLM 流受单次超时约束且单一迭代器取消; store 锁等待 10s (原 2s) 以覆盖重建临界区。
- 死代码清除 (F11): 未实现的「晋升」特性 (`promotionEligible`、`promoteSessions` 规则、`op: 'promote'`、`loadAgentRules`) 已移除; AGENTS.md `### 晋升` 段落退化为自由备注。`AuditOp` 新增 `quarantine`。
- 文档: 设置表更正为真实默认值 (`llm.maxOutputTokens` 2000、`timeoutMs` 60000) 与三段式 LLM 路由解析; 记忆页文案不再声称只读。
- 卫生: 删除 `pnpm-lock.yaml` (npm 为规范), 新增 `.gitattributes` 固定 LF。
- `npm run typecheck` 无错; `npm run build` 产出 lib/index.js + lib/testing.js + lib/client.js。
