# 长期记忆实现规范

## 1. 目标、范围与术语

本规范为 Python Agent Harness 增加可恢复、可隔离、不会阻塞主 Drive 的长期记忆能力。它借鉴 L0--L3 晋升与“先高层、后具体”的召回方式，但以本仓库的 Session、Lane、Operation 和 effect intent 不变量为准。

记忆回答“知道什么”，不保存可执行操作流程；后者属于 [Skill 自进化功能接入](skill-self-evolution-integration.md)。`Session` 仍是单次对话和执行的唯一写拥有者。长期记忆由独立的 `MemoryStore` 持有，不能作为 `Session` 的 value/list 或 entry tree 的替代品。

本阶段包括：跨 Session 的 L0--L3 数据模型、异步晋升、受预算的召回、repository 隔离、SQLite 实现、保留/GC 策略及恢复/审计。它不包括跨进程多主写入、记忆资产的审批 UI、模型权重训练，或把全部历史自动塞入 prompt。

术语以根目录 [CONTEXT.md](../CONTEXT.md) 为准。本文中的 **必须** 是验收条件；**建议** 可替换，但不能削弱权限、可追溯性或主运行时的恢复性。

### 1.1 本 harness 只实现 code 模式

参考实现的抽取 prompt 分为 `chat` 和 `code` 两个互不兼容的家族：`chat` 使用 `episodic | persona | instruction` 与对话式场景块；`code` 使用 `work_fact | work_task | work_method | work_artifact` 与工作场景块。本 harness 是编码 agent，**必须**只实现 code 家族，且 v1 不暴露 `prompt_mode` 配置——不存在需要 `chat` 的调用方，可选项只会制造未被测试覆盖的分支。prompt 注册表仍需按 `mode` 键区分存档，以便未来新增模式时旧 scope 的 `prompt_mode` 能被识别为“不支持”而不是静默套用错误的抽取协议。

### 1.2 与 Skill 的职责边界

L1 的 `work_method` 与 Skill 都描述“怎么做”，边界**必须**按下表区分，不能靠调用方自行判断：

| | L1 `work_method` | Skill |
| --- | --- | --- |
| 形态 | 描述性认知，一到两句 | 可执行流程：步骤、前置条件、验证、失败处理、资源 |
| 典型内容 | “这个项目里直接改 `X` 会绕过 `Y` 校验，得走 `Z` 入口” | 带 `SKILL.md` + 资源文件的完整方法 |
| 验证 | 无强制验证证据 | 至少一个有成功结果的来源，且有验证步骤 |
| 检索 | 召回时按相关性截断进 prompt | 先 listing，选中后才加载全文 |
| 归属 | `MemoryStore` | `SkillStore` |

判定规则：**缺少可执行步骤或验证证据的方法性认知停留在 L1 `work_method`；两者齐备才升级为 Skill。** 反向限制同样成立——L1 的更新绝不能隐式改写 Skill（见 [Skill 自进化功能接入](skill-self-evolution-integration.md) §1）。`work_method` 的类型定义与元数据见 §3.2。

## 2. 架构和所有权边界

