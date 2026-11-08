# Session 任务规划

提供 task_create/get/update/list 和 Harness.tasks facade。任务 DTO 不可变，字段为 id、subject、description、activeForm、status、owner、metadata、blocks、blockedBy、unfinished_blockers。Session 内编号递增不复用。

pending/in_progress/completed 为状态，deleted 为更新操作。仅当前置均 completed 时可开始或完成；重新打开不能阻塞执行中或完成的下游。拒绝未知、自身和循环依赖。metadata 按键合并，null 删除键。删除记录 tombstone、移除全部关联依赖。所有操作在 Session mutation 内读取最新图并校验，失败不写入。

values 的 session/tasks 保存版本化图、编号和快照版本，session/tasks/audit list 追加完整修改审计。原生控制 intent 冻结参数，结算事务计算任务结果并同时提交图、审计、工具 entry、span 和下一状态；事务前退出可重试，事务后恢复消费结果。facade 共用校验和写入构造。

task_list 按数字 ID 排序，offset 分页，默认 50、上限 100，支持 status 筛选。概览优先执行中、可开始、被阻塞任务，包含负责人及未完成前置，限制约 2000 估算 tokens；冻结版本及实际消息到 intent，不进入历史或摘要。工具权限由注册及角色交集决定。

验收覆盖 memory/SQLite 原子性、编号、依赖、Session 隔离；runtime 四工具、跨 lane、权限和概览；真实进程事务前后恢复及冻结 intent。
