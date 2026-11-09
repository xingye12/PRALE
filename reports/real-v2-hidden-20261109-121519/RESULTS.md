# 隐藏目标文件的 real-v2 评测结果

最终结果：48/48 次已完成且全部通过。
模型：deepseek-flash；系统：PRALE；target_visibility=hidden；accounting_version=2。
题目不列本题目标路径与文件数量；源码和跨阶段相同的公共测试加载器可供模型自行探索。
warm 使用全新组内记忆，cold 每题独立状态；基础/进阶各 12 题、各 warm/cold，共 48 次。
本地宿主模式，非正式容器隔离排名。初次进程中断后恢复：基础 warm 首题保留归档，通过离线复验恢复；其余未完成阶段重新启动。

## 主结果：解题成本

解题时间包含定位、查阅已有记忆、修改和本地验证，排除晋升与控制器隐藏验收。token 只计解题模型调用；缺失用量不计零。

| 条件 | 完成 | 通过 | 解题平均秒 | 解题平均 token | 完整 token 样本 |
|---|---:|---:|---:|---:|---:|
| advanced-cold | 10 | 12 | 199.6 | 2,035,348 | 11/12 |
| advanced-warm | 12 | 12 | 166.1 | 1,634,509 | 12/12 |
| basic-cold | 12 | 12 | 84.4 | 660,558 | 12/12 |
| basic-warm | 12 | 12 | 76.9 | 644,384 | 12/12 |

上表平均耗时包含失败任务；token 平均仅使用用量完整的任务，样本数量显式列出。晋升请求不计入上述时间或 token。

## 两组均通过的同题比较

时间按两组均通过的同题配对；token 进一步要求两侧用量均完整。

| 题库 | 时间配对数 | cold 秒 | warm 秒 | token 配对数 | cold token | warm token |
|---|---:|---:|---:|---:|---:|---:|
| basic | 12 | 84.4 | 76.9 | 11 | 615,434 | 644,384 |
| advanced | 12 | 189.6 | 166.1 | 12 | 2,035,348 | 1,634,509 |

## 晋升开销：单独记账

| 条件 | 晋升累计秒 | 晋升已观测 token |
|---|---:|---:|
| advanced-cold | 0.0 | 0 |
| advanced-warm | 3934.5 | 4,774,426 |
| basic-cold | 0.0 | 0 |
| basic-warm | 2422.5 | 2,869,611 |

晋升用量可能因失败请求而不完整；没有单价配置，不推算美元费用。记忆注入/读取作为解题的一部分保留；仅排除产生新记忆的模型请求和晋升时间。

## 逐题

| 条件 | 题组 | learn | transfer | correction | retransfer |
|---|---|---|---|---|---|
| advanced-cold | execution-lifecycle | failed | failed | passed | passed |
| advanced-cold | resource-consistency | passed | passed | passed | passed |
| advanced-cold | session-integrity | passed | passed | passed | passed |
| advanced-warm | execution-lifecycle | passed | passed | passed | passed |
| advanced-warm | resource-consistency | passed | passed | passed | passed |
| advanced-warm | session-integrity | passed | passed | passed | passed |
| basic-cold | extension-trust | passed | passed | passed | passed |
| basic-cold | session-migration | passed | passed | passed | passed |
| basic-cold | tool-recovery-order | passed | passed | passed | passed |
| basic-warm | extension-trust | passed | passed | passed | passed |
| basic-warm | session-migration | passed | passed | passed | passed |
| basic-warm | tool-recovery-order | passed | passed | passed | passed |

## 失败原因

无。


