# 仓库探索工具设计

## 1. 目标与范围

本设计为 PRALE 增加一个**按需调用**的仓库探索工具。它帮助 Agent 在修改代码前快速回答：某个功能位于哪些文件、关键符号在哪里定义、哪些模块引用它、应优先阅读哪些局部实现。

它借鉴 `/root/vibe/CoLe/aider` 的 RepoMap 思路：从源码提取 definition/reference 标签，构建文件间引用图，以个性化 PageRank 排序，再在确定 token 预算内渲染关键文件和代码行。它**不是**把仓库地图自动拼入每次 LLM 请求的 prompt。

首个完整交付聚焦于**以明确 identifier 或已知代码为种子的引用导航**：本机已配置项目根目录内的只读源码探索、多语言语法标签、路径/标识符聚焦、固定 wire 输出预算、进程外 tag 缓存，以及在普通工具调用协议下的崩溃恢复。模糊 `query` 是辅助提示，不能替代 identifier 排序。

不在范围：

- 从任意用户提交路径读取、跨项目探索或把 `repository_id` 当作文件系统权限；
- 让 runtime/domain 依赖 tree-sitter、git、图算法库或 aider；
- 自动向每一轮 provider context 注入仓库地图；
- 以 RepoMap 取代 `read`、`bash` 或对当前工作树的验证；
- 将索引结果写入 Session、长期记忆或 Skill 资产作为仓库当前状态的权威副本。

## 2. 术语与不变量

| 术语 | 含义 | 非含义 |
| --- | --- | --- |
| 仓库索引（Repository Index） | 给定一个项目 checkout 与版本指纹后，可重建的源码标签和引用图 | Session 状态、长期记忆、工作树真相的持久副本 |
| 仓库地图（Repository Map） | 由仓库索引按一次请求的焦点和预算导出的紧凑视图 | 每轮隐式 prompt 前缀 |
| 探索快照（Exploration Snapshot） | 某次调用实际输出的路径、片段和其内容指纹 | 全仓库的原子快照或对后续调用仍然新鲜的承诺 |
| 工作区根（workspace root） | 服务端 `ProjectRuntimeConfig.project_root` 规范化后的允许读取根 | 模型可覆盖的参数或稳定仓库身份 |

以下不变量必须成立：

1. 只有服务端配置的 `workspace root` 决定可读取范围；所有相对路径在 resolve 后必须仍位于该根目录内。
2. 探索结果是一次普通、持久化的 tool result，只能经所在 branch 的正常上下文投影与 compaction 参与后续 provider request；它不得成为跨 branch 或每轮自动注入的全局隐式上下文。
3. 索引与缓存均非权威数据。任何 edit、测试或结论都必须以当前 checkout 的 `read`/验证工具结果为准。
4. 该工具不写工作树、不执行项目代码、不访问网络；其可恢复重放语义为 `safe`。
5. 缓存未命中、索引失败、符号不存在和输出截断必须显式返回状态，不能伪造完整或新鲜的地图。
6. “一致”只保证最终输出的每个源码片段与其记录的内容指纹一致；不承诺索引期间全仓库未改变。未输出文件的并发变化不得迫使一次昂贵的全仓重扫。

## 3. 位置与依赖边界

```text
api/deployment composition
       │  仅按服务端配置注册
       ▼
integrations/repository_explorer.py
       ├─ RepositoryExplorerTool       # AgentTool adapter
       ├─ RepositoryIndexer            # tags / graph / ranking protocol
       ├─ TreeSitterRepositoryIndexer  # 可选依赖实现
       └─ RepositoryTagCache            # 受控、checkout 外的 tag 缓存
       │
       ▼
runtime.tools.AgentTool                # 不知道索引细节
       │
       ▼
domain/                                # 不导入任何上述模块
```

`RepositoryExplorerTool` 与现有 `ReadTool` 同属 `integrations/`：它实现 `name`、`description`、`input_schema`、`replay_policy` 和 `async execute()`，但 runtime 只能看见 `AgentTool` 协议。生产依赖（如 tree-sitter/grep-ast）放进新的可选 extra，例如 `repository-explorer`；未安装时由 deployment composition 拒绝启用该工具，而不是在 core package 中静默降级。`Settings.from_environment()` 必须仍能解析并打印配置，保持 `--print-config` 不要求安装 optional extra 的既有语义。

