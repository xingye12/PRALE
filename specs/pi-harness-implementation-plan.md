# Pi Harness 重构实施方案

## 1. 目标与边界

本项目实现 pi `packages/agent/src/harness/` 的 Python 版 Agent Harness。目标是提供一个可持久化、可恢复、可观察的 Agent 运行时，而非 TypeScript 源码的逐行翻译。

第一版的交付边界：

- 单机单写 Session，使用 SQLite 作为生产存储、内存存储作为测试实现；
- Session entry tree、branch、lane、operation、usage ledger 的完整持久化模型；
- 无工具的 DeepSeek 流式生成，覆盖 `intent → effect → settlement → recovery`；
- 工具批次、取消、重试、有限流帧 checkpoint；
- compaction、navigation、branch summary 与 fork；
- 小而稳定的 Python 库 API、事件和 hook；
- 存储一致性与崩溃恢复测试。

第一版明确不包含：多主写入、分布式一致性、外部副作用的 exactly-once 保证，以及 pi 的实验性 `pico3/` 运行时。跨会话长期记忆和 Skill 自进化作为阶段 10 的可选扩展实现，其范围和不变量分别见 [长期记忆实现规范](long-term-memory-implementation-spec.md) 与 [Skill 自进化功能接入](skill-self-evolution-integration.md)。

## 2. 规范来源与优先级

实现行为按以下优先级裁决：

1. 本文和 `specs/AGENTS.md`；
2. `/root/vibe/CoLe/pi/packages/agent/docs/agent-harness-python-architecture.md`；
3. `/root/vibe/CoLe/pi/packages/agent/docs/harness.md` 中的事务、状态机、恢复与测试不变量；
4. `/root/vibe/CoLe/pi/packages/agent/src/harness/` 的现有可观察行为。

若 Python 架构文档与 TypeScript 实现的局部细节不一致，优先保留 Python 架构文档规定的行为边界。遇到未定义且会影响持久化格式、公开 API 或恢复语义的选择，先在本文“架构决策”补充 ADR，再实现。

## 3. 目标架构

```text
agent_harness/
  api/             # 稳定公开 API、DTO、领域错误
  domain/          # 纯领域模型与纯计算；不依赖 DB、Web、LLM SDK
  runtime/         # Lane、Drive、generation、tools、structural、recovery
  storage/         # Storage/SessionRepo 协议、memory、SQLite、迁移
  integrations/    # DeepSeek、具体工具、telemetry 适配器
tests/
  unit/ conformance/ integration/ crash_recovery/
```

依赖方向只能向内：`api → runtime → domain`，`storage → domain`，`integrations → api/domain`。`domain/` 不得导入运行时、数据库驱动、HTTP 框架或任何 LLM SDK。`runtime/` 只能依赖 storage/integration 定义的协议，不能依赖 DeepSeek wire payload。

推荐 Python 技术基线：Python 3.12+、`asyncio`、`typing`/`dataclasses`（或同等不可变 DTO）、`pytest`。框架、ORM 和 Web/RPC 传输在第 9 阶段以后才可引入；存储层直接使用 SQLite 时不得将 SQL 泄漏到 domain/runtime。

## 4. 领域模型与持久化约束

```text
Harness
  └─ Session（唯一可写拥有者）
       ├─ entry tree（只追加）
       ├─ values/lists（可替换运行状态与短期 checkpoint）
       ├─ usage ledger（只追加）
       └─ Lane × N（每条 lane 至多一个 operation）
```

| 对象 | 职责 | 持久化规则 |
|---|---|---|
| Session | 对话及运行状态的持久容器 | 同时仅一个写拥有者；所有写入通过事务 |
| Entry | 消息、工具结果、摘要、业务自定义记录 | 不可变、仅追加；`id` 唯一，父 entry 必须存在 |
| Branch | entry tree 中可移动的逻辑路径 | 保存 tip；历史不重写 |
| Lane | 绑定 branch tip 的串行执行通道 | 每条 lane 仅一个活动 operation |
| Operation | `run`、`compaction`、`navigation` 工作单元 | metadata 不变；state 整体替换；terminal result 独立保存 |
| Drive | operation 的进程内执行器 | 不持久化；重启后由 operation state 重建 |

