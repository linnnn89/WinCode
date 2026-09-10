# WinCode

<p align="center">
  <strong>Project structure, running windows, and source evidence for coding agents.</strong><br>
  让 Coding Agent 同时掌握 .NET 项目结构、运行中的桌面窗口与 XAML 源码证据。
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#简体中文">简体中文</a><br>
  <img src="https://img.shields.io/badge/Platform-Windows%2011%20x64-0078D6" alt="Windows 11 x64">
  <img src="https://img.shields.io/badge/MCP-stdio-black" alt="MCP stdio">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="MIT license"></a>
</p>

文档导航 / Documentation: [架构与数据流](WinCode-架构与数据流说明.md) · [当前路线图](WinCode-迭代路线图.md) · [待实施计划](WinCode-下一轮工程化迭代计划书.md) · [Skill 与 MCP 配置](WinCode-Skill制作与MCP配置指南.md) · [工作记录](docs/codex_worklog.md)

## English

WinCode is a local MCP server built for Windows and .NET engineering. It bridges project architecture analysis with non-invasive desktop UI inspection, enabling coding agents to debug desktop applications across source declarations, runtime control hierarchies, and annotated screenshots in a unified workflow.

- **Understand the project:** Parse declared `.sln`/`.csproj` references, search code symbols, and prepare code context within a character-based output budget (an estimate, not a model-token limit).
- **Inspect the running app:** Enumerate visible windows, query specific controls or subtrees, and capture numbered visual overlays without activating or stealing focus from the target.
- **Review with evidence:** Trace on-screen widgets back to literal XAML declaration tags, line numbers, and file hashes, with transparent reporting for ambiguity, truncation, or degraded upstreams.

Current source version: **0.14.0**. All UI tools are strictly read-only and non-destructive. See [CHANGELOG](CHANGELOG.md) for full version history.

**Platform and compatibility:** Windows 11 x64 is the baseline for this project's local development and testing. Identical functionality, behavior, and performance are not guaranteed on other operating systems, other Windows versions, or different dependency versions. macOS and Linux users are encouraged to **fork this repository and adapt and validate it locally** for their platform. Use the dependency versions documented and pinned in this repository as the reference environment.

### Quick start

**Requirements:** Git, Windows x64 and Node.js `>=22` (24 primary, 22 compatible). Building requires .NET SDK 10.0.303, pinned without roll-forward in `global.json`; the published UI helper needs the .NET 10 Windows Desktop runtime. See [CONTRIBUTING](CONTRIBUTING.md) for locked builds and delivery verification.

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run check

# Verify the complete Gateway / Release Host / Skill delivery
npm run delivery:verify
```

Add WinCode as a stdio MCP server in your agent client configuration (for clients that support `mcpServers`). Choose either startup mode below.

**Choose a project when needed:** If the target project is not yet known, or you want to query different projects in sequence, configure only the server entry point:

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": ["C:/path/to/WinCode/dist/index.js"]
    }
  }
}
```

Without `--workspace`, WinCode initially uses the server process's current working directory, which may differ from your intended project. Before querying, ask the agent to call `workspace_open` with the target project's absolute path, for example `workspace_open({"path":"C:/path/to/project"})`. Repeat this when switching projects; the server installation path stays the same. Confirming the same healthy workspace keeps the Roslyn Host/snapshot warm and does not drain active queries. Cancelling that confirmation does not force recovery; known restart/cleanup failures still follow the explicit recovery path. One server process has one active workspace, so calls sharing that process must not interleave queries for different projects. For concurrent independent projects, configure separate server instances with distinct names and explicit workspace paths.

**Specify a project at startup:** Add `--workspace` followed by the project directory:

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

> **Path note:** All paths above are illustrative placeholders. Replace them with your actual absolute installation and project paths. The server entry point and the project directory serve different purposes and need not be in the same directory.

For graphical configuration interfaces:

| Field | Choose a project when needed | Specify a project at startup |
| --- | --- | --- |
| Name / Type | `wincode` / `stdio` | `wincode` / `stdio` |
| Command | `node` | `node` |
| Argument 1 | `C:/path/to/WinCode/dist/index.js` | `C:/path/to/WinCode/dist/index.js` |
| Argument 2 | Omit | `--workspace` |
| Argument 3 | Omit | `C:/path/to/project` |

Add each argument as a separate entry, without extra surrounding quotes even when a path contains spaces. To defer project selection, remove both `--workspace` and its value; do not leave an empty value. Ensure `node` is available in PATH, or specify its absolute executable path. No additional environment variables are required for this basic configuration.

For prompt engineering and token-efficient skill routing, refer to the optional [Skill and MCP setup guide](WinCode-Skill制作与MCP配置指南.md).

### Optional tray and manual memory release

Automatic Roslyn release is **off**. This version provides no idle timer or automatic-release switch. A loaded semantic workspace stays warm for successive Agent calls. To release it when you decide it is no longer needed:

1. Build with `npm run check`, then run `tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe --show` from the repository. It requires the .NET 10 Windows Desktop runtime and does not install itself or enable Windows startup.
2. Add `--tray` as a separate argument to each Gateway you want to see, then refresh that MCP connection. For example: `"args": ["C:/path/to/WinCode/dist/index.js", "--workspace", "C:/path/to/project", "--tray"]`. Keep your existing explicit `--roslyn-config` arguments if using Roslyn.
3. Open **设置 / 内存管理**, refresh the observed state, select an idle instance and click **释放 Roslyn 内存**. A busy instance refuses the action; it does not queue a release for later. Requests arriving after a release has started wait for it to finish.

“暂无在途请求” means no request is currently in flight, not that the Agent has finished its task. Failed refreshes or observations older than 30 seconds are shown as unknown; manual release first obtains a new passive status. Opening, refreshing, hiding, or reconnecting Tray never releases or reloads Roslyn. Registration errors are reported in settings and Gateway diagnostics.

