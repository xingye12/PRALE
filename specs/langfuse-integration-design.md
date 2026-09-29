# PRALE 接入 Langfuse：可观测性与评测实施设计

## 结论

可以接入，而且 PRALE 的现有边界非常适合：`runtime` 已经将模型、工具和
事件分开，且 `integrations/telemetry.py` 已有可选的事件监听器模式。推荐将
Langfuse 实现为**可选的外部 telemetry adapter**，而不是把 SDK、网络 I/O 或
Langfuse 数据模型引入 `domain/`、`runtime/` 或 `storage/`。

第一阶段提供每个 Operation 的完整 Agent trace；第二阶段以这些 trace 中的真实
案例建立 Dataset，运行完整 harness 的离线 Experiment；第三阶段在生产 trace 上
运行低风险、确定性的质量检查。这样既能调试调用链，又能在改动 provider、prompt、
工具或 memory/skill 策略前发现回归。

本方案使用 Langfuse Python SDK v4（OpenTelemetry 架构）。Cloud 与 self-host 的
应用代码相同，只通过 `LANGFUSE_BASE_URL` 与凭据区分。

## 目标、非目标与不变量

### 目标

- 每一次 `run` Operation 产生一条 Langfuse trace；PRALE Session 是该 trace 的
  `session_id`，使多轮对话在 Langfuse 中可聚合。
- 将一次 Agent loop 展示为 `agent` → 多个 `generation` 与 `tool` 子观察；每次模型
  调用必须是独立的 `generation`，不得将整轮循环合并为一条 generation。
- 带上输入、输出、模型名、token usage、工具参数/结果、重试、错误、耗时，以及安全
  的 PRALE 关联元数据，以便排障、成本分析和评分器筛选。
- 未配置 Langfuse 时零网络连接、无行为差异；Langfuse 网络故障、队列满或 SDK 异常
  不得影响 Operation、持久化、重试、取消或崩溃恢复。
- 通过 Dataset Experiment 复用**真实的 Harness + Provider + 工具装配**，而不是仅
  单独评测最终 prompt。

### 非目标

- 不把 Langfuse 当成 PRALE 的权威事件存储、恢复日志或审计记录；SQLite 中的
  effect intent / settlement 仍是唯一真相。
- 不用 Langfuse 回放 `never` 工具、恢复未知 effect，或改变 safe/never 重试策略。
- 不在第一阶段上传原始文件内容、工具输出、长期记忆、Skill 正文或认证信息。
- 不在核心库中强制安装 `langfuse`；该依赖属于单独的可选 extra。

### 必须保持的 PRALE 不变量

1. 外部副作用仍遵循 durable intent → effect → atomic settlement；遥测永远处于该
   流程之外。
2. `domain/` 保持纯净，`runtime/` 只面向一个本地 telemetry 协议；
   `integrations/langfuse.py` 才允许导入 Langfuse SDK。
3. Event listener 是 best-effort。它不得同步调用 Langfuse API，也不得在 listener
   内读写 Session 或等待 exporter 发送完成。
4. 进程在 effect 后崩溃时，遥测可以丢失或留下未关闭观察，但不得据此推断远程调用
   是否执行或修改恢复结果。

## 现状与推荐映射

PRALE 已有三个可直接复用的事实来源：

- `runtime/drive.py` 在每个 provider attempt 之前保存 `assistant.effect_pending`，
  包含 model、messages、attempt、memory/skill loadout；settlement 写入 assistant
  entry、usage 和 effect span。
- 同一文件对每个工具调用创建 effect span，并发布 `tool_start`/`tool_end`。工具的
  输入、结果、错误与最终状态均有 durable record。
- `runtime/events.py` 的 `EventBus` 已保证监听器异常不会中断 Agent loop；
  `integrations/telemetry.py` 是现有的可选 adapter 位置。

建议的 Langfuse 层级如下。`operation_id` 只放 metadata，绝不充当 Langfuse 的
trace ID；Langfuse 管理其自身 W3C ID。

| PRALE 对象/动作 | Langfuse 对象 | 稳定名称 | 必填内容 |
|---|---|---|---|
| 一次 `run` Operation | trace 的根 `agent` | `prale.run` | prompt 摘要/输入、最终 assistant output、session id、operation id、lane、状态 |
| 一次 provider attempt | `generation` | `prale.generate` | messages（按隐私策略）、model、attempt、response、usage、finish reason、错误 |
| 一个工具 effect attempt | `tool` | `prale.tool.<tool_name>` | 工具名、参数（脱敏/限长）、结果（脱敏/限长）、attempt、是否 error |
| memory 检索/装配（可选） | `retriever` 或 `chain` | `prale.memory.retrieve` | item 数、内容 hash、token/字符预算；默认不含正文 |
| Skill 装载（可选） | `chain` | `prale.skill.load` | skill id、version、content hash、预算；默认不含正文 |
| compaction/navigation（可选） | 根 `span`/`chain` | `prale.compact` / `prale.navigate` | 操作状态、结果摘要 |