所有持久内容必须归类为 entries、values/lists 或 usage ledger。单次提交分配单调递增的 `sequence`，且 entry 插入、usage 插入、tip 更新、operation state 更新和队列更新必须原子可见。禁止把这些逻辑拆成多个独立事务。

初始 SQLite schema 至少包含：`sessions`、`entries`、`values`、`list_elements`、`usage_rows` 和 `schema_migrations`。为 `(session_id, seq)`、`(session_id, parent_id)`、value 地址和 list 地址建立查询索引。迁移只前进不回滚；每次迁移必须可在空库和已有库上重复安全执行。

## 5. Operation 状态机与副作用协议

每个 operation 必须保存 immutable metadata、完整当前 state 和 terminal result。state 是恢复点，必须整体替换；不得通过扫描日志或事件推断下一步。

```text
starting → checkpoint → assistant_ready → assistant_effect_pending → tools
                 ↑             │                    │                  │
                 └─────────────┴──── retry_wait ─────┴── terminal ──────┘

summary_deciding → summary_ready → summary_effect_pending → retry_wait / terminal
navigation_ready → terminal
deferred_suspended → deferred_effect_pending / terminal
```

任何 LLM 或工具副作用固定使用四阶段协议：

```text
准备不可变输入 → 持久化 effect intent → 调用外部系统 → 原子持久化 outcome 与下一状态
```

- LLM intent 至少保存 model identity、投影后的请求上下文、stream options、预留 assistant entry ID、usage ID、尝试次数和重试时间；
- 工具 intent 至少保存已验证参数、`tool_call_id`、源顺序和 replay policy；
- `safe` 工具可在恢复后重试；`never` 工具恢复时必须写入“执行中断、结果未知”的 tool result，不能盲目重放；
- provider stream 在 effect-pending 崩溃后不能尝试续接同一 HTTP 连接，应按已 checkpoint 内容收束为明确 interrupted/aborted assistant 结果；
- 若 provider 或工具支持幂等键，使用 operation ID / tool-call ID；这只能降低重复风险，不能声称 exactly-once。

## 6. 公开 API、事件与 Hooks

第一版公开 API 保持传输无关，并为正常的领域控制流返回显式结果类型：

```python
harness = await Harness.open(session)
lane = await harness.acquire_lane(name)
await lane.prompt(...)
await lane.queue_steer(...)
await lane.queue_follow_up(...)
await lane.compact(...)
await lane.navigate(...)
await lane.resume(...)
await lane.recover(provider=None)
await lane.request_abort(...)
snapshot = await lane.snapshot(...)
subscription = lane.watch(...)
```

`LaneBusy`、`NothingToCompact`、`UnknownTarget` 等是领域错误；存储损坏和 provider 故障是系统错误。不得用异常消息字符串来表达可预期的领域分支。

事件至少覆盖 lane 创建/配置、operation 生命周期、message start/update/end、tool start/update/end、entry committed、usage、compaction 和 handler error。事件与 snapshot 都是投影；监听器异常必须隔离、记录，且绝不能中断 Agent 主流程。

Hook 是同步等待型状态机扩展点，按注册顺序串行执行：`before_drive`、`before_run`、`transform_context`、`before_request`、`before_payload`、`after_response`、`before_tool`、`after_tool`、`before_run_end`、`before_compaction`、`before_navigation`。hook 注册不持久化；其返回值只有在后续事务中消费后才 durable，因此所有 hook 都必须可重放、幂等。`before_drive` 失败 fail-closed；`before_tool` 失败按 block；其他 handler 失败记录后 fail-open。

## 7. 分阶段实施计划

