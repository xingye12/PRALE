# Real-v2 进阶题：12 道跨文件行为修复任务

本题库独立于旧的 `../fixtures/`，不替换原有 12 题。复用同一个冻结 pi capsule：
`b45597504eeaba1f11a9920a1d1048c361ed4b8e`。标识为 `real-v2-advanced-v1`，
fixture revision 5、oracle version 4。题目、数据、行为断言均在本地运行；不使用 LLM judge。

完整的逐题构造、验收过程与审计修复见
[CONSTRUCTION_AND_TESTING.md](CONSTRUCTION_AND_TESTING.md)。该文档包含故障细节，面向维护者，不作为 Agent 输入。

## 题目

每题有 2–3 个需要实际修复的生产文件，而不是“改一个源码文件再加一个测试文件”。
每个主题仍按 learn → transfer → correction → retransfer 排列，方便同一运行器做 warm/cold 对照。
所有阶段独立从冻结源码创建工作区；每题的多个故障同时存在。

| 主题 | 阶段 | 事故与跨模块约束 | 源码文件数 |
|---|---|---|---|
| 资源一致性 | learn | 已信任状态污染新 bootstrap；显式拒绝失效；设置读取绕过信任 | 3 |
| 资源一致性 | transfer | 已记住的拒绝被默认策略覆盖；设置优先级反转；批准未到达最终加载 | 3 |
| 资源一致性 | correction | 允许仅本次批准；修复 resolver 不调用、信任切换不生效、误持久化许可 | 3 |
| 资源一致性 | retransfer | 无 UI 时拒绝；撤销必须同步清空缓存设置和项目扩展 | 3 |
| 会话完整性 | learn | BOM 解码与 OAuth/API-key 优先级冲突，保证迁移及输入保护 | 2 |
| 会话完整性 | transfer | 迁移写入路径与正常读取路径不一致，串联编码、文件搬迁和真实 reader | 2 |
| 会话完整性 | correction | 冲突不覆盖；非法 header 不得触发文件自动修复 | 2 |
| 会话完整性 | retransfer | 批次开头冲突不得中止后续工作，尾部无换行记录不得丢失 | 2 |
| 执行生命周期 | learn | 重放许可、持久参数、effect gate 准入必须一致 | 3 |
| 执行生命周期 | transfer | 区分 live/checkpoint 更新；异常保持错误；取消送达已开始的工具 | 3 |
| 执行生命周期 | correction | 安全重放允许执行；显式 false patch 生效；关闭取代等待中的取消 | 3 |
| 执行生命周期 | retransfer | 取消阻止重放；完成后拒绝迟到更新；关闭状态不可被 abort 重开 | 3 |

完整任务和文件路径见 [TASKSET.md](TASKSET.md)；机器清单见 [benchmark.json](benchmark.json)。
题目不泄露具体错误行或修复 diff，但公开行为要求和允许更改的模块范围。

## 执行方式

Python 3.12+ 和 Node 24 即可执行确定性验收，无需 npm 安装。Agent 的模型访问单独配置。
构建与本地验证不调用模型、不消耗模型费用：

```bash
python scripts/build_real_experience_advanced.py --check
python -m pytest tests/unit/test_real_experience_advanced.py
```

真实 Agent 运行复用原批量入口，仅切换 fixture 根目录：

```bash
python scripts/run_real_experience_batch.py \
  --capsule evals/experience-real-v2/capsules/pi-b455975/capsule.json \
  --fixtures evals/experience-real-v2/advanced/fixtures \
  --adapter prale --memory-mode warm \
  --state-dir .eval-state/advanced-warm-r1 \
  --output reports/advanced-warm-r1.json \
  --allow-host-execution
```

cold 使用 `--memory-mode cold` 以及独立的 state/output 路径。Claude Code 使用
`--adapter claude-code`。`--allow-host-execution` 是既有本地联调开关；正式实验应使用
原协议要求的容器隔离和模型出口策略。Node VM、临时目录和 cleared environment 不是 OS sandbox。

