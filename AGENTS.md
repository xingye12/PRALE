# PRALE 开发规范

本文件适用于整个仓库。实现 Python 版 pi harness 时，必须同时遵守 [specs/AGENTS.md](specs/AGENTS.md) 和 [specs/pi-harness-implementation-plan.md](specs/pi-harness-implementation-plan.md)；前者是架构、持久化、状态机与测试的详细约束。

## 全局规则

- 优先实现可恢复的 library/runtime；不要将 CLI、TUI、HTTP/RPC 或具体 provider SDK 混入核心层；
- 所有 storage、runtime 或公开 API 的改动都必须保持 `domain/` 的纯净依赖边界；
- 外部副作用必须遵守 durable intent → effect → atomic settlement；
- 每项持久状态转换都需要相应的 conformance、integration 或 crash-recovery 测试；
- 修改持久化格式、公开 API、恢复逻辑或副作用语义时，同步更新 `specs/` 中的方案和 ADR；
- 提交前运行受影响的 pytest、ruff 与格式/类型检查；保留与本任务无关的用户改动。
