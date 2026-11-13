# Real-v3 进阶任务：隐藏目标后的执行观察

PRALE / deepseek-flash；进阶 fixture revision 1；warm/cold 各 12 题；仅运行 advanced，基础题未重跑。
使用全新状态目录和本地宿主调试模式。解题耗时与 token 排除记忆晋升；未配置单价，不估算费用。

| 条件 | 已完成 | 隐藏验收通过 | 平均解题秒（通过题） | 平均解题 token（完整用量） | 完整用量样本 |
|---|---:|---:|---:|---:|---:|
| advanced-warm | 11/12 | 7/11 | 329.2 | 3,256,813.5 | 4 |
| advanced-cold | 12/12 | 10/12 | 268.7 | 3,628,475.2 | 8 |

| 题组/阶段 | warm | cold | warm 秒 | cold 秒 |
|---|---|---|---:|---:|
| execution-lifecycle/learn | passed | passed | 539.6 | 330.8 |
| execution-lifecycle/transfer | passed | failed | 431.8 | 365.7 |
| execution-lifecycle/correction | failed | passed | 307.0 | 387.8 |
| execution-lifecycle/retransfer | passed | passed | 354.1 | 352.1 |
| resource-consistency/learn | failed | passed | 900.1 | 261.1 |
| resource-consistency/transfer | passed | passed | 211.5 | 217.1 |
| resource-consistency/correction | passed | passed | 348.5 | 339.0 |
| resource-consistency/retransfer | passed | passed | 227.0 | 233.6 |
| session-integrity/learn | passed | passed | 191.5 | 157.7 |
| session-integrity/transfer | failed | passed | 154.7 | 233.4 |
| session-integrity/correction | failed | passed | 2.3 | 174.6 |

同题通过配对统计见 comparison.json；各题隐藏行为、修复版通过、原故障断言失败的完整记录见 stages/ 与 submissions/。

探索证据见 exploration.json 和 traces/。题面不列目标路径；公共 subject.mjs 为通用加载器；故障注入不再添加描述错误的源码注释。宿主调试模式仍不提供文件读取安全隔离。

记忆晋升开销与 job 状态见 memory-diagnostics.json；promotion completed 只代表 drain 结束，不代表所有 job 成功。

单次重复且题目较少；通过率相同或成本差异均不足以独立证明记忆收益。