| 阶段 | 交付物 | 验收标准 |
|---|---|---|
| 0. 工程骨架 | 包布局、类型检查/格式化/pytest 配置、错误与 DTO 边界 | 空实现可导入；CI 能运行 lint、type check、tests |
| 1. 存储契约 | `Storage`、`SessionRepo`、memory backend、conformance suite | 所有原子提交、seq、tree、value/list、usage 契约在内存实现通过 |
| 2. Session 与上下文 | entry tree、branch tip、branch scan、projection、单写 mutation line | 任意分支可重建稳定上下文；嵌套写不会死锁或越权 |
| 3. Lane 接纳 | lane restore、operation metadata/state/result、snapshot、队列 | 操作在 Drive 领取前已 durable；同 lane busy 被拒绝/复用 |
| 4. 无工具生成 | provider 协议、DeepSeek adapter、intent/settlement、stream events | 成功、provider error、未知 outcome 恢复均不重复写入 assistant entry |
| 5. 工具与控制 | tool registry、parallel/sequential batch、abort、retry、frame checkpoints | 工具结果按 assistant 源顺序落盘；取消不启动新的 effect |
| 6. 结构操作 | compaction、branch summary、navigation、fork | 历史不可变；摘要/导航可恢复且 tip 原子更新 |
| 7. SQLite 与恢复 | schema、migration、SQLite backend、crash injection suite | 在每个事务边界中断后可恢复到定义状态 |
| 8. 观察与扩展 | hooks、watch、telemetry、文档与示例 | handler/listener 失败隔离；hook 结果遵守持久化边界 |
| 9. 服务层（后置） | HTTP/RPC、认证、远程订阅、TUI 适配 | 仅复用库 API；不得把传输状态混入 domain/runtime。Web UI 的 catalog、durable trace 查询、指标与适配实施见 [Web UI 实施计划](web-ui-implementation-plan.md) |
| 10. 长期资产（可选） | 持久化调度器与 runtime 生命周期、Session→L0 trace archive、L1--L3、Skill buffer/review、资产检索、保留/GC 与 SQLite | 跨 Session 资产经 scope 隔离；后台失败不阻塞 Drive；冻结 source snapshot、召回/Skill 版本进入 effect intent；进程重启后延迟任务不丢失且只执行一次 |

每阶段顺序固定为：先写规格化/崩溃测试，再实现 memory backend 或 runtime，再接入 SQLite 或外部适配器。阶段完成前不得提前把服务框架或 UI 作为运行时依赖。

## 8. 测试策略与关键不变量

测试分为 unit、storage/session conformance、runtime integration、crash recovery 四层。每项持久化状态机改动必须增加至少一条中断测试，模拟在 effect intent 之后、外部 effect 之后、settlement 之前终止进程。

必须持续验证：

- entry 和 usage 只追加，entry 父引用存在，sequence 严格递增；
- 一个 Session 任一时刻只有一个写 mutation line；
- 每条 lane 任一时刻只有一个活动 operation，同一 operation 不得创建多个 Drive；
- terminal result 只提交一次，结果可在重启后查询；
- assistant/tool outcome、branch tip、usage、operation state 同一事务提交；
- 并行工具的完成事件可乱序，但 tool-result entries 必须保持 assistant tool-call 的源顺序；
- 调用方取消等待不等于 operation 取消；operation 取消必须先关闭 effect gate，再持久化取消，再终止本地任务；
- snapshot/event 非权威，重新挂载 lane 必须只依赖 durable state；
- hook 重放不得产生未受控制的外部副作用。

## 9. 架构决策记录

### ADR-001：SQLite 是第一版生产后端

选择 SQLite 以匹配单机单写的范围，并优先验证事务与恢复语义。接口不得假设 SQLite 专有类型，后续可增加其他 `Storage` 实现。

### ADR-002：DeepSeek 只存在于 integration adapter

第一版仅提供 `integrations/deepseek.py`，其向 runtime 暴露 provider 中立的流事件和完整 assistant result。模型名称、认证、HTTP 字段和 SDK 对象禁止出现在 `domain/` 或 `runtime/`。

### ADR-003：持久 operation state 使用全量快照

每次状态转换替换完整 state，降低恢复逻辑复杂度并避免从事件日志猜测进度。历史审计由 immutable entries/usage 与 telemetry 承担。

### ADR-004：外部副作用采用 at-least-once 风险可见化

在外部系统不支持幂等时，无法保证 exactly-once。系统以 durable intent 表示不确定副作用，以 replay policy 选择重试或显式中断收束。

### ADR-005：跨会话资产与 Session 状态分库存储、通过 outbox 衔接