不得直接 import aider 的 `RepoMap` 作为生产实现。aider 的实现同时耦合 CLI `InputOutput`/spinner、模型 token counter、`.aider.tags.cache.*` 工作树缓存和其刷新策略。PRALE 可以实现小型、确定性的 PageRank，避免为此引入 `networkx`；若复制任何 aider 源码或标签查询，必须保留 Apache-2.0 归属与许可通知。PRALE 的 adapter、DTO、缓存位置和错误模型必须由本设计定义。

tree-sitter 的每种语言标签查询（`.scm`）是实现的一部分，必须作为 wheel package data 随 `agent_harness` 分发，并以 `importlib.resources` 加载；不得依赖源码 checkout 中的相对路径。每次查询变更都要提升 `indexer_version`，使旧 tag cache 失效。

## 4. 工具契约

工具名称为 `repository_explore`，描述应明确它用于“由 identifier 或已知代码定位关联实现”。描述还必须说明：已知精确文件路径时用 `read`；已启用 `bash` 且能用一次精确搜索定位时不调用本工具；它永远不设置 `terminate=true`。

```json
{
  "type": "object",
  "properties": {
    "identifiers": {"type": "array", "items": {"type": "string"}},
    "known_paths": {"type": "array", "items": {"type": "string"}},
    "focus_paths": {"type": "array", "items": {"type": "string"}},
    "path_prefixes": {"type": "array", "items": {"type": "string"}},
    "query": {"type": "string", "description": "可选的功能描述，只用于辅助路径/标识符提示"},
    "include_tests": {"type": "boolean", "default": true},
    "max_tokens": {"type": "integer", "minimum": 256, "maximum": 6000, "default": 4000}
  },
  "additionalProperties": false
}
```

- 调用至少提供 `query`、`identifiers`、`known_paths`、`focus_paths` 或 `path_prefixes` 中的一项；完全空范围被拒绝。仅有 `query` 时允许受扫描上限约束的全仓退化探索：从描述提取有限候选词，并优先返回项目入口和匹配路径，帮助 Agent 获得下一次 identifier 调用所需的符号名。
- `identifiers` 是第一优先级信号：它表示模型或用户已知、希望反查定义和引用的符号。`query` 只提取有限的候选词作为低权重辅助，既不是 shell，也不是正则或路径；它不能伪装成精确引用分析。部署可维护一个版本化、受限的自然语言概念提示表（例如 `记忆模块`/`记忆` 展开为代码词 `memory`），以便中文功能描述能匹配路径和符号名；该表不是语义检索、翻译服务或 LLM 总结，未收录概念不得产生臆测性匹配。
- `known_paths` 表示模型已读或当前正在修改的普通文件：它们是图排序种子，**绝不**被渲染到地图中。`focus_paths` 表示模型希望首次展开的普通文件，可被渲染；两者不可混用。`path_prefixes` 只提升 personalization，绝不裁剪发现或候选范围。
- 所有路径均为根目录相对路径。越界、NUL、绝对路径、根外 symlink 和不存在路径均返回参数错误。
- 输入在 intent 前规范化、去重并限制大小：`query` 最多 1,000 UTF-8 字节；每个数组最多 32 项；identifier 最多 256 字节、路径最多 1,024 UTF-8 字节。空字符串和同一文件同时出现在 `known_paths`/`focus_paths` 是参数错误。
- `max_tokens` 限制的是 provider 实际收到的完整 tool message：`json.dumps({"content", "is_error", "details"})` 的估算 token 总和，而非仅 Markdown `content`。估算器必须在最后序列化结果上计数并保守留余量；没有精确 tokenizer 时返回 `token_estimate=true`。

成功的 `content` 是紧凑、可读的 Markdown 地图，并在正文内包含选中路径、符号、行号、短 revision 和截断提示。`details` 由于会被 provider 看见，只可包含不能实用地放入正文的极小元数据：

```json
{"truncated": false, "token_estimate": true}
```

不得在 `details` 重复 `selected_symbols`、渲染正文、完整 fingerprint、绝对路径、缓存路径或未选择的符号全集。无匹配、部分可解析、预算截断是成功且在正文标明的结果；根目录不可读、索引器不可用、参数无效或输出文件在渲染中改变为 `is_error=true`。工具结果的最大 token 限制包含这些错误结果的诊断文本。

## 5. 索引、排序与渲染

### 5.1 文件发现与标签

