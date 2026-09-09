# 诊断与审计

0.13.0 彻底退役外部 Serena。默认本地文本模式可用，但不提供编译器语义；需要 C# 语义时按代码手册显式配置直接 Roslyn。维护入口为 test:roslyn-host 与 test:roslyn-gateway，不再有 test:serena-real。

从 0.12.4 起 Repomix 健康探测和打包都由当前 Node 可执行文件直接启动已安装的 JavaScript CLI；不经过 cmd、npx 或 PATH 包装脚本，也不下载包。默认按目标工作区和 WinCode 安装目录的 Node 模块路径读取 repomix/package.json 的 bin 入口；不搜索 npx 缓存或 npm 自定义全局前缀。非标准安装需在宿主 WinCodeConfig.adapters.repomix.customCliPath 提供绝对 .js/.cjs/.mjs 路径；该字段不是 MCP 工具参数，不能传给 hello/prepare_context。显式路径无效时返回 builtin fallback，不执行另一份安装；useCli=false 仍完全禁止探测和启动。执行已安装脚本不提供沙盒或脚本可信性保证。

`hello` 从 0.12.1 起只读取版本、能力和已知状态，不启动上游、CLI 或 UI Host 探测进程。`health.healthObservation` 区分 `known/unknown` 并给出 `observedAt`；`unknown`、`available:null` 或 `commandFound:null` 表示尚未探测，不能解释为不可用。配置禁用属于已知策略，但观察时间可为 null。已知健康结果可能陈旧，需要当前检查时调用现有 `wincode_diagnose_project({})`，不向 hello 添加未声明的 force/probe 字段。

代码查询、引用、上下文、影响分析和重构建议接收 MCP 客户端取消信号；停止后续扫描/打包，等待当前读操作或自有上游进程清理后释放请求占用。Roslyn 取消会传播到自有 Host；若合作取消未及时完成，则按既有超时策略清理自有进程树，不宣称其他请求已成功。磁盘单次 OS I/O 不能保证瞬时中断。工作区切换在等待和提交前可取消；已开始提交切换时完成一致性收尾，不声称已回滚。

`health.resourceCleanup` 是最多 100 条资源关闭记录（owner、kind、closed/failed 与最多 1024 字符错误），`omitted` 表示更早记录被省略。进程数量为零不能替代这些结果或真实 PID 退出证据。关闭失败会向调用方抛出，重复关闭保留失败；初始化失败会尝试释放已取得资源。记录只保存在当前进程内，不是持久审计或防篡改证明。

规范输入：`wincode_hello_world` 仅支持可选 `greeting`（字符串，最长 1024）和 `toolName`（非空字符串，最长 128，选择本实例支持的工具）；`wincode_diagnose_project` 没有业务参数。`toolNames`、`forceReconnect`、`version` 不是这些工具的规范请求字段，额外字段被忽略，不会重连、切换版本或批量查询。示例：`wincode_hello_world({toolName:"wincode_prepare_context"})`。未知字段容忍不等于已有字段错误类型也能通过。

更新仓库后，先用 `npm run skill:check -- <已安装 wincode 目录的绝对路径>` 核对四份受管手册；不一致退出码为 2。明确更新时使用 `npm run skill:sync -- <同一路径>`，先在同级 .wincode-backup-* 目录以 .bak 后缀备份旧手册（避免备份被发现为重复 Skill），再写入并校验哈希；其他文件保持原样。此操作不注册 MCP、不改客户端配置、不重启运行实例。检查本机安装内容与仓库一致也不证明当前连接加载了新版。

仅遇到故障或用户要求时调用 wincode_hello_world({}) 查看适配器、工作区及 runtime；环境问题再用 wincode_diagnose_project({})。本地文本健康成功不证明 Roslyn 已配置或项目已加载；watcher 停止、最近超时和清理错误如实报告，不自动安装依赖或循环重启。

工具不可用：先确认客户端是否启用了 wincode MCP；已保存配置通常需重新加载客户端/会话。Skill 不负责注册 MCP。安装路径取实际客户端配置，不沿用历史机器的 I:/WinCode。STDIO 配置结构（占位路径需替换）：
- 命令：node
- 独立参数：<WinCode安装目录>/dist/index.js、--workspace、<目标工作区绝对路径>

