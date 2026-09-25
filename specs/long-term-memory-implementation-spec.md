# 长期记忆实现规范

## 1. 目标、范围与术语

本规范为 Python Agent Harness 增加可恢复、可隔离、不会阻塞主 Drive 的长期记忆能力。它借鉴 L0--L3 晋升与“先高层、后具体”的召回方式，但以本仓库的 Session、Lane、Operation 和 effect intent 不变量为准。

记忆回答“知道什么”，不保存可执行操作流程；后者属于 [Skill 自进化功能接入](skill-self-evolution-integration.md)。`Session` 仍是单次对话和执行的唯一写拥有者。长期记忆由独立的 `MemoryStore` 持有，不能作为 `Session` 的 value/list 或 entry tree 的替代品。

本阶段包括：跨 Session 的 L0--L3 数据模型、异步晋升、受预算的召回、身份隔离、SQLite 实现及恢复/审计。它不包括跨进程多主写入、记忆资产的团队审批 UI、模型权重训练，或把全部历史自动塞入 prompt。

术语以根目录 [CONTEXT.md](../CONTEXT.md) 为准。本文中的 **必须** 是验收条件；**建议** 可替换，但不能削弱权限、可追溯性或主运行时的恢复性。

## 2. 架构和所有权边界

```text
Harness / Drive
  ├─ SessionStore                 # 当前会话的 entries、operations；现有权威状态
  ├─ MemoryRuntime                # 编排 capture、recall 和后台晋升
  │    ├─ MemoryStore             # L0/L1/L2/L3、任务、索引、审计
  │    ├─ MemoryExtractor         # provider 中立的 LLM 抽取协议
  │    └─ EmbeddingProvider?      # 可选；不可用时不影响关键词检索
  └─ ContextAssembler             # 将 RecallBundle 投影成 provider 请求上下文
```

新增包布局：

```text
src/agent_harness/
  domain/memory.py                # 纯 DTO、状态、预算和纯合并策略
  memory/protocol.py              # MemoryStore、MemoryExtractor、EmbeddingProvider 协议
  memory/runtime.py               # capture/recall、任务调度与恢复
  storage/memory_sqlite.py        # 记忆 SQLite 后端与迁移
  integrations/memory_provider.py # LLM/embedding 适配器；不泄漏 wire payload
tests/{conformance,integration,crash_recovery}/memory_*.py
```

`domain/` 不得导入 SQLite、向量库、HTTP 或 provider SDK。`runtime/` 通过协议使用记忆；provider 请求由 `ContextAssembler` 生成。L2/L3 的人类可读 Markdown 只是一种投影/导出，SQLite 中的版本与来源引用才是权威记录，防止文件与数据库双写不一致。

### 2.1 Session 是 L0 的来源，不是 L0 的替代品

应复用现有 Session，而不是在每次 message/tool settlement 时再写一份平行聊天记录。当前 entry tree 已持久化且只追加，包含 user、assistant、tool、compaction 和 branch summary；operation meta/result 给出了 operation 的边界。因此一个 terminal operation 的 L0 输入必须由其 **terminal tip 的有序 branch entries** 生成，而不是读取“当前 provider context”。后者会在 compaction 后只包含摘要和保留消息，不能代表原始对话。

L0 仍须作为 `MemoryStore` 的独立、不可变 archive 保存。这不是双写两个权威聊天记录：Session 是执行期的权威来源；L0 archive 是从一个已提交的 Session snapshot 派生的、受 MemoryScope 保留策略管理的晋升输入。独立 archive 的必要性在于 Session 可被删除、fork、导航，且 MemoryStore 的 worker 不应在数小时后读取已变化或不可用的 Session。

capture outbox 至少冻结 `session_id`、`lane`、`operation_id`、terminal `tip_id`、`source_entry_ids`（按 branch 顺序）、`source_entry_hash`、`trace_format_version` 和 scope。dispatcher 按这些 ID 读取 immutable entries 后写入 L0 archive；它不得改用 dispatch 时的 lane tip。唯一 capture key 为 `(session_id, operation_id, terminal_tip_id, source_entry_hash)`，因而 fork 后相同的 entry IDs 也不会混淆来源。

### 2.2 身份与可见性

每次 `Harness.open` 必须可选接收不可变 `MemoryScope` 和 `MemoryRuntime`。未配置二者时，现有 harness 行为不变，且不进行 capture、召回或后台任务。`MemoryScope` 至少包含：

