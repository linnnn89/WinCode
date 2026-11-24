# 诊断与恢复

按场景查阅：[Skill 按需会话](#skill-按需会话) · [连接与交付身份](#连接与交付身份) · [错误处理](#错误处理) · [UI 取证失败](#ui-取证失败) · [Roslyn 诊断](#roslyn-诊断) · [关闭与可选托盘](#关闭与可选托盘)。

## Skill 按需会话

若客户端已配置工作区匹配的原生 MCP 连接，直接调用 MCP 工具即可。按需会话模式适用于支持持久交互终端的客户端（如开启 `tty: true` 的 Codex）：切换至该模式前需在客户端配置中禁用原生 WinCode 自动启动条目并刷新客户端；不支持持久终端的环境请继续使用原生 stdio MCP。

### 启动与复用

通过交互终端工具（如 `exec_command` 设 `tty: true`）启动会话，记录返回的 `session_id`（请使用本机实际验证的安装目录与目标项目绝对路径）：

```powershell
node "<WinCode安装目录>/dist/Client/SkillSessionCli.js" --workspace "<目标工作区绝对路径>"
```

- 仅当目标项目已获授权启用 Roslyn 时，才追加 `--roslyn-config "<配置文件绝对路径>"`。
- 启动回执 `ready` 含 `ownerPid`，初始 `status.state = "unused"`、`pid = null`；首次发送业务工具请求时才实际拉起 Gateway，同一任务内全程复用该会话。
- 通过 `write_stdin` 向同一 `session_id` 发送单行 JSON（Windows 交互终端以 `\r` 结尾，单行上限 64 KiB；默认 `timeoutMs` 为 `120000`，范围 `1–180000`），收到上一条回执后再发下一条：

```json
{"id":"q1","tool":"wincode_search_text","arguments":{"query":"Save","scopePaths":["src"]},"timeoutMs":120000}
```

### 读取完整结果与客户端 UI 流程

- **必读结果文件**：终端回执中的 `resultFile` 指向完整的 MCP `CallToolResult` JSON，必须读取该文件以核对 `isError`、业务 `success` 及完整正文；`imageFiles` 指向保存的原始截图文件。结果保存在 `<WinCode安装目录>/test-tmp/skill-sessions/run-*`（含源码或窗口信息，请勿提交或公开）。
- **客户端 UI 动作**：支持通过会话 JSON 调用客户端编排（注意它们是客户端 `action`，不是服务端 MCP 工具名，默认 `timeoutMs` 15000、上限 30000，参数说明见 [UI 手册](ui.md#只读配方)）：
  - `readonly-ui` + `recipe: "checkbox-audit"`：指定复选框集合统计（支持可选总开关短路）。
  - `readonly-ui` + `recipe: "sibling-range"`：读取扁平列表中两个同级标题之间的条目。
  - `expand-ui`：在祖先 `scopePath` 下最多展开一次折叠容器并验证读回目标状态。

### 取消、状态与关闭

```json
{"id":"cancel1","action":"cancel","targetId":"q1"}
{"id":"status1","action":"status"}
{"id":"close1","action":"close"}
```

收到取消确认不代表副作用已回滚，仍须读取原请求的最终结果。任务结束时发送 `close`（或关闭 stdin）并核对 `closed` 状态与子进程退出。

## 连接与交付身份

- 工具列表或参数与预期不符时，调用 `wincode_hello_world({ toolName: "具体工具名" })` 核对 `version`、`runtime.instanceId`、`runtime.build.buildId`、`toolContract.schemaHash`、`uiMode`、`uiWriteWindowBound`、`uiShortcutWindowBound` 与 `workspace`。
- `wincode_hello_world` 仅读取已知缓存状态，不主动拉起探测进程；返回 `unknown`、`null` 或 `not-observed` 仅代表尚未探测，不代表不可用。需主动检查 Git、`.NET SDK`（对照最近 `global.json`）、Repomix 与 UIA 时，请调用 `wincode_diagnose_project`（动态模式传入 `workspacePath`）。
- **UIA `inspectionVersion` 版本要求**：查询与状态读取需 `>=2`，基础动作需 `>=3`，`set_expanded` 需 `>=4`，`scopePath` 父路径需 `>=5`，`--background-ui` 与绑定窗口 `setValue` 需 `>=7`，绑定窗口后台 WPF 声明式快捷键 `wincode_ui_shortcut` 需 `>=8`。遇到 `VERSION_MISMATCH` 时请检查发布目录与连接进程，切勿通过删减 `scopePath` 等安全范围参数绕过检查。

| 仓库维护命令 | 验证范围 |
| --- | --- |
| `npm run check` | 类型检查、锁定构建、核心回归、新进程 stdio 集成与交付清单生成校验 |
| `npm run check:desktop` | 隔离 WPF 夹具的桌面 UI 与源码关联验收（需交互式桌面） |
| `npm run delivery:verify` | 只读核验磁盘 Gateway、原生 Release 组件与四份受管 Skill 手册哈希一致 |
| `npm run skill:check -- <绝对Skill目录>` | 只读比对已安装四份手册与仓库是否一致（不一致退出码为 `2`） |
| `npm run skill:sync -- <绝对Skill目录>` | 自动备份已修改旧文件（`.wincode-backup-*/*.bak`）后同步四份受管手册 |

## 错误处理

排错时先保留完整错误响应、`requestId` 与阶段信息，同时检查协议层 `isError` 与领域层 `success` / `outcome`。对于具有副作用的操作，结果未知时先只读读回当前状态，切勿盲目重发。

| 错误码 / 状态 | 原因与处理方式 |
| --- | --- |
| `WORKSPACE_MISMATCH` | 固定连接收到了非启动根路径；按返回的 `activeWorkspace` / `requestedWorkspace` 切换连接或改用 `--dynamic-workspace`。 |
| `WORKSPACE_BUSY` | 动态模式的 4 个工作区槽位均在使用或初始化中；等待在途请求完成后再试。 |
| `WORKSPACE_RECOVERY_REQUIRED` | 查看 `recoveryAction`：`workspace_open` 可在固定模式下恢复同根实例；若提示 `restart_gateway`（如槽位清理失败），核查资源后重建 MCP 连接。 |
| `GIT_NOT_TRUSTED` | 目标仓库未在启动时通过 `--trust-git <绝对项目根>` 授权；当前自动回退为目录指纹，如需原生 Git 状态请补充启动参数后重连。 |
| `SERVER_BUSY` | 超出单实例并发上限（32 个业务槽 / 4 个状态槽）；若 `workStarted: false` 表示尚未执行，等待在途任务结束后按需重试，勿死循环刷请求。 |
| `REQUEST_TIMEOUT` / `CANCELLED` | 耗时计入排队、启动、执行与收尾全过程；先检查是否已产生部分结果及工作区健康状态。 |
| `HOST_UNAVAILABLE` / `VERSION_MISMATCH` | 核对 Release 发布目录完整性、配置路径与客户端进程是否已重连最新构建。 |
| `OUTPUT_BUDGET_EXCEEDED` | 缩小查询范围或适当调高 `maxOutputChars` / `maxTokens`，保留未覆盖区间记录。 |
| `OUTSIDE_WORKSPACE` / `UNSUPPORTED_LINK` | 路径超出授权工作区或包含不支持的符号链接/目录联接；改用工作区内的真实普通路径。 |

## UI 取证失败

- **提示浮层准入**：原生 Host 在访问窗口前必须成功显示 `REC / WinCoding` 提示浮层并写入审计日志。若返回 `Recording indicator could not be displayed`，说明浮层未就绪、UI 访问已被中止；保留原生错误信息并检查 Helper 是否已退出，切勿尝试绕过浮层门槛。
- **审计锁与容量**：`AUDIT_BUSY` 表示另一实例正在执行 UI 操作并持有命名 Mutex，稍候重试即可。审计日志位于 `%LOCALAPPDATA%/WinCode/logs/ui-audit`（达 1 MiB 返回 `auditNotice` 提醒，接近 2 MiB 时拒绝新访问；请简短告知用户路径与大小，未经用户授权切勿静默删除日志）。可用内置脚本只读检查：

```powershell
pwsh -NoProfile -File "<WinCode安装目录>/scripts/check-ui-audit.ps1"
```

## Roslyn 诊断

出现编译或加载诊断时，先读取 `semanticContext.diagnosticSummary`（`compilationErrorCount`、`loadDiagnosticCount` 与项目分组统计），再查看 `limitations` 中的样例：
- 遇到 `CS0234` 等命名空间缺失时，先核对入口项目与被引用类库各自的 `TargetFramework`、NuGet 还原资产与实际 `MetadataReference`。
- 遇到 `CS8795` 等分部成员缺失时，结合源生成器排除策略判断（Code Host 当前默认排除分析器与生成器，切勿仅凭诊断码擅自改项目框架或安装包）。

| Roslyn 错误码 | 处理方式 |
| --- | --- |
| `SNAPSHOT_STALE` / `INPUTS_CHANGED` | 源码或项目输入已变更；重新调用 `wincode_find_code_symbol` 获取新 `location`。 |
| `HOST_RESTART_REQUIRED` | 按 `recoveryAction` 恢复当前工作区；若修改了 `--roslyn-config` 文件内容则需重连 MCP。 |
| `HOST_TIMEOUT` / `HOST_CRASHED` | 旧 `location` 已失效；排查超时或崩溃原因后，下一次显式符号搜索会拉起新 Host。 |
| `PROJECT_LOAD_FAILED` / `INPUT_UNAVAILABLE` | 检查 `.csproj` XML、配置路径与 `additionalInputs` 缺失文件，修复后再重新搜索。 |
| `HOST_VERSION_MISMATCH` / `HOST_PROTOCOL_ERROR` | 核对 Gateway 与 `WinCode.Code.Host` 是否来自同一次完整 Release 构建。 |
| `LEGACY_SYMBOL_ID` / `SYMBOL_MISMATCH` | 重新搜索符号，确保原样传入返回的声明 `name` 与声明标识符起点的完整 `location`。 |
| `UNSUPPORTED_SYMBOL_LOCATION` | 当前连接未启用 Roslyn（`local-text` 无法消费语义 `symbolLocation`）。 |
| `INPUT_BUDGET_EXCEEDED` | 区分文件枚举数超限或输入总字节超限，收敛项目范围，不接受截断快照。 |

## 关闭与可选托盘

- 连接关闭或收到 EOF 时，Gateway 会取消在途任务并在预算时间内回收本实例拉起的子进程树（校验进程创建时间顺序，绝不终止用户的目标应用）。
- 可选托盘 `WinCode.Tray.exe` 默认不启用、不自启动；仅管理同用户会话下带 `--tray` 启动的实例。在托盘内手动释放空闲 Roslyn 内存后，Gateway 保持运行但旧 `symbolLocation` 失效；关闭托盘界面不会停止 MCP 服务。