不要把 codex mcp add 整条终端命令填入启动命令。不要重复注册或静默修改配置。VERSION_MISMATCH 可能表示新网关配了旧 Host，局部查询/状态要求 inspectionVersion=2；按授权重新构建发布。HOST_UNAVAILABLE 时检查已配置 Host 路径/发布产物；构建或环境变更按用户授权执行。

出现 auditNotice.message 时把大小、建议和完整路径简短转告原用户。日志目录为 %LOCALAPPDATA%/WinCode/logs/ui-audit：1 MiB 提醒，2 MiB 前预留结束空间并拒绝新 UI 访问；不自动删除。AUDIT_BUSY 表示另一 Helper 占用审计锁，等其完成后再按需要重试，勿杀目标应用。

需要手动检查时执行已有只读脚本：

```powershell
pwsh -NoProfile -File "<WinCode安装目录>/scripts/check-ui-audit.ps1"
```

仅用户明确需要桌面弹窗时加 -Desktop；不例行弹窗。日志只有 start 表示结果未知；本地日志不是防篡改证据。清理须获得授权、停止相关调用并保留用户需要的记录，不能为了恢复取证静默删除。

从 0.12.2 起，生产模式仅使用发布的 Release Host，缺失时明确不可用；`npm run dev`（`--development`）才允许 Debug/dotnet-run 回退。`customHostPath` 是显式配置覆盖，不是 MCP 请求字段。Host 响应的 `hostIdentity` 来自实际程序集，包含 version、informationalVersion、configuration 与 framework；旧 Host 未提供身份时不能推定版本一致。

仓内 `npm run check` 执行锁定构建、核心回归和生产 stdio，生成并校验 `dist/delivery-manifest.json`；`npm run check:desktop` 单独运行隔离桌面闭环。`npm run delivery:verify` 检查 Gateway、发布 Host 全部文件及四份受管手册的一致性，不启动 Host，也不验证另一个客户端实例或签名真实性。构建要求 Node 24（22 兼容）和 `global.json` 中锁定的 SDK；缺少环境时按授权安装，不自动修改环境。

WORKSPACE_RECOVERY_REQUIRED 表示切换中途失败后工作区一致性尚未确认。此时业务工具被拒绝；被动 hello 仍可读取 health.workspaceRecovery，status=recovery_required。先检查 recoveryAction：workspace_open 表示可按原任务指定路径重新打开，只有完整重置/初始化及 watcher 绑定成功才恢复请求；同一路径也执行完整恢复。restart_gateway 表示清理失败被当前实例保留，重新打开无法恢复；先检查 Gateway 自有资源的清理情况，再按客户端正常流程重启 Gateway，不自动重启或终止目标应用。永久失败后的 workspace_open 不再反复改变根或会话。不要只修改路径字段、反复重试业务请求或把旧适配器状态当成已切换成功。CANCELLED 若附带 workspaceRecovery，同样按其 recoveryAction 处理；切换变更前失败且状态未改变时仍保留旧工作区。

E4 统一错误表达尚未实施：当前可能收到 isError=true 的纯文本，也可能是 content 中的 JSON；不能要求所有失败都含 structuredContent、统一 recoveryAction 或 retryable。先保留 isError 和原始内容，只在实际存在时读取 errorCode、workspaceRecovery、trash outcome/实际位置。结构化字段缺失不等于成功，取消或失败也不代表副作用已回滚；部分完成不原样重试。JSON 文本与 structuredContent 同源的方案是后续迁移方向，不能套用到旧连接。

直接 Roslyn Host 与 UIA Host 是不同组件。新 Gateway 的 hello.codeProvider 和 health.roslyn 报告显式选择的提供方、已知观察、processAlive、snapshotId 及重载/重启/清理状态；hello 不启动 Roslyn 或执行项目，进程存活不等于当前磁盘语义已验证。ready 是内部握手帧，UIA 的 VERSION_MISMATCH、inspectionVersion 等不能套到 Code Host。当前 npm run check / delivery:verify 不替代 test:roslyn-host/test:roslyn-gateway，也不证明 Code Host 已纳入正式发布包。

