# 诊断与审计

0.13.0 彻底退役外部 Serena。默认本地文本模式可用，但不提供编译器语义；需要 C# 语义时按代码手册显式配置直接 Roslyn。维护入口为 test:roslyn-host 与 test:roslyn-gateway，不再有 test:serena-real。

从 0.12.4 起 Repomix 健康探测和打包都由当前 Node 可执行文件直接启动已安装的 JavaScript CLI；不经过 cmd、npx 或 PATH 包装脚本，也不下载包。默认按目标工作区和 WinCode 安装目录的 Node 模块路径读取 repomix/package.json 的 bin 入口；不搜索 npx 缓存或 npm 自定义全局前缀。非标准安装需在宿主 WinCodeConfig.adapters.repomix.customCliPath 提供绝对 .js/.cjs/.mjs 路径；该字段不是 MCP 工具参数，不能传给 hello/prepare_context。显式路径无效时返回 builtin fallback，不执行另一份安装；useCli=false 仍完全禁止探测和启动。执行已安装脚本不提供沙盒或脚本可信性保证。

`hello` 从 0.12.1 起只读取版本、能力和已知状态，不启动上游、CLI 或 UI Host 探测进程。`health.healthObservation` 区分 `known/unknown` 并给出 `observedAt`；`unknown` 或 `available:null` 表示尚未探测，不能解释为不可用。配置禁用属于已知策略，但观察时间可为 null。已知健康结果可能陈旧，需要当前检查时调用现有 `wincode_diagnose_project({})`，不向 hello 添加未声明的 force/probe 字段。

`wincode_diagnose_project` 会检查 SDK 并主动探测 Repomix/UIA；对 Roslyn 只读取已有加载状态，不会启动 Code Host 或执行项目加载。已授权配置 Roslyn 后，首次明确的符号搜索才触发加载。`health.healthObservation` 当前包含 text/repomix/flaui；Roslyn 的观察时间与快照状态在 `health.roslyn`，不要按旧 Serena 字段判断。

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

0.13.1 中，已知工具执行失败的 JSON 文本与 structuredContent 同源；Gateway 异常含 success=false、errorCode、errorMessage、provider 和 recoveryAction。UI/trash 保留领域字段及实际位置，不要求所有领域错误具有 Gateway 字段；图片保持独立 image 块。未知工具在正常受理状态下返回 JSON-RPC -32602 协议错误，不返回 isError 结果；关闭/取消的入口拒绝优先于工具查找。旧连接不能套用此契约，先核对实际版本。恢复动作不表示已经回滚或允许原样重试。

直接 Roslyn Host 与 UIA Host 是不同组件。新 Gateway 的 hello.codeProvider 和 health.roslyn 报告显式选择的提供方、已知观察、processAlive、snapshotId 及重载/重启/清理状态；hello 不启动 Roslyn 或执行项目，进程存活不等于当前磁盘语义已验证。ready 是内部握手帧，UIA 的 VERSION_MISMATCH、inspectionVersion 等不能套到 Code Host。当前 npm run check / delivery:verify 不替代 test:roslyn-host/test:roslyn-gateway；当前交付清单已覆盖 Code Host 完整发布目录，但不证明实际客户端已启用 Roslyn。

Roslyn 运行中已观察到的加载、查询或清理错误也纳入 health.lastAdapterError，provider=roslyn；health.roslyn.health.lastError 保留对应观察。lastError 是历史最后一次失败，不表示每次 hello 都执行了健康探测，也不能据此自行重放业务请求。工作区完整重置后观察清空。

Code Host 内部协议 v2 的失败包含 success=false、errorCode 和 error，且不附带旧引用。SNAPSHOT_STALE/INPUTS_CHANGED 在内部协议层要求等写入稳定后显式 reload，再用新身份定位；MCP 客户端应重新调用 wincode_find_code_symbol，由适配器执行所需重载，不存在 wincode_reload 工具；PROJECT_LOAD_FAILED 表示结构化 MSBuild 加载失败，先修复项目输入，再 reload，不能继续使用最后一次成功快照。源码的 compilationErrors 可随有用的部分引用返回，不能据此宣称完整。

Roslyn 的已知领域错误通过 MCP 的 isError=true 和 JSON 文本 success=false/errorCode/errorMessage 返回；失败的 JSON 文本与 structuredContent 一致，仍保留领域差异。HOST_RESTART_REQUIRED（SDK/监听状态）应对当前路径执行 workspace_open，再显式搜索；同根打开也关闭旧 Host 后重新选择 SDK。清理失败则按 WORKSPACE_RECOVERY_REQUIRED 的 restart_gateway 处理，不能通过再次打开恢复。HOST_TIMEOUT/HOST_CRASHED 后旧定位不可用，下一次显式搜索才启动新 Host；不会重放失败引用。

