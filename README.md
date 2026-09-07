# WinCode

### v0.7.2 optional UI text evidence / 可选界面关键词检索

在现有 wincode_ui_review 参数中增加 textQueries，例如 ["TavernDesk", "FirstRun.Language.Title"]。最多 5 个显式关键词，每个 80 字符，仅扫描 candidateFiles 指定的 XAML，复用既有文件、时间及 128 KiB 文本输出预算。

sourceEvidence.textSearch 返回独立的文件、属性行号、片段和 SHA256；最多保留 40 项，totalMatches 是已扫描内容中的属性/关键词命中数。按原始属性值区分大小写做字面量子串检索，不解码 XML 实体、不展开资源字典、不检索元素正文。支持 Content/Text/Header/Title/ToolTip/AutomationProperties.Name/x:Key；资源引用和绑定表达式单独标注。文本命中不是运行时节点身份匹配；输出紧张时优先裁剪这些可选结果，truncated 标记不完整结果，整个可选对象也可能被省略。


### v0.7.1 acceptance and diagnostics / 验收与诊断

UI source results include per-node `reason`, `declarationCoverage` and `coverage` (evaluated/returned nodes, nodes with IDs and matched nodes). A syntax gap is reported as a limitation, never attributed to a particular runtime control without evidence. `fileScanComplete` only describes supplied-file reads, not full XAML semantics or complete UI coverage.

`wincode_hello_world.health` adds `workspaceWatch` and `flaui.runtime`. These are passive snapshots; recent timeout/cancellation/cleanup errors have timestamps and remain visible after a successful health probe. A stopped file watcher is reported without an automatic retry loop.

For opt-in testing, `npx tsx scripts/verify-ui-runtime.ts <options.json>` accepts `{ "pid": 12345, "workspace": "C:/source", "candidateFiles": ["MainWindow.xaml"], "output": "C:/isolated-results", "iterations": 20 }`. Start your target with its own fresh isolated-data mode first. The runner attaches only to that PID and does not start the application or send model requests. Reports and screenshots remain local; `test-tmp/` is ignored by Git. Twenty iterations are a short acceptance sample, not a long-term leak guarantee.

### v0.7 working version: UI source candidates / UI 源码候选

Workspace browsing omits `.dotnet` only when local SDK markers (the dotnet executable, `sdk`, and `host`) are present. Tree output includes omission reasons; metadata counts describe the filtered, depth-limited scan rather than total disk usage. `projectSummaries` reports project-file declarations independently of directory naming; imported/conditional MSBuild values are not evaluated.

`wincode_ui_review` reuses one UI snapshot and searches explicit WPF XAML candidates. It returns literal declaration evidence, not verified runtime/source identity or an automatic defect diagnosis.

`wincode_ui_review` 将同一次窗口取证与指定 WPF XAML 文件中的字面量声明候选组合返回。例如：

```json
{
  "pid": 12345,
  "capture": "annotated",
  "candidateFiles": ["Views/MainWindow.xaml"],
  "maxDepth": 6,
  "maxNodes": 300
}
```

- Open the intended source workspace first. `candidateFiles` requires 1–16 relative `.xaml` paths; it does not automatically verify that the running application was built from this workspace.
- 先打开目标源码工作区。候选必须为工作区内相对 XAML 路径，不递归扫描；UTF-8、每文件 256 KiB、总读取 1 MiB，最多关联 100 个快照节点，每节点返回最多 5 个候选。
- `sourceEvidence.nodes` 通过本次快照 `nodeId` 对应控件，包含真实起始标签行号、片段、文件 SHA-256 和原始属性声明。`single-candidate` 仅代表已扫描范围内一个候选；`ambiguous` 保留歧义，`not-found` 不是“不存在”，`unsupported` 包括缺失或可能被裁剪的 ID。
- Only literal `AutomationProperties.AutomationId` attributes are matched. XML entities, property-element syntax, resources, namespace semantics, `x:Name` inference and runtime Binding/DataContext evaluation are not supported. `fileScanComplete` reports whether all supplied files were scanned; it does not mean semantic analysis was complete. File statuses and truncation describe incomplete coverage.
- 截图独立放入 MCP image 块；源码结果使用剩余的 128 KiB 文本预算。查询失败或超预算时缩减/省略源码证据，保留 UI 快照。`runtimeSourceVerified` 始终为 `false`；源码哈希只标识读取内容，不证明运行时版本。
- No additional dependencies, target instrumentation, automatic clicks or code edits. 当前未发布；4K/多 DPI 肉眼验收仍未覆盖。

<p align="center">
  <strong>A Windows-first MCP gateway that gives coding agents a small set of high-level tools: workspace graph, evidence-bounded context, change-impact reports, and desktop UI inspection that stay honest when analysis is incomplete.</strong>
</p>

