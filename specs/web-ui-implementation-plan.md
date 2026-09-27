# PRALE Web UI 实施计划

## 1. 结论、目标与边界

**结论：可以实现。** 现有 Harness 已具备适合接入 Web 的基础：`HarnessRpc` 的传输无关命令入口、`AuthenticatedHarnessService` 的事件订阅边界、SQLite 的持久 Session、usage ledger，以及独立的 L0--L3 memory store 与 skill store。Web UI 不应成为 runtime 的依赖；它应是一个独立应用，调用稳定的应用服务 API。

本计划交付一个**本机单用户**的 Web UI：

- 顶栏显示由服务端配置的当前项目绝对路径与仓库标识（`repository_id`）；
- 侧边栏在 **Agent 对话 / 完整轨迹 / 记忆 / 技能** 四个视图间切换；
- 对话视图可向指定 lane 发送 prompt、流式显示消息和工具状态；
- 轨迹视图可选择 session，按 operation（UI 中的 turn）展示输入/输出、token、总耗时、每次 LLM call 和工具 call 的耗时；
- 记忆视图按服务端配置的 repository scope 展示 L0 归档、L1 atomic memories、L2 work-scene memories，以及全局唯一的 L3 operating doctrine；
- 技能视图只读展示该 scope 下的 skill 资产、版本历史、来源归档与提取任务状态。

不在本期范围：把浏览器连接、HTTP 框架、前端状态或项目目录扫描逻辑放入 `domain/` / `runtime/`；以事件流替代 durable 历史；把工作目录权限扩大为任意文件浏览；**多用户 / 团队 ACL 与"认证主体到 scope"的映射**（ADR-018 明确 `repository_id` 不是授权维度，见 ADR-WEB-003）；**技能的创建、修改、评审与人工审批**（`skill-self-evolution-integration.md` 规定人工审核/资产管理 API 另行定义，不得混入自动 Review 权限）；修改 L0--L3 内容或执行记忆 GC。

## 2. 当前实现盘点与缺口

| UI 需求 | 可复用的现有能力 | 必须补齐的能力 |
|---|---|---|
| 项目路径 | 内置工具有 `cwd` 概念（`integrations/local_tools.py`）；memory 已用稳定的 `repository_id` | Harness 不保存项目元数据；应用启动配置必须提供 `project_root` 并规范化，**并显式提供它与 `repository_id` 的映射**——`repository_id` 必须是稳定标识（如 canonical git remote），不能由 checkout 路径推导 |
| Agent 对话 | `prompt`、`drive`、`watch()`、`recover()`、`AuthenticatedHarnessService.subscribe()` | RPC 只支持 prompt/drive/snapshot/abort；需要把"提交并后台 drive"、SSE 适配、断线后的 snapshot 补偿、**进程重启后的 recover 归属**做成应用服务 |
| session 选择 | `SessionMetadata` + `SQLiteSessionRepo`/`MemorySessionRepo`（`storage/repository.py`，含 `list()`） | 现有 `list()` 依赖 `glob("*.sqlite")` + `path.stem` 推断归属（`repository.py:69-72`），不能作为权限与归属依据；需要 allow-list catalog（项目、最近活动、默认 lane），并明确它与 `SessionRepo` 谁是元数据权威 |
| 完整轨迹 | entry tree、operation meta/state/result、`operation/{id}/trace` 索引 | 没有按 operation 枚举的公开、分页查询 API；`LaneSnapshot` 只含 tip 与 operation id |
| token / turn 耗时 | `OperationResult.started_at/ended_at`；`Entry.timestamp`（每次 commit 的毫秒时间戳）；`usage_rows` 的 `entry_id` 列 | storage protocol 不提供任何 usage 读取方法；usage 每个 operation 最多一条且只含**最后一次成功尝试**，失败 attempt 的 token 完全没有记录；没有 call 级开始时间；没有 attempt 级记录 |
| L0 归档 | `trace_archives`/`trace_items` 表；`unconsumed_items()`（watermark 驱动） | 无"按 scope 列出归档"的接口，`_read_archive` 是私有的；UI 无法列出某个 session 的归档与其脱敏来源 |
| L1 | `read_l1_since(scope, watermark)` | SQL 硬编码 `status='active'`（`storage/memory_sqlite.py:544`），superseded/rejected 读不出；watermark 驱动且无分页；来源引用（`atomic_memory_sources`）只在内部读取 |
| L2 | `read_l2(scope)` | SQL 硬编码 `status='current'`（`memory_sqlite.py:814`），dormant 场景读不出；无分页（按 `heat` 排序） |
| L3 | `read_l3(scope)`；`GLOBAL_L3_SCOPE`（`domain/memory.py:61`） | `read_l3` **忽略传入 scope**、恒用全局 scope（`memory_sqlite.py:866`）；UI 必须按全局 doctrine 展示，不能按 repository 过滤 |
| 晋升管道 | `memory_jobs`/`memory_job_attempts`/`memory_audit` 表 | 无 jobs 列表接口（`claim_job` 是 worker 抢占，不是查询）；`audit()` 只写不读 |
| 技能 | `SkillAsset`/`SkillVersion`/`SkillArchive`/`SkillExtractionJob`、`SQLiteSkillStore`、`SkillEvolutionRuntime.listing()/load()/review_status()` | `search`/`listing` 硬编码 `state='active'`（`storage/skill_sqlite.py:437`），disabled/archived 列不出；`listing` 按字符预算截断，是 prompt 注入视图而非 UI 列表（`:448-458`）；`view`/`load` 需先知道 `skill_id`；无归档、任务、候选与审计的列表读取 |

因此，本期的前置工作不是重写 agent loop，而是补充**只读查询模型**和**durable observability 记录**。这也意味着旧 Session 若未开启 span 记录，能展示 entry、terminal result 和最多 entry 级的 usage 绑定；不能诚实地补算历史工具/LLM effect 的精确耗时，应在 UI 标记为"不可用"。