```text
Harness / Drive
  ├─ SessionStore                 # 当前会话的 entries、operations；现有权威状态
  ├─ MemoryRuntime                # 编排 capture、recall 和后台晋升
  │    ├─ MemoryStore             # L0/L1/L2/L3、任务、索引、审计
  │    ├─ MemoryExtractor         # provider 中立的 LLM 抽取协议
  │    ├─ PromotionScheduler      # 延迟 job 的时钟与唤醒（见 ADR-014）
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

`MemoryRuntime` **必须**提供显式的生命周期：构造时不启动任何后台活动，`start()` 恢复未完成 job 与 outbox 扫描，`aclose()` 停止调度并等待在途 job 收敛。`Harness.close()` **必须**关闭已注入的 `MemoryRuntime`；未被显式 `close` 的 runtime 不得在事件循环结束后继续持有任务（见 ADR-014）。

### 2.1 Session 是 L0 的来源，不是 L0 的替代品

应复用现有 Session，而不是在每次 message/tool settlement 时再写一份平行聊天记录。当前 entry tree 已持久化且只追加，包含 `message`（其 `role` 区分 user/assistant/tool）、`compaction`、`branch_summary` 和 `custom` 四类 entry；operation meta/result 给出了 operation 的边界。因此一个 terminal operation 的 L0 输入**必须**由其 **terminal tip 的有序 branch entries** 生成，而不是读取“当前 provider context”。后者会在 compaction 后只包含摘要和保留消息，不能代表原始对话。

术语约定：**terminal tip** 指该 operation 结算时写入 lane 的 `tip_id`，即 terminal result 中的 `tip_id` 字段；**base tip** 指同一 operation 启动时的 `OperationMeta.source_tip_id`，它同时出现在 terminal result 的 `from_tip_id` 字段中。两者都能从已持久化的 operation result 读回，不需要在 settle 时重新扫描 Session。

L0 的来源**必须**按 base tip 与 terminal tip 之间的增量确定：

```text
source_entry_ids = scan_branch(tip_id) 中 seq 严格大于 scan_branch(base_tip_id) 末项的 entry
```

而不是该 operation 的完整可见历史。理由有两点：其一是正确性——`source_entry_ids` 按增量取得后，即使 capture 之前发生 fork 或 navigation，archive 记录的仍是该 operation 实际新增的 entries，而不是 capture 时的当前 branch；其二是存储成本——全量 branch 快照会让每个 operation 都重存一遍共同前缀，长期总存储量退化为 O(n²)。

缺失的背景**必须**由 archive 自身携带的**受限祖先链**补齐，而不是回读 Session：archive 保存 `parent_archive_id` 与 `ancestor_item_ids`（terminal branch 上紧邻增量之前的最多 K 个 item ID，K 建议 50）。窗口边界处需要更长历史时，沿 `parent_archive_id` 继续回溯。因此 extractor 的“新消息 + 少量背景”完全从 L0 内解析，与 Session 是否仍存在无关。

L0 仍须作为 `MemoryStore` 的独立、不可变 archive 保存。这不是双写两个权威聊天记录：Session 是执行期的权威来源；L0 archive 是从一个已提交的 Session snapshot 派生的、受 MemoryScope 保留策略管理的晋升输入。独立 archive 的必要性在于 Session 可被删除、fork、导航，且 MemoryStore 的 worker 不应在数小时后读取已变化或不可用的 Session。

capture outbox 至少冻结 `session_id`、`lane`、`operation_id`、`base_tip_id`、`tip_id`、`source_entry_ids`（按 branch 顺序）、`source_entry_hash`、`trace_format_version` 和 scope。dispatcher 按这些 ID 读取 immutable entries 后写入 L0 archive；它不得改用 dispatch 时的 lane tip。唯一 capture key 为 `(session_id, operation_id, tip_id, source_entry_hash)`，因而 fork 后相同的 entry IDs 也不会混淆来源。

### 2.2 scope 与可见性

每次 `Harness.open` **必须**可选接收不可变 `MemoryScope` 和 `MemoryRuntime`。未配置二者时，现有 harness 行为不变，且不进行 capture、召回或后台任务。当前本地单用户部署的 `MemoryScope` 只包含稳定仓库标识：

```python
@dataclass(frozen=True, slots=True)
class MemoryScope:
    repository_id: str
