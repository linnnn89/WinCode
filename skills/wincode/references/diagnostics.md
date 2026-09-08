# 诊断与审计

0.12.5 已兼容 Serena 1.7/FastMCP 的 structuredContent.result 字符串包装。真实上游验收入口是维护命令 `npm run test:serena-real -- <已安装命令绝对路径> [启动器参数]`，只在用户要求验收且环境已准备时执行；它创建独立 C# 夹具，记录重载、引用、空结果、未激活、断连降级及 PID 退出。脚本不自动安装，也不把 commandFound/握手成功当作语义可用。安装在 test-tmp 的上游仅用于隔离验收，不表示 Codex 默认连接已启用 Serena。

从 0.12.4 起 Repomix 健康探测和打包都由当前 Node 可执行文件直接启动已安装的 JavaScript CLI；不经过 cmd、npx 或 PATH 包装脚本，也不下载包。默认按目标工作区和 WinCode 安装目录的 Node 模块路径读取 repomix/package.json 的 bin 入口；不搜索 npx 缓存或 npm 自定义全局前缀。非标准安装需在宿主 WinCodeConfig.adapters.repomix.customCliPath 提供绝对 .js/.cjs/.mjs 路径；该字段不是 MCP 工具参数，不能传给 hello/prepare_context。显式路径无效时返回 builtin fallback，不执行另一份安装；useCli=false 仍完全禁止探测和启动。执行已安装脚本不提供沙盒或脚本可信性保证。

`hello` 从 0.12.1 起只读取版本、能力和已知状态，不启动上游、CLI 或 UI Host 探测进程。`health.healthObservation` 区分 `known/unknown` 并给出 `observedAt`；`unknown`、`available:null` 或 `commandFound:null` 表示尚未探测，不能解释为不可用。配置禁用属于已知策略，但观察时间可为 null。已知健康结果可能陈旧，需要当前检查时调用现有 `wincode_diagnose_project({})`，不向 hello 添加未声明的 force/probe 字段。

代码查询、引用、上下文、影响分析和重构建议接收 MCP 客户端取消信号；停止后续扫描/打包，等待当前读操作或自有上游进程清理后释放请求占用。上游 RPC 取消可能重置共享 Serena 连接，其他上游调用可能失败或降级；不保证外部服务器的单请求取消实现。磁盘单次 OS I/O 不能保证瞬时中断。工作区切换在等待和提交前可取消；已开始提交切换时完成一致性收尾，不声称已回滚。

`health.resourceCleanup` 是最多 100 条资源关闭记录（owner、kind、closed/failed 与最多 1024 字符错误），`omitted` 表示更早记录被省略。进程数量为零不能替代这些结果或真实 PID 退出证据。关闭失败会向调用方抛出，重复关闭保留失败；初始化失败会尝试释放已取得资源。记录只保存在当前进程内，不是持久审计或防篡改证明。

规范输入：`wincode_hello_world` 仅支持可选 `greeting`（字符串，最长 1024）和 `toolName`（非空字符串，最长 128，选择本实例支持的工具）；`wincode_diagnose_project` 没有业务参数。`toolNames`、`forceReconnect`、`version` 不是这些工具的规范请求字段，额外字段被忽略，不会重连、切换版本或批量查询。示例：`wincode_hello_world({toolName:"wincode_prepare_context"})`。未知字段容忍不等于已有字段错误类型也能通过。

更新仓库后，先用 `npm run skill:check -- <已安装 wincode 目录的绝对路径>` 核对四份受管手册；不一致退出码为 2。明确更新时使用 `npm run skill:sync -- <同一路径>`，先在同级 .wincode-backup-* 目录以 .bak 后缀备份旧手册（避免备份被发现为重复 Skill），再写入并校验哈希；其他文件保持原样。此操作不注册 MCP、不改客户端配置、不重启运行实例。检查本机安装内容与仓库一致也不证明当前连接加载了新版。

仅遇到故障或用户要求时调用 wincode_hello_world({}) 查看适配器、工作区及 runtime；环境问题再用 wincode_diagnose_project({})。健康成功不证明 Serena 语义连接成功；watcher 停止、最近超时和清理错误如实报告，不自动安装依赖或循环重启。

工具不可用：先确认客户端是否启用了 wincode MCP；已保存配置通常需重新加载客户端/会话。Skill 不负责注册 MCP。当前本机安装路径为 I:/WinCode，STDIO 启动配置：
- 命令：node
- 独立参数：I:/WinCode/dist/index.js、--workspace、I:/WinCode

不要把 codex mcp add 整条终端命令填入启动命令。不要重复注册或静默修改配置。VERSION_MISMATCH 可能表示新网关配了旧 Host，局部查询/状态要求 inspectionVersion=2；按授权重新构建发布。HOST_UNAVAILABLE 时检查已配置 Host 路径/发布产物；构建或环境变更按用户授权执行。

出现 auditNotice.message 时把大小、建议和完整路径简短转告原用户。日志目录为 %LOCALAPPDATA%/WinCode/logs/ui-audit：1 MiB 提醒，2 MiB 前预留结束空间并拒绝新 UI 访问；不自动删除。AUDIT_BUSY 表示另一 Helper 占用审计锁，等其完成后再按需要重试，勿杀目标应用。

需要手动检查时执行已有只读脚本：

```powershell
pwsh -NoProfile -File I:/WinCode/scripts/check-ui-audit.ps1
```

仅用户明确需要桌面弹窗时加 -Desktop；不例行弹窗。日志只有 start 表示结果未知；本地日志不是防篡改证据。清理须获得授权、停止相关调用并保留用户需要的记录，不能为了恢复取证静默删除。

从 0.12.2 起，生产模式仅使用发布的 Release Host，缺失时明确不可用；`npm run dev`（`--development`）才允许 Debug/dotnet-run 回退。`customHostPath` 是显式配置覆盖，不是 MCP 请求字段。Host 响应的 `hostIdentity` 来自实际程序集，包含 version、informationalVersion、configuration 与 framework；旧 Host 未提供身份时不能推定版本一致。

仓内 `npm run check` 执行锁定构建、核心回归和生产 stdio，生成并校验 `dist/delivery-manifest.json`；`npm run check:desktop` 单独运行隔离桌面闭环。`npm run delivery:verify` 检查 Gateway、发布 Host 全部文件及四份受管手册的一致性，不启动 Host，也不验证另一个客户端实例或签名真实性。构建要求 Node 24（22 兼容）和 `global.json` 中锁定的 SDK；缺少环境时按授权安装，不自动修改环境。
