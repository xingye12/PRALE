# 真实仓库经验复利评测 v2

本目录定义在冻结 `pi` 提交上运行的跨会话 coding 评测。它不使用当前
`/root/vibe/CoLe/pi` worktree：capsule builder 只读取 `HEAD` commit，因此未提交
改动不会进入评测。

## 运行模型

每个 stage 从 capsule 的 `source.tar` 解出新的工作区，应用不可见 mutation，然后将
该状态提交为 `fixture baseline`。agent 因而能正常使用 Git 记录自己的改动，但无法
从 mutation 的未提交 diff 反推答案。hidden oracle 位于 workspace 之外，结束后才运行。

真实运行必须在 manifest 指定的、预先安装了锁定依赖的容器内进行，并禁用网络。当前
runner 明确拒绝在宿主机启动 agent，除非传入 `--allow-host-execution`；这个开关只用于
本地 fixture 调试，不能被视为 OS sandbox。

```bash
python scripts/build_real_experience_capsule.py \
  --pi-root /root/vibe/CoLe/pi \
  --output /srv/prale-eval/pi-2026-10-02 \
  --container-image 'node:24-bookworm@sha256:<digest>'

# 在该容器内，agent command 可以使用 {workspace} 接收唯一可写工作区。
python scripts/run_real_experience_stage.py \
  --capsule /srv/prale-eval/pi-2026-10-02/capsule.json \
  --fixture /srv/prale-eval/fixtures/extension-trust/transfer \
  --agent-command 'prale-run --cwd {workspace}' \
  --output reports/prale-warm-extension-trust-transfer.json
```

运行器不将 learn transcript、上一个 worktree、patch 或人工摘要传给 transfer。warm
仅挂载系统自身 learn 后形成的 memory volume；cold 创建空的 memory volume。PRALE 和
Claude Code 均应采用相同 capsule、task、超时、工具白名单、模型和容器。

## 当前 episode

`benchmark.json` 固定首批三类真实 `pi` 经验。每类都必须提供三个同构但不同文件/符号
的 mutation 变体后才可用于正式排名。每个具体 fixture 包含 `TASK.md`、`mutation.patch`、`fixture.json`、`oracle.py` 和公开测试辅助文件；
补丁、元数据和 oracle 仅由 runner 在 agent workspace 外读取。

正式报告的 raw envelope 以 `metadata` 和 `runs` 表达。每个 run 至少携带 `stage`、hidden
`acceptance`、`duration_seconds`、`tool_calls`、diff digest 和（若系统可观测）
`memory_retrievals`。用以下命令生成只基于可观察事实的报告：

```bash
python scripts/report_real_experience_eval.py \
  --results reports/prale-warm.raw.json \
  --output reports/prale-warm.real.json
```

主指标为 `warm - cold` 的 transfer 与 retransfer hidden-acceptance 增益；耗时、token 和
工具调用只在通过的 run 中比较。纠错阶段必须单独报告，并追踪 stale-memory 导致的负迁移。

## Agent adapters

`scripts/real_experience_adapters.py` is the native adapter boundary. `prale`
directly drives the Python Harness and stores only the warm condition's SQLite
memory state under the supplied state directory. `claude-code` invokes
`claude --print --output-format stream-json` in a new session per stage. Its
warm condition retains only its isolated Claude home; it never resumes a
previous conversation or injects a hand-written summary. Use an API-key based
Claude login for this isolated home (`ANTHROPIC_API_KEY`); copying a personal
home directory would invalidate the experiment.

The batch controller runs one complete condition and writes the raw envelope:

```bash
# Four independent invocations: PRALE warm/cold and Claude Code warm/cold.
python scripts/run_real_experience_batch.py \
  --capsule evals/experience-real-v2/capsules/pi-b455975/capsule.json \
  --adapter prale --memory-mode warm --state-dir .eval-state/prale-warm \
  --model deepseek-flash --allow-host-execution \
  --output reports/prale-warm.raw.json
```