长期记忆和 Skill 的生命周期、scope 范围和异步处理方式均不同于单 Session 的执行状态，因此由独立的资产存储拥有。Session terminal settlement 原子写入 capture outbox，后台以幂等方式投递资产库；召回和 Skill loadout 冻结进 provider effect intent。这样既不把 LLM/索引 I/O 放进 Session transaction，也能在崩溃后补投并维持 operation 的可复现性。

### ADR-006：流式输出以内容 checkpoint 恢复，而非连接续接

**背景：** provider 的 HTTP/SSE 连接不能在进程重启后可靠续接，但 UI 仍需要看到已生成的内容，恢复也必须避免把未知远端结果当作未发生。

**决策：** `assistant.effect_pending` intent 保存 `model`、`stream_options` 与 `content_checkpoint`。支持流式能力的 provider 每收到一个内容帧就原子替换该 state 并发出 `message_update`；流结束后仍通过正常 settlement 写入 assistant entry 和 usage。`recover()` 默认只收束未知 provider outcome；若已知 pending tool 为 `safe`，调用方必须以 `recover(provider)` 提供继续运行所需的 provider。

**后果：** checkpoint 增加写放大，但不会保存或重连 provider transport 状态。崩溃恢复写入明确的 aborted assistant entry，内容为最后一个已 durable checkpoint；不会将其误报为完整回答。

### ADR-007：SQLite 文件一库一 Session，并显式绑定逻辑 ID

**背景：** 第一版的 SQLite repository 为每个 Session 分配独立数据库文件；若只依赖文件名，会让复制、移动或错误打开文件时的 Session 所有权变得不明确。

**决策：** 每个数据库在 `sessions` 表中保存唯一逻辑 ID 和创建时间。`Harness.open()` 绑定或验证该 ID；repository fork 在暴露克隆之前将绑定替换为目标 Session。schema migration ledger 目前为 v1 基表与 v2 查询索引，均可重复执行。

**后果：** 同一 SQLite 文件不能被不同 session ID 打开，消除了跨 Session value/lane 地址碰撞；跨 Session fork 是数据库快照而非共享可写存储。

### ADR-008：Drive 领取使用 durable lease

**背景：** 同一 SQLite Session 可以被多个进程内 Harness 或多个数据库连接重新挂载。仅靠对象内 `asyncio.Lock` 无法阻止两个 Drive 对同一 effect intent 同时调用 provider/tool。

**决策：** `lane.drive()` 在执行前原子写入 `operation/<id>/drive_lease`，未取得 lease 的调用方仅观察 terminal result。terminal settlement 与 lane 空闲状态在同一事务删除 lease；本地异常退出在 finally 中按 token 条件释放。`recover()` 显式接管旧 lease，代表调用方已判定原执行进程不可用。

**后果：** 同一 operation 在正常运行中只有一个 Drive。进程崩溃留下的 lease 不会自动猜测远端 effect 是否完成，而由显式恢复走既有 intent/settlement 规则；运维方不应对仍在运行的实例调用 `recover()`。

### ADR-009：operation 取消中止本地 Drive，但不伪造远端 outcome

**背景：** 调用方取消等待与业务层 `request_abort()` 不是同一件事。后者需要停止本地资源占用，但 provider/tool 已开始时无法证明远端是否完成。

**决策：** `request_abort()` 先 durable 写入 `cancel_requested`，然后仅中止同一 Lane 已登记的本地 Drive task。Drive 捕获该取消时，若 state 仍为 `assistant.effect_pending`，按 interrupted/unknown settlement 收束；尚未开始 effect 的状态按 cancelled settlement 收束。单纯取消调用 `drive()` 的 await task 不会设置 durable cancel flag，仍向调用方传播 `CancelledError`。

**后果：** API 可以立即停止本地生成，同时不会错误声称外部请求未执行。跨进程运行实例不共享 task，仍需通过自己的 watcher/abort transport 触发本地中止，durable state 保持一致。

### ADR-010：服务层仅提供认证后的 JSON-RPC 与事件流适配

**背景：** 阶段 9 需要 HTTP/RPC、认证和远程订阅，但核心 harness 不应依赖 Web 框架或连接状态。