**进度：阶段 1--6 已实现。** 阶段 1 交付 `ProjectRuntimeConfig`/`ProjectInfo`（`api/project.py`）与 session catalog（`api/catalog.py`、`storage/catalog.py`，内存与 SQLite 后端经 conformance suite 验证）。阶段 2 交付 `EffectSpan`/`UsageRecord`（`domain/effects.py`）、`Storage.list_spans`/`list_usage`/`usage_for_entries` 读取契约、Session DB v3（`effect_spans`）与 v4（usage 归属列）迁移，以及 §3.2 所述的未结算/未知编码。阶段 3 交付三个只读 facade（`api/trace.py`、`api/memory.py`、`api/skill.py`）、共享分页契约（`api/pagination.py`）、它们所需的 store 读取路径与 list-view DTO，以及为枚举 turn 而新增的两个只追加索引（§3.3）。阶段 4 交付 `api/web.py`（可选 extra `web`）：REST 路由、SSE 与断线补偿、受控后台 drive、显式 abort、recover 归属与 session 创建契约（§4.1）。阶段 5 交付 `src/agent_harness/web/` 下的四个视图与外壳（随包发布的原生 ES module，无构建步骤；见 §4.2），由 `GET /` 与 `GET /static/*` 托管，并用 `tests/integration/test_web_assets.py` 在 HTTP 层锁住前后端契约（资源可达、模块调用的 `/api/...` 路径都在路由表里、展示契约的硬规则在源码层成立）。阶段 6 交付部署入口与运维契约：`api/serve.py`（`prale-web`，配置全部来自环境变量，示例见 `deploy/web.env.example`）、`GET /api/health`、并发上限与日志脱敏（§4.3）。六个阶段至此全部完成；本文件不再保留未实现项。

## 3. 架构与数据流

```text
Browser SPA
  │ HTTPS + SSE/WebSocket
  ▼
Web adapter (项目配置、静态资源、连接生命周期)
  │ 调用稳定 DTO
  ▼
Application service / Query facade
  ├─ HarnessRpc + AuthenticatedHarnessService  ──► Harness / Lane
  ├─ SessionCatalog (session_id -> DB location + 所属项目/仓库)
  ├─ TraceQueryService ─────────────────────────► Session storage read protocol
  ├─ MemoryQueryService ────────────────────────► MemoryStore read protocol
  └─ SkillQueryService ─────────────────────────► SkillStore read protocol
                                                    │
              SQLite Session DBs / SQLite memory asset DB / SQLite skill DB
```

Web adapter 只负责 HTTP/SSE/WebSocket 编解码和连接释放。应用 service 只返回不可变 DTO，执行 catalog allow-list 与 scope 解析。`domain/` 保持纯净；storage 只提供协议和事务实现；运行中 effect 仍严格遵守既有的 intent → effect → atomic settlement。

### 3.1 Session catalog 与项目路径

新增应用层 `ProjectRuntimeConfig`：`project_root`、`repository_id`、session 数据目录、memory store 位置、skill store 位置。启动时使用 `Path.resolve(strict=True)` 取得项目根目录，作为只读 `ProjectInfo` 返回；不从浏览器提供的路径读取。**`repository_id` 必须显式配置，不从 `project_root` 推导**：`domain/memory.py:26-28` 要求它是稳定的、调用方提供的标识（例如 canonical Git remote），而不是短暂的 checkout 路径。

新增 catalog（建议项目数据目录中的 SQLite 小库）：记录 `session_id`、创建/最近活动时间、数据库相对路径、项目 ID、默认 lane。**权威关系必须明确**：session 文件是 session 内容的唯一权威，catalog 只拥有"归属、项目、最近活动与允许访问范围"这份元数据，是查询与 allow-list 的唯一入口。现有 `SessionRepo.list()` 的 glob 结果只用于迁移期发现既有库并在 catalog 中登记，不作为归属依据。

创建或挂载 Harness 时原子登记/更新 catalog。session 查询只通过 catalog 的 allow-list 打开对应数据库；不得让 HTTP 参数成为任意 SQLite 文件路径。

### 3.2 Durable trace 与指标模型

将 operation 作为一个 UI turn。新增 append-only `EffectSpan` / `UsageRecord` 领域 DTO（`domain/effects.py`）：

- `operation_id`、`call_id`、`kind`（`llm` / `tool`）、lane、attempt、开始/结束毫秒时间、`outcome` 和 `error_class`。**不保存工具名**：生成的 `call_id` 是 intent 预留的 assistant entry ID，工具的是 `tool_call_id`，名称、参数与 source order 已由 assistant entry 的 `tool_calls` 与 branch `seq` durable 提供，span 只存关联键，也不保存未脱敏的参数/结果副本；
- LLM span 与 usage record 关联（`span_id`）；usage 标准化 `input_tokens`、`output_tokens`、`total_tokens`，并保留 provider 原始已知字段（`raw`）。缺失的计数保持为空值而不是 0，且只在 provider 给出两个分量时才推导总量；只绑定 entry 的旧行 `operation_id IS NULL`，由 `legacy_unattributed` 标记为不可归属。

**事务边界（必须与既有 trace 语义一致）**：

- span-start 与 effect intent **在同一个 Session mutation 中写入**。`memory/trace.py` 与 long-term memory spec 已确立同一严格性：审计写入失败必须使该次 mutation 失败，不能制造"已执行但缺审计"的半个记录。若 span-start 单独提交，崩溃会留下"intent 已写、span 缺失、effect 已发起"的不可解释状态。
- span-end、usage、assistant/tool entry、operation state/result 在同一 settlement transaction 中写入。
- 失败、取消和 interrupted/unknown settlement 也必须写终态。每一次 provider retry 和每一个并行工具均创建独立 call/span，不能只记录最终聚合值。

**与既有 `TraceRecord` 的分工**：`EffectSpan` 是面向查询与指标的权威记录，其可用性不依赖 `trace_recorder`；`trace_recorder` 与 `TraceRecord` 继续服务 L0 archive 的 `execution-v1` 审计。二者并存、职责不同、不互相替代，开启 `trace_recorder` 不再是 UI 看到 call 级耗时的前提。