```

`repository_id` 必须是稳定仓库标识（建议 canonical Git remote），不能使用易变 checkout 路径。`session_id` 仅作为 L0 来源和任务去重维度，不能单独授予跨 Session 访问权。L0--L2 查询必须先按 repository 过滤，再进行关键词或向量排序；不得先全库搜索再在应用层过滤。L3 是唯一例外：每个本地 MemoryStore 仅保留一个全局 doctrine，所有 repository scope 都可读取它；L3 的更新输入是全部仓库的 current L2 场景。

## 3. 数据模型与持久化

所有记录须带 `id`、`scope`、`created_at`、`updated_at`、`version`（适用时）、内容哈希和可追溯来源。ID 由注入的 ID factory 生成；时间由可注入 clock 提供。

| 层 | 权威对象 | 写入模式 | 保留规则 |
| --- | --- | --- | --- |
| L0 | `SessionTraceArchive` | append-only | 已结算 operation 的增量轨迹、祖先链、可选 effect trace、脱敏状态 |
| L1 | `AtomicMemory` | 新建或以 version 取代当前版本 | 保留来源、类型、置信度、场景和 supersedes 链 |
| L2 | `WorkSceneMemory` | 乐观锁替换整个 Markdown 内容 | 保留版本及输入 L1 watermarks |
| L3 | `OperatingDoctrine` | 乐观锁替换整个 Markdown 内容 | 每个 scope 一个当前版本及历史 |

### 3.1 L0 SessionTraceArchive

L0 是唯一不可丢失的晋升原料，也是对已完成 Session 轨迹的保留快照。一个 archive 包含 `archive_id`、`scope`、`session_id`、`lane`、`operation_id`、`operation_kind`、`base_tip_id`、`tip_id`、capture key、`parent_archive_id`、`ancestor_item_ids`、`trace_format_version`、`created_at`、`content_hash`，以及按 branch 顺序的增量 `TraceItem`。`TraceItem` 至少保留 source entry ID/sequence/timestamp/type、role/content、tool call/result、compaction/branch summary 和脱敏标记。L0 可为 FTS/embedding 将每个 item 建立派生索引，但 archive 是原文和来源的权威载体。

archive 是**投递单位**，`TraceItem` 是**消费单位**：`MemoryStore` 为每个已存储 item 分配 scope 内单调递增的 `store_seq`，L1 的 `input_high_watermark` 即已消费的最大 `store_seq`（见 §4.2）。因此一个 archive 可以只被部分消费，watermark 不因 archive 边界而跳跃。同一 archive 被重复 materialize 时，capture key 与 `(archive_id, source_entry_id)` 双重去重，不重复分配 `store_seq`。

仅在一个 operation 已 terminal、且 assistant/tool outcome 均已 durable 后 capture。这样一个 archive 天然包括 `base_tip_id` 之后的 user/assistant/tool entries；它不应只捕获单轮 prompt。导航和 compaction 是普通 operation：它们各自产生 archive，但 extractor 应通过 `operation_kind`、terminal status 和 content hash 去重，避免把同一历史反复当作新事实；`branch_summary` 一类结构性 entry 在抽取时**建议**折叠为背景而非新事实来源。

现有 Session 已能形成完整的**已结算对话轨迹**，但还不能形成完整的**执行轨迹**：`OperationState` 是替换式 checkpoint，terminal 后 generation intent、重试次数、stream frame 和已完成的工具 intent 不再可通过公开 Storage 协议枚举。若 L0/Skill 需要审计“模型实际看到了什么、尝试过几次、哪个工具失败”，**必须**增加可选 `TraceRecorder`。每次 durable generation/tool intent、retry、tool outcome 和 terminal settlement 都在同一个 Session mutation 中：

1. 追加不可变 `custom` entry（`custom_type="trace_record"`，仅含脱敏结构化事件）；
2. 向 `operation/{operation_id}/trace` append 该 entry ID；
3. 再写对应的 operation state、conversation entry、usage、tip 或 result。

trace list 是该 operation 的稳定索引，避免 trace custom entry 干扰 lane 的对话 branch projection；`TraceRecorder` 写入失败**必须**使该次 Session mutation 失败，不能制造“已执行但缺审计”的半个 trace。不开启 recorder 时，`trace_format_version` 明确标为 `conversation-v1`；开启后为 `execution-v1`。内存事件、未 checkpoint 的流 token 和外部系统未返回的未知 outcome 不属于“完整”定义，也不能事后伪造。

流式文本 checkpoint 虽然为了崩溃恢复会替换 `OperationState.content_checkpoint`，但**不得**写入 TraceRecorder 或 L0 的 execution trace：它们是同一次未结算 generation 的内部进度，不是独立 effect intent/outcome。否则每个 token 都会制造携带完整 context 的 `custom` 项，既重复又会使 L0 晋升输入失真。

在 archive 写入前必须对 entry payload 和 TraceRecord 执行字段级脱敏。密钥、认证头、cookie、私钥、环境变量值及被配置为私密的路径/内容必须替换为稳定标记；同时保留原条目 ID、字段路径和 hash，以支持审计与去重但不泄露值。脱敏是**写入 L0 时**的强制动作，不是抽取或导出时的可选步骤，因为 L0 是保留期最长的一层。

### 3.2 L1 AtomicMemory

`AtomicMemory` 类型固定为 `work_fact`、`work_task`、`work_method`、`work_artifact` 四类，**必须**按以下定义与优先级带区分：

| 类型 | 定义 | 典型内容 | 优先级带 |
| --- | --- | --- | --- |
| `work_fact` | 与工作对象相关的客观事实 | 依赖版本、模块边界、外部系统行为 | 中 |
| `work_task` | 有状态与归属的工作项 | 待办、阻塞、负责人、时间窗 | 高 |
| `work_method` | 经过验证的方法性认知（不含完整可执行流程） | “改 X 会绕过 Y 校验，应走 Z 入口” | 高 |
| `work_artifact` | 产出物、路径或构建物的引用 | 生成的产物位置、分支名、制品标识 | 低 |

每类**必须**携带其专属元数据，缺失时该条候选**必须**被拒绝而不是降级为 `work_fact`：

| 类型 | 元数据字段 |
| --- | --- |
| `work_task` | `owner`、`deadline`、`status` |
| `work_method` | `scope`（适用边界）、`method_type` |
| `work_artifact` | `artifact_type`、`artifact_ref` |
| `work_fact` | `work_object`、`status`、`activity_start_time`、`activity_end_time` |

一条 L1 必须只表达一个可独立判断的信息。字段至少为：`memory_id`、`version`、`status`（`active | superseded | rejected`）、`type`、`content`、`background`、`scene_key`、`priority`、`confidence`、`source_record_ids`、`source_hash`、`supersedes_id`、`last_confirmed_at`。禁止以删除覆盖冲突事实；新事实须创建新版本或新记录，并标记旧记录 `superseded`，保留审计链。

去重与冲突检测**必须**在类型内与类型间同时进行，并支持多对多合并：`work_fact` 的新版本可以同时取代两条过时的旧 `work_fact` 并吸收一条 `work_method`。因此 L1 的冲突决定**必须**使用 `create | supersede | merge | no_op` 四态，其中 `merge` 是 `supersede` 的多对多形式（N 条旧记录 → 1 条新记录），`supersedes_id` 相应扩展为 `supersedes_ids` 列表。四态的每个分支都必须写入 audit，说明被取代的 ID 与依据。

### 3.3 L2 WorkSceneMemory

L2 的每个 `scenario_key`（工作场景键）在一个 scope 中只有一个 current 版本。内容采用受限 Markdown 的工作场景块，**必须**包含以下九段，缺段的更新**必须**被拒绝：

```text
工作场景 / 适用条件 / 核心 SOP / 判断逻辑 /
禁忌与反模式 / 关键事实依据 / 相关任务与资产 / 演化记录 / 待确认问题
```

元数据至少保存 `created_at`、`updated_at`、`summary`、`heat` 以及本次消费的 L1 IDs 和 `l1_high_watermark`。`heat` 由引用强度与最近活跃度计算，用于在 `maxScenes` 上限处决定淘汰候选；淘汰**只能**降级为 `dormant` 并保留内容，使该决定可逆——内容的实际回收只由 §3.5 的保留策略决定，淘汰本身不得删除任何记录。

单条场景块正文**必须**限制在 1,500 字符以内。超限时**必须**由 extractor 压缩后重新提交，而不是截断——截断会静默丢弃后半段的 SOP 与禁忌。

场景块生成**必须**区分三种操作，且不得由同一次 LLM 调用同时决定：

- `CREATE`：无高度重合的现有场景时新建；
- `UPDATE`：与某个现有场景高度重合时，提交该场景的**完整**新内容（乐观锁 + `expected_version`）；
- `MERGE`：与多个现有场景部分重合时，合并为一条并标其余为 `dormant`。

`maxScenes` 默认 **20**，是每 scope 的 current 场景上限，为配置项。达到上限且无场景可合并时，**必须**按 `heat` 淘汰最低者；**必须**在接近上限时产出分级预警（建议在 80% 与 100% 两档），使超限成为可观测事件而不是静默行为。

L2 只消费自上次 L2 之后新增的 L1，避免每次重新总结全部历史。

### 3.4 L3 OperatingDoctrine

L3 为每个 scope 的单一 doctrine 文档，**必须**包含以下六段：

```text
Operating Thesis / Core Principles / Reusable SOPs /
Decision Logic / Boundaries & Anti-patterns / Agent Rules
```

正文**必须**限制在 1,200 字符以内。L3 只可包含稳定画像、沟通偏好与长期准则，不能写临时任务状态；**必须**显式拒绝以下内容：单一任务的进度或待办、只在一个场景成立的具体事实、未经多次验证的推测、密钥或凭据、会随版本升级失效的精确依赖版本、以及任何属于 L1/L2 的原始引文。

L3 **必须**以增量更新为主：读取自上次生成后发生变化的 L2 场景块与现有 doctrine，输出完整新版本。当 L2 判定需要调整 L3 时，只能通过在场景元数据中提出更新请求标记（`PERSONA_UPDATE_REQUEST`）来表达，由 L3 自己的调用决定是否采纳；L2 **不得**直接改写 doctrine。

### 3.5 保留与回收

保留策略**必须**是配置项并**必须**可审计，默认值如下：

| 层 | 默认保留 | 回收前置条件 |
| --- | --- | --- |
| L0 archive | 90 天 | 所有 item 已被消费（`store_seq` ≤ 本 scope L1 watermark），且无未送达 outbox 引用 |
| 未送达 outbox | 永久 | 只能在投递成功或人工判定为不可投递后清理 |
| L1 | 取代后 180 天 | 已被 `superseded`，且无 current L2/L3 引用其 ID |
| L2 | 转入 `dormant` 后 365 天 | 仍为 `dormant`，且未被 current L3 引用 |
| L3 | 永久 | 不可自动回收 |
| audit | 400 天 | 不可在对应资产仍存在时回收 |

GC **必须**是可中断的离线批处理，且**必须**遵守一条硬约束：**被 supersedes 链或 watermark 引用的记录不得回收**，否则审计链会断。GC 每轮**必须**写入 audit（回收对象、数量、依据），使保留策略的执行本身可追溯。删除 repository `MemoryScope` 时只级联回收其 L0--L2、job 与 audit，且不得影响其他 repository 或全局 L3。

### 3.6 索引

SQLite 初版必须含 `memory_scopes`、`trace_archives`、`trace_items`、`atomic_memories`、`atomic_memory_sources`、`work_scene_memories`、`operating_doctrines`、`memory_jobs`、`memory_job_attempts`、`memory_audit`、FTS 表和 `schema_migrations`。L0/L1 索引使用 FTS5/BM25；embedding 是可选的旁路索引，必须带 `model_id` 与 `content_hash`。索引损坏可重建，权威正文和版本不可依赖索引恢复。

## 4. Capture、晋升和恢复

### 4.1 主路径

在 operation terminal settlement 的同一 Session mutation 中，runtime 必须追加一个轻量 outbox entry（`memory_capture_requested`，含冻结 base/terminal tip、source entry IDs、operation、scope、trace format 和去重 key）。随后异步 dispatcher 将其幂等写入 `MemoryStore.capture_archive`，并把 outbox 状态标为 delivered。不得在 terminal settlement 事务中调用 LLM、embedding 或记忆 SQLite。若启用 `TraceRecorder`，terminal settlement 的 outbox 还须引用 operation trace list。

这样处理崩溃窗口：

```text
terminal outcome + frozen-source capture outbox 原子提交
  → dispatcher materialize 已冻结的 Session snapshot 为 L0 archive（幂等）
  → 按 store_seq watermark 创建/唤醒 promotion job（幂等）
  → L1 → L2 → L3