<p align="center">
  <a href="#-english">English</a> • <a href="#-简体中文">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Platform">
  <img src="https://img.shields.io/badge/.NET-Supported-512BD4?style=flat-square&logo=dotnet&logoColor=white" alt=".NET">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Protocol-Model%20Context%20Protocol-black?style=flat-square" alt="MCP">
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License">
</p>

---

<span id="-english"></span>
## 🌐 English

### 🌟 Project Vision
**WinCode** is not just a tool wrapper; it is an **engineering capability gateway built specifically for Windows development environments**.

Instead of forcing AI coding agents (such as Codex, Claude Code, etc.) to master dozens of low-level tools, WinCode exposes a curated set of **high-level MCP tools**. Agents connect to one endpoint for workspace graphs, file-backed context, change-impact reports, and **Windows desktop runtime UI inspection**. Serena and Repomix are optional upstreams; when they are missing or incomplete, WinCode keeps running and **labels the gap**. With v0.5 stability hygiene (one owner for child processes, workspace sessions, byte-capped cache, bounded timeouts) and v0.6 desktop UI inspection (out-of-process FlaUI.UIA3 host, bounded control trees, coordinate-aware badge captures, and strict helper-only process killing), the gateway provides trustworthy, evidence-bounded intelligence for both code and running desktop applications.

```
Coding Agent (Codex / Claude Code / Cursor / Windsurf)
                    │
                    ▼  (Single High-Level MCP Gateway)
┌────────────────────────────────────────────────────────────────────────┐
│                       WinCode MCP Agent Gateway                        │
├──────────────────────────────────────────────────────┬─────────────────┤
│                  🟢 Current (v0.6)                   │   🟡 Planned    │
├──────────────────┬──────────────────┬────────────────┼─────────────────┤
│ .NET sln/csproj  │ Evidence-bounded │ Desktop UI     │ Diagnostics &   │
│ graph + impact   │ context + health │ Inspection     │ Performance     │
│ + process/session│ + byte-capped    │ (FlaUI.UIA3)   │ (Snoop/PerfView)│
│ lifecycle        │ cache/timeouts   │ +Bounded/Badge │ + UiSourceMapper│
└──────────────────┴──────────────────┴────────────────┴─────────────────┘
```

### 🏛️ Key Principles
1. **Upstream First**: **Serena** and **Repomix** are optional adapters. A found `serena` binary is not a connection. Handshake, project activation, and a successful semantic query are reported separately.
2. **Evidence over summaries**: Default context is file snippets with path/symbol/line, inside a token budget. Missing evidence is declared; the server will not dump the whole repo or invent architecture advice.
3. **Windows First**: Reads real `.sln` / `.csproj` graphs (ProjectReference, WPF/WinUI/WinForms, entry points). `dotnet` on PATH is not semantic analysis. Extra Roslyn integration is **not** committed.
4. **Safe Workspace Policy**: No hard deletes. Obsolete files move to `trash/` with audit metadata. Only relative in-workspace paths are accepted.
5. **Caching**: Fingerprints (git HEAD / dirty mtime) avoid repeat scans. Incomplete Serena queries are not cached. Memory/disk caches have **byte** caps, not only entry counts. Consecutive tool calls reuse a few-second fingerprint memo; workspace switch changes the cache namespace.
6. **Source ≠ confidence**: `source` is the provider. Confidence for impact analysis requires unique resolution and a complete query. Zero references, ambiguity, or incomplete queries return `UNKNOWN` — never "safe to delete". Local regex fallback does not guarantee symbol identity, overloads, or complete cross-file references.
7. **Long-running hygiene**: Every child process, timer, and MCP transport has an owner (`ResourceManager`). `SIGINT`/`SIGTERM` run an idempotent graceful shutdown. Adapter timeouts become structured `{ status: failed, reason: timeout, recoverable: true }` results — they do not crash the gateway.
8. **Runtime UI Inspection & Process Safety**: Desktop UI inspection executes out-of-process via an isolated `FlaUI.UIA3` helper host (`tools/WinCode.UIA.Host`) over stdin/stdout JSON streaming. Queries are non-invasive and read-only. Bounded tree traversal (`maxDepth`, `maxNodes`) prevents deep visual trees from overflowing agent token contexts; offscreen or micro-sized nodes are filtered from badge rendering. Process-tree cleanup strictly terminates only the helper process; target application PIDs are immune. Screenshots with numbered badges map to control node IDs with DPI-aware relative coordinates.

---

### 🗺️ Roadmap

#### v0.1–v0.3 (Delivered)
- [x] MCP `stdio` server, `workspace_open`, safe `trash/` policy, fingerprint cache.
- [x] Serena MCP adapter **when handshake succeeds**; otherwise labeled text fallback (not an AST/Roslyn engine).
- [x] Repomix CLI packing **when installed**; otherwise a capped builtin file packer (not Tree-sitter compression unless the CLI `--compress` path runs).
- [x] `analyze_change_impact` with risk levels; `wincode_plan_refactoring` is a checklist on top of impact, not an automated refactor engine.

