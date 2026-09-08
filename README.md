# WinCode

<p align="center">
  <strong>Project structure, running windows, and source evidence for coding agents.</strong><br>
  让 Coding Agent 同时掌握 .NET 项目结构、运行中的桌面窗口与 XAML 源码证据。
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#简体中文">简体中文</a><br>
  <img src="https://img.shields.io/badge/Platform-Windows%20x64-0078D6" alt="Windows x64">
  <img src="https://img.shields.io/badge/MCP-stdio-black" alt="MCP stdio">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="MIT license"></a>
</p>

## English

WinCode is a local MCP server built for Windows and .NET engineering. It bridges project architecture analysis with non-invasive desktop UI inspection, enabling coding agents to debug desktop applications across source declarations, runtime control hierarchies, and annotated screenshots in a unified workflow.

- **Understand the project:** Parse declared `.sln`/`.csproj` references, search code symbols, and prepare code context within a character-based output budget (an estimate, not a model-token limit).
- **Inspect the running app:** Enumerate visible windows, query specific controls or subtrees, and capture numbered visual overlays without activating or stealing focus from the target.
- **Review with evidence:** Trace on-screen widgets back to literal XAML declaration tags, line numbers, and file hashes, with transparent reporting for ambiguity, truncation, or degraded upstreams.

Current source version: **0.11.1**. All UI tools are strictly read-only and non-destructive. See [CHANGELOG](CHANGELOG.md) for full version history.

### Quick start

**Requirements:** Git, Node.js `>= 20.0.0`, and Windows x64. This iteration was tested on Node.js 24.19.0; Node.js 20 was not separately executed. Building the UI helper requires the .NET 10 SDK; running it requires the corresponding .NET runtime installed on the machine.

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run build

# Build the native Windows UI helper
dotnet publish tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj -c Release -r win-x64 --no-self-contained
```

Add WinCode as a stdio MCP server in your agent client configuration:

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": ["~/WinCode/dist/index.js", "--workspace", "~/target-project"]
    }
  }
}
```

> **Path Note:** `~` is a placeholder. Replace `~/WinCode` with your absolute installation path (e.g., `I:/WinCode`), and `~/target-project` with your target repository's absolute path. Do not copy `~` literally if your client does not expand shell tildes.

For graphical configuration interfaces:

| Field | Value |
| --- | --- |
| Name / Type | `wincode` / `stdio` |
| Command | `node` |
| Argument 1 | `~/WinCode/dist/index.js` |
| Argument 2 | `--workspace` |
| Argument 3 | `~/target-project` |

Add each argument as a separate entry. Ensure `node` is available in PATH, or specify its absolute executable path.

For prompt engineering and token-efficient skill routing, refer to the optional [Skill and MCP setup guide](WinCode-Skill制作与MCP配置指南.md).

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

Serena results retain full `namePath`, including containers and overload indices. Pass it as `symbolName` together with its defining `relativePath`. Simple names require complete unique semantic resolution; ambiguity returns at most 20 candidates plus the count. Malformed/shortened responses are incomplete; valid empty results stay empty. Coordinates are one-based; `lineKind: "containing-symbol"` marks a containing declaration, not an exact call site. Controlled upstream tests do not establish actual language-server availability.

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
| `wincode_hello_world` | Probe gateway status, active cache volume, and adapter connection layers. |
| `wincode_diagnose_project` | Check local SDKs, Git, and Windows environment health non-invasively. |

`wincode_analyze_change_impact` is an alias of `analyze_change_impact`. Detailed workflows: [code intelligence](skills/wincode/references/code.md), [UI inspection](skills/wincode/references/ui.md), [diagnostics](skills/wincode/references/diagnostics.md).

### Architecture and resource control

```text
Coding agent ── stdio MCP ── WinCode
                              ├─ Code adapters: Serena / Repomix / Built-in text fallbacks
                              ├─ Workspace analysis, context, and impact tools
                              └─ FlaUiAdapter ── stdin/stdout JSON ── .NET UIA helper
                                                                       └─ Window tree + screenshot
```

- **Target PID Absolute Immunity:** UI inspection executes out-of-process via an isolated helper (`tools/WinCode.UIA.Host`). All process cleanups target only the owned helper process tree via Windows `taskkill /T`; the inspected target application is never terminated or injected.
- **Concurrency Protection:** UI inspection and health checks share a serial execution mutex to prevent native UIA message pump deadlocks. Workspace switches safely drain in-flight calls before changing cache namespaces.
- **Byte-Bounded Cache:** Memory and disk caches enforce strict byte caps (default 32 MiB serialized memory, 128 MiB disk quota including disk-spilled overflow snapshots). Debounced file watching (150 ms) and index probing invalidate the ~2.5s fingerprint memo upon disk changes.

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
- **Project analysis:** Extracted directly from project file XML without invoking MSBuild evaluations. Serena and Repomix are optional upstreams; local fallbacks explicitly label reduced semantic coverage.
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

