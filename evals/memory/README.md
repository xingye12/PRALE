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
