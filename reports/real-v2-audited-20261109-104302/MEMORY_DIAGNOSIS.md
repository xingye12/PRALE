# 本次评测的 dead-letter 与 L2 诊断

检查对象：`real-v2-audited-20261109-104302` 的两个 warm 状态目录。
全部数据库以只读方式读取；未重试失败作业、未修改状态、未再次调用模型。

结论：有实际落盘、格式/摘要校验通过的 L2；但 L2 生产、完成记账和检索链路存在明显问题，不能把这轮 warm 解释为记忆正常发挥后的对照实验。

## 14 个 dead-letter 是什么

这是 **14 个晋升作业的最终失败状态**，不是 14 个评测任务失败，也不是 14 次 API 调用。

| 最终错误 | 基础 warm | 进阶 warm | 层级 | 含义 |
|---|---:|---:|---|---|
| schema | 4 | 4 | 全为 L2 | audit 均记为 `invalid work-scene markdown`。场景正文要求不超过 1500 字符且含九个固定中文栏目；违反任意条件即抛 ValueError，直接 dead-letter。日志未保存无效候选正文，不能再区分究竟是超长还是缺栏目。 |
| TimeoutError | 3 | 1 | L1 两个、L2 两个 | 该作业最后一次尝试为超时，达到默认 3 次尝试上限。provider 配置的请求超时为 60 秒；audit 只保存异常类别，不能精确追溯哪个请求阶段超时或断言前三次全是同一种错误。 |
| PromotionConflict | 2 | 0 | 全为 L2 | 写场景的版本/文件预期或合并条件不满足，3 次尝试后终止。audit 只存类名，缺少具体冲突对象与候选，不能认定是外部并发修改。 |
| 合计 | 9 | 5 | L1=2，L2=12 | L3 没有 dead-letter。 |

另外一些已完成作业的 error_class 仍为 TimeoutError：它们是先失败后成功，`complete_job` 没清空旧错误字段；不应再计入 dead-letter。

评测适配器 `_promote` 用未来时间 `10**15` 领取到期任务，因此还会立刻领取重试/延迟任务，绕过真实时间下的退避与 L2 最短间隔。这是本地强制排空的行为，不等同生产调度节奏。

## 到底生成了多少有效 L2

L2/L3 的权威正文在 `memory-assets/` 的 Markdown 中，SQLite 主要保存流水线状态；`work_scene_memories`/`operating_doctrines` 旧表为空不表示没有产物。

| 指标 | 基础 warm | 进阶 warm |
|---|---:|---:|
| active L1 | 41 | 28 |
| 当前可读 L2 场景 | 10 | 1 |
| dormant L2 场景 | 0 | 4 |
| 当前 L3 | 1 份，v1 | 1 份，v2 |
| memory_read_scene 调用 | 19 | 3 |
| 成功返回正文 | 11 | 0 |
| 返回错误 | 8 | 3 |

全部 15 份当前/休眠场景都能解析、通过现有九栏目和长度校验，正文 content_hash 一致；已填写的 L1 来源 ID 全部存在。**这是结构与存储有效，不是已证明每句话正确或能提升任务通过率。**

基础 L2 主要涵盖扩展信任、OAuth BOM、会话 cwd 迁移、VM 跨 realm 断言和回归负向对照。例如 `coding-agent/extension-trust-bootstrap` 已更新到 v5。存在多个同主题但不同 scenario_key 的场景，去重整合不充分；未看到工具恢复主题的当前场景。

进阶当前 L2 为 `agent-harness-effect-execution-recovery`，归纳工具参数权威、gate 准入和恢复完成顺序；另外四个旧场景已经合并为 dormant。没有覆盖之后的资源一致性和会话完整性主题。合并场景的 `l1_ids=[]`，直接来源关联不完整；正文还混有早期 `open regression` 与后续 verified 描述，需要进一步整理。

## 关键问题：作业失败不等于没有写入

`MemoryRuntime._run_job` 对 L2 候选逐条 `write_scene`；全部写完才推进 L2 watermark、完成 job。后续候选失败时，已写文件不会回滚。

基础组有 16 次 `l2_file_written`，但 L2 作业只有 1 个 completed、8 个 dead-letter。日志显示多个最终失败的处理批次中已经发生场景写入。结果是：

- 已经有 10 个 current 场景，部分场景来源水位达到 236；
- L2 的“完整完成水位”仍停在 52，L1 为 236；
- L3 仍停在早期 L2 水位 52，后续部分写入没有正常触发新一轮 L3；
- 重试会重新处理旧范围，而不是从候选级别的已结算状态恢复，存在重复创建、版本冲突和额外开销风险。

进阶 L1 水位 131、L2 完成水位 47，也存在后续晋升没有正常推进的情况。

## 为什么读取失败

从 L0 trace 中按 source_entry_id 去重，关联 assistant tool_call_id 与实际 tool reply，而不是仅统计 adapter 的工具调用名：

- 基础组：11 次确实读到正文，8 次失败；失败中包括把 content_hash 当成 scene_id，以及使用不存在的 ID。
- 进阶组：3 次都请求同一个已合并为 dormant 的旧场景，返回 `scene is not available in the current repository scope`。
- `read_l2_index` 返回包含 dormant 项的完整索引；自动注入提示仅说按 scene_id 读取，`read_scene` 却只接受 current 项。这形成了可见索引与可读集合不一致的问题，不能将“三次调用”解释为“三次成功利用 L2”。

因此，“有产物”和“后续任务成功取用合适产物”是两回事。本轮基础组有成功取用证据；进阶组没有成功取回 L2 正文的证据，但有自动注入 L3/索引的机制，不能因此说完全没有记忆上下文。


