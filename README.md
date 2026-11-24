# WinCode

<p align="center">
  <strong>Background UI inspection and code analysis for Windows and .NET—supporting text-only LLMs.</strong><br>
  面向 Windows 与 .NET 的后台 UI 检查与代码分析工具，支持纯文本大语言模型。
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#简体中文">简体中文</a><br>
  <img src="https://img.shields.io/badge/Platform-Windows%2011%20x64-0078D6" alt="Windows 11 x64">
  <img src="https://img.shields.io/badge/MCP-stdio-black" alt="MCP stdio">
  <a href="https://github.com/linnnn89/WinCode/actions/workflows/ci.yml"><img src="https://github.com/linnnn89/WinCode/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="MIT license"></a>
</p>

<p align="center">
  <a href="WinCode-Skill制作与MCP配置指南.md">Setup / 配置指南</a> ·
  <a href="skills/wincode/references/code.md">Code / 代码手册</a> ·
  <a href="skills/wincode/references/ui.md">UI / 界面手册</a> ·
  <a href="WinCode-架构与数据流说明.md">Architecture / 架构说明</a> ·
  <a href="CHANGELOG.md">Changelog / 版本记录</a>
</p>

---

## English

WinCode is a local Model Context Protocol (MCP) server for AI coding agents on Windows. It combines Windows UI Automation (UIA), source navigation, and .NET project analysis in a single connection, allowing an agent to inspect a running desktop application and examine its codebase together.

### Features

- **Background UI inspection**: Read control trees, properties, and states from a running application without activating its window or stealing keyboard focus, so you can keep working in other windows.
- **Text-only LLM friendly**: Control names, hierarchy, and states are returned as structured JSON. Models without vision input (such as text-only DeepSeek configurations) can inspect desktop UIs; screenshots are optional.
- **UI-to-source correlation**: Inspect a live control, locate candidate XAML declarations and related C# code, and read the relevant lines with file paths, line numbers, and content hashes.
- **Targeted, bounded reads**: Scope UI queries to an observed parent path or control selector, and read specific source line ranges or declarations to keep context payloads small.
- **Project and code analysis**: Inspect `.sln`/`.csproj` project graphs, search literal text and symbols, read file outlines, and evaluate change impact. Built-in text analysis works out of the box; optional Roslyn integration adds compiler-backed C# symbol and reference resolution.
- **Guarded semantic UI actions**: Act on uniquely matched enabled controls via UIA patterns (`click`, `set_expanded`, `type`/`setValue`, and opt-in bound WPF shortcuts)—never coordinate mouse simulation. Disabled controls, ambiguous or incomplete matches, read-only values, and unconfirmed focus are rejected.

### Quick start

**Prerequisites**: Windows x64 (Windows 11 x64 baseline), Git `>=2.36`, Node.js `>=22` (24 recommended, 22 supported), and .NET SDK **10.0.303** (pinned in `global.json` with `rollForward: "disable"`). The published UI helper and optional Tray require the .NET 10 Windows Desktop runtime.

