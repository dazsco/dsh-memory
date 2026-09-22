# dsh-memory

DeepSeek Harness (DSH) 的持久记忆插件: **全局记忆 + 项目独立记忆 + 规则层 + 后台 Dream 整理 + DSH 原生 `/memory` 命令 + GUI 管理面**。

生产级实现: 138/138 测试通过, typecheck 与 build 干净, 可作为 profile bundle 安装。(English: [README.md](README.md))

## 设计要点

参考了主流方案的成熟做法并做了取舍:

| 方案 | 借鉴 |
| --- | --- |
| [Generative Agents](https://arxiv.org/abs/2504.13171) (memory stream + reflection) | 记忆卡片 + 周期性反思整理 (Dream); 召回按相关性/时间/重要性/置信度打分; MMR 多样性 + 1-hop 链接扩展 |
| [Mem0](https://memo.d.foundation) / [Letta](https://docs.letta.com) (add/extract/consolidate 管线) | 自动抽取 → 候选池 (inbox) → 后台合并/去重/归档的两段式写入, 写入路径与整理路径解耦 |
| [Zep](https://arxiv.org/abs/2501.13956) 双时态记忆 | 修正从不销毁历史: 被替换的卡片保留文件并盖上 `validUntil` + `supersededBy`, 因此退出召回但仍可审计、可恢复 |
| Claude Code 记忆惯例 (`AGENTS.md`/`CLAUDE.md`) | 规则层: `$DSH_HOME/AGENTS.md` 与项目 `AGENTS.md`/`CLAUDE.md` 中的 `## Memory` 段落可追加更严格的拒绝规则 |

### 存储布局 (全部在 `$DSH_HOME/memory/`, 绝不写进项目目录)

```
$DSH_HOME/memory/
  global/                  # 跨项目全局记忆
    cards/<id>.md          # 记忆卡片 (markdown + front-matter 元数据)
    inbox.jsonl            # 候选池 (策略已清洗, 只含允许内容)
    dream/summary.md       # Dream 概览
    audit.jsonl            # 追加式审计 (只记 id 与动作, 不记内容)
    archive/<id>.md        # 归档区 (遗忘 = 移入, 可恢复)
    index.json             # 派生索引 v2 (terms + 卡片元数据; 可重建)
  projects/<slug>/         # 每个项目一个独立存储 (slug 由路径确定性生成)
  projects.json            # 项目路径 ↔ slug 注册表
```

`index.json` 为 **v2** schema: 除每张卡片的元数据外, 还持久化卡片的词元数组 (`terms`), 因此召回、简报、Dream 与管理页都只需一次缓存的 JSON 读取即可打分, 不再逐张重读卡片文件。v1 索引在首次读取时被识别并重建; 卡片文件在库外被新增/删除/改名时, 索引也会自愈 (每次缓存未命中做一次 `readdir`)。

### DSH 集成 (插件实际接入的能力)

| DSH 能力 | 用途 |
| --- | --- |
| `settings` 服务 | 本行自身的实时 Config (`dsh-memory` 的 volatile 字段; GUI + profile patch) |
| `tools` 服务 | 9 个面向模型的工具 |
| `commands` 服务 | 人类在输入框敲的 `/memory …`(单命令, 支持中文子命令别名) |
| `connection` 服务 | 13 条 exact `/api/memory/*` fetch 路由, 经连接鉴权下发给浏览器 |
| `timer` 服务 | 60s Dream tick + 30s 启动巡检 (服务出现时随时补挂) |
| `systemPrompt` 服务 | 静态 `memory:usage` 段 (order 150) |
| `session/event` (`turn/end`) | 轮次结束自动捕获 (启发式 + 可选 LLM 抽取) |
| `session/event` (`compaction/summary`) | harness 自身的压缩摘要被暂存为 `summary` 候选, 因此长会话的持久结论能在替换其历史的压缩中存活下来 |
| `agent/created` | 每个会话一次预算内的 `<system-reminder>` 简报, 对 resume 做持久化去重 |
| `llm` 服务 | 预算内的辅助调用 (抽取、Dream 概览/冲突) 走 agent 自身路由 |

所有贡献都注册在它所需的服务作用域内, 因此任意挂载顺序都成立, 可选服务缺失只降级为一次告警, 释放时随 fiber 一起解绑。

### 召回与注入

- `memory_recall` 工具: 对当前项目库 + 全局库做打分召回 (`scope: "all"` 可扩到所有已发现项目)。分数 = BM25 (感知 CJK bigram) + 标签加权, 归一化后与时间新旧、重要性、互证置信度结合, 再按访问强度缩放; MMR 保持 top-k 多样, 1-hop 链接扩展可把词面查询漏掉的图邻居提上来。过滤器可组合: `kind`、`tags`、`since`、`minImportance`、`store`。
- **取代是读路径不变量**: 只要卡片设置了 `validUntil`, 除非显式传入 `includeSuperseded`, 否则绝不返回。因此修正默认隐藏历史, 却从不删除历史。
- **会话简报**: 每个 agent 会话启动时注入一次预算内的 `<system-reminder>` (项目 Top-K=12 + 全局 Top-K=8, 总字节 ≤ 4096), 保证 KV-cache 前缀稳定。
- **压缩捕获**: harness 压缩会话时, `compaction/summary` 事件文本先过策略闸门, 再暂存为 `summary` 候选 (同一会话内相同摘要去重) —— 长会话的结论变成持久项目记忆, 而不是消失在下次 Dream 永远不会读的检查点里。
- 系统提示追加 `memory:usage` 使用段 (order 150)。

### 自动捕获 (两段式)

1. 轮次结束事件 → 启发式抽取 (意图句/偏好句, 可用 `capture.heuristic=false` 关闭) → 候选写入 `inbox.jsonl`;
2. 若 `capture.useLlm` 开启, 再经用户配置的 LLM 路由做一轮抽取/合并 (失败只告警, 绝不阻断)。

`capture.mode` 门控整条路径: `off` 关闭捕获, `explicit` 完全关闭自动捕获 (只有 `memory_remember` / `/memory remember` 会写入), `auto` 两轮都开。策略闸门在任何内容暂存之前执行, 候选池因此只含允许内容。

### Dream 后台整理 (默认 LLM 通道开启)

- 空闲周期触发 (默认 30 分钟, 最小 5) + 启动 30s 巡检 + 显式运行 (`memory_dream`、`/memory dream`, 或 GUI 按钮的 `POST /api/memory/dream`)。
- **ingest**: 候选池捕获转为卡片 (Mem0 式基于 Jaccard 相似度的 ADD/UPDATE/NOOP); 畸形行被隔离, offset 越过它们继续前进。
- **access**: 召回访问日志折算进每张卡片的计数器。
- **decay**: 规则保留 (`AGENTS.md` Memory 段中的 `retention:`) 加观察下限, 把陈旧卡片归档。
- **relink**: 只对 LIVE 卡片做标签共现链接 (共享标签 ≥2, top-5)。
- **summarize**: 库内 live 卡片 ≥8 时, 取 Top-40 生成/更新 `dream/summary.md`。
- **conflict**: Jaccard 相似度落在 0.3–0.85 的候选对 (每次最多 4 对) 由 LLM 仲裁; 败者被**取代** (保留文件, 盖上 `validUntil` + `supersededBy`, 胜者记录正向链接) 而非销毁, 决策写入审计。
- 预算: 每次运行 `maxLlmCalls`(40) / `maxWallMs`(600s) 双限, 逐库检查点 (`inboxOffset`) —— **幂等且可崩溃恢复** (重复运行零副作用)。整次运行只做一次索引重建 (每次变更都传 `rebuild: false`)。
- `dream.useLlm=false` 时退化为纯启发式 (摄取/去重/衰减/重链)。

### 密钥与隐私

- **内置密钥闸门恒开、不可配置**: API key、密码、token、私钥等模式在写入前拦截, 返回结构化 `blocked` 结果 (不落盘、不抛异常、不泄漏原文)。已验收: 伪造 OpenAI 风格 key → `{"blocked":true,"reason":"openai-style-key"}`。
- `redact.pii`: `off | warn(仅审计) | redact`(默认, 在存储文本中脱敏) — 策略覆盖所有写路径: 自动捕获、Dream 摄取**以及**显式 `memory_remember` 工具写入 (落盘的卡片文本即闸门处理后的文本)。
- 审计文件追加式、只记卡片 id 与动作, 不记内容; 所有写入原子 (temp+rename), 并发零丢失。
- **故障隔离**: 单张损坏卡片被跳过 (仅告警一次) 而不拖垮召回/状态/Dream; 被截断的 inbox / access 行被跳过 —— inbox 的行还会被隔离 (审计 `op: quarantine`, offset 前移), 因此写入中途 kill -9 绝不会把库卡死。

### 规则层

- 用户层 `$DSH_HOME/AGENTS.md`、项目层 `AGENTS.md`/`CLAUDE.md` 的 `## Memory` 段落可定义拒绝规则 (如 `deny: salary`), 在策略闸门之上叠加, 只允许更严、不允许放宽密钥闸门。

### 记忆管理页 (GUI)

agent 工具只能看「当前项目 + 全局库」, 其他项目库对工具路径不可见; 管理页补齐这个缺口:

- **入口**: Settings → 记忆 (settings 导航独立页面, `settings.section` 槽, order 25)。
- **概览**: 总量 (live / superseded / pending / archived / bytes), 以及每个库的 kind 直方图与 top 标签。
- **浏览**: 全部库 (全局 + 所有项目)、按库搜索 (BM25 + 标签加权, 与召回同一套打分) 并支持 kind 与标签过滤、卡片全文详情 (front-matter 全字段)、待处理候选池 (只列未消费的行 —— 即下次 Dream 真正会摄取的部分)、归档列表, 以及 **审计 tab** (最近操作: 时间、op、via、id、详情)。
- **写入**: 「新建记忆」表单与卡片详情内的行内编辑器都走与工具完全相同的策略闸门与审计 (`POST /api/memory/card/remember`、`POST /api/memory/card/update`); 编辑会写入一张**新**卡片并把旧卡标记为已取代, 因此不会有内容被静默覆盖。
- **单卡管理**: 详情面板提供 编辑 / 归档 / 删除 (两步确认; 删除标注不可恢复), 归档 tab 提供 恢复。这些**不是**另一条裸写路径 —— 它们调用的是 agent 工具所用的同一批 store 操作 (`core.forgetCardIn` → `store.archiveCard` / `deleteCardHard`; `core.restoreCardIn` → `store.restoreCard`; `core.updateCard` → `store.supersedeCard`), 每次都在 store 锁内原子移动, 每次都有审计 (`op: archive/hard-delete/restore/supersede`, `via: 'client'`)。单写者纪律与 Dream 管线不变量原封不动。
- **立即 Dream**: POST `/api/memory/dream` 并渲染返回的逐库增量。
- **导出 / 导入**: 把选中的库 (或全部库) 下载为 JSON bundle, 并可导入回来, 附逐库 added/skipped/replaced/rejected 报告。
- **严格单库**: GUI 的写操作只作用于它显式指定的库 (store), 绝不回落到全局; 未知库/卡 → 404, 畸形 id/请求体 → 400。
- **传输**: Host 在 connection 通道注册 13 条 exact 路由 (7 条 GET: `summary|cards|card|inbox|archive|audit|export`; 6 条 POST: `card/forget|card/restore|card/remember|card/update|dream|import`), 与 session-log-export / file-upload 同一机制; 浏览器经连接鉴权访问。`connection` 服务缺失 (headless profile) 时静默降级, 仅告警。
- **暴露面**: 只下发已落盘内容 (落盘前已过密钥闸门/PII 脱敏, 且简报本就会把卡片注入模型上下文)。审计行只带 id、op 与短标题 —— 绝不含命中的密钥内容。路由失败契约: 400/404/500 + 通用错误信息, 详情只记 Host 日志。

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

## 工具 (9 个)

| 工具 | 说明 |
| --- | --- |
| `memory_remember` | 存一条持久记忆 (fact/preference/decision/procedure/commitment/observation/summary), scope `project`/`global`/`auto`; 遵循实时 `redact.pii` 策略, 被脱敏的类别以 `piiWarnings` 回报。传 `supersedes=<id>` 修正旧记忆, 传 `ttlDays` 设定有效期窗口。 |
| `memory_recall` | 排序召回 (默认 项目 + 全局; `scope: "all"` 搜索所有已知项目库)。过滤器: `kind`、`tags`、`since`、`minImportance`、`store`、`includeSuperseded`; `expandLinks` 提升 1-hop 图邻居。 |
| `memory_get` | 按精确 id 读取一张完整卡片 (正文、元数据、链接图、取代指针)。 |
| `memory_update` | 写入某张卡片的修正版本: 旧卡保留在磁盘上作为历史并退出召回 (双时态取代)。与 `memory_remember` 一样过策略闸门。 |
| `memory_forget` | 按精确 id 归档 (默认, 可恢复) 或硬删除。按查询遗忘是 **dry run**, 除非传 `confirm=true`, 因此模糊匹配永远不会隐含破坏性操作。 |
| `memory_gc` | 容量清理: 归档过期/低价值卡片、执行在线卡片上限、裁剪最旧的归档卡片与审计/访问日志、压缩已消费候选池。除非 `confirm=true`, 否则是 **dry run**。 |
| `memory_drop_store` | 永久删除**单个项目库** (卡片、归档、整理历史、候选池、索引 + 注册表条目)。除非 `confirm=true` 否则是 dry run; 全局库不可删除。 |
| `memory_status` | 逐库的 卡片 / 归档 / 已取代 计数、待处理候选池、kind 直方图、top 标签、字节数、总量、上次 Dream 运行。记忆关闭时也可用。 |
| `memory_dream` | 触发后台整理 (摄取、去重、衰减、重链、冲突、容量维护、重建索引), 或读取其状态。 |

## 输入框命令 (DSH `commands`)

由人类输入, 在 Host 上执行, 不消耗模型轮次。**只有一个命令** `/memory`, 子命令承担全部能力 —— 菜单行的描述与输入提示就是中文 (DSH 对宿主命令的文案原样渲染, 第三方命令拿不到按语言切换的查表), 中文子命令别名与英文 token 等价:

```
/memory                     store + Dream status (裸调用)
/memory status   | 状态      各库卡片数、待整理候选、上次 Dream
/memory recall <query>  | 召回   在当前项目库 + 全局库中检索
/memory search <query>  | 搜索   在全部已知记忆库中检索
/memory remember <text> | 写入   写入一条长期记忆
/memory forget <id>     | 遗忘   归档一条记忆 (可恢复)
/memory gc [confirm]    | 清理   容量清理 (默认试算, 加 confirm 执行)
/memory dream           | 整理   立即执行一次 Dream 整理
/memory help            | 帮助   用法
```

策略闸门同样覆盖命令路径: 被拦截的写入返回 `Blocked by policy: <pattern-names>`, 绝不回显命中的内容。

命令没有图标: 输入框菜单行的图标只能来自客户端 `CommandContribution` (`ui-commands`) 或第一方的 `HOST_FACES` 表, 而客户端贡献**不允许与宿主命令同名** (客户端会抛 `contribution /<name> collides with a host command`)。因此想要图标就必须把 `/memory` 整体搬到客户端, 代价是失去可输入子命令、结果文本与非 Web 客户端的可用性 —— 不值得。

## 设置 (namespace `dsh-memory`, GUI: Plugins → dsh-memory → Configure)

DSH 0.1.7 起, 插件自身的 `Config` 通过 `ctx.settings` 投影为表单, 表单命名空间就是 **Loader 行 id** — 对本 bundle 即 `dsh-memory`(包名)。下表每一节都声明为 `.volatile()`, 因此一次保存会直接写进运行中行的引用, 不重挂载; 用户层是 profile patch (`$DSH_PROFILE_DIR/cordis.patch.yml`), 本 bundle 的 `cordis.patch.yml` 是组合层, 下表默认值是最底层。同一份值也可以用设置文档读写, 所以 CLI 与 GUI 是同一写入路径。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关; 关闭后不捕获/不注入, 工具报 disabled |
| `capture.mode` | `auto` | `off` 不捕获 / `explicit` 仅显式 (完全不做自动捕获) / `auto` 轮次结束抽取 |
| `capture.useLlm` | `true` | 抽取走用户 LLM 路由 |
| `capture.heuristic` | `true` | 对用户陈述做基于规则的意图抽取 |
| `capture.llmMaxCallsPerSession` | `20` | 单个会话的辅助抽取调用上限 (`0` = 不限)。抽取会重读会话尾部, 被跳过的轮次由下一次调用覆盖 |
| `capture.llmMinIntervalMs` | `30000` | 同一会话两次抽取调用的最小间隔 (`0` = 不限制); 把快速连续多轮合并为一次调用, 而不是每轮一次 |
| `capture.turnTailChars` | `20000` | 送入抽取的轮次尾部字符数 |
| `capture.minTurnContentChars` | `120` | 短于该长度的轮次不捕获 |
| `capture.compaction` | `true` | 把 harness 的压缩摘要暂存为 `summary` 候选 |
| `capture.compactionMaxChars` | `4000` | 单条压缩摘要候选的字节上限 |
| `redact.pii` | `redact` | `off`/`warn`(仅审计)/`redact`(脱敏) |
| `dream.enabled` | `true` | Dream 开关 |
| `dream.useLlm` | `true` | LLM 通道 (概览/冲突); 关 = 纯启发式 |
| `dream.intervalMinutes` | `30` | 空闲触发周期 (≥5) |
| `dream.maxLlmCalls` / `maxWallMs` | `40` / `600000` | 单次运行 LLM 调用数 / 墙钟预算 |
| `dream.requestSeq` | `0` | GUI「立即 Dream」单调触发器 (旧路径; 页面现在 POST `/api/memory/dream`) |
| `brief.enabled` / `maxBytes` | `true` / `4096` | 会话简报开关 / 注入字节上限 |
| `brief.projectK` / `globalK` | `12` / `8` | 项目/全局注入条数上限 |
| `recall.k` | `8` | `memory_recall` / `/memory recall` 的默认返回条数 |
| `recall.expandLinks` / `linkDecay` | `true` / `0.5` | 排序的 1-hop 图扩展及其提升系数 |
| `recall.briefIncludeSuperseded` | `false` | 会话简报是否包含已被取代的卡片 |
| `commands.enabled` | `true` | 注册 `/memory`(唯一命令; 子命令已覆盖旧的 `/remember`) |
| `budget.maxCardBytes` / `maxInboxLines` | `4096` / `1000` | 单卡字节上限 / 候选池行数上限 (Dream 每次运行后压缩**已消费**头部; 未消费尾部永不丢弃) |
| `maintenance.enabled` | `true` | 每次 Dream 结束时执行容量维护 |
| `maintenance.staleDays` / `staleMaxImportance` | `180` / `6` | 超过该天数未更新且重要性 ≤ 上限的在线卡片会被归档 (`staleDays: 0` 关闭; `preference`/`commitment` 豁免) |
| `maintenance.maxLiveCards` | `2000` | 单库在线卡片上限; 超出后归档价值最低的卡片 (常驻类最后) |
| `maintenance.maxArchivedCards` | `2000` | 单库归档卡片上限; 超出后**硬删除最旧**的归档 |
| `maintenance.maxAuditLines` / `maxAccessLines` | `4000` / `4000` | 单库日志行数上限 (保留最新) |
| `maintenance.maxInboxBytes` | `1000000` | 单库候选池字节上限 (优先丢弃已消费头部) |
| `llm.provider` / `model` | `''` | 逐字段覆盖。解析顺序 (每字段取首个非空): ① 本设置 → ② 部署的实时默认模型 (`ctx.agentDefaultModel.currentSelection()`, 插件随 agent 自身路由走) → ③ 本插件内置兜底路由 (`deepseek` / `deepseek-v4-flash`)。留空即继承; 也可以用组合行固定路由 |
| `llm.maxOutputTokens` / `timeoutMs` | `2000` / `60000` | 单次辅助调用输出上限 / 超时 |

## 容量与清理

只增不减的记忆会让每次召回、每次 Dream、每次索引写入都越来越慢, 因此本插件是**有界**而非累积式的:

- **热路径有界。** 召回只在**有上限的候选池**上排序, 且贪心 MMR 在选出 `k` 条后立即停止 (旧实现每次都对整个语料排序, 实际是立方级复杂度)。Dream 去重为每张卡只构建一次 token 集合 (旧实现为每个候选池条目重建全部卡片集合); 重链改由标签倒排索引驱动 (旧实现是全量两两扫描); 冲突通道有比较次数上限。所有长循环最多每 8ms 让出一次事件循环, 因此大规模整理不会卡死 harness。
- **增量索引。** `index.json` 按单卡增量更新 (精确维护 `docCount` / `avgDocLen` / `df`), 不再每次写入都重读全部卡片文件; 索引以紧凑格式 (非缩进) 落盘, 每卡持久化的 token 数组也有上限。
- **自动维护** (每次 Dream 的第 6 个 pass, `maintenance.*`): 归档过期低重要性卡片、执行在线卡片上限、裁剪归档 / 审计 / 访问日志 / 候选池预算。该 pass 遵循本次运行的墙钟预算 (被截断的清理下次继续), 所有上限都可在 **Plugins → dsh-memory → Configure** 的「写入预算」「容量与清理」分组中调整。
- **写入突发有界。** 全新的库会一次性改变所有卡片的链接; 重链 pass 每次运行最多写 500 张卡 (幂等, 剩余部分在后续运行收敛), 辅助抽取调用按会话节流 (`capture.llmMaxCallsPerSession` / `llmMinIntervalMs`), 长会话不再每轮多发一次模型调用。
- **按需清理**: `memory_gc` 工具与 `/memory 清理 [slug] [confirm]`。除非确认, 两者都是 **dry run**, 并逐库报告会归档什么、裁剪什么、回收多少字节。
- **彻底重置**: 直接删除 `$DSH_HOME/memory/projects/<slug>` (或 `$DSH_HOME/memory/global`) 即可清空该库; `memory_drop_store` / `/memory 删除库 <slug>` 可删除单个项目库并同时清理注册表条目。

没有任何东西会被静默丢弃: 卡片清理都是**归档** (文件移入 `archive/`, 可在 Settings → Memory → Archive 恢复); 只有归档/日志裁剪不可逆, 且仅在超出配置上限时发生。

## 导出与导入

- **导出**: `GET /api/memory/export[?store=<slug>][&liveOnly=1]` 返回自描述 bundle (`{format:"dsh-memory-export", version, schema, stores:[{slug,kind,projectPath,cards,archived}]}`); 管理页把它下载为 JSON 文件。
- **导入**: 用该 bundle 调 `POST /api/memory/import` 是**追加式且幂等**的 —— 内容完全相同的已存在卡片被跳过, 同 id 但内容不同的卡片被替换, 每张入站卡片都必须重新通过当前的密钥/PII 闸门才能落盘 (导入的 bundle 永远无法把当前策略禁止的凭据重新带进来)。畸形卡片计入 `rejected` 并附原因, 绝不写入。

## 开发

```powershell
npm install
npm run build      # esbuild: lib/index.js (host) + lib/testing.js + lib/client.js (GUI 设置卡片 + 记忆页)
npm run typecheck
npm test           # 快速套件 (node --test tests/**/*.test.mjs)
npm run test:scale # 规模守卫 (tests/**/*.slow.mjs) —— 较慢, 发布前必跑
npm run bench      # 实测召回/写入/Dream 成本; `-- 3000`、`--old` 可对比新旧形态
```

- `docs/PERFORMANCE.md` 记录了实测热路径、仍为线性的两处、各项上限, 以及**刻意未实现**的设计草案 (倒排表、索引分片、hub 标签) —— 连同触发条件一起写明。

- `src/` 是 host 平面 (store / core / capture / recall / dream / tools / commands / brief / settings / browse / llm); `src/client/` 是浏览器平面 (插件自身配置表单注册进 `plugins.bundle.config` + `plugins.row.config`, 记忆页注册进 `settings.section`)。
- 每项 host 贡献都注册在它所需的服务作用域内 (`ctx.inject([...])`), 因此任意挂载顺序都成立, 可选服务缺失只告警一次, 释放时随 fiber 解绑。行配置在挂载时由导出的 `Config` schema 校验。
- 召回、简报、Dream 与管理页都从派生索引打分 (`index.json` v2 保留每张卡的 `terms`); 没有任何读路径会重新打开每一张卡片文件。规则文件以 mtime 为缓存键。`src/browse.ts` 拥有路由表 (`MEMORY_BROWSE_ROUTES`), 测试也以它为准做断言。
- LLM 全部走注入的 `llm` 服务 + 硬超时, **任何 LLM 失败都不可致命** (卡死流受单次调用超时约束, 单一迭代器被取消而非重入); 工具返回匿名 JSON 安全字面量。
- npm 为规范包管理器 (`package-lock.json`); `.gitattributes` 将换行固定为 LF。

## 验收记录 (web profile, 2026-08-17)

- 组合行挂载: `dsh --profile web --dump-config` 出现 `dsh-memory` 行 (含 llm 路由)。
- 客户端 bundle: `GET /plugins/dsh-memory/client.js` 200, `__ModuleLoader__` 包装完整。
- 设置面: `settings.describe` 返回 `dsh-memory` 命名空间全量默认值; 嵌套路径 `settings.mutate` set/unset 双向验证通过 (已被下方 v0.5.0 记录中的 entry-id 命名空间取代)。
- 工具: 真实会话中 `memory_status` 返回双库实况 (全局 + `D-Repos-tanke` 项目库自动注册)。
- Dream: 真实进程 `memory_dream` 35ms 完成, `lastDream` 检查点写入, 幂等。
- 密钥闸门: 伪造 key 被拦截 (`blocked:true`), 未落盘。
- 会话简报: 新进程 agent 会话收到 `<system-reminder>` 记忆段。

## 验收记录 (浏览面, 2026-09-05)

- 测试: 99/99 通过。浏览面 8 条 (summary 双库计数 / enabled 不挡读 / 卡片时间序+查询排序+limit 分页 / 详情+404+400 / inbox 计数+截断 / 路由注册与解除 / connection 缺失降级 / 注册失败回滚); 单卡管理 3 条 (归档→恢复往返 + 审计 via=client / 硬删不可恢复 + 审计 / 严格单库 + 404/400 拒绝)。
- 构建: `lib/index.js` (host) + `lib/client.js` (设置卡 + 记忆页) 编译通过, `tsc --noEmit` 无错。
- 路由: `/api/memory/*` exact 路由经 `connection.fetch.register` 挂载到 row fiber, 随其卸载; `connection` 缺失或注册失败均降级为告警, 不抛入 agent 轮次。
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

## 验收记录 (v0.3.0 — DSH 原生升级, 2026-09-17)

**破坏性变更** (全部为有意为之, 且都已在上文说明): 卡片/索引 schema v1 → v2 (新增 `supersededBy`、索引 `terms`/`bytes`); Dream 的 LLM 冲突仲裁改为取代败者而非归档; 按查询遗忘需要 `confirm=true`; `capture.mode='explicit'` 现在真正关闭自动捕获; `StatusReport` 新增 `totals`/`kinds`/`topTags`/`superseded`/`bytes` (追加式); 路由表由 7 条增至 13 条。

- **Cordis 生命周期**: 每项贡献都通过 `ctx.inject([service])` 注册 (tools / commands / connection / timer / systemPrompt), 因此挂载顺序不再重要, 迟到的可选服务也能绑定。行配置由导出的 `Config` schema 校验。已由 fake-ctx E2E 验证 (用结构化 fake 调用 `apply()`)。
- **索引 v2 + 自愈**: `index.json` 中保存 `terms`/`bytes`/`supersededBy`; v1 索引在首次读取时重建; 卡片文件在库外被新增/删除/改名会被每次缓存未命中的一次 `readdir` 发现并触发重建。召回/Dream/简报/GUI 不再逐张读取卡片文件。
- **双时态取代**: `memory_remember{supersedes}`、`memory_update` 以及 Dream 的冲突仲裁都走 `store.supersedeCard` (原子写入 `validUntil` + `supersededBy`, 胜者记录正向链接, 审计 `op:supersede`); `passesFilter` 把取代变成读路径不变量, 可用 `includeSuperseded` 覆盖。
- **新能力面**: `/memory` 输入框命令 (DSH `commands` 服务; 单命令、中文行文案、中文子命令别名); `compaction/summary` → `summary` 候选捕获; 6 条新 fetch 路由 (audit、export、card/remember、card/update、dream、import)。
- **安全**: 导入时每张卡片都重新过当前策略闸门; 按查询遗忘是 dry run; 畸形 id 永远不会进入文件系统路径拼接。
- **验证**: `npm run typecheck` 无错; `npm run build` 产出 lib/index.js + lib/testing.js + lib/client.js; `npm test` → **138/138** (118 基线 + 20 条新 v3 用例, 覆盖索引迁移、自愈、取代路径、过滤器、链接扩展、导出/导入、dry-run 遗忘、状态结构、压缩捕获、命令面与新路由; 另有 wiring E2E 中 `memory_get` / `memory_update` / 带过滤召回的工具边界用例)。
- **线上验收 (web profile, 原地升级)**: bundle 安装并激活为 `include:dsh-memory` (`fiberPhase: active`), 写入 profile 的 `dsh.profile.bundles` 与 `dependencies`, 重启后仍然生效, 且零激活告警。随后用插件自身的工具对**真实记忆库**做了验证: `memory_status` 返回新结构 (`schema: 2`、`totals`, 以及每个库的 `superseded`/`kinds`/`topTags`/`bytes`), 覆盖 **7 个库 / 441 张卡片** —— 说明 v1→v2 索引迁移在既有数据上静默完成; `memory_recall` 用 `scope:"all"` 检索了全部库, `minImportance`/`scope` 过滤器可组合; `memory_get` 读出一张 v2 之前的卡片并显示 `supersededBy: null`, 证明对真实旧文件的向后兼容。
- **环境说明 (非插件缺陷)**: 本机沙箱会静默吞掉符号链接创建 (`mklink /D` 报告成功但链接并不存在; junction 正常)。因此 pnpm 会记录依赖却不会在 `node_modules` 顶层生成条目, `plugin_manager install_bundle` 首次解析必然失败。修复方式: 把 `…/profiles/web/node_modules/dsh-memory` 建成指向仓库的 **junction**, 再重跑 `plugin_manager install_bundle` —— pnpm 不会动已存在的条目, 激活随即完成。记忆管理页与 `/memory` 命令需要真人在浏览器/输入框中操作; 本次会话没有浏览器控制能力, 且所有 HTTP 路由都需要鉴权 (401), 因此这两处由客户端 bundle 构建 + 宿主路由/命令测试覆盖, 而非点击验证。

## 验收记录 (v0.4.0 — 容量与性能加固, 2026-09-25)

**问题**: 记忆只增不减; 项目库累积到数百至数千张卡片后, dsh 明显变卡。

**根因** (全部同步跑在 harness 的同一个事件循环上):

1. `rankWithMmr` 对**整个候选集**做贪心 MMR 之后才 `slice(0, k)` —— 内层还要遍历已选集, 实际是 **O(N³)**, 且每次召回都跑 (会话简报一次会话跑两次)。实测 1000 张卡片时单次排序 **130.8 秒**。
2. Dream 重链 pass 对每张卡遍历全部卡片, 且**每一对都 `new Set(tokens)`** —— O(N²) 集合构造。
3. Dream 去重 pass 为**每个候选池条目**重建全部卡片的 token 集合 —— O(候选 × 卡片) 集合构造。
4. 每次显式写入 (`remember`/`update`/`forget`/`restore`) 都做全量 `rebuildIndex` (O(N) 次文件读 + 数 MB JSON 序列化)。
5. 无界增长: 在线卡片无上限 (只有 `observation` 有 14 天衰减)、审计日志永不裁剪、访问日志只在 Dream 时清空、候选池只按行数压缩 (单行上限 20KB)、索引含全量 `terms` 且**缩进**写入。
6. 热路径反复整文件读取: `inboxLineCount` 每次 tick/status 全读; `readAuditTail` 解析整个审计文件只为取最后 50 行。

**修复**:

- **召回有界**: 候选池按分数截断 (≥240 或 12×k), MMR 只做 k 轮 → O(pool·k)。3000 张卡片时 MMR 12ms, `core.recall` 端到端 36–52ms (与 N 基本无关)。
- **Dream 有界**: 每卡 token 集合每轮只建一次; 重链改由标签倒排索引驱动 (语义不变: 仍需 ≥2 共享标签、按共享数取前 5); 冲突通道加 token 长度预筛 + 20000 次比较上限; 所有长循环最多每 8ms 让出事件循环。
- **索引增量**: 单卡增量更新 (精确维护 `docCount`/`totalTokens`/`df`), 紧凑写入, 每卡 `terms` 上限 1024; 缺少 `bm25.totalTokens` 的旧索引自动回退全量重建。
- **批量化**: `patchCards` 单次加锁批量写; 卡片文件读写 16 路并发 (3000 卡重建 1.26s → 0.48s); 访问计数改为进程内缓冲、批量落盘 (顺带消除 recall 的游离 promise 与测试 teardown 竞态)。
- **索引原地增量 + 批量清理**: 单卡索引更新不再拷贝 `cards`/`df` (此前**每次写入**都是 O(卡片数 + 词表), 现在只与变更卡片相关); `archiveCards` + `auditMany` 把批量清理收敛为每 256 张卡一次加锁 / 一次索引更新 / 一次审计追加 —— 3000 张卡超限库的首次 Dream 因此从 13.5s 降到 **6.5s**。
- **有界增长**: 新增 `maintenance.*` 上限, 由 Dream 第 6 个 pass 自动执行; 审计/访问日志支持真实 tail 读与裁剪; 候选池按行 + 字节双预算压缩; 归档卡片有上限。
- **写入突发与每轮成本有界**: Dream 的墙钟预算现在会传到衰减/重链/维护 pass (被截断的部分下次继续), 重链写入每次运行上限 500 张; 辅助捕获调用改为按会话节流 (预算 + 最小间隔), 不再每轮一次; 打分语料按索引对象缓存, 召回不再重建全量 Map; `budget.*` / `maintenance.*` 已可在 GUI 设置卡中调整。
- **清理通道**: `memory_gc` 工具 + `/memory 清理 [slug] [confirm]` (默认 dry run, 逐库报告归档/裁剪/回收字节); 卡片清理一律**归档** (可从 GUI 归档页恢复)。

**实测** (本机 Windows, N=1000): MMR 124282ms → **4ms**; 重链 5179ms → 330ms (≈16×); 单次写入 153ms (全量重建) → 34ms (增量)。N=3000 时召回 27–53ms, Dream 稳态 **2.9s**。完整成本画像、仍为线性的两处以及刻意未实现的设计草案见 `docs/PERFORMANCE.md`。

- **破坏性变更**: `StoreDreamResult` 新增 `pruned`; `StoreMaintenanceResult` 新增 `truncated`; `archiveCard`/`deleteCardHard`/`restoreCard` 新增 `opts.rebuild`; 新增 `capture.llmMaxCallsPerSession`/`llmMinIntervalMs`、settings 段 `maintenance`、工具 `memory_gc`、命令 `/memory 清理`; 索引 schema 仍为 2 (新增可选字段 `bm25.totalTokens`)。
- **验证**: `npm run typecheck` 无错; `npm run build` 产出 lib/index.js + lib/testing.js + lib/client.js; `npm test` → **162/162** 快速用例 (147 基线 + 15 条新用例: 维护策略/试算与执行/归档与日志预算/候选池按行与按字节只丢已消费头/超时截断清理/增量索引与全量重建逐字段一致/旧索引升级/`memory_gc`/`/memory 清理`/捕获调用按预算·间隔·会话节流), 另 `npm run test:scale` → **3/3** 规模守卫。上述所有数字都可用 `npm run bench` 复现。

## 验收记录 (v0.5.0 — DSH 0.1.7 适配, 2026-09-22)

harness 从独立的 settings 命名空间注册表改为**插件自身的 Config**(`describe`/`update`/`mutate` 针对某个 Loader entry, 只有 `.volatile()` 字段可编辑, 且编辑直接提交进运行中的 fiber), 并废弃了共享的 `{kind:'plugin'}` 消息来源, 改为生产者自有 kind。本版本同时适配这两点。

**破坏性变更**

- 设置命名空间是**行 id** `dsh-memory`(不再是 `memory`); 插件全部配置就是它导出的 `Config` schema (`MemorySettingsSchema`), 每节一个 volatile 字段。不再有 `settings.register`/`scope.get()`, 组合行也不再带 `llm:` 路由 —— 空的 `llm.provider`/`model` 依次继承 `ctx.agentDefaultModel` 与本插件内置兜底路由。
- 本插件产出的消息归属为 `{ kind: 'dsh-memory' }`(会话简报为 `form: 'recall'`)。简报的持久去重仍识别两种旧写法 (session-format 读取器把已发布会话改写成 `plugin:dsh-memory`, 以及未迁移的原始 `{kind:'plugin', plugin:'dsh-memory'}`), 因此升级后恢复会话不会被重复注入。
- 捕获改为按 `source.kind === 'user'` 判定人类文本 —— 在生产者的来源词表中这是唯一表示"人打的字"的来源 —— 不再用 `plugin`/`tool` 黑名单。
- 浏览器半部把配置表单注册进 Plugins 页自己的位置 (`plugins.bundle.config` 按包名, `plugins.row.config` 按 `dsh-memory#dsh-memory`), 并通过 `ctx.configForms.get('dsh-memory')` 读取; 旧的 `settings.plugins.tab` 标签页已移除。卡片保留暂存字段、分组与保存/放弃, 现在内联渲染 (标题与一句话描述由页面绘制), 行摘要走 `view: 'summary'`。

**验证**

- `npm run typecheck` 无错; `npm run build` 产出 lib/index.js + lib/testing.js + lib/client.js; `npm test` → **173/173** 快速用例 (162 基线, 已改造到新夹具: 真实用户夹具一律带 `{kind:'user'}`, checkpoint marker 用例改为在人类来源的消息上验证 marker, wiring E2E 改为驱动假 volatile Config; 另加 `tests/v5.test.mjs` 7 条设置契约用例与 `tests/client.test.mjs` 4 条浏览器半部用例 —— 在无浏览器环境下物化已构建的 bundle)。
- **线上验收 (web profile, 原地升级)**: `plugin_manager install_bundle link:D:/Repos/dsh/dsh-memory` → `application: applied`; 组合行在 `Config.listConfigs` 中为 `include:dsh-memory`, `status: schema`, 投影出的表单显示全部十节 `x-cordis.volatile: true`。该行的 9 个工具 (`Tool.listTools`) 与浏览器注册 (`Slots.listSubTree` → `settings.section` 占用者 `memory`、`plugins.row.config` 占用者 `dsh-memory#dsh-memory`, 均 `active`) 在运行中的 Host 与页面上均为实时状态。
- **线上设置往返**: 往 `$DSH_PROFILE_DIR/cordis.patch.yml` 的组合层写入 `enabled: false` 后, 运行中的 `memory_status` 立即变为 `enabled:false` 且未重挂载; 同一层写入 `dream.requestSeq: 5` 后, 行的 `loader/volatile-update` 监听器立刻跑了一次 Dream (`lastDream` 从 `""` 变为真实时间戳)。临时覆盖随后已删除, profile 恢复原状。
- **未做点击验证**: 本次会话没有浏览器控制能力, 且 Web 路由需要鉴权 (401), 因此卡片的实际渲染与记忆页是通过实时 Client slot 台账 + 客户端 bundle 构建验证的, 而非点击。证据是 slot 的 `active` 状态与 Host 侧 Config 往返。
