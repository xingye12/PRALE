# Skill 自进化功能接入

## 1. 目的与边界

本功能让 Harness 从已完成的对话和工具执行中沉淀、演进可复用的 **Skill**。Skill 描述“如何完成一类任务”，包含 `SKILL.md`、可选资源文件和版本化元数据；它不是长期记忆的替代，也不是模型训练、自动修改 runtime、自动跨仓库共享经验或无审核地传播经验。

本设计接入 [长期记忆实现规范](long-term-memory-implementation-spec.md) 所定义的 repository scope、outbox、后台任务和审计原则，但 `SkillStore` 是独立资产库：L1 记忆的更新绝不能隐式改写 Skill，Skill Review 的失败也不能影响 L0--L3 晋升。

自动路径只允许新增或非破坏性更新。删除、撤销历史版本、变更可见性、跨 scope 发布 loadout、安装外部依赖，均须经独立的人工/资产管理流程。

### 1.1 自动创建的默认状态是 active

自动提炼创建的 Skill 默认状态为 **`active`**，不是 `draft`。这与参考实现一致：参考实现的 `skills` 表已移除 draft 状态并以 `DEFAULT 'active'` 建表，即自动沉淀的经验应当立即可用，而不是等待一个现实中不存在的审核队列。

由此产生的安全边界**必须**由另外两个属性承担，且二者都是自动路径不能修改的：

- `visibility` 初始且始终为 `private`——自动路径**不提供** `set_visibility` 动作；
- scope **必须**是提炼时的 `repository_id`（见 ADR-018），自动路径**不提供**跨 repository 写入。

因此“默认 active”的准确含义是：**该 Skill 对创建它的 repository scope 立即可用，对其他 repository 不可见**。这也意味着不存在“先创建再激活”的两步流程，`activate`/`disable`/`archive` 只作为人工资产管理动作存在。

## 2. Skill 合约与存储模型

一个 Skill 的逻辑结构如下：

```text
SkillAsset (skill_id: "skl-…")
├─ metadata: repository scope, visibility, state, tags, current_version
└─ SkillVersion (单调递增)
   ├─ SKILL.md        # frontmatter + 方法、限制、失败处理、验证
   ├─ manifest.json   # 资源清单及每项 SHA-256
   └─ files/*         # 可选脚本、模板、样例；全部版本化
```

`SKILL.md` frontmatter 必须含 `name`、`description`、`triggers`、`version`、`status`。正文必须覆盖：适用范围与不适用范围、前置条件、步骤、验证、失败/回滚处理、资源使用说明。`description` 与 `triggers` 用于 listing/search；完整正文只有在实际选中 Skill 后才加载。

`SkillScope` 与 `MemoryScope` 的归属字段一致且同源：只含一个稳定的 `repository_id`（由 `SkillScope.from_memory_scope()` 构造，`storage_key` 即 `repository_id`）。初版只允许在提炼时的 repository scope 内自动创建和修改私有 Skill，自动路径**不提供**跨 scope 写入。`visibility` 初始值为 `private`；`active | disabled | archived` 是 Skill 生命周期状态，自动提炼创建的默认状态为 `active`（见 §1.1）。`disabled`/`archived` 与任何 visibility 变更都是显式资产管理动作，而非 Review LLM 的权限。

SQLite 后端至少包含 `skills`、`skill_versions`、`skill_files`、`skill_archives`、`skill_extraction_jobs`、`skill_candidates`、`skill_audit`、Skill FTS 表和 `schema_migrations`。Skill 各表直接以 `repository_id` 建列，不保留旧三元组 identity 列（与记忆库的兼容列策略不同，Skill 库没有历史 identity 数据需要承载）。文件正文可存 SQLite blob 或由 content-addressed blob store 持有；不论实现如何，`SkillVersion` 提交必须原子地绑定 Markdown、manifest、文件 hash 和版本号。禁止通过可变工作目录把“当前文件”当作权威版本。

## 3. 在线接入：buffer 与归档

### 3.1 捕获时机

Skill buffer 只能消费已 terminal operation 的已持久化输入和结果。它的来源**必须**是长期记忆规范定义的 `SessionTraceArchive`，而不是 event bus、当前 provider context 或从可变 `OperationState` 临时读取的数据。默认使用 `conversation-v1` archive 中的 user/assistant/tool entries；启用 `execution-v1` TraceRecorder 后，Review 可额外看到脱敏的 intent、retry 和验证轨迹。绝不从流式未完成片段、`never` replay policy 的未知工具结果或未执行的计划中提炼成功方法。