#### v0.4 (Delivered)
- [x] Layered adapter status: `commandFound` / `handshakeOk` / `projectActive` / `semanticQueryUsable` / `mode`. `available: true` + fallback means local tools work, not "Serena connected".
- [x] `.sln` / `.csproj` project graph and entry points from project files (`projectGraph`). Folder names are hints only.
- [x] Impact `confidence` from unique resolution + query completeness. Ambiguous types, incomplete queries, and 0 references return `UNKNOWN`.
- [x] `wincode_prepare_context` returns evidence snippets by default; `includeFullText` packs only the related file set; empty related set does not dump the repo.
- [x] Portable fixture `tests/fixtures/dotnet-mini` (MiniDesk, 3 projects). Optional live repo via `WINCODE_TAVERN_PATH`.

#### v0.5 (Delivered)
- [x] Unified `ResourceManager`: child processes, timers, adapter transports. `stop()` is idempotent. SIGINT/SIGTERM drain in-flight calls then dispose.
- [x] Serena: lazy connect, single-flight handshake, crash/timeout reset, workspace switch drops the old MCP session. Layered `commandFound` / `handshakeOk` / `projectActive` / `semanticQueryUsable` unchanged.
- [x] `SessionManager`: current workspace, cache namespace, fingerprint, createdAt, lastActivity. `workspace_open` is serialized and must not leak symbols across projects.
- [x] Cache byte limits (`maxMemoryBytes` / `maxDiskBytes` / `maxEntryBytes`). Oversized snapshots are not kept in the heap.
- [x] Fingerprint memo (~2.5s) + single-flight so consecutive prepare_context / find_symbol / find_references / impact calls do not repeat `git status`.
- [x] Timeouts on git, dotnet, Serena connect/RPC, Repomix CLI, and file scans.
- [x] Lightweight runtime health on `wincode_hello_world` (and a `runtime` block on diagnose): uptime, cache bytes, child process count, Node memory, last adapter error.

#### v0.5.1 (Delivered)
- [x] Windows process-tree kill: `taskkill /T` before signaling the wrapper; Serena spawn avoids extra `cmd /c` when a `.exe` is resolved.
- [x] Fingerprint memo invalidated by cheap git/index probe + debounced `fs.watch` (not only TTL).
- [x] Same-path `workspace_open` clears cache and marks Serena project stale when the fingerprint changed.
- [x] Oversized Repomix/context snapshots spill to disk; heap keeps a preview.
- [x] Mock Serena stdio fixture for handshake tests without a live Serena install.

#### v0.6 (Delivered)
- [x] **C# FlaUI.UIA3 Host** (`tools/WinCode.UIA.Host`): Out-of-process stdin/stdout JSON host targeting Windows desktop apps via HWND or PID with Per-Monitor V2 DPI awareness.
- [x] **Resilient Capture Pipeline**: 3-tier window screenshot fallback: `PrintWindow(PW_RENDERFULLCONTENT)` -> `BitBlt` -> GDI+ `CopyFromScreen(Format32bppRgb)`.
- [x] **Bounded UI Control Tree**: Hierarchical traversal bounded by `maxDepth` and `maxNodes` with explicit `TruncateReason` flags (`maxDepth`, `maxNodes`, while timeout maps to structured `errorCode: TIMEOUT`).
- [x] **Numbered Badge Overlay**: Relative coordinate transformation and high-contrast numbered badges matching `UiNode.id` for multimodal visual inspection (offscreen or tiny elements safely skipped).
- [x] **Isolated WPF Review Fixture** (`tests/fixtures/wpf-ui-review`): Deterministic multi-control WPF fixture for testing layout, visibility, and UIA hierarchy.
- [x] **TypeScript Adapter & Contracts** (`src/Adapters/FlaUiAdapter.ts`, `src/Core/UiContracts.ts`): Non-invasive health probe, Mutex-serialized execution, and strict helper-only process killing (target app PID is immune).
- [x] **MCP Tool `wincode_ui_inspect`**: Clean content separation: bounded JSON text in `content[0]` (Base64 stripped to prevent token bloat) and PNG image block appended in `content[1]` only when capture is requested. Supports `capture` modes: `none` (default, zero image token overhead), `original`, and `annotated`.
- [x] **Automatic PID Resolution**: Resolves owner PID automatically when queried with HWND only.

