# 短期上下文管理实施计划

## 1. 目标与非目标

本计划为 PRALE 的 provider 请求建立分层、自动且可恢复的短期上下文管理（Short-Term Context Management, STCM）。其参考 Claude Code 的 query 前处理顺序：大工具结果预算、history snip、micro-compact、context-collapse、常规摘要压缩；但不复制其进程内消息数组、feature gate 或 Anthropic 专属 wire payload。PRALE 的 Session entry tree、usage 和 effect ledger 的现有不变量优先。

目标：

- 每次新的 generation effect intent 写入前，自动将 provider 输入控制在模型上下文预算内；
- 对大工具结果先做无模型调用的投影裁剪，再逐级采用可逆的内容清除和摘要；
- 保留原始 `message` entry 和工具结果，供恢复、审计、L0 archive、Skill 和长期记忆使用；
- 将会影响 provider 可见输入的决策冻结在 durable intent 中，重启、retry 和同一 operation 的恢复不会重新估算或改变上下文；
- 在 provider 支持 prompt-cache 编辑时利用该能力；不支持时保持同样的语义性投影，绝不伪造 cache-edit 请求；
- 在仍无法满足预算时受预算地召回既有长时记忆，而不是静默丢失任务关键事实。

非目标：

- 不删除、替换或截断权威 entry payload；
- 不让 `domain/` 依赖具体 provider、tokenizer、SQLite 或 HTTP；
- 不把 Claude Code 的全局模块状态、时间驱动的 cache TTL 猜测或其内部 feature 名称直接移植进来；
- 不在后台线程与 Drive 竞争修改 lane；所有短期上下文决策只由持有该 lane 的 Drive 作出；
- 不把长期记忆当作完整聊天记录或 compaction 的唯一恢复来源。

## 2. 当前状态与缺口

当前 `Lane.compact()` 是显式操作：只要 lane 有 tip 就可执行。`Drive._run_compaction()` 固定保留最近四个 entry 中的 message，并对 `project_messages(context)` 请求摘要。它追加 `compaction` entry（`summary`、`retained_message_ids`）且后续 projection 只发送最新摘要、声明保留的旧 message 及摘要后的消息。历史没有被删除。

这个实现正确地满足了摘要压缩的 durable settlement，但尚缺少：

1. token/字符预算、模型上下文窗口和输出预留；
2. 每次 query 前的自动处理；
3. 对单个或聚合工具结果的限制；
4. 无需 LLM 的旧工具结果清除；
5. 多个局部摘要/折叠范围的可组合投影；
6. provider cache-edit 能力的协议边界；
7. 在压缩后仍超限时的可观测 memory fallback。

现有长期记忆的 L0 archive 已明确要求从 terminal tip 的原始 branch entries 生成，不能从 provider context 生成。本计划不得改变该规则。

## 3. 设计原则和处理顺序

### 3.1 两种视图

每一轮必须明确区分：

- **authoritative history**：Session 的有序 branch entries。它是唯一的恢复、L0 capture 和审计来源；
- **request view**：从 authoritative history 派生、仅用于一条 generation 或 summary effect 的 provider messages。它可以裁剪、替换和折叠，但不会写回原始 entry。

所有请求都按下面顺序构建 request view。前一层无变化时为纯 no-op，后一层只能处理前一层的输出：

```text
branch entries
  -> 基础 projection（已有 compaction / branch summary）
  -> 单工具结果预算（hard trim）
  -> snipCompactIfNeeded（旧的可丢弃消息范围）
  -> micro-compact（旧工具结果 placeholder / provider cache edit）
  -> context-collapse **或** global auto-compact（同一 lane 二选一）
  -> hooks: transform_context（仍先看到完整基础 projection）
  -> 自动 prompt memory / skill listing
  -> before_request / before_payload / selected skill loadout
  -> 最终预算验证；必要时受预算的 memory fallback
  -> durable generation intent
```

这是一个刻意保持兼容的 hook 边界：当前 `transform_context` 接收的是完整的 `project_messages(context)`；缩减层不得悄悄挪到它之前，否则会改变既有 hook 的输入语义。它在 hook 返回后、写入 provider intent 前处理 hook 可见的会话消息。自动 prompt-memory、skill listing 仍按现有顺序插入；`before_request`、`before_payload` 随后运行，selected skill loadout 又在 `before_payload` **之后**加入。因此最终、只读的预算验证必须位于 loadout 和 memory fallback 之后。若 hook/loadout 造成超限，运行时返回明确的 `ContextBudgetExceeded`，而不是自动移除调用方内容。

