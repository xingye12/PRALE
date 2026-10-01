# 文件权威 L2/L3 与按需记忆检索实施方案

## 1. 目标与非目标

本改造把长期记忆明确分成两类权威介质：L0/L1 是可查询的结构化事实，保留在 SQLite；L2/L3 是面向人和模型共同编辑的 Markdown 资产，不再把新的正文写入 SQLite。

| 层级 | 权威介质 | 自动进入 provider 请求 | 获取方式 |
| --- | --- | --- | --- |
| L0 | SQLite `trace_*` | 否 | `conversation_search` |
| L1 | SQLite `atomic_memories` + FTS/vector side index | 否 | `memory_search` |
| L2 | scope 专属 Markdown + `index.json` | 仅 `index.json` | `memory_read_scene` |
| L3 | 共享 Markdown | 是，全文 | 固定系统上下文 |

非目标：不把 Markdown 文件作为可执行指令；不让 L2/L3 再参与 BM25/embedding 召回；不自动把 L0/L1 或 L2 正文塞进模型上下文；不将 repository scope 由请求参数决定。

## 2. 目录与文件格式

`PRALE_MEMORY_ASSETS_DIR` 是可由多个部署共享的根目录。scope 的物理目录使用 `sha256(repository_id)`，因此路径安全且相同 repository 在多个进程中映射相同目录。

```text
${PRALE_MEMORY_ASSETS_DIR}/
  scopes/<sha256(repository_id)>/
    scope.json                         # repository_id，供枚举与校验
    l2/index.json                      # 当前 scene 的小型目录
    l2/scenes/<scene-id>.md            # 当前 L2 正文
    l2/history/<scene-id>/v0001.md     # 被替换前的版本
  l3/operating-doctrine.md             # 全局唯一 L3 正文
  l3/history/v0001.md
```

每个 Markdown 由 JSON front matter（`---` 包围）和正文组成。front matter 包含稳定 ID、scope、版本、状态、时间、来源 watermark、引用 ID 与 `content_hash`；正文仍须通过既有的九段 L2/六段 L3 domain 校验。选择 JSON 而非依赖 YAML 库，使格式读写可复现且不会让资产解析引入 provider 或第三方运行时依赖。

`index.json` 不复制正文。它包含 `format_version`、`repository_id` 及 scene ID、summary、版本、状态、heat、更新时间与 hash。任意合法 scene 文件集合都可重建 index。读取 scene 时先检查它位于本 scope 的 index，再打开对应 Markdown，防止跨 scope 的猜测 ID 读取。

## 3. 权威、写入和恢复

`MarkdownMemoryAssets` 是唯一的 L2/L3 文件编码器。文件替换采用“同目录临时文件 → flush/fsync → `os.replace`”，所以读取方只会看到旧完整文件或新完整文件。更新前把旧内容放入 history。

SQLite 新增 `memory_file_operations`，只保存操作 ID、scope、asset kind、相对目标路径、期望/目标 hash、状态和错误分类，绝不保存 L2/L3 正文。状态机为：

```text
prepared --(atomic Markdown replace)--> settled
   |                                       
   +--(重启时文件不存在或 hash 不同)--> dead_letter
```

流程是：校验 candidate 与 optimistic version；写入 SQLite `prepared` intent；原子写 Markdown 与 index；将 intent settlement 为 `settled`；最后审计。若进程在 replace 后崩溃，启动恢复扫描 prepared intent，文件 hash 匹配便 settlement。若文件缺失，正文不在 SQLite，不能安全重放，原 promotion job 会按其重试策略重新产生 candidate；恢复记录为 dead letter。若 hash 不同，则视为人工编辑冲突，保留手工版本且 dead-letter，绝不自动覆盖或调用 LLM 合并。

L2 容量淘汰、MERGE 和 GC 只更新/删除该 scope 的 Markdown；L3 从不参与 scope GC 或 scope 删除。`delete_scope` 在 SQLite 事务完成后仅删除该 scope 的资产目录，不会触及全局 L3。

## 4. 旧库迁移

启动迁移保留旧 `work_scene_memories`、`operating_doctrines` 表，保证旧审计、查询和升级可读；它们不是新运行时的写入目标。尚未处理的旧行被幂等导出为 Markdown：

1. 文件不存在：写出其旧版本与 index；
2. 文件 hash 相同：视为已迁移；
3. 文件 hash 不同：写 `file_migration_conflict` 审计并保留人工文件；
4. 所有 scope 的 index 从合法 scene 文件重建；
5. 写 schema marker，避免重复导出。

此策略避免一次迁移覆盖共享目录中已被用户或另一部署修改的内容。

## 5. 晋升路径与 scope

L0→L1 的 archive capture、watermark、outbox、lease、候选校验和 SQLite 原子提交保持不变。L1→L2 只读取 job 所属 repository 的 L1 增量和该 repository 的 file-backed scenes；L2→L3 读取全局 L3 与所有 scope 的当前 file-backed scenes。工作队列继续使用 SQLite `memory_jobs`：创建由 archive/L1 watermark 等事件触发，认领由 worker 轮询；`BEGIN IMMEDIATE` 的条件更新和 lease 防止两个 worker 同时成功认领同一任务。

所以即使多个 repo 指向同一个 `PRALE_MEMORY_DB`，L0→L1、L1→L2 的计算和 watermark 仍由 `MemoryScope(repository_id)` 隔离；L3 是唯一有意跨 scope 汇总的层。

## 6. 请求上下文与工具

每次生成 intent 固定读取：全局 L3 全文和当前 scope 的 L2 `index.json`。`MemoryRuntime.prompt_memory()` 形成可审计 bundle，`ContextAssembler.assemble_prompt_memory()` 将它们作为只读系统背景加入请求。intent 审计记录 bundle hash 与版本。L0/L1 绝不在这条自动路径中出现。

工具在 integration/composition root 创建，runtime 仅依赖 `AgentTool` 与 `MemoryStore` 协议：

* `memory_search(query, limit, mode)`：active L1 的 scope 过滤检索，复用 FTS+embedding/RRF；
* `conversation_search(query, limit)`：仅该 scope 的已脱敏 L0 trace item；
* `memory_read_scene(scene_id)`：仅该 scope index 中存在的 current L2 scene 正文。

输入均限制 query/limit/scene_id；工具只读、`replay_policy="safe"`，异常被工具注册表转换为失败结果。服务组合时，只要 memory store 启用，就在常规本地工具外自动注册它们。

## 7. 验收与运维

必须保持并运行以下验证：

1. L2/L3 Markdown 与 index round trip、history 与 index rebuild；
2. 两个 repository 在同一 DB 和资产根下拥有不同目录、不同 index，且工具不能跨 scope 读 scene；
3. 新 L2/L3 写入后旧 SQLite 正文表不新增行；
4. L3/index 注入但 L0/L1/L2 正文不注入；三个工具分别返回 L1、L0、已索引 L2；
5. prepared intent 在 replace 前/后崩溃的恢复，以及 hash 不同的人工编辑 dead letter；
6. 旧 SQLite 行迁移幂等和冲突保留；
7. L2 dormant GC、scope 删除、L3 不删除；
8. 既有 memory conformance、integration、crash-recovery、web deployment 测试和 Ruff。

运维者备份共享 assets 目录时应与 SQLite 一起备份。可以手工编辑 Markdown；下次 promotion 若其 expected hash/version 不再匹配，任务必须失败并留下审计，而不是覆盖修改。恢复 index 可以从该 scope 的 `l2/scenes/*.md` 重建，前提是每个文件 front matter hash 合法。
