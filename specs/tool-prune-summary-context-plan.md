# 工具裁剪优先的上下文压缩实施计划

状态：已实现（2026-11-08）。新策略已作为 library/runtime 与部署默认值，旧策略完整保留。实现与验证记录见第 9 节。

## 1. 目标与双策略并存

新增并默认采用 `tool_prune_summary_v1` 策略：达到压力阈值后，先裁剪大工具结果，重新计量；仍达到阈值才调用 LLM 摘要。默认总上下文窗口改为 **1,000,000 tokens**（十进制 1M，不是 1,048,576）。移除新策略路径中的 history snip、micro-clear 和 collapse/global 双层选择，不在摘要前直接丢弃旧对话。

本计划新增独立策略，并将默认选择切换为 `tool_prune_summary_v1`；不删除、改写或停用旧方案。旧 [短期上下文管理计划](short-term-context-management-implementation-plan.md) 继续约束 `layered_v1` 的行为；原始历史不可变、依赖边界、effect 协议和恢复约束对两套方案同时有效。已有已接纳的 intent 按原格式恢复，不受默认策略变更影响。

两套策略均必须完整可用：

- `layered_v1`：保留现有 hard trim → snip → microcompact → collapse/global 流程、相关开关、显式压缩行为及恢复逻辑。默认窗口仍为旧方案的 128,000，已有显式配置优先。
- `tool_prune_summary_v1`：新增工具裁剪 → LLM 摘要流程，保护原文保留范围，默认窗口为 1,000,000；未指定 strategy 时选择此方案。

通过 `PRALE_CONTEXT_STRATEGY=layered_v1` 或 library 配置可显式选回旧方案。domain 算法和 runtime 调度按策略分派，只共享无策略语义差异的公共能力；不能通过删除旧实现或将旧策略名称映射到新算法完成接入。配置采用“先选择策略，再解析该策略缺省值”，未显式指定窗口时不能把新方案的 1M 默认泄漏给旧方案。

## 2. 参考实现与采用范围

参考 `/root/vibe/dsh/deepseek-harness` 的以下源码：

- `packages/compaction/compaction-basic/src/config.ts`：默认触发比例 0.8、headroom 65,536、近期保留比例 0.16；压力预算同时受窗口比例和输出预留约束。
- `packages/compaction/compaction-basic/src/index.ts`：先判断压力，执行工具剪枝，重新计量，再选择摘要范围。
- `packages/compaction/compaction-tool-result-pruner/src/config.ts`、`index.ts`：超过 8,192 个 Unicode 字符的工具文本，保留头 4,096、尾 1,024，中间换成标记；保留非文本块、结果身份及错误属性。
- `packages/compaction/compaction-basic/src/region.ts`：按 token 预算保留近期尾部，边界不能拆开工具调用与结果。

采用上述策略，但按用户要求增加更严格的保护：先确定原文保留范围，该范围内的工具调用和结果不参与裁剪。不移植 Cordis、surface replacement 事件或其日志锁。PRALE 继续使用 entry tree、operation state、effect span 和原子 settlement。首版不新增图片卸载、独立摘要 provider、模型路由策略表、provider 溢出自动重试或缓存编辑能力。

## 3. 默认预算与配置

| 参数 | 默认值 / 规则 |
|---|---|
| strategy | `tool_prune_summary_v1` |
| context_window_tokens | 1,000,000 |
| reserved_output_tokens | 20,000 |
| threshold_ratio | 0.3 |
| headroom_tokens | 65,536 |
| trigger_tokens | `floor(min(window × ratio, window - reserved_output - headroom))` = **300,000** |
| hard_margin_tokens | 3,000 |
| hard_limit_tokens | `window - reserved_output - hard_margin` = **977,000** |
| retain_ratio | 0.16 |
| retain_tokens | `floor((window - reserved_output) × retain_ratio)` = **156,800** |
| tool_prune_threshold_chars | 8,192 |
| tool_prune_head_chars / tail_chars | 4,096 / 1,024 |
| max_summary_retries | 1 次额外重试，独立于旧策略默认值 |

1M 是总窗口，300,000 是默认压缩触发点；不等待窗口用满。计量达到阈值（`>=`）即触发，裁剪后严格低于阈值才跳过摘要。输出预留和固定上下文实际占用分别计量，避免重复扣除 system 预算。