在 operation terminal settlement 的同一 Session mutation 中，新增 `skill_capture_requested` outbox entry，引用冻结的 Session source IDs、terminal tip、operation ID 与 trace format；其语义与记忆 capture outbox 相同。Skill dispatcher **必须**消费已 materialize 的 `SessionTraceArchive`（可按 archive ID 等待/重试），以 `(scope, archive_id, payload_hash)` 幂等写入 session `SkillBuffer`，再独立标记 outbox delivered。若记忆和 Skill 同时启用，可在同一 Session transaction 追加两条 outbox；两条下游投递互不依赖，但二者必须引用同一个冻结 snapshot。

### 3.2 配置组合与依赖解析

`SkillStore` 的来源是 L0 `SessionTraceArchive`，而 L0 materializer 由 `MemoryRuntime` 拥有。因此存在一个**必须显式解决**的配置组合问题：`Harness.open` 接受独立的可选 `memory_runtime` 与 `skill_runtime`，但只配置 `skill_runtime` 时不产出任何 archive，Skill 将永久静默为空。

v1 的解析规则**必须**是 fail-closed：

| `memory_runtime` | `skill_runtime` | 行为 |
| --- | --- | --- |
| 未配置 | 未配置 | 现有 harness 行为不变，无 capture、无后台任务 |
| 已配置 | 未配置 | 仅记忆功能；capture/L0/晋升按配置运行 |
| 未配置 | 已配置 | **必须**在 `Harness.open` 阶段抛出配置错误，而不是静默不产出 Skill |
| 已配置 | 已配置 | 共享同一 L0 materializer 与同一冻结 archive |

只想要 Skill 而不想要记忆晋升的部署，**必须**配置 `memory_runtime` 并把 L1/L2/L3 晋升阶段关闭（capture 与 L0 materializer 保持启用）。这比在 `SkillEvolutionRuntime` 内复制一个 materializer 更好：两个 materializer 会让 L0 的身份、去重 key 和保留策略出现两套实现。

两条 outbox 的投递顺序无关，但**必须**由同一个 dispatcher 语义消费同一冻结 snapshot；`skill_runtime` 已配置但 `memory_runtime` 缺失时不得降级为“从 Session 直接读”。

### 3.3 归档阈值

Buffer 按 `(scope, session_id)` 维护消息字节数、成功 tool call 数和 turn 数。满足任一条件时原子封存为 immutable `SkillArchive` 并创建 extraction job：

- 成功工具调用数达到配置阈值（默认 **5**）；
- 脱敏后的累计字节数达到阈值（默认 **40 KiB**）；
- Session 显式关闭或删除；
- 管理/API 显式 `force_archive`；
- 单条内容超过限制时以压缩或分块策略封存。

归档**必须**返回 `tool_calls | bytes | session_closed | forced | oversize` 原因，并清空的只是当前 buffer 指针/计数，绝不能删除 archive。低质量、失败或无复用价值的内容可以被 Review 判定为 `no_op`，仍必须保留 archive 和结论审计。

不设空闲/超时触发。理由与 L1 相同：后台按时间推断“对话已结束”会与 Session 的 compaction、navigation 和 fork 竞争判断，而 `session_closed` 已覆盖“会话真的结束了但没到阈值”这一唯一真实缺口，且是完全可重现的显式事件。因此 `last_activity` 只作为 telemetry，不作为归档依据。

## 4. 异步 Review 与受控写入

每个 `SkillScope` 的 extraction jobs 必须串行 claim，避免自动任务并发修改同一资产；不同 repository scope 可并行。job 状态为 `scheduled | queued | running | retry_wait | dead_letter | completed`，须保存 archive ID、`not_before`、lease、attempt、prompt/version、候选 Skill IDs、动作输出 hash、错误类别和退避时间。与记忆任务一样，claim/lease takeover/完成/失败都必须 durable、幂等、可审计，且 `not_before` 与状态在同一事务持久化（见 ADR-014）。

Review 顺序如下：