发现器从 `workspace root` 开始，遵循部署指定的忽略规则（至少 `.git`、**实际配置的** repository-index cache、依赖/构建产物的默认排除），只接纳 resolve 后仍在根内的普通文件，并设置文件数、单文件字节数、总字节数和扫描时间上限。任一上限被越过时返回 `repository_scan_limit_exceeded`，不得以未说明的部分图伪装成完整排名。`path_prefixes` 不是扫描裁剪：引用图依赖全局 reference 分布，首次调用或 cache 冷启动必须对所有合格文件 `stat`，并读取/解析全部缺失或改变的文件；其成本与仓库规模成正比，扫描上限正是为此设置。`include_tests=false` 是唯一可从发现集排除的一类约定路径：目录名 `test`、`tests`、`__tests__`，或文件名 `test_*`、`*_test.*`、`*.test.*`、`*.spec.*`。符号提取优先使用 tree-sitter 查询的 `definition` 与 `reference` 标签；不支持的语言只产生文件节点，绝不把文件当作可执行文本处理。

每个标签是 `(relative_path, name, role, symbol_kind, line)`：

- `role` 只能为 `definition` 或 `reference`；
- `symbol_kind` 只能为 `class | function | method | interface | constant | variable | module | type | unknown`。它由标签查询的具体 capture 导出；不支持或无法可靠分类时为 `unknown`；
- `line` 是**1-based** 的名称节点起始行（例如多行 Python 签名中函数名所在行），不是语法构造的首行。定义片段以此行作为中心，正文展示同一个 1-based 行号，使 Agent 可直接将它传给 `read(offset=...)`。

索引器可以对仅有 definition 的语言做受限 lexical reference 回填，但必须标记为低置信度，不能把字符串匹配当成确定调用边。

### 5.2 图与排序

对同名 reference/definition 建立 `referencer file → definer file` 的带权边，采用确定性的个性化 PageRank 选择候选。首个交付使用以下明确、可测试的 aider 风格权重：

| 信号 | 边权修正 |
| --- | --- |
| identifier 精确等于 `identifiers` 中的一项 | ×10 |
| snake/kebab/camel 且长度至少 8 | ×10 |
| 名称以 `_` 开头 | ×0.1 |
| 同名 definition 多于 5 个 | ×0.1 |
| reference 来自 `known_paths` | ×50 |
| 同一 referencer 对同一 identifier 的重复次数 | `sqrt(count)`，不线性累加 |
| lexical 回填得到的 reference | 再 ×0.1，且在正文标记低置信度 |

`focus_paths` 与 `path_prefixes` **只提升**相关文件的 personalization，绝不限制发现或图构建范围；否则符号的真实定义可能被错误排除。只有 `known_paths` 获得“已知上下文”的 ×50 引用边。测试文件只在 `include_tests=true` 时加入，且默认 personalization 低于生产代码。

图构建的兜底顺序固定为：① 全图没有任何 reference 时，以 definition 集合构造 fallback references；② 对每个没有入边的 definition 添加**边权** `0.1` 的自环（此值与上表的 identifier 倍率无关），防止 PageRank 悬空并保留定义-only 文件；③ 仍没有任何图节点时，以稳定路径顺序追加文件级候选和根目录重要文件。首期 `ROOT_IMPORTANT_FILES` 是版本化精确名称表：`.gitignore`、`README`、`README.md`、`README.rst`、`CONTRIBUTING.md`、`LICENSE`、`LICENSE.md`、`LICENSE.txt`、`pyproject.toml`、`setup.py`、`setup.cfg`、`requirements.txt`、`package.json`、`tsconfig.json`、`go.mod`、`Cargo.toml`、`pom.xml`、`Dockerfile`、`docker-compose.yml`、`Makefile`、`pytest.ini`。它只匹配根目录；唯一目录例外是 `.github/workflows/*.yml`，不能以 README/后缀 glob 匹配任意深度的文件。扩展该表必须修改此规格并新增固定 fixture 测试。

### 5.3 预算渲染

候选可以是符号级 `(file, symbol)`，也可以是文件级 `(file)`。符号级候选渲染“路径 + 以定义名称行（§5.1）为中心的最小语法上下文”；文件级候选只输出一个标记为“未展开”的相对路径，不输出源码、行号或 content hash。它用于 identifier 未匹配、没有可解析标签或图为空时，让 Agent 仍能选择下一步 `read` 目标。