#### 1. Build and verify

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run check
```

`npm run check` builds the TypeScript Gateway and native .NET helpers, runs core regression and stdio integration tests, and verifies the delivery manifest (`npm run delivery:verify` re-checks artifacts standalone).

#### 2. Configure your MCP client

Add a dynamic stdio server entry so one connection can work across multiple projects:

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

- Replace `C:/path/to/WinCode/dist/index.js` with your built absolute path (run `node dist/index.js --print-connection --dynamic-workspace` in the WinCode directory to print your local snippet).
- In GUI clients, select `stdio` and pass the script path and `--dynamic-workspace` as two separate arguments.
- To lock a connection to a single repository instead, pass `["C:/path/to/WinCode/dist/index.js", "--workspace", "C:/projects/App"]`.
- For Codex with persistent interactive terminals, an optional on-demand CLI session mode is also available; see the [Setup Guide](WinCode-Skill制作与MCP配置指南.md).

#### 3. Verify the connection and run your first query

Ask your agent to call `wincode_hello_world` to confirm `health.workspaceBinding.mode`, then try:

> Summarize the project structure of `C:/projects/App`, list `src`, and find the code that saves data.

In `--dynamic-workspace` mode, project tools take the target project's absolute directory in `workspacePath` (`workspace_open` uses `path`).

### Example: Investigate a disabled Save button

> Find the running application window, check whether the Save button is enabled without bringing the window to the foreground, and locate the related XAML and C# code.

1. Call `wincode_ui_list_windows` (filtering by `processName` or `titleContains`) to get the target `pid` and `hwnd`.
2. Call `wincode_ui_review` with the target control query and candidate source files (use `wincode_search_text` first if file paths are unknown; use `wincode_ui_inspect` if you only need the UI tree):

```json
{
  "workspacePath": "C:/projects/App",
  "pid": 12345,
  "hwnd": "0x123456",
  "backgroundOnly": true,
  "capture": "none",
  "responseFormat": "compact",
  "query": { "automationId": "SaveButton", "controlType": "Button" },
  "maxDepth": 3,
  "maxNodes": 30,
  "candidateFiles": ["Views/MainWindow.xaml"],
  "candidateCodeFiles": ["ViewModels/MainWindowViewModel.cs"]
}
```

3. Inspect the returned control properties (for example, `isEnabled: false`) and pass the returned `nextRequest` directly to `wincode_prepare_context` to read the candidate declaration or command logic.
4. Verify the source code before concluding why the button is disabled—name matches identify code to read, not the live `DataContext`. Add `readStates: true` when you need toggle/selection/expand states, or `capture: "annotated"` for a numbered window screenshot.

### Tools overview

For targeted source reading, `wincode_search_text` (literal string search, no regex) and `wincode_file_outline` both generate follow-up arguments for `wincode_prepare_context`:

```json
{
  "workspacePath": "C:/projects/App",
  "task": "Review the save logic",
  "lineRanges": [{ "file": "src/Service.cs", "startLine": 50, "endLine": 80 }],
  "maxTokens": 2000
}
```

`lineRanges` reads explicit lines; `scopeFiles` restricts reading to listed files; `candidateFiles` prioritizes files during discovery without excluding others. `maxTokens` is a UTF-16 character-based estimate rather than an exact tokenizer count.

| Category | Tool | Purpose |
| --- | --- | --- |
| **Workspace & Status** | `wincode_hello_world` | Inspect instance identity, workspace binding, UI mode, capabilities, and a tool's live schema (`toolName`). |
| | `wincode_diagnose_project` | Check Git, Repomix/UIA availability, and `.NET SDK` selection against the nearest `global.json`. |
| | `workspace_open` | Return a compact project summary (uses `path`; in fixed mode it must match the startup root). |
| | `wincode_list_directory` | Browse directories with depth, entry-count, and output limits. |
| | `wincode_analyze_workspace` | Parse declared `.sln` and `.csproj` structure and project references. |
| | `wincode_safe_move_to_trash` | Move a regular workspace file to WinCode's local trash via the native Windows handle-verifying helper. |
| **Code Intelligence** | `wincode_search_text` | Search literal strings across scoped files or directories. |
| | `wincode_file_outline` | Extract local declarations and line count from a file. |
| | `wincode_prepare_context` | Read bounded source excerpts with line ranges, coverage, and truncation metadata. |
| | `wincode_find_code_symbol` | Search symbols via `local-text` (default) or `roslyn`. |
| | `wincode_find_references` | Find symbol references with known totals, returned counts, and output-budget reporting. |
| | `analyze_change_impact` | Assess potential impact of changing a symbol and surface incomplete-evidence uncertainty (`wincode_analyze_change_impact` alias included). |
| | `wincode_plan_refactoring` | Generate verification steps and safety checks for a proposed refactoring. |
| **Desktop UI** | `wincode_ui_list_windows` | List visible top-level windows with process and title filters. |
| | `wincode_ui_inspect` | Read UIA control subtrees, optional control states, and optional screenshots. |
| | `wincode_ui_review` | Inspect UI controls and correlate candidate XAML/C# source locations. |
| | `wincode_ui_click` | Invoke, toggle, or select one uniquely matched control (standard connections only). |
| | `wincode_ui_set_expanded` | Explicitly expand or collapse one uniquely matched control, with optional `scopePath` (standard connections; requires `inspectionVersion >= 4`, or `5` with `scopePath`). |
| | `wincode_ui_type` | Set a control's value via `ValuePattern` (`mode: "setValue"`), or send keystrokes when `--isolated-keyboard` is enabled. |
| | `wincode_ui_shortcut` | Trigger an application-declared `WinCode.WpfBackgroundShortcut.v1` control on a launcher-bound background window (listed only with `--background-ui` + `--ui-shortcut-window`; requires `inspectionVersion 8`). |

Full parameter constraints: [Code reference](skills/wincode/references/code.md) · [UI reference](skills/wincode/references/ui.md) · [Diagnostics reference](skills/wincode/references/diagnostics.md). After rebuilding WinCode, reconnect the MCP server in your client so the running process reloads.

### Advanced and optional configuration

<details>
<summary><strong>Workspace modes, LRU slots, Git trust, and Repomix</strong></summary>

- **Dynamic vs. fixed mode**: `--dynamic-workspace` keeps up to **4** on-demand project workspaces open concurrently (each with its own cache and file watcher) and evicts the least recently used idle slot when a fifth is requested. If all 4 slots are busy, it returns `WORKSPACE_BUSY`; if cleanup fails on a slot, accessing that project returns `WORKSPACE_RECOVERY_REQUIRED` (`restart_gateway`). Both standard long paths and Windows 8.3 short paths are accepted under the selected root. Without `--dynamic-workspace`, WinCode binds to `--workspace <abs-path>` (or launch `cwd`) and rejects other roots with `WORKSPACE_MISMATCH`.
- **Trusted Git (`--trust-git`)**: Native Git commands run only in repositories authorized at startup via `--trust-git <abs-root>` (repeatable). Unlisted repositories report `GIT_NOT_TRUSTED` and fall back to directory fingerprints. Recognized remote URLs have credentials stripped in summaries.
- **Repomix (`--repomix-cli`)**: WinCode checks its own installation for Repomix, accepts `--repomix-cli <abs-path-to-cli.js>` for an external trusted copy, and falls back to its built-in packer otherwise.
</details>

<details>
<summary><strong>Shared-desktop background UI & bound window writes/shortcuts</strong></summary>

- Add `--background-ui` when sharing your desktop with an agent. It enforces `PID` + `HWND` background inspection (`inspectionVersion >= 7`) and hides `wincode_ui_click` and `wincode_ui_set_expanded`.
- To allow background `ValuePattern` writes (`wincode_ui_type` with `mode: "setValue"`), pass `--ui-write-window <PID>:<HWND>:<processStartFileTime>` for one top-level window.
- To allow application-declared background WPF shortcuts (`wincode_ui_shortcut`), pass `--ui-shortcut-window <PID>:<HWND>:<processStartFileTime>` (`inspectionVersion >= 8`); see the [WPF background shortcut guide](tools/WinCode.UIA.Host/Wpf/README.md) for `<wc:BackgroundShortcut />` setup and `shortcutStatus` checks.
- Writes and shortcuts are refused whenever the target process owns the foreground window or foreground ownership cannot be verified (`UI_WRITE_TARGET_DENIED`). Rebind if the target process restarts. You can obtain a window's binding string in PowerShell:

```powershell
$appProcess = Get-Process -Id 12345
'{0}:0x{1:X}:{2}' -f $appProcess.Id, $appProcess.MainWindowHandle.ToInt64(), $appProcess.StartTime.ToFileTimeUtc()
```
</details>

<details>
<summary><strong>Roslyn C# semantics, client UI workflows, Tray, and Agent Skill</strong></summary>

- **Roslyn (`--roslyn-config <abs-json-path>`)**: Enables the compiler-backed C# Code Host (requires explicit permission for MSBuild design-time evaluation). On a `--dynamic-workspace` connection, also pass `--workspace <authorized-root>` to identify which project uses Roslyn; other projects use `local-text`. Pass returned symbol `location` objects unchanged as `symbolLocation` to reference/impact tools. See the [Code reference](skills/wincode/references/code.md).
- **Client UI recipes & on-demand session**: `dist/Client/SkillSessionCli.js` supports persistent terminal sessions plus explicit client-side workflows (`readonly-ui` recipes `checkbox-audit` and `sibling-range`, and single-parent `expand-ui` with observed `scopePath`). These workflows do not invoke model APIs or change default MCP behavior; real-application coverage beyond test fixtures remains subject to validation. See [Client UI workflows](docs/hybrid-readonly-orchestration.md).
- **Tray memory release (`--tray`)**: Add `--tray` to Gateway arguments, reconnect, and launch `tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe --show` to manually release idle Roslyn memory under **设置 / 内存管理**. Closing Tray does not stop MCP.
- **Managed Agent Skill**: Run `npm run skill:check -- <abs-skill-dir>` to verify an installed Skill copy, or `npm run skill:sync -- <abs-skill-dir>` to back up and update the four managed Skill manuals.
</details>

### Scope and limitations

- **Interactive desktop & focus**: UI inspection and actions require an interactive Windows session. Global keystrokes (`mode: "type"`) are disabled by default and require `--isolated-keyboard` in an isolated session provided by the launcher (cannot be combined with `--background-ui`). Even without explicit window activation, an application's own event handlers may still bring windows or dialogs forward.
- **UIA provider & rendering coverage**: Exposed properties depend on the target framework's UIA provider. Automated desktop tests cover WPF; custom-rendered or embedded web/CEF surfaces may expose partial or unstable trees. Visual details (colors, layout, icons) require screenshots. Background capture uses `PrintWindow` without desktop-screen fallback and may produce blank or stale images on some GPU-rendered windows—always check `captureQuality`.
- **Heuristic source mapping & analysis limits**: XAML/C# correlations are static text candidates (`runtimeSourceVerified: false`); WinCode does not verify that the running binary matches current source, resolve dynamic bindings/templates, or read live `DataContext`. `.sln`/`.csproj` analysis reads static XML without MSBuild evaluation, `local-text` search is heuristic, and Roslyn currently excludes analyzers/source generators (`queryComplete: false`). Current benchmarks measure scripted scenarios only and do not establish universal speed or accuracy gains over screenshot-based Computer Use.
- **Resource bounds & inspection indicator**: Admission, traversal, and output sizes are bounded (overload returns `SERVER_BUSY`; queue wait counts toward deadlines). During any UI inspection or action, WinCode displays a non-focusing `REC / WinCoding` overlay and writes minimal local audit metadata under `%LOCALAPPDATA%/WinCode/logs/ui-audit`.

### Development and documentation

Current version: **0.17.1** ([CHANGELOG](CHANGELOG.md)). Reference platform: Windows 11 x64.

```powershell
npm run check                           # Build, core regression, stdio integration, and delivery verification
npm run check:desktop                   # Interactive WPF UI and UI-to-source tests (WINCODE_TEST_ISOLATED_KEYBOARD=1 adds keystroke test)
npm run delivery:verify                 # Verify Gateway, native helpers, and managed Skill manifest hashes
npm run test:inventory                  # Verify test suite registration
npm run benchmark:agent -- 1            # Optional scripted efficiency benchmark
npm run benchmark:context -- compare 8  # Model-free paired sequential vs. batched local-text context benchmark
```

[CI](https://github.com/linnnn89/WinCode/actions/workflows/ci.yml) runs on Windows with Node.js 22 and 24 and the pinned .NET SDK; interactive desktop tests run separately. Keep local screenshots and raw diagnostic artifacts in git-ignored directories (`test-tmp/`) and publish only sanitized findings.

- [Setup & Skill Guide](WinCode-Skill制作与MCP配置指南.md) · [Architecture & Data Flow](WinCode-架构与数据流说明.md) · [Client UI Workflows](docs/hybrid-readonly-orchestration.md) · [Contributing](CONTRIBUTING.md) · [Iteration Plan](docs/next-iteration.md) · [Security Policy](SECURITY.md)

---

## 简体中文

WinCode 是面向 AI 编程智能体的本地模型上下文协议（MCP）服务器，集成了 Windows UI Automation（UIA）、源码导航与 .NET 项目分析。智能体可以通过同一个连接检查正在运行的桌面应用，并联动查阅对应的项目源码。

### 核心功能

- **后台 UI 检查**：无需激活目标窗口或切换键盘焦点，即可读取运行中应用的控件树、属性与状态，检查期间不影响你在其他窗口继续操作。
- **支持纯文本大模型**：以结构化 JSON 返回控件名称、层级与状态；不具备图像输入能力的纯文本模型（如纯文本模式下的 DeepSeek）也能检查桌面界面，截图为可选项。
- **UI 与源码联动定位**：检查运行时控件，关联候选 XAML 声明与相关 C# 代码，并结合文件路径、行号与内容哈希读取具体源码片段。
- **按需定向读取**：支持按实际观察到的父路径（`scopePath`）或条件查询局部控件，并按指定行号或声明范围读取源码，减少送入模型的上下文体积。
- **项目与代码分析**：解析 `.sln`/`.csproj` 声明的项目引用结构，搜索字面量文本与符号，提取文件大纲并评估变更影响。默认启用内置文本分析，可选配 Roslyn 获得编译器级 C# 符号与引用分析。
- **受控的语义化 UI 操作**：仅通过 UIA 模式操作单次有界搜索确认唯一的启用控件（支持点击、展开/折叠、直接赋值，以及显式绑定的后台 WPF 声明式快捷键），不使用坐标鼠标模拟；禁用控件、歧义或不完整匹配、只读值及未确认焦点均会直接拒绝。

### 快速开始

**环境要求**：Windows x64（基准平台为 Windows 11 x64）、Git `>=2.36`、Node.js `>=22`（推荐 24，兼容 22），以及 `global.json` 锁定的 .NET SDK **10.0.303**（`rollForward: "disable"`）。发布的 UI 辅助程序与可选托盘依赖 .NET 10 Windows Desktop 运行时。

#### 1. 构建并验证

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run check
```