### 3.2 预算口径

新增纯领域 DTO `ContextBudget` 与 `ContextEstimate`：

- `context_window_tokens`：此 provider/model 可接受的输入加输出总窗口；
- `reserved_output_tokens`：为正常 answer/tool call 保留的输出额度；
- `reserved_system_tokens`：固定 system prompt、工具 schema、已选 skill 和 memory 的保守预留；
- `soft_limit_tokens = context_window - reserved_output - reserved_system - soft_margin`；
- `hard_limit_tokens = context_window - reserved_output - reserved_system - hard_margin`，其中 `hard_margin > 0`，以覆盖字符估算误差。

新增 `TokenEstimator` 协议。默认实现必须以现有 `repository_explorer._token_estimate()` 的最终 wire JSON 保守估算为基线，即 `ceil(UTF-8 bytes / 3)`，而不是另造不一致的字符公式；消息 JSON、CJK、图片/文档详情和 tool schema 由同一 estimator 计入。DeepSeek adapter 可提供模型专用 estimator，但不可把 SDK 类型穿透到 runtime。provider 返回的 prompt token usage 仅校准下一次估算，不能改变已经 durable 的 intent。

预算、估算器 ID/版本、各层输入/输出 token 估算和采取的动作必须写入 operation trace 及 telemetry。配置必须可注入到 `Harness.open()`；部署层再从 Settings 读取环境变量。首版基线应贴近参考实现：`soft_margin_tokens=13_000`、`hard_margin_tokens=3_000`、`reserved_output_tokens=min(model_max_output, 20_000)`；其他值要求由 provider 配置显式给出。没有 context window 时禁用自动摘要、保留 hard trim，并发出 `context_budget_unavailable` 事件。

### 3.3 选择与保留规则

不按“最后 N 个 entry”粗略保留。所有缩减算法必须将 assistant tool-use 与相应 tool-result 视为不可拆分的 turn fragment，并保护：当前 user prompt、其紧邻的最近 assistant/tool exchange、尚未结算的 tool call、最新 explicit compaction/branch summary、system messages 和已注入的 memory/skill anchors。一个 fragment 要么完整可见，要么通过明确的摘要或 placeholder 表达；不得留下 `tool_result` 而移除其 `tool_call`。

每个缩减记录需要稳定 source entry IDs、tool call IDs、估算前后 token、内容 hash（不含原文）和策略版本。相同 source 与策略的重复运行必须 idempotent。

## 4. 分层策略

### 4.1 大工具结果预算（hard trim）

在工具 settlement 后保留完整的 `{content, details, is_error, terminate}` 于原始 tool message entry。request view 生成时：

1. 根据 tool definition 的可选 `max_result_tokens`（优先）或全局 `per_tool_result_tokens` 计算每个结果上限；默认基线为每结果 50,000 chars、每条 tool message 200,000 chars，并覆盖工具自身已经较小的输出上限（本地 `bash` 为 2,000 行/50 KiB，`repository_explore` 有 max_tokens/wire budget，`read` 已有分页）；
2. 对超限文本优先复用已持久化的可恢复句柄和现有 details 约定：`read` 的 `path`/`offset`/`limit`，`bash` 的 `full_output_path`，以及 `truncation.{truncated,truncated_by,total_lines,total_bytes}`。投影视图显示稳定 preview（优先在换行边界切、含原始字节/token 和 handle），而不声称“重新执行相同 tool”一定可重现旧结果；没有可恢复句柄时才退化为 UTF-8 安全的 head+tail/hash。结构化内容按字段级上限递归裁剪，二进制/image/document 采用固定 token 成本并保留 metadata；
3. 同一 tool-result message 的所有 block 合并计算 `per_tool_message_tokens`，超过聚合上限时按原始 tool-call 顺序处理；错误和 `terminate=True` 的结果只可在超过 hard limit 时裁剪，并保留错误摘要；
4. 记录 `tool_result_trimmed` trace/event，但不创建新的对话 entry。