#### Later (v0.7+)
- [ ] v0.7 `UiSourceMapper` (mapping UIA runtime elements to XAML source files and line numbers).
- [ ] Snoop / PerfView integration and diagnostic triggers.
- [ ] Extra Roslyn host (only after measuring Serena gaps on real C# repos).
- [ ] Removing existing tool names.

---

### 🛠️ High-Level MCP Tools

| Tool | Description | Notes |
| :--- | :--- | :--- |
| `workspace_open` | Open a directory; detect type, sln/csproj, git, metadata, tree. | Switches the active workspace. |
| `wincode_hello_world` | Heartbeat, layered adapter status, and runtime health (uptime, cache, child processes). | Fallback ≠ Serena connected. |
| `wincode_analyze_workspace` | Workspace overview + `.NET` `projectGraph` from sln/csproj. | Directory layers are hints, not architecture judgments. |
| `wincode_prepare_context` | Task-related evidence (path, symbol, line, snippet) within `maxTokens`. | Set `includeFullText` to pack **related** files only. Declares insufficient evidence. |
| `wincode_find_code_symbol` | Symbol search with `source`, `queryComplete`, `uniqueTypeMatch`. | Serena when usable; otherwise text scan. |
| `wincode_find_references` | Call-site / usage list with the same honesty fields. | 0 hits is not "no impact". |
| `analyze_change_impact` | Blast radius + risk. Alias: `wincode_analyze_change_impact`. | `UNKNOWN` when not uniquely resolved or query incomplete. Confidence is not `source`. |
| `wincode_diagnose_project` | Windows / SDK / git / Serena status plus a `runtime` snapshot. | `dotnet --version` ≠ semantic references. |
| `wincode_plan_refactoring` | Checklist derived from impact + trash policy. | Not an automated refactor engine. |
| `wincode_safe_move_to_trash` | Move a relative in-workspace path to `trash/` with metadata. | Absolute / `..` / symlink escape rejected. |
| `wincode_ui_inspect` | Inspect Windows desktop application UI via UIA. Returns bounded control tree JSON in `content[0]` and optional screenshot in `content[1]` as MCP image block. | Target by `pid` or `hwnd`. Screenshot base64 stripped from text JSON. `capture` modes: `none` (default), `original`, or `annotated`. |

---

### 📂 Architecture Overview

```
WinCode/
├── src/
│   ├── index.ts                      # MCP CLI Entrypoint (stdio)
│   ├── Gateway/
│   │   ├── McpServer.ts              # MCP Server instance & handlers
│   │   └── Protocol.ts               # MCP Tool schemas & contract (includes wincode_ui_inspect)
│   ├── Core/
│   │   ├── Config.ts                 # Workspace, timeouts, cache byte limits
│   │   ├── ResourceManager.ts        # Child processes / timers / idempotent dispose
│   │   ├── SessionManager.ts         # Active workspace session + cache namespace
│   │   ├── WorkspaceWatch.ts         # Debounced fs.watch to drop fingerprint memo
│   │   ├── Workspace.ts              # Project detection & safe trash policy
│   │   ├── Cache.ts                  # Byte-capped memory/disk cache + fingerprint memo
│   │   ├── DotNetGraph.ts            # sln/csproj ProjectReference graph
│   │   ├── Context.ts                # Evidence-bounded context (budget + snippets)
│   │   ├── ToolRouter.ts             # Router, session switch, runtime health
│   │   └── UiContracts.ts            # UI inspection types, interfaces, & schemas
│   ├── Adapters/
│   │   ├── IAdapter.ts               # Adapter contract + layered upstream status
│   │   ├── FlaUiAdapter.ts           # FlaUI UIA3 host adapter & process manager
│   │   ├── RepomixAdapter.ts         # Repomix CLI or closed-set builtin packer
│   │   └── SerenaAdapter.ts          # Serena MCP client or regex fallback
│   ├── CompositeTools/
│   │   ├── ArchitectureAnalyzer.ts   # File-derived graph + directory hints
│   │   ├── ImpactAnalyzer.ts         # Blast radius; UNKNOWN when incomplete
│   │   ├── ProjectDiagnostics.ts     # SDK/git/Serena status (no overclaim)
│   │   └── RefactorAssistant.ts      # Impact-based checklist + trash policy
│   └── Extensions/
│       └── ExtensionManager.ts       # Reserved; no Snoop/PerfView plugins yet
├── tools/
│   └── WinCode.UIA.Host/             # C# FlaUI.UIA3 out-of-process UI automation host (.NET 10)
├── tests/
│   ├── fixtures/
│   │   ├── dotnet-mini/              # Portable MiniDesk .NET fixture (3 projects)
│   │   └── wpf-ui-review/            # Isolated WPF UI review test application
│   ├── flaui-adapter.test.ts         # FlaUI host adapter & lifecycle unit tests
│   ├── ui-inspect-mcp.test.ts        # wincode_ui_inspect MCP protocol end-to-end tests
│   ├── tdd-suite.test.ts             # Default CI suite (v0.4 contract + e2e)
│   ├── v05-stability.test.ts         # Lifecycle / cache bytes / timeouts
│   └── verify.ts                     # Smoke verification
└── trash/                            # Safe archive (.gitignore)
```

---

### 🚀 Getting Started

#### Prerequisites
- Windows 10/11
- Node.js >= 18.0.0
- .NET SDK (Required: .NET SDK 10 for building `WinCode.UIA.Host` and running WPF test fixture)

#### 1. Installation & Build
```bash
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm install
npm run build
# Publish the C# FlaUI.UIA3 host and the WPF test fixture
dotnet publish tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj -c Release -r win-x64 --no-self-contained
dotnet publish tests/fixtures/wpf-ui-review/wpf-ui-review.csproj -c Release -r win-x64 --no-self-contained
```

#### 2. Tests
```bash
npm run build
npm test
npx tsx --test tests/ui-inspect-mcp.test.ts
npm run test:verify
```

`npm test` runs the eight suites listed in `package.json`, including UI MCP, hardening, source-review and v0.7.1 acceptance tests. End-to-end MCP cases spawn `dist/index.js`, so build first.
`tests/ui-inspect-mcp.test.ts` executes end-to-end MCP UI inspection tests against a live WPF fixture.

Default tests use `tests/fixtures/dotnet-mini`. To optionally exercise a local live solution:

```bash
set WINCODE_TAVERN_PATH=C:\path\to\your.sln-folder
npm test
```

#### 3. Connect to AI Agents (Claude Desktop / Codex / Windsurf / Cursor)
Add WinCode to your MCP client configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": [
        "C:/path/to/WinCode/dist/index.js",
        "--workspace",
        "C:/path/to/your/target-project"
      ]
    }
  }
}
```

---

<span id="-简体中文"></span>
## 🇨🇳 简体中文

### 🌟 项目愿景
**WinCode** 不是简单的底层工具转发器，而是专为 **Windows 桌面与工程环境打造的 Agent 开发能力网关**。

核心理念：**不要让 Agent 学习几十个低层工具，而是给少量高语义接口。** 统一提供工作区依赖图、预算内代码证据、变更影响面分析以及 **Windows 桌面运行时 UI 取证**。Serena / Repomix 是可选上游；缺失或不完整时继续运行，并**标明缺口**，而不是夸大连接。在 v0.5 长期驻留稳定性（统一资源管控、会话隔离、字节级缓存封顶、超时熔断）与 v0.6 桌面 UI 取证（进程外 FlaUI.UIA3 宿主、有界控件树、带编号标注截图、严格仅终止辅助进程且目标应用 PID 绝对免疫）的加持下，网关为 AI Agent 提供兼顾代码静态语义与桌面运行时取证的高可靠工程底座。

```
Coding Agent (Codex / Claude Code / Cursor / Windsurf 等)
                    │
                    ▼  (统一 MCP 网关入口)