`npm run check` 会编译 Gateway 与原生 .NET 组件，运行核心回归与 stdio 集成测试，并校验交付清单（也可单独执行 `npm run delivery:verify` 复核产物一致性）。

#### 2. 配置 MCP 客户端

推荐配置动态工作区模式（`--dynamic-workspace`），只需一个连接即可在不同项目间复用：

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

- 将 `C:/path/to/WinCode/dist/index.js` 替换为本机编译产物的绝对路径（在安装目录执行 `node dist/index.js --print-connection --dynamic-workspace` 可直接打印本机配置）。
- 在图形化客户端中选择 `stdio`，将脚本路径与 `--dynamic-workspace` 作为两个独立参数填入。
- 若需绑定单一项目目录（固定模式），参数改为 `["C:/path/to/WinCode/dist/index.js", "--workspace", "C:/projects/App"]`。
- 支持持久交互终端的 Codex 客户端还可选用 Skill 按需会话模式，详见 [Skill 与 MCP 配置指南](WinCode-Skill制作与MCP配置指南.md)。

#### 3. 验证连接并执行首次查询

连接后让智能体调用 `wincode_hello_world` 核对 `health.workspaceBinding.mode`，随后可尝试提问：

> 概述 `C:/projects/App` 的项目结构，列出 `src` 目录内容，并定位负责保存数据的代码。

