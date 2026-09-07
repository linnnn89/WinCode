# 诊断与审计

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