```python
@dataclass(frozen=True, slots=True)
class MemoryScope:
    team_id: str
    agent_id: str
    user_id: str | None
    task_id: str | None = None
```

`session_id` 仅作为 L0 来源和任务去重维度，不能单独授予跨 Session 访问权。查询必须先按 scope/资产可见性过滤，再进行关键词或向量排序；不得先全库搜索再在应用层过滤。初版默认仅允许同一 `(team_id, agent_id, user_id)` 读取与写入；团队共享必须以后续显式绑定/ACL 功能实现。

## 3. 数据模型与持久化

所有记录须带 `id`、`scope`、`created_at`、`updated_at`、`version`（适用时）、内容哈希和可追溯来源。ID 由注入的 ID factory 生成；时间由可注入 clock 提供。

| 层 | 权威对象 | 写入模式 | 保留规则 |
| --- | --- | --- | --- |
| L0 | `SessionTraceArchive` | append-only | Session snapshot、完整已持久化对话轨迹、可选 effect trace、脱敏状态 |
| L1 | `AtomicMemory` | 新建或以 version 取代当前版本 | 保留来源、类型、置信度、场景和 supersedes 链 |
| L2 | `ScenarioMemory` | 乐观锁替换整个 Markdown 内容 | 保留版本及输入 L1 watermarks |
| L3 | `CoreMemory` | 乐观锁替换整个 Markdown 内容 | 每个 scope 一个当前版本及历史 |

### 3.1 L0 SessionTraceArchive

L0 是唯一不可丢失的晋升原料，也是对已完成 Session 轨迹的保留快照。一个 archive 包含 `archive_id`、`scope`、`session_id`、`lane`、`operation_id`、terminal `tip_id`、capture key、`trace_format_version`、`created_at`、`content_hash`，以及按 branch 顺序的 `TraceItem`。`TraceItem` 至少保留 source entry ID/sequence/timestamp/type、role/content、tool call/result、compaction/branch summary 和脱敏标记。L0 可为 FTS/embedding 将每个 item 建立派生索引，但 archive 是原文和来源的权威载体。

仅在一个 operation 已 terminal、且 assistant/tool outcome 均已 durable 后 capture。这样一个 archive 天然包括该 operation 前可见的历史和本 operation 新写入的 user/assistant/tool entries；它不应只捕获单轮 prompt。导航和 compaction 是普通 operation：它们各自产生 archive，但 extractor 应通过 `operation_kind`、terminal status 和 content hash 去重，避免把同一历史反复当作新事实。

现有 Session 已能形成完整的**已结算对话轨迹**，但还不能形成完整的**执行轨迹**：`OperationState` 是替换式 checkpoint，terminal 后 generation intent、重试次数、stream frame 和已完成的工具 intent 不再可通过公开 Storage 协议枚举。若 L0/Skill 需要审计“模型实际看到了什么、尝试过几次、哪个工具失败”，必须增加可选 `TraceRecorder`。每次 durable intent、retry、tool effect intent、tool outcome 和 terminal settlement 都在同一个 Session mutation 中：

1. 追加不可变 `custom` entry（`custom_type="trace_record"`，仅含脱敏结构化事件）；
2. 向 `operation/{operation_id}/trace` append 该 entry ID；
3. 再写对应的 operation state、conversation entry、usage、tip 或 result。

trace list 是该 operation 的稳定索引，避免 trace custom entry 干扰 lane 的对话 branch projection；`TraceRecorder` 写入失败必须使该次 Session mutation 失败，不能制造“已执行但缺审计”的半个 trace。不开启 recorder 时，`trace_format_version` 明确标为 `conversation-v1`；开启后为 `execution-v1`。内存事件、未 checkpoint 的流 token 和外部系统未返回的未知 outcome 不属于“完整”定义，也不能事后伪造。

在 archive 写入前必须对 entry payload 和 TraceRecord 执行字段级脱敏。密钥、认证头、cookie、私钥、环境变量值及被配置为私密的路径/内容必须替换为稳定标记；同时保留原条目 ID、字段路径和 hash，以支持审计与去重但不泄露值。

### 3.2 L1 AtomicMemory

`AtomicMemory` 类型固定为 `episodic`、`persona`、`instruction`：

- `episodic`：带时间或事件性的事实；
- `persona`：跨会话稳定的偏好或协作特点；
- `instruction`：须遵守的规则、工程约束或用户明确指令。