动态模式下，每次调用项目相关工具都需在 `workspacePath` 中传入目标项目的绝对路径（`workspace_open` 使用 `path` 参数）。

### 使用示例：排查“保存”按钮被禁用的原因

> 查找正在运行的应用窗口，在不切到前台的情况下检查“保存”按钮是否启用，并定位对应的 XAML 与 C# 代码。

1. 调用 `wincode_ui_list_windows`（按 `processName` 或 `titleContains` 筛选），获取目标窗口的 `pid` 和 `hwnd`。
2. 调用 `wincode_ui_review` 指定目标控件与候选源码文件（若尚不清楚文件路径，先用 `wincode_search_text` 搜索；若只需查看控件树，改用无需工作区参数的 `wincode_ui_inspect`）：

```json
{
  "workspacePath": "C:/projects/App",
  "pid": 12345,
  "hwnd": "0x123456",
  "backgroundOnly": true,
  "capture": "none",
  "responseFormat": "compact",
  "query": { "automationId": "SaveButton", "controlType": "Button" },
  "maxDepth": 3,
  "maxNodes": 30,
  "candidateFiles": ["Views/MainWindow.xaml"],
  "candidateCodeFiles": ["ViewModels/MainWindowViewModel.cs"]
}
```

3. 查看返回的控件属性（如 `isEnabled: false`）与候选位置，将返回的 `nextRequest` 原样传给 `wincode_prepare_context` 读取相关声明或命令逻辑。
4. 结合源码核实原因：绑定或命令名匹配仅提供排查线索，不能单独证明运行时实际的 `DataContext`。需要读取勾选、选中或展开状态时传 `readStates: true`；需要带编号截图辅助核对视觉布局时传 `capture: "annotated"`。