**"未知"必须有显式编码（已实现）**：`OperationStatus` 增加 `unknown`（表示结束时没有可证明的结果），终态写入 `ControlStatus = settled`，`EffectOutcome = pending | completed | failed | aborted | unknown`。UI 因此能区分"正在运行""崩溃后无人接管""被取消"和"已失败"，而不必从"无 result + state 停在 effect_pending"推断。该变更已同步 `pi-harness-implementation-plan.md` §5.1。

**不能把 turn 总耗时当作 effect 耗时（已实现）**：`OperationResult.ended_at - started_at` 包含 retry backoff 等待，且 `Entry.timestamp` 只有 settlement 结束时刻（并行工具共享同一毫秒）。因此 `EffectSpan.duration_ms` 只在 outcome 为 `completed`/`failed`/`aborted` 且 `ended_at` 存在时给出：`pending` 没有结束，`unknown` 的 `ended_at` 记录的是记录被关闭的时刻（可能远晚于 effect 停止，例如进程重启后的 recovery），两者都返回空值。UI 必须分层展示 task 总耗时与每次 call 耗时，不得用减法伪造 call 耗时。

**span 不得永久停留 pending（已实现）**：`safe` 工具被恢复重放时，丢失的前一次 attempt 会在授权重试的同一事务中结算为 `unknown`/`interrupted`，新的 attempt 使用递增的 `attempt` 与新的 `span_id`。因此一个 operation 终结后其所有 span 都已结算，UI 只会对"当前确有 effect 在飞"或"崩溃后尚未恢复"显示 pending。

不能用仅在线的 `HarnessEvent` 测量历史耗时：订阅可能断开，事件没有时间戳，也不能在进程重启后重放。事件只用于实时刷新；历史页面必须只读取上述持久记录。

### 3.3 只读查询契约

在 `api/` 增加只读、分页的 facade/DTO，而不是向 UI 暴露 `Session._storage` 或 SQLite SQL：

- `SessionCatalog.list_sessions(project_id, cursor, limit)`：返回 session 元信息和最近活动时间；
- `TraceQueryService.list_turns(session_id, lane?, cursor, limit)`：返回 operation meta/result、聚合 token 和总耗时；
- `TraceQueryService.get_turn(session_id, operation_id)`：返回按发生顺序的 entries、LLM/tool spans 和 usage records；
- `MemoryQueryService.list_l0(scope, cursor, limit)`、`list_l1(scope, cursor, limit, status?)`、`list_l2(scope, cursor, limit, status?)`、`get_l3()`、`list_jobs(scope, cursor, limit)`；
- `SkillQueryService.list_skills(scope, state?, cursor, limit)`、`get_skill(scope, skill_id)`、`list_versions(scope, skill_id, cursor, limit)`、`list_archives(scope, cursor, limit)`、`list_jobs(scope, cursor, limit)`、`list_audit(scope, cursor, limit)`。

上述读取**需要新增 SQL 路径，而不是给现有方法加参数**：`read_l1_since` 硬编码 `status='active'`（`memory_sqlite.py:544`）、`read_l2` 硬编码 `status='current'`（`:814`）、`read_l3` 恒用 `GLOBAL_L3_SCOPE`（`:866`）、skill `search`/`listing` 硬编码 `state='active'` 并按字符预算截断（`skill_sqlite.py:437,448`）。L3 按全局唯一 doctrine 返回并在 UI 中如此标注，不接受 repository 过滤。

授权解析遵循 ADR-WEB-003：`scope` 来自服务端配置，请求只能提交 `session_id` / `skill_id` 这类 allow-list 查找键，不能提交可伪造的 `repository_id`。查询 cursor 使用稳定排序键（如 `(started_at, operation_id)`、`(updated_at, memory_id)`、`(created_at, skill_id)`），不得依赖前端内存排序。

实现范围提示：memory 与 skill 的内存后端分别是 `SQLiteMemoryStore(":memory:")` 与 `SQLiteSkillStore(":memory:")` 的子类（`storage/memory_memory.py:13-15`、`storage/skill_memory.py:6-7`），因此新增的 SQL 读取路径自动同时满足两个后端，不需要写两份实现。**（已实现）**新增读取为 `MemoryStore.list_l0/read_archive/list_l1/list_l2/list_jobs/list_audit` 与 `SkillStore.get_skill/list_skills/list_versions/list_archives/list_jobs/list_audit`：各自接受"已解码的排序键 + limit"，返回 `limit + 1` 行，让"是否还有下一页"由读取本身回答而不必再查一次计数。列表投影刻意不携带大 payload：`ArchiveSummary`/`SkillArchiveSummary` 只带元信息与 `item_count`/`bytes_count`、`successful_tool_calls`、`turn_count`，`MemoryAuditRecord`/`SkillAuditRecord` 保留 `data`（审计的意义就在于此），完整归档仍由 `read_archive`/`get_archive` 提供。

**阶段 3 的 turn 枚举索引（新增 durable 状态）**：既有键空间无法枚举一个 session 的 lane 或一个 lane 的 operation，`LaneSnapshot` 只有当前 tip，`trace_writes_with_ids` 只在开启 `trace_recorder` 时写入、不能充当索引。因此在 `domain/values.py` 新增两个只追加地址：`lane/{lane}/operations`（按接纳顺序的 turn 索引）与 `session/lanes`（lane 枚举索引），分别写在唯一的接纳点 `Lane._admit` 与唯一的 lane 创建点 `Lane.attach` 的同一 mutation 事务内；`attach` 会为早于索引存在的 lane 回填 `session/lanes`，旧 Session 重新挂载后同样可枚举。索引只存 `operation_id`/`kind`/`started_at`，其余事实仍以 operation metadata/state/result 与 entry 为唯一权威；`get_turn` 取不到分支边界时抛 `StorageInvariantError`，不会给出可能错位的 entries。该变更已同步 `pi-harness-implementation-plan.md` §4。

