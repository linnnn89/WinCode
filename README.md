# WinCode

<p align="center">
  <strong>Background UI inspection and code intelligence for Windows and .NET—with support for text-only LLMs.</strong><br>
  面向 Windows 与 .NET 的后台 UI 检查和代码分析工具，支持纯文本大语言模型。
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#简体中文">简体中文</a><br>
  <img src="https://img.shields.io/badge/Platform-Windows%2011%20x64-0078D6" alt="Windows 11 x64">
  <img src="https://img.shields.io/badge/MCP-stdio-black" alt="MCP stdio">
  <a href="https://github.com/linnnn89/WinCode/actions/workflows/ci.yml"><img src="https://github.com/linnnn89/WinCode/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="MIT license"></a>
</p>

[Setup / 配置指南](WinCode-Skill制作与MCP配置指南.md) · [Code / 代码分析](skills/wincode/references/code.md) · [UI inspection / UI 检查](skills/wincode/references/ui.md) · [Changelog / 版本记录](CHANGELOG.md)

## English

WinCode is a local server implementing the Model Context Protocol (MCP) for AI coding agents. It combines Windows UI Automation (UIA), code navigation and .NET project analysis, so an agent can inspect a running application and investigate its source code through the same connection.

### Features

- **Background UI inspection:** Read controls in a running application without activating its window or changing keyboard focus. Continue working in other applications while the agent inspects the target window.
- **Support for text-only LLMs:** Control names, hierarchy, properties and states are returned as structured JSON. Through an MCP-capable agent client, models such as DeepSeek used without image input can inspect desktop interfaces. Screenshots are optional.
- **UI inspection with source navigation:** Inspect a control, find candidate XAML declarations and related C# code, then read the relevant source lines. File paths, line numbers and content hashes make the findings traceable.
- **Faster, more accurate inspection in everyday use:** In our day-to-day Windows/.NET development, WinCode makes UI inspection and source navigation faster and more accurate than screenshot-based Computer Use workflows. Direct access to structured control properties and source locations reduces reliance on image interpretation and repeated interaction. Targeted queries and compact responses also reduce the amount of data the model needs to process.
- **Project and code analysis:** Explore declared solution and project references, search text and symbols, read selected code, and assess change impact. Built-in text analysis works by default; optional Roslyn integration provides compiler-backed C# symbol and reference analysis.

A recorded test with a 222-node window reduced response text from approximately **62 KB to 1.6 KB** by querying a specific control instead of returning the full tree. See the [test record](docs/codex_worklog.md).

### Example: Investigate a disabled Save button

> Find the application's window, check whether the Save button is enabled without bringing the window to the foreground, and locate the relevant XAML and C# code.

The agent can complete this investigation using text output:

1. Call `wincode_ui_list_windows` with `processName` or `titleContains` to obtain the target process ID (`pid`) and window handle (`hwnd`).
2. Call `wincode_ui_review` with the target control and relevant source files. If those files are not yet known, locate them with the code navigation tools first.

```json
{
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

3. Read the returned control properties and source candidates. For example, `isEnabled: false` reports that the control is disabled. Follow the returned `nextRequest` arguments with `wincode_prepare_context` to inspect the candidate declaration or assignment.
4. Check the source before explaining the behavior. A matching binding or command name identifies code to investigate; it does not by itself establish the active `DataContext` or the reason the button is disabled.

The IDs and paths above are placeholders. Use values from the actual window and workspace. When only the control tree is needed, use `wincode_ui_inspect` without the source-file arguments. Add `readStates: true` for toggle, selection or expand/collapse states; use `capture: "annotated"` when a numbered screenshot is useful for visual review.

### Quick start

**Requirements:** Windows x64, Git 2.36 or later, Node.js `>=22` (24 primary, 22 compatible), and .NET SDK **10.0.303**. The SDK version is pinned in `global.json` with roll-forward disabled. The published UI helper and optional Tray require the .NET 10 Windows Desktop runtime. Windows 11 x64 is the development and test baseline.

**1. Build and verify WinCode**

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run check
npm run delivery:verify
```

Running `npm run check` builds the Gateway and native components, runs core regression and stdio integration tests, and verifies the delivery manifest. Desktop tests are available separately.