### 工具一览

定位代码时，`wincode_search_text`（普通字符串匹配，不支持正则）与 `wincode_file_outline` 均会返回可直接传给 `wincode_prepare_context` 的续读参数：

```json
{
  "workspacePath": "C:/projects/App",
  "task": "核查保存逻辑",
  "lineRanges": [{ "file": "src/Service.cs", "startLine": 50, "endLine": 80 }],
  "maxTokens": 2000
}
```

`lineRanges` 读取指定行区间；`scopeFiles` 将读取限定在指定文件内；`candidateFiles` 仅作为发现阶段的优先候选（不排除其他文件）。`maxTokens` 为按 UTF-16 字符数换算的估算预算，而非特定模型的精确 Token 数。

| 分类 | 工具 | 用途 |
| --- | --- | --- |
| **工作区与状态** | `wincode_hello_world` | 读取实例身份、工作区绑定、UI 模式、已启用能力，以及指定工具（`toolName`）的当前 Schema。 |
| | `wincode_diagnose_project` | 检查 Git、Repomix/UIA 可用性，以及工作区最近的 `global.json` 对应的 .NET SDK 状态。 |
| | `workspace_open` | 返回项目结构摘要（使用 `path`；固定模式下须与启动工作区一致）。 |
| | `wincode_list_directory` | 按深度、条目数与输出上限浏览目录。 |
| | `wincode_analyze_workspace` | 静态读取 `.sln` 与 `.csproj` 声明的项目结构与引用关系。 |
| | `wincode_safe_move_to_trash` | 通过随产品发布的 Windows 原生助手校验文件句柄后，将工作区普通文件移入本地回收目录。 |
| **代码分析** | `wincode_search_text` | 在指定文件或目录范围内按字面量字符串搜索。 |
| | `wincode_file_outline` | 提取文件的本地声明列表与实际行数。 |
| | `wincode_prepare_context` | 按范围与预算读取源码片段，返回覆盖率与截断说明。 |
| | `wincode_find_code_symbol` | 使用默认 `local-text` 或已配置的 `roslyn` 搜索代码符号。 |
| | `wincode_find_references` | 查找符号引用，返回已知总数、实际返回条数与输出裁剪信息。 |
| | `analyze_change_impact` | 评估符号变更的潜在影响，并在证据不完整时标明不确定性（同时提供别名 `wincode_analyze_change_impact`）。 |
| | `wincode_plan_refactoring` | 为拟议的重构提供核查项与验证步骤建议。 |
| **桌面 UI** | `wincode_ui_list_windows` | 列出可见顶层窗口，支持按进程名和标题筛选。 |
| | `wincode_ui_inspect` | 读取 UIA 控件树，可按需读取控件状态或捕获窗口截图。 |
| | `wincode_ui_review` | 检查 UI 控件并关联候选 XAML/C# 源码位置。 |
| | `wincode_ui_click` | 通过 UIA 模式点击、勾选或选择唯一命中的控件（仅普通连接提供）。 |
| | `wincode_ui_set_expanded` | 显式展开或折叠唯一命中的控件，支持可选 `scopePath`（仅普通连接提供；需 `inspectionVersion >= 4`，带路径需 `5`）。 |
| | `wincode_ui_type` | 通过 `ValuePattern` 直接赋值（`mode: "setValue"`），或在启用 `--isolated-keyboard` 时发送按键。 |
| | `wincode_ui_shortcut` | 触发启动者绑定的后台窗口中由应用显式声明的 `WinCode.WpfBackgroundShortcut.v1` 快捷键控件（仅在同时启用 `--background-ui` 与 `--ui-shortcut-window` 时列出；需 `inspectionVersion 8`）。 |

