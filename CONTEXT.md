# Agent Harness

一个以 Session 为可恢复执行边界的持久化 Agent 运行时；长期资产在 Session 之外管理，并通过受控投影参与一次 Drive。

## Runtime

**Session**:
一次对话及其可恢复运行状态的唯一写拥有者。它不等同于用户、团队或跨会话知识库。
_Avoid_: Memory, workspace

**Drive**:
一个已持久化 Operation 在进程内的执行器；可在进程重启后重建，且本身不是权威状态。
_Avoid_: Run, worker

**Operation**:
Lane 中一个可恢复、可终止的工作单元，拥有不可变元数据和可整体替换的状态。
_Avoid_: Task, job

## Long-lived assets

**Memory scope**:
限定长期记忆可见性和写入归属的身份范围，由 `team_id`、`agent_id`、`user_id` 及可选 `task_id` 构成。它不由 `session_id` 单独定义。
_Avoid_: Global memory, session memory

**Atomic memory**:
可独立判断、可追溯到 L0 来源且可被单独召回的长期记忆单元。
_Avoid_: Note, summary

**Scenario memory**:
围绕一个稳定工作场景组织的、可人工查看和维护的知识块。
_Avoid_: Chat summary, project memory

**Session trace archive**:
在 Operation terminal 时由固定 branch tip 与 source IDs 派生的不可变 L0 快照。它不是 dispatch 时读取的当前上下文。
_Avoid_: Current transcript, conversation copy

**Trace record**:
在同一 Session mutation 中追加的、已脱敏执行审计事件，例如 effect intent、retry 或工具 outcome。
_Avoid_: Event, checkpoint

**Skill**:
带版本的可复用操作方法，由 `SKILL.md` 及可选受版本控制资源组成；它描述“如何做”，而非事实或偏好。
_Avoid_: Memory, prompt snippet

**Skill candidate**:
从已归档的成功经验中提出、但尚未修改任何 Skill 的审计记录。
_Avoid_: Skill, draft skill