**阶段 3 已交付的投影语义**（`TraceQueryService`）：turn 的 `duration_ms` 只在 `completed`/`declined`/`aborted`/`failed` 时给出，与 `EffectSpan.duration_ms` 同一规则（`unknown` 的 `ended_at` 是记录被关闭的时刻，`pending` 没有结束）；turn 的 token 分量只有在该 turn 的每条 usage 行都给出该分量时才聚合，**绝不把部分求和当作总量**，`operation_id IS NULL` 的旧行单列为 `unattributed_usage` 而不计入任何 turn；turn 的 entries 由分支段 `(from_tip_id, tip_id]` 决定，未结算 operation 以后继 operation 的 `source_tip_id` 为下界；catalog 之外或已缺库的 session 抛 `SessionNotFound`，不会因 SQLite 惰性建库而"成功返回空"。memory/skill 的 facade 对未知 status/state 抛 `ValueError`、对跨视图 cursor 抛 `InvalidCursor`，不接受的请求不用空列表回答；L1 superseded/rejected、L2 dormant、skill disabled/archived 均可列出（skill 当前只有 `active` 的写入方，browse 读取不为该状态设限）。

SQLite migration 只前进：为 operation/call usage、span 和查询索引加入新 schema version；迁移不会重建或丢弃旧 Session。注意各库版本不同：Session DB 现为 v1/v2（`storage/sqlite.py:60-87`）、memory DB 现为 v5（`storage/memory_sqlite.py:140-171`）、skill DB 现为 v1（`storage/skill_sqlite.py:77`）。旧 usage 与 operation 的关联若不可证明则标记 `legacy_unattributed`；注意 `UsageRow.entry_id` 只关联 entry，与 operation 没有直接关联（`storage/protocol.py:13`），描述与实现都应以"最多 entry 级绑定"为准。

## 4. API 与界面契约

推荐 REST 查询 + SSE 实时事件（WebSocket 可替换）的外壳。具体框架是应用层选择，不进入核心依赖。

| 端点/流 | 用途 |
|---|---|
| `GET /` | SPA 外壳（`index.html`），路由在浏览器内的 hash（见 §4.2） |
| `GET /static/{file}` | 前端静态资源（原生 ES module 与 CSS，无构建步骤） |
| `GET /api/health` | 存活与负载：状态、项目标识、各 store 是否配置、会话与 drive 计数；不含任何路径或凭据（§4.3） |
| `GET /api/project` | 返回规范化项目路径与只读仓库标识 |
| `GET /api/sessions` | 分页 session 选择器（catalog allow-list） |
| `POST /api/sessions` | 登记 session 并创建其数据库；session 唯一的诞生路径（见 §4.1） |
| `GET /api/sessions/{id}/lanes` | 该 session 的 lane 列表（来自只追加 lane 索引） |
| `POST /api/sessions/{id}/lanes/{lane}/turns` | durable `prompt`；由受控后台 task drive |
| `POST /api/sessions/{id}/lanes/{lane}/abort` | 映射 `request_abort` |
| `POST /api/sessions/{id}/lanes/{lane}/recover` | 接管已被判定为无人执行的未完成 operation |
| `GET /api/sessions/{id}/lanes/{lane}/events` | SSE：先 snapshot，后转发 `RemoteSubscription`；带事件 ID/重连补偿规则 |
| `GET /api/sessions/{id}/turns` | 分页轨迹列表和聚合指标 |
| `GET /api/sessions/{id}/turns/{operation_id}` | 单 turn 的完整 entries、spans、usage |
| `GET /api/memory/l0`、`/l1`、`/l2`、`/l3`、`/jobs`、`/audit`、`/l0/{archive_id}` | 只读记忆视图；L3 为全局 doctrine，`/jobs` 为晋升管道状态，单条归档含脱敏后的 items |
| `GET /api/skills`、`/skills/{skill_id}`、`/skills/{skill_id}/versions` | 只读 skill 资产与版本历史（含 disabled/archived） |
| `GET /api/skills/archives`、`/skills/archives/{id}`、`/skills/jobs`、`/skills/audit` | 来源归档（含 payload）、提取任务状态与技能审计 |

前端布局：顶栏固定显示 `project_root` 与 `repository_id`；左侧导航为"对话 / 轨迹 / 记忆 / 技能"。对话页与轨迹页都有 session 与 lane 选择器；轨迹页内有 turn 列表，详情按时间线展示 message、LLM、tool、usage。

展示契约：

- 时间显示 wall-clock 与 `duration_ms`；token 显示 input/output/total，provider 未给出的字段显示 `—`，不填零；
- 总耗时与 call 耗时分层展示，不用减法推导 call 耗时；
- 未结算/未知的 operation 显式标记为"结果未知"，不显示为 0 耗时或成功；
- 缺少 span 的旧 Session 把 call 级耗时标为"不可用（未记录）"，不推断；
- 记忆页按 L0 / L1 / L2 / L3 四个层级分栏（L3 标注为全局 doctrine），显示 version、status、更新时间、来源引用与脱敏状态；
- 技能页展示资产状态（active/disabled/archived）、当前版本、triggers/tags、SKILL.md 正文、资源文件、版本历史（版本号与 content_hash，版本永不重写）、来源归档与提取任务状态；**只读**，不提供编辑、启用/停用或审批操作。

### 4.1 阶段 4 已交付的传输契约（`api/web.py`）

**类型与错误**：响应统一为 JSON，dataclass/list/dict/标量直接映射，`bytes` 映射为 base64（skill 资源文件）；无法诚实描述的、非以上类型的字段是 500 而不是被 `str()` 成 `<object at 0x...>`。分页响应统一为 `{"items": [...], "next_cursor": ...}`。错误映射：`SessionNotFound` 404、`LaneBusy` 409（附 `lane`/`operation_id`）、`InvalidCursor` 与其余 `HarnessError`/`ValueError` 400、无活动 operation 的 abort 与"本进程正在 drive"的 recover 409、未配置的 store 503。

**session 的诞生**：只有 `POST /api/sessions` 创建数据库（登记 catalog + 创建 SQLite 文件），body 可带 `session_id`（缺省由服务端生成）与 `lane`；重复提交同一 id 只刷新最近活动、不清空历史。除此之外所有路径（读 facade 与 web adapter 的命令路径）都要求数据库已存在，catalog 有行而文件缺失一律 404——避免"文件被删后静默变成空会话"（与阶段 3 的 `TraceQueryService._open` 同一规则）。