详细参数约束见：[代码分析手册](skills/wincode/references/code.md) · [UI 检查手册](skills/wincode/references/ui.md) · [诊断与恢复手册](skills/wincode/references/diagnostics.md)。重新构建源码后，请在客户端重新连接 MCP 服务器以加载最新进程与 Schema。

### 高级与可选配置

<details>
<summary><strong>工作区模式、并发槽位、Git 授权与 Repomix</strong></summary>

- **动态与固定模式**：`--dynamic-workspace` 最多同时保留 **4 个**按请求打开的项目工作区（各自拥有独立缓存与文件监听），打开第 5 个时回收最久未使用的空闲工作区；若 4 个可用槽位均在使用或初始化中则返回 `WORKSPACE_BUSY`；清理失败的槽位会被保留，再次访问该项目将返回 `WORKSPACE_RECOVERY_REQUIRED`（`restart_gateway`）。项目路径同时兼容标准长路径与 Windows 8.3 短路径。不带 `--dynamic-workspace` 时为固定模式，绑定 `--workspace <绝对路径>`（缺省为启动目录），访问其他目录返回 `WORKSPACE_MISMATCH`。
- **原生 Git 授权（`--trust-git`）**：仅对启动时通过 `--trust-git <项目绝对根目录>`（可重复传入）显式授权的仓库执行原生 Git 命令；未授权仓库返回 `GIT_NOT_TRUSTED` 并回退为目录指纹，识别到的远程 URL 会自动隐去凭据。
- **Repomix（`--repomix-cli`）**：默认查找 WinCode 自身安装的 Repomix，也可通过 `--repomix-cli <CLI入口绝对路径>` 指定受信的 `.js/.mjs/.cjs` 入口；未安装时使用内置打包器。
</details>

