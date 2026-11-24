# WinCode Skill 安装、维护与 MCP 配置指南

适用版本：**0.17.1**。下文使用 `C:/path/to/WinCode` 和 `C:/projects/App` 作为路径占位符，实际配置时请替换为本机绝对路径。不同客户端的设置界面名称可能随版本调整，请以客户端实际界面为准。

## 1. 三个独立对象

日常排查版本或行为不一致时，需区分以下三个彼此独立的对象：

- **Skill 手册**：指导智能体选择工具并传入规范参数；发现或读取手册本身不会启动服务器。
- **磁盘交付物**：包含编译后的 Gateway、原生 `WinCode.UIA.Host` / `WinCode.Code.Host`、可选托盘 `WinCode.Tray` 的完整 Release 发布目录及交付清单（`dist/delivery-manifest.json`）。
- **MCP 运行实例**：客户端已经拉起的 Node 进程；修改源码、重新编译或同步 Skill 文件都不会自动热更新已运行的进程，必须由客户端重新连接。

整体架构见 [架构与数据流说明](WinCode-架构与数据流说明.md)，未完成事项统一维护在 [迭代计划](docs/next-iteration.md)。

## 2. 构建与交付校验

**前置环境**（需预先独立安装，校验脚本不会自动安装全局依赖）：
- Windows x64（以 Windows 11 x64 为基准）
- Git `>=2.36`
- Node.js `>=22`（推荐 24，兼容 22，不支持 20）
- `global.json` 锁定的 .NET SDK **10.0.303**（`rollForward: "disable"`）及 .NET 10 Windows Desktop 运行时

在仓库根目录执行：

```powershell
npm ci
npm run check
npm run delivery:verify
```

- `npm run check`：依次执行类型检查、Gateway 构建、NuGet 锁定还原、Release 原生组件与测试夹具构建、核心回归、独立进程 stdio 集成验证，并生成与核验交付清单。
- `npm run check:desktop`：需要交互式 Windows 桌面会话，执行 WPF UI 与 UI→源码关联验收。
- `npm run build`：仅编译 TypeScript Gateway，不能单独保证原生组件和交付清单一致。生产模式（`npm start`）只加载已发布的 Release 原生组件；仅 `npm run dev` 显式启用开发期回退。检查报告输出在已忽略的 `test-tmp/check/` 下（清单哈希用于本地一致性核对，并非数字签名）。

## 3. Skill 手册结构与同步

仓库在 `skills/wincode/` 下维护四份受管手册：
- 路由入口：[SKILL.md](skills/wincode/SKILL.md)
- 按任务查阅的分册：[代码与工作区](skills/wincode/references/code.md) · [窗口与 UI](skills/wincode/references/ui.md) · [诊断与恢复](skills/wincode/references/diagnostics.md)

对本机已安装的 Skill 目录，可先只读核对，再按需同步：

```powershell
npm run skill:check -- C:/Users/<用户名>/.agents/skills/wincode
npm run skill:sync  -- C:/Users/<用户名>/.agents/skills/wincode
```

- `skill:sync` 仅管理上述四份文件：写入前自动将本地已修改的旧文件备份到同级 `.wincode-backup-*`（后缀 `.bak`），目录中的其他个人文件保留不动，也不会改动客户端 MCP 配置。
- 仓库内的受管手册属于交付清单输入项；若修改了 `skills/wincode/` 下的文件，需重新运行 `npm run check` 更新交付清单。
- **参数大小写与类型严格匹配**：服务端容忍并剔除未声明的额外字段（不会报错，但该字段不会生效）。例如必须传 `automationId`，误写为 `automationID` 会被忽略；仅含未知字段的 `query` 仍会被判定为缺少有效筛选条件。

## 4. 配置启动方式

### 方式 A：原生 stdio MCP（通用推荐）

