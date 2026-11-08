# 危险工具检测与 Web 执行审批

## 行为与边界

实现参考 deepseek-harness 的 core/tools、interaction/user-approval 和 client/ui-approval：
统一使用 allow / deny / ask，拒绝不可被授权覆盖；审批失败或无通道时不执行。
PRALE 扩展了持久等待、精确会话授权和撤销。

普通工作区文件读写自动执行；下列调用要求审批：

- 工作区外路径，包括解析符号链接后的目标；
- 凭据文件读取与修改：`.env*`、SSH/云凭据目录、常见私钥与凭据文件；
- Git 内部状态、CI、部署目录、agent/skill 指令及安装/执行配置的修改；
- shell 执行和未声明风险能力的扩展工具。

仅精确 `pwd` 自动允许；内置 BashTool 直接返回工作目录，不启动 shell，避免 profile/BASH_ENV 副作用。
带 command_prefix 的 shell 仍需审批。shell 授权指纹包含配置前缀与环境哈希。
内部 repository_explore 读取跳过凭据与部署追加的敏感路径，并在结果中说明过滤。
作用域受限的 memory/skill 只读工具以及能力收缩的原生控制工具自动允许；子工具独立评估。
工具不存在、最终参数不符合 JSON Schema、风险检测异常或 hook 拦截均拒绝执行。

审批提供允许本次、允许本会话相同操作、拒绝。会话匹配键包含工具名称、完整 JSON 参数、
实际目录、解析目标、工具实现身份/能力版本、策略版本及独立 lane 主体；对象键顺序不影响匹配。
父子 lane 不共享授权，Subagent 续跑的同一 agent lane 可以复用自己的授权。
会话授权保存在 Session，重启有效，可撤销；不提供前缀规则、目录通配授权或全局放行。

这是 runtime 的执行授权，不是 OS 沙箱，也不阻止调用方绕开 Harness 直接调用工具对象。
任意 shell 均不能靠命令黑名单推断安全。外部进程在最终检查后并发修改文件系统仍属于
非沙箱部署的竞争边界；部署若需要强隔离，须使用受约束执行器。

## 持久状态与恢复

不新增 SQLite 表。`format_version=1` JSON 记录使用既有 values/lists：

- `approval/request/{id}`：完整冻结请求和当前状态；`approval/requests` 是原子写入的定位索引；
- `approval/grant/{id}`：精确授权与撤销标记；`approval/grants` 是定位索引；
- `approval/audit`：只追加的请求、决定、授权使用、撤销、取消和替换记录。

tools call 的 `status=planned` 增加 `prepared_event` 与 `approval_id`；逻辑上的 prepared、
approval_pending、authorized 分别由冻结输入和请求的 pending/allowed 状态表达。
请求与完整 OperationState 同事务提交。等待不创建工具 span，不持有事务锁，进程内 Event
仅唤醒等待者，持久记录才决定下一步。服务关闭只停止等待，浏览器断连不取消 operation。

最终参数先经过 before_tool，再通过 JSON Schema 校验，之后冻结并评估。恢复不重复修改冻结参数。
执行 intent、span-start、授权有效性检查和消费审计在同一 Session mutation 内提交；
风险上下文改变或授权被撤销时重新申请。批准不改变 replay_policy：safe 的恢复重试重新评估，
never 的未知结果收束 unknown，不自动重放。effect outcome 与下一状态继续原子 settlement。
拒绝调用写入配对的错误工具结果，不创建工具 effect span。

显式取消原子撤回未消费请求，父取消也撤回子请求；迟到决定返回冲突。
重复相同决定幂等返回，冲突决定拒绝。危险调用形成批次屏障；连续低风险并行调用仍可并行，
所有工具结果按源序落盘。原生控制调用也经过相同门禁，且子接纳与父 intent 保持原子性。

旧 tools state 缺少审批字段时，尚未执行的调用必须经过新门禁；旧 effect_pending 保持既有恢复语义。
没有表结构迁移，也不删除、重写已有历史。新格式不支持降级到无审批门禁的旧二进制后恢复活动 Session。

## Library 与部署配置

`agent_harness.api` 导出 ApprovalConfig、ApprovalConflict 和 RiskAssessment。
Harness.open(..., approvals=ApprovalConfig(...)) 默认 policy=ask、channel_available=False；
无通道的危险调用返回 unavailable。交互调用方须显式注册可处理请求的通道。

Harness.approvals 提供 records(grants=False)、decide(id, decision) 和 revoke(id)。
decision 为 allow_once / allow_session / reject；返回记录是存储副本。
自定义工具可实现 assess_risk(arguments) 返回 RiskAssessment；未实现时为 ask。
工具升级应递增 risk_version 或返回新的 capability_version。部署可注入 RiskEvaluator 协议。
domain 不依赖 Web、数据库驱动、provider 或 runtime；本地路径策略在 integrations。
JSON Schema 参数校验由 runtime/tools 使用 jsonschema 实现。

Web 默认注册可持续等待的审批通道；无人打开页面时也保留请求，首版没有自动超时。
部署环境变量：