For Claude Code configured against an Anthropic-compatible endpoint, export
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` in the
shell that starts the batch. Do not put credentials in a command line, report,
fixture, or state directory. The adapter defaults to `--max-budget-usd 10` per
stage; that is a hard ceiling on one Claude Code invocation's reported model
spend, not a pre-charge. Override it only when a stage legitimately needs more
reasoning budget.

`--allow-host-execution` is only an adapter smoke-test mode. Before reporting
formal rankings, use the same command inside a disposable agent container with
the workspace as its only writable bind mount and an egress proxy that permits
only the selected model endpoint. A fully disconnected agent container cannot
call a hosted model, so `--network none` applies to the `pi` runtime and oracle
validation image, not the model-facing agent process.


## 当前验收：基础 fixture revision 6

旧的源码字符串检查已经替换为可执行行为契约。12 道题现在全部有非空故障补丁，
correction 中的碰撞策略、信任决策和条件重放规则也在题目中明确说明。
旧版分数不能与本版混用。完整协议见
[real-v2-behavioral-acceptance.md](../../specs/real-v2-behavioral-acceptance.md)。

隐藏 oracle 使用 Node 24（`--experimental-vm-modules`）对提交的完整 TypeScript
模块去除类型后执行，无需安装 npm 依赖。信任加载使用边界 fake 检查阶段与决策；
迁移运行真实文件操作；恢复检查安全矩阵、取消、checkpoint 和执行/发布顺序。
这些是边界行为测试，不等同于完整 pi 集成测试或真实崩溃恢复测试。

每题额外要求 `.prale-eval/regression.mjs` 和 `.prale-eval/result.json`。
公开的只读 `subject.mjs` 只提供通用 `loadModule` / `createGraph`，不包含仓库路径、业务符号、场景映射或预写的边界 fake。Agent 必须自行定位源码、选择真实依赖并编写 fake。回归脚本应使用未捕获的
`node:assert/strict` 断言，可通过下面的命令运行：

```bash
node --experimental-vm-modules .prale-eval/regression.mjs
```

只有隐藏行为测试通过、回归脚本在修复版通过、在独立副本恢复原故障后产生断言失败，
才算验收通过。打印成功、语法/导入错误、超时、缺少运行环境均不能代替有效断言。
控制器保存分项退出码、状态和输出到 `oracle_result`，每次执行使用独立工作区副本。
VM 和临时目录不是 OS sandbox；原有容器隔离要求仍然适用。

本地校验（不会调用模型）：

```bash
python scripts/build_real_experience_fixtures.py --check
python -m pytest tests/unit/test_real_experience_behavior.py tests/unit/test_real_experience_eval.py \
  tests/unit/test_build_real_experience_fixtures.py tests/unit/test_real_experience_adapters.py \
  tests/unit/test_report_real_experience_eval.py
```

warm/cold 仍通过同一批量入口的 `--memory-mode warm|cold` 切换。每阶段新建代码工作区和
会话；warm 保留记忆并推进记忆任务，cold 不启用 PRALE 长期记忆。修订本地验收不等于
已完成真实模型的记忆增益实验，请为新实验使用新的 state/output 目录。

## 独立的进阶题库

新增的 12 道跨文件任务位于 [advanced/](advanced/README.md)，不替换本目录原有题目。
每题涉及 2–3 个真实生产模块，并要求提交测试分别检出每个文件的独立故障。
使用 `--fixtures evals/experience-real-v2/advanced/fixtures` 选择该题库；旧默认值保持不变。

2026-11-09 验收审计修复及证据边界见 [审计报告](AUDIT_REPORT.md)。基础 oracle 协议仍为 3；当前基础 fixture revision 为 6，进阶为 5（题面及公共加载器均去除目标文件提示）；新旧修订分数应分开记录。

## 隐藏目标文件与解题成本（accounting version 2）

批量和单题 CLI 默认使用 `--target-visibility hidden`，模型提示和工作区 `TASK.md` 都只保留故障现象、行为要求与交付协议，不列本题目标文件，也不提示需修改几个文件。控制器继续持有真实目标清单并执行原验收；源码和共用只读通用加载器可供模型自行探索；加载器不再提供任务到源码的映射或业务专用适配。当前生成的基础与进阶共 24 道题面也不再列出目标文件或修改文件数量。新 fixture 标记 `public_support_version: 1`；控制器在注入故障后重建工作区并统一源码时间戳，Git 索引也不保留原始修改时间。`listed` 仅表示按原文读取磁盘题面，可用于复现旧 fixture；新 fixture 原文已经隐藏目标。历史成绩与此次题面修订应分开统计。

PRALE 的主要字段 `duration_seconds`、`usage`、`cost_usd` 现在仅指解题，包括查找代码、读取已有记忆、修改和本地验证；L1/L2/L3 晋升另存 `promotion`，代理与晋升合计存 `total`，包含控制器验收的整阶段墙钟时间存 `wall_duration_seconds`。所有结果标记 `accounting_version: 2`，请勿与旧的混合统计直接合并。未配置单价则金额为 null；失败请求用量未知时保留 `usage_complete: false`，不按零计费。

解题和记忆晋升分别使用 `--timeout`、`--promotion-timeout`（各默认 900 秒）。解题完成先保存检查点，晋升超时/失败单独记录；晋升不会改变该题已经完成的解题状态。warm 仍在下一题前完成或限时结束晋升，使其可以读取此前记忆。实验使用新状态目录，避免旧题目泄露。

```bash
.venv/bin/python scripts/run_real_experience_batch.py \
  --capsule evals/experience-real-v2/capsules/pi-b455975/capsule.json \
  --adapter prale --memory-mode warm --model deepseek-flash \
  --target-visibility hidden --timeout 900 --promotion-timeout 900 \
  --state-dir .eval-state/hidden-basic-warm \
  --output reports/hidden-basic-warm.raw.json \
  --submission-dir reports/hidden-basic-warm-submissions \
  --allow-host-execution
```

用 `--memory-mode cold` 运行独立 cold 对照；用 `--fixtures evals/experience-real-v2/advanced/fixtures` 选择进阶集。报告的均值只在用量完整且验收通过的任务上计算，并保留样本数量；失败题及晋升开销仍逐题保存。