INPUT_UNAVAILABLE/HOST_UNAVAILABLE 先检查明确的配置文件、SDK/Host/项目路径，以及 additionalInputs 中的文件是否存在；补充文件缺失时，重载也会失败，恢复文件后再显式搜索。不要为恢复查询而静默移除真实构建输入。HOST_VERSION_MISMATCH 先核对 Code Host 与 Gateway 的版本、Release 配置和协议；不要继续使用混合交付。HOST_PROTOCOL_ERROR 同时检查协议 v2、inputPolicy.version=1 和实际补充列表；旧 Host 没有确认新策略时不能绕过。LEGACY_SYMBOL_ID 要求重新搜索 Roslyn 身份；UNSUPPORTED_SYMBOL_LOCATION 表示该实例未配置 Roslyn；SYMBOL_MISMATCH 表示名称和定位不一致。INPUT_BUDGET_EXCEEDED 区分枚举规模与受跟踪输入字节限制，先缩小受支持范围，不能接受截断指纹。内部 BUSY 表示队列已满，DUPLICATE_REQUEST 要求新的 id；CANCELLED 是目标终止结果，取消确认不替代它。OUTSIDE_WORKSPACE/UNSUPPORTED_LINK 拒绝越界或链接路径，不放松校验来恢复。

维护接口变更时，同步检查 Gateway 工具定义、相应 references 手册、实际客户端 Schema 和已安装四份受管文件；更新源码手册后运行 skill:sync，再以 skill:check 校验。仍须单独确认 MCP 实例的版本/构建/Schema，不能用手册同步代替重连。公共接口尚未发布时，只记录实验边界，不提前把新参数加入 MCP 规范字段表。


`npm run test:error-contracts` 使用生成夹具验证错误、部分完成与恢复；Node 22 CI 执行该专项并保存有界报告。UI 图片场景使用注入响应，只验证序列化，不冒充真实屏幕验收。

## 连接关闭（0.13.2）

正式入口在 stdin EOF/close、传输关闭或管道错误时停止接收请求，取消初始化和活动操作，并按统一 8 秒预算清理自有资源。关闭失败保留非零退出结果；缓存写入不能无限延迟退出。不能把此行为等同于 Codex 当前连接已更新，也不能承诺强杀 Gateway 时所有后代均受同一个 Windows Job 保护。升级后刷新对应 MCP 连接，不必一概重启整个 Codex。

## 原生 Helper 所属进程退出（0.13.3）

Gateway 通过子进程私有环境传递所属 PID；两个 .NET Host 在项目求值或 UI 读取前核验真实祖先链和创建时间，并持有该进程对象句柄。直接运行 Host 时使用实际父进程。无法核验时拒绝开始重操作，不按 Codex/Claude 等客户端名称扫描。所属进程死亡后先取消，独立线程宽限两秒后仅硬退出当前 Helper；Code Host 的既有 Job 处理其覆盖的后代，UIA 不终止目标窗口应用。UIA 的 stdin EOF 仍表示请求输入结束。此机制不检测仍存活但卡死的 Gateway，也不自动覆盖独立 Repomix 子进程。开发启动包装链最多八层；不要手工设置任意 WINCODE_OWNER_PID 绕过核验。

## UIA 首用与被动状态（0.13.4）

启动只核验 UIA 平台、配置和发布文件，不运行健康探测进程。文件存在且尚无运行观察时，hello 的 flaui.available=null、source=unknown，不能理解为已安装 Host 不可用。首次 UI 请求直接执行请求；成功响应更新已知 Host 观察，失败保留 lastAdapterError，即使健康状态仍 unknown。需要主动验证时使用现有 wincode_diagnose_project；hello 不补发探测。缺失文件仍可在启动被报告，文件恢复后显式 UI 请求重新解析发布路径，不必重新初始化整个 Gateway。

## 手动 Roslyn 释放与可选托盘（0.14.0）

自动释放关闭，本版不创建 idle timer。用户可按 README 手动启动独立 Tray，并给希望管理的 Gateway 启动参数添加 --tray 后刷新连接。托盘只管理已注册的实例，不扫描/终止外部客户端或目标应用；MCP 仍为原有 15 个工具，没有让 Agent 自动代替用户释放的管理工具。默认不启用托盘连接、不设置自启动。

手动释放遇到业务在途、语义排队/收尾、工作区切换或恢复门时拒绝，不自动延后执行。被接纳的释放完成后，新 MCP 请求继续；旧 symbolLocation 返回 SNAPSHOT_STALE，显式重新搜索再取得当前定位。保留 Gateway、watcher、缓存与最后诊断。清理失败进入 restart_gateway 恢复门，不能靠反复点击清除错误。local-text 没有可释放的 Roslyn。

概览只读内存快照，不为状态启动 Host 或枚举缓存目录。状态是注册/打开/刷新时的观察，不代表 Agent 在两次请求之间已结束整个任务。失联/超时表示未知，控制命令不自动重放；退出 Tray 不停止 Gateway。首版最多八个同用户/会话实例，按同权限级别使用；版本必须匹配。需要停止时由用户确认“停止此实例”，走该 Gateway 既有关闭路径，客户端可能重新建立新实例。
