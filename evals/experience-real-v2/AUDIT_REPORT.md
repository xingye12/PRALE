# real-v2 任务与验收审计报告

审计日期：2026-11-09。对象是当前工作树，而不是仅审查已提交版本。
范围包括基础题库 `fixtures/` 的 12 题、进阶题库 `advanced/fixtures/` 的 12 题、
题目生成器、公开加载器、隐藏行为检查、提交回归测试的正反重放，以及公共运行器。
已有未提交题库内容保留，在其基础上做修复。

结论：存在能漏检越界修改、影响验收隔离性和覆盖完整性的问题，已修复下列六类问题。
这些是题库与验收自检结果，不是模型成绩；没有执行付费模型评测或声称记忆增益。

## 问题、影响范围及修复

| 问题 | 影响的评测集/任务 | 原因与影响 | 修改 |
|---|---|---|---|
| 改动范围校验依赖代理可改写的 Git 索引 | 基础集全部 12 题 | `git diff`、`ls-files` 不能作为实际文件状态的权威证据。例如对非目标已跟踪文件设置 `assume-unchanged` 后再改写内容，原校验可能放行；Git 配置也未校验。 | 启动代理前，在工作区外保存原始文件清单、内容摘要、符号链接目标、文件权限及 Git 配置摘要。验收直接比较实际文件与控制器清单，拒绝越界变更及配置变更。进阶集复用同一实现。 |
| 文件指纹遗漏权限 | 进阶集全部 12 题；基础集一并加固 | 只记录内容与链接，非目标文件仅改变执行权限仍能通过。 | 普通文件指纹加入权限位，新增两套题库的权限变更拒绝测试。 |
| 隐藏行为检查污染提交回归的正例 | 基础集全部 12 题 | 隐藏行为与提交回归在同一修复副本执行；隐藏测试或被测实现写文件后，正例就不再是原始提交。与先前复制的故障副本也不对称。 | 隐藏行为、修复正例、原始故障反例使用三个独立副本。新增在隐藏行为副本写入标记的测试，确保提交回归看不到标记。进阶集原已独立复制，保留该设计。 |
| 默认信任策略分支未独立覆盖 | 进阶 `resource-consistency` 的 learn/transfer/correction/retransfer | 原有显式 override、已存决策的测试会提前返回，无法检查没有这些决策时 `always`/`never` 分支自身是否正确。 | 增加无 override、无存储决策的默认策略测试，检查资源可见性、最终信任状态与不持久化决策。另将两个策略分别反转为错误结果，证明隐藏测试能拒绝。 |
| 恢复完成顺序检查依赖等待时长 | 基础 `tool-recovery-order` 四阶段 | 等待 5ms 后检查“尚未完成”，没有明确确认被测 effect 已进入阻塞点，证据不够直接。 | 加入 effect-entered Promise，在确认实际执行进入受控 effect 后检查未完成，再显式释放。移除该处时间推断。 |
| 子进程与输出处理边界不足 | 公共运行器影响两套题库全部任务；Node 适配器同样影响全部任务 | 代理父进程结束或超时后，其后台子进程可能继续写工作区，与 oracle 竞争；Node 输出非法 UTF-8 字节会触发解码异常而不是结构化校验结果。 | 代理使用独立进程组，完成/超时均在 oracle 前清理整个组。Node 关闭标准输入并明确用 UTF-8 replacement 解码。增加正常结束、超时两条子进程清理测试及非法字节测试。 |

基础清单存放于原故障文件旁的 `.baseline.json`，进阶仍为故障目录中的 `baseline.json`。
控制器必须在代理执行前捕获，缺失时拒绝验收，不退回 Git 判定。
这些外部文件属于可信控制器输入，不应挂载为代理可写。

## 对各任务内容的检查

以下每一行均包含 learn、transfer、correction、retransfer 四题。