**决策：** `api/service.py` 提供 `AuthenticatedHarnessService`、可替换的 `Authenticator` 协议和 `RemoteSubscription`。HTTP、WebSocket、SSE 或 TUI 外壳只负责认证、调用 `dispatch()`、以及将 `next()` 事件编码给客户端；service 本身只依赖公开 `HarnessRpc` / `Lane.watch()`。telemetry 以独立的 event listener adapter 提供。

**后果：** 传输连接、认证凭据和订阅队列不会进入 domain/runtime 或 durable Session。应用可以采用任意 Web 框架，而无需重写 Agent loop。

### ADR-011：compaction entry 持久化摘要覆盖范围与保留 tail

**背景：** 仅追加 summary entry 不会自动缩短 provider context；如果后续投影仍读取全部祖先消息，compaction 没有实际作用。

**决策：** compaction payload 除 `summary` 外保存 `retained_message_ids`。上下文投影遇到最近的 compaction/branch summary 后，发送 system summary、声明保留的原始 message tail，以及摘要之后的新消息；被摘要覆盖的祖先消息不再发送，但仍保留在 entry tree。

**后果：** compaction 格式是可演进的 JSON payload；旧格式没有 tail 元数据时安全退化为仅发送 summary 和其后消息。摘要不重写历史，也不改变 branch 的不可变 parent 链。

### ADR-012：内置本地工具是 integration adapter，写入类效果默认不可重放

**背景：** `read`、`write`、`edit` 和 `bash` 需要本地文件系统或进程访问，且后三者可能已产生无法从 durable state 推断的外部效果。

**决策：** 本地工具实现置于 `integrations.local_tools`，仅以 runtime 的 `AgentTool` 协议注册。`read` 标记为 `safe`；`write`、`edit` 与 `bash` 标记为 `never`。文件修改按 resolved file path 通过共享队列串行化。工具结果可携带 JSON `details`（read 分页/图片、edit diff/patch、bash 截断日志路径），并随 tool-result entry 原子结算。

**后果：** 在 tool effect intent 之后发生崩溃时，恢复会重放 read，但绝不自动重放写、编辑或 shell 命令；它们会按既有规则留下 outcome-unknown 工具结果。文件队列只定义进程内顺序，不能把普通文件写入升级为原子替换或 exactly-once。

### ADR-013：L0 是冻结的 Session trace archive，而非当前上下文的副本

Session entry tree 是已结算对话的权威来源，但 compaction、navigation、fork、删除和替换式 operation state 使其不能被后台 worker 延迟地当作“当前轨迹”读取。terminal settlement 因而冻结 branch entry IDs/hash，并以 outbox 异步 materialize 不可变 L0 archive；需要 effect/retry 级审计时，额外以 append-only TraceRecord 保存。此选择避免丢失原始历史，也避免将瞬态 event 或可变 checkpoint 错当完整事实。

### ADR-014：后台资产 worker 的调度与生命周期由持久状态驱动

**背景：** 阶段 10 需要延迟执行（L1 成功后延迟触发 L2）、失败退避重试和 outbox 重扫，但现有运行时只有进程内 `asyncio` 原语。当前 `RetryPolicy.not_before` 只被写入、从没有任何组件在到期后唤醒它。同时 `MemoryRuntime`/`SkillEvolutionRuntime` 没有明确的启动/关闭语义，未被 `close` 的后台任务会在事件循环结束或被丢弃时静默消失，留下 `running` 状态的 job 和已过期的 lease。

**决策：** 所有延迟与重试状态（`not_before`、job 状态、attempt）必须与 job 在**同一事务**持久化；进程内 timer 只是唤醒优化，不是事实来源。`PromotionScheduler` 是唯一的时间驱动者，接受可注入 clock 与等待原语，使测试可用假时钟瞬时推进而不依赖真实时间。`start()` 重新武装未完成 job：`not_before` 已过则立即领取，未到则挂起 timer；`aclose()` 停止接纳新 job，等待在途 job 收敛到 durable 状态后返回，不得在取消路径上留下半个写入。`Harness.close()` 必须级联关闭两个 runtime。scheduler 不提供互斥保证——跨进程并发仍由既有的 lease compare-and-set 裁决。