若请求含 `identifiers` 但其中没有任何一项精确匹配 definition，正文必须先声明 `identifiers_not_found`，且不得用无关的高 rank 符号伪装匹配结果；此时仅输出由 `path_prefixes`/`query` 命中的路径、根目录重要文件和稳定路径 fallback 组成的有界文件级候选。未命中的 identifier 可仅作为**文件名路径提示**参与这组文件候选的排序，正文必须明确它不代表符号匹配；不得据此渲染符号或源码片段。若只部分 identifier 未匹配，正常输出匹配的符号级候选，并在正文逐项列出未匹配名称。

rank 只决定哪些候选能进入预算；入选成员固定按 `(relative_path, line, name)` 渲染，同一文件内按行号排序，文件级候选排在该文件的符号前。排除全部 `known_paths`。先为每个候选文件建立至多 120 字符/行的片段，再以递减打包选择不超过 `max_tokens` 的最大候选集；候选片段的 token/字节增量必须只计算一次、以 prefix sum 或等价增量预算选择成员，不能对每增加一个候选重复序列化完整 JSON。仅对最终候选集（及至多一次截断调整）执行完整 `json.dumps` 和 tokenizer 校验。相同文件状态与请求必须产生稳定结果，单文件不能独占全部预算。

工具的完整 wire JSON UTF-8 编码还必须不超过 **50 KiB**，`content` 不超过 **1,600 行**，两项均包含任何截断说明；任一限制先到即截断。部署给出 `max_tokens` 的硬上限，默认值为 4,000，首期上限为 6,000；工具说明必须提醒该结果作为 branch entry 会参与后续上下文，应优先用 `identifiers` 做窄查询。所有 token、字节和行限制也适用于错误结果。

渲染每个入选的**符号级**文件时重新读取其内容，并把 `(relative_path, content_hash)` 写入正文的短快照标记；读取后再次 `stat`/hash，若该文件变化则最多重新执行一次请求，仍变化时返回 `workspace_changed_during_render`。文件级候选不含源码，渲染时只确认路径仍存在，不需要二次内容 hash。这是对**输出源码**的 TOCTOU 保证，不要求为证明未选择文件未变而二次读取全仓。结果开头必须包含短 revision 与“仅为探索导航，请读取目标文件确认”的提示。若有未纳入的高排名文件，输出有限的路径列表和截断原因，使 Agent 可以再调用更窄的请求。

## 6. 新鲜度、缓存与并发

### 6.1 首期仅缓存文件标签

首个交付只实现 **文件标签缓存**，不实现最终地图/导出缓存，也不实现 single-flight。缓存键为 `(relative_path, content_hash, parser_version, query_version)`，值为标签或不可解析标记。这样先验证高价值、低风险的“避免重复 tree-sitter 解析”；同一请求的最终排序和渲染始终从当前标签集计算，避免缓存一份很快失去上下文意义的地图。冷启动时 manifest 为空，故所有合格文件都会被读取并 hash；暖启动只读取 stat 改变或未见过的文件。

每次发现文件只做廉价的 `stat(size, mtime_ns)`。若它与 cache manifest 相同，则复用已存 content hash 和标签；若不同或不存在，才读取内容、计算 hash 并更新标签。内容 hash 是权威身份，`stat` 只是不读取未变文件的预筛。缓存可采用 SQLite 或 content-addressed 文件，必须有容量上限、LRU/TTL 回收，损坏条目视为 miss；读写缓存失败只能退化为重新解析，不能使工具失败。

缓存目录由 `PRALE_REPOSITORY_INDEX_DIR` 显式配置，启动时 resolve 后必须**不在** `project_root` 内；工具启用但该变量未配置即为 deployment composition 错误。不可把默认 `PRALE_DATA_DIR` 当作安全位置，因为当前默认值可以是 `$PROJECT_ROOT/.prale`。发现器使用实际 resolve 后的缓存目录生成忽略规则，绝不硬编码 `.prale`。

### 6.2 Revision 与局部 TOCTOU

若 Git 可用，正文的短 revision 标记可包含 `HEAD`；它只帮助人理解，不可单独作为缓存键。有未提交改动或非 Git 目录时，输出的可信版本标识是每个**实际渲染文件**的 content hash，而不是全仓 worktree fingerprint。