<details>
<summary><strong>共用桌面后台模式与窗口写入 / 快捷键绑定</strong></summary>

- 与智能体共用桌面时可添加 `--background-ui`，强制要求提供 `PID` + `HWND` 进行后台取证（需 `inspectionVersion >= 7`），同时在工具列表中隐藏 `wincode_ui_click` 与 `wincode_ui_set_expanded`。
- 若需允许后台 `ValuePattern` 直接写值（`wincode_ui_type` 配合 `mode: "setValue"`），由启动者额外传入 `--ui-write-window <PID>:<HWND>:<processStartFileTime>` 绑定单个顶层窗口。
- 若需允许触发后台 WPF 声明式快捷键（`wincode_ui_shortcut`），额外传入 `--ui-shortcut-window <PID>:<HWND>:<processStartFileTime>`（需 `inspectionVersion >= 8`）；应用侧声明 `<wc:BackgroundShortcut />` 与查询 `shortcutStatus` 的方法见 [后台 WPF 快捷键接入说明](tools/WinCode.UIA.Host/Wpf/README.md)。
- 当目标进程拥有当前前台窗口或前台归属无法核实时，写入与快捷键请求均会被拒绝（`UI_WRITE_TARGET_DENIED`）。目标进程重启后须重新获取绑定值，可用以下 PowerShell 命令生成：

```powershell
$appProcess = Get-Process -Id 12345
'{0}:0x{1:X}:{2}' -f $appProcess.Id, $appProcess.MainWindowHandle.ToInt64(), $appProcess.StartTime.ToFileTimeUtc()
```
</details>

<details>
<summary><strong>Roslyn 语义分析、客户端 UI 工作流、托盘与 Skill 同步</strong></summary>

- **Roslyn（`--roslyn-config <JSON绝对路径>`）**：启用 C# Code Host（须在配置中明确允许 MSBuild 设计时项目求值）。在 `--dynamic-workspace` 连接中须同时传入 `--workspace <授权项目根>` 指定启用 Roslyn 的项目，其余项目仍使用 `local-text`。查询引用或影响时，请将符号搜索返回的完整 `location` 原样作为 `symbolLocation` 传入。详见 [代码分析手册](skills/wincode/references/code.md)。
- **客户端 UI 工作流与按需会话**：`dist/Client/SkillSessionCli.js` 支持在持久终端中按需启动并复用会话，同时提供显式调用的客户端配方（`readonly-ui` 下的 `checkbox-audit` 复选框统计、`sibling-range` 同级列表分组读取，以及带实际祖先 `scopePath` 的单层 `expand-ui` 展开读回）。这些流程不会自动调用模型 API 或改变客户端默认配置，测试夹具之外的真实应用覆盖与性能仍须按场景单独验证，详见 [客户端 UI 工作流](docs/hybrid-readonly-orchestration.md)。
- **托盘与内存释放（`--tray`）**：为 Gateway 添加 `--tray` 并重连后，手动运行 `tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe --show`，可在“设置 / 内存管理”中手动释放空闲实例的 Roslyn 内存；退出托盘不会停止 MCP。
- **智能体 Skill 同步**：更新仓库后，可用 `npm run skill:check -- <Skill绝对目录>` 校验已安装的 Skill，或用 `npm run skill:sync -- <Skill绝对目录>` 备份并同步受管的四份手册。
</details>

