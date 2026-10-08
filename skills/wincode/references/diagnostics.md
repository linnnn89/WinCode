# 诊断与恢复

按需启动读[会话入口](#skill-按需会话)；连接或版本问题读[连接与交付身份](#连接与交付身份)；运行失败按[错误处理](#错误处理)、[UI 取证失败](#ui-取证失败)或[Roslyn 诊断](#roslyn-诊断)查阅。

## Skill 按需会话

已有正确工作区的原生 MCP 连接时直接使用。按需模式适合能保留交互终端的客户端；安装切换需禁用原生 WinCode 自动连接并刷新客户端，日常调用不自行改配置。没有持久终端时使用已配置的原生连接。

安装路径从实际客户端配置或已核实交付目录取得，不沿用别人的机器路径。工作区使用本任务的绝对目录。

### 启动与复用

通过 exec_command 启动，设置 tty:true，保存返回的 session_id：

```powershell
node "<WinCode安装目录>/dist/Client/SkillSessionCli.js" --workspace "<目标工作区绝对路径>"
```

只有目标项目已获准使用 Roslyn 时才追加 `--roslyn-config "<配置文件绝对路径>"`。入口 ready 包含 ownerPid；初始 status.state=unused、pid=null，首次工具请求才创建 Gateway。一次任务复用此会话，不逐次启动新进程。

使用 write_stdin 向同一个 session_id 发送单行 JSON。Windows 交互终端的 chars 以 `\r` 结束；一次请求收到回执后再发下一次。工具返回仍在运行时继续等待原会话，不重复提交。

```json
{"id":"q1","tool":"wincode_search_text","arguments":{"query":"Save","scopePaths":["src"]},"timeoutMs":120000}
```

id 为1–64位字母、数字、点、下划线或连字符，任务内不重复。单工具 timeoutMs 默认120000、范围1–180000，包含连接等待；单行请求不超过64KiB。

### 读取完整结果

回执中的 resultFile 指向完整 MCP CallToolResult；读取该文件，核对 isError 和业务 success，保留全部内容块。imageFiles 指向原始图片，可用本地图片查看工具读取。终端回显、折行或仅有路径都不是完整结果。

结果保存到安装目录的 test-tmp/skill-sessions/run-*，关闭后仍保留；可能含源码和窗口内容，不直接公开或提交。每次调用需要额外读取结果文件，这是按需入口的实际成本。

### 客户端 UI 流程

先列窗并确定 PID/HWND，再选择[UI 手册](ui.md#只读配方)中的请求：

| action | 用途 |
|---|---|
| readonly-ui + recipe:checkbox-audit | 指定复选框统计，可按摘要状态决定是否读详情 |
| readonly-ui + recipe:sibling-range | 读取两个同级标题之间的条目 |
| expand-ui | 最多展开一次父级，再读目标复选框；带状态验证 |

这些是客户端 action，不是 MCP 工具名，不接受任意源码或表达式。timeoutMs 默认15000、上限30000。非法配方参数在连接／读取前拒绝，回执带 requestError、errorCode、field、recoveryAction 和 workStarted:false；据反馈修正参数，不把修正建议当已执行结果。

### 取消与关闭

```json
{"id":"cancel1","action":"cancel","targetId":"q1"}
{"id":"status1","action":"status"}
{"id":"close1","action":"close"}
```

cancel 的 targetId 指向当前请求；确认收到取消不表示工作已回滚，仍读取目标的最终结果。任务结束或放弃时发送 close，检查 closed/status 和进程退出。stdin EOF 同样触发清理；关闭失败保留错误，不因为终端结束就宣称清理成功。

### 指定构建验收

用户明确要求测试当前分支构建，且现有连接 buildId 不符时，可保留旧配置，用一个分支 CLI 会话顺序调用；核对磁盘与实际 hello 身份，结束后关闭。不同时向旧、新连接提交同一业务任务，也不为测试静默替换默认连接。

## 连接与交付身份

工具和参数不符时调用 `wincode_hello_world({toolName:"具体工具名"})`，比较 tools/list、schemaHash、runtime.instanceId/build.buildId 和 workspace。hello 只读已有状态，不启动探测；unknown、available:null 或 not-observed 都表示未知，不能当作不可用或零值。

需要主动检查环境时用 `wincode_diagnose_project({})`；它检查SDK及Repomix/UIA，对Roslyn只读已有状态。不要给 hello/diagnose 传 forceReconnect、toolNames、version 等未声明字段。

原生 stdio 启动命令为 node，独立参数为 `<安装目录>/dist/index.js`、`--workspace`、`<绝对工作区>`。不要把整条终端安装命令填入启动命令。配置保存、磁盘构建和 Skill 同步都不会热更新运行实例；按客户端正常方式重连。

生产使用完整 Release 发布目录。UIA 查询／状态、语义动作、展开、父路径分别需要 inspectionVersion 2、3、4、5。VERSION_MISMATCH 时核对实际 Host 身份及发布文件，不删除范围或状态参数绕过版本检查。

| 仓内维护命令 | 证明范围 |
|---|---|
| npm run check | 锁定构建、核心回归、生产 stdio、交付清单 |
| npm run check:desktop | 隔离桌面流程，不代表任意用户软件通过 |
| npm run delivery:verify | 磁盘Gateway、Host、四份受管Skill文件一致；不验证现有客户端 |
| npm run test:roslyn-host / test:roslyn-gateway | 生成夹具的语义与进程验证，可能还原夹具依赖 |
| npm run skill:check -- <绝对Skill目录> | 只读比较四份手册；不一致退出码2 |
| npm run skill:sync -- <绝对Skill目录> | 先备份旧手册，再同步并校验哈希；保留其他文件 |

维护命令从 WinCode 仓库执行，环境要求以 global.json 和包配置为准。缺少SDK或依赖时按用户授权处理，不自动安装。Skill备份位于同级 .wincode-backup-*，文件用 .bak 后缀；同步不改MCP配置，也不证明当前会话重新加载了Skill。

## 错误处理

先保存完整响应、requestId、实际阶段和必要日志，再决定下一步。isError 与业务 success 都要检查；领域工具还可能返回 partial。未知动作结果先读回，不能统一按“未执行”重发。

| 错误／状态 | 处理 |
|---|---|
| WORKSPACE_MISMATCH | 按 activeWorkspace/requestedWorkspace 选择连接，原根未切换 |
| WORKSPACE_RECOVERY_REQUIRED | 查看 recoveryAction；workspace_open 只恢复同根，restart_gateway 则先核查自有资源清理，再重建对应连接 |
| SERVER_BUSY | workStarted:false 表示尚未开始。等在途工作结束后按需重试，不循环请求或重启Host |
| REQUEST_TIMEOUT / CANCELLED | 包含启动、排队、执行或收尾；核对实际结果及恢复状态 |
| HOST_UNAVAILABLE / VERSION_MISMATCH | 核对配置路径、完整发布目录与实际版本 |
| OUTPUT_BUDGET_EXCEEDED | 根据具体工具缩小范围或提高允许的输出预算；保留缺口 |
| OUTSIDE_WORKSPACE / UNSUPPORTED_LINK | 修正为授权范围内的实际路径，不放宽边界 |

每实例最多32个在途业务请求、4个轻量状态请求，UI仍有独立互斥。health.admission 的 waitMs 是队列等待，executionMs 包含I/O与清理，不是CPU时间。health.resourceCleanup 是有界内存记录；需要证明退出时同时核对自有PID，不按客户端名称清理其他进程。

缓存统计也可能是历史观察。overflow附件失效就重新取得上下文；不为修复单个问题全局删除缓存。Repomix未配置或失败时可返回builtin-fallback，查看实际source/lastError；显式customCliPath是宿主配置，不是MCP参数，不用npx临时下载补救。

## UI 取证失败

Host 必须显示 REC/WinCoding 提示并写入审计。`Recording indicator could not be displayed` 表示提示未就绪，UI访问被拒绝；保留原生错误、审计阶段及耗时，检查自有Helper是否退出。没有根因证据时，不修改提示门槛或把后续成功当成已修复。

AUDIT_BUSY 表示另一Helper持有审计锁，等其完成；不终止目标应用。日志位于 `%LOCALAPPDATA%/WinCode/logs/ui-audit`，1MiB提醒，接近2MiB时预留结束记录空间并拒绝新访问。出现 auditNotice.message 时简短转告大小、完整路径和建议。

需要检查时使用安装目录的现有脚本：

```powershell
pwsh -NoProfile -File "<WinCode安装目录>/scripts/check-ui-audit.ps1"
```

只有用户需要弹窗时加 -Desktop。日志只有start表示结果未知。清理日志需用户授权并保留所需记录，不为恢复访问静默删除。截图失败、黑图或窗口最小化按[UI手册](ui.md#选择目标与取证)处理。

## Roslyn 诊断

先读 semanticContext.diagnosticSummary 的总数、错误码与项目分组，再看limitations中的样例。CS0234等缺失命名空间先核对入口及引用项目各自的TargetFramework、restore assets、实际MetadataReference；正常编译不证明设计时加载相同。CS8795等partial缺失需结合生成器配置及排除数量；不凭错误码安装包、改框架或开启生成器。

| 错误 | 处理 |
|---|---|
| SNAPSHOT_STALE / INPUTS_CHANGED | 重新显式搜索符号，获得新location；失败的引用请求不自动重放 |
| HOST_RESTART_REQUIRED | 按recoveryAction对同一工作区恢复；配置变化仍需重建连接 |
| HOST_TIMEOUT / HOST_CRASHED | 旧location失效，下一次显式搜索才启动新Host |
| PROJECT_LOAD_FAILED | 修复实际项目输入，再显式搜索；不继续使用旧快照 |
| INPUT_UNAVAILABLE | 核查配置、项目及additionalInputs，恢复缺失文件，不静默移除输入 |
| HOST_VERSION_MISMATCH / HOST_PROTOCOL_ERROR | 核对Gateway与Code Host版本、Release发布、协议及输入策略；不混用交付 |
| LEGACY_SYMBOL_ID / SYMBOL_MISMATCH | 重新搜索并传回实际名称和完整location |
| UNSUPPORTED_SYMBOL_LOCATION | 当前实例未配置Roslyn；文本定位不能冒充语义身份 |
| INPUT_BUDGET_EXCEEDED | 分清枚举数量与输入字节超限，缩小合法范围，不接受截断快照 |

queryComplete:false可能是生成器或加载图的覆盖限制，不一定是运行故障；可使用已验证的局部证据，但零引用不证明全局没有引用。

## 关闭与可选托盘

close/EOF 会取消活动工作并在统一预算内清理自有资源。所属进程退出保护只针对本实例Helper及已覆盖的后代，不终止目标应用；不要手工伪造所属PID。清理失败保留非零结果，不能靠反复关闭掩盖。

托盘为显式可选组件，默认不启用、不自启动。它只管理已注册的同用户／会话实例；释放Roslyn保留Gateway，旧location失效。业务在途时释放可能被拒绝，清理失败进入恢复状态。退出托盘不会停止Gateway，概览也不证明Agent当前空闲。