**后台 drive 与生命周期**：`POST .../turns` 先 durable 写入 `prompt` 再返回 202，随后由 supervisor 持有的后台 task 执行 `drive`；SSE 断开只关闭订阅（`finally: subscription.close()`），从不调用 `request_abort`。同一 lane 已有 drive 时，新提交被 durable `LaneBusy` 拒绝（409 给出当前 operation id），而"上一轮 drive 正在收尾"时排在其后而不是被丢弃。session 在进程生命周期内保持打开（每个一条 SQLite 连接）；`aclose` 归还连接、封存 skill 缓冲并关闭共享的 memory/skill runtime；**不调用 `Harness.close()`**，因为它会关掉跨 session 共享的 runtime。

**recover 归属**：`POST .../recover` 只在"本进程没有该 lane 的 drive task"时执行，否则 409——这正是 `pi-harness-implementation-plan.md` 中"运维方不应对仍在运行的实例调用 `recover()`"的强制执行。被中断的 turn 由 `Drive.recover` 按既有 intent/settlement 规则收束（若 effect 结果不可知则显式 `unknown` + `interrupted`，不伪造 completed 或耗时），收束后 lane 立即恢复可用。

**SSE 补偿**：每条流先发 `retry:`，再以 `id: 0` 发 durable `snapshot`（含 `resumed_from`）。事件为 best-effort（ADR-WEB-002），因此 `Last-Event-ID` 只被确认、不回放：断线期间的补偿来自每条流开头的 durable snapshot 与随时可重读的查询 facade。空闲 15s 发注释行保活。

**认证与可选依赖**：配置了 token 时，`Bearer` 中间件对所有**携带数据**的路由（含 SSE）生效，未带凭证 401；未配置 token 即本机单用户部署（ADR-WEB-003）。唯一例外是浏览器自己发起的页面请求——`GET /` 与 `GET /static/*`（`_is_page_request`）：打开页面是导航而非 `fetch`，浏览器不会也不能带 `Authorization` 头，"把 token 放进 URL"又被 §4.2 拒绝，因此把外壳也挡上只会让已配置 token 的部署有 API 而没有界面。外壳与模块本身不含任何数据（页面显示的值全部来自 `/api/...`），token 也只存在于浏览器的 sessionStorage；前端在收到 401 时弹出凭据对话框。Web 框架作为可选 extra `web = ["starlette", "uvicorn"]` 引入，仅 `api/web.py` 导入它。

### 4.2 阶段 5 已交付的前端（`src/agent_harness/web/`）

无构建步骤的原生 ES module：`index.html` + `styles.css` + `app.js`（外壳）、`api.js`（HTTP/SSE 客户端）、`dom.js`/`format.js`（渲染与展示契约）、`chat.js`/`trace.js`/`memory.js`/`skills.js`（四个视图）。随包发布（`src/agent_harness/web/`），由 `GET /` 与 `GET /static/*` 托管。

**路由与刷新**：视图、session、lane 与视图内选择都在 URL hash 里（`#/trace?session=…&lane=…&turn=…`）。刷新页面回到同一 session/lane/turn 并重新执行 durable 查询，因此"刷新后的历史"与"流中看到的历史"必然一致——实时只负责触发重读，不负责提供历史。

**事件流**：用 `fetch` + `ReadableStream` 读取 SSE，而不是 `EventSource`——后者无法设置 `Authorization` 头，会给已配置 token 的部署留下"把 token 放进 URL"的唯一出路，而 URL 会进入访问日志。客户端自己解析 SSE 帧、按服务端 `retry:` 提示重连，并在重连时带上 `Last-Event-ID`；服务端返回的 `resumed_from` 会提示"已确认但未回放"。

**实时与 durable 的分界**：`message_update` 只驱动一个明确标注"流式接收中（尚未落盘）"的临时气泡，一旦 durable 读回该 turn 已有 status 就丢弃它；`operation_admitted`/`input_queued`/`message_end`/`tool_start`/`tool_end` 触发合并后的重读（默认 300ms 合并窗口）。没有事件时页面依然完整，只是不再自动更新。

**展示契约由前端强制**：`format.js` 是唯一把值变成字符串的地方——缺失 token 显示 `—`、未结算显示"未结算"、`unknown` 显示"结果未知"、`duration_ms` 为 `null` 时显示 `—`，并附上"为什么没有耗时"的说明；视图只读 provider/domain 给出的数，不从时间戳相减推导耗时。agent 产出的一切文本都经 `textContent` 渲染，从不使用 `innerHTML`。

**认证交互**：token 存在页面 sessionStorage，请求带 `Authorization: Bearer`；收到 401 时弹出凭据对话框，而不是把 token 写进 URL。空态与不可用态：未选择 session、lane 无 turn、某层没有记录、store 未配置（503）各有独立文案。

### 4.3 阶段 6 已交付的部署契约（`api/serve.py`、`deploy/web.env.example`、`deploy/start-web.sh`）

**配置只来自服务端环境**：`prale-web`（`agent_harness.api.serve:main`，`pyproject.toml` 的 `[project.scripts]`）在启动时读一次环境变量：项目标识（`PRALE_PROJECT_ROOT`/`PRALE_REPOSITORY_ID`/`PRALE_PROJECT_ID`）、store 位置（`PRALE_DATA_DIR` 及其派生的 sessions/catalog/memory/skill 路径，逐项可覆盖，或用 `PRALE_MEMORY=off`/`PRALE_SKILLS=off` 关掉）、provider（`PRALE_API_KEY`/`PRALE_MODEL`/`PRALE_BASE_URL`/`PRALE_TIMEOUT_SECONDS`，凭据无默认值，缺失即启动失败）、工具（`PRALE_TOOLS=read,edit,…`，默认空=只能对话）、访问（`PRALE_TOKENS`）、限额与监听（`PRALE_MAX_DRIVES`/`PRALE_MAX_CONNECTIONS`/`PRALE_GRACEFUL_SHUTDOWN_SECONDS`/`PRALE_HOST`/`PRALE_PORT`/`PRALE_LOG_LEVEL`）。`PRALE_GRACEFUL_SHUTDOWN_SECONDS` 默认 10 且必须大于 0：收到 SIGINT/SIGTERM 后，Uvicorn 最多等待这么久让已有 HTTP 请求自行结束，然后取消仍在运行的请求，避免持久 SSE 订阅使退出永久卡住；随后才进入应用 lifespan，关闭 session、worker 与 store。`repository_id` 直接交给 `ProjectRuntimeConfig`，路径形态的取值被 ADR-018 的校验拒绝。配置错误以退出码 2 和一行说明结束，不打印 traceback、不回显凭据。`--print-config` 打印解析结果（凭据只显示 `<set>`/`<unset>`）后退出，便于在绑定端口前核对。