```

若在 outbox 后崩溃，重启恢复扫描未送达 outbox；若 L0 已写而 outbox 标记未更新，capture key 去重；若后台 job 中断，则从 durable job checkpoint 重试。若 snapshot 中任一 source entry 或 trace entry 缺失，dispatcher 必须进入可观测 dead letter，而不能用“当前 branch”补齐。主 Drive 成功与否不能依赖晋升成功。

dispatcher **必须**只依赖 outbox 中冻结的 ID 与 hash 读取 entries，且**必须**在 archive 上记录 `parent_archive_id`：它指向该 scope 内 `store_seq` 最大的已存在 archive，用于支撑 §2.1 的祖先回溯。若父 archive 已被 GC 回收，**必须**记录该缺口并继续，而不是回读 Session 或重建父 archive。

### 4.2 晋升任务状态机

`PromotionJob` 以 `(scope, stage, input_high_watermark)` 去重，并保存 `scheduled | queued | running | retry_wait | dead_letter | completed` 状态、`not_before`、attempt、lease、输入 archive IDs/watermark、prompt/version、输出 hash、错误分类和下次重试时间。一个 scope 同一 stage 最多一个运行 job；worker 获取 lease 时必须使用事务 compare-and-set。lease 到期可接管，已完成输出通过输入/输出 hash 保证幂等。L1 以新的 L0 item watermark 为增量，而不是以“某个 session 的当前最后消息”为增量。

`not_before` **必须**与 job 状态在同一事务持久化，调度**必须**由 `PromotionScheduler` 按持久状态重新武装；不得依赖进程内内存 timer（见 ADR-014）。进程重启后，`scheduled` 且 `not_before` 已过的 job **必须**被立即领取。

推荐默认阈值：

| stage | 触发条件 |
| --- | --- |
| L1 | 同一 scope 新增 5 个 turn，或显式 flush |
| L2 | L1 成功后延迟 90 秒入队；同一 scope 最小间隔 15 分钟 |
| L3 | 首次 L2 成功后；此后任一仓库产生 L2 变更，或管理员 flush |

L1 **不设**空闲/超时触发：轮次阈值与显式 flush 是唯一触发源。理由是空闲触发在本 harness 中没有正确的信号来源——Session 的可写状态由 Drive 拥有，后台按时间推断“对话已结束”会与 compaction、navigation 和 fork 竞争判断，而轮次阈值已经覆盖了同一场景且完全可重现。

阈值与延迟均为配置项，不是 API 兼容承诺。L2 的 90 秒延迟**必须**允许配置为 0，此时 job 直接以 `queued` 入队——这使一个不引入任何时钟依赖的 v1 成为可能，也让测试不必等待真实时间。

L1 worker 必须：读取未消费 L0 item 与受限祖先链背景、执行质量/敏感信息门控、产出协议化候选、在当前 L1 中检索相似项（类型内与类型间）、作出 `create | supersede | merge | no_op` 决定，并原子写入 L1、来源关系、索引更新任务和审计。对 code 模式，extractor 还必须接收由冻结 L0 派生的 CodingEvidence（仓库 ID、有限路径集合、带 entry ID 的工具 outcome）；工具成功/失败可作为事实证据，但 assistant 的计划或诊断未经结果验证不得沉淀为事实。路径、symbol、测试或命令的引用必须说明其作用、约束或 outcome，不能仅保存裸字符串。L2/L3 只消费成功的下层 watermark；L2 失败不可触发 L3。LLM 输出必须先经 JSON/Markdown schema 验证和长度/类型校验，再写入；校验失败**必须**记为不可重试错误，不得重试同一非法输出。

失败分为可重试（provider 超时、暂时存储不可用）、不可重试（schema 不合法、权限拒绝、内容安全拒绝）和未知。有限指数退避后进入 `dead_letter`，保留输入引用而非静默丢弃。管理员可显式重放 dead letter；重放必须生成 audit event。

## 5. 召回与 prompt 投影

在 `run` operation 发出首次 provider effect intent 前，runtime 应调用：

```python
async def recall(scope: MemoryScope, query: RecallQuery, budget: RecallBudget) -> RecallBundle: ...
```

`RecallQuery` 含当前用户请求、lane/branch 可见上下文摘要和可选 task；`RecallBudget` 至少含 `timeout_ms`、`max_l1_items`、`min_score`、`max_item_chars`、`max_total_chars`、`include_l3`、`include_l2` 与按 L1 类型的配额。默认：5 秒、最多 5 条 L1、最低分 0.3、必须设置总字符预算（建议 6,000 字符）。与参考实现不同，本 harness 不允许 `0` 表示无限注入，避免挤占 effect intent 的可恢复请求上下文；`0` 在此**必须**被解释为“该类别不注入”。

排序顺序固定为：

1. 在预算内加入 L3 doctrine（若存在）；
2. 以 scene key/关键词选择相关 L2 场景块；
3. 对 L1 和必要 L0 做 `keyword | embedding | hybrid` 检索；hybrid 使用 RRF 融合；
4. 去重、过滤 superseded/rejected/无权限项，按相关性、priority、recency 和来源多样性截断；code 模式还须把 query/context 中的路径和 identifier 拆为检索词，并索引 `work_artifact` 的稳定引用字段；
5. 生成结构化 `RecallBundle`，其中每项包含 ID、version、层级、内容、score 和 source IDs。

`work_task` 类记录在任务上下文匹配时**建议**优先保留其 `status` 与 `owner`，使“谁在等什么”不被相关性打分挤掉。

`ContextAssembler` 必须以明确 `<long_term_memory>` 边界、只读提示和来源 ID 投影 bundle；code 模式须分组标明 global doctrine、repository context、relevant code memory 和 trace evidence，并提醒 Agent 将路径、symbol、命令与测试结果视为历史证据、在当前 checkout 验证后再编辑或断言。记忆内容不得覆盖 system 指令，也不得被当作当前用户的授权。注入点在现有 hook 链的 `transform_context` 之后、`before_request` 之前：`transform_context` 仍可调整对话上下文，而记忆注入作为其下游的独立区块加入，且**必须**可被 `before_request` 观察到以便审计。最终 provider 请求（含 memory bundle hash、每个记忆 ID/version 与预算）必须写入现有 LLM effect intent；恢复时重用该 frozen bundle，绝不能重新召回后改变已持久化 intent。

召回超时、embedding 失败、索引尚未建立或 `MemoryRuntime` 不可用时，必须降级为 FTS；FTS 也不可用时记录 telemetry 并以空 bundle 继续 Drive。任何召回故障不得阻塞 prompt admission 或终止正常 operation。

## 6. 公共协议、错误与可观测性

API 仅暴露不可变 DTO 和显式领域错误。`MemoryStore` 至少提供 `capture_archive`、`claim_job`、`complete_job`、`fail_job`、`search`、`read_l2`、`read_l3`、`audit`；不得暴露 SQL 或 provider 对象。`MemoryExtractor` 接收带稳定输入 ID 的纯 DTO，并返回 schema 化候选，不能直接写库。

正常控制流使用 `MemoryScopeDenied`、`RecallBudgetExceeded`、`PromotionConflict`、`MemoryNotFound`、`UnsupportedPromptMode`。存储损坏、provider 故障和索引故障是系统错误，须分类记录而非通过异常文本判断。

至少记录：capture 延迟/去重、各层 job 状态和重试、抽取 prompt ID/version、输入/输出 hash、候选数量、冲突/去重决定、L2 场景数与淘汰、L3 拒绝项、召回耗时/降级原因、被注入的 IDs 与字符预算。审计记录不得存明文密钥或未脱敏的 provider payload。

## 7. 实施顺序与验收

1. 定义 domain DTO、scope、协议与 in-memory conformance backend；不接入 Drive。
2. 实现 `PromotionScheduler` 与生命周期（`start`/`aclose`、`not_before` 持久化与重启重武装），先以内存后端验证时钟可控性。
3. 实现 L0 capture outbox、恢复扫描与 L1 job 状态机；补齐崩溃注入测试。
4. 实现 FTS/BM25 的 L1/L0 召回与预算化 `RecallBundle`；把冻结 bundle 接入 LLM effect intent。
5. 接入 L2/L3、SQLite migrations、保留/GC、审计/死信与可选 embedding/hybrid。

必须通过以下验收：

- 同一 terminal operation 在 dispatcher 重启、重复投递后只产生一份 L0 archive，且 archive 的 entries 与 terminal outbox 冻结的 IDs/hash 一致；
- archive 只包含 base tip 之后的增量 entries；重复 capture 同一 operation 不产生重复 `store_seq`；
- compaction、navigation 或 branch fork 发生在 dispatcher 之前时，L0 仍还原 terminal operation 当时新增的 branch，而不是 capture 时的当前 branch；
- 跨 scope 的 `store_seq` 与 watermark 互不干扰；部分消费一个 archive 后崩溃，恢复只消费剩余 item；
- 开启 `TraceRecorder` 后，每个 durable effect intent/outcome 都可由 L0 archive 回溯到一个有序 TraceRecord；关闭时 archive 必须明确标记为 conversation-only；
- L1 冲突决定覆盖 `create | supersede | merge | no_op`，且 `merge` 的多对多来源全部记录在 audit 中；
- L2 场景块缺段、超 1,500 字符或超过 `maxScenes` 时不会静默写入或截断；
- L3 拒绝项（任务进度、密钥、单一场景事实）在生产路径上可观测，且 L2 无法直接改写 doctrine；
- L1/L2/L3 failure 或死信不会丢失 L0，也不会阻塞后续 Session operation；
- scope 不匹配时无法通过 ID、FTS 或向量搜索得到内容；
- `superseded` L1 不会被默认召回，且可从当前 L1 回溯来源 L0；
- 同一 frozen operation intent 在崩溃恢复后使用完全相同的 memory IDs/versions/content hash；
- `not_before` 未到的 job 不被执行，进程重启后已到期的 `scheduled` job 被领取且只执行一次；
- embedding 失败时 FTS 或空 bundle 能在 recall timeout 内返回；
- GC 不回收仍被 supersedes 链或 watermark 引用的记录；回收动作可在 audit 中复现；
- memory SQLite migration 在空库、旧库和重复执行下均安全，所有 backend 通过相同 conformance suite；
- 每个新增 job 状态至少覆盖 claim 后、LLM effect 后、写入 L1/L2/L3 前后的中断恢复。
