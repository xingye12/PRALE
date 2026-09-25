# Harness 实施规范

本目录的文档是 Python 版 pi harness 的设计与实施约束。修改本仓库代码、测试、迁移或本目录规范时，所有 agent 和开发者必须遵守本文件及 [pi-harness-implementation-plan.md](pi-harness-implementation-plan.md)。

## 工作范围

- 当前任务是构建 Python library/runtime，不是移植 pi CLI、TUI 或实验性 `pico3`；
- 以 `/root/vibe/CoLe/pi/packages/agent/docs/agent-harness-python-architecture.md` 为 Python 重构的主要行为规范；以 `docs/harness.md` 和 `src/harness/` 校验事务与边界语义；
- 不得为“尽快跑通”跳过 durable operation state、effect intent、原子 settlement、单 lane 串行化或崩溃恢复；
- 未被规格覆盖且会改变公开 API、持久化格式、恢复或副作用语义时，先更新实施方案中的 ADR，再写实现。

## 架构边界

- `domain/` 必须纯净：不能导入 Web 框架、数据库驱动、HTTP client、DeepSeek SDK 或 runtime；
- `runtime/` 编排状态机，只依赖 domain 和 storage/provider/tool 的协议；
- `storage/` 封装事务、序列、迁移和后端细节；SQLite SQL 不得泄漏到上层；
- `integrations/` 隔离 DeepSeek、shell/filesystem 工具和 telemetry；provider wire payload 不得穿透 adapter；
- `api/` 只暴露稳定 DTO、facade 和领域错误；HTTP/RPC/TUI 是后置适配器，不得成为核心依赖。

允许的依赖方向：`api → runtime → domain`、`storage → domain`、`integrations → api/domain`。出现反向依赖应先重构协议，而不是以循环导入解决。

## 持久化与状态机规则

- entries 和 usage ledger 只追加；value 可替换；list 仅追加或整体删除；
- 一次 Session transaction 内的 entry、usage、branch tip、lane state、operation state、队列修改必须原子提交；
- 每个 operation 持久化 immutable metadata、完整 state 和 terminal result；state 更新使用全量替换，不写 diff；
- 调用外部 LLM 或工具前必须写 effect intent；成功或失败 outcome 与下一状态必须原子落盘；
- `safe` 工具可以恢复重试，`never` 工具不得自动重放；未知结果必须明确收束；
- Session 只有一个写拥有者；同一 lane 同时最多一个 operation；同一 operation 同时最多一个 Drive；
- snapshot 和 event 是投影，不是权威数据；恢复只能依赖持久状态；
- 调用方断开只取消等待；只有 `request_abort` 才取消 operation。取消顺序为关闭 effect gate、持久化 `cancel_requested`、中止本地任务。

## 代码与 API 约定

- 使用 Python 3.12+、`asyncio` 和完整类型标注；公共 DTO 优先使用不可变 dataclass；
- 正常业务分支使用明确的 result/领域错误类型，如 `LaneBusy`、`NothingToCompact`、`UnknownTarget`；不要用字符串匹配异常；
- ID、时间、随机性和 I/O 必须通过可注入接口或 context 提供，确保测试可控；
- provider 适配器向 runtime 返回中立的流事件及已完成 assistant result；不能返回 SDK 原始对象；
- 并行工具可按完成顺序发事件，但写入的 tool-result entry 必须按 assistant 原始 tool-call 顺序；同一工作目录的写/edit 工具必须串行化；
- hook handler 不可直接写 Session。hook 必须幂等；`before_drive` fail-closed，`before_tool` 异常按 block，其余 handler 异常记录后 fail-open；
- 事件监听器异常必须隔离并记录，不得中断 operation。

## 测试与变更门槛

- 先写测试再实现：存储行为放 conformance suite，状态机行为放 integration，进程中断行为放 crash-recovery；
- 每个新增持久状态或 effect 边界，至少覆盖 intent 后、effect 后、settlement 前的中断；
- 每个 storage backend 都必须通过同一 conformance suite；memory backend 是最快的规范实现，SQLite 是生产实现；
- 每个 schema 变化必须新增前向 migration、迁移测试和兼容性说明；禁止隐式重建或丢弃现有 Session 数据；
- 提交前至少运行受影响的格式化、类型检查和测试；新增运行时行为时补充文档中的验收标准；
- 避免无关重排、批量格式化和破坏已有用户改动。发现工作树中不属于当前任务的变化时保留它们。

## 文档维护

- 影响边界、状态、持久化格式、错误语义或实施顺序的改动，必须同步更新 `pi-harness-implementation-plan.md`；
- 设计决策用“背景 / 决策 / 后果”追加 ADR，不能只在代码注释中留下隐含选择；
- 文档中的“必须”表示验收条件；“建议”表示可替换实现，但替换不得削弱可恢复性和原子性；
- 不要把 TypeScript 的文件组织、类型技巧或实验模块当作兼容性目标；兼容目标是用户可观察行为与本规范列出的不变量。