┌────────────────────────────────────────────────────────────────────────┐
│                       WinCode MCP Agent Gateway                        │
├──────────────────────────────────────────────────────┬─────────────────┤
│                  🟢 当前版本 (v0.6)                  │    🟡 后续规划  │
├──────────────────┬──────────────────┬────────────────┼─────────────────┤
│ .NET sln/csproj  │ 预算内证据上下文 │ 桌面 UI 取证   │ 深度诊断与调优  │
│ 图 + 影响面分析  │ + 分层健康状态   │ (FlaUI.UIA3)   │(Snoop/PerfView) │
│ 进程与会话生命期 │ + 字节上限缓存   │+有界树/标注徽章│ + UiSourceMapper│
└──────────────────┴──────────────────┴────────────────┴─────────────────┘
```

### 🏛️ 核心架构原则
1. **不修改上游源码**：**Serena** 与 **Repomix** 走适配器。命令在 PATH 上 ≠ 已握手。命令存在、握手成功、项目激活、语义查询可用必须分开报告。
2. **证据优先于摘要**：默认返回带路径/符号/行号的片段，受 token 预算约束。证据不足就声明不足；禁止无相关文件时倾倒整个仓库，也不编造架构结论。
3. **Windows 优先**：从真实 `.sln` / `.csproj` 生成项目依赖和入口。`dotnet` 在 PATH 上 ≠ 具备语义引用能力。额外 Roslyn 集成本里程碑**未承诺**。
4. **安全防误删**：禁止硬删除，归档到 `trash/` 并写审计元数据；只接受工作区内相对路径。
5. **指纹缓存**：基于 git HEAD / dirty mtime。不完整的 Serena 查询不入库。内存/磁盘缓存有**字节**上限，不只是条数。连续工具调用复用数秒级指纹 memo；切换工作区会更换 cache namespace。
6. **source 不能决定 confidence**：`source` 只说明供应方。影响分析的可信度看目标是否唯一解析、查询是否完整。0 引用、同名歧义、查询不完整必须返回 `UNKNOWN`，不得写成可安全删除。本地正则降级不保证符号身份、重载区分或跨文件引用完整性。
7. **长期驻留卫生**：子进程、定时器、MCP transport 都有明确 owner（`ResourceManager`）。`SIGINT`/`SIGTERM` 做可重复的 graceful shutdown。适配器超时变成结构化 `{ status: failed, reason: timeout, recoverable: true }`，不得把网关打崩。
8. **运行时 UI 取证与进程安全**：桌面 UI 取证通过独立的 `FlaUI.UIA3` 辅助进程（`tools/WinCode.UIA.Host`）在进程外执行，采用标准 stdin/stdout JSON 通信，坚持只读与非侵入原则。有界控件树遍历（`maxDepth`、`maxNodes`）防止深层视觉树耗尽 Agent 的 Token 上下文；屏幕外或极小尺寸节点在 Badge 渲染时会被自动过滤。进程树清理严格仅终止辅助取证进程，被测目标应用 PID 绝对免疫。带编号 Badge 的标注截图与控件节点 ID 一一对应，并基于 DPI 感知的高精度相对坐标渲染。

---

### 🗺️ 研发路线图 (Roadmap)

#### v0.1–v0.3 (已交付)
- [x] MCP `stdio` 服务、`workspace_open`、安全 `trash/`、指纹缓存。
- [x] Serena MCP 适配器（**握手成功才算上游**）；否则为标明限制的文本降级，不是 AST/Roslyn 引擎。
- [x] Repomix CLI（已安装时）；否则为有上限的内置打包器。Tree-sitter 压缩仅在 CLI `--compress` 路径上存在。
- [x] `analyze_change_impact` 风险定级；`wincode_plan_refactoring` 是基于 impact 的检查清单，不是自动重构器。

#### v0.4 (已交付)
- [x] 分层状态：`commandFound` / `handshakeOk` / `projectActive` / `semanticQueryUsable` / `mode`。`available: true` 且 fallback 只表示本地功能可用，不表示 Serena 已连接。
- [x] 从 `.sln` / `.csproj` 生成项目依赖图与入口（`projectGraph`）。目录名分层只是提示。
- [x] 影响分析 `confidence` 由唯一解析 + 查询完整性决定。歧义、查询不完整、0 引用返回 `UNKNOWN`。
- [x] `wincode_prepare_context` 默认返回证据片段；`includeFullText` 只打包相关文件；无相关文件时拒绝倾倒仓库。
- [x] 可移植夹具 `tests/fixtures/dotnet-mini`（MiniDesk，3 个项目）。真实仓库可通过 `WINCODE_TAVERN_PATH` 可选接入。

#### v0.5（已交付）
- [x] 统一 `ResourceManager`：子进程、定时器、适配器 transport。`stop()` 可重复调用。SIGINT/SIGTERM 先排空在途请求再释放。
- [x] Serena：懒连接、单飞握手、崩溃/超时后重置、切换工作区丢弃旧 MCP 会话。分层 `commandFound` / `handshakeOk` / `projectActive` / `semanticQueryUsable` 不变。
- [x] `SessionManager`：当前工作区、cache namespace、fingerprint、createdAt、lastActivity。`workspace_open` 串行化，禁止跨项目泄漏符号。
- [x] 缓存字节上限（`maxMemoryBytes` / `maxDiskBytes` / `maxEntryBytes`）。超大 snapshot 不长期留在堆上。
- [x] 指纹 memo（约 2.5 秒）+ single-flight，避免连续 prepare_context / find_symbol / find_references / impact 重复跑 `git status`。
- [x] git、dotnet、Serena 连接/RPC、Repomix CLI、文件扫描均有超时。
- [x] `wincode_hello_world` 带轻量 runtime health（diagnose 带 `runtime` 块）：uptime、缓存字节、子进程数、Node 内存、最近适配器错误。

#### v0.5.1（已交付）
- [x] Windows 进程树：先 `taskkill /T` 再信号 wrapper；能解析到 `.exe` 时 Serena 不再套一层 `cmd /c`。
- [x] 指纹 memo 被 cheap git/index probe + 去抖 `fs.watch` 失效，不只靠 TTL。
- [x] 同一路径 `workspace_open` 在 fingerprint 变化时清缓存并标记 Serena project stale。
- [x] 超大 snapshot 落盘，堆上只留预览。
- [x] mock Serena stdio 夹具，无需安装 Serena 也能测 handshake。

#### v0.6（已交付）
- [x] **C# FlaUI.UIA3 独立宿主**（`tools/WinCode.UIA.Host`）：基于 stdin/stdout JSON 的进程外辅助宿主，支持通过 HWND 或 PID 探测 Windows 桌面应用，具备 Per-Monitor V2 高 DPI 感知能力。
- [x] **高韧性截图管线**：三级截图降级策略：`PrintWindow(PW_RENDERFULLCONTENT)` -> `BitBlt` -> GDI+ `CopyFromScreen(Format32bppRgb)`。
- [x] **有界 UI 控件树**：受 `maxDepth` 和 `maxNodes` 严格约束的层级遍历，包含显式截断标记 `TruncateReason`（`maxDepth`、`maxNodes`，超时则走 `errorCode: TIMEOUT`）。
- [x] **编号 Badge 标注图**：物理坐标到窗口相对坐标转换，渲染与 `UiNode.id` 严格一一对应的高对比度数字标注徽章（屏幕外或极小尺寸元素安全跳过），供多模态 Agent 视觉分析。
- [x] **独立 WPF 测试夹具**（`tests/fixtures/wpf-ui-review`）：确定性多控件 WPF 测试应用，覆盖布局、可见性与 UIA 层级自动化回归验证。
- [x] **TypeScript 适配器与契约**（`src/Adapters/FlaUiAdapter.ts`、`src/Core/UiContracts.ts`）：非侵入式健康探测、Mutex 串行化执行保护、以及严格仅终止辅助进程的生命周期管理（目标应用 PID 绝对免疫不受影响）。
- [x] **MCP 工具 `wincode_ui_inspect`**：内容完全分离：`content[0]` 为干净的有界 JSON 文本（剥离 Base64 避免 Token 膨胀），仅在请求截图时将 PNG 图片追加为 `content[1]` 的 MCP `image` 内容块。支持 `capture` 模式：`none`（默认，无额外图片 Token 消耗）、`original` 与 `annotated`。
- [x] **自动 PID 解析**：支持仅传 HWND 时自动解析宿主窗口归属进程 PID。

#### 之后（v0.7+）
- [ ] v0.7 `UiSourceMapper`（将运行时 UIA 元素映射至 XAML 源码文件及行号）。
- [ ] Snoop / PerfView 深度诊断与触发联动。
- [ ] 额外 Roslyn 宿主（须先在真实 C# 仓库上量化 Serena 缺口）。
- [ ] 删除现有工具名。

---

### 🛠️ 对外核心 MCP 工具

| 工具名称 | 功能描述 | 说明 |
| :--- | :--- | :--- |
| `workspace_open` | 打开目录，识别类型、sln/csproj、git、元数据与目录树 | 切换当前工作区。 |
| `wincode_hello_world` | 心跳、分层适配器状态、runtime health（uptime / 缓存 / 子进程） | fallback ≠ Serena 已连接。 |
| `wincode_analyze_workspace` | 工作区概览 + 从 sln/csproj 得到的 `projectGraph` | 目录分层只是提示，不是架构判断。 |
| `wincode_prepare_context` | 任务相关证据（路径、符号、行、片段），受 `maxTokens` 约束 | `includeFullText` 只打包**相关**文件。证据不足会声明。 |
| `wincode_find_code_symbol` | 符号检索，带 `source` / `queryComplete` / `uniqueTypeMatch` | Serena 可用时走上游，否则文本扫描。 |
| `wincode_find_references` | 引用/调用点列表，同样的诚实字段 | 0 命中不是“无影响”。 |
| `analyze_change_impact` | 爆炸半径与风险。别名：`wincode_analyze_change_impact` | 无法唯一解析或查询不完整时为 `UNKNOWN`。confidence 不由 source 决定。 |
| `wincode_diagnose_project` | Windows / SDK / git / Serena 状态，外加 `runtime` 快照 | `dotnet --version` ≠ 语义引用能力。 |
| `wincode_plan_refactoring` | 基于 impact 的检查清单 + trash 策略 | 不是自动重构引擎。 |
| `wincode_safe_move_to_trash` | 将工作区内相对路径移入 `trash/` 并写元数据 | 拒绝绝对路径 / `..` / 符号链接逃逸。 |
| `wincode_ui_inspect` | 基于 UIA 检查 Windows 桌面应用 UI。返回 `content[0]` 有界控件树 JSON 与可选 `content[1]` 截图（MCP image 内容块） | 通过 `pid` 或 `hwnd` 定位。截图 Base64 从文本 JSON 中剥离。`capture` 模式支持 `none`（默认）、`original`、`annotated`。 |

---

### 📂 项目架构分层

```
WinCode/
├── src/
│   ├── index.ts                      # MCP 服务启动入口 (stdio)
│   ├── Gateway/
│   │   ├── McpServer.ts              # MCP 服务端核心实现
│   │   └── Protocol.ts               # MCP 高层工具契约定义（含 wincode_ui_inspect）
│   ├── Core/
│   │   ├── Config.ts                 # 工作区、超时、缓存字节上限
│   │   ├── ResourceManager.ts        # 子进程 / 定时器 / 可重复 dispose
│   │   ├── SessionManager.ts         # 当前工作区会话与 cache namespace
│   │   ├── WorkspaceWatch.ts         # 去抖 fs.watch，用于丢掉过期指纹 memo
│   │   ├── Workspace.ts              # 项目检测与安全 trash
│   │   ├── Cache.ts                  # 按字节封顶的内存/磁盘缓存 + 指纹 memo
│   │   ├── DotNetGraph.ts            # sln/csproj ProjectReference 图
│   │   ├── Context.ts                # 预算内证据上下文
│   │   ├── ToolRouter.ts             # 调度、会话切换、runtime health
│   │   └── UiContracts.ts            # UI 取证类型、接口与 Schema 定义
│   ├── Adapters/
│   │   ├── IAdapter.ts               # 适配器契约 + 分层上游状态
│   │   ├── FlaUiAdapter.ts           # FlaUI UIA3 宿主适配器与进程生命周期管理
│   │   ├── RepomixAdapter.ts         # Repomix CLI 或闭集内置打包
│   │   └── SerenaAdapter.ts          # Serena MCP 客户端或正则降级
│   ├── CompositeTools/
│   │   ├── ArchitectureAnalyzer.ts   # 文件派生图 + 目录提示
│   │   ├── ImpactAnalyzer.ts         # 爆炸半径；不完整则为 UNKNOWN
│   │   ├── ProjectDiagnostics.ts     # SDK/git/Serena 状态（不夸大）
│   │   └── RefactorAssistant.ts      # 基于 impact 的清单 + trash 策略
│   └── Extensions/
│       └── ExtensionManager.ts       # 预留；尚无 Snoop/PerfView 插件
├── tools/
│   └── WinCode.UIA.Host/             # C# FlaUI.UIA3 进程外 UI 取证宿主 (.NET 10)
├── tests/
│   ├── fixtures/
│   │   ├── dotnet-mini/              # 可移植 MiniDesk .NET 夹具（3 个项目）
│   │   └── wpf-ui-review/            # 独立 WPF UI 评审自动化测试应用
│   ├── flaui-adapter.test.ts         # FlaUI 宿主适配器与生命周期单元测试
│   ├── ui-inspect-mcp.test.ts        # wincode_ui_inspect MCP 协议端到端测试
│   ├── tdd-suite.test.ts             # 默认 CI 套件（v0.4 契约 + e2e）
│   ├── v05-stability.test.ts         # 生命周期 / 缓存字节 / 超时
│   └── verify.ts                     # 冒烟验证
└── trash/                            # 安全回收站（.gitignore）
```

---

### 🚀 快速上手

#### 环境要求
- Windows 10/11
- Node.js >= 18.0.0
- .NET SDK（构建 `WinCode.UIA.Host` 及运行 WPF 自动化测试夹具需要 .NET SDK 10）

#### 1. 安装与编译构建
```bash
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm install
npm run build
# 发布 C# FlaUI.UIA3 宿主程序及 WPF 测试夹具
dotnet publish tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj -c Release -r win-x64 --no-self-contained
dotnet publish tests/fixtures/wpf-ui-review/wpf-ui-review.csproj -c Release -r win-x64 --no-self-contained
```

#### 2. 测试
```bash
npm run build
npm test
npx tsx --test tests/ui-inspect-mcp.test.ts
npm run test:verify
```

`npm test` 会运行 `package.json` 中的八个套件，包括 UI MCP 端到端、加固、源码关联及 v0.7.1 验收测试。端到端 MCP 用例会拉起 `dist/index.js`，所以要先 build。
`tests/ui-inspect-mcp.test.ts` 会拉起真实 WPF 测试夹具并执行 MCP UI 取证全链路端到端测试。

默认测试使用 `tests/fixtures/dotnet-mini`。若要可选跑本地真实解决方案：

```bash
set WINCODE_TAVERN_PATH=C:\path\to\your.sln-folder
npm test
```

#### 3. 接入 Agent 客户端 (Claude Desktop / Codex / Windsurf / Cursor 等)
在 MCP 客户端配置文件（如 `claude_desktop_config.json`）中注册：

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": [
        "C:/path/to/WinCode/dist/index.js",
        "--workspace",
        "C:/path/to/your/target-project"
      ]
    }
  }
}
```

---

## 💡 Acknowledgements / 致谢

This project is inspired by and builds upon the excellent work of:

- **[Serena](https://github.com/orai-tech/serena)** — for pioneering how AI coding agents benefit from semantic code intelligence, symbol-level navigation, and structured code interactions.
- **[Repomix](https://github.com/yamadashy/repomix)** — for setting the standard in repository context packaging and making extensive codebases accessible and token-efficient for AI agents.

WinCode builds upon these foundational concepts to deliver a unified, Windows-focused MCP gateway that integrates multi-faceted software engineering capabilities into a single, cohesive interface for AI coding agents.

> 本项目深受上述优秀开源项目的启发：
> - **Serena**：展示了代码语义理解、符号级代码导航以及智能化代码交互对 Coding Agent 的关键价值。
> - **Repomix**：展示了高效的代码库上下文打包方案，使大型项目在面对 AI Agent 时更加高效且节约 Token。
> 
> WinCode 继承并融合了这些优秀理念，致力于为 AI 开发者提供一套面向 Windows 深度定制、能力聚合的高阶 MCP 网关。

---

## 📄 License

本项目采用 [MIT License](LICENSE) 开源许可。
