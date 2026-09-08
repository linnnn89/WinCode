# 诊断与审计

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