继续以 `ceil(UTF-8 JSON bytes / 3)` 为默认确定性估算，报告 estimator ID/version；这是估算值，不声称等于 provider tokenizer。将普通请求与摘要请求的消息、工具定义纳入统一计量；adapter 额外开销通过中立预算接口预留，不引入 SDK 依赖。

`ContextManagementConfig` 增加策略和上述参数；`Settings`、`Harness.open()`、子 agent 的配置传递、部署示例和配置展示同步更新。新增 `PRALE_CONTEXT_STRATEGY`、`PRALE_CONTEXT_THRESHOLD_RATIO`、`PRALE_CONTEXT_HEADROOM_TOKENS`、`PRALE_CONTEXT_RETAIN_RATIO` 和 `PRALE_CONTEXT_TOOL_PRUNE_*`。现有窗口环境变量保留，默认改为 1000000；显式配置继续优先。

旧 snip/micro/collapse 开关继续由 `layered_v1` 解析并生效；新策略不使用这些开关，显式混配时报清晰配置错误并指出 `layered_v1` 选项，不静默忽略。既有部署选回旧方案后，原配置不需要改名或删除。关闭 context management 时禁用自动裁剪和摘要，仍执行所选策略的硬预算检查。未知窗口按所选策略处理；新策略禁用压力压缩，保留明确的预算不可用诊断。校验比例、预留、保留预算及头尾加标记长度，拒绝不可能满足的配置。

## 4. 请求处理流程

1. 从当前 branch 投影，执行 `transform_context`；hook 继续收到完整基础投影。
2. 将候选会话消息与 memory、skill listing、hook 输出、skill loadout、system prompt、tool schemas 组成完整请求，执行既有 hooks 顺序。计量覆盖最终实际输入，不能只量会话后再漏掉注入内容。
3. 未达到触发点：保持工具输出和所有会话消息，不提前裁剪。
4. 达到触发点：先基于未裁剪的会话确定并冻结原文保留范围（见第 5 节），再仅对该范围之外、可归属到会话工具结果的文本执行 head + marker + tail 裁剪，一次处理所有符合条件的超限结果。原文保留范围内的 assistant 工具调用及其所有结果完整保留，即使单条超过工具裁剪上限也不能裁剪。范围外结果保留 tool_call_id、is_error、terminate、其他 metadata 和内容块顺序，不删除整条结果。范围外错误结果保留头尾和错误属性，不清空。非文本块不在本阶段裁剪。
5. 重新计量，低于触发点则冻结最终 generation intent；否则对冻结的原文保留范围之前的旧会话前缀生成摘要。不得根据裁剪后变小的消息重新选择尾部，将已裁剪结果纳入原文保留范围。system、外部 hook 注入、memory/skill 内容不作为可删除会话范围。
6. 摘要成功后追加 `compaction` entry，保存摘要覆盖 IDs、保留 IDs、策略版本及裁剪引用；原子结算 usage/span/tip/state，回到 `assistant.ready`。后续投影为最新摘要、保留尾部及新消息。
7. 重新组装并计量；只有严格缩小且满足预算才继续。每次 generation 准备最多两次成功摘要，次数持久化，超过即明确失败，禁止在 `assistant.ready` 中无限摘要。非会话注入本身超限、无合法可压缩前缀或受保护内容过大时返回 `ContextBudgetExceeded`。

实现时将上下文准备拆为“会话来源映射、请求组装、纯压缩规划、intent 提交”，避免在裁剪后重复执行有副作用的注入记账。hooks 仍要求幂等；无法追踪来源的 hook 新消息不自动删除或裁剪。摘要 intent 冻结选区及实际摘要输入；恢复不能重新运行 hooks 改写该 attempt。

## 5. 摘要范围和质量

当前用户请求和 system 消息作为独立原文锚点保留，不因保护用户请求就保护它之后的所有工具步骤；同一用户轮次内较早、已闭合的工具片段仍可裁剪或摘要，避免长任务无法释放上下文。

在任何工具裁剪之前，从最近消息向前按未裁剪文本累计至少 retain_tokens，边界向前扩展至完整 assistant tool-call/result fragment；系统消息和当前用户请求必须保护。冻结该原文保留范围及其 IDs，工具裁剪、摘要选区与重试共享同一边界。保护覆盖调用名称、参数和所有结果正文及内容块，不只是调用/结果的配对身份。尾部预算是目标，不允许通过截断 fragment 强行满足。单个过大 fragment 可使尾部超预算，无法保留并有效摘要时明确失败，不得以工具硬裁剪作为兜底。