Known lines: use `lineRanges`. Known file and declaration: use `scopeFiles` plus `symbol`. Known files only: use `scopeFiles`. Use `candidateFiles` when discovery beyond those candidates is intended; it remains a priority list, not an exclusive scope. Scoped symbol matching currently uses local C#/TS/JS/Python declaration patterns and reports incomplete semantic coverage; ambiguous or missing targets remain explicit issues.

The default `compact` response contains one JSON text block; `responseFormat: "legacy"` returns JSON plus Markdown. `maxTokens` accepts 512–65536 and budgets all returned text as UTF-16 characters divided by four, including metadata. Actual model tokens differ. Check actual ranges, `queryComplete`, truncation and `bodyStatus` before treating evidence as sufficient. Once the required evidence is available, continue analysis; refresh after edits or workspace changes. WinCode does not guarantee cross-request evidence freshness or provide the benchmark's reuse policy as a production cache. Parameter combinations and limits are in the [code manual](skills/wincode/references/code.md).

### Development and validation

```powershell
npm run build
npm run typecheck
npm test                  # Non-interactive test suites
npm run test:benchmark    # Benchmark correctness and fault-injection tests
npm run benchmark:agent -- 1  # Small pilot; use -- 3 for three repetitions

# Build isolated WPF test fixture for live UI testing
dotnet publish tests/fixtures/wpf-ui-review/wpf-ui-review.csproj -c Release -r win-x64 --no-self-contained
npm run test:ui           # Interactive UI suites
npm run test:ui-query     # Targeted local query acceptance suite
npm run test:all          # Comprehensive test run
```

Live UI suites require an interactive Windows desktop session. In a 222-node test fixture, targeted queries reduced response text from 62 KB to ~1.6 KB while completing in ~0.78 seconds. Detailed test records are maintained in the [work log](docs/codex_worklog.md).

The agent benchmark covers ten scripted scenarios, including existing `dotnet-mini` C# fixtures and four levels of initial location knowledge. It validates returned files, ranges, bodies and status against current fixture contents. Tool/transport/response/cleanup failures remain in the JSON report under `test-tmp/agent-efficiency`; failed cases produce a nonzero exit code. Unchanged-evidence reuse is tested only under trusted, controlled fixture writes; edits require a new request. Reports measure MCP calls, output characters, repeated displayed lines and call time using local fallback with upstreams and GUI disabled. They do not establish real-agent completion rates, model-token savings or production cache benefits. Schema v2 results should not be compared directly with the earlier six-scenario report.

---

## 简体中文

WinCode 是面向 Windows 与 .NET 工程研发的本地 MCP 服务。它将项目依赖拓扑分析与非侵入式桌面 UI 取证深度整合，让 Coding Agent 能够在同一套工作流中，结合源码声明、运行时控件层级与标注截图协同排查问题。

- **理解项目架构：**解析 `.sln`/`.csproj` 声明的项目引用拓扑，跨文件检索符号，并在基于字符数估算的输出预算内准备任务上下文；该预算不是真实模型 Token 硬上限。
- **观察实际界面：**发现系统可见窗口，按条件定向查询目标控件或子树，并在不激活、不抢占前台焦点的前提下获取数字标注截图。
- **源码双向印证：**将运行时抓取的控件关联回 XAML 源码声明的起始行号、代码片段与文件哈希，清晰报告歧义、截断与降级状态。

当前源码版本为 **0.11.1**。所有 UI 取证工具均为纯只读与非侵入设计。版本历史见 [CHANGELOG](CHANGELOG.md)。

### 快速上手

**环境要求：**Git、Node.js `>= 20.0.0`、Windows x64。本轮实际测试使用 Node.js 24.19.0，未另行运行 Node.js 20。编译 UI Helper 需安装 .NET 10 SDK；运行依赖宿主机对应的 .NET 运行时。

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run build

# 编译 C# 原生 UI 取证宿主
dotnet publish tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj -c Release -r win-x64 --no-self-contained
```

在 Agent 客户端配置文件中添加 stdio MCP 服务（以支持 `mcpServers` 的客户端为例）：

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": ["~/WinCode/dist/index.js", "--workspace", "~/target-project"]
    }
  }
}
```

> **路径说明：**配置中的 `~` 仅为路径占位符。请将 `~/WinCode` 替换为你本地安装 WinCode 的绝对路径（如 `I:/WinCode`），将 `~/target-project` 替换为待分析项目的绝对路径。若客户端不支持自动展开波浪号，请勿直接照抄 `~`。

若通过图形界面添加：

| 配置字段 | 填写内容 |
| --- | --- |
| 服务名称 / 类型 | `wincode` / `stdio` |
| 启动命令 | `node` |
| 参数 1 | `~/WinCode/dist/index.js` |
| 参数 2 | `--workspace` |
| 参数 3 | `~/target-project` |