Release closes only that instance's owned Roslyn Host and invalidates its symbol locations. The next explicit symbol search reloads the project; old `symbolLocation` values require a new search. Gateway, workspace watcher, bounded cache, and last diagnostics remain. Local-text instances have no Roslyn memory to release.

Tray and Gateway are independent. Hiding settings or exiting Tray leaves MCP running; **停止此实例** requests that selected Gateway's normal shutdown after confirmation. Start Tray manually when needed; it can connect before or after an opted-in Gateway. The current limit is eight connected Gateways per Windows user/session. Use the same Windows user and privilege level. State is observed on registration/open/refresh, not continuously polled; disconnected means unknown, and the connection count does not include old or unregistered instances. Remove `--tray` and reconnect to disable integration. Windows 11 is the tested platform; alternate permissions, Explorer recovery and other DPI configurations need separate validation.

### Practical walkthrough: Targeted control inspection

Query specific controls directly rather than dumping an entire window's visual tree (which can easily span thousands of nodes and exhaust context limits):

> **Prompt:** *"Find my application's window, inspect its Save button in the background, and verify its declaration in `Views/MainWindow.xaml`."*

1. Call `wincode_ui_list_windows` with a process name or title substring filter to obtain the target `pid` and `hwnd`.
2. Inspect the targeted control using `wincode_ui_inspect`:

```json
{
  "pid": 12345,
  "hwnd": "0x123456",
  "backgroundOnly": true,
  "capture": "none",
  "query": {"automationId": "SaveButton", "controlType": "Button"},
  "maxDepth": 3,
  "maxNodes": 30,
  "readStates": true
}
```

3. Enable `capture: "annotated"` when visual layout verification is needed. To correlate the widget with source code, switch to `wincode_ui_review` and supply `candidateFiles: ["Views/MainWindow.xaml"]`.

