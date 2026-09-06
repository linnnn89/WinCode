# WinCode

<p align="center">
  <strong>A Windows-first MCP gateway that gives coding agents a small set of high-level tools: workspace graph, evidence-bounded context, and change-impact reports that stay honest when analysis is incomplete.</strong>
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

Instead of forcing AI coding agents (such as Codex, Claude Code, etc.) to master dozens of low-level tools, WinCode exposes a curated set of **high-level MCP tools**. Agents connect to one endpoint for workspace graphs, file-backed context, and change-impact reports. Serena and Repomix are optional upstreams; when they are missing or incomplete, WinCode keeps running and **labels the gap**. v0.5 keeps that contract and makes the gateway safe to leave running: one owner for child processes, workspace sessions, byte-capped cache, and bounded timeouts.

```
Coding Agent (Codex / Claude Code / Cursor / Windsurf)
                    │
                    ▼  (Single High-Level MCP Gateway)
┌────────────────────────────────────────────────────────────────────────┐
│                       WinCode MCP Agent Gateway                        │
├───────────────────────────────────┬────────────────────────────────────┤
│         🟢 Current (v0.5)         │         🟡 Planned (not started)   │
├─────────────────┬─────────────────┼──────────────────┬─────────────────┤
│ .NET sln/csproj │ Evidence-bounded│Desktop Automation│ Diagnostics &   │
│ graph + impact  │ context + health│   (FlaUI)        │ Performance     │
│ + process/session│ + byte-capped  │                  │ (Snoop/PerfView)│
│ lifecycle        │ cache/timeouts │                  │                 │
└─────────────────┴─────────────────┴──────────────────┴─────────────────┘
```

### 🏛️ Key Principles
1. **Upstream First**: **Serena** and **Repomix** are optional adapters. A found `serena` binary is not a connection. Handshake, project activation, and a successful semantic query are reported separately.
2. **Evidence over summaries**: Default context is file snippets with path/symbol/line, inside a token budget. Missing evidence is declared; the server will not dump the whole repo or invent architecture advice.
3. **Windows First**: Reads real `.sln` / `.csproj` graphs (ProjectReference, WPF/WinUI/WinForms, entry points). `dotnet` on PATH is not semantic analysis. Extra Roslyn integration is **not** committed.
4. **Safe Workspace Policy**: No hard deletes. Obsolete files move to `trash/` with audit metadata. Only relative in-workspace paths are accepted.
5. **Caching**: Fingerprints (git HEAD / dirty mtime) avoid repeat scans. Incomplete Serena queries are not cached. Memory/disk caches have **byte** caps, not only entry counts. Consecutive tool calls reuse a few-second fingerprint memo; workspace switch changes the cache namespace.
6. **Source ≠ confidence**: `source` is the provider. Confidence for impact analysis requires unique resolution and a complete query. Zero references, ambiguity, or incomplete queries return `UNKNOWN` — never "safe to delete". Local regex fallback does not guarantee symbol identity, overloads, or complete cross-file references.
7. **Long-running hygiene**: Every child process, timer, and MCP transport has an owner (`ResourceManager`). `SIGINT`/`SIGTERM` run an idempotent graceful shutdown. Adapter timeouts become structured `{ status: failed, reason: timeout, recoverable: true }` results — they do not crash the gateway.

---

### 🗺️ Roadmap

#### v0.1–v0.3 (Delivered)
- [x] MCP `stdio` server, `workspace_open`, safe `trash/` policy, fingerprint cache.
- [x] Serena MCP adapter **when handshake succeeds**; otherwise labeled text fallback (not an AST/Roslyn engine).
- [x] Repomix CLI packing **when installed**; otherwise a capped builtin file packer (not Tree-sitter compression unless the CLI `--compress` path runs).
- [x] `analyze_change_impact` with risk levels; `wincode_plan_refactoring` is a checklist on top of impact, not an automated refactorer.

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

#### Later (not in v0.5)
- [ ] FlaUI / Snoop / PerfView.
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

