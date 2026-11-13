# Real-v3 基础任务：隐藏目标后的执行观察

PRALE / deepseek-flash；基础 fixture revision 1；warm/cold 各 12 题；advanced 未运行。
使用全新状态目录和本地宿主调试模式。解题耗时与 token 排除记忆晋升；未配置单价，不估算费用。

| 条件 | 已完成 | 隐藏验收通过 | 平均解题秒（通过题） | 平均解题 token（完整用量） | 完整用量样本 |
|---|---:|---:|---:|---:|---:|
| basic-warm | 12/12 | 7/12 | 190.6 | 1,533,703.0 | 7 |
| basic-cold | 12/12 | 11/12 | 185.8 | 2,339,641.9 | 10 |

| 题组/阶段 | warm | cold | warm 秒 | cold 秒 |
|---|---|---|---:|---:|
| extension-trust/learn | passed | passed | 647.0 | 131.4 |
| extension-trust/transfer | passed | passed | 167.9 | 126.7 |
| extension-trust/correction | passed | passed | 103.1 | 147.8 |
| extension-trust/retransfer | passed | passed | 144.0 | 307.7 |
| session-migration/learn | failed | passed | 111.0 | 95.7 |
| session-migration/transfer | passed | passed | 92.6 | 87.4 |
| session-migration/correction | passed | failed | 65.1 | 75.1 |
| session-migration/retransfer | passed | passed | 114.8 | 92.1 |
| tool-recovery-order/learn | failed | passed | 900.1 | 132.1 |
| tool-recovery-order/transfer | failed | passed | 890.1 | 325.2 |
| tool-recovery-order/correction | failed | passed | 2.3 | 308.5 |
| tool-recovery-order/retransfer | failed | passed | 2.3 | 289.6 |

同题通过配对统计见 comparison.json；各题隐藏行为、修复版通过、原故障断言失败的完整记录见 stages/ 与 submissions/。

探索证据见 exploration.json 和 traces/。题面不列目标路径；公共 subject.mjs 为通用加载器；故障注入不再添加描述错误的源码注释。宿主调试模式仍不提供文件读取安全隔离。

记忆晋升开销与 job 状态见 memory-diagnostics.json；promotion completed 只代表 drain 结束，不代表所有 job 成功。

单次重复且题目较少；通过率相同或成本差异均不足以独立证明记忆收益。