后续再次压缩时，原文保留范围仍按原始 entry 正文计量；若历史裁剪记录对应的消息因配置变化或 navigation 等重新进入该范围，投影必须从原始 entry 恢复完整内容，保护规则优先于旧裁剪记录。该例外必须记入请求报告，不能将已裁剪视图称作原文。

摘要输入只包含待覆盖前缀（包含已有摘要），使用已裁剪的工具视图；不重复摘要保留尾部。要求保留目标、约束、决策、路径、已完成工作、工具发现、待办及未解决问题，不调用工具；剥离可选 analysis，拒绝空摘要和不产生有效缩减的结果。摘要调用本身必须满足其输入加输出预算；不得通过无提示删除旧对话使摘要请求可发送。重试必须改变实际输入预算或要求更短输出并记录原因，不能只追加“已截断”而没有真实截断。

显式 `Lane.compact()` 保持公开入口和 `before_compaction` hook；新策略使用同一合法选区及摘要校验，允许阈值以下主动摘要，不再固定保留四个 entry。旧策略保留原行为。

## 6. 持久化、恢复与兼容

工具裁剪决策采用 branch 可达的 append-only `custom` entry（payload kind 为 `context_tool_prune`），不覆盖原 message。记录 format_version、strategy_version、source_entry_id、tool_call_id、source hash、头尾预算、前后估算和稳定裁剪文本；投影只应用当前 branch 祖先链内匹配原始 ID/hash 且不属于本次原文保留范围的决策。重复决策幂等，不影响分叉之前或其他分支；navigation/fork 后根据所选祖先链恢复对应视图，原文保护优先。

纯裁剪与下一 generation/summary intent 在同一事务提交，包括 tip、reduction audit 和完整状态。裁剪已提交但摘要失败时保留裁剪进展；摘要失败不发布伪摘要。来源无法归属的结果只冻结在本次 intent，不写成永久 branch 决策。

自动摘要沿用 `context.global_compaction.effect_pending`，新 intent 增加 format/strategy version、冻结配置、source tip、覆盖/保留 IDs、输入、attempt 和循环上限。普通 generation intent 与摘要 intent 均记录原文保留 IDs 和边界，恢复不得重新计算并缩小保护范围。每次调用先写 intent/span；成功将摘要 entry、usage、span outcome、tip、下一 state 同事务提交。失败 attempt 先结算再开始下一 attempt；取消遵守 effect gate 和现有请求取消协议。

中断后的未结算摘要先收束 `unknown/interrupted`，不猜测远端结果、不伪造 usage；恢复重试使用冻结输入及新 attempt/span，受持久重试上限约束，不将旧 attempt 冒充未执行。已完成的 generation intent 原样执行，不能受新默认值影响。

旧 `compaction`、`context_collapse`、`branch_summary` payload 继续可读；无策略字段的旧 pending intent 走现有恢复路径。新 custom JSON 使用既有 entries 存储，无需 SQLite 表迁移，但必须验证历史 session 重开兼容。公开配置新增字段均有默认值，旧导入路径保持有效。

## 7. 实施步骤与验收

1. **先补测试与纯算法**：先将现有行为固定为 `layered_v1` 回归基线，再新增策略分派、配置、统一预算、头尾裁剪、来源映射、工具配对选区和摘要进展校验；保留旧实现与旧策略测试，不将旧测试改成只验证新策略。
2. **持久投影**：实现裁剪记录及幂等、branch/navigation/fork 投影，memory/SQLite 运行同一 conformance suite。
3. **runtime 接入**：最终请求计量、两阶段压缩、摘要原子结算、失败/取消/重试、旧状态兼容和有界循环。
4. **配置与说明**：默认 1M、新旧策略切换、部署示例、子 agent 继承和 telemetry。报告策略、阈值、压缩前后估算、裁剪数量、摘要 attempt、来源 hash，不额外上传原始工具正文。
5. **验证交付**：受影响 pytest、ruff check、ruff format --check、项目 mypy；同步本文实施状态和主计划 ADR。

验收必须覆盖：