---

### 📂 Architecture Overview

```
WinCode/
├── src/
│   ├── index.ts                      # MCP CLI Entrypoint (stdio)
│   ├── Gateway/
│   │   ├── McpServer.ts              # MCP Server instance & handlers
│   │   └── Protocol.ts               # MCP Tool schemas & contract
│   ├── Core/
│   │   ├── Config.ts                 # Workspace, timeouts, cache byte limits
│   │   ├── ResourceManager.ts        # Child processes / timers / idempotent dispose
│   │   ├── SessionManager.ts         # Active workspace session + cache namespace
│   │   ├── Workspace.ts              # Project detection & safe trash policy
│   │   ├── Cache.ts                  # Byte-capped memory/disk cache + fingerprint memo
│   │   ├── DotNetGraph.ts            # sln/csproj ProjectReference graph
│   │   ├── Context.ts                # Evidence-bounded context (budget + snippets)
│   │   └── ToolRouter.ts             # Router, session switch, runtime health
│   ├── Adapters/
│   │   ├── IAdapter.ts               # Adapter contract + layered upstream status
│   │   ├── RepomixAdapter.ts         # Repomix CLI or closed-set builtin packer
│   │   └── SerenaAdapter.ts          # Serena MCP client or regex fallback
│   ├── CompositeTools/
│   │   ├── ArchitectureAnalyzer.ts   # File-derived graph + directory hints
│   │   ├── ImpactAnalyzer.ts         # Blast radius; UNKNOWN when incomplete
│   │   ├── ProjectDiagnostics.ts     # SDK/git/Serena status (no overclaim)
│   │   └── RefactorAssistant.ts      # Impact-based checklist + trash policy
│   └── Extensions/
│       └── ExtensionManager.ts       # Reserved; no FlaUI/Snoop plugins yet
├── tests/
│   ├── fixtures/dotnet-mini/         # Portable MiniDesk .NET fixture (3 projects)
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
- .NET SDK (recommended for C#/.NET projects)

#### 1. Installation & Build
```bash
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm install
npm run build
```

#### 2. Tests
```bash
npm run build
npm test
npm run test:verify
```

`npm test` runs the v0.4 contract suite and `tests/v05-stability.test.ts`. End-to-end MCP cases spawn `dist/index.js`, so build first.

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
        "D:/CODEX PROJECT/WinCode MCP/dist/index.js",
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

核心理念：**不要让 Agent 学习几十个低层工具，而是给少量高语义接口。** 当前 v0.5 在 v0.4 可证伪查询链之上，把网关做成可长期驻留的进程：统一资源释放、工作区会话、按字节封顶的缓存、外部调用超时。Serena / Repomix 是可选上游；缺失或不完整时继续运行，并**标明缺口**，而不是写成“已连接”。

```
Coding Agent (Codex / Claude Code / Cursor / Windsurf 等)
                    │
                    ▼  (统一 MCP 网关入口)