**2. Configure the MCP connection**

For Codex with persistent terminal support, the [Skill on-demand mode](skills/wincode/references/diagnostics.md#skill-按需会话) starts WinCode only when needed and reuses one connection throughout the task. Install the Skill, disable the native WinCode MCP entry, and refresh the client connection before using this mode. The Skill starts `dist/Client/SkillSessionCli.js` in an interactive execution session; results remain available as full JSON and image files. It requires an extra file read per result. Other clients can use the native stdio configuration below.

For clients that support `mcpServers`, add the following stdio configuration. Explicitly setting `--workspace` is recommended:

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": ["C:/path/to/WinCode/dist/index.js", "--workspace", "C:/path/to/project"]
    }
  }
}
```

Replace both paths with existing absolute paths. The WinCode installation directory and your project directory may be different. Ensure `node` is available in `PATH`, or use its absolute executable path.

For a graphical configuration interface, use type `stdio`, command `node`, and three separate argument entries: the `dist/index.js` path, `--workspace`, and the project path. Do not add surrounding quotes to individual argument entries, even when a path contains spaces. No additional environment variables are required for the default configuration.

**3. Verify the connection and try a query**

After connecting, ask the agent to call `wincode_hello_world` and confirm that `health.workspaceBinding.root` matches your project. Then try:

> Summarize this project's structure, list the contents of `src`, and locate the code responsible for saving data.

The agent can use `workspace_open` to obtain the project summary, `wincode_list_directory` to browse a directory, and `wincode_search_text` to locate code. For UI inspection, start the target application in your interactive Windows desktop session and use the example above.

Each connection is bound to one workspace for its lifetime. `workspace_open` confirms or recovers that workspace; it does not switch projects. A different root returns `WORKSPACE_MISMATCH`. Use a separately configured connection for another project. If `--workspace` is omitted, the connection binds to the server's launch directory.

See the [Skill and MCP setup guide](WinCode-Skill制作与MCP配置指南.md) for client configuration and the optional agent Skill. After rebuilding, reconnect the client's MCP server to load the updated process and tool schemas.

### Common workflows and tools

**Code navigation:** Start with a known directory, file or symbol. `wincode_search_text` searches within `scopePaths` using plain strings rather than regular expressions; `wincode_file_outline` returns a file's declarations and line count. Both provide follow-up arguments for reading source with `wincode_prepare_context`.

```json
{
  "task": "Review the save logic",
  "lineRanges": [{ "file": "src/Service.cs", "startLine": 50, "endLine": 80 }],
  "maxTokens": 2000
}
```

Use actual paths and line numbers from the search result. `lineRanges` selects known lines; `scopeFiles` limits reading to known files. `candidateFiles` prioritizes files during discovery and is not an exclusive scope. Check returned ranges, `coverage` and truncation before deciding whether more code is needed. `maxTokens` is an estimate based on UTF-16 character count, not a model-specific token count.

**UI inspection:** Select a window, query the relevant control or subtree, and request source candidates when needed. `responseFormat: "compact"` retains control IDs, names, hierarchy and states while omitting per-node geometry and class names. Use `full` when coordinates or additional detail are needed. Unsupported or unknown control states are distinct from `false`.

**C# semantic analysis:** Enable Roslyn explicitly, search for a symbol, and pass its returned `location` unchanged as `symbolLocation` to reference, impact or refactoring tools. Search again when the tool reports a stale location. The default `local-text` provider offers text-based navigation and reports its semantic limitations.

| Tool | Purpose |
| --- | --- |
| `workspace_open` | Confirm or recover the fixed workspace and return a compact project summary. |
| `wincode_list_directory` | Browse a directory with depth, entry-count and output limits. |
| `wincode_analyze_workspace` | Read solution structure and declared project references. |
| `wincode_search_text` | Find literal text within selected files or directories. |
| `wincode_file_outline` | Read a file's local declarations and observed line count. |
| `wincode_prepare_context` | Read selected source excerpts with paths, line ranges and coverage information. |
| `wincode_find_code_symbol` | Search symbols using the configured provider. |
| `wincode_find_references` | Find references and report known totals, returned counts and truncation. |
| `analyze_change_impact` | Assess potential change impact and report uncertainty when evidence is incomplete. |
| `wincode_plan_refactoring` | Suggest checks and verification steps for a proposed refactoring. |
| `wincode_safe_move_to_trash` | Move validated workspace files to `trash/` and record the actual completed or partial outcome. |
| `wincode_ui_list_windows` | List visible top-level windows with process and title filters. |
| `wincode_ui_inspect` | Read controls and optional states or screenshots. |
| `wincode_ui_review` | Inspect UI and return candidate XAML/C# source locations. |
| `wincode_hello_world` | Read instance identity, workspace binding, capabilities and known status. |
| `wincode_diagnose_project` | Actively check SDKs, Git and the local environment. |

`wincode_analyze_change_impact` is an alias of `analyze_change_impact`. Detailed parameters and workflows: [code analysis](skills/wincode/references/code.md), [UI inspection](skills/wincode/references/ui.md), [diagnostics](skills/wincode/references/diagnostics.md). To inspect a tool's schema in the running connection, pass its name as `toolName` to `wincode_hello_world`.

### Optional configuration

- **Roslyn:** Add `--roslyn-config` followed by an absolute configuration-file path. This enables the C# Code Host and requires explicit authorization for MSBuild project evaluation. Configuration, input tracking and recovery are described in the [code guide](skills/wincode/references/code.md).
- **Connection configuration:** Run `node C:/path/to/WinCode/dist/index.js --print-connection --workspace C:/path/to/project` to generate a project's stdio configuration without starting its Gateway or changing client settings. This generates the default local-text configuration; add any Roslyn or Tray options separately.
- **Tray and memory management:** Add `--tray` to the Gateway arguments, reconnect, and manually start `tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe --show`. In **设置 / 内存管理**, select an idle instance and choose **释放 Roslyn 内存**. The next explicit symbol search reloads the project; previous symbol locations become invalid. Automatic idle release is disabled. Exiting Tray leaves MCP running. See the [diagnostics guide](skills/wincode/references/diagnostics.md).
- **Agent Skill:** After updating WinCode, use `npm run skill:check -- <absolute-skill-directory>` to check the installed Skill. `npm run skill:sync -- <absolute-skill-directory>` backs up and synchronizes the Skill documents managed by the sync script. It does not change MCP configuration or restart a connection.

### Scope and limitations

- **Desktop access:** UI inspection is read-only. It does not click controls, type text or read input-field values. Background mode requires both PID and HWND, supports non-minimized windows, and does not activate or restore the target. UI inspection requires an interactive Windows desktop session and does not support headless operation.
- **UIA and visual rendering:** Available properties depend on the application's UIA provider. WPF is covered by the project's desktop tests; other frameworks and custom-rendered controls may expose less information. Colors, icons and rendering quality require visual review. Background screenshots use `PrintWindow` without screen-capture fallback; check the returned capture-quality indicators.
- **Source mapping:** XAML and C# matches identify candidate source locations, with `runtimeSourceVerified: false`. The tool does not verify that the running build matches the source, resolve dynamic bindings or runtime templates, or determine the active `DataContext`.
- **Analysis coverage:** Project structure analysis reads `.sln` and `.csproj` declarations without MSBuild evaluation. Text-based references are heuristic. Review completeness, omissions and diagnostics before drawing conclusions; no matches in a limited scan do not establish absence across the project.
- **Resource limits:** Requests, traversal and response size have explicit limits. Overload returns `SERVER_BUSY`; queue time counts toward the timeout. Output limits do not represent process memory limits. Full concurrency, cache and process-lifecycle details are in the [architecture guide](WinCode-架构与数据流说明.md).
- **Inspection notice:** During inspection, a semi-transparent `REC / WinCoding` status overlay is displayed without taking focus, and minimal local audit metadata is recorded under `%LOCALAPPDATA%/WinCode/logs/ui-audit`. See the [diagnostics guide](skills/wincode/references/diagnostics.md) for audit-log maintenance.

### Development and documentation

Current source version: **0.15.0**. See [CHANGELOG](CHANGELOG.md) for version history and migration notes. Windows 11 x64 is the reference platform; ports to other operating systems require adaptation and separate validation.

```powershell
npm run check            # Builds, core regression, stdio integration and delivery verification
npm run check:desktop    # WPF and UI-to-source tests; requires an interactive Windows desktop
npm run delivery:verify  # Verify Gateway, native components and managed Skill artifacts
npm run test:inventory   # Verify automated-test suite registration
npm run benchmark:agent -- 1  # Run one iteration of the optional scripted benchmark
```

[CI](https://github.com/linnnn89/WinCode/actions/workflows/ci.yml) runs on Windows with Node.js 22 and 24 and the pinned .NET SDK. The Node.js 22 job includes additional native and integration checks; desktop tests run separately. Benchmark reports measure scripted scenarios, including calls, response size and execution time. See the linked records for test conditions and results.

- [Contributing](CONTRIBUTING.md): builds, test suites and delivery requirements.
- [Architecture and data flow](WinCode-架构与数据流说明.md): components, interfaces, resource limits and lifecycle management.
- [Skill and MCP setup](WinCode-Skill制作与MCP配置指南.md): installation and client configuration.
- [Work log](docs/codex_worklog.md) and [remaining test plan](WinCode-下一轮工程化迭代计划书.md): historical verification, known issues and pending validation.

---

## 简体中文

WinCode 是面向 AI 编程智能体的本地模型上下文协议（Model Context Protocol，MCP）服务器，集成 Windows UI Automation（UIA）、代码导航和 .NET 项目分析功能。智能体可以通过同一连接检查正在运行的应用，并查阅相关源码。

### 核心功能

- **后台 UI 检查：**无需激活目标窗口或切换键盘焦点，即可读取运行中应用的控件信息。智能体检查目标窗口时，用户可以继续使用其他应用。
- **支持纯文本大语言模型：**以结构化 JSON 返回控件名称、层级、属性和状态。通过支持 MCP 的智能体客户端，DeepSeek 等以纯文本方式使用的模型也能检查桌面界面，无需输入图像；截图为可选功能。
- **结合源码分析 UI：**检查运行时控件，查找可能对应的 XAML 声明和相关 C# 代码，再读取具体源码。结果包含文件路径、行号和内容哈希，便于核查。
- **实际使用中更快、更准确：**在日常 Windows/.NET 开发中，使用 WinCode 检查 UI 和定位源码，比基于截图的 Computer Use 工作流更快、更准确。通过直接获取结构化的控件属性和源码位置，可以减少对图像识别的依赖和反复交互；配合定向查询与精简响应，还能减少模型需要处理的数据量。
- **项目与代码分析：**查看解决方案和项目中声明的引用关系，搜索文本与符号，按需读取代码，并评估变更影响。默认提供内置文本分析，可选的 Roslyn 集成支持基于编译器语义的 C# 符号与引用分析。

在包含 222 个节点的窗口测试中，仅查询指定控件即可将返回文本量从约 **62 KB 减少至 1.6 KB**。详见 [测试记录](docs/codex_worklog.md)。

### 使用示例：排查“保存”按钮被禁用的问题

> 查找应用窗口，在不切换前台窗口的情况下检查“保存”按钮是否启用，并定位相关 XAML 和 C# 代码。

智能体可以通过纯文本输出完成以下排查流程：

1. 调用 `wincode_ui_list_windows`，通过 `processName` 或 `titleContains` 获取目标进程 ID（`pid`）和窗口句柄（`hwnd`）。
2. 调用 `wincode_ui_review`，指定目标控件和相关源码文件。如果尚不知道文件位置，先使用代码导航工具定位。

```json
{
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

3. 查看返回的控件属性和源码候选位置。例如，`isEnabled: false` 表示控件处于禁用状态。根据返回的 `nextRequest` 参数调用 `wincode_prepare_context`，读取候选声明或赋值语句。
4. 核查源码后再解释界面行为。匹配到绑定或命令名称，可以确定下一步需要检查的代码，但仅凭名称匹配无法确定当前 `DataContext` 或按钮被禁用的原因。

上述 ID 和路径均为示例，使用时应替换为实际窗口和工作区中的值。如果只需读取控件树，可使用 `wincode_ui_inspect`，无需传入源码文件参数。需要勾选、选中或展开/折叠状态时，添加 `readStates: true`；需要结合编号截图检查视觉效果时，使用 `capture: "annotated"`。

### 快速开始

**环境要求：**Windows x64、Git 2.36 及以上、Node.js `>=22`（推荐 24，兼容 22），以及 .NET SDK **10.0.303**。SDK 版本已在 `global.json` 中锁定，并通过 `rollForward: "disable"` 要求使用完全匹配的版本。发布的 UI 辅助程序和可选托盘程序均依赖 .NET 10 Windows Desktop 运行时。开发和测试的基准平台为 Windows 11 x64。

**1. 构建并验证 WinCode**

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run check
npm run delivery:verify
```

运行 `npm run check` 会构建 Gateway 和原生组件，执行核心回归测试与 stdio 集成测试，并验证交付清单。桌面测试单独执行。

**2. 配置 MCP 连接**

支持持久终端的 Codex 可使用 [Skill 按需模式](skills/wincode/references/diagnostics.md#skill-按需会话)：首次需要时才启动 WinCode，任务内复用同一连接。先安装 Skill、禁用原生 WinCode MCP 条目，并刷新客户端连接。Skill 通过交互执行会话启动 `dist/Client/SkillSessionCli.js`，完整结果保存为 JSON 和图片文件，每次结果需要额外读取文件。其他客户端可使用下列原生 stdio 配置。

对于支持 `mcpServers` 的客户端，添加以下 stdio 配置。建议显式设置 `--workspace`：

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": ["C:/path/to/WinCode/dist/index.js", "--workspace", "C:/path/to/project"]
    }
  }
}
```

将两个路径替换为实际存在的绝对路径。WinCode 安装目录与目标项目目录可以不同。确保 `node` 位于 `PATH` 中，或将命令改为其可执行文件的绝对路径。

使用图形化配置界面时，类型选择 `stdio`，命令填写 `node`，依次添加三个独立参数：`dist/index.js` 的路径、`--workspace`、目标项目路径。即使路径包含空格，也不要为独立参数额外添加引号。默认配置不需要额外环境变量。

**3. 验证连接并执行首次查询**

连接后，让智能体调用 `wincode_hello_world`，确认 `health.workspaceBinding.root` 与目标项目一致，然后尝试：

> 概述项目结构，列出 `src` 目录中的内容，并查找负责保存数据的代码。

智能体可以使用 `workspace_open` 获取项目摘要，使用 `wincode_list_directory` 浏览目录，再通过 `wincode_search_text` 定位代码。检查 UI 时，先在交互式 Windows 桌面会话中启动目标应用，再参考前面的使用示例。

每条连接在其生命周期内固定对应一个工作区。`workspace_open` 用于确认或恢复该工作区，不能切换项目；请求其他根目录会返回 `WORKSPACE_MISMATCH`。访问其他项目时，应使用单独配置的连接。如果省略 `--workspace`，连接将固定到服务器的启动目录。

客户端配置和可选的智能体 Skill 安装方式见 [Skill 与 MCP 配置指南](WinCode-Skill制作与MCP配置指南.md)。重新构建后，需要重新连接客户端中的 MCP 服务器，才能加载更新后的进程和工具参数定义。

### 常用工作流与工具

**代码导航：**从已知目录、文件或符号开始。通过 `wincode_search_text` 在 `scopePaths` 指定的范围内按普通字符串搜索，不使用正则表达式；通过 `wincode_file_outline` 查看文件中的声明和行数。两者均提供后续调用 `wincode_prepare_context` 读取源码所需的参数。

```json
{
  "task": "核查保存逻辑",
  "lineRanges": [{ "file": "src/Service.cs", "startLine": 50, "endLine": 80 }],
  "maxTokens": 2000
}
```

使用搜索结果中的实际路径和行号。通过 `lineRanges` 指定要读取的行号范围，通过 `scopeFiles` 将读取范围限制在指定文件内。`candidateFiles` 仅用于优先搜索候选文件，不排除其他文件。根据返回的行号、`coverage` 和截断信息判断是否需要继续读取。`maxTokens` 设置的是按 UTF-16 字符数估算的 Token 预算，并非具体模型的精确 Token 数。

**UI 检查：**选择窗口，查询相关控件或子树，必要时查找源码候选位置。设置 `responseFormat: "compact"` 后，响应中会保留控件 ID、名称、层级和状态，省略各节点的几何信息和类名；需要坐标或更多细节时使用 `full`。结果中会明确区分不支持读取、未知和 `false` 等状态。

**C# 语义分析：**显式启用 Roslyn 后，先搜索符号，再将返回的完整 `location` 作为 `symbolLocation` 传给引用、变更影响或重构工具。工具提示位置已过期时，应重新搜索。默认的 `local-text` 提供基于文本的代码导航，并说明其语义分析限制。

| 工具 | 用途 |
| --- | --- |
| `workspace_open` | 确认或恢复固定工作区，返回精简的项目摘要。 |
| `wincode_list_directory` | 浏览指定目录，支持深度、条目数和输出限制。 |
| `wincode_analyze_workspace` | 读取解决方案结构及声明的项目引用。 |
| `wincode_search_text` | 在指定文件或目录中按普通字符串搜索。 |
| `wincode_file_outline` | 通过本地文本分析提取文件中的声明，并返回实际行数。 |
| `wincode_prepare_context` | 读取指定源码片段，提供路径、行号范围和覆盖情况。 |
| `wincode_find_code_symbol` | 使用已配置的分析后端搜索符号。 |
| `wincode_find_references` | 查找引用，报告已知总数、返回数量和截断情况。 |
| `analyze_change_impact` | 评估潜在变更影响，并在信息不完整时报告不确定性。 |
| `wincode_plan_refactoring` | 为拟议的重构提供检查和验证建议。 |
| `wincode_safe_move_to_trash` | 将通过路径校验的工作区文件移至 `trash/`，记录实际完成或部分完成的结果。 |
| `wincode_ui_list_windows` | 列出可见顶层窗口，支持按进程和标题筛选。 |
| `wincode_ui_inspect` | 读取控件信息，以及可选的状态或截图。 |
| `wincode_ui_review` | 检查 UI 并返回 XAML/C# 源码候选位置。 |
| `wincode_hello_world` | 读取实例身份、工作区绑定、能力及已知状态。 |
| `wincode_diagnose_project` | 主动检查 SDK、Git 和本地环境。 |

`wincode_analyze_change_impact` 是 `analyze_change_impact` 的别名。详细参数与工作流见 [代码分析手册](skills/wincode/references/code.md)、[UI 检查手册](skills/wincode/references/ui.md) 和 [诊断手册](skills/wincode/references/diagnostics.md)。如需查看当前连接中某个工具的参数定义，可将工具名作为 `toolName` 传给 `wincode_hello_world`。

### 可选配置

- **Roslyn：**在启动参数中添加 `--roslyn-config` 及配置文件的绝对路径，以启用 C# Code Host。启用前需要明确授权进行 MSBuild 项目评估。配置方式、输入跟踪与恢复流程见 [代码分析手册](skills/wincode/references/code.md)。
- **连接配置生成：**运行 `node C:/path/to/WinCode/dist/index.js --print-connection --workspace C:/path/to/project`，可生成对应项目的 stdio 配置，不启动 Gateway，也不修改客户端设置。生成结果采用默认的 local-text 配置；Roslyn 或托盘选项需要单独添加。
- **托盘与内存管理：**为 Gateway 添加 `--tray` 参数并重新连接，然后手动运行 `tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe --show`。在“设置 / 内存管理”中选择空闲实例，点击“释放 Roslyn 内存”。下一次显式符号搜索会重新加载项目，旧的符号位置随之失效。自动空闲释放处于禁用状态；退出托盘不会停止 MCP。详见 [诊断手册](skills/wincode/references/diagnostics.md)。
- **智能体 Skill：**更新 WinCode 后，可运行 `npm run skill:check -- <Skill绝对目录>` 检查已安装的 Skill。运行 `npm run skill:sync -- <Skill绝对目录>` 会备份并更新由同步脚本管理的 Skill 文档，不会修改 MCP 配置或重启连接。

### 适用范围与限制

- **桌面访问：**UI 检查为只读操作，不点击控件、不输入文本，也不读取输入框的值。后台模式需同时指定 PID 和 HWND，仅支持未最小化的窗口，检查过程中不激活或还原目标窗口。该功能需要交互式 Windows 桌面会话，不支持在无头环境（Headless）中运行。
- **UIA 与视觉效果：**可读取的属性取决于目标应用的 UIA 提供程序。项目的桌面测试覆盖 WPF，其他框架和自绘控件可能提供较少的信息。颜色、图标和渲染质量需要结合图像检查。后台截图使用 `PrintWindow`，不回退到屏幕截图；应检查返回的截图质量提示。
- **源码映射：**XAML 和 C# 的匹配结果提供了可能相关的源码位置，`runtimeSourceVerified` 为 `false`。工具不验证运行版本与源码是否一致，不解析动态绑定或运行时模板，也不确定当前的 `DataContext`。
- **分析范围：**项目结构分析仅静态读取 `.sln` 和 `.csproj` 中的声明，不进行 MSBuild 项目评估。文本引用搜索采用启发式方法。应结合完整性、省略项和诊断信息判断结果；在有限范围内未找到匹配，并不代表整个项目中不存在匹配内容。
- **资源限制：**请求数量、遍历范围和响应大小均有限制。超过处理容量时返回 `SERVER_BUSY`，排队时间计入超时。输出限制不等于进程内存上限。并发、缓存与进程生命周期的详细说明见 [架构文档](WinCode-架构与数据流说明.md)。
- **检查提示：**检查期间会显示半透明的 `REC / WinCoding` 状态浮层（Overlay），不会获取键盘焦点。同时，将最小必要的审计元数据记录到本地目录 `%LOCALAPPDATA%/WinCode/logs/ui-audit`。审计日志维护方式见 [诊断手册](skills/wincode/references/diagnostics.md)。

### 开发与文档

当前源码版本为 **0.15.0**。版本历史和迁移说明见 [CHANGELOG](CHANGELOG.md)。项目以 Windows 11 x64 为基准平台，移植至其他操作系统需要适配并单独验证。

```powershell
npm run check            # 构建、核心回归、stdio 集成和交付校验
npm run check:desktop    # WPF 与 UI 源码关联测试，需要交互式 Windows 桌面
npm run delivery:verify  # 校验 Gateway、原生组件和交付清单中的 Skill 文件
npm run test:inventory   # 核对自动化测试的套件注册情况
npm run benchmark:agent -- 1  # 执行一轮可选的脚本化基准测试
```

[CI](https://github.com/linnnn89/WinCode/actions/workflows/ci.yml) 在 Windows 环境中使用 Node.js 22、24 和固定版本的 .NET SDK 运行。在 Node.js 22 的任务中，还会额外执行原生组件与集成检查；桌面测试单独运行。基准报告记录脚本化场景中的调用次数、响应大小和执行时间，具体测试条件及结果见以下文档。

- [贡献指南](CONTRIBUTING.md)：构建、测试套件和交付要求。
- [架构与数据流](WinCode-架构与数据流说明.md)：组件、接口、资源限制和生命周期管理。
- [Skill 与 MCP 配置指南](WinCode-Skill制作与MCP配置指南.md)：安装与客户端配置。
- [工作记录](docs/codex_worklog.md) 与 [后续测试计划](WinCode-下一轮工程化迭代计划书.md)：历史验证结果、已知问题和待验证事项。

---

## Acknowledgements / 致谢

WinCode uses or has drawn ideas from these open-source projects:

- **[FlaUI](https://github.com/FlaUI/FlaUI)** — The Windows UI Automation library used by the UI helper.
- **[Serena](https://github.com/oraios/serena)** — A reference for semantic code search and symbol navigation in coding agents.
- **[Repomix](https://github.com/yamadashy/repomix)** — An optional tool for packing repository contents as code context.

WinCode 使用或参考了以下开源项目：

- **FlaUI**：UI 辅助进程使用的 Windows UI Automation 库。
- **Serena**：为代码语义搜索和符号导航提供了设计参考。
- **Repomix**：可选的代码仓库打包工具，用于准备代码上下文。

## License / 许可

[MIT](LICENSE)