一条 L1 必须只表达一个可独立判断的信息。字段至少为：`memory_id`、`version`、`status`（`active | superseded | rejected`）、`type`、`content`、`background`、`scene_key`、`priority`、`confidence`、`source_record_ids`、`source_hash`、`supersedes_id`、`last_confirmed_at`。禁止以删除覆盖冲突事实；新事实须创建新版本或新记录，并标记旧记录 `superseded`，保留审计链。

### 3.3 L2/L3 和索引

L2 的每个 `scenario_key` 在一个 scope 中只有一个 current 版本。内容采用受限 Markdown，至少有 `summary`、`decisions`、`constraints`、`risks`、`open_questions` 五段；其元数据保存本次消费的 L1 IDs 和 `l1_high_watermark`。L3 为每个 scope 的单一 `core` 文档，只可包含稳定画像、沟通偏好和长期准则，不能写临时任务状态。

SQLite 初版必须含 `memory_scopes`、`conversation_records`、`atomic_memories`、`atomic_memory_sources`、`scenario_memories`、`core_memories`、`memory_jobs`、`memory_job_attempts`、`memory_audit`、FTS 表和 `schema_migrations`。L0/L1 索引使用 FTS5/BM25；embedding 是可选的旁路索引，必须带 `model_id` 与 `content_hash`。索引损坏可重建，权威正文和版本不可依赖索引恢复。

## 4. Capture、晋升和恢复

### 4.1 主路径

在 operation terminal settlement 的同一 Session mutation 中，runtime 必须追加一个轻量 outbox entry（`memory_capture_requested`，含冻结 terminal tip、source entry IDs、operation、scope、trace format 和去重 key）。随后异步 dispatcher 将其幂等写入 `MemoryStore.capture_archive`，并把 outbox 状态标为 delivered。不得在 terminal settlement 事务中调用 LLM、embedding 或记忆 SQLite。若启用 `TraceRecorder`，terminal settlement 的 outbox 还须引用 operation trace list。

这样处理崩溃窗口：

```text
terminal outcome + frozen-source capture outbox 原子提交
  → dispatcher materialize 已冻结的 Session snapshot 为 L0 archive（幂等）
  → 创建/唤醒 promotion job（幂等）
  → L1 → L2 → L3
```

若在 outbox 后崩溃，重启恢复扫描未送达 outbox；若 L0 已写而 outbox 标记未更新，capture key 去重；若后台 job 中断，则从 durable job checkpoint 重试。若 snapshot 中任一 source entry 或 trace entry 缺失，dispatcher 必须进入可观测 dead letter，而不能用“当前 branch”补齐。主 Drive 成功与否不能依赖晋升成功。

### 4.2 晋升任务状态机

`PromotionJob` 以 `(scope, stage, input_high_watermark)` 去重，并保存 `queued | running | retry_wait | dead_letter | completed` 状态、attempt、lease、输入 archive IDs/watermark、prompt/version、输出 hash、错误分类和下次重试时间。一个 scope 同一 stage 最多一个运行 job；worker 获取 lease 时必须使用事务 compare-and-set。lease 到期可接管，已完成输出通过输入/输出 hash 保证幂等。L1 以新的 L0 archive 为增量，而不是以“某个 session 的当前最后消息”为增量。

推荐默认阈值：L1 在 5 个新 turn、空闲 10 分钟或显式 flush 后运行；成功后以 90 秒延迟安排 L2，并设置每 scope 15 分钟最小间隔；L3 首次 L2 成功后运行，之后每新增 50 条 L1 或管理员 flush 后运行。阈值为配置项，不是 API 兼容承诺。

L1 worker 必须：读取未消费 L0 与少量背景、执行质量/敏感信息门控、产出协议化候选、在当前 L1 中检索相似项、作出 `create | supersede | no_op` 决定，并原子写入 L1、来源关系、索引更新任务和审计。L2/L3 只消费成功的下层 watermark；L2 失败不可触发 L3。LLM 输出必须先经 JSON/Markdown schema 验证和长度/类型校验，再写入。

失败分为可重试（provider 超时、暂时存储不可用）、不可重试（schema 不合法、权限拒绝、内容安全拒绝）和未知。有限指数退避后进入 `dead_letter`，保留输入引用而非静默丢弃。管理员可显式重放 dead letter；重放必须生成 audit event。

## 5. 召回与 prompt 投影

在 `run` operation 发出首次 provider effect intent 前，runtime 应调用：

```python
async def recall(scope: MemoryScope, query: RecallQuery, budget: RecallBudget) -> RecallBundle: ...
```