- 未指定策略时实际执行新方案且默认 1M；显式选择 `layered_v1` 时实际执行原流程且保留旧默认预算；两套策略的显式窗口覆盖、开关、library/部署/子 agent 传递分别测试。
- 旧 hard trim、snip、microcompact、collapse/global、手动 compact 和恢复测试继续通过；新方案的保护规则不意外改变旧方案行为。切换默认不改变已冻结 intent，策略切换后的新请求按明确选择执行。
- 阈值前原样；等于阈值触发；仅裁剪足够时零摘要调用；裁剪不足时摘要；无大工具时直接摘要。
- 8,192 字符边界、CJK/emoji、多文本块和非文本块、错误/terminate 属性、完整工具配对和巨大单轮。
- 原文保留范围内超大的工具调用参数、结果正文及所有内容块原样发送；范围外才允许裁剪；边界向前扩展所纳入的完整 fragment 同样受保护；裁剪后不重新缩小保护范围。
- 受保护工具结果本身过大时明确失败，不退回裁剪；历史已裁剪结果重新进入保护范围时恢复原文；intent/retry/recovery 保持冻结的保护边界。
- memory、skills、system、tool schemas 和 hooks 全部计入；非会话内容超限明确失败；无效摘要重试和摘要不缩小均有界终止。
- 保护范围之外的持久裁剪下轮仍生效；原始 entry/L0 仍保留原文；分支互不污染；旧 session 和两种旧 pending summary state 可恢复。
- 每个新增持久边界覆盖事务前后；摘要覆盖 intent 后、effect 后、settlement 前的真实进程中断。验证无重复 settlement、无伪成功、span/usage/tip 一致，新 attempt 可辨且重试有界。
- 取消期间不再开启新 effect；重开不会因默认窗口或配置变化改写冻结输入。

## 8. ADR：压力触发的工具剪枝与单层摘要

**背景：** 现有自动路径在摘要之前 snip 旧消息，再 micro-clear，并将 collapse/global 分为两个入口。用户要求参考 deepseek-harness 简化流程并将总窗口提高至 1M。

**决策：** 默认采用 1,000,000 总窗口、30% 压力触发、head/tail 工具裁剪及单层前缀摘要。裁剪前按原文 token 预算确定并冻结近期完整 fragment，范围内工具调用及结果不得裁剪，保护优先于历史裁剪投影。保留旧策略显式选项和旧持久格式读取。裁剪决策采用 branch 内 append-only 记录，LLM 使用 durable intent → effect → atomic settlement。

**后果：** 阈值前保留完整上下文；达到阈值后优先节省模型调用，摘要不会遗漏被 snip 的旧对话。新增来源映射、裁剪投影和兼容测试；默认容量变更并不证明部署模型具有该容量，部署仍可显式设置实际窗口。新策略已接入运行时；实际窗口可由部署配置覆盖。

## 9. 实现与验证记录

- `domain/context_management.py` 保留旧算法并增加策略分派、策略专属缺省预算与校验；`domain/tool_prune.py` 实现原文保护边界、Unicode 头尾裁剪、富内容聚合及 branch 内裁剪记录投影。
- `runtime/drive.py` 在新策略下计量完整最终请求及工具定义，原子提交裁剪和生成/摘要 intent；自动摘要及手动压缩复用合法选区，失败重试、取消和恢复均结算 span。无有效缩减时明确失败，自动摘要循环有持久上限。
- 已提交裁剪按原始 entry ID/hash 应用；配置变化导致结果重新进入保护区时恢复原文，并在请求报告记录恢复 IDs。摘要重试冻结配置、输入与保留 IDs，未知摘要不写占位摘要。
- 旧单元和集成断言保持不变，仅显式选择 `layered_v1`；新增单元、memory/SQLite conformance、集成及真实子进程崩溃测试。
- 单位为确定性 UTF-8 JSON 估算 token；未接入 provider tokenizer、图片卸载和 provider 溢出自动恢复。无法归属到原始会话的 hook 内容不自动裁剪/摘要，无法满足预算时显式失败。
- 项目 mypy 仍有基线已有的 20 项错误；与 HEAD 源码隔离比较，错误逐项相同，新改动未新增项目类型错误。
- 最终验证：unit/conformance/integration/crash_recovery 共 **756 passed、1 skipped**；受影响 Python 文件的 Ruff、格式检查和 `git diff --check` 通过。