大多数支持 `mcpServers` 的客户端可配置单个**动态工作区**入口，供不同项目共用：

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": ["C:/path/to/WinCode/dist/index.js", "--dynamic-workspace"]
    }
  }
}
```

- 参数必须作为独立数组项传入，不要拼成单条 shell 命令字符串。Codex 的 `config.toml` 可在 `[mcp_servers.wincode]` 下填写相同的 `command` 与 `args`。
- 在仓库目录运行 `node dist/index.js --print-connection --dynamic-workspace`（或传入 `--workspace <项目绝对路径>`）可直接打印本机 JSON 配置片段。
- **动态模式（`--dynamic-workspace`）**：每次项目工具调用通过 `workspacePath` 指定项目绝对路径（`workspace_open` 使用 `path`），最多并发保留 4 个活动项目（LRU 回收空闲项目）。
- **固定模式（默认）**：启动参数传 `["C:/path/to/WinCode/dist/index.js", "--workspace", "C:/projects/App"]`，请求其他目录会返回 `WORKSPACE_MISMATCH`。

#### 可选启动参数速查

| 启动参数 | 作用与约束 |
| --- | --- |
| `--dynamic-workspace` | 启用按请求切换项目的动态模式；省略时为绑定单一根目录的固定模式。 |
| `--workspace <绝对目录>` / `-w` | 固定模式下指定绑定工作区；动态模式配合 `--roslyn-config` 时用于标识获准启用 Roslyn 的项目。 |
| `--roslyn-config <JSON绝对路径>` | 显式启用 C# Code Host（文件 `<=16 KiB` 且 `enabled: true`、`allowProjectEvaluation: true`）。 |
| `--trust-git <绝对项目根>` | 授权在该项目根目录内运行原生 Git（可重复传入多个）；未授权仓库返回 `GIT_NOT_TRUSTED` 并改用目录指纹。 |
| `--repomix-cli <JS绝对路径>` | 指定受信的外部 Repomix CLI 入口（`.js`/`.mjs`/`.cjs`）；未指定且内置环境未安装时使用内置打包器。 |
| `--background-ui` | 启用共用桌面后台 UI 模式：强制要求 `PID` + `HWND` 后台检查（`inspectionVersion >= 7`），隐藏 `click` 与 `set_expanded`。 |
| `--ui-write-window <PID>:<HWND>:<FileTime>` | 须配合 `--background-ui`；授权对绑定的单个后台顶层窗口执行 `ValuePattern` 赋值（目标处于前台时拒绝）。 |
| `--ui-shortcut-window <PID>:<HWND>:<FileTime>` | 须配合 `--background-ui`；启用 `wincode_ui_shortcut`（`inspectionVersion >= 8`），仅触发该后台窗口声明的 `WinCode.WpfBackgroundShortcut.v1` 控件。 |
| `--isolated-keyboard` | 仅限独立隔离桌面会话：开启前台逐键输入（`mode: "type"`）；不可与 `--background-ui` 同用。 |
| `--tray` | 允许连接到本地可选托盘程序 `WinCode.Tray.exe`，用于查看状态或手动释放空闲 Roslyn 内存。 |

### 方式 B：Codex Skill 按需会话模式

适用于支持持久交互终端（`exec_command` 设 `tty: true`）的 Codex 环境，做到首次调用时才拉起 WinCode：

1. 完成构建并同步 Skill，在 Codex `config.toml` 的 `[mcp_servers.wincode]` 段设置 `enabled = false`，刷新客户端连接（防止客户端启动时自动拉起常驻进程）。
2. 智能体在任务首次需要时通过交互终端运行 `node "<WinCode目录>/dist/Client/SkillSessionCli.js" --workspace "<项目绝对路径>"`，任务内通过同一个 `session_id` 发送单行 JSON 请求并从 `resultFile` 读取完整结果与图片路径，任务结束发送 `close` 关闭。
3. 详细交互协议与客户端只读 UI 配方（`readonly-ui` / `expand-ui`）见 [诊断与恢复手册](skills/wincode/references/diagnostics.md#skill-按需会话) 与 [客户端 UI 工作流](docs/hybrid-readonly-orchestration.md)。结果文件保存在 `test-tmp/skill-sessions/`，请勿公开提交。

## 5. 连接验证要点

1. 客户端重连后调用 `wincode_hello_world`（动态模式可传入 `workspacePath`），核对 `version`、`runtime.build.buildId`、`toolContract.schemaHash`、`uiMode` 与 `codeProvider`。
2. `wincode_hello_world` 仅读取已知缓存状态，不会主动拉起外部探测进程；字段为 `unknown` 或 `null` 仅表示尚未探测，不代表组件不可用。需主动探测 SDK、Git、Repomix 与 UIA 时，请调用 `wincode_diagnose_project`。
3. 代码分析后端看 `hello.codeProvider`（默认 `local-text`，显式配置后为 `roslyn`），Roslyn 详细状态看 `hello.health.roslyn`（首次执行符号搜索时才实际加载项目）；`hello.health.text.semanticConfigured` 仅描述文本适配器本身，始终为 `false`。

## 6. 常见问题排查

| 现象 | 排查与处理方式 |
| --- | --- |
| 源码已更新，但 `hello` 仍返回旧版本或旧 `buildId` | 客户端仍连着旧 Node 进程。核对客户端配置的入口路径与 `instanceId`，在客户端内执行 MCP 重连。 |
| 传入的筛选字段未生效 | 对照手册字段表或通过 `wincode_hello_world({ toolName })` 查看实际 Schema，检查字段名大小写与类型。 |
| 修改文件后读取到的仍是旧内容 | 先核对连接 `buildId` 是否为最新构建；跨调用的临时附件不提供永久租约，文件内容变更后重新调用读取工具即可。 |
| 客户端取消请求后，后台子进程短暂仍在收尾 | 客户端取消返回早于服务端异步清理完成属正常现象；观察在途计数归零即可，无需反复重启连接。 |
| 报 `HOST_UNAVAILABLE` 或 `VERSION_MISMATCH` | 重新执行 `npm run check` 与 `npm run delivery:verify`，确保使用完整的 Release 发布目录，切勿混用新 Gateway 与旧 DLL。 |
| Roslyn 不可用或未生效 | 检查启动参数是否包含 `--roslyn-config`、JSON 中是否开启 `allowProjectEvaluation: true`。Roslyn 报错时不会静默降级为 `local-text`。 |
| Roslyn 查找引用返回候选列表且 `references` 为空 | 仅按简单名称调用且存在重名/重载时不会直接查引用；请按 `signature`/`file`/`project` 选定目标，传入完整 `symbolLocation` 重试。 |
| 符号定位报 `SNAPSHOT_STALE` / `INPUTS_CHANGED` | 项目文件或源码已变更导致旧快照位置失效；等待文件写入稳定后重新执行 `wincode_find_code_symbol` 获取新 `location`（无独立 reload 工具）。 |
| Git 状态显示 `GIT_NOT_TRUSTED` | 启动参数未通过 `--trust-git <绝对项目根>` 授权该仓库；按需补充参数并重连，或继续使用默认的目录指纹模式。 |
| UI 查不到控件或提示非唯一 | 核对目标 `pid`/`hwnd` 及区分大小写的查询条件；仅当 `searchComplete: true` 且 `status: "unique"` 时才代表唯一命中。 |