`RecallQuery` 含当前用户请求、lane/branch 可见上下文摘要和可选 task；`RecallBudget` 至少含 `timeout_ms`、`max_l1_items`、`min_score`、`max_item_chars`、`max_total_chars`、`include_l3` 与 `include_l2`。默认：5 秒、最多 5 条 L1、最低分 0.3、必须设置总字符预算（建议 6,000 字符）。与参考实现不同，本 harness 不允许 `0` 表示无限注入，避免挤占 effect intent 的可恢复请求上下文。

排序顺序固定为：

1. 在预算内加入 L3（若存在）；
2. 以 scene key/关键词选择相关 L2；
3. 对 L1 和必要 L0 做 `keyword | embedding | hybrid` 检索；hybrid 使用 RRF 融合；
4. 去重、过滤 superseded/rejected/无权限项，按相关性、priority、recency 和来源多样性截断；
5. 生成结构化 `RecallBundle`，其中每项包含 ID、version、层级、内容、score 和 source IDs。

`ContextAssembler` 必须以明确 `<long_term_memory>` 边界、只读提示和来源 ID 投影 bundle；记忆内容不得覆盖 system 指令，也不得被当作当前用户的授权。最终 provider 请求（含 memory bundle hash、每个记忆 ID/version 与预算）必须写入现有 LLM effect intent；恢复时重用该 frozen bundle，绝不能重新召回后改变已持久化 intent。

召回超时、embedding 失败、索引尚未建立或 `MemoryRuntime` 不可用时，必须降级为 FTS；FTS 也不可用时记录 telemetry 并以空 bundle 继续 Drive。任何召回故障不得阻塞 prompt admission 或终止正常 operation。

## 6. 公共协议、错误与可观测性

API 仅暴露不可变 DTO 和显式领域错误。`MemoryStore` 至少提供 `capture_turn`、`claim_job`、`complete_job`、`fail_job`、`search`、`read_l2`、`read_l3`、`audit`；不得暴露 SQL 或 provider 对象。`MemoryExtractor` 接收带稳定输入 ID 的纯 DTO，并返回 schema 化候选，不能直接写库。

正常控制流使用 `MemoryScopeDenied`、`RecallBudgetExceeded`、`PromotionConflict`、`MemoryNotFound`。存储损坏、provider 故障和索引故障是系统错误，须分类记录而非通过异常文本判断。

至少记录：capture 延迟/去重、各层 job 状态和重试、抽取 prompt ID/version、输入/输出 hash、候选数量、冲突/去重决定、召回耗时/降级原因、被注入的 IDs 与字符预算。审计记录不得存明文密钥或未脱敏的 provider payload。

## 7. 实施顺序与验收

1. 定义 domain DTO、scope、协议与 in-memory conformance backend；不接入 Drive。
2. 实现 L0 capture outbox、恢复扫描与 L1 job 状态机；补齐崩溃注入测试。
3. 实现 FTS/BM25 的 L1/L0 召回与预算化 `RecallBundle`；把冻结 bundle 接入 LLM effect intent。
4. 接入 L2/L3、SQLite migrations、审计/死信与可选 embedding/hybrid。

必须通过以下验收：

- 同一 terminal operation 在 dispatcher 重启、重复投递后只产生一份 L0 archive，且 archive 的 entries 与 terminal outbox 冻结的 IDs/hash 一致；
- compaction、navigation 或 branch fork 发生在 dispatcher 之前时，L0 仍还原 terminal operation 当时的 branch，而不是 capture 时的当前 branch；
- 开启 `TraceRecorder` 后，每个 durable effect intent/outcome 都可由 L0 archive 回溯到一个有序 TraceRecord；关闭时 archive 必须明确标记为 conversation-only；
- L1/L2/L3 failure 或死信不会丢失 L0，也不会阻塞后续 Session operation；
- scope 不匹配时无法通过 ID、FTS 或向量搜索得到内容；
- `superseded` L1 不会被默认召回，且可从当前 L1 回溯来源 L0；
- 同一 frozen operation intent 在崩溃恢复后使用完全相同的 memory IDs/versions/content hash；
- embedding 失败时 FTS 或空 bundle 能在 recall timeout 内返回；
- memory SQLite migration 在空库、旧库和重复执行下均安全，所有 backend 通过相同 conformance suite；
- 每个新增 job 状态至少覆盖 claim 后、LLM effect 后、写入 L1/L2/L3 前后的中断恢复。