1. 读取 archive，并按角色重建输入；工具调用和结果必须成对呈现，明确成功、失败和验证证据。没有 `execution-v1` trace 时，Review 不得声称知道实际重试次数、hook 决策或 provider payload。
2. 从归档生成少量高信号关键词，用 scope 过滤后的 FTS（可选 hybrid）检索候选 Skills。
3. 向 provider 中立的 `SkillReviewer` 提交 archive、候选摘要和严格输出 schema。
4. Reviewer 返回 `no_op`、`create`、`update` 或 `patch` 建议，以及可验证的完整内容/唯一补丁、预期版本和引用证据。
5. `SkillEvolutionRuntime` 本地校验 schema、frontmatter、资源路径、大小、敏感内容和版本，然后以乐观锁调用 `SkillStore`。
6. 成功写入新的 `SkillVersion` 与 audit；冲突时重新读取当前版本，最多一次重新 review，之后进入 retry/dead-letter，绝不能静默覆盖。

Review LLM **不得**直接使用数据库、文件系统、shell、网络或删除工具。它只可通过受控 DTO 相当于以下动作：

| 动作 | 约束 |
| --- | --- |
| `skill_list` / `skill_view` | 仅能读取调用 scope 已授权的元数据或版本 |
| `skill_create` | 写入 `active` + `private`；名称、frontmatter、资源 manifest 校验通过才写入 |
| `skill_update` | 要求 `expected_version`，提交完整新版本 |
| `skill_patch` | 必须唯一命中指定片段；无法唯一命中时拒绝 |
| `skill_files_write` | 仅新增/替换相对资源路径；路径遍历、可执行外部下载和超限内容拒绝 |

自动流程不提供 `delete`、`set_visibility`、`activate`、`deactivate`、`archive` 或跨 scope 修改动作。脚本资源即使被提炼出来，也只是未执行的版本化文本；后续执行仍必须通过 Harness 工具注册、权限和 effect intent 机制。

`skill_create` 写入的是 `active` 而非 `draft`，因此“新建即生效”**必须**由质量门（§5）而非状态流转来保证。

## 5. 版本、冲突和质量门

每个 asset 拥有稳定 `skill_id` 与从 1 起单调递增的 version。`create` 产生 version 1；`update`、`patch`、`files_write` 在一个原子提交中产生新 version。所有变更都必须带 `expected_version`：

```text
view(skill_id) → version 3
write(expected_version=3) → 成功 version 4 / VersionConflict(current=4)
```

版本永不重写；可以读取、列举、导出历史 version。资源 manifest 与 `SKILL.md` 同一版本提交，故任何版本始终可完整重建。

创建或更新至少要通过：可复用性（不只是一次性事实）、明确触发边界、至少一个有成功结果的来源、验证步骤、无 secret/PII、无未验证高风险命令、与现有 Skill 的重复/冲突检查。将“这次任务做了什么”直接复制为 Skill、仅凭 assistant 声称成功、或把临时项目状态写入 Skill 均须 `no_op`。

敏感内容扫描是**净新增工作**，不能依赖已有实现：参考实现的长度与 prompt-injection 过滤在 `sanitize.ts` 中已被注释掉，因此本 harness **必须**自行实现并测试字段级脱敏、prompt-injection 检测与 secret 扫描。**必须**为每条拒绝规则提供阳性与阴性测试用例，否则该门形同虚设。

上述规则中被判为“一次性事实”或“未验证方法”的内容不应被丢弃：它们应进入长期记忆的 `work_method` 或保留在 session，二者与 Skill 的判定规则见长期记忆规范 §1.2。

## 6. 运行时检索和装配

Skill 可用 `keyword | embedding | hybrid` 搜索，但必须先按 scope、visibility、绑定与 `status=active` 过滤。**SQLite v1 只提供 FTS/BM25**：`embedding` 与 `hybrid` 是接口允许的取值，但未接入向量索引时**必须**降级为 BM25 并记录 telemetry，而不是让 `embedding` 生效却返回空结果。

每次 run 在构造 provider request 前取得预算受限的 `SkillListing`：仅含 `skill_id`、name、description、triggers、version 和简短状态，建议总预算 2,000 字符。listing 应置于独立 `<available_skills>` prompt 区块，不能把所有 `SKILL.md` 注入。

模型/运行时选中某项后，通过稳定 ID + version 请求 `SkillLoadout`，其中包含完整 Markdown 与 manifest 指定的必要资源。完整 loadout 进入该 operation 的 effect intent，至少记录 `skill_id`、version、content hash、resource hashes 和装配预算。崩溃恢复必须重用该冻结 version，不能在重试时偷偷换成最新 Skill。

