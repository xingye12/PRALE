# real-v2 真实模型评测结果

模型：`deepseek-flash`；系统：PRALE；运行：本地宿主模式；基础 fixture revision 4，进阶 revision 3。
每个条件运行 12 题，warm 组内保留新建记忆，cold 每题独立状态。每阶段重新解包冻结源码。
没有重跑失败题或人工补交产物；不是容器隔离下的正式排名。

| 题库/条件 | 完成 | 通过 | 通过率 | 累计耗时(秒) | 输入 token | 输出 token | 缓存读取 token |
|---|---:|---:|---:|---:|---:|---:|---:|
| advanced-cold | 12 | 12 | 100.0% | 2561.7 | 20,347,146 | 302,613 | 19,593,728 |
| advanced-warm | 12 | 11 | 91.7% | 4118.8 | 17,537,886 | 313,472 | 16,263,296 |
| basic-cold | 12 | 12 | 100.0% | 1110.8 | 7,258,567 | 133,312 | 6,834,560 |
| basic-warm | 12 | 11 | 91.7% | 3514.9 | 8,253,391 | 377,796 | 6,724,864 |

累计耗时是单题耗时之和；四组并行，不能相加解释为墙钟时长。输入 token 已包含缓存读取；用量包含记忆模型调用。超时/崩溃且未生成 adapter_result 的任务缺少用量；表中 token 仅为已观测量，不是完整计费总量。未配置单价，不推算美元费用。

## 按阶段对照

| 题库 | 阶段 | warm | cold | 通过率差(warm−cold) |
|---|---|---:|---:|---:|
| basic | learn | 3/3 | 3/3 | +0.0 个百分点 |
| basic | transfer | 2/3 | 3/3 | -33.3 个百分点 |
| basic | correction | 3/3 | 3/3 | +0.0 个百分点 |
| basic | retransfer | 3/3 | 3/3 | +0.0 个百分点 |
| advanced | learn | 3/3 | 3/3 | +0.0 个百分点 |
| advanced | transfer | 3/3 | 3/3 | +0.0 个百分点 |
| advanced | correction | 2/3 | 3/3 | -33.3 个百分点 |
| advanced | retransfer | 3/3 | 3/3 | +0.0 个百分点 |

## 逐题结果

| 条件 | 题组 | learn | transfer | correction | retransfer |
|---|---|---|---|---|---|
| advanced-cold | execution-lifecycle | passed | passed | passed | passed |
| advanced-cold | resource-consistency | passed | passed | passed | passed |
| advanced-cold | session-integrity | passed | passed | passed | passed |
| advanced-warm | execution-lifecycle | passed | passed | passed | passed |
| advanced-warm | resource-consistency | passed | passed | failed | passed |
| advanced-warm | session-integrity | passed | passed | passed | passed |
| basic-cold | extension-trust | passed | passed | passed | passed |
| basic-cold | session-migration | passed | passed | passed | passed |
| basic-cold | tool-recovery-order | passed | passed | passed | passed |
| basic-warm | extension-trust | passed | passed | passed | passed |
| basic-warm | session-migration | passed | failed | passed | passed |
| basic-warm | tool-recovery-order | passed | passed | passed | passed |

## 失败原因

- `advanced-warm/resource-consistency/correction`：代理执行超时；every faulty production module must be repaired: ['packages/coding-agent/src/core/project-trust.ts', 'packages/coding-agent/src/core/resource-loader.ts', 'packages/coding-agent/src/core/settings-manager.ts']；代理状态 `failed`。详见相应 raw JSON 和 submissions 目录。
- `basic-warm/session-migration/transfer`：missing or symlinked delivery: .prale-eval/result.json；代理状态 `completed`。详见相应 raw JSON 和 submissions 目录。

## 用量可观测性

- `advanced-cold`：12/12 次任务有适配器用量记录。
- `advanced-warm`：11/12 次任务有适配器用量记录。
- `basic-cold`：12/12 次任务有适配器用量记录。
- `basic-warm`：12/12 次任务有适配器用量记录。

## 记忆调用与解释边界

- `advanced-warm`：记忆模型调用 20 轮；显式记忆工具调用 {'memory_read_scene': 3}。
- `basic-warm`：记忆模型调用 64 轮；显式记忆工具调用 {'memory_read_scene': 19, 'memory_search': 1}。

适配器 memory_retrievals 字段只标记 memory_search，不能代表所有场景读取或自动注入。
每条件仅一次运行，题目共用固定模块，样本相关；通过率差仅为本轮描述，不能证明记忆造成收益或损失。
缺少交付文件的失败也不等于生产代码行为已证明错误；按完整任务交付契约计为失败。
隐藏测试检查有限行为及提交测试的故障敏感性，不代表完整生产构建、上游测试或崩溃恢复均正确。

原始证据：四个 *.raw.json、四个 *.report.json、summary.json、submissions/；controller.py 保存无密钥运行脚本；run-config.json 保存运行环境和验收文件指纹；memory-diagnostics*.json 保存记忆队列诊断。

## 记忆队列最终状态

- `advanced-warm`：{'completed': 10, 'dead_letter': 5}。
- `basic-warm`：{'completed': 11, 'dead_letter': 9}。

记忆作业存在 dead-letter 及超时/schema/冲突记录，完整分类见 memory-diagnostics.json；不能将这次运行解释为记忆机制正常发挥后的受控因果实验。

证据完整性检查：四组各 12 条、每组任务不重复、48 份提交 manifest 与原始判定一致。

补充逐作业及实际 L2 诊断见 [MEMORY_DIAGNOSIS.md](MEMORY_DIAGNOSIS.md)：14 个 dead-letter 不等于没有 L2，当前实际有基础 10 个、进阶 1 个可读场景；进阶显式 L2 读取 3 次均失败。