`prale.run` 的 trace input/output 要刻意设置：input 是用户 prompt 的受控表示，output
是最终 assistant 内容或可评分的结构化结果。不要依赖根观察自动镜像，因为日后的
LLM-as-a-Judge 或 Dataset 评测会以这两个字段为契约。

## 数据与隐私策略

PRALE 可执行本地 shell、读写文件且保存长期记忆，因此默认策略应是“最少上传”，不
是“所有 trace 都上传”。所有值在进入 Langfuse 前走同一个纯 Python sanitizer。

### 默认上传

- `session_id`、`operation_id`、lane、operation kind、模型名称、attempt、状态、时长；
- 标量用量（input/output/total tokens）和可选成本；
- 工具名、工具结果的 `is_error` / `terminate`、参数键名、内容长度、SHA-256 短 hash；
- 已有 `_redact_trace()` 能识别的密钥字段/常见 Bearer token，作为 sanitizer 的起点。

### 默认禁止上传

- `DEEPSEEK_API_KEY`、`LANGFUSE_SECRET_KEY`、Authorization/Cookie，以及任意环境变量
  全量；
- `bash` 的环境、命令输出、文件绝对路径；
- `read`/`write`/`edit` 的文件内容；
- 长期记忆正文、Skill markdown/资源与 provider 的完整 system prompt；
- 未经明确配置的最终用户 prompt 与模型原文输出。

### 配置档

| 档位 | 内容策略 | 使用场景 |
|---|---|---|
| `off`（默认） | 不初始化 SDK | 本地开发、无凭据部署 |
| `metadata` | 仅默认上传项 | 初次生产接入 |
| `redacted` | 允许 prompt/response/工具摘要，经递归脱敏、字段 allowlist、长度截断 | 受控 staging / 已审核生产 |
| `full` | 仅显式允许的安全测试环境 | 复现质量问题；不能作为生产默认 |

建议实现 `TelemetrySanitizer`，输入 `JsonValue` 与 schema/用途（prompt、tool input、
tool output），输出可序列化的安全值。它必须具备：递归 secret-key 脱敏、字符串截断、
最大数组/对象深度、路径归一化（仅保留相对/哈希表示）、allowlist 优先和不可逆 hash。
不要只依赖正则脱敏，也不要在 Langfuse 项目 metadata 中放用户标识或仓库绝对路径。

## 架构设计

### 新模块和依赖边界

```text
api/serve.py or embedding application
    └─ builds optional LangfuseTelemetry
runtime/ (local protocol + structured facts only)
    └─ telemetry sink / EventBus
integrations/langfuse.py
    └─ langfuse SDK v4 + bounded exporter queue + sanitizer
domain/, storage/
    └─ no Langfuse import
```

建议新增：

- `src/agent_harness/integrations/langfuse.py`：`LangfuseTelemetry`、配置、队列 worker、
  sanitizer 与 SDK 的唯一导入点；
- `src/agent_harness/integrations/telemetry.py`：小型 `TelemetrySink` 协议或 enrich 后的
  immutable telemetry event DTO；保持现有 `InMemoryTelemetry` 可用；
- `src/agent_harness/api/serve.py`：从环境构建 adapter，并在应用 shutdown 关闭队列、
  `langfuse.flush()`；
- `pyproject.toml`：增加 `langfuse = ["langfuse>=4,<5"]` optional extra，不能放入 core
  dependencies；
- `deploy/web.env.example`：只写变量名、用途与安全说明，绝不提交实际 key；
- `tests/unit/test_langfuse_telemetry.py` 和相应 integration tests。

### 为什么不能只订阅现有 `HarnessEvent`

现有事件只有 operation kind、消息增量以及工具名/错误标识；它不携带 generation 的
model、完整 usage、attempt、工具参数/结果或 terminal outcome。仅靠它会产生无法评分、
不能正确关联重试的 trace。

因此应在 `runtime` 暴露一个**不依赖 Langfuse 的、最小化且结构化的 telemetry 事实
协议**，在 durable settlement 成功后发布：