装配优先级建议为：显式调用方绑定 > 任务/场景匹配 > FTS/hybrid 分数。若 SkillStore 超时、索引失败或未启用，运行时记录 telemetry 并以空 listing 继续；不得阻塞 operation admission。已 `disabled` 或 `archived` 的版本不得新装配，但已冻结在进行中 intent 的版本可继续用于恢复，以保证可复现性。

## 7. API、配置和安全

`Harness.open` 应增加可选 `skill_runtime` 与 `skill_scope` 依赖；未传时保持兼容，但组合合法性受 §3.2 约束。稳定 API 可提供：

```python
await skill_runtime.force_archive(scope, session_id)
await skill_runtime.listing(scope, query, budget)
await skill_runtime.load(scope, skill_id, version=None)
await skill_runtime.review_status(archive_or_job_id)
```

`SkillEvolutionRuntime` **必须**提供与 `MemoryRuntime` 相同的生命周期：`start()` 恢复未完成 job 与 outbox 扫描，`aclose()` 停止调度并等待在途 job 收敛；`Harness.close()` 必须级联关闭二者（见 ADR-014）。

人工审核/资产管理 API 另行定义，不能混入自动 Review 权限。配置至少包含：buffer 阈值（tool call 数与字节数）、archive 最大大小、Review provider/timeout/retry、最大候选数、listing/loadout 字符预算、允许的资源 MIME/大小、是否允许 embedding、以及 `auto_create` / `auto_update_active` 开关。生产默认**必须**启用 `auto_create`，**必须**关闭 `auto_update_active`——即可以自动沉淀新 Skill（`active` + `private`），但不得自动改写一个已存在且可能正被使用的 active Skill；对该类资产的更新只能由人工资产管理流程发起。

必须记录 archive 原因与 hash、job 生命周期、Reviewer prompt/version、候选检索结果、每项 create/update/patch 的前后 version/hash、拒绝原因、冲突和被装配的 Skill versions。日志/审计不得保存原始密钥或受控资源明文。

## 8. 实施顺序与验收

1. 实现纯 DTO、`SkillStore`/`SkillReviewer` 协议、in-memory conformance backend 和版本/资源原子性测试。
2. 实现 terminal outbox、SkillBuffer、归档、worker lease/recovery 和审计；不接入 LLM。
3. 实现受控 Review schema、候选检索、active create/update/patch、敏感内容扫描和 optimistic-lock 冲突处理。
4. 实现 listing/loadout 与冻结到 LLM effect intent；最后接入 SQLite、可选 embedding 和人工审核适配器。

验收条件：

- 同一 terminal operation 的重复 dispatcher 投递只增加一次 buffer 输入；archive 后崩溃不丢 archive、不重复创建 extraction job；Skill buffer 与 Memory L0 使用同一冻结 terminal snapshot；
- 自动创建的 Skill 为 `active` + `private`，且仅对该 repository scope 可见；自动路径无法改变 visibility 或写入其他 scope；
- 默认配置下自动流程不能修改已存在的 active Skill（`auto_update_active=false`），尝试时必须留下拒绝审计；
- 只配置 `skill_runtime` 而不配置 `memory_runtime` 时，`Harness.open` 抛出配置错误而不是静默停用；
- 并发 update 不能静默覆盖，`expected_version` 不匹配必须返回当前版本；
- 自动 Reviewer 无法删除资源、提升 visibility/status、写出 scope，或调用未授权副作用；
- 成功但一次性的聊天不会创建 Skill；包含成功工具结果与验证的重复流程创建 `active` Skill；
- 敏感内容、prompt-injection 与 secret 扫描规则各有阳性/阴性测试，且拒绝项进入 audit；
- `embedding` 在仅 BM25 的 SQLite v1 上降级并记录 telemetry；
- 未授权、disabled、archived Skill 不会出现在 listing/search/loadout；
- 未到 `not_before` 的 job 不执行；进程重启后已到期的 job 只执行一次；
- Review/存储/embedding 故障不会阻塞用户 operation，且有限重试后存在可重放 dead letter；
- SQLite migration、资源原子提交、buffer/archive/版本语义在所有 Storage backend 的 conformance suite 中一致。