Roslyn 运行中已观察到的加载、查询或清理错误也纳入 health.lastAdapterError，provider=roslyn；health.roslyn.health.lastError 保留对应观察。lastError 是历史最后一次失败，不表示每次 hello 都执行了健康探测，也不能据此自行重放业务请求。工作区完整重置后观察清空。

Code Host 内部协议 v2 的失败包含 success=false、errorCode 和 error，且不附带旧引用。SNAPSHOT_STALE/INPUTS_CHANGED 要求等写入稳定后显式 reload，再用新身份定位；PROJECT_LOAD_FAILED 表示结构化 MSBuild 加载失败，先修复项目输入，再 reload，不能继续使用最后一次成功快照。源码的 compilationErrors 可随有用的部分引用返回，不能据此宣称完整。

Roslyn 的已知领域错误通过 MCP 的 isError=true 和 JSON 文本 success=false/errorCode/errorMessage 返回，不代表 E4 已覆盖所有工具。HOST_RESTART_REQUIRED（SDK/监听状态）应对当前路径执行 workspace_open，再显式搜索；同根打开也关闭旧 Host 后重新选择 SDK。清理失败则按 WORKSPACE_RECOVERY_REQUIRED 的 restart_gateway 处理，不能通过再次打开恢复。HOST_TIMEOUT/HOST_CRASHED 后旧定位不可用，下一次显式搜索才启动新 Host；不会重放失败引用。

INPUT_UNAVAILABLE/HOST_UNAVAILABLE 先检查明确的配置文件、SDK/Host/项目路径，以及 additionalInputs 中的文件是否存在；补充文件缺失时，重载也会失败，恢复文件后再显式搜索。不要为恢复查询而静默移除真实构建输入。HOST_VERSION_MISMATCH 先核对 Code Host 与 Gateway 的版本、Release 配置和协议；不要继续使用混合交付。HOST_PROTOCOL_ERROR 同时检查协议 v2、inputPolicy.version=1 和实际补充列表；旧 Host 没有确认新策略时不能绕过。LEGACY_SYMBOL_ID 要求重新搜索 Roslyn 身份；UNSUPPORTED_SYMBOL_LOCATION 表示该实例未配置 Roslyn；SYMBOL_MISMATCH 表示名称和定位不一致。INPUT_BUDGET_EXCEEDED 区分枚举规模与受跟踪输入字节限制，先缩小受支持范围，不能接受截断指纹。内部 BUSY 表示队列已满，DUPLICATE_REQUEST 要求新的 id；CANCELLED 是目标终止结果，取消确认不替代它。OUTSIDE_WORKSPACE/UNSUPPORTED_LINK 拒绝越界或链接路径，不放松校验来恢复。

维护接口变更时，同步检查 Gateway 工具定义、相应 references 手册、实际客户端 Schema 和已安装四份受管文件；更新源码手册后运行 skill:sync，再以 skill:check 校验。仍须单独确认 MCP 实例的版本/构建/Schema，不能用手册同步代替重连。公共接口尚未发布时，只记录实验边界，不提前把新参数加入 MCP 规范字段表。


## 2026-09-09 E4 当前开发快照

用户已确认尚未广泛分发，可直接迁移到方案二。Gateway 普通错误已改为 JSON 文本并同步 structuredContent，使用稳定 errorCode、errorMessage、provider 和 recoveryAction；原文本前缀不再是兼容接口。UI/trash 保留领域结果字段并附同内容结构化载荷，尤其 partial 仍表示文件已经移动，不自动重试或移回。成功响应不在本次迁移范围。

这是未发布、未完成专项验收的开发状态；恢复动作只表示先处理的步骤，不授予执行、安装或自动重试权限。完整错误码/恢复状态矩阵、E4 专项回归和最终手册核对尚待完成，当前连接是否已更新须查看运行身份。