`ToolDefinition` 位于 `runtime/generation.py`，由 `ToolRegistry.definitions()` 从 `AgentTool` 生成；`AgentTool` 现为全必填 Protocol。首版不能直接给每个工具增加必填字段：以独立可选 `ToolContextLimits` capability（运行时用 `getattr(tool, "max_result_tokens", None)` 读取）或 `ToolRegistry` 的外部配置表提供覆盖，未声明工具回退全局值。`ToolResult` 的持久格式不变。这样大型 `read`、`bash`、`repository_explore` 输出不会迫使先运行 LLM compaction，也不会破坏恢复。

### 4.2 `snipCompactIfNeeded()`：query 前历史 snip

新增 `domain/context_management.py` 的纯函数 `snip_compact_if_needed(entries, budget, policy)`。每次 `_persist_generation_intent()` 建立新 intent 前调用，永不在正在执行的 `assistant.effect_pending` 上调用。

算法：

1. 从已应用的结构性摘要之后，以 turn fragment 为单位估算；
2. 若总量未超过 `snip_trigger_tokens`，返回原 view；
3. 若超过，优先剔除最旧的、已被现有 compaction/branch/context-collapse 覆盖且不属于 protected tail 的原始 fragment；
4. 对未被摘要覆盖的可安全省略 fragment，插入一个单独的 system notice，说明省略范围、entry IDs 范围和如何通过 memory/工具重新获得信息；不得假称已总结其内容；
5. 达到 `snip_target_tokens` 或没有合法候选时停止。输出 `SnipDecision`（移除范围、notice、估算节省、无法继续的原因）。

snip 是 request-view 层面的临时投影，不移动 tip、不修改 entry tree，也不产生额外 LLM effect。其决定的完整 messages 会随 generation intent 原子持久化；重启/retry 直接复用 intent，因而不会发生“同一次远端调用换了一份 snip”的情况。手动 `compact()` 的摘要输入也必须先应用 hard trim 和 snip，以免摘要请求本身超限。

### 4.3 micro-compact：旧工具结果清除与 cache-edit

新增 `MicroCompactPolicy`。当普通请求仍超过 `microcompact_trigger_tokens`，或在同一 lane 的可配置 idle gap 后 cache 冷却时，选择不在 protected tail 的旧、成功且可重放读取的工具结果。request view 将其 `content` 替换为精确占位文本：

```text
[Old tool result content cleared]
```

占位文本必须附带稳定的 tool call ID、来源 entry ID、原始内容 hash 和“原始结果仍在 session history”这一 machine-readable metadata；provider adapter 将 metadata 转为其允许的内容格式。`is_error`、`terminate`、tool call/result 关联和原始 details 不可删除。

选择记录以 `ContextReductionRecord(kind="micro_clear")` 只追加地存入独立的 Session list（不能依赖可选 TraceRecorder）。每条记录带 `source_entry_ids`、`source_tip_id`、tool call IDs 和 source hash；在任一请求的 `scan_branch(tip)` 得到当前 branch ID 集后，**仅**应用 `source_entry_ids` 全属于该集合的记录。lane 的可替换 `context_view_checkpoint` 只是加速索引，不能作为 branch 归属或权威来源；丢失时从 reduction list 并按 source-ID 过滤重建。恢复时同一 source ID 已清除则保持清除，新增的工具结果才参与选择。不会把 placeholder 写进原始 tool entry。

新增可选 `PromptCacheEditor` provider capability：

- capability 输入是稳定 tool call IDs 及删除列表，输出 provider 所需的 cache-edit payload 和确认的删除 token；
- 支持该能力时，先冻结 deletion plan，再在同一次 provider request 附带 cache reference/edit；本地 request view 仍保持原内容，以保持 cache prefix；
- server 成功返回后才把 cache edit 作为已确认 trace fact，并发出 `cache_edit_applied`；失败或 provider 不支持时降级到上述本地 placeholder view，不可把“已从 server cache 删除”写成事实；
- cache state 必须按 `(session_id, lane, provider identity, model)` 隔离，且在 manual compaction、navigation 到其他 branch、prompt cache key 改变和 provider failure 后失效。

PRALE 当前 DeepSeek adapter 没有这个 capability。因此第一阶段只实现本地 placeholder 投影及 capability 协议/contract test，不发送 Anthropic 专属字段。

### 4.4 context-collapse：局部、可组合摘要