**后果：** 延迟语义在进程重启后不丢失，且延迟可配置为 0 以获得一个无时钟依赖的最小实现。代价是每次调度需要一次存储读取；允许用内存索引加速，但该索引必须能从 durable 状态完整重建，不得成为唯一事实来源。

### ADR-015：L0 archive 存增量、以 item watermark 消费

**背景：** ADR-013 规定了 terminal settlement 冻结 branch entry IDs 并 materialize 不可变 L0 archive，但没有定义 archive 的边界。若每个 operation 都保存它可见的完整 branch，共同前缀会被每个 operation 重复存储，总存储量随会话长度退化为 O(n²)，且单次 capture 的写入量随时间线性增长。反之若只保存“最后几条消息”，extractor 既没有背景，也无法正确表达 fork 前的历史。

**决策：** archive 是**投递单位**，`TraceItem` 是**消费单位**。archive 只保存 base tip 之后的增量 entries（base tip 取自 `OperationMeta.source_tip_id`，并同时出现在 terminal result 的 `from_tip_id`），另以 `parent_archive_id` 与最多 K 个 `ancestor_item_ids` 携带受限背景。`MemoryStore` 为每个 item 分配 scope 内单调递增的 `store_seq`，L1 的 watermark 是 `store_seq` 而不是 archive 边界，因此一个 archive 可以被部分消费而不丢失位置。重复 materialize 由 capture key 与 `(archive_id, source_entry_id)` 双重去重。

**后果：** 存储与写入量回到 O(n)，archive 可被部分消费，且 fork 或 navigation 之后 archive 仍精确对应该 operation 新增的 entries。背景必须由 L0 自身沿 archive 链解析，不能回读 Session。代价是 archive 之间存在引用关系：GC 必须保证被 watermark 或 supersedes 链引用的记录不被回收，且父 archive 缺失时要显式记录缺口而不是重建。

### ADR-016：资产投递必须先于 Session 物理删除

**背景：** 现有 `SQLiteSessionRepo.delete` 直接 unlink 数据库文件，会连同该 Session 的 entries、values 和 lists 一并销毁。而 capture outbox 本身是 Session 内的 entry，投递是异步的。“operation 结算 → 调用方删除 Session → dispatcher 尚未投递”因此会永久丢失这段轨迹：dispatcher 随后会因 source entry 缺失进入 dead letter，但原始数据已不存在，重放也无从进行。

**决策：** `delete` 不再立即 unlink。它先写入 durable 删除标记，把该 Session 的未送达 outbox 提升为高优先级投递，仅在所有 outbox 已 delivered（或人工判定为不可投递）后才执行 unlink。dispatcher 遇到 entry 缺失时**必须**进入可观测 dead letter，绝不能回读 Session 或用当前 branch 补齐。fork 或复制不受此约束：L0 archive 一经 materialize 即独立于 Session 生命周期。

**后果：** 删除成为异步且可观测的操作，语义从“文件立即消失”变为“标记删除并排空投递”。若投递持续失败，删除会停留在 pending 状态并需要人工介入——这是有意的选择：宁可暴露一个未完成的删除，也不要静默丢弃无法重建的历史。

### ADR-017：Web 观察通过应用层读模型，effect 耗时必须持久化

**背景：** 阶段 9 的既有 RPC 与远程订阅可以驱动实时界面，但 event 是 best-effort 投影，不能在断线或重启后重建完整轨迹。现有 usage ledger 也没有稳定的 operation/call 查询关系，无法可靠回答逐 turn token 和 LLM/工具耗时。

**决策：** Web UI 位于核心外的应用适配层，以受权 session catalog 定位一库一 Session；新增只读 trace/memory facade 而不将 SQL 或 storage 私有对象暴露给 HTTP。每个 LLM/tool effect attempt 追加 durable span，其开始与 intent 对齐，结束与 outcome、operation state、usage 一起原子结算。L1--L3 观察按认证主体映射的 `MemoryScope` 查询。完整接口、迁移和验收见 [Web UI 实施计划](web-ui-implementation-plan.md)。