**本地启动脚本**：`deploy/start-web.sh` 只是把"从 checkout 起一次部署"变成一条命令，不接管任何配置语义。它补三件事：store 落点（`PRALE_DATA_DIR` 默认 `$HOME/.local/share/prale`，不写进 checkout）、`src` 进 import path（仅当 `python -c "import agent_harness"` 失败——装好的包优先，否则 `PYTHONPATH` 会遮蔽它）、以及**拒绝猜 scope**：`PRALE_REPOSITORY_ID` 未设即退出 2，并把该 checkout 的 origin 打印成建议（凭据同理不填默认值，未设 `PRALE_TOKENS` 只警告——是否允许匿名由 server 判定）。配置文件取 `$PRALE_CONFIG`、`~/.config/prale/web.env`、`deploy/web.env` 中第一个存在的，`set -a` 后 source；落在 checkout 内且未被 git 忽略时告警。`PRALE_API_KEY_FILE` 可把 key 放进文件，避免进 shell history 与 `ps e`。`PRALE_CONFIG` 与 `PRALE_API_KEY_FILE` 是脚本自己的变量，`serve.py` 不读。末行是 `exec python -m agent_harness.api.serve "$@"`：信号与退出码都归 server（SIGTERM 下 uvicorn 打印 shutdown 行后按惯例以 `-15` 结束，不是崩溃）。首次运行会建出 `PRALE_DATA_DIR` 的布局（`prepare_directories`，否则 sqlite 首次运行即 `unable to open database file`）；`--print-config` 不建任何东西——"查配置"不是一次部署。

**页面与会话的初始化**：配置了 `PRALE_TOKENS` 的部署，浏览器先无凭据取回外壳与模块（`GET /`、`GET /static/*`，见 §4.1），随后第一个 `/api/...` 请求得到 401，前端弹出凭据对话框；token 写入 sessionStorage 后重跑 `boot()`。因此"有 token 的部署"不需要把 token 放进 URL，也不需要代理在网关处注入头部。

**health/readiness**：`GET /api/health` 返回 `status`（shutting down 时为 `shutting_down`，供排空前的探针判定）、`project`（仅 `repository_id`/`project_id`，**不含 `project_root`**）、`stores`（各 store 是否配置的布尔值，**不含路径**）、`sessions.open` 与 `drives.{active,limit,failed}`。`failed` 只计数：drive 的异常文本可能引用 provider 响应或工具参数，留在日志而不进入响应。配置了 token 时 health 同样受 Bearer 中间件约束（探针需带凭证——把一个会暴露项目标识的端点做成匿名可达没有必要）。

**并发限制**：`PRALE_MAX_DRIVES`（默认 `DEFAULT_MAX_CONCURRENT_DRIVES = 8`）在 `Lane.prompt` **之前**判定：已 durable 接纳却无人 drive，正是 `recover` 要收拾的状态，削峰不应制造它。判定只在"该 lane 没有活动 operation 且没有在跑的 drive"时生效——占用中的 lane 仍由 `LaneBusy` 给出更准确的 409，正在收尾的 lane 是接续 drive 而不是新增并发。超限返回 503。它是削峰而非预留：同一事件循环轮次内的两个提交可能都通过检查，因此上限可能被在途请求超出个位数。`PRALE_MAX_CONNECTIONS` 作为第二道（连接级）边界交给 uvicorn 的 `limit_concurrency`。

**日志脱敏**：`RedactingFilter` 挂在唯一的 root handler 上，并以 `log_config=None` 让 uvicorn 不另装 handler，因此访问日志也经过同一过滤器。两层：字面值层抹掉本部署的 provider key 与各 service token（无论出现在何处），形状层（`Bearer <…>`、`key=…`/`token: …`/`password: …`）接住字面值层不知道的凭据，例如 provider 错误信息里回引的 key。记录被重新排版为已脱敏文本，`exc_text`/`stack_info` 同样处理——异常栈正是凭据最常被打印的地方。脱敏宁可过度（`token: 3` 这类计数也会被抹掉），不追求最小改动。

**运维面与客户端面的分界**：日志与 `--print-config` 面向运维，会显示 store 路径与监听地址——这是运维要看的信息；面向客户端的全部响应（含 health）不含任何路径、凭据、未脱敏的工具参数或其它 scope 的内容。阶段 6 的验收标准约束的是后者。

**记忆/技能提炼的边界**：晋升是 LLM 阶段，其 prompt 是部署产物而非配置，本包不提供占位 prompt（否则会把通用指令的产物写进记忆库）。`PRALE_MEMORY_PROMPT` 指向部署自己的 prompt 文件时才启用提取（文件正文为 system prompt，各阶段 payload——含 `coding_memory_policy`——作为 user message，`stage` 标明 l1/l2_create/l2_update/l2_merge/l3）；未提供时 store 只读，记忆视图显示 L0 归档而无晋升条目。skill 评审同理留空。

## 5. 分阶段实施与验收

开工前必须先确定（否则阶段 4/5 无法排期）：