当 snip 和 micro-compact 后仍超过 `collapse_trigger_tokens`，且 lane 选择 `collapse` 模式时，创建局部摘要，而不是立刻把整个历史压为一条 `compaction`。`collapse` 与 global auto-compact 是同一 lane 同一轮的互斥策略：启用 collapse 后，正常的 global auto-compact 阈值被抑制；collapse 以 soft limit（建议约 90% effective window）提交局部结果，并在 hard/blocking limit（建议约 95%）前保留 headroom。这避免刚提交 collapse 又立即全局摘要的抖动和额外 LLM effect。

只有 collapse 明确返回 `not_eligible`、`source_too_large`、`insufficient_savings`，或其 effect 无法提交/被恢复为 unknown，才允许在同一 intent 建立前**一次性**切换到 global auto-compact；该原因、源 tip 和 mode transition 必须 durable。成功 collapse 后，必须有新的可折叠 source range 才能再次 collapse；不得因仍处同一 source tip 而改走 global auto-compact。新增 structural entry type `context_collapse`，payload 至少包含：

- `summary`、`covered_entry_ids`、`covered_from_id`、`covered_to_id`；
- `retained_entry_ids` 和受保护的 assistant/tool pair IDs；
- `parent_collapse_ids`（允许对已有 collapse 的摘要再折叠）；
- `source_content_hash`、`policy_version`、`estimated_tokens_before/after`；
- `status`（`completed | unknown`）和 provenance。

新增 run 内部状态机（不是第二条并发 lane operation）：

```text
assistant.ready
  -> context.collapse.effect_pending
  -> assistant.ready
  -> assistant.effect_pending
```

摘要 effect 必须有明确提示词，而不是把 `project_messages(context)` 原样发送。新增 provider-neutral `CompactionPromptBuilder`，构造：无工具 preamble/trailer、完整摘要 schema、两种 partial prompt（摘要在被折叠区间之前/之后的措辞）、目标范围与保留 tail、以及“只返回 continuation summary、不得调用工具”的指令。输出先允许 `<analysis>` 草稿，再以 `format_compact_summary()` 剥离草稿、验证 schema/上限并持久化最终摘要；若格式不合格，使用带 `[earlier conversation truncated for compaction retry]` 的 retry prompt，最多三次，然后报告 `summary_invalid` 而非提交伪摘要。每次 retry 都是新的、带 attempt/span 的 durable LLM effect，绝不在既有 effect intent 上原地重发。summary 请求的 `GenerationRequest.tools` 必须为空。

摘要的后续投影也必须由 builder 定义，而不能只拼接裸文本：以一个明确的 continuation user message（`This session is being continued…`，包含格式化摘要）表达已折叠历史，再追加 retained fragment 与新消息；它替换当前仅有的 `Conversation summary:` system 文本格式。该角色/文案、summary schema 和 prompt version 都是可演进的持久格式，迁移期间旧 `compaction` payload 继续用现有 system-summary projection。

状态转换前，在同一 Session transaction 中写入 collapse LLM effect intent、span、prompt version/retry count 以及冻结的 compacted source request；LLM 返回后，在一个 transaction 中写入 `context_collapse` entry、结算 span、更新 lane tip/context checkpoint，然后回到 `assistant.ready` 重建最终 generation intent。中断 recovery 必须扩展 `Drive.recover()` 的分支，并仿照既有 `_settle_interrupted_compaction()` 将该 effect 收束为 `unknown`，不自动重放；unknown collapse 不覆盖 source range，系统退回 snip/micro-compact/fallback，避免用占位“摘要”静默丢失历史。

`project_messages()` 重构为读取 `ContextViewPlan`：按 branch 顺序解析全部 completed、非重叠的 collapse/compaction/branch-summary 覆盖区间，输出由 `CompactionPromptBuilder` 定义的 continuation summary message、每区间 retained fragment 和区间外消息。发生重叠时只接受完整包含且 `parent_collapse_ids` 已声明的嵌套折叠；其他交叉重叠判为 storage corruption。最新 structural entry 不再是唯一选择依据。`context_collapse` 是真正的 branch entry，按祖先链过滤；§4.3 的 root-level reduction records 则按 source-entry-ID 集过滤，两者不得混淆。

常规 `Lane.compact()` 保留为用户显式的“全局摘要”操作，但改用相同 `ContextViewPlan`、token budget、`CompactionPromptBuilder` 和 durable effect helper。自动模式的互斥规则不限制用户显式 compact。

### 4.5 auto-memory 兜底与全局 auto-compact

