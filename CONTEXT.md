# Agent Harness

一个以 Session 为可恢复执行边界的持久化 Agent 运行时；长期资产在 Session 之外管理，并通过受控投影参与一次 Drive。

## Runtime

**Session**:
一次对话及其可恢复运行状态的唯一写拥有者。它不等同于用户、仓库或跨会话知识库。
_Avoid_: Memory, workspace

**Drive**:
一个已持久化 Operation 在进程内的执行器；可在进程重启后重建，且本身不是权威状态。
_Avoid_: Run, worker

**Operation**:
Lane 中一个可恢复、可终止的工作单元，拥有不可变元数据和可整体替换的状态。
_Avoid_: Task, job

## Long-lived assets

**Memory scope**:
限定 L0--L2 长期记忆可见性和写入归属的仓库范围，由稳定的 `repository_id` 构成。L3 不属于某一仓库，而是该本地 agent 的单一全局 doctrine。
_Avoid_: Team memory, user memory, session memory

**Repository memory / global doctrine**:
L0、L1 与 L2 只可在其 `repository_id` 内被读取、晋升、合并或回收；L3 从全部仓库的 current L2 场景提炼，并可被每个仓库召回。
_Avoid_: Cross-repository L1, repository-specific L3

**Coding evidence**:
从冻结 L0 的消息与工具结果派生出的、带 source entry ID 的紧凑视图，包含仓库相对路径和工具 outcome。它辅助 L1 抽取判断已验证结果，但不替代 L0，也不使 Agent 跳过对当前 checkout 的验证。
_Avoid_: Source dump, executable instruction, current workspace truth

**Atomic memory**:
可独立判断、可追溯到 L0 来源且可被单独召回的长期记忆单元。
_Avoid_: Note, summary

**Work scene memory**:
围绕一个稳定工作场景组织的、可人工查看和维护的知识块；承载“某项目当前处于什么阶段、有哪些决策、约束与待办”的组合语境。
_Avoid_: Chat summary, project memory, scenario memory

**Session trace archive**:
在 Operation terminal 时派生、只包含该 Operation 新增 entry 的不可变 L0 记录。它以 base tip 与 terminal tip 界定增量，并以受限祖先链携带背景；它不是 dispatch 时读取的当前上下文，也不是完整 branch 的副本。
_Avoid_: Current transcript, conversation copy

**Terminal tip / base tip**:
一次 Operation 结算时写入 lane 的 `tip_id`，以及同一 Operation 启动时的 `source_tip_id`。二者都从已持久化的 operation result 读回，无需重新扫描 Session；其差集定义了 L0 增量。
_Avoid_: Current branch, latest message

**Promotion job**:
把 L0 增量推进到 L1、L2 或 L3 的可恢复后台工作单元；按 scope 与 stage 去重，以持久化的输入 watermark 和 `not_before` 驱动，因此重启后不会丢失延迟或重复消费。
_Avoid_: Task, worker, timer

**Trace record**:
在同一 Session mutation 中追加的、已脱敏执行审计事件，例如 effect intent、retry 或工具 outcome。
_Avoid_: Event, checkpoint

**Skill**:
带版本的可复用操作方法，由 `SKILL.md` 及可选受版本控制资源组成；它描述“如何做”，而非事实或偏好。
_Avoid_: Memory, prompt snippet

**Skill candidate**:
从已归档的成功经验中提出、但尚未修改任何 Skill 的审计记录。
_Avoid_: Skill, draft skill