索引期间其他文件变化可能使“下一次最优排序”不同，但不影响本次已验证输出片段的正确性；工具不得声称返回全仓原子快照。§5.3 的二次读取仅覆盖入选并要输出的文件，最坏成本为渲染文件数的两次读取，而非全仓二次 hash。

### 6.3 首期并发策略

所有阻塞的发现、解析和图计算在 `asyncio.to_thread` 或受控 executor 中运行，不能阻塞 Drive event loop。首期依靠 deployment 的索引并发上限保护资源；相同请求允许重复构建。只有在 profile 证明同请求并发重复是瓶颈后，才增加 single-flight；届时它是实现优化，不改变 tool result、恢复或缓存语义。

## 7. Harness 执行、持久化与恢复

`repository_explore.replay_policy = "safe"` 的理由是它只读取配置根目录和受控缓存；相同 durable arguments 可以重新执行。它仍完全遵循现有工具四阶段协议：

```text
已验证且规范化参数
  → durable tool intent + EffectSpan(pending)
  → 执行索引/读缓存
  → 原子写入 tool result、span outcome、operation state
```

进程在 effect 后、settlement 前中断时，recovery 将旧 span 原子收束为 `unknown/interrupted`，再以新 attempt 重放该工具；不得从未结算的内存索引结果拼造 tool result。由于工具结果本身可能很大，仍适用 Session 的条目持久化、上下文投影和 compaction 策略；tag cache 不是恢复所需的权威数据。

工具调用相互独立可被 runtime 并发调度。它与 write/edit/bash 并发时无法冻结整个工作树，因此仅在实际渲染的文件变化时按 §5.3 明确拒绝结果；不通过给读取工具加全局写锁来牺牲所有交互吞吐。

## 8. 部署与权限

`PRALE_TOOLS` 增加显式名称 `repository_explore`，默认仍不开启；实现时必须同时扩展现有 `BUILTIN_TOOLS` 白名单和 tool composition，不能只修改环境变量文档。启用时 deployment 必须：

- 已配置并验证 `project_root`，且将其作为唯一读取根；
- 安装 `repository-explorer` optional extra；缺失时在 `build_application()` 失败，而不是破坏 `--print-config`；
- 配置 checkout 外的 `PRALE_REPOSITORY_INDEX_DIR`、容量/TTL、扫描限制、索引并发上限和最大允许导出 token；
- 在 `--print-config` 仅报告开关和数值，不回显绝对缓存路径或源码内容。

首期环境变量为 `PRALE_REPOSITORY_INDEX_DIR`、`PRALE_REPOSITORY_MAX_FILES`、
`PRALE_REPOSITORY_MAX_FILE_BYTES`、`PRALE_REPOSITORY_MAX_TOTAL_BYTES`、
`PRALE_REPOSITORY_MAX_SCAN_MS`、`PRALE_REPOSITORY_MAX_EXPORT_TOKENS`、
`PRALE_REPOSITORY_CACHE_ENTRIES`、`PRALE_REPOSITORY_CACHE_TTL_MS` 与
`PRALE_REPOSITORY_MAX_CONCURRENT_INDEXES`。`repository-explorer` extra 必须安装
与 grammar bindings 兼容的 `tree-sitter`（当前范围 `>=0.23,<0.26`）；0.26 在部分
bindings 的 query cursor 上会使解释器崩溃，不能作为部署可接受的静默升级。

工具不得调用 shell、Git hook、语言服务器、网络 API 或用户仓库中的代码。Git 仅可通过受控库或受限子进程读取 HEAD；其失败退化到 content fingerprint，不能导致探索越界。符号名、源码注释和 README 都是非可信输入，输出时仅作为数据呈现，不能变成 tool schema、系统指令或配置。

## 9. 实施阶段与验收

| 阶段 | 交付物 | 验收 |
| --- | --- | --- |
| 0 | DTO、`BUILTIN_TOOLS`/composition 接线、可选依赖与 fake indexer | 未装 extra 时 core 可导入；`--print-config` 可用；未启用不影响现有部署 |
| 1 | 文件发现、containment、checkout 外 tag cache | 越界/`..`/根外 symlink/二进制/超大文件被拒或跳过；超出扫描限制明确失败；冷启动全量解析、暖启动仅 hash 变化文件 |
| 2 | 引用图、明确权重剪枝、预算打包与 package data | identifier 命中定义进入 top-N；高频 `__init__`/`run` 不占预算；1-based 名称行可直接传给 `read(offset=...)`；`.scm` 在 wheel 中可加载；渲染文件两次读内完成 |
| 3 | `RepositoryExplorerTool` 与部署注册 | provider wire 的 `content + details` 合计不超 token/50 KiB/1,600 行限制；`terminate=false`；intent/effect/settlement 与 `read` 一致 |
| 4 | 局部新鲜度与恢复 | 输出文件并发改变、intent 后/effect 后/settlement 前崩溃与 safe 重放均有测试 |