1. 前端形态：采用无构建步骤的静态资源（原生 ES module 或 htmx），不引入 node 工具链——仓库当前没有任何 JS 构建链，验证路径只有 `pytest`/`mypy`/`ruff`（ADR-WEB-005）；
2. Web 框架以可选依赖（extra）引入，不进入核心依赖，保持"核心库不绑定 HTTP 框架"的承诺（已交付为 `web = ["starlette", "uvicorn"]`，仅 `api/web.py` 导入）；
3. 部署形态为本机单用户，不做 ACL（ADR-WEB-003）。

| 阶段 | 交付物 | 验收标准 |
|---|---|---|
| 0. 规格、决策与 fixture | 本文件 §7 的 ADR、DTO/schema 定义、旧 Session fixture、fake clock/provider/tool、前端形态决策 | 明确 legacy 指标的未知语义；不改变 domain 依赖方向；前端与框架决策已记录 |
| 1. Catalog 与项目服务 | project config、session catalog、allow-list 解析 | catalog 是归属与元数据唯一入口；未登记 session 返回领域错误；路径不接受客户端覆盖；`repository_id` 来自配置而非路径 |
| 2. Durable observability | span/usage 标准化、storage migration、read protocol、未结算显式编码 | span-start 与 intent 同事务；intent 后/effect 后/settlement 前崩溃均不产生虚假的 completed duration；崩溃未恢复的 operation 可被显式识别为未知；每次 retry 与并行工具（fixture）各有独立 span |
| 3. 查询 facade | Trace/Memory/Skill query service、分页 DTO、L0--L2 全 status 可见 | 重启后同一 turn 的总耗时、token、span 排序一致；L1 superseded/rejected、L2 dormant、skill disabled/archived 均可列出；L3 按全局 doctrine 返回 |
| 4. Web adapter（**已实现**：`api/web.py`，可选 extra `web`） | REST、SSE reconnect、后台 drive 生命周期与重启后 recover | 断开浏览器只取消等待而不取消 operation；显式 abort 才调用 `request_abort`；进程重启后可 recover 未完成 operation 且 UI 状态一致 |
| 5. SPA（**已实现**：`src/agent_harness/web/`，随包发布） | 四个侧栏视图、session/lane 选择器、实时对话、轨迹/记忆/技能详情 | 新消息/工具事件实时更新；刷新后从 durable 查询恢复相同历史；四视图均可渲染空态与不可用态 |
| 6. 发布与运维（**已实现**：`api/serve.py` + `deploy/web.env.example`） | 配置示例、访问日志脱敏、限制并发、health/readiness | production 配置不暴露 DB 路径、provider credential、未脱敏 tool 参数或其他 scope 的 memory |

完成每阶段后运行受影响的 `pytest`、`ruff check .`、`ruff format --check .`、`mypy`。涉及 schema、公开 DTO 或恢复语义的实现同时更新本文件及 `pi-harness-implementation-plan.md`。

## 6. 测试矩阵

- storage conformance：span、usage、cursor、L0--L2 全 status 可见性与 `legacy_unattributed` 标记在 memory/SQLite 后端一致（内存后端是同一实现的 `:memory:` 实例）；
- migration：Session DB v1/v2、memory DB v5、skill DB v1 升级后 entry/usage/资产不丢失，新增索引可重复迁移；
- integration：一次含 retry、串行与并行工具（fixture 构造，生产 provider 目前不产生并行调用）的 turn，验证 per-turn token、task duration、call duration 和 source order；
- crash recovery：分别在 span-start 后、LLM/tool effect 后、terminal settlement 前终止并 reopen，验证 unknown/aborted 而非伪造耗时和 token；
- service：catalog 之外的 session、SSE 断线重连、浏览器取消等待、显式 abort、重启后 recover。阶段 4 已交付：`tests/integration/test_web_adapter.py`（真实 ASGI 应用 + 真实 SQLite store；直接驱动 ASGI 以模拟"流中断开"，覆盖 snapshot 先发与 `Last-Event-ID` 确认、断线后台 drive 继续、仅显式 abort 才取消、进程消失后 recover 收束为 `unknown`、本进程在 drive 时 recover 被拒、session 创建与"有行无库"404、未配置 store 503、token 中间件）；
- skill/memory 查询：disabled/archived skill 可见、版本历史、归档/任务/审计分页、L1 superseded 与 L2 dormant 可见、L3 全局唯一。阶段 3 已交付：`tests/conformance/test_memory_browse.py` 与 `tests/conformance/test_skill_browse.py`（两个后端上的浏览读取、排序键分页、scope 隔离、非默认 status）、`tests/integration/test_trace_query.py`（真实 turn 走 catalog 允许列表读回，含未知/未结算 turn 与部分 usage）、`tests/integration/test_memory_query.py` 与 `tests/integration/test_skill_query.py`（facade 层：scope 由服务端决定、cursor/limit/过滤器校验、只读可见性）；
- UI e2e：项目路径、四视图切换、session/lane 选择、token `—` 回退、未结算标记。阶段 5 已交付 `tests/integration/test_web_assets.py`（HTTP 层：外壳与所有被引用资源可达、模块构建的每个 `/api/...` 路径都在路由表中、每个视图都有空态与不可用态、源码层禁用 `innerHTML` 与时间戳相减推导耗时、SSE 客户端以头部而非 URL 传凭据）。视图的完整渲染需要浏览器，仓库不引入该工具链（ADR-WEB-005）：这部分以本机 node 临时 shim 手工验证，不进入常规验证路径。
- 发布与运维：阶段 6 已交付 `tests/integration/test_web_deployment.py`——已配置 token 的部署仍可取回外壳与模块（`/api/...` 仍 401、`/static/../api/...` 两者都不达）、health 只给标识与计数（断言部署路径、provider key、drive 异常文本都不出现在响应里，含一条"provider 报错信息引用凭据"的真实失败路径）、health 同样受 token 中间件约束、`max_concurrent_drives=1` 时的 503 削峰与被拒 lane 不留 operation（占用中的 lane 仍是 409）、日志过滤器对消息/参数/异常栈的脱敏、环境变量解析的合法与非法取值、以及 `--print-config` 不回声凭据与"配置错误以退出码 2 结束且无 traceback"。启动脚本另有 `tests/integration/test_web_launcher.py`，在干净环境与空工作目录下跑真实子进程：`--help` 自述并在包未安装时经 `src` 找到后端、未设 `PRALE_REPOSITORY_ID` 以退出码 2 拒绝编造 scope、`--print-config` 报告 `api_key <set>` 而不回声 key 且不建任何目录，以及"一条命令真的服务起来"——拉起到 `/api/health` 应答、首次运行建出布局、SIGTERM 后日志出现 `Shutting down`/`Application shutdown complete.` 且进程退出。