PRALE 已有 `MemoryRuntime.recall()` 的受预算、fail-open 检索，以及现有 `_persist_generation_intent()` 对 bundle hash/items 的冻结和 `record_injection()` 审计。本计划复用这些能力，不新建平行 memory 管道；它只是最后的语义兜底，而不是短期历史替代：

1. 当 collapse 后仍高于 hard limit，或 snip 表示被移除范围含当前 prompt 的实体/文件/任务引用时，用当前 prompt 与被省略范围的 source hashes 查询 `MemoryRuntime`；
2. 以现有 `RecallBudget` 的独立 `memory_fallback_budget_tokens` 限制召回内容，并将 bundle 按既有 `ContextAssembler` 注入；bundle ID、item IDs、版本、hash、预算和 source range 必须冻结进 generation intent；
3. fallback scope 与 `prompt_memory()` 一致：默认只自动注入 L3 和 L2 catalogue；L0/L1 仍需通过既有 memory tool 取证，不能因上下文压力绕过该边界；
4. 只有 memory runtime 已启用、scope 已确定且检索成功才注入；索引/embedding/provider 失败必须 fail-open 并记录，而不是阻塞 Drive；若仍超 hard limit，只有 §4.4 指定的 collapse 失败/耗尽例外才可尝试一次 global auto-compact，否则终结该 operation 为 `ContextBudgetExceeded`，绝不发送已知会超限的请求。

全局 auto-compact 复用现有 compaction prompt/settlement helper，但自动接纳只能由当前 run Drive 在 lane 内完成，不能调用公开 `lane.compact()` 抢占自己；它使用与 collapse 对称的内部 `context.global_compaction.effect_pending` 状态，而非伪造第二条并发 operation。新增 `auto_compaction` provenance、阈值、reason、先前 collapse outcome 和连续失败计数。连续失败达到配置上限时打开 circuit breaker；后续轮次直接返回明确错误，直到用户显式 `compact()`、navigation 或新成功的结构性缩减重置它。

## 5. API、领域模型和持久化改动

### 5.1 新的公开配置与观察 DTO

在 `api/models.py` / `api/harness.py` 增加不可变 DTO：`ContextManagementConfig`、`ContextBudgetSnapshot`、`ContextReductionReport`。`Harness.open(..., context_management=...)` 接受配置；默认 `enabled=True`，但 context window 未配置时只启用 hard trim 和显式 compaction。部署 Settings 增加严格校验的 `PRALE_CONTEXT_*` 环境变量；API/RPC/Web 只透传稳定 DTO。

配置至少含：窗口与输出预留、各层 trigger/target、per-tool/per-message 限额、protected tail（以 turn fragment 数而非 entry 数）、micro-clear keep-recent、idle-gap（默认关闭）、collapse 最大 source tokens、memory fallback budget、auto-compact failure cap，以及每项策略开关。所有阈值必须满足 `0 <= target <= trigger < hard_limit`；不合法设置启动即拒绝。

新增事件：`context_budget_measured`、`tool_result_trimmed`、`history_snipped`、`micro_compacted`、`cache_edit_planned`、`cache_edit_applied`、`context_collapse_started/settled`、`memory_fallback_injected`、`auto_compaction_started/failed`。事件包含计数、token、hash 和 ID，不含被裁剪正文。

### 5.2 domain

在 `domain/context.py` 之外增加纯模块 `domain/context_management.py`：预算 DTO、fragment builder、纯 token-estimate inputs、trim/snip/micro selection、覆盖区间验证和 `ContextViewPlan`。`domain/entries.py` 扩展 `EntryType` 为 `context_collapse`，并为 structural payload 提供解析/验证函数。`OperationState.at` 现为裸 `str`，所以无需改 `domain/operations.py` 或 `domain/types.py`；实现必须扩展的是 `Drive.run()` 的 match 和 `Drive.recover()` 对 `context.collapse.effect_pending` 的显式分支，避免未知状态落入 `RuntimeError`。

### 5.3 storage 与迁移

entry table 已可存 `custom`/新 type；若 SQLite 有 `CHECK(type)`，新增前向 migration。新增值/list 地址（名称以实现时的 `domain.values` 常量为准）：

- `lane/{lane}/context_view_checkpoint`：最后已应用的 reduction ID/branch tip/policy version（仅索引，非 branch 归属）；
- `operation/{id}/context_report`：终态可查询的缩减报告；
- `operation/{id}/context_reductions`：只追加的 reduction IDs 索引。

