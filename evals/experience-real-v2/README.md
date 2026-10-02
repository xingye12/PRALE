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
的 mutation 变体后才可用于正式排名。每个具体 fixture 必须包含 `TASK.md`、
`mutation.patch` 和 `oracle.py`；后两项仅由 runner 在 agent workspace 外读取。

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