┌────────────────────────────────────────────────────────────────────────┐
│                       WinCode MCP Agent Gateway                        │
├───────────────────────────────────┬────────────────────────────────────┤
│         🟢 Current (v0.5)         │         🟡 规划（尚未开工）        │
├─────────────────┬─────────────────┼──────────────────┬─────────────────┤
│ .NET sln/csproj │ 预算内证据上下文 │  Windows 自动化  │ 深度诊断与调优  │
│ 图 + 影响面     │ + 分层健康状态  │   (FlaUI)        │(Snoop/PerfView) │
│ + 进程/会话生命周期 │ + 字节上限缓存 │                  │                 │
└─────────────────┴─────────────────┴──────────────────┴─────────────────┘
```

### 🏛️ 核心架构原则
1. **不修改上游源码**：**Serena** 与 **Repomix** 走适配器。命令在 PATH 上 ≠ 已握手。命令存在、握手成功、项目激活、语义查询可用必须分开报告。
2. **证据优先于摘要**：默认返回带路径/符号/行号的片段，受 token 预算约束。证据不足就声明不足；禁止无相关文件时倾倒整个仓库，也不编造架构结论。
3. **Windows 优先**：从真实 `.sln` / `.csproj` 生成项目依赖和入口。`dotnet` 在 PATH 上 ≠ 具备语义引用能力。额外 Roslyn 集成本里程碑**未承诺**。
4. **安全防误删**：禁止硬删除，归档到 `trash/` 并写审计元数据；只接受工作区内相对路径。
5. **指纹缓存**：基于 git HEAD / dirty mtime。不完整的 Serena 查询不入库。内存/磁盘缓存有**字节**上限，不只是条数。连续工具调用复用数秒级指纹 memo；切换工作区会更换 cache namespace。
6. **source 不能决定 confidence**：`source` 只说明供应方。影响分析的可信度看目标是否唯一解析、查询是否完整。0 引用、同名歧义、查询不完整必须返回 `UNKNOWN`，不得写成可安全删除。本地正则降级不保证符号身份、重载区分或跨文件引用完整性。
7. **长期驻留卫生**：子进程、定时器、MCP transport 都有明确 owner（`ResourceManager`）。`SIGINT`/`SIGTERM` 做可重复的 graceful shutdown。适配器超时变成结构化 `{ status: failed, reason: timeout, recoverable: true }`，不得把网关打崩。

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

#### 之后（不在 v0.5）
- [ ] FlaUI / Snoop / PerfView。
- [ ] 额外 Roslyn 宿主（须先在真实 C# 仓库上量 Serena 缺口）。
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

---

### 📂 项目架构分层

```
WinCode/
├── src/
│   ├── index.ts                      # MCP 服务启动入口 (stdio)
│   ├── Gateway/
│   │   ├── McpServer.ts              # MCP 服务端核心实现
│   │   └── Protocol.ts               # MCP 高层工具契约定义
│   ├── Core/
│   │   ├── Config.ts                 # 工作区、超时、缓存字节上限
│   │   ├── ResourceManager.ts        # 子进程 / 定时器 / 可重复 dispose
│   │   ├── SessionManager.ts         # 当前工作区会话与 cache namespace
│   │   ├── Workspace.ts              # 工作区检测与安全 trash
│   │   ├── Cache.ts                  # 按字节封顶的内存/磁盘缓存 + 指纹 memo
│   │   ├── DotNetGraph.ts            # sln/csproj ProjectReference 图
│   │   ├── Context.ts                # 预算内证据上下文
│   │   └── ToolRouter.ts             # 调度、会话切换、runtime health
│   ├── Adapters/
│   │   ├── IAdapter.ts               # 适配器契约 + 分层上游状态
│   │   ├── RepomixAdapter.ts         # Repomix CLI 或闭集内置打包
│   │   └── SerenaAdapter.ts          # Serena MCP 客户端或正则降级
│   ├── CompositeTools/
│   │   ├── ArchitectureAnalyzer.ts   # 文件派生图 + 目录提示
│   │   ├── ImpactAnalyzer.ts         # 爆炸半径；不完整则为 UNKNOWN
│   │   ├── ProjectDiagnostics.ts     # SDK/git/Serena 状态（不夸大）
│   │   └── RefactorAssistant.ts      # 基于 impact 的清单 + trash 策略
│   └── Extensions/
│       └── ExtensionManager.ts       # 预留；尚无 FlaUI/Snoop 插件
├── tests/
│   ├── fixtures/dotnet-mini/         # 可移植 MiniDesk .NET 夹具（3 个项目）
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
- .NET SDK（推荐，用于 C#/.NET 解决方案）

#### 1. 安装与编译构建
```bash
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm install
npm run build
```

#### 2. 测试
```bash
npm run build
npm test
npm run test:verify
```

`npm test` 会跑 v0.4 契约套件和 `tests/v05-stability.test.ts`。端到端 MCP 用例会拉起 `dist/index.js`，所以要先 build。

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
        "D:/CODEX PROJECT/WinCode MCP/dist/index.js",
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