```python
@dataclass(frozen=True, slots=True)
class GenerationTelemetry:
    session_id: str
    lane: str
    operation_id: str
    attempt: int
    model: str | None
    input: JsonValue              # adapter 负责脱敏
    output: JsonValue
    usage: Mapping[str, int | float]
    finish_reason: str | None
    outcome: Literal["completed", "failed", "unknown"]

@dataclass(frozen=True, slots=True)
class ToolTelemetry:
    session_id: str
    lane: str
    operation_id: str
    tool_call_id: str
    name: str
    attempt: int
    input: JsonValue
    output: JsonValue
    is_error: bool
    outcome: Literal["completed", "failed", "aborted", "unknown"]
```

发布点必须在以下位置：

1. provider 成功 settlement 后发布 `GenerationTelemetry(completed)`；
2. provider attempt 失败或在恢复中被收束为未知后发布相应 terminal telemetry；
3. 工具 settlement 后发布 `ToolTelemetry`，包括 hook block、unknown tool 和异常；
4. Operation terminal 时发布 `OperationTelemetry`，携带最终文本/结果摘要与 terminal
   status。

这会比目前 `tool_start`/`tool_end` 更晚发生，因此上报的“成功”只反映 PRALE 已持久化
的事实。实时流式 token 可继续发给 Web UI，但不应为每个 `message_update` 创建
Langfuse event；最终 generation 记录即可，避免高基数和敏感增量泄漏。

### 上报与上下文关联

`LangfuseTelemetry` 在收到 `OperationTelemetry(started)` 时建立根 `agent` observation，
以 `(session_id, operation_id)` 为内存键；之后 generation、tool 观察作为它的子节点。
并行工具使用各自的 observation；不要以“当前全局 span”来关联，因为并行 task 会破坏
父子关系。

实现使用 SDK 的 context manager 或显式 observation API 均可，但以下约束不可变：

- 按 `session_id` 写入 Langfuse session 属性，按 `operation_id` 放 metadata；
- 在 `generation` 中写 `model` 和 Langfuse 认可的 usage 字段，保留 provider raw usage
  仅在经过 sanitizer 后的 metadata 中；
- `tool` 必须嵌套在 `agent` 下，generation 与工具按 Agent loop 顺序交替；
- 名称固定为上述 `prale.*` 格式，禁止把 operation ID、文件名或用户内容拼进 name；
- shutdown 时 drain 有界队列并 `flush()`；短命令也必须在退出前 flush。

`EventBus.emit()` 当前会等待 async listener，故 Langfuse listener 必须同步地将已脱敏
DTO 放入有界 `asyncio.Queue`，然后立即返回。队列满时增加本地丢弃计数并丢弃该 telemetry
项（按策略优先保留 operation terminal），绝不能阻塞 Drive。后台 worker 才创建/更新 SDK
observations。处理 adapter 错误时只记录结构化本地日志和内部计数，禁止反向 emit
`handler_error` 造成递归。

> 实现说明（与上文的两处偏离）。缓冲用的是 `collections.deque` 而不是 `asyncio.Queue`：
> `asyncio.Queue` 会绑定到第一个等待它的 event loop，而实验 runner 每次
> `run_experiment` 都在新 loop 上 `asyncio.run`，前一个 loop 上留下的 worker 会让之后的
> 事实永远排在队列里。deque 不绑定 loop，worker 在发现自己的 loop 已关闭后就地重建，
> 每一轮实验的事实因此都能在 runner 关掉自己的 loop 之前变成 observation。为此
> `LangfuseTelemetry.drain()` 是公开的：runner 在 task 返回前显式等一次，`aclose()` 用它
> 加上 `PRALE_LANGFUSE_FLUSH_TIMEOUT_SECONDS` 作为超时上限（超时只影响关闭，不影响 turn）。

### 运行时配置

```dotenv
# 将 `LANGFUSE_TRACING_ENABLED=false` 作为默认安全开关。
LANGFUSE_TRACING_ENABLED=true
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=staging
PRALE_LANGFUSE_CAPTURE=metadata
PRALE_LANGFUSE_QUEUE_SIZE=1000
PRALE_LANGFUSE_FLUSH_TIMEOUT_SECONDS=5
```

启动校验规则：开关为 false 时不导入/构造 SDK；开关为 true 时三项凭据缺一即明确启动
失败（避免以为已被监控）；`environment` 只接受固定 allowlist（如 `development`、
`staging`、`production`）；capture 档位只接受本文列出的值。密钥可沿用 PRALE 现有的
`*_FILE` 读取模式，但错误消息只能指出变量名。

## 分阶段实施计划

### Phase 0：准备与数据治理