## 7. 架构决策记录

### ADR-WEB-001：Web UI 使用独立的应用适配层和 catalog

**背景：** Harness 的 SQLite 文件一库一 Session，核心层没有项目根目录概念，`SessionRepo.list()` 依赖 `glob("*.sqlite")` 与文件名推断归属，不能作为权限与归属依据。直接让浏览器扫描文件或传入路径既破坏边界，也会造成路径授权漏洞。

**决策：** 项目路径与 session catalog 由核心外的应用配置/数据库拥有；catalog 是归属、项目与最近活动元数据的唯一权威，session 文件是内容的唯一权威；Web adapter 通过 catalog 解析 session，随后调用 facade。

**后果：** 部署应用需显式配置 catalog、项目根目录与 `repository_id`；换来稳定的 session 选择和明确的边界，不改变 Session 的单写语义。

### ADR-WEB-002：历史性能数据以 durable effect span 为权威

**背景：** 当前 event stream 为 best-effort 且无时间戳；usage ledger 没有读取契约，每个 operation 最多一条且只含最后一次成功尝试；每个 effect 只有 settlement 结束时刻，没有开始时间与 attempt 粒度，并行工具还共享同一毫秒。既有 `TraceRecorder` 覆盖 intent/retry/tool outcome 的 L0 审计，但没有 call 级耗时字段且默认关闭。

**决策：** 每个 effect attempt 追加 durable span，span-start 与 effect intent 同事务，span-end 与 outcome/state/usage 在同一 Session transaction 结算。`EffectSpan` 是面向查询的权威记录，与 `TraceRecord` 并存且不互相替代。UI 仅以这些记录和 `OperationResult` 展示历史统计，events 只用于实时更新。

**后果：** 会增加少量 append-only 存储和迁移工作，却保证刷新、重启和崩溃恢复后统计仍可审计；旧历史保留未知而非伪造指标。

### ADR-WEB-003：记忆与技能观察不做身份 ACL，scope 由服务端配置决定

**背景：** ADR-018 已把公开归属字段统一为稳定的 `repository_id`，并明确"该模型不提供多用户或团队 ACL；若未来需要，必须引入独立 owner/ACL 维度，而不能复用 repository ID"。`domain/memory.py:25-26` 同样声明身份不是记忆授权维度。L3 是全局唯一 doctrine，`read_l3` 恒用保留的 `GLOBAL_L3_SCOPE`，不按 repository 过滤。

**决策：** 本期为本机单用户部署，不引入主体认证到 scope 的映射、不做越权判定。memory/skill 的 scope 由服务端启动配置决定，请求只能提交 `session_id`/`skill_id` 这类 allow-list 查找键，不能提交 scope 或文件路径。`AuthenticatedHarnessService` 的 token 仅用于防止本机其他进程误连，不是多用户授权。L1--L2 与 skill 按配置的 repository scope 展示，L3 按全局 doctrine 展示。

**后果：** UI 能正确显示分层记忆与技能，同时不把 session 选择误解为 memory 权限边界。若未来需要多用户，必须按 ADR-018 新增独立的 owner/ACL 维度，而不是复用 `repository_id`。

### ADR-WEB-004：技能视图只读

**背景：** 技能资产有严格的质量与安全闸门（`validate_skill_proposal`）与乐观版本语义（写入必须携带 `expected_version`，版本永不重写）；`skill-self-evolution-integration.md` 明确人工审核/资产管理 API 需另行定义，且不得混入自动 Review 权限。

**决策：** 本期技能视图只提供读取：资产与状态、版本历史、来源归档、提取任务与审计。不提供创建、修改、启用/停用、补丁或审批入口，也不暴露 review 权限。

**后果：** UI 可以观察技能沉淀结果，但不会绕过质量闸门或版本规则。人工审核能力留给后续独立设计。

### ADR-WEB-005：前端不引入构建工具链，Web 框架为可选依赖

**背景：** 仓库当前没有 `package.json` 或任何 JS 工具链，验证路径是 `pytest`/`mypy`/`ruff`，且 `mypy` 只覆盖 `domain`/`storage`/`api`。README 明确承诺"核心库不绑定 HTTP 框架"。

**决策：** 前端使用无构建步骤的静态资源（服务端提供 HTML 与原生 ES module/htmx，由 Web adapter 托管），不引入 node 构建链；Web 框架与 ASGI 服务器以可选依赖（extra）引入，核心安装不包含它们。

**后果：** 保持纯 Python 的本地验证流程，前端不需要独立的构建与产物管理；代价是前端不使用组件框架，复杂交互需自行组织。UI 端到端测试以 HTTP 层为主，不引入浏览器自动化之外的额外工具链。

### ADR-WEB-006：优雅退出为长连接设置有界期限

**背景：** 对话页面维持 SSE 订阅，正常情况下它不会自行完成。Uvicorn 未设置 `timeout_graceful_shutdown` 时，会在第一次 SIGINT/SIGTERM 后无限等待该请求，应用 lifespan 因而永远无法开始释放资源。

**决策：** 部署以 `PRALE_GRACEFUL_SHUTDOWN_SECONDS`（默认 10，必须为正数）传给 Uvicorn 的 `timeout_graceful_shutdown`。到期后由 ASGI server 取消仍未结束的请求，再运行应用的 shutdown/lifespan 清理；显式 abort 的 durable 语义不变，关机中断的 in-flight operation 仍遵循既有 recovery 规则。

**后果：** 退出时间有上限，SSE 客户端会断开并在下次连接时通过 durable 查询恢复显示。超过期限的 in-flight operation 可能需要 recover，不能把服务器关机误报为远端 effect 已取消或成功。
