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

将 operation 作为一个 UI turn。新增 append-only `EffectSpan` / `UsageRecord` 领域 DTO（或等价稳定存储 DTO）：

- `operation_id`、`call_id`、`kind`（`llm` / `tool`）、lane、工具名（如适用）、attempt、开始/结束毫秒时间、终态和错误分类；
- LLM span 与 usage record 关联；usage 至少标准化 `input_tokens`、`output_tokens`、`total_tokens`，并保留 provider 原始已知字段；
- tool span 保存 `tool_call_id`，但不重复保存工具名、参数与 source order——这些已由 assistant entry 的 `tool_calls` 与 branch `seq` durable 提供（`drive.py:621-624`），span 只存关联 id；同时不保存未脱敏的参数/结果副本。

**事务边界（必须与既有 trace 语义一致）**：

- span-start 与 effect intent **在同一个 Session mutation 中写入**。`memory/trace.py` 与 long-term memory spec 已确立同一严格性：审计写入失败必须使该次 mutation 失败，不能制造"已执行但缺审计"的半个记录。若 span-start 单独提交，崩溃会留下"intent 已写、span 缺失、effect 已发起"的不可解释状态。
- span-end、usage、assistant/tool entry、operation state/result 在同一 settlement transaction 中写入。
- 失败、取消和 interrupted/unknown settlement 也必须写终态。每一次 provider retry 和每一个并行工具均创建独立 call/span，不能只记录最终聚合值。

**与既有 `TraceRecord` 的分工**：`EffectSpan` 是面向查询与指标的权威记录，其可用性不依赖 `trace_recorder`；`trace_recorder` 与 `TraceRecord` 继续服务 L0 archive 的 `execution-v1` 审计。二者并存、职责不同、不互相替代，开启 `trace_recorder` 不再是 UI 看到 call 级耗时的前提。

**"未知"必须有显式编码**：当前未结算状态只能由"无 result + state 停在 effect_pending"隐式推断，`OperationStatus` 没有 unknown 取值（`domain/types.py:4`），且 `_terminal_writes` 在终态仍写 `control="running"`（`drive.py:1062-1065`）。本期必须新增显式的未结算/未知表达，使 UI 能区分"正在运行"与"崩溃后无人接管"。该变更触及公开 DTO，需同步 `pi-harness-implementation-plan.md` 与相应测试。

**不能把 turn 总耗时当作 effect 耗时**：`OperationResult.ended_at - started_at` 包含 retry backoff 等待（`drive.py:566, 572-579`），且 `Entry.timestamp` 只有 settlement 结束时刻（并行工具共享同一毫秒，`storage/sqlite.py:114-117`）。UI 必须分层展示 task 总耗时与每次 call 耗时，不得用减法伪造 call 耗时。

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

实现范围提示：memory 与 skill 的内存后端分别是 `SQLiteMemoryStore(":memory:")` 与 `SQLiteSkillStore(":memory:")` 的子类（`storage/memory_memory.py:13-15`、`storage/skill_memory.py:6-7`），因此新增的 SQL 读取路径自动同时满足两个后端，不需要写两份实现。

SQLite migration 只前进：为 operation/call usage、span 和查询索引加入新 schema version；迁移不会重建或丢弃旧 Session。注意各库版本不同：Session DB 现为 v1/v2（`storage/sqlite.py:60-87`）、memory DB 现为 v5（`storage/memory_sqlite.py:140-171`）、skill DB 现为 v1（`storage/skill_sqlite.py:77`）。旧 usage 与 operation 的关联若不可证明则标记 `legacy_unattributed`；注意 `UsageRow.entry_id` 只关联 entry，与 operation 没有直接关联（`storage/protocol.py:13`），描述与实现都应以"最多 entry 级绑定"为准。

## 4. API 与界面契约

推荐 REST 查询 + SSE 实时事件（WebSocket 可替换）的外壳。具体框架是应用层选择，不进入核心依赖。

| 端点/流 | 用途 |
|---|---|
| `GET /api/project` | 返回规范化项目路径与只读仓库标识 |
| `GET /api/sessions` | 分页 session 选择器（catalog allow-list） |
| `POST /api/sessions/{id}/lanes/{lane}/turns` | durable `prompt`；可选择由受控后台 task drive |
| `POST /api/sessions/{id}/lanes/{lane}/abort` | 映射 `request_abort` |
| `GET /api/sessions/{id}/lanes/{lane}/events` | SSE：先 snapshot，后转发 `RemoteSubscription`；带事件 ID/重连补偿规则 |
| `GET /api/sessions/{id}/turns` | 分页轨迹列表和聚合指标 |
| `GET /api/sessions/{id}/turns/{operation_id}` | 单 turn 的完整 entries、spans、usage |
| `GET /api/memory/l0`、`/l1`、`/l2`、`/l3`、`/jobs` | 只读记忆视图；L3 为全局 doctrine，`/jobs` 为晋升管道状态 |
| `GET /api/skills`、`/skills/{skill_id}`、`/skills/{skill_id}/versions` | 只读 skill 资产与版本历史（含 disabled/archived） |
| `GET /api/skills/archives`、`/skills/jobs`、`/skills/audit` | 来源归档、提取任务状态与技能审计 |