1. 创建 Langfuse 项目（按 staging/production 分项目或可靠的 environment 隔离），生成
   独立 server-side API key；不要将 secret 下发到浏览器。
2. 审核上述 capture 档位，明确哪些 prompt、工具及路径允许离开执行环境；先从
   `metadata` 开始。
3. 决定 retention、项目访问权限和删除流程。若使用 Cloud，确认区域和组织数据政策；
   需要完全自控时部署 self-hosted Langfuse。
4. 记录 `prale.*` 稳定名称、metadata allowlist 与评分指标，作为后续变更的兼容契约。

验收：能在 staging 以假 key 验证配置错误不会泄露值；关闭开关时不产生 SDK/network
初始化。

### Phase 1：最小可用 tracing

1. 实现可选依赖、配置和 `LangfuseTelemetry` 的队列/生命周期。
2. 加入 Operation、generation、tool 的结构化 telemetry DTO 与 settlement 后发布点。
3. 实现 `metadata` sanitizer、根 agent/generation/tool 映射与安全的 shutdown flush。
4. 在 DeepSeekProvider 实际调用上验证：一个含工具调用的 Drive 显示为一个 agent trace、
   两条 generation 和正确的 tool；usage 与 SQLite `UsageRow` 相符。
5. 在 Langfuse 中人工检查：session 分组、模型/用量、失败重试、取消、unknown outcome
   和并行工具。

验收：禁用模式、成功模式、Langfuse 不可用模式均不改变同一测试中的 `OperationResult`、
entries、usage、span 或恢复结果。

### Phase 2：可评测的离线实验

1. 从已确认的 staging/生产 trace 手工挑选样本，建立 Dataset，例如
   `prale/harness-regression`。每项保留受控 `input`、期望结果、风险标签和允许工具集合。
2. 新建独立脚本（例如 `examples/evaluate_harness.py` 或 `scripts/eval_harness.py`），它以
   临时 SQLite 存储和受限工具运行真实 Harness，不能复用生产 Session，不能调用会写真实
   工作区的工具。
3. Dataset item 的 task 调用完整 Agent，并返回一个供评分的结构化 output：

   ```python
   {
       "answer": final_answer,
       "tool_calls": [{"name": name, "is_error": is_error}],
       "terminal_status": terminal_status,
       "generation_count": count,
   }
   ```

4. 运行 Langfuse SDK 的 dataset experiment；给运行 metadata 写 `git_sha`、PRALE 版本、
   provider/model、prompt/skill/memory 配置版本与 evaluator 版本。
5. 每次候选变更使用**同一 Dataset 版本、同一评分器**与 baseline 比较，检查汇总分和
   逐条退化 trace。

初始评分器：

| 名称 | 类型 | 规则 |
|---|---|---|
| `terminal_success` | 确定性 | operation 为成功终态且无 unknown outcome |
| `required_tools` | 确定性 | 使用 expected metadata 中所有必要工具 |
| `forbidden_tools` | 确定性 | 不调用禁用或写入型工具 |
| `tool_error_free` | 确定性 | 工具结果均非 error（按样本允许的预期失败例外） |
| `answer_contract` | 确定性 | JSON/schema、关键字段或精确输出符合预期 |
| `answer_quality` | LLM-as-a-Judge | 在人工标注小集上校准后的任务完成度/安全性 |
| `tool_count` / `latency` / `token_cost` | run-level | 预算与 P95 回归检查 |

对 `bash`、`write`、`edit` 测试用例：仅使用临时目录、预置 fixtures、网络隔离和允许命令
allowlist；即使如此也应默认将这类样本标为高风险并人工复核。

### Phase 3：线上质量监测与发布门槛

1. 在 Langfuse 创建 observation-level code evaluator：例如最终回答 JSON 可解析、工具参数
   存在、只读模式没有写工具、工具失败率。规则筛选目标为稳定名称和 type，而不是自由文本。
2. 将低分 trace 抽样进入 annotation queue 供人工标注；每周将代表性失败加入 Dataset，
   去重并注明来源/风险标签。
3. CI 中运行小型、无副作用的 Dataset 作为 PR gate；夜间运行更大集。门槛例子：
   `forbidden_tools == 1.0`、安全集全通过、任务成功率不低于 baseline、token P95 增幅
   不超过 15%。
4. LLM judge 先与人工标签计算一致性；不达标时只作观察信号，不作自动发布 gate。

## Experiment 脚本轮廓

以下是形状说明，不是可直接复制的实现；具体 SDK API 应在实施时按已锁定的 Langfuse
Python v4 文档确认。