Optionally add `candidateCodeFiles: ["ViewModels/MainWindowViewModel.cs"]` (1–8 explicit relative C# files). `codeEvidence` follows literal Click/simple Binding identifiers to declaration/assignment candidates and provides scoped `nextRequest` arguments for `wincode_prepare_context`. Reads are bounded to 256 KiB per file/1 MiB total, with at most 40 clues, 200 matches and 16000 JSON characters before the shared response budget. Missing or ambiguous matches remain explicit; runtime build identity, DataContext, templates and a disabled control's cause are not established. Omit this option for the existing XAML-only path.

**Key Behaviors:**
- **Zero Image Overhead:** `capture: "none"` returns clean structural JSON without wasting vision tokens. When screenshots are captured, images travel as independent MCP `image` blocks—never Base64-inlined into text.
- **Accurate State Semantics:** `readStates` checks toggle, selection, and expand/collapse patterns without executing actions. If a control lacks support for a given pattern, it is explicitly reported as unsupported rather than returning `false`, preventing misleading negative states (e.g., mistaking an unsupported toggle for an unchecked checkbox).
- **Background Integrity:** `backgroundOnly: true` uses dedicated `PrintWindow` capture without window activation, restoration, or focus-stealing, preventing foreground windows or games from contaminating the capture.

### Tool reference

Local declaration search supports C#/TS/TSX/JS/JSX/Python with bounded comment/literal/JSX masking; uncertain lexical boundaries are reported as incomplete. Text references remain heuristic. Impact analysis returns one JSON text block, including formattedReport once. Known tool errors expose matching JSON text and structuredContent; unknown tools use JSON-RPC -32602 during normal admission.

The default provider is `local-text`, with an explicit semantic-unconfigured status. Configure direct Roslyn to obtain compiler-backed identities. Pass a returned `location` unchanged as `symbolLocation` to references, impact, or refactoring, and use the returned plain symbol name. Old Serena namePath identities and external startup settings are retired; stale snapshots require a new explicit search.

`wincode_hello_world` reports a frozen running instance ID and build fingerprint, plus a hash of the tool definitions actually registered by that instance. Pass `toolName: "wincode_prepare_context"` to inspect just that tool's input schema. Compare it with `tools/list` on the same connection. `npm run build` emits a manifest; direct `tsc`, missing/mismatched artifacts or source development mode can report `unknown`. The build fingerprint checks local output consistency, not release authenticity. Workspace changes do not change the running build.

Explicit `lineRanges` return `coverage` computed from the final serialized evidence: requested/complete line counts, actual returned intervals, missing intervals and reasons. A partial last line (`endLineComplete: false`) is not a covered line. Recoverable gaps can include a bounded `nextRequest`; EOF/missing files do not suggest blind retries. Detail pruning reports `omittedItemCount` while retaining totals. `bodyStatusScope` identifies `displayed-snippet` or `packed-file`; a complete snippet does not mean a complete method. Symbol windows report `symbolCoverage: "unknown"` and, when more file lines exist, a `nextRequest` for up to 80 following lines. A partial tail is reread; observed EOF stops continuation. This is optional follow-up evidence, not a parsed method boundary. Other requests return `coverage: null`; `taskCoverage` is always null because source excerpts do not prove whole-method or task sufficiency. `npm run test:tavern-context -- <TavernDesk repository>` runs an opt-in read-only source acceptance in a new stdio process.

After rebuilding, reconnect the client's MCP server and check hello again; rebuilding files alone cannot update an existing process or the client's cached schema. `npm run test:e2e` verifies one new stdio process with compiled handlers and an isolated source fixture, including actual symbol/range bodies. It does not verify a separate Codex connection or GUI/upstream adapters.

After updating the repository, check the installed skill with `npm run skill:check -- <absolute-wincode-skill-directory>`; a mismatch exits with code 2. Use `npm run skill:sync -- <same-directory>` to back up and synchronize the four managed documents, preserving additional files. This does not change MCP configuration or restart a connection.

The 2026-09-08 check of the current Codex connection against TavernDesk source passed: workspace opening returned 3,705 UTF-16 characters, the requested method was located, and a 223-line request matched the source completely. A 512-token estimate budget reported only 9 complete lines and an incomplete tenth line. This is a dated acceptance result for that instance; verify other connections separately. Details are in the [work log](docs/codex_worklog.md).

| Tool | Purpose |
| --- | --- |
| `workspace_open` | Open or switch workspace, isolate caches and return a bounded project summary. |
| `wincode_list_directory` | Browse a specific workspace directory with entry, depth and output limits. |
| `wincode_analyze_workspace` | Parse solution structure and declared `.sln`/`.csproj` project references. |
| `wincode_prepare_context` | Prepare scoped code evidence and actual line ranges within a character-based output budget. |
| `wincode_find_code_symbol` | Search codebase symbols with transparent source and completeness metadata. |
| `wincode_find_references` | Trace exact identities and report ambiguity, incomplete queries and degraded evidence. |
| `analyze_change_impact` | Assess refactor blast radius; explicitly mark confidence as `UNKNOWN` if ambiguous. |
| `wincode_plan_refactoring` | Generate impact-driven verification checklists prior to making code edits. |
| `wincode_safe_move_to_trash` | Safely quarantine obsolete files to `trash/` with metadata; rejects path traversal. |
| `wincode_ui_list_windows` | Enumerate visible top-level windows with title/process filters and count limits. |
| `wincode_ui_inspect` | Inspect UI control subtrees, interactive states, and optional numbered screenshots. |
| `wincode_ui_review` | Return explicit XAML/C# source candidates, lines, hashes and scoped next requests from one UI snapshot. |
| `wincode_hello_world` | Read instance identity and known adapter state without spawning probes; use diagnose_project for active checks. |
| `wincode_diagnose_project` | Check local SDKs, Git, and Windows environment health non-invasively. |

`wincode_analyze_change_impact` is an alias of `analyze_change_impact`. Detailed workflows: [code intelligence](skills/wincode/references/code.md), [UI inspection](skills/wincode/references/ui.md), [diagnostics](skills/wincode/references/diagnostics.md).

### Architecture and resource control

See the [architecture, data-flow and verification-gate guide](WinCode-架构与数据流说明.md) for the current component boundaries, request sequences, storage lifecycle and delivery checks (Chinese).

```text
Coding agent ── stdio MCP ── WinCode
                              ├─ Code adapters: Direct Roslyn / Repomix / Local text
                              ├─ Workspace analysis, context, and impact tools
                              └─ FlaUiAdapter ── stdin/stdout JSON ── .NET UIA helper
                                                                       └─ Window tree + screenshot
```

- **Owned-process cleanup:** UI inspection executes out-of-process via an isolated helper (`tools/WinCode.UIA.Host`). All process cleanups target only the owned helper process tree via Windows `taskkill /T`; the inspected target application is never terminated or injected.
- **Concurrency Protection:** UI inspection and health checks share a serial execution mutex to prevent native UIA message pump deadlocks. Workspace switches safely drain in-flight calls before changing cache namespaces.
- **Byte-Bounded Cache:** The shared cache manager bounds retained serialized data (default 32 MiB memory, 128 MiB disk including overflow); these are not process RSS limits. Local-text queries re-enumerate bounded inputs and reuse declarations by content hash. Builtin packs validate the actual selected contents before reuse; CLI output without a verified input manifest is not cached. Missing overflow files become cache misses. Watch/index probes invalidate the ~2.5s change-hint memo; that hint is not proof of source identity or a guarantee that watcher events are complete.

| UI budget | Limit / behavior |
| --- | --- |
| Targeted query | Scans up to 1,000 nodes by default (max 5,000); returns up to 10 candidates (max 20). |
| Traversal bounds | Soft limits of 2 seconds and 50 levels; blocking native Win32 calls are terminated by the helper process timeout. |
| Tree text | Capped at 128 KiB with explicit truncation reasons. |
| PNG image | 2 MiB ceiling; dynamically downscaled or safely omitted if still oversized. |
| Transport pipe | Capped at 6 MiB raw stream bytes. |
| Screenshot allocation | Hard check: at most 16,777,216 total pixels and 16,384 pixels per dimension before bitmap allocation. |

`helperPeakWorkingSetBytes` reports peak operating system working set through response preparation. `treeComplete` reflects structural coverage, while `propertyIssues` tracks clipped or unavailable properties.

### Boundaries and visibility

- **Background capture:** `backgroundOnly: true` requires both PID and HWND. It uses `PrintWindow` without focus shifts or screen fallbacks. Minimized windows are rejected. `captureQuality` samples up to 1024 raw pixels before annotation: `suspect-low-variation` means the sampled RGB channel ranges are at most 3 and may reflect either blank output or a legitimate uniform/low-contrast view. `unknown` never certifies visual usability. Hints retain both image and UIA evidence and do not change the capture policy. Older helpers without this field leave quality unverified.
- **UI coverage:** Inspection depends on the application's underlying UIA provider. Verified against WPF; WinUI, WinForms, and custom-rendered controls may expose differing levels of UIA detail.
- **Source evidence:** Matches literal attribute declarations in supplied `.xaml` files (`runtimeSourceVerified: false`). Dynamic bindings, runtime templates, and resource dictionaries are not evaluated.
- **Project analysis:** Extracted directly from project file XML without invoking MSBuild evaluations. Direct Roslyn requires explicit project-evaluation authorization; Repomix is optional. Local text results explicitly label reduced semantic coverage.
- **Visual indicator:** A non-activating, semi-transparent `REC / WinCoding` overlay is painted in the top-right corner of the primary display during UI inspection to ensure complete visibility.
- **Local audit:** Lightweight start/end records are flushed to `%LOCALAPPDATA%/WinCode/logs/ui-audit` (1 MiB triggers cleanup reminders; 2 MiB blocks new access with reserved end-record space). The [audit checker script](scripts/check-ui-audit.ps1) enables manual inspections.

### Opening and browsing a workspace

`workspace_open({"path":"~/target-project"})` returns a compact summary with at most 8 entry paths and no directory tree by default. `maxOutputChars` defaults to 8000 (2048–32768) and budgets the entire JSON text, including metadata and escaping; it is not a model-token count. Replace the placeholder with an absolute path. Discovery is bounded: check `projectScanComplete` and the reported gaps; unmeasured file/size totals are `null`.

Use `wincode_list_directory({"path":"src","maxDepth":1,"maxEntries":100})` to browse only the next useful directory. It reports actual visited/returned counts, omissions and truncation. `includeIgnored:true` explicitly exposes generated directories within the workspace; outside-workspace links remain rejected. Narrow the path after truncation. Existing callers needing a tree can request `workspace_open({"path":"~/target-project","includeTree":true})`, which returns a bounded compatibility tree, not the former unrestricted inventory.

### Code context and retrieval routing

Use `wincode_prepare_context` with the location information already available:

```json
{"task":"Review the save logic","lineRanges":[{"file":"src/Service.cs","startLine":50,"endLine":80}],"maxTokens":2000}
```

Known lines: use `lineRanges`. For a declaration and nearby context, use `scopeFiles` plus `symbol`; this returns a 24-line window before budget clipping. When reviewing a known method's error handling, cancellation or cleanup, prefer an existing file reader with bounded `rg` context when available, so the required branches can be read together. A small known file can also be requested with `scopeFiles` and `includeFullText:true`, subject to the output budget. Known files only: use `scopeFiles` for a preview. Use `candidateFiles` when discovery beyond those candidates is intended; it remains a priority list, not an exclusive scope. Scoped symbol matching currently uses local C#/TS/JS/Python declaration patterns and reports incomplete semantic coverage; ambiguous or missing targets remain explicit issues.

The default `compact` response contains one JSON text block; `responseFormat: "legacy"` returns JSON plus Markdown. `maxTokens` accepts 512–65536 and budgets all returned text as UTF-16 characters divided by four, including metadata. Actual model tokens differ. Check actual ranges, `queryComplete`, truncation and `bodyStatus` before treating evidence as sufficient. Once the required evidence is available, continue analysis; refresh after edits or workspace changes. WinCode does not guarantee cross-request evidence freshness or provide the benchmark's reuse policy as a production cache. Parameter combinations and limits are in the [code manual](skills/wincode/references/code.md).

### Development and validation

The [CI workflow](.github/workflows/ci.yml) runs `npm run check` on pull requests and main pushes using Windows, Node.js 22/24 and .NET SDK 10.0.303. It performs locked builds, core regression, production stdio and delivery verification, and uploads bounded reports even on failure. Node 22 also runs error/recovery contracts and real Roslyn Host/MCP acceptance on generated projects. Interactive desktop/UI acceptance remains separate. Check the actual run result. Main protection was verified on 2026-09-08 with required Node 22/24 and three CodeQL checks; approvals are zero under the single-maintainer policy. See [CONTRIBUTING](CONTRIBUTING.md) for enforcement and evidence boundaries.

```powershell
npm ci
npm run check            # Locked builds, core regression, stdio and delivery manifest
npm run check:desktop    # Isolated WPF, UI and UI-to-source; interactive Windows required
npm run delivery:verify  # Detect changed/missing Gateway, Host sidecars or managed Skill
npm run test:inventory   # Ensure every *.test.ts belongs to a declared suite
npm run test:all          # Both check and check:desktop
npm run benchmark:agent -- 1  # Opt-in pilot; -- 3 for three repetitions
```

Live UI suites require an interactive Windows desktop session. In a 222-node test fixture, targeted queries reduced response text from 62 KB to ~1.6 KB while completing in ~0.78 seconds. Detailed test records are maintained in the [work log](docs/codex_worklog.md).

`npm run test:product -- <TavernDesk repository> <dedicated-test PID> <HWND>` explicitly runs six navigation-to-source tasks against an already running fixed test profile. It discovers source files, checks the live control and verifies literal command/method candidates, recording native and MCP calls, response characters and repeated source lines under `test-tmp/product-tasks`. It neither launches the application nor changes its data or source. This scripted acceptance does not establish runtime bindings, full-method coverage, native-only speedup or semantic completeness; see the acceptance matrix in the work log.

The agent benchmark covers ten scripted scenarios, including existing `dotnet-mini` C# fixtures and four levels of initial location knowledge. It validates returned files, ranges, bodies and status against current fixture contents. Tool/transport/response/cleanup failures remain in the JSON report under `test-tmp/agent-efficiency`; failed cases produce a nonzero exit code. Unchanged-evidence reuse is tested only under trusted, controlled fixture writes; edits require a new request. Reports measure MCP calls, output characters, repeated displayed lines and call time using local fallback with upstreams and GUI disabled. They do not establish real-agent completion rates, model-token savings or production cache benefits. Schema v2 results should not be compared directly with the earlier six-scenario report.

---

## 简体中文

WinCode 是面向 Windows 与 .NET 工程研发的本地 MCP 服务。它将项目依赖拓扑分析与非侵入式桌面 UI 取证深度整合，让 Coding Agent 能够在同一套工作流中，结合源码声明、运行时控件层级与标注截图协同排查问题。

- **理解项目架构：**解析 `.sln`/`.csproj` 声明的项目引用拓扑，跨文件检索符号，并在基于字符数估算的输出预算内准备任务上下文；该预算不是真实模型 Token 硬上限。
- **观察实际界面：**发现系统可见窗口，按条件定向查询目标控件或子树，并在不激活、不抢占前台焦点的前提下获取数字标注截图。
- **源码双向印证：**将运行时抓取的控件关联回 XAML 源码声明的起始行号、代码片段与文件哈希，清晰报告歧义、截断与降级状态。

当前源码版本为 **0.14.0**。所有 UI 取证工具均为纯只读与非侵入设计。版本历史见 [CHANGELOG](CHANGELOG.md)。

**平台与兼容性说明：**本项目以 **Windows 11 x64** 为本地开发与测试基准。其他操作系统、其他 Windows 版本或不同依赖版本下，功能表现、运行行为与性能不保证完全一致。建议 **macOS、Linux 用户通过 fork 本仓库进行本地适配与验证**；请以本项目文档和锁定文件中列出的依赖版本作为参考环境。

### 快速上手

**环境要求：**Git、Windows x64、Node.js `>=22`（24 主支持、22 兼容）。构建使用 `global.json` 精确锁定且不自动滚动的 .NET SDK 10.0.303；已发布 UI Helper 依赖 .NET 10 Windows Desktop 运行时。锁定构建和交付校验见 [CONTRIBUTING](CONTRIBUTING.md)。

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run check

# 核对 Gateway / Release Host / Skill 完整交付物
npm run delivery:verify
```

在 Agent 客户端配置文件中添加 stdio MCP 服务（以支持 `mcpServers` 的客户端为例），可按需要选择以下两种启动方式。

**使用时再选择项目：**如果暂时不确定目标项目，或需要依次查询多个项目，只配置服务入口：

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": ["C:/path/to/WinCode/dist/index.js"]
    }
  }
}
```

省略 `--workspace` 时，WinCode 初始使用服务进程的当前工作目录，它不一定是你要分析的项目。查询前，让 Agent 调用 `workspace_open` 并传入目标项目的绝对路径，例如 `workspace_open({"path":"C:/path/to/project"})`。换项目时再次调用即可，服务安装路径无需修改。同一健康工作区的重复确认保留 Roslyn Host/快照，不等待在途业务排空；取消该确认不会强制进入恢复。已知重启要求和清理失败仍走显式恢复路径。一个服务进程只有一个活动工作区，共享该进程的调用不能交错查询不同项目；如需同时独立查询多个项目，应配置名称不同、各自明确指定工作区路径的服务实例。

**启动时指定项目：**添加 `--workspace`，并在其后填写项目目录：

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

> **路径说明：**以上路径均为通用占位示例，请替换为实际的安装目录和项目目录绝对路径。服务入口与待分析项目目录用途不同，不必位于同一个目录。

若通过图形界面添加：

| 配置字段 | 使用时再选择项目 | 启动时指定项目 |
| --- | --- | --- |
| 服务名称 / 类型 | `wincode` / `stdio` | `wincode` / `stdio` |
| 启动命令 | `node` | `node` |
| 参数 1 | `C:/path/to/WinCode/dist/index.js` | `C:/path/to/WinCode/dist/index.js` |
| 参数 2 | 不添加 | `--workspace` |
| 参数 3 | 不添加 | `C:/path/to/project` |

每个参数独立添加为一行，路径包含空格时也无需额外加引号。使用时再选择项目，应同时删除 `--workspace` 及其值，不要保留空值。确保系统环境变量 PATH 中包含 `node`，或直接填写 node.exe 的绝对路径。这一基础配置无需额外设置环境变量。

如需配合 Agent Skill 获得低 Token 开销的精准任务路由，请参阅可选的 [Skill 与 MCP 配置指南](WinCode-Skill制作与MCP配置指南.md)。

### 可选托盘与手动释放内存

**自动释放保持关闭**，本版没有 idle 定时器或自动释放开关。Roslyn 加载后会保留，优先保障 Agent 连续工作；确实不再需要时，由你在设置里主动释放。

1. 完成 `npm run check` 后，运行仓库内 `tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe --show`。使用已有 .NET 10 Windows Desktop 运行时，不安装服务，不设置 Windows 自启动。
2. 给需要管理的 MCP 启动参数单独加上 `--tray`，再刷新该 MCP 连接。例如 `"args": ["C:/path/to/WinCode/dist/index.js", "--workspace", "C:/path/to/project", "--tray"]`。已配置 Roslyn 时保留原有 `--roslyn-config` 参数。
3. 打开“设置 / 内存管理”，刷新状态、选择空闲实例，点击“释放 Roslyn 内存”。实例忙碌或仍在收尾时拒绝本次释放，不排队延后释放；释放开始后到来的请求等待其完成。

只关闭所选实例拥有的 Roslyn Host 并失效旧符号定位；下一次显式搜索才重新加载，旧 `symbolLocation` 必须重新搜索。Gateway、工作区 watcher、现有受限缓存和最后诊断保留。local-text 实例没有 Roslyn 内存可释放。

“暂无在途请求”不代表 Agent 已结束任务。刷新失败或观察超过 30 秒时显示状态未知；手动释放前先获取新状态，超时不会接着释放。打开、刷新、隐藏设置及托盘重连均不触发 Roslyn 启停。注册失败原因会显示在设置和 Gateway 诊断输出中。

关闭设置窗口会收回托盘；“退出托盘”不影响 MCP。“停止此实例”经确认后请求该 Gateway 正常退出，客户端可能重新建立一个新实例。托盘和 Gateway 可按任意顺序手动启动；每个 Windows 用户/登录会话目前最多连接八个 Gateway，应使用同一用户和权限级别。状态仅在注册、打开或手动刷新时更新，不持续轮询；失联表示未知，连接数不含旧版或未注册实例。移除 `--tray` 并刷新 MCP 连接即可禁用集成。其他权限、Explorer 重启和不同 DPI 仍需单独验证。

### 实战示例：精准定位并分析目标控件

大型桌面应用的完整控件树动辄包含成百上千个视觉节点。若直接全量导出，不仅耗尽 Agent 上下文，还会增加定位干扰。WinCode 支持按条件精准定位目标控件子树：

> **提示词示例：** *“找到我的应用窗口，在后台查看保存按钮的状态，并核对 `Views/MainWindow.xaml` 中的源码声明。”*

1. 调用 `wincode_ui_list_windows`，通过进程名或标题关键字筛选获得目标 `pid` 与 `hwnd`。
2. 使用 `wincode_ui_inspect` 进行定向检索：

```json
{
  "pid": 12345,
  "hwnd": "0x123456",
  "backgroundOnly": true,
  "capture": "none",
  "query": {"automationId": "SaveButton", "controlType": "Button"},
  "maxDepth": 3,
  "maxNodes": 30,
  "readStates": true
}
```

3. 若需要视觉排查，启用 `capture: "annotated"` 获取带编号的高对比度标注截图；若需关联源码，改用 `wincode_ui_review` 并传入 `candidateFiles: ["Views/MainWindow.xaml"]`。

可增加 `candidateCodeFiles: ["ViewModels/MainWindowViewModel.cs"]`（1–8 个显式相对 C# 路径）。`codeEvidence` 从 Click/简单 Binding 的字面标识符提供声明、赋值候选及可用于 `wincode_prepare_context` 的限定 `nextRequest`。读取限单文件 256 KiB、总计 1 MiB，最多 40 条线索、200 个匹配，代码元数据最多 16000 JSON 字符并受整体响应预算限制。歧义、未找到和未完成扫描保留；运行时构建身份、DataContext、模板和禁用原因仍未证明。不传此参数时保持原有 XAML 路径。

**关键机制说明：**
- **零图片 Token 开销：**若仅需排查结构与属性，使用 `capture: "none"` 仅返回纯净的结构化 JSON；需要截图时，图片走独立 MCP `image` 内容块传输，绝不将庞大的 Base64 塞入文本段。
- **准确的状态语义：**`readStates: true` 会安全读取控件的勾选、选中与展开折叠状态。若控件本身未实现某种模式，接口明确标记为不支持，绝不误报为 `false`，杜绝大模型产生误判。
- **纯后台无感取证：**`backgroundOnly: true` 仅使用定向 `PrintWindow` 捕获，不抢前台焦点、不还原窗口，有效防止用户当前操作或全屏游戏污染截图画面。

### 工具一览

本地声明扫描支持 C#/TS/TSX/JS/JSX/Python，有界屏蔽注释、字符串及 JSX；词法边界不确定时报告不完整。引用仍为文本线索。影响分析仅返回一个 JSON 文本块（含一份 formattedReport）；已知工具失败的 JSON 文本与 structuredContent 一致，正常受理的未知工具走 JSON-RPC -32602。

默认以 `local-text` 启动，并明确报告语义能力未配置。显式配置直接 Roslyn 后，将搜索返回的完整 `location` 作为 `symbolLocation` 传给引用、影响分析或重构工具，名称使用原结果的简单名称。外部 Serena 启动配置及 namePath 身份已退役；过期快照须重新显式搜索。

`wincode_hello_world` 返回启动时固定的实例 ID、构建指纹及当前注册工具定义的 hash。传 `toolName: "wincode_prepare_context"` 可按需查看单个工具参数，与同一连接的 `tools/list` 对照。`npm run build` 生成 manifest；直接运行 `tsc`、产物缺失/失配或源码开发模式会明确报告 `unknown`。构建指纹校验本地产物一致性，不证明发布来源可信；切换分析工作区不会改变运行构建。

显式 `lineRanges` 的 `coverage` 按最终返回正文计算：请求/完整行数、实际返回区间、未返回区间及原因。尾行只有一部分字符（`endLineComplete:false`）不计完整覆盖；可补取缺口可带有界 `nextRequest`，EOF/缺文件不建议盲重试。明细超预算会记录 `omittedItemCount` 并保留总计。其他请求 `coverage:null`，`taskCoverage` 始终为 null，片段非空不证明整个方法或任务证据充足。`npm run test:tavern-context -- <TavernDesk仓库>` 在新 stdio 进程执行显式启动的只读源码验收。

重新构建后需在客户端重连 MCP，再核对 hello；仅替换磁盘文件不能更新旧进程或客户端缓存的参数定义。`npm run test:e2e` 用新 stdio 进程、生产编译产物和隔离源码夹具验证同会话契约及目标符号/行范围正文，不代表另一个 Codex 连接、GUI 或真实上游已经验收。

更新仓库后，用 `npm run skill:check -- <已安装wincode目录绝对路径>` 核对手册；不一致退出码为 2。明确更新时运行 `npm run skill:sync -- <同一路径>`，先备份再同步四份受管文档，保留其他文件。它不修改 MCP 配置，也不重启连接。

2026-09-08 已在当前 Codex 连接上完成 TavernDesk 源码验收：打开工作区返回 3,705 个 UTF-16 字符，目标方法成功定位，223 行请求与真实源码完整一致；512 token 估计预算明确报告仅 9 行完整、第 10 行不完整。这是该实例在当日的验收结果，其他连接仍需单独核对，详见[工作日志](docs/codex_worklog.md)。

| 工具名称 | 功能描述 |
| --- | --- |
| `workspace_open` | 打开或切换工作区、隔离缓存，并返回有界项目摘要。 |
| `wincode_list_directory` | 按指定目录浏览，限制条目、深度与整份输出。 |
| `wincode_analyze_workspace` | 解析工程依赖拓扑，提取 `.sln`/`.csproj` 项目引用关系。 |
| `wincode_prepare_context` | 在基于字符数估算的输出预算内，按文件、符号或行号范围提供代码证据。 |
| `wincode_find_code_symbol` | 检索代码符号，透明附带数据源置信度与完整性标识。 |
| `wincode_find_references` | 按完整身份查引用，明确报告歧义、查询缺口及降级证据。 |
| `analyze_change_impact` | 评估代码改动爆炸半径与重构风险；若存在歧义或查询受限，置信度如实返回 `UNKNOWN`。 |
| `wincode_plan_refactoring` | 基于影响面分析生成改动前置检查清单与验证步骤。 |
| `wincode_safe_move_to_trash` | 安全回收站：校验相对路径后将文件移入 `trash/` 归档并记录元数据，杜绝物理硬删除。 |
| `wincode_ui_list_windows` | 列出系统可见顶层窗口，支持按标题/进程名筛选与数量硬截断。 |
| `wincode_ui_inspect` | 定向抓取控件子树、交互状态与可选的高对比度数字标注截图。 |
| `wincode_ui_review` | 从一次 UI 快照提供显式 XAML/C# 源码候选、行号、哈希和下一步限定读取请求。 |
| `wincode_hello_world` | 被动读取版本、能力及已知状态，不启动探测；主动检查使用 diagnose_project。 |
| `wincode_diagnose_project` | 无侵入检查本地 .NET SDK、Git 与运行环境健康度。 |

`wincode_analyze_change_impact` 是 `analyze_change_impact` 的别名。详细参数与工作流请参考对应手册：[代码分析](skills/wincode/references/code.md)、[UI 取证](skills/wincode/references/ui.md)、[系统诊断](skills/wincode/references/diagnostics.md)。

### 架构设计与资源管控

```text
Coding Agent ── stdio MCP ── WinCode
                               ├─ 代码适配器：直接 Roslyn / Repomix / 本地文本
                               ├─ 工作区分析、上下文提取与影响面分析工具
                               └─ FlaUiAdapter ── stdin/stdout JSON ── .NET UIA Helper
                                                                        └─ 控件树遍历 + 截图渲染
```

- **目标进程绝对免疫：**UI 取证由独立的 C# 辅助进程（`tools/WinCode.UIA.Host`）在进程外执行。所有清理操作严格仅终止自身派生的 Helper 辅助进程树（通过 Windows `taskkill /T`），**被测目标应用进程受绝对免疫保护，绝不被终止或注入**。
- **防死锁与并发保护：**UI 自动化访问与健康检查共用串行互斥锁，杜绝底层 Win32/UIA 消息泵死锁。切换工作区前会先等待排空在途请求，超时则拒绝切换，保证会话隔离安全。
- **按字节约束缓存：**缓存条目按工作区 namespace 隔离，多个实例仍可能共用磁盘目录；默认序列化内存预算 32 MiB、磁盘配额 128 MiB（含 overflow），不等于进程 RSS 上限。local-text 每次有界扫描实际输入，按内容哈希复用声明解析；内置打包核对实际选中文件的内容后复用，没有可核验输入清单的 CLI 结果不缓存。附件缺失按缓存未命中重建。150 ms 去抖监听与索引探测只使约 2.5 秒的变更提示 memo 失效，不能证明源码完整身份或保证监听事件无遗漏。

| 取证预算指标 | 限制值与行为策略 |
| --- | --- |
| 定向搜索范围 | 默认最多扫描 1,000 个节点（上限 5,000）；候选匹配默认最多 10 个（上限 20）。 |
| 遍历层级约束 | 软限制 2 秒、50 层深度；若底层 Win32 调用发生阻塞，由 Helper 进程全局硬超时机制强制中断。 |
| 控件树文本 | 上限 128 KiB，超出时透明附带截断原因。 |
| PNG 图像 | 上限 2 MiB；优先动态缩小尺寸，仍超限则安全省略图片并保留控件树。 |
| 进程管道传输 | 严格限制为 6 MiB 原始字节流。 |
| 截图内存防护 | 硬性前置校验：总像素不超过 16,777,216，单边不超过 16,384 像素，超限在分配位图前即拦截。 |

`helperPeakWorkingSetBytes` 记录响应准备阶段的系统峰值工作集。`treeComplete` 表征控件树结构的完整性，`propertyIssues` 单独记录不可用或被裁剪的属性。

### 能力边界与可见性

- **后台截图适用性：**`backgroundOnly: true` 仅支持非最小化窗口且需同时指定 PID 与 HWND。`captureQuality` 在标注前最多采样 1024 个原始像素；suspect-low-variation 表示采样 RGB 各通道范围不超过 3，可能为空图或正常纯色/低对比界面。unknown 也不能证明图片可用。提示保留图像和 UIA，不自动改变截图策略；旧 Host 缺少该字段时按未验证处理。
- **UI 自动化覆盖度：**取证效果取决于目标应用本身的 UIA Provider 完备性。项目针对 WPF 提供了隔离测试夹具；对于 WinUI、WinForms 或自绘渲染程序，UIA 支持度视其实现而定。
- **源码证据边界：**仅匹配指定 `.xaml` 文件内的字面量属性声明（`runtimeSourceVerified: false`），不求值动态 Binding、模板或全局资源字典。
- **项目分析边界：**直接解析 `.sln` 与 `.csproj` 文件结构，不执行 MSBuild 动态属性计算。直接 Roslyn 需要显式项目求值授权；Repomix 为可选上游。本地文本结果明确声明语义范围不足。
- **视觉指示器：**在 UI 取证期间，主屏幕右上角会强制浮现半透明置顶标志（`REC / WinCoding`），保障操作对用户完全透明可见。
- **本地审计记录：**仅记录时间、PID、耗时等结构化元数据至 `%LOCALAPPDATA%/WinCode/logs/ui-audit`。达到 1 MiB 提示清理，达到 2 MiB 拦截新访问以预留结束记录空间。日志不自动删除，支持通过 [检测脚本](scripts/check-ui-audit.ps1) 手动审查。

### 打开与浏览工作区

`workspace_open({"path":"~/target-project"})` 默认返回紧凑摘要及最多 8 个入口路径，不附带目录树。`maxOutputChars` 默认 8000（范围 2048–32768），约束包含元数据及转义的整份 JSON 文本，不是模型 token 数；示例占位路径须替换为实际绝对路径。项目发现有界，需检查 `projectScanComplete` 和缺口；未统计的文件数量及总大小为 `null`。

接下来用 `wincode_list_directory({"path":"src","maxDepth":1,"maxEntries":100})` 只读取需要的目录，核对实际检查/返回条目数、省略和截断。`includeIgnored:true` 可显式访问工作区内通常隐藏的生成目录，工作区外链接仍被拒绝；截断后应缩小目录路径。旧调用方需要树时可传 `workspace_open({"path":"~/target-project","includeTree":true})`，得到有界兼容树，不能恢复原先无总量限制的清单。

### 代码上下文与取证路由

调用 `wincode_prepare_context` 时，直接使用已经掌握的位置：

```json
{"task":"核对保存逻辑","lineRanges":[{"file":"src/Service.cs","startLine":50,"endLine":80}],"maxTokens":2000}
```

已知行号用 `lineRanges`；只需声明及附近上下文时用 `scopeFiles` 加 `symbol`，预算裁剪前为 24 行窗口。审核已知方法的异常处理、取消或资源释放时，若已有文件读取工具，优先结合有界 `rg` 上下文一次读到所需分支。小文件也可用 `scopeFiles` 加 `includeFullText:true` 在预算内读取正文。仅知道文件时用 `scopeFiles` 预览。需要发现候选之外的文件时再用 `candidateFiles`，它仍然是优先列表，不是排他范围。限定范围的符号定位目前使用 C#/TS/JS/Python 本地声明模式，会明确保留语义不完整、重名和缺失提示。

默认 `compact` 返回一个 JSON 文本块；`responseFormat: "legacy"` 返回 JSON 加 Markdown。`maxTokens` 接受 512–65536，以全部返回文本的 UTF-16 字符数除以四估算，包含元数据，不等于真实模型 Token 数。结合实际行号、`queryComplete`、截断信息和 `bodyStatus` 判断证据是否够用；满足后继续分析，文件修改或工作区切换后重新取证。WinCode 没有跨调用证据有效期保证，基准中的复用策略也不是生产缓存。参数组合与限制见[代码手册](skills/wincode/references/code.md)。

### 本地开发与测试验证

[CI 工作流](.github/workflows/ci.yml) 在 PR 和 main 推送时使用 Windows、Node.js 22/24 与 .NET SDK 10.0.303 执行 `npm run check`，覆盖锁定构建、核心回归、生产 stdio 和交付校验，失败时也上传有界报告。Node 22 另运行错误/恢复契约专项与生成项目的真实 Roslyn Host/MCP 验收；交互桌面/UI 验收仍单独执行。通过与否以实际运行结果为准。2026-09-08 已核对 main 保护要求 Node 22/24 和三项 CodeQL 检查；单维护者策略要求 approval=0，不代表已获独立审核。详见 [贡献指南](CONTRIBUTING.md)。

```powershell
npm ci
npm run check            # 锁定构建、核心回归、stdio 和交付清单
npm run check:desktop    # 隔离 WPF、UI 与 UI→源码；需要交互式 Windows
npm run delivery:verify  # 检测 Gateway、Host/依赖文件、受管 Skill 缺失或变化
npm run test:inventory   # 核对每个 *.test.ts 均被明确归入套件
npm run test:all          # 同时执行 check 与 check:desktop
npm run benchmark:agent -- 1  # 显式小样本；三轮对照使用 -- 3
```

实机 UI 测试需要交互式 Windows 桌面会话。实测在包含 222 个节点的测试夹具中，定向查询将返回文本由 62 KB 降至约 1.6 KB，单次耗时稳定在 0.78 秒左右。详尽的测试记录参见 [工作日志](docs/codex_worklog.md)。

`npm run test:product -- <TavernDesk仓库> <专用测试PID> <HWND>` 显式运行六项导航到源码任务，要求固定测试 profile 已启动。它发现候选文件、核对实际控件及命令/方法文字候选，将原生和 MCP 调用、返回字符、重复源码行写入 `test-tmp/product-tasks`；不启动应用、不修改数据或源码。此脚本验收不证明运行时绑定、完整方法覆盖、相对纯原生工具提速或语义完整性；详见工作日志验收矩阵。

Agent 基准包含 10 类脚本场景，复用现有 `dotnet-mini` C# 夹具，并按四种初始位置信息分层。返回的文件、行号、正文及状态均与当前夹具核对；工具错误、传输异常、响应损坏和清理失败会保留在 `test-tmp/agent-efficiency` 下的 JSON 报告中，失败返回非零退出码。无变化复用只在夹具写入受控、变化事件可信的条件下测试，修改后必须重新请求。测量使用本地回退，关闭上游与 GUI，记录 MCP 调用、返回字符、重复显示行和调用耗时，不代表真实 Agent 完成率、模型 Token 节省或生产缓存收益。Schema v2 场景与旧版六场景报告不同，不能直接比较两版总量。

---

## Acknowledgements / 致谢

This project is inspired by and builds upon the foundational work of:
- **[FlaUI](https://github.com/FlaUI/FlaUI)** — Providing a robust, modern UI Automation (UIA2/UIA3) library for Windows desktop applications.
- **[Serena](https://github.com/oraios/serena)** — Pioneering semantic code intelligence, symbol-level navigation, and structured interactions for AI coding agents.
- **[Repomix](https://github.com/yamadashy/repomix)** — Setting the benchmark for token-efficient repository context packing.

本项目在立项与演进过程中深受上述优秀开源项目的启发：
- **FlaUI**：为 Windows 平台提供了坚固现代的 UI Automation (UIA2/UIA3) 封装底座。
- **Serena**：展示了代码语义理解、符号级代码导航以及智能化代码交互对 Coding Agent 的关键价值。
- **Repomix**：展示了高效的代码库上下文打包方案，使大型项目在面对 AI Agent 时更加高效且节约 Token。

## License / 许可

[MIT](LICENSE)
