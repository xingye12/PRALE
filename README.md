# PRALE Agent Harness
对话：
![alt text](PRALE/images/conversation.png)
轨迹：
![alt text](PRALE/images/trajectory.png)
记忆：
![alt text](PRALE/images/memory.png)
技能：
![alt text](PRALE/images/skill.png)
Python 版、可持久化的Agent Harness。Session 是可恢复执行边界；entry、usage、lane state 与 operation state 都通过 Storage transaction 持久化。

PRALE 面向需要持续对话、调用工具和在进程重启后恢复工作的 Agent 应用。项目以可独立嵌入的 Python library/runtime 为核心，并提供 Web UI 与服务适配层，可用于搭建本地代码助手、仓库探索和多 Agent 委派工作流。

## 主要能力

- **持久化执行与恢复**：以 Session、Lane 和 Operation 管理对话与执行状态，使用 SQLite 保存历史、工具调用意图和结果，明确处理中断后的未知结果。
- **工具与仓库探索**：提供文件读写、精确编辑、Shell 执行，以及可选的源码符号与引用关系索引。
- **上下文与长期记忆**：支持上下文压缩、历史导航、会话检索，以及从执行归档逐层提炼的仓库记忆和全局经验；记忆晋升需要配置提取器与提示词。
- **Skill 与 Subagent**：管理可复用 Skill，支持独立历史的子 Agent、后台委派、续跑与可选 Git worktree 隔离。
- **Web 与可观测性**：提供浏览器交互界面、传输无关的 RPC 接口，以及可选的 Langfuse 追踪和数据集评测。

## 安装

需要 **Python 3.12 或更高版本**，在仓库根目录执行：

```bash
python -m pip install -e .
```

按需安装可选依赖，例如 `python -m pip install -e '.[web,subagents]'`。`web` 用于 Web 服务，`subagents` 用于加载 Markdown 子 Agent 定义；`repository-explorer`、`embedding` 和 `langfuse` 分别用于源码索引、本地向量检索与追踪。

Web 部署的配置示例与启动方式见 [deploy/web.env.example](deploy/web.env.example)，启动脚本为 [deploy/start-web.sh](deploy/start-web.sh)。

## 项目结构

| 目录 | 职责 |
| --- | --- |
| `src/agent_harness/domain/` | 领域模型与契约，保持纯净依赖边界 |
| `src/agent_harness/runtime/` | 执行循环、工具调度、重试和子 Agent 运行时 |
| `src/agent_harness/storage/` | SQLite 等存储实现 |
| `src/agent_harness/api/` | Python API、服务接口与部署入口 |
| `src/agent_harness/integrations/` | 模型、工具、检索、追踪等外部集成 |
| `src/agent_harness/memory/` | 长期记忆处理与晋升运行时 |
| `src/agent_harness/web/` | Web UI 静态资源 |
| `specs/` | 架构约束、实现方案与设计决策 |
| `tests/`、`evals/` | 自动化测试与评测数据集 |


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

`agent_harness.integrations.create_builtin_tools(working_directory)` 提供 `read`、`write`、`edit`、`bash`。相对路径以工作目录解析，绝对路径也允许；这不是文件系统沙箱。`read` 支持文本分页和 JPEG/PNG/GIF/WebP/BMP 的 base64 structured details；`write` 创建父目录；`edit` 要求原始文件中每项精确匹配一次且互不重叠，并保留 BOM 与换行风格；`bash` 合并 stdout/stderr，支持 timeout、取消时进程组终止，以及 2,000 行/50 KiB 尾部截断。

其中只有 `read` 是恢复时可自动重放的 `safe` 工具。文件写入、编辑和 shell 命令均为 `never`：若进程在 effect 后、持久化结果前中断，恢复会显式记录结果未知，而不会重新执行可能已生效的命令。

## 服务适配

核心库不绑定 HTTP 框架。`HarnessRpc` 提供传输无关的 JSON-RPC-shaped dispatch；`AuthenticatedHarnessService` 叠加可替换认证与可关闭的远程订阅，供 WebSocket、SSE 或 TUI 外壳使用。认证凭据和连接状态不会写入 Session。

## Subagent

默认开启的本地 Subagent 使用同一 Session 内的独立历史，支持 `general-purpose`、`explore`、`plan`、自定义定义、前台/后台、查询、停止与续跑。子工具权限只收缩；Explore/Plan 不开放 Bash 或写入工具。父显式取消会级联取消其子运行；等待超时、断开或父正常结束不会取消后台运行。

```python
from agent_harness import SubagentConfig, SubagentRequest
from agent_harness.runtime.subagents import MappingProviderResolver, create_subagent_tools

harness = await Harness.open(
    "session-1", storage,
    tools=create_subagent_tools(),  # 模型可委派；普通工具按需加入此 tuple
    subagent_config=SubagentConfig(enabled=True),
    provider_resolver=MappingProviderResolver({"default": provider}, "default"),
)
lane = await harness.acquire_lane("main")
parent = await lane.prompt("分析项目")
child = await harness.start_subagent(
    "main", parent.operation_id,
    SubagentRequest("检查架构", "架构检查", "plan", run_in_background=True),
    idempotency_key="architecture-review",
)
result = await harness.wait_subagent_run(child.run_id, timeout_ms=30_000)
# result.retrieval_status == "timeout" 时，子运行仍可继续。
# 显式停止：await harness.stop_subagent_run(child.run_id)
await harness.close()  # 停止本地执行器；保留持久恢复状态
```

部署默认启用 runtime，未设置 `PRALE_TOOLS` 时默认提供 `subagent`、`subagent_continue`、`subagent_output`、`subagent_list`、`subagent_stop`。显式 `PRALE_TOOLS` 列表完全替代默认集合，空字符串禁用全部模型工具；`PRALE_SUBAGENTS_ENABLED=false` 关闭 runtime。Python library 默认启用 facade 与恢复，模型工具仍通过 `tools=create_subagent_tools()` 注册。后台结果进入父 inbox，空闲时不主动调用模型。重开已启用的 Harness 会恢复已接纳运行；缺失 provider 和不完整状态通过恢复报告显式列出。

默认共享工作区；请求或角色 Markdown frontmatter 可设置 `isolation="worktree"`。部署入口已配置本地 Git 适配器；library 用法需向 `Harness.open` 传入 `workspace_manager=GitWorkspaceManager(project_root)` 和 `workspace_tool_factory=LocalWorkspaceToolFactory()`（均位于 `agent_harness.integrations.workspaces`）。worktree 固定从父 HEAD 创建，不复制未提交或未跟踪文件，不 fetch、自动提交或合并。无产物时自动清理；有改动、ignored 文件或提交时保留，路径、分支、基准和错误见 `snapshot.workspace` / `result.workspace`。续跑固定沿用模式；保留副本复用，已清理副本从原基准重建。

自定义工具需提供 `for_workspace(workspace)` 返回独立绑定工具，或显式设置 `workspace_reusable = True`；否则隔离请求会报出具体工具名。内置文件、Bash 和仓库索引工具自动重绑定；memory/conversation/skill 维持逻辑作用域。worktree 是代码副本隔离，绝对路径和任意 Bash 命令仍可访问外部目录。

Python DTO 无额外依赖；显式配置 `PRALE_SUBAGENT_DIRS='["agents"]'` 加载 Markdown 时需安装 `.[subagents]`。文件不会自动发现、热加载或执行。完整持久化与恢复契约见 [Subagent 实现方案](specs/subagent-system-implementation-plan.md)。

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
