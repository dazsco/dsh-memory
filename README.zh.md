# dsh-memory

DeepSeek Harness (DSH) 的持久记忆插件: **全局记忆 + 项目独立记忆 + 规则层 + 后台 Dream 整理**。
生产级实现, 63/63 测试通过, 已在 web profile 完成端到端验收。

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
- `redact.pii`: `off | warn | redact`(默认) — 个人信息在存储文本中脱敏或仅审计。
- 审计文件追加式、只记卡片 id 与动作, 不记内容; 所有写入原子 (temp+rename), 并发零丢失。

### 规则层

- 用户层 `$DSH_HOME/AGENTS.md`、项目层 `AGENTS.md`/`CLAUDE.md` 的 `## Memory` 段落可定义拒绝规则 (如 `deny: 薪酬`), 在策略闸门之上叠加, 只允许更严、不允许放宽密钥闸门。

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
| `memory_remember` | 存一条持久记忆 (fact/preference/decision/procedure/commitment), scope `project`/`global`/`auto` |
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
| `budget.maxCardBytes` / `maxInboxLines` | `4096` / `1000` | 单卡字节上限 / 候选池行数上限 |
| `llm.provider` / `model` | `''` | 空 = 用组合行路由; 可覆盖 provider/model |
| `llm.maxOutputTokens` / `timeoutMs` | `600` / `30000` | 单次辅助调用输出上限 / 超时 |

## 开发

```powershell
npm install
npm run build      # esbuild: lib/index.js (host) + lib/testing.js + lib/client.js (GUI 设置卡片)
npm run typecheck
npm test           # node --test tests/*.test.mjs (63 tests)
```

- `src/` host 平面 (store/capture/recall/dream/tools/brief/settings), `src/client/` 浏览器平面 (设置卡片, `settings.plugin.item` 槽)。
- LLM 全部走注入的 `llm` 服务 + 硬超时, **任何 LLM 失败都不可致命**; 工具返回匿名 JSON 安全字面量。

## 验收记录 (web profile, 2026-08-17)

- 组合行挂载: `dsh --profile web --dump-config` 出现 `dsh-memory` 行 (含 llm 路由)。
- 客户端 bundle: `GET /plugins/dsh-memory/client.js` 200, `__ModuleLoader__` 包装完整。
- 设置面: `settings.describe` 返回 `memory` 命名空间全量默认值; 嵌套路径 `settings.mutate` set/unset 双向验证通过。
- 工具: 真实会话中 `memory_status` 返回双库实况 (全局 + `D-Repos-tanke` 项目库自动注册)。
- Dream: 真实进程 `memory_dream` 35ms 完成, `lastDream` 检查点写入, 幂等。
- 密钥闸门: 伪造 key 被拦截 (`blocked:true`), 未落盘。
- 会话简报: 新进程 agent 会话收到 `<system-reminder>` 记忆段 (0 条时显示占位)。
