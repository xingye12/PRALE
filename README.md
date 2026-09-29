# PRALE Agent Harness

Python 版、可持久化的 pi-style Agent Harness。Session 是可恢复执行边界；entry、usage、lane state 与 operation state 都通过 Storage transaction 持久化。

## 最小示例

```python
from agent_harness.api.harness import Harness
from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.storage.sqlite import SQLiteStorage

storage = SQLiteStorage("session.sqlite")
harness = await Harness.open("session-1", storage)
lane = await harness.acquire_lane("main")

await lane.prompt("解释这个项目", operation_id="op-1")
provider = DeepSeekProvider(api_key="…", model="deepseek-flash")
result = await lane.drive(provider)
```

`prompt()` 先原子保存 operation 与 user entry；Drive 随后保存 provider effect intent，才会执行外部请求。若外部 outcome 在持久化前未知，恢复会明确收束为 aborted，而不会把它误当作未执行。

DeepSeek 使用 SSE 时，内容帧会发布为 `message_update` 并保存为短期 checkpoint；重启不会尝试续接旧 HTTP 连接。`recover()` 可不带 provider 收束未知 LLM outcome；若需要恢复 `safe` 工具后的下一轮生成，则传入 provider：`await lane.recover(provider)`。

## 核心 API

- `Harness.open(session_id, storage, tools=..., retry=...)`
- `Harness.acquire_lane(name)` / `Harness.subscribe(listener)` / `Harness.on_hook(name, handler)`
- `Lane.prompt()`、`queue_steer()`、`queue_follow_up()`、`compact()`、`navigate()`
- `Lane.drive(provider)`、`resume(provider)`、`recover()`、`request_abort()`、`snapshot()`、`watch()`

SQLite 是单机持久化后端，`MemoryStorage` 用于测试。工具可标记为 `safe` 或 `never`：前者在 interrupted effect 后允许 resume 重放，后者会记录未知 outcome 而不自动重放。

## 本地工具

`agent_harness.integrations.create_builtin_tools(working_directory)` 提供 pi 风格的 `read`、`write`、`edit`、`bash`。相对路径以工作目录解析，绝对路径也允许；这不是文件系统沙箱。`read` 支持文本分页和 JPEG/PNG/GIF/WebP/BMP 的 base64 structured details；`write` 创建父目录；`edit` 要求原始文件中每项精确匹配一次且互不重叠，并保留 BOM 与换行风格；`bash` 合并 stdout/stderr，支持 timeout、取消时进程组终止，以及 2,000 行/50 KiB 尾部截断。

其中只有 `read` 是恢复时可自动重放的 `safe` 工具。文件写入、编辑和 shell 命令均为 `never`：若进程在 effect 后、持久化结果前中断，恢复会显式记录结果未知，而不会重新执行可能已生效的命令。

## 服务适配

核心库不绑定 HTTP 框架。`HarnessRpc` 提供传输无关的 JSON-RPC-shaped dispatch；`AuthenticatedHarnessService` 叠加可替换认证与可关闭的远程订阅，供 WebSocket、SSE 或 TUI 外壳使用。认证凭据和连接状态不会写入 Session。

## 追踪与评测

`agent_harness.integrations.langfuse` 在每次 settlement 提交之后，把执行事实（operation 起止、每次 generation、每次 tool attempt）投影为 Langfuse observation。它订阅事实流，不参与 Drive 的判定：整条 trace 丢失也不改变 Session。默认关闭，需设置 `LANGFUSE_TRACING_ENABLED` 与两个 key 才启用（启动时只给开关不给 key 会被拒绝），并需要 `langfuse` extra。

`PRALE_LANGFUSE_CAPTURE` 决定多少正文可以离开本进程：默认 `metadata` 只上传长度、计数与哈希，不上传 prompt、消息、记忆或工具结果正文；`redacted` 上传去除秘密后的文本；`full` 原样上传。选择即出口，见 `deploy/web.env.example`。

`scripts/eval_harness.py` 用同一套环境变量把数据集跑成一次可对比的评测：每个 case 在自己的临时 workspace 与 SQLite session 中运行真实的 Agent（同一 Session、Drive、工具与 settlement 路径），再由 `agent_harness.integrations.evaluation` 从已提交的事实而非模型散文里打分。

```bash
python scripts/eval_harness.py --from-json dataset.json --report report.json  # 只本地运行，不上传
python scripts/eval_harness.py --from-json dataset.json --upload-to prale/harness-regression  # 建/更新固定集
python scripts/eval_harness.py --dataset prale/harness-regression             # 从 Langfuse 取物品并回传
```

`--upload-to` 把解析后的 case 逐个写进数据集（case id 即 item id，重复上传是更新而不是翻倍），写完即停，不打分；仓库里的 JSON 因此始终是「这个固定集是什么」的真相，Langfuse 是两次运行被并排比较的地方。`--run-name` 建议填 git sha 或 tag，配合 `PRALE_LANGFUSE_RELEASE` 才能看出是哪一版跑出的分数。

退出码即接口：0 已打分，1 有 gate 未达标（`--gate terminal_success_rate=0.9`），2 在任何模型调用之前被拒绝——数据集有歧义、scorer 或 gate 不可用、case 要求本次不授予的工具。`--dry-run` 只打印计划。打分口径与沙箱边界见 `src/agent_harness/integrations/evaluation.py`：`read`/`write`/`edit` 的路径被限制在 case 的临时工作目录内，但 `bash` 不是操作系统沙箱，因此写入类工具默认不授予，需要 `--allow-writing`。

## 验证

安装开发依赖后运行：

```bash
python -m pip install -e '.[dev]'
mypy
pytest
ruff check .
ruff format --check .
```