每次 reduction record、context collapse entry、operation state、effect span、usage、lane tip 以及 context checkpoint 的相关写入必须同一 Session transaction 提交。当前只有 `test_effect_spans.py` 做 memory/SQLite 双后端参数化；本项目必须新建针对 context entry type、value/list、原子提交和旧 session 打开的双后端 conformance suite，不能假定已有 suite 覆盖它。旧 session 没有 checkpoint 或 records 时，以“无 reduction、沿用旧 compaction projection”兼容读取；不得重建、迁移或截断旧 entries。

### 5.4 provider 协议

`GenerationRequest` 增加 provider-neutral 的 `context_management` metadata（只含预算/trace 标识，不带 provider wire 字段）。`ChatProvider` 可选实现 `ContextManagementProvider`：token estimation、context window 描述、prompt cache edit encoding/ack。DeepSeek 只实现其确实支持的部分。adapter 必须在边界把 `ContextViewPlan` 输出转为 wire messages；runtime 不读取 SDK usage 或 cache headers。

## 6. 实施阶段

| 阶段 | 交付物 | 验收标准 |
|---|---|---|
| 0：规格与基线 | 本文、ADR、现有 compaction 投影回归测试 | 明确 immutable history、互斥策略、摘要提示词和 recovery 语义；补齐现有 `summary.effect_pending` 的 crash-recovery 模板（intent 后/effect 后/settlement 前） |
| 1：纯预算与 projection | `ContextBudget`、estimator、fragment builder、hard trim、`ContextViewPlan` | domain 单测覆盖 CJK/JSON/图片、tool pair 不拆分、旧 compaction 兼容、确定性/idempotence |
| 2：intent 接入与 snip | `_persist_generation_intent()` query 前 pipeline、report/事件、配置/Settings | 每次新 intent 自动执行；同一 intent recovery/retry 字节级复用 messages；hook 超限被拒绝 |
| 3：micro-compact | durable reduction records/checkpoint、本地 placeholder、idle policy | 原始 tool entry 完整；重开 SQLite 后得到同一 placeholder 集；navigation/fork 隔离 |
| 4：cache-edit capability | provider-neutral capability、DeepSeek no-op、fake provider contract | 只在 capability ack 后记录 applied；不支持/失败安全降级且不泄露 wire payload |
| 5：context-collapse | entry type/migration、run 内部 effect state、区间 projection | 多个非重叠/嵌套 collapse 可重建；effect 各崩溃点均可恢复；未知 collapse 不覆盖历史 |
| 6：memory 与互斥 auto compact | 复用 recall fallback、collapse/global 仲裁、circuit breaker | recall 版本冻结；memory 失败 fail-open；正常 collapse lane 不触发 global auto-compact；仅记录的 collapse 失败/耗尽例外可切换一次；不可压缩超限显式失败，不发送 provider request |
| 7：可观测性与迁移 | RPC/Web DTO、telemetry、文档/示例、性能基准 | 长度/节省可观测但不上传正文；Memory/SQLite 全量回归通过 |

每阶段先完成 unit/conformance/crash-recovery 测试，再接 runtime 和 SQLite。阶段 5、6 之前不可宣称自动 context-collapse 或 auto-memory 已实现。

## 7. 测试矩阵

除现有测试外，至少新增下列测试：