### 适用范围与限制

- **桌面会话与焦点边界**：UI 检查与操作需要交互式 Windows 桌面会话。全局按键发送（`mode: "type"`）默认关闭，仅在启动者提供独立隔离会话并显式传入 `--isolated-keyboard` 时可用（不可与 `--background-ui` 同用）。即使工具本身不调用窗口激活，目标应用自身的事件响应仍可能弹窗或将窗口带到前台。
- **UIA 提供程序与截图限制**：可读控件信息取决于目标框架的 UIA 实现。桌面自动化测试覆盖 WPF；其他框架、自绘控件或部分内嵌 Web/CEF 界面暴露的控件树可能不完整或不稳定。颜色、图标与视觉排版需结合图像核对。后台截图仅使用 `PrintWindow`（不回退到整屏截图），在部分硬件加速窗口上可能出现黑图或旧画面，需检查返回的 `captureQuality`。
- **源码关联与静态分析边界**：XAML/C# 关联结果属于静态文本候选（`runtimeSourceVerified: false`），不验证运行中程序是否由当前源码编译，不解析动态绑定、运行时模板或实际 `DataContext`。项目结构分析仅静态解析 `.sln`/`.csproj` XML 声明；`local-text` 引用为启发式文本匹配；Roslyn 目前排除分析器与源生成器（`queryComplete: false`）。现有基准测试仅覆盖特定脚本化场景，不能据此推断在各类任务中普遍比基于截图的 Computer Use 更快或更准确。
- **资源上限与检查提示**：并发受理、目录遍历与响应体积均设有明确上限（超载返回 `SERVER_BUSY`，排队时间计入总超时）。每次执行 UI 检查或操作期间，屏幕会显示不抢占焦点的半透明 `REC / WinCoding` 提示浮层，并在 `%LOCALAPPDATA%/WinCode/logs/ui-audit` 记录最小必要的本地审计元数据。

### 开发与文档

当前源码版本：**0.17.1**（变更记录见 [CHANGELOG](CHANGELOG.md)）。基准开发与测试平台为 Windows 11 x64。

```powershell
npm run check                           # 构建、核心回归、stdio 集成与交付清单校验
npm run check:desktop                   # 交互式桌面 WPF 与 UI 源码关联测试（独立会话设 WINCODE_TEST_ISOLATED_KEYBOARD=1 启用发键用例）
npm run delivery:verify                 # 单独核验 Gateway、原生组件与受管 Skill 的交付清单哈希
npm run test:inventory                  # 核对自动化测试套件注册完整性
npm run benchmark:agent -- 1            # 运行一轮可选的脚本化效率基准
npm run benchmark:context -- compare 8  # 不调用模型，在隔离夹具中配对比较逐关键词与默认批量（最多 4 词）的 local-text 扫描开销
```

[CI](https://github.com/linnnn89/WinCode/actions/workflows/ci.yml) 在 Windows 环境下使用 Node.js 22、24 及锁定版 .NET SDK 运行，桌面交互测试需在本地独立执行。本机截图与原始诊断输出请保留在已忽略的本地目录（如 `test-tmp/`），公开内容仅保留去标识后的结论。

- [Skill 与 MCP 配置指南](WinCode-Skill制作与MCP配置指南.md) · [架构与数据流](WinCode-架构与数据流说明.md) · [客户端 UI 工作流](docs/hybrid-readonly-orchestration.md) · [贡献指南](CONTRIBUTING.md) · [迭代计划](docs/next-iteration.md) · [安全策略](SECURITY.md)

---

## Acknowledgements / 致谢

WinCode uses or draws ideas from these open-source projects / WinCode 使用或参考了以下开源项目：

- **[FlaUI](https://github.com/FlaUI/FlaUI)** — Windows UI Automation library used by the native UI helper / 原生 UI 辅助程序使用的 Windows UI Automation 库。
- **[Serena](https://github.com/oraios/serena)** — Reference for symbol navigation and semantic code workflows in coding agents / 为编程智能体中的符号导航与语义代码分析提供了设计参考。
- **[Repomix](https://github.com/yamadashy/repomix)** — Optional repository packer for code context preparation / 可选的代码仓库上下文打包工具。

## License / 许可

[MIT](LICENSE)