前端布局：顶栏固定显示 `project_root` 与 `repository_id`；左侧导航为"对话 / 轨迹 / 记忆 / 技能"。对话页与轨迹页都有 session 与 lane 选择器；轨迹页内有 turn 列表，详情按时间线展示 message、LLM、tool、usage。

展示契约：

- 时间显示 wall-clock 与 `duration_ms`；token 显示 input/output/total，provider 未给出的字段显示 `—`，不填零；
- 总耗时与 call 耗时分层展示，不用减法推导 call 耗时；
- 未结算/未知的 operation 显式标记为"结果未知"，不显示为 0 耗时或成功；
- 缺少 span 的旧 Session 把 call 级耗时标为"不可用（未记录）"，不推断；
- 记忆页按 L0 / L1 / L2 / L3 四个层级分栏（L3 标注为全局 doctrine），显示 version、status、更新时间、来源引用与脱敏状态；
- 技能页展示资产状态（active/disabled/archived）、当前版本、triggers/tags、SKILL.md 正文、资源文件、版本历史（版本号与 content_hash，版本永不重写）、来源归档与提取任务状态；**只读**，不提供编辑、启用/停用或审批操作。

## 5. 分阶段实施与验收

开工前必须先确定（否则阶段 4/5 无法排期）：

1. 前端形态：采用无构建步骤的静态资源（原生 ES module 或 htmx），不引入 node 工具链——仓库当前没有任何 JS 构建链，验证路径只有 `pytest`/`mypy`/`ruff`（ADR-WEB-005）；
2. Web 框架以可选依赖（extra）引入，不进入核心依赖，保持"核心库不绑定 HTTP 框架"的承诺；
3. 部署形态为本机单用户，不做 ACL（ADR-WEB-003）。

| 阶段 | 交付物 | 验收标准 |
|---|---|---|
| 0. 规格、决策与 fixture | 本文件 §7 的 ADR、DTO/schema 定义、旧 Session fixture、fake clock/provider/tool、前端形态决策 | 明确 legacy 指标的未知语义；不改变 domain 依赖方向；前端与框架决策已记录 |
| 1. Catalog 与项目服务 | project config、session catalog、allow-list 解析 | catalog 是归属与元数据唯一入口；未登记 session 返回领域错误；路径不接受客户端覆盖；`repository_id` 来自配置而非路径 |
| 2. Durable observability | span/usage 标准化、storage migration、read protocol、未结算显式编码 | span-start 与 intent 同事务；intent 后/effect 后/settlement 前崩溃均不产生虚假的 completed duration；崩溃未恢复的 operation 可被显式识别为未知；每次 retry 与并行工具（fixture）各有独立 span |
| 3. 查询 facade | Trace/Memory/Skill query service、分页 DTO、L0--L2 全 status 可见 | 重启后同一 turn 的总耗时、token、span 排序一致；L1 superseded/rejected、L2 dormant、skill disabled/archived 均可列出；L3 按全局 doctrine 返回 |
| 4. Web adapter | REST、SSE reconnect、后台 drive 生命周期与重启后 recover | 断开浏览器只取消等待而不取消 operation；显式 abort 才调用 `request_abort`；进程重启后可 recover 未完成 operation 且 UI 状态一致 |
| 5. SPA | 四个侧栏视图、session/lane 选择器、实时对话、轨迹/记忆/技能详情 | 新消息/工具事件实时更新；刷新后从 durable 查询恢复相同历史；四视图均可渲染空态与不可用态 |
| 6. 发布与运维 | 配置示例、访问日志脱敏、限制并发、health/readiness | production 配置不暴露 DB 路径、provider credential、未脱敏 tool 参数或其他 scope 的 memory |

完成每阶段后运行受影响的 `pytest`、`ruff check .`、`ruff format --check .`、`mypy`。涉及 schema、公开 DTO 或恢复语义的实现同时更新本文件及 `pi-harness-implementation-plan.md`。

## 6. 测试矩阵

- storage conformance：span、usage、cursor、L0--L2 全 status 可见性与 `legacy_unattributed` 标记在 memory/SQLite 后端一致（内存后端是同一实现的 `:memory:` 实例）；
- migration：Session DB v1/v2、memory DB v5、skill DB v1 升级后 entry/usage/资产不丢失，新增索引可重复迁移；
- integration：一次含 retry、串行与并行工具（fixture 构造，生产 provider 目前不产生并行调用）的 turn，验证 per-turn token、task duration、call duration 和 source order；
- crash recovery：分别在 span-start 后、LLM/tool effect 后、terminal settlement 前终止并 reopen，验证 unknown/aborted 而非伪造耗时和 token；
- service：catalog 之外的 session、SSE 断线重连、浏览器取消等待、显式 abort、重启后 recover；
- skill/memory 查询：disabled/archived skill 可见、版本历史、归档/任务/审计分页、L1 superseded 与 L2 dormant 可见、L3 全局唯一；
- UI e2e：项目路径、四视图切换、session/lane 选择、token `—` 回退、未结算标记。

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