```python
from langfuse import get_client

langfuse = get_client()
dataset = langfuse.get_dataset("prale/harness-regression")

async def task(*, item, **_):
    # 每个 item：独立临时工作目录、MemoryStorage/临时 SQLite、受限工具。
    result, trace = await run_harness_in_sandbox(item.input)
    return {
        "answer": result.final_text,
        "terminal_status": result.status,
        "tool_calls": trace.safe_tool_summary,
        "generation_count": trace.generation_count,
    }

def required_tools(*, output, expected_output, **_):
    required = set(expected_output.get("required_tools", []))
    used = {call["name"] for call in output["tool_calls"]}
    return {"name": "required_tools", "value": float(required <= used)}

result = dataset.run_experiment(
    name="prale harness regression",
    task=task,
    evaluators=[required_tools, terminal_success, answer_contract],
    metadata={"git_sha": GIT_SHA, "provider": "deepseek", "model": MODEL},
)
print(result.format())
langfuse.flush()
```

如果 SDK 的 experiment runner 不接受 async task，应由脚本在 event loop 外包装同步入口；
不要为迁就 runner 而改变 Harness 的 async API。任何实验运行结束时都要 flush，确保短命
进程的 trace 已送达。

## 测试、验证与回滚

### 自动化测试

- 单元：sanitizer 对嵌套 secret、Bearer、绝对路径、超长文本、`details` 和未知 JSON 的
  行为；开关/配置校验；队列溢出策略；SDK fake 收到的 observation 映射。
- integration：一轮无工具、带工具、多 generation、并行工具、provider retry、provider
  异常、工具异常、取消、崩溃后 unknown 收束；断言本地持久状态与未接入时完全等价。
- crash recovery：在 provider/tool intent 后、effect 后、settlement 前中断，断言 exporter
  不会触发 effect 或重放，恢复语义保持原有测试的期望。
- deployment：无 extra / tracing off 能启动；tracing on + 凭据从环境或文件读取能启动；
  mock exporter drain/flush 在优雅退出被调用。
- experiment：对固定 fake provider 和只读 fixture tool 的小 Dataset，断言每项都有 output
  和全部确定性分数。

### 人工验收

1. 发一个普通提问，确认一条 `prale.run` agent trace、一个 generation、正确 session 分组；
2. 发一个两次 generation、一次工具调用的请求，确认 tree 的嵌套和每一步 usage；
3. 强制 provider 失败并重试，确认 attempts 分离，且错误不会被标为成功；
4. 停止/恢复一个处于 effect_pending 的进程，确认 PRALE 显式 unknown，遥测没有诱导重放；
5. 检查 trace 原始 JSON：无 API key、cookie、文件正文、绝对工作路径或禁止字段；
6. 在同一 Dataset 版本上完成 baseline/candidate 对比并查看任一退化项的完整 trace。

### 回滚

设置 `LANGFUSE_TRACING_ENABLED=false` 即停止新上报，不触碰 Session SQLite 数据和恢复能力。
若发现隐私问题，先关闭开关并撤销/删除受影响的 Langfuse project 数据，再修复 sanitizer；
不要通过迁移或重写 PRALE 的持久记录来“清理”远端 telemetry。

## 决策记录

### 背景

PRALE 是可恢复的本地 Agent runtime。其 effect intent、settlement 与 crash recovery 不能
被可失败的第三方遥测系统耦合。

### 决策

Langfuse 采用可选、异步、best-effort integration adapter；runtime 发布 provider-neutral
事实 DTO，adapter 在队列 worker 中完成脱敏和 Langfuse SDK 调用。每个 Operation 是一个
agent trace，每个 provider/tool attempt 是单独的 generation/tool observation。

### 后果

实现比简单的 `@observe` 装饰器多一个适配层和测试成本，但保持依赖方向、可靠性与隐私
边界。Langfuse 可能短暂缺少 trace 或留下未关闭观察；这是可接受的可观测性降级，不能
影响 PRALE 的业务结果。

## 参考资料

- Langfuse Python tracing 与配置：<https://langfuse.com/docs/observability/get-started>
- 手工 observation、属性传播和 trace input/output：<https://langfuse.com/docs/observability/sdk/instrumentation>
- Agent trace 的结构与命名实践：<https://langfuse.com/docs/observability/best-practices>
- 观察类型（agent、generation、tool 等）：<https://langfuse.com/docs/observability/features/observation-types>
- Dataset / SDK experiments：<https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk>
- Code evaluator 与 observation/experiment 范围：<https://langfuse.com/docs/evaluation/evaluation-methods/code-evaluators>
