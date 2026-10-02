# 长期记忆评测集 v1

运行 `python scripts/build_memory_eval_cases.py` 生成 `benchmark-v1.json`；CI 可用
`--check` 验证该数据集仍由源码确定性生成。当前固定包含 15 个生成、10 个语义
召回与 10 个纠错案例，不含遗忘/GC。

评测时将生成案例的 archive 交给真实 `MemoryExtractor`，再按 `expected_memories`、
`forbidden_terms` 和 note 做人工或 LLM judge 审核；语义召回案例分别用 BM25-only
和 BGE-M3 hybrid 跑同一 corpus，比较 `must_recall` 的 Recall@K/MRR；纠错案例验证
新的记录状态、`supersedes_ids`、audit 和默认召回行为。

原始执行结果可用 `scripts/report_memory_eval.py` 转换成统一报告：

```bash
python scripts/report_memory_eval.py \
  --results raw-results.json \
  --output reports/memory-v1-hybrid.json
```

`raw-results.json` 有三个数组：`generation` 的每项是 `{id, candidates}`；
`semantic_recall` 的每项是 `{id, mode, retrieved_ids}`；`correction` 的每项是
`{id, decision, old_status, active_contents, retrieved_contents}`。报告输出各类 pass
rate、Recall@5、MRR 和逐 case 的失败原因。

真实执行使用 `scripts/eval_memory.py`。先跑一次 BM25，再用同一 benchmark 跑一次
BGE-M3 hybrid，分别转换为报告后比较召回指标：

```bash
python scripts/eval_memory.py --mode bm25 --memory-prompt deploy/memory-code-prompt.md \
  --output reports/memory-v1-bm25.raw.json
python scripts/eval_memory.py --mode hybrid \
  --embedding-model /root/vibe/AgenticRAG+RL/core/models/bge-m3 \
  --memory-prompt deploy/memory-code-prompt.md \
  --output reports/memory-v1-hybrid.raw.json
```

精确匹配报告是回归诊断，不适合裁定有效改写。使用 `judge_memory_eval.py` 以 LLM
rubric 对生成、召回与纠错逐 case 评分；它输出每个维度 0--4、pass/partial/fail 和理由：

```bash
python scripts/judge_memory_eval.py \
  --results reports/memory-v1-bm25-full.raw.json \
  --output reports/memory-v1-bm25-full.llm-judge.json
```

## 经验复利评测 v1

`benchmark-v1` 回答“记住了吗”；`experience-v1` 回答“这次完成任务得到的经验，能否在**新的 session、不同但相关的任务**中减少试错并提高正确率”。每个 episode 固定为 learn → transfer → correction：先形成经验证的经验，再隔离 session 测试迁移，最后给出反证，测试系统会不会更新旧经验。

这是一项对比实验：同一模型、同一任务包、同一工具权限分别跑 warm/cold。warm 只能启用该系统在 learn 阶段自行写入的正常持久状态，不能人工粘贴上一轮摘要；cold 必须禁用或清空持久状态。PRALE 的 transfer/correction 必须新建 session 并使用同一个 repository scope；Claude Code 也必须新开会话，并在报告 metadata 中明确版本和实际启用的持久状态机制。每个阶段保存原始 transcript、独立验收结果、`evidence_ids`、标准化 `actions` 和 `tool_calls`；evidence ID 只能填写 agent 当时真正可用的历史证据。

生成基准并为每个 run 出报告：

```bash
python scripts/build_experience_eval_cases.py --check
python scripts/report_experience_eval.py --results reports/prale-warm.raw.json \
  --output reports/prale-warm.experience.json
python scripts/report_experience_eval.py --results reports/claude-code-warm.raw.json \
  --output reports/claude-code-warm.experience.json
```

原始输入的最小格式：

```json
{
  "metadata": {"system": "PRALE", "memory_mode": "warm", "model": "..."},
  "episodes": [{"id": "migration-runner-transfer", "stages": [
    {"id": "learn", "acceptance": "passed", "evidence_ids": ["migration-runner"], "actions": [], "tool_calls": 3},
    {"id": "transfer", "acceptance": "passed", "evidence_ids": ["migration-runner"], "actions": [], "tool_calls": 1},
    {"id": "correction", "acceptance": "passed", "evidence_ids": ["migration-runner-corrected"], "actions": [], "tool_calls": 1}
  ]}]
}
```

最后一次性比较 PRALE 与 Claude Code 的 warm-minus-cold 提升：

```bash
python scripts/compare_experience_eval.py \
  reports/prale-warm.experience.json reports/prale-cold.experience.json \
  reports/claude-code-warm.experience.json reports/claude-code-cold.experience.json \
  --output reports/experience-v1-comparison.json
```

关键读法是 transfer/correction acceptance、evidence reuse、avoidable rediscovery，以及 transfer tool-call saving；不要把 warm 的绝对分数直接当“经验复利”。只有 warm 相对于同系统 cold 的增益，才是该系统自身经验产生的边际价值。

### 可执行 mini-repo fixtures

每个阶段现在有独立的 mini-repo fixture，位于 `evals/memory/experience-v1/fixtures/<episode>/<stage>/`：`workspace/` 是给 agent 的唯一工作区，包含 `TASK.md` 和 `input.json`；`oracle/verify.py` 是 runner 在工作区外保管并于结束后运行的验收脚本。每个任务要求 agent 写出 `decision.json`，oracle 以精确字段、禁止的危险操作/秘密文本进行验证。

```bash
python scripts/build_experience_eval_fixtures.py --check

# 演示一个阶段；真实 runner 应先把 workspace 复制到临时目录，且不要把 oracle 暴露给 agent。
fixture=evals/memory/experience-v1/fixtures/migration-runner-transfer/transfer
tmp=$(mktemp -d)
cp -R "$fixture/workspace/." "$tmp"
# 让 PRALE 或 Claude Code 在 $tmp 完成 TASK.md 中的任务
python "$fixture/oracle/verify.py" "$tmp"
```

oracle 不应与 agent 的工作目录一起复制；否则模型可以直接针对验收实现“应试”输出。每个 stage 都在新的临时目录运行，只有 warm 条件允许来自 learn 的持久记忆跨越该目录和 session 边界。
