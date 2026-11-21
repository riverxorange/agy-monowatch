# monowatch 数据口径说明

这份文档写给想了解或维护 monowatch 的人：数据从哪里读、怎么解码、指标怎么算，以及 Antigravity 升级后该检查什么。

Antigravity 没有公开的用量接口，相关数据分散在本地的 SQLite、Protobuf 和 JSON 文件里。monowatch 只读这些文件（SQLite 一律以 `{ readOnly: true, timeout: 2500 }` 打开，见 [utils.mjs](../sidecars/monitor_board/telemetry/utils.mjs)），按 **步骤 → 轮次 → 会话 → 会话树** 逐级汇总。

> [!NOTE]
> 下文的 Protobuf 字段号、枚举值都是从本地数据观察得到的，没有官方文档，Antigravity 升级后可能变化。变化时请先看第 7 节的检查清单。

## 目录

1. [代码结构](#1-代码结构)
2. [数据源](#2-数据源)
3. [解码](#3-解码)
4. [指标计算](#4-指标计算)
5. [会话关系与归属](#5-会话关系与归属)
6. [运行时](#6-运行时)
7. [升级检查清单](#7-升级检查清单)
8. [已知限制](#8-已知限制)

---

## 1. 代码结构

| 文件 | 职责 |
| :--- | :--- |
| [main.mjs](../sidecars/monitor_board/main.mjs) | HTTP 服务、鉴权、设置存储、文件监听、自动重启 |
| [updater.mjs](../sidecars/monitor_board/updater.mjs) | 版本检查与自更新 |
| [telemetry/engine.mjs](../sidecars/monitor_board/telemetry/engine.mjs) | 组装快照、会话树、冷热分层与历史归档 |
| [telemetry/ledger.mjs](../sidecars/monitor_board/telemetry/ledger.mjs) | 本地持久化用量账本（`usage_ledger.sqlite`），保留已删除会话的历史汇总 |
| [telemetry/discovery.mjs](../sidecars/monitor_board/telemetry/discovery.mjs) | 发现会话、父子关系、项目、子代理与 Swarm 成员 |
| [telemetry/metrics.mjs](../sidecars/monitor_board/telemetry/metrics.mjs) | 单会话的 Token、费用、上下文、耗时与事件 |
| [telemetry/turns.mjs](../sidecars/monitor_board/telemetry/turns.mjs) | 逐轮明细、压缩摘要 |
| [telemetry/proto.mjs](../sidecars/monitor_board/telemetry/proto.mjs) | Protobuf 线格式解码 |
| [telemetry/models.mjs](../sidecars/monitor_board/telemetry/models.mjs) | 模型目录、单价、价格覆盖 |
| [telemetry/routing.mjs](../sidecars/monitor_board/telemetry/routing.mjs) | 模型切换与路由识别 |
| [ui/](../sidecars/monitor_board/ui/) | 前端视图、格式化、主题、多语言 |
| [test/telemetry.test.mjs](../sidecars/monitor_board/test/telemetry.test.mjs) | 单元测试与 SQLite 集成测试 |

---

## 2. 数据源

`<appData>` 默认会扫描 `~/.gemini/antigravity`、`~/.gemini/antigravity-ide`、`~/.gemini/antigravity-cli` 三个目录（分别对应桌面端、IDE、CLI），合并后展示。也可以用 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 或 `ANTIGRAVITY_APP_DATA_DIR` 指定。

| 路径 | 用途 | 模块 |
| :--- | :--- | :--- |
| `<appData>/conversation_summaries.db` | 会话索引：标题、父会话、项目、工作区、状态。按 WAL 签名缓存 | discovery |
| `<appData>/conversations/<id>.db` | 单会话轨迹：`steps`、`gen_metadata`、`trajectory_meta`、`parent_references`。也用来补齐还没进索引的会话（如 `/btw`） | metrics、proto |
| `<appData>/annotations/<id>.pbtxt` | 索引里还没有标题时，从这里取重命名后的标题 | discovery |
| `<appData>/chapter_titles/<id>.pb` | 长会话的分章标题与步号范围 | metrics |
| `<appData>/brain/<id>/.system_generated/logs/transcript*.jsonl` | SQLite 未落盘时的用量兜底；提取压缩摘要原文 | metrics、turns |
| `<appData>/brain/<id>/.system_generated/swarm/members.json` | Swarm 成员名、角色、工作区模式 | discovery |
| `<appData>/brain/<id>/.system_generated/subagents/<cid>.json` | 子代理类型、角色、状态 | discovery |
| `~/.gemini/config/projects/*.json` | 工作区 URI → 项目名 | discovery |
| `~/.gemini/config/sidecars/*/sidecar.json` | 识别定时任务（`builtin: "schedule"`） | discovery |
| `<appData>/antigravity_state.pbtxt` | 新建空会话时，读取当前默认模型 | models |
| `<sidecar_data>/data/pricing_override.json` | 用户自定义单价，热加载 | models |
| `<sidecar_data>/data/settings.json` | 订阅方案、计费日、语言、更新检测开关（写于独立沙盒目录） | main |
| `<sidecar_data>/data/usage_ledger.sqlite` | 本地持久化用量账本：缓存根会话树汇总，在会话被宿主删除后保留其历史费用与按天明细（写于独立沙盒目录） | ledger |
| `<sidecar_data>/data/update_cache.json` | GitHub 版本检查缓存（6 小时 TTL，写于独立沙盒目录） | updater |

---

## 3. 解码

### 3.1 `steps` 与 `gen_metadata`

一次模型调用的信息分在两张表里：

- **`steps.metadata`**：体积小，包含时间戳、模型枚举、Token 用量。
- **`gen_metadata`**：包含完整模型标识和上下文窗口信息，但单行常超过 100 KB。

为避免整行读取 `gen_metadata`，[metrics.mjs](../sidecars/monitor_board/telemetry/metrics.mjs) 在 SQL 里直接切片：

- 不超过 8192 B 的行：整行读取。
- 超过 8192 B 的行：只取头 6144 B（请求模型、窗口上限）和尾 1536 B（实际模型、`botId`、`traceHash`）。
- 只对最新一条大行，额外取末尾 98304 B，用来找上下文窗口信息。

**`step_type` 常用值**

| 值 | 含义 |
| :--- | :--- |
| `14` | 用户输入 |
| `15` | 模型响应（计费主体） |
| `17` | 错误 / 系统消息 |
| `23` | 上下文压缩点 |
| `101` | 系统唤醒、通知 |
| `132` | 工具执行（含 `generate_image`） |

**`status` 常用值**：`1` / `2` / `8` 进行中，`3` 完成，`5` 取消（已产生的消耗仍计入），`6` 拒绝，`7` 失败。

**`steps.metadata` 字段**（见 `parseStepMetadata`、`parseModelUsageSubmessage`）

| 外层字段 | 含义 | `field 9`（ModelUsage）内字段 | 含义 |
| :--- | :--- | :--- | :--- |
| `1` | 请求发起时间 `t1` | `1` | 实际响应模型枚举（`1000 + N` 对应 `M<N>`） |
| `6` | 首字到达时间 `t6` | `2` / `5` / `4` | input / cacheRead / cacheWrite tokens |
| `7` | 完成时间 `t7` | `3` / `9` / `10` | output / thinking / response tokens |
| `9` | ModelUsage | `6` | API 通道（`apiProvider`） |
| `11` | 请求的模型枚举 `requestedEnum` | `7` / `8` / `11` | `botId` / session / `responseId` |

**`gen_metadata` 字段**（见 `parseGenMetadataSliceRow`、`findContextField9InLargeTail`）

- 模型标识：tag `0xe2 0x01` → `desiredSlug`，`0x9a 0x01` → `rawSlug`，`0xaa 0x01` → 显示名，`0xa2 0x01` → `MODEL_PLACEHOLDER_M*`，`0x8a 0x01` → `traceHash` 与嵌套用量。
- 窗口上限：`field 3 → 13 → 2 → 22`。
- 上下文窗口信息 `field 1 → 9`：
  - `fn 1`：压缩基准步号 `checkpointStepIndex`；
  - `fn 10`（ContextWindowMetadata）：`cfn 1` 已用 token、`cfn 2` 截断原因、`cfn 3` 各模块构成（对话、工具、系统提示、技能、规则、子代理、MCP 工具等）、`cfn 4` 窗口上限。

### 3.2 `/btw` 分支去重

`/btw` 会话（`trajectory_meta.trajectory_type = 22`，普通会话为 `4`）创建时，会把父会话到分叉点为止的步骤完整复制进新库。直接求和会重复计费。

`parent_references.data`（见 `parseParentRefProto`）里有分叉信息：

| 字段 | 含义 |
| :--- | :--- |
| `1` | 父轨迹 ID |
| `2` | 最后一条复制步的索引 `parentStepIndex` |
| `5` | 引用类型（分支为 `2`） |
| `6` | 父会话 ID |

引擎取「`step_type = 101` 分叉标记的位置」和 `parentStepIndex + 1` 中较大者作为 `effectiveMinStepIdx`，所有查询都带 `WHERE idx >= effectiveMinStepIdx`，只统计分叉之后的新增步骤。

---

## 4. 指标计算

### 4.1 Token

1. 只统计 `idx >= effectiveMinStepIdx`、状态为 `3` 或 `5` 的 `step_type = 15`（以及 `23`）步骤。
2. 如果只记录了 thinking 或 response 之一，用 `output = thinking + response` 补齐另一项。
3. 缓存命中率统一按 `cacheRead / (input + cacheRead)` 计算。
4. `transcript.jsonl` 中因中途撤销/重问而被回滚覆盖的旧分支步骤（自动扫描上限 16 MB，去重保护防止同一步重复 flush 误算），会自动并入主账的 `selfUsd` / `treeUsd` / `tokens` / `daily` / `byModel`，同时在 `cost.retryBranchDeltaUsd` 与 `cost.retryBranchStepCount` 单独标明。
5. 如果 `<id>.db` 还不存在，就从 transcript 的事件汇总。

### 4.2 等效 API 价值

这是把用量按公开 API 单价折算出来的参考值，不是实际账单。

- **单步费用** = `(input × inputRate + cacheRead × cacheRate + output × outputRate) / 1,000,000`。
- **缓存节省** = `cacheRead × max(0, inputRate − cacheRate) / 1,000,000`。
- **长上下文阶梯价**：单步 `input + cacheRead > 200,000` 且模型配置了 `over200k` 时，按阶梯价计算。
- **历史调价**：模型配置了 `schedule[].effectiveFrom` 时，按步骤时间选择当时的费率。
- **生图**：已完成、且带 `generate_image` 标记的 `step_type = 132` 步骤，从末尾 512 B 提取模型名，按张计价。

单价查找顺序：

1. `pricing_override.json`
2. 内置目录 `BASE_MODELS` / `IMAGE_MODELS`（[models.mjs](../sidecars/monitor_board/telemetry/models.mjs)）
3. 未收录的模型：按 `apiProvider` 和名称关键词推断一个兜底价，并标记 `isUnknownModel: true`

内置公开 API 参考单价（美元 / 百万 token；图片为美元 / 张）：

| 模型系列 | 档位 / 枚举 | 未缓存输入 | 缓存读取 | 模型输出 / 单张 | >200K 阶梯价（输入 / 缓存 / 输出） |
| :--- | :--- | ---: | ---: | ---: | :--- |
| **Gemini 4 Carbon** | `High` (`M427`)、`Medium` (`M437`)、`Low` (`M438`) | `$2.00` | `$0.10` | `$10.00` | `$4.00` / `$0.20` / `$15.00` |
| **Gemini 4 Argon** | `High` (`M417`)、`Medium` (`M418`)、`Low` (`M419`) | `$2.00` | `$0.10` | `$10.00` | `$4.00` / `$0.20` / `$15.00` |
| **Gemini 4 Hydrogen** | `XHigh` (`M528`)、`High` (`M525`)、`Medium` (`M526`)、`Low` (`M527`) | `$1.50` | `$0.075` | `$7.50` | `1M` 内平价 |
| **Gemini Pro Orchestrator** | `Carbon` (`M667`)、`Argon` (`M681`)、`Hydrogen` Worker (`M669`) | `$2.00` / `$1.50` | `$0.10` / `$0.075` | `$10.00` / `$7.50` | Planner 适用 `>200K` 阶梯 |
| **Gemini 3.8 Flash** | `High` (`M318`)、`Medium` (`M322`)、`Low` (`M320`) | `$0.75` | `$0.075` | `$3.75` | `1M` 内平价 |
| **Gemini 3.5 Flash** | `Lite` (`M132`) | `$0.25` | `$0.025` | `$1.50` | `1M` 内平价 |
| **Gemini Pro** | `Default` (`M16`) | `$2.00` | `$0.20` | `$12.00` | `$4.00` / `$0.40` / `$18.00` |
| **Claude Opus 5.5** | `High` (`M402`)、`Medium`、`Low` | `$4.00` | `$0.20` | `$20.00` | `1M` 内平价 |
| **Claude Sonnet 5.5** | `High`、`Medium`、`Low` | `$2.00` | `$0.10` | `$10.00` | `1M` 内平价 |
| **Claude Opus 4.6** | `Thinking` (`M26`) | `$5.00` | `$0.50` | `$25.00` | `200K` 物理上限 |
| **GPT-OSS 120B** | `Medium` (`342`) | `$0.09` | `$0.045` | `$0.36` | `131K` 物理上限 |
| **Gemini 3.1 Flash-Lite Image** | `gemini-3.1-flash-lite-image` | — | — | `$0.034` / 张 | 按 `generate_image` 步计价 |
| **Gemini 3.1 Flash Image** | `gemini-3.1-flash-image` | — | — | `$0.067` / 张 | 按 `generate_image` 步计价 |
| **Gemini 3 Pro Image / Imagen** | `gemini-3-pro-image`、`imagen-4` | — | — | `$0.04` / 张 | 按 `generate_image` 步计价 |

`pricing_override.json` 格式（放在 `<appData>/sidecar_data/monowatch/monitor_board/data/` 下，保存后即生效）：

```json
{
  "models": {
    "<model-slug>": {
      "inputRate": 2.0,
      "cacheRate": 0.1,
      "outputRate": 10.0,
      "over200k": { "thresholdTokens": 200000, "inputRate": 4.0, "cacheRate": 0.2, "outputRate": 15.0 },
      "schedule": [
        { "effectiveFrom": "2026-12-01T00:00:00Z", "inputRate": 1.5, "cacheRate": 0.075, "outputRate": 7.5 }
      ]
    }
  },
  "images": {
    "<image-model>": { "perImageUsd": 0.04 }
  }
}
```

单位：美元 / 百万 token；图片为美元 / 张。

### 4.3 上下文占用

压缩之后，累计 token 已经不等于当前上下文占用，所以当前占用按以下优先级确定：

1. **宿主实测**（`source = 'official'`）：取属于当前压缩周期（以 `checkpointStepIndex` 校验）的 ContextWindowMetadata。如果最新一轮还没有刷出这份数据，就在上一次实测值上叠加增量。
2. **压缩后估算**（`isPostCompactionEstimate = true`）：刚压缩完、还没有新的推理步时，按 `12,000 + ceil(摘要字节数 / 3.5)` 估算；没有摘要时取 18,000。
3. **用量兜底**（`source = 'api_usage'`）：取最后一次请求的 `input + cacheRead + response`。窗口上限优先用同端同模型观测到的最大值，其次用模型默认值。

### 4.4 耗时与速度

- **活跃耗时**：按轮次累加执行区间。遇到 `step_type = 101` 唤醒、且距上次活跃超过 `IDLE_WAKEUP_GAP_SEC = 15` 秒时，跳过中间的空闲段，避免跨夜会话或定时任务算出几十小时。
- **TTFT** = `t6 − t1`；没有流式数据时退回 `t7 − t1`。
- **解码速度** = `output / (t7 − t6)`。解码时长小于 0.05 秒或速度高于 650 tok/s 的步骤视为缓存回放，不计入。
- 顶栏有两个速度：`avgStreamTps` 是单个流的平均速度，`totalBurnTps` 是所有活跃会话的速度之和。

---

## 5. 会话关系与归属

### 5.1 派生会话

| 类型 | 落盘方式 | 统计方式 |
| :--- | :--- | :--- |
| `/btw` 分支 | 独立 `<id>.db`，`trajectory_type = 22`，不进索引库 | `kind = 'btw'`，挂到父会话下，按 3.2 去重 |
| Swarm | `swarm/members.json` | `kind = 'swarm'`，解析成员名、角色和工作区模式，整树汇总 |
| 子代理 | `parent_conversation_id` + `subagents/<cid>.json` | `kind = 'subagent'`，费用、耗时、生图数汇总到父会话树 |

### 5.2 模型切换识别

同一会话里出现不同模型时，[routing.mjs](../sidecars/monitor_board/telemetry/routing.mjs) 会区分以下几种情况：

- **规划模式**（`/plan`）：Planner 与 Worker 模型交替出现，轮次会标为 Plan / Execute / Review 三个阶段。
- **用户手动切换模型**。
- **响应模型与请求模型不一致**：例如 `requestedEnum ≠ respondedEnum`、`rawSlug` 带实验后缀，或者出现未收录的模型。

最后一类会在「路由 / Routing」页签汇总，便于核对计价；规划模式和子代理的正常切换不会计入。

### 5.3 运行事件

从 `step_type = 17`、`101` 和失败的 `132` 中识别以下事件，在「事件 / Events」页签与详情页的筛选中展示：

| 类别 | 识别依据 | 备注 |
| :--- | :--- | :--- |
| `safety_filter` | 错误消息匹配内容安全过滤 | 被丢弃的前一步记为 `discardedStepIndex`，其费用单列为 `wastedUsd`，不重复计入 |
| `quota_429` | `RESOURCE_EXHAUSTED`、`429`、额度相关文案 | 会话级提醒 |
| `server_injection` | 宿主插入的系统提示或通知（如子代理重启通知） | 用户自己设的 `/schedule` 唤醒不计入 |
| `upstream_retry` | `API error (attempt N)`、超时、连接中断等 | 记录重试次数 |
| `tool_error` | `step_type = 132` 且状态为 `6` 或 `7` | 视为正常试错，不在「事件」页签展示 |

早期 IDE 会把正常的工具调用写成 `step_type = 17`，这类记录在解码时直接忽略。事件行在逐轮明细里是 `kind = 'incident'`，不计入 `llmStepCount` 和轮次加总，保证 `turnsSum === selfUsd`。被撤销的旧分支步骤（见 4.1 第 4 条）不出现在逐轮明细里，所以存在撤销重问时是 `turnsSum === selfUsd - retryBranchDeltaUsd`。

### 5.4 其他归属

- **项目**：按 `project_id` 和规范化后的文件夹 URI 匹配 `projects/*.json`（同时兼容 `folderUri` 和 `gitFolder.folderUri`）。
- **CLI 批处理**：同一项目里连续的 `agy` 调用会折叠成一组。
- **定时任务**：按 Cron 表达式和提示词指纹打标签；挂起时间按 4.4 节的规则剔除。
- **Arena 对战**：用索引库里的 `battle_id` 和 `winning_conversation_id` 关联。

---

## 6. 运行时

### 6.1 冷热分层

- **热数据**：每次快照只完整计算最近的会话树，包括最多 140 个交互会话（其中至少 40 个留给独立对话）、最多 80 个 CLI 会话，以及所有正在运行的会话（`DEFAULT_*_ROOT_LIMIT`，见 [utils.mjs](../sidecars/monitor_board/telemetry/utils.mjs)）。
- **冷数据**：其余历史会话在后台按每批 120 个分析（`ARCHIVE_CHUNK`），用 `setImmediate` 让出事件循环，汇总成按天的统计放在内存里。这样时间段汇总能覆盖全部历史，而每次轮询不必传输几千个节点。

### 6.2 HTTP 接口

| 方法与路径 | 用途 |
| :--- | :--- |
| `GET /api/snapshot?etag=` | 快照；前端每 1200 ms 轮询一次，未变化时返回 `unchanged` |
| `GET /api/thread?id=&fast=1` | 单会话详情 |
| `GET /api/archive` | 历史会话分页，每页 40 条 |
| `GET /api/stream` | SSE 推送（仅在 `?sse=1` 时启用；最多 4 个客户端，积压超过 256 KB 时断开） |
| `GET` / `POST /api/settings` | 读取 / 保存设置 |
| `GET /api/update-status`，`POST /api/update` | 版本检查与更新 |
| `POST /_sidecar/get-conversation-metadata` | 覆盖 SDK 默认实现，直接从本地数据返回，避免同步调用 `agentapi` 阻塞主线程 |

**鉴权**：所有 `/api/*` 都要求宿主下发的 UI token（`?token=` 或 `X-Sidecar-Token`），GET 请求也不例外。跨域访问只允许回环地址和宿主 webview。静态资源不鉴权，因为不含数据。独立调试模式（`MONOWATCH_STANDALONE=1`，环境里没有 token）下不鉴权。

### 6.3 其他

- **自动重启**：插件自身文件变化时，进程会退出，由宿主重新拉起。自更新也依赖这个机制。
- **主题与语言**：[theme.js](../sidecars/monitor_board/ui/theme.js) 监听宿主的 `--background` 亮度切换明暗；[i18n.js](../sidecars/monitor_board/ui/i18n.js) 跟随系统语言或用户设置。
- **本地调试**：`MONOWATCH_STANDALONE=1 node sidecars/monitor_board/main.mjs`，然后访问 http://127.0.0.1:49880 。需要宿主提供的 `sidecar_sdk`（装好插件后，在 `node_modules/` 下）。

---

## 7. 升级检查清单

Antigravity 大版本更新后，按顺序检查：

1. **新模型**：查看新会话 `steps.metadata` 的模型枚举，以及 `gen_metadata` 的 `MODEL_PLACEHOLDER_M*` / `rawSlug`，补到 [models.mjs](../sidecars/monitor_board/telemetry/models.mjs) 和 [routing.mjs](../sidecars/monitor_board/telemetry/routing.mjs)。
2. **上下文信息位置**：确认 ContextWindowMetadata 仍在 `field 1 → 9 → 10`，窗口上限仍在 `field 3 → 13 → 2 → 22`。
3. **步骤与轨迹类型**：执行 `SELECT DISTINCT step_type, status FROM steps` 和 `SELECT DISTINCT trajectory_type FROM trajectory_meta`，看有没有新值。
4. **Sidecar 接口**：确认 `/preload.js`、`/_sidecar/get-conversation-metadata` 的字段，以及 `--background` 变量没有变化。
5. **测试**：运行 `npm --prefix sidecars/monitor_board test`。

---

## 8. 已知限制

1. **`run_workflow` 派生的子代理**：费用已经计入父会话树，但列表里和普通子代理混在一起，还没有按工作流批次分组。
2. **精度标记**：后端已经输出 `waterline.source`、`waterline.limitSource`、`isPostCompactionEstimate`、`model.isUnknownModel`，但前端还没有标出「实测 / 估算 / 兜底价」。