注意每个参数独立添加为一行。确保系统环境变量 PATH 中包含 `node`，或直接填写 node.exe 的绝对路径。

如需配合 Agent Skill 获得低 Token 开销的精准任务路由，请参阅可选的 [Skill 与 MCP 配置指南](WinCode-Skill制作与MCP配置指南.md)。

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

Serena 结果保留完整 `namePath`（容器及重载索引）；将其作为 `symbolName` 并附定义文件 `relativePath` 续查引用。简单名称只有完整、唯一语义定位才继续；歧义最多返回 20 个候选及总数。损坏/缩略响应不完整，合法空结果保持为空。坐标统一一基；`lineKind:"containing-symbol"` 表示所在声明起点，不是精确调用行。受控上游测试不替代真实语言服务器验收。

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
| `wincode_hello_world` | 网关状态心跳，检查缓存体积与适配器分层连接状态。 |
| `wincode_diagnose_project` | 无侵入检查本地 .NET SDK、Git 与运行环境健康度。 |

`wincode_analyze_change_impact` 是 `analyze_change_impact` 的别名。详细参数与工作流请参考对应手册：[代码分析](skills/wincode/references/code.md)、[UI 取证](skills/wincode/references/ui.md)、[系统诊断](skills/wincode/references/diagnostics.md)。

### 架构设计与资源管控

```text
Coding Agent ── stdio MCP ── WinCode
                               ├─ 代码适配器：Serena / Repomix / 内置文本降级引擎
                               ├─ 工作区分析、上下文提取与影响面分析工具
                               └─ FlaUiAdapter ── stdin/stdout JSON ── .NET UIA Helper
                                                                        └─ 控件树遍历 + 截图渲染
```

- **目标进程绝对免疫：**UI 取证由独立的 C# 辅助进程（`tools/WinCode.UIA.Host`）在进程外执行。所有清理操作严格仅终止自身派生的 Helper 辅助进程树（通过 Windows `taskkill /T`），**被测目标应用进程受绝对免疫保护，绝不被终止或注入**。
- **防死锁与并发保护：**UI 自动化访问与健康检查共用串行互斥锁，杜绝底层 Win32/UIA 消息泵死锁。切换工作区前会先等待排空在途请求，超时则拒绝切换，保证会话隔离安全。
- **按字节硬封顶缓存：**代码缓存按工作区物理隔离，采用序列化内存估算与字节上限清理策略（默认内存预算 32 MiB、磁盘配额 128 MiB，包含超大快照落盘文件）。结合 150 ms 去抖监听与 Git 索引探测，文件变更时指纹缓存及时失效。

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
- **项目分析边界：**直接解析 `.sln` 与 `.csproj` 文件结构，不执行 MSBuild 动态属性计算。Serena 与 Repomix 均为可选上游，降级运行时会在结果中明确声明。
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

已知行号用 `lineRanges`；已知文件和声明名用 `scopeFiles` 加 `symbol`；仅知道文件用 `scopeFiles`。需要发现候选之外的文件时再用 `candidateFiles`，它仍然是优先列表，不是排他范围。限定范围的符号定位目前使用 C#/TS/JS/Python 本地声明模式，会明确保留语义不完整、重名和缺失提示。

默认 `compact` 返回一个 JSON 文本块；`responseFormat: "legacy"` 返回 JSON 加 Markdown。`maxTokens` 接受 512–65536，以全部返回文本的 UTF-16 字符数除以四估算，包含元数据，不等于真实模型 Token 数。结合实际行号、`queryComplete`、截断信息和 `bodyStatus` 判断证据是否够用；满足后继续分析，文件修改或工作区切换后重新取证。WinCode 没有跨调用证据有效期保证，基准中的复用策略也不是生产缓存。参数组合与限制见[代码手册](skills/wincode/references/code.md)。

### 本地开发与测试验证

```powershell
npm run build
npm run typecheck
npm test                  # 运行非交互单元与契约测试
npm run test:benchmark    # 基准正确性与故障注入测试
npm run benchmark:agent -- 1  # 单轮小样本；三轮对照使用 -- 3

# 实机 UI 测试前发布隔离 WPF 测试夹具
dotnet publish tests/fixtures/wpf-ui-review/wpf-ui-review.csproj -c Release -r win-x64 --no-self-contained
npm run test:ui           # 交互式 UI 自动化测试
npm run test:ui-query     # 运行定向控件查询验收测试
npm run test:all          # 全套回归验证
```

实机 UI 测试需要交互式 Windows 桌面会话。实测在包含 222 个节点的测试夹具中，定向查询将返回文本由 62 KB 降至约 1.6 KB，单次耗时稳定在 0.78 秒左右。详尽的测试记录参见 [工作日志](docs/codex_worklog.md)。

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