| 题组 | 检查的任务要求与证据 | 本轮任务内容结论 |
|---|---|---|
| 基础 `extension-trust` | 初始信任重置、true/false 决策、异步 resolver、再次拒绝、拒绝异常、无 resolver 的正常 reload | 没有发现新增的题意与变异不匹配。基础范围检查与重放隔离修复适用于此组。 |
| 基础 `session-migration` | BOM、OAuth/API-key 优先级、既有 auth、无效输入、POSIX/Windows/UNC、碰撞保全及继续处理、幂等 | 未发现需要改写题目或原始变异的新增问题。该组涉及真实临时文件 IO，副本隔离尤其必要。 |
| 基础 `tool-recovery-order` | 两侧 safe 声明及取消的组合、缺失工具/声明、checkpoint 保留、clear/invoke/publish 次序 | 题意与原始变异对应；完成等待证据改为可控屏障。该组替换真实工具执行边界，不能据此声称验证了完整工具执行链。 |
| 进阶 `resource-consistency` | resolver → loader → SettingsManager、多源配置合并、持久化 consent 与会话信任 | 增补默认策略分支。原题及多文件变异仍成立，不改变修复要求。 |
| 进阶 `session-integrity` | migration → text/paths → session reader、碰撞、尾行修复、跨读缓冲区的 UTF-8 | 未发现新增题意矛盾；原有每个故障子集与独立重放检查保留。 |
| 进阶 `execution-lifecycle` | recovery → executor/finalizer → gate、取消、晚到回调、checkpoint、drain 与 publication | 未发现新增题意矛盾；原有每个故障子集、独立恢复单文件及组合故障的检查保留。 |

没有用预期源码字符串来判断修复正确，也没有通过把题目改简单来消除失败。
保留“健康源码通过、每个注入故障失败、等价实现可通过、空回归和部分回归失败”的检查。

## 验收版本与复验

基础集 `fixture_revision` 从 3 升为 **4**，oracle 协议仍为 3；
进阶集 `fixture_revision` 从 2 升为 **3**，oracle 协议仍为 4。
生成器和落盘 fixture 元数据同步，基础 oracle 结果补充 task_id 与 fixture_revision。
历史分数不要与本轮新验收版本直接合并。

最终复验 **188 passed（86.56s）**，命令为：

```bash
.venv/bin/pytest -o addopts='' -q \
  tests/unit/test_real_experience_eval.py \
  tests/unit/test_real_experience_behavior.py \
  tests/unit/test_real_experience_advanced.py \
  tests/unit/test_build_real_experience_fixtures.py \
  tests/unit/test_real_experience_adapters.py \
  tests/unit/test_report_real_experience_eval.py \
  tests/unit/test_crossrepo_execution_capture.py \
  tests/unit/test_crossrepo_experience_eval.py
```

修改涉及的 9 个 Python 文件通过 `ruff check` 和 `ruff format --check`。
四个验收/运行器模块通过 mypy 检查。两个生成器 `--check` 均通过，确认落盘 fixture 与生成器一致。
JavaScript 行为检查由上述 pytest 实际启动 Node 24 执行。
没有运行与评测改动无关的完整 harness 测试套件。

## 校验结果仍然不能证明的事情

- 基础四阶段复用相同函数；进阶也复用固定模块图。24 个任务不等于 24 个独立代码库或独立能力样本。
- 阶段通过只能说明修复符合有限行为契约，不能证明经验或记忆导致修复。需要另外进行模型 warm/cold 对照，且考虑题组内相关性。
- VM 加载器替换外部依赖，并不运行项目完整构建、上游所有测试或真实 storage 崩溃恢复。不能把局部行为通过解释为生产系统全部正确。
- 修复正例通过且原始故障触发 assertion，是回归有效性的必要证据，不是其意图的数学证明。刻意读取源码/哈希后断言也可能满足差分条件。当前不添加容易误拒合法测试的字符串/AST 黑名单。
- 控制器清单、隐藏测试及故障文件必须受外部权限隔离。清理进程组不能阻止主动 setsid 脱离、读取宿主隐藏文件或恶意篡改控制器。VM、临时目录及单一共享可写容器均不构成对抗性安全沙箱；本轮不宣称已解决恶意宿主代码的安全隔离。

这些边界已经与验收规范同步，不把尚未验证的能力计入通过结论。