- **unit**：估算有界且确定；持久化 handle/preview 优先于 head+tail；聚合预算；tool-use/result 成对；snip 不移除 protected tail；micro-clear 保留错误语义；覆盖区间的无交叉/合法嵌套校验；同一输入得到相同 plan；旧 compaction payload 无 tail 的降级；compaction prompt 的 partial 两方向、`<analysis>` 剥离、无工具约束和三次 PTL retry 上限。
- **conformance**：新建 memory/SQLite 双后端参数化 suite，验证新增 entry type、reduction list、checkpoint、原子提交、旧 session 打开和迁移；不得以现有单后端 storage 测试替代。
- **integration**：`transform_context` 仍收到完整基础 projection，缩减在其后；最终预算校验位于 loadout 后；每次 `assistant.ready` 前 pipeline 都运行；intent 含最终 messages/report；工具大输出不再进入 provider；collapse/global 互斥及唯一例外；缓存 capability 的 supported/unsupported/failure 路径；既有 recall/prompt-memory 的预算、引用和 fail-open。
- **crash recovery**：先补齐既有 `summary.effect_pending` 的 intent 后、effect 后、settlement 前 crash cases；再覆盖 hard trim/snip 后 intent 前、collapse intent 后/provider effect 后/summary entry 前、micro record/checkpoint 前后、cache edit request 后/ack 前、允许的 auto compact intent 后。每个断点均验证无重复外部 effect、span 被结算、tip/entry 一致，以及重启后 provider 可见上下文符合冻结 intent。
- **branch/长期记忆**：fork 或 navigate 后以当前 `scan_branch(tip)` 的 source-ID 集过滤 root-level reduction records，不应用另一分支记录；collapse 另以祖先链过滤；L0 archive 仍取得未裁剪的工具结果；长期记忆只接收脱敏后的 archive，不接收 placeholder 当原文。
- **property/fuzz**：随机 entry tree、工具批次和缩减阈值下，projection 不产生孤儿 `tool_result`、不超过 hard limit（或明确失败）、没有交叉 collapse，且不改变原始 entries。

验证命令至少包括受影响的 `pytest`、`ruff check .`、`ruff format --check .` 与 `mypy`。

## 8. ADR：短期上下文只做持久化投影，不改写历史

**背景：** Claude Code 可在会话消息数组或 provider cache 上删除工具内容；PRALE 的 entries 还承担 crash recovery、L0 archive、审计和 branch 重建。直接把旧 tool result 改成 placeholder 会损坏这些权威用途。

**决策：** 原始 entry 永远仅追加；裁剪、snip、micro-clear 和 collapse 都产生 request view 或 append-only reduction/collapse record。实际 provider messages 与策略/来源冻结进 effect intent。cache-edit 是 adapter capability，且其成功事实单独结算。

**后果：** storage 会保存少量索引和审计元数据，读取 projection 更复杂；换来的是可恢复性、分支隔离、完整 L0 原料和 provider 无关性。

## 9. ADR：context-collapse 是 run 的内部 durable effect

**背景：** 自动 collapse 发生在同一 user prompt 的 provider 请求之前；若把它作为独立公开 `Lane.compact()` operation，会与当前 run 争夺单 lane，且无法原子地回到原 prompt。

**决策：** 使用 run operation 的 `context.collapse.effect_pending` 内部状态和标准 intent → effect → atomic settlement 协议。显式 `Lane.compact()` 仍是独立的用户操作。

**后果：** Drive 的状态机和 crash suite 增加一个 effect 边界，但不破坏 lane admission、取消和 terminal result 的既有语义。

## 10. ADR：collapse 与 global auto-compact 在自动模式互斥

**背景：** 局部 collapse 在接近窗口上限时已承担释放 headroom 的职责。若随后按同一 token 阈值立即运行全局摘要，会额外增加 LLM effect、破坏局部的细粒度上下文，并可能每轮重复压缩。

**决策：** lane 自动模式选择 `collapse` 或 `global_auto_compact`。启用 collapse 时正常 global auto-compact 完全抑制；collapse 在 soft/hard 两级阈值管理 headroom。只有已 durable 记录的 `not_eligible`、`source_too_large`、`insufficient_savings` 或 effect unknown/失败可允许本轮一次性 fallback 到 global auto-compact。手动 compact 不受此仲裁限制。

**后果：** 配置、telemetry 和测试必须显式显示 mode 与切换原因；实现不得把“collapse 后仍大”本身当作直接执行全局摘要的理由。

## 11. ADR：auto-memory 是受预算 fallback，而非短期历史替代

**背景：** 摘要/清除可降低 token，但可能移除当前任务所需的旧事实；PRALE 已有来源可追溯的长期记忆。

**决策：** 仅在短期缩减仍无法满足预算或检测到关键 source 范围被省略时，复用既有受预算 `MemoryRuntime.recall()` 和 intent/injection 审计注入冻结 bundle，且遵守 `prompt_memory()` 的 L3/L2 自动注入边界。检索失败不阻塞；仍超限通常明确失败，只有 collapse 已记录为无法提交或已无可省 token 时才可切换一次可恢复的 global auto-compact。

**后果：** 记忆不会悄悄覆盖聊天历史，且每次注入都可审计；部署方必须为 memory scope、预算和隐私策略作出明确配置。
