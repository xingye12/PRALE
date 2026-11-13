# Real-v2 基础任务：隐藏目标后的执行观察

本轮已按用户要求取消。warm 完成 7/12，cold 完成 12/12；未完成任务不计为失败，也不补跑。

PRALE / deepseek-flash；基础 fixture revision 5；warm/cold 各 12 题；advanced 未运行。
使用全新状态目录和本地宿主调试模式。解题耗时与 token 排除记忆晋升；未配置单价，不估算费用。

| 条件 | 已完成 | 隐藏验收通过 | 平均解题秒（通过题） | 平均解题 token（完整用量） | 完整用量样本 |
|---|---:|---:|---:|---:|---:|
| basic-warm | 7/12 | 7/7 | 67.1 | 586,534.9 | 7 |
| basic-cold | 12/12 | 12/12 | 68.6 | 588,366.0 | 12 |

| 题组/阶段 | warm | cold | warm 秒 | cold 秒 |
|---|---|---|---:|---:|
| extension-trust/learn | passed | passed | 62.5 | 60.6 |
| extension-trust/transfer | passed | passed | 90.3 | 85.3 |
| extension-trust/correction | passed | passed | 57.7 | 53.4 |
| extension-trust/retransfer | passed | passed | 46.9 | 50.8 |
| session-migration/learn | passed | passed | 75.5 | 93.2 |
| session-migration/transfer | passed | passed | 78.7 | 76.6 |
| session-migration/correction | passed | passed | 58.0 | 57.4 |

同题通过配对统计见 comparison.json；各题隐藏行为、修复版通过、原故障断言失败的完整记录见 stages/ 与 submissions/。

探索证据见 exploration.json 和 traces/。题面不列目标路径；公共 subject.mjs 仍暴露源码入口，因此不能据此声称已消除测试辅助定位捷径。

记忆晋升开销与 job 状态见 memory-diagnostics.json；promotion completed 只代表 drain 结束，不代表所有 job 成功。

单次重复且题目较少；通过率相同或成本差异均不足以独立证明记忆收益。