至少新增：

- unit：参数规范化/大小限制、`known_paths` 排除、路径 containment、tag 的 1-based 名称行与 symbol kind、rank tie-break、具体权重、wire token/字节/行预算截断、stat/hash cache manifest；
- integration：包含生产代码/测试代码/重复符号的 fixture，验证 identifier 驱动的调用后能定向 `read`；验证 path prefix 不裁剪全图、未匹配 identifier 仍返回文件级候选；
- conformance：工具注册、JSON-safe result、缓存损坏退化、optional extra 缺失时 composition 失败但 `--print-config` 可用；
- crash-recovery：intent 后、tag-cache 命中/未命中 effect 后、settlement 前终止，验证旧 span 为 `unknown` 且 safe attempt 可重放；
- security：绝对路径、`..`、指向根外的 symlink、超大/二进制文件、恶意 query/符号文本和工作树并发改动。

## 10. 架构决策记录

### ADR-REPO-001：仓库地图作为按需工具结果，而非隐式上下文

**背景：** aider 的 RepoMap 能高效建立项目全局感知，但若在每轮请求自动注入，会在任务无关时消耗 token；地图内容变化也会改变 provider 的请求前缀，降低 prompt cache 命中。

**决策：** PRALE 仅暴露 `repository_explore` 工具。模型根据任务自行调用，返回内容经标准 tool-result entry 按所在 branch 的正常投影参与后续上下文；不保存为每轮自动注入的全局 prompt 段。

**后果：** Agent 首次探索需主动发起一个工具调用，但无关请求保持更短、更稳定；新鲜度的成本只在确有探索需求时支付。

### ADR-REPO-002：首期使用 checkout 外的增量 tag 缓存，并只验证输出文件

**背景：** RepoMap 的标签/地图缓存能显著降低重复解析成本，但向 checkout 写缓存污染用户仓库。全仓内容 hash 与双全量扫描虽严格，却会让每次调用重复承担缓存本应避免的 I/O；另一方面，模型真正需要可信的是被输出的代码片段。

**决策：** 启用工具时必须显式配置 checkout 外的缓存目录。以 `(size, mtime_ns)` 预筛、以 content hash 为 tag cache 权威键；首期不缓存最终地图。仅在输出文件的渲染前后验证内容 hash，并将其写入探索快照。

**后果：** 未输出文件的并发变化可能影响下一次排序、不会令本次结果成为“全仓原子快照”；换来不污染工作树、避免全仓二次 I/O，且不交付内容已变化的源码片段。

### ADR-REPO-003：复用 aider 的算法思想，不耦合 aider 运行时

**背景：** aider 已验证语法标签、引用图和 PageRank 对代码探索有效，但其 `RepoMap` 与 CLI I/O、模型对象、工作树 diskcache 及刷新策略耦合，直接依赖会破坏 PRALE 的 integration 边界和可选依赖策略。

**决策：** 在 PRALE `integrations/` 定义独立协议与实现，使用自有的确定性 PageRank 和随 wheel 分发的 `.scm` 查询；可审计地移植必要算法，并遵守来源项目 Apache-2.0 的 notice 要求。

**后果：** 初期需要维护少量适配代码和测试 fixture；换来 core 纯净、部署可控和明确的缓存/错误/恢复语义。

### ADR-REPO-004：工具预算按 provider wire payload 计算

**背景：** 当前 provider adapter 将 `ToolExecutionResult.content`、`is_error` 和可选 `details` 一并 JSON 序列化后发送给模型；只限制 Markdown 正文会低估真实上下文花费。

**决策：** `max_tokens` 限制最终完整 tool message 的估算 token 数。探索工具把导航信息放入正文，`details` 仅保留极小状态字段，并将序列化包装、错误提示和截断说明全部计入预算。

**后果：** 工具实现必须在最终渲染后再做预算检查，且可用正文略少；换来可验证的上下文上限和无重复 JSON 噪声。