## 验收

每题交付修复源码、`.prale-eval/regression.mjs`、结果 JSON 与 `repair.md`。
公共 `subject.mjs` 仅提供通用模块加载，不包含源码入口映射、业务符号或场景专用 fake。Agent 自行选择模块和提供边界绑定，目标生产模块应调用其他
目标模块的真实实现：resolver → loader → SettingsManager、migration → text/path → reader、
recovery → executor/finalizer → gate。不会把待修复模块替换成正确的 fake。

验收依次要求：

1. 所有列出的生产文件都有更改，且没有越界改动或篡改公共辅助文件。
2. 隐藏跨模块行为契约在最终提交的独立副本上通过。
3. 提交的同一个回归脚本在修复副本上通过。
4. 每次只把一个目标文件恢复为原始故障版，该回归脚本必须分别触发断言失败。
5. 恢复全部原始故障后，该脚本仍然必须断言失败。

因此，仅覆盖一个文件的测试不够，只有测试文件/注释改动也不够。语法错误、导入失败、
普通运行异常、超时或打印成功均不能代替断言证据。每个条件使用新的工作区副本和 HOME，
Node 子进程上限 8 秒；控制器默认 oracle 上限 60 秒。输出包含每个文件的独立检测结果。

隐藏测试包含真假许可、缓存撤销、嵌套设置继承、数据冲突、重复执行、UTF-8 字符跨 1 MiB
读取边界、非换行尾记录、取消/关闭状态、迟到回调，以及用 Promise 屏障控制的执行/进度
完成顺序。正确性不依赖 wall clock、随机 ID、网络、真实数据库或人工评分。

语料测试不仅要求完整故障失败，还枚举每题的所有未修复文件子集：12 个健康状态和
68 个非空故障子集。另有逐文件回归校验、无效交付、等价修复和三个主题的完整 runner 流程测试。

## 范围

这些题目加强了跨文件调查与状态一致性要求，仍然属于人工构造的真实仓库回归。
checkpoint/store/transport 等外部边界使用受控 fake，未声称覆盖完整 pi 持久化后端或进程崩溃恢复。
题目难度与模型区分度需要真实运行后测量；本地语料自检不能证明长期记忆带来了增益。


## Revision 2 审计修复

本轮核对了全部 12 题，并修复了 namespace import 误判、缺失重放策略被默认成 safe、
并发辅助代码串状态、断言分类与提前退出、长诊断截断、Git index 隐藏修改，以及目录名泄露条件。
现在范围检查基于控制器在 Agent 启动前捕获的文件指纹和 Git 配置摘要；各回放条件使用同名随机工作区。
Migration 的目录枚举被明确排序，避免依赖宿主文件系统顺序。恢复准入覆盖 32 个策略/声明/取消组合，
另增加了字段继承、完整恢复链 gate 准入、失败后的迟到回调与额外变异测试。

完整复验为进阶题库 119 项，加原 real-v2 和相关 crossrepo 流程 68 项，合计 187 项通过。
详细问题、证据边界和运行方法见上面的维护者文档。请为 revision 5 使用新的 state/output 目录。

2026-11-09 补充验收审计见 [审计报告](../AUDIT_REPORT.md)，其中记录最新复验结果；上面的 187 项为 revision 2 历史记录。

当前 fixture revision 5：题面不列故障模块和修改数量，公共加载器也不含任务到源码的映射。
Agent 从 incident 自行探索生产代码及调用链，定位全部故障，并向通用 `createGraph` 提供模块路径、
边界 fake 和必要的私有入口 trailer。具体场景适配仅保留在工作区外的隐藏验收侧。
新 workspace 在注入故障后重建并统一时间戳，Git 索引不会保留故障文件的特殊修改时间。
隐藏 oracle、逐文件故障回放和回归检出要求保持原样。批量及单题 CLI 默认隐藏目标；
历史 revision 3/4 成绩需单独统计。