**后果：** UI 能在刷新、重启和崩溃恢复后显示可审计的历史；未记录 span 的旧 Session 显式显示未知数据。系统新增 catalog、查询 DTO 和 append-only 观测数据，但保持 Web 框架、连接状态和项目路径配置不进入 domain/runtime。

### ADR-018：L0--L2 按 repository 隔离，L3 为本地全局 doctrine

**背景：** 本 harness 的目标部署是一个人以同一 agent 在多个仓库工作。旧的 `(team_id, agent_id, user_id)` scope 既没有本地身份提供者支撑，也不能阻止仓库专属事实、路径和任务跨仓库召回；反过来，稳定的工作原则与偏好应能跨仓库复用。

**决策：** `MemoryScope` 的公开归属字段改为稳定 `repository_id`。L0 archive、L1 atomic memory、L2 work scene、其索引、水位线、job 与 audit 均只按 repository ID 过滤。L3 采用一个保留的全局 scope：任何仓库召回同一 doctrine，L3 job 汇集全部仓库的 current L2 场景再决定是否更新。旧 SQLite 的三元组物理列暂作为兼容存储键承载 repository ID（其余两列固定为空）；由于旧数据不含 repository 身份，迁移不得臆测归属，旧调用可通过兼容构造器排空/导出后再显式重归档。

**后果：** 仓库知识不会在 L0--L2 之间泄漏，L3 仍能形成跨仓库一致的个人工作准则。该模型不提供多用户或团队 ACL；若未来需要，必须引入独立 owner/ACL 维度，而不能复用 repository ID。

### ADR-019：Code memory 以冻结工具证据和代码词元提升可用性

**背景：** coding Agent 的关键经验经常附着在文件路径、符号、测试/构建 outcome 与工具调用上。只把原始对话交给抽取模型会把长工具输出当作噪声，也容易将 assistant 的计划误写成已验证事实；按空白切词还会漏掉 `src/module.py`、`foo_bar` 等代码查询。

**决策：** L1 extractor 从已经脱敏的冻结 L0 生成有限 CodingEvidence：repository ID、路径和带 source entry ID 的工具 outcome，并带固定的 code-memory 提取契约。L1 FTS 索引额外纳入稳定 artifact/path/symbol 元数据；召回把 query 与 context summary 中的路径、标识符拆词，并保留原始 content 作为展示内容。ContextAssembler 分层投影 global doctrine、repository context、code memory 与 trace evidence，并强制声明它们不是当前 checkout 的真相。

**后果：** 代码相关的事实、资产与验证结果更容易被正确沉淀和命中，且 Agent 被提醒重新验证。CodeGraph、工作区扫描或自动执行命令不进入 memory runtime；它们如需加入，必须作为独立、受权限约束的 tool/integration。

### ADR-020：Skill worker 等待同一 L0 archive

**背景：** terminal settlement 同时写入 memory 和 Skill capture outbox，但二者的 dispatcher 没有顺序保证。若 Skill worker 回读 Session entries，就会绕过 L0 的冻结与去重语义。

**决策：** Skill outbox 保持 pending，直到 `MemoryRuntime` 已按同一冻结 key materialize `SessionTraceArchive`。Skill buffer 仅追加该 L0 archive；SQLite 在一个 transaction 内更新 `(scope, session)` 计数，并在工具调用、字节或 oversize 阈值触发时写入 immutable archive 与 extraction job。

**后果：** Skill 不会从可变 Session 回读，memory 暂未投递时只会延迟 Skill Review，不影响用户 operation。

## 10. 首个可执行里程碑

第一个编码里程碑仅实现阶段 0–3：纯领域 DTO、storage/session 协议、内存后端、entry tree/branch projection、lane operation admission、snapshot 和结果查询。此里程碑不调用 DeepSeek、不执行工具，但必须已经具备“先持久化 operation、后由 Drive 领取”的恢复基础。

阶段 4 开始前需要冻结：entry/usage/value/list 的序列化格式、value 地址命名、operation state schema、公开错误码和 conformance fixture 格式。任何破坏这些格式的修改必须附带迁移和恢复测试。