- PRALE_APPROVAL_POLICY=ask；never 表示需要审批的调用直接拒绝。
- PRALE_APPROVAL_SENSITIVE_PATHS：逗号分隔的追加敏感路径 glob，保护读取与写入。
- PRALE_APPROVAL_PROTECTED_PATHS：逗号分隔的追加修改保护 glob。

追加规则不能削弱内置保护，规则变化使旧精确授权失效。

## HTTP 与 Web 展示

- GET /api/sessions/{session_id}/approvals：待处理请求。
- POST /api/sessions/{session_id}/approvals/{approval_id}/decision：仅接受 {"decision": "allow_once|allow_session|reject"}。
- GET /api/sessions/{session_id}/approval-grants：授权及撤销状态。
- POST /api/sessions/{session_id}/approval-grants/{grant_id}/revoke：幂等撤销。

接口沿用部署 Bearer 认证；决定和撤销额外检查 Origin / Sec-Fetch-Site。
服务端按 Session 读取权威请求，不接收客户端提供的工具参数、风险理由或指纹。
参数伪造返回 400，跨 Session/失效/冲突请求返回 409。审批界面和完整审计不注入模型上下文；
模型仅获得实际工具结果或权限错误。

聊天面板在对应 tool call 旁展示审批卡片、完整参数、路径、实际工作目录、原因及子运行来源；
待审批 turn 标注“等待执行权限”，固定提醒及“前往审批”入口避免长历史遮蔽权限请求。
子调用审批挂在父控制调用旁；历史未加载或详情投影尚未赶上时，请求仍在输入区附近可操作。
三个决定按钮提交时禁用并去重，授权面板支持查看精确范围与撤销。
页面重载重新读取请求；SSE 快照含 pending_approvals，审批请求/决定/授权变更触发重读。
审批事件在整个 Session 可见，主页面因此能处理子 lane 请求。
新服务批准主 lane 的原请求后接管遗留 Drive lease；子 lane 由既有 Subagent 恢复调度器接管。

## 验收证据

- unit/test_tool_risk：风险分级、保护路径、符号链接、追加策略。
- conformance/test_approvals：memory/SQLite 同一工作流，持久请求、决定、授权、审计与恢复。
- integration/test_tool_approvals：无通道、never、冻结 hook 参数、精确复用、撤销竞争、路径变化、并行屏障与子级取消。
- integration/test_web_approvals：认证、伪造/跨 Session/跨 Origin 拒绝、快照、服务重启后原请求恢复与撤销。
- crash_recovery/test_approval_recovery：真实进程退出覆盖请求、决定、intent、effect、settlement，不重放未知 never 效果。
- web/approvals.test.mjs：执行实际界面模块，验证按钮、重复点击、禁用、授权、撤销及重载；由 pytest 调用 Node。

此外运行全量 pytest、ruff check、ruff format --check 与类型检查。
全仓 mypy 的既有 memory_assets/memory_sqlite 错误应与 HEAD 基线比较，审批改动不得新增错误。

## 工作区沙箱修订（ADR-038，优先于上述旧默认规则）

默认删除凭据文件名和项目配置修改审批清单；读取工作区外文件也直接允许。写入范围按实际解析目标判断，宿主 /tmp 不属于默认写入范围。显式 sensitive/protected glob 保留；配置非空时一般 Bash 回退审批，不能声称 glob 在 shell 内强制实施。

普通 Bash 自动执行依赖 Linux bubblewrap 实际能力探测，根只读、工作区可写、私有 /tmp、PID 隔离、网络保留。sandbox_permissions 默认 workspace-write；danger-full-access 需要非空 justification 和审批。off、前缀、探测失败均说明将以宿主权限执行；失败不自动重试。精确 pwd 仍直接返回路径。执行模式、能力版本、工作区进入指纹并在执行前复核；策略版本提升，历史审计不改写。沿用精确 lane 授权、撤销、恢复和 never 语义，不新增表。

### ADR：工作区执行配置只读覆盖挂载

背景：工作区可写沙箱允许 shell 修改启动文件、编辑器和工具配置或 Git hooks，影响后续执行。

决策：bubblewrap 在工作区可写挂载后，将工作区根目录已存在的 `.bashrc`、`.bash_profile`、
`.zshrc`、`.zprofile`、`.profile`、`.gitconfig`、`.gitmodules`、`.ripgreprc`、`.mcp.json`、
`.vscode`、`.idea`、`.git/hooks`、`.git/config` 只读覆盖挂载；`.git` 为 worktree 指针文件时，
只读挂载该文件，不将普通仓库整个 `.git` 目录设为只读。符号链接目标使用规范化路径覆盖，
避免向符号链接挂载导致 bubblewrap 失败；符号链接目录项本身不作为不可替换保证。能力版本升级，保护路径及文件身份进入探测身份，执行前重新核对。

后果：只保护调用开始时已存在的路径，不创建缺失的占位文件，不递归搜索嵌套项目；
不存在的路径仍可新建。工作区外仍整体只读。此边界只适用于 bubblewrap Bash，直接 write/edit
和获批的宿主 Bash 不受这些挂载约束。不新增持久状态或改变恢复重放语义。
验收覆盖挂载顺序、普通仓库/worktree、能力身份变化、实际写入/替换/删除拒绝与普通文件可写。
原 `pi-harness-implementation-plan.md` 在当前工作树已删除，本次不恢复该用户改动。
