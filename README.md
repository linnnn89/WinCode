# WinCode

<p align="center">
  <strong>A Windows-first MCP gateway that provides AI coding agents unified access to code intelligence, repository understanding, desktop automation, and engineering tools.</strong>
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

Instead of forcing AI coding agents (such as Codex, Claude Code, etc.) to master dozens of low-level tools, WinCode exposes a curated set of **high-level, semantic, and reasoning-oriented MCP tools**. Agents connect to a single endpoint to gain repository understanding, symbol-level intelligence, change-impact analysis, and Windows-native developer tooling.

```
Coding Agent (Codex / Claude Code / etc.)
                    │
                    ▼  (Single MCP Endpoint)
┌────────────────────────────────────────────────────────┐
│               WinCode MCP Agent Gateway                │
├──────────────────┬──────────────────┬──────────────────┤
│ Code Intelligence│ Context Packing  │ Impact & Health  │
│  (via Serena)    │  (via Repomix)   │ (Composite Tools)│
└──────────────────┴──────────────────┴──────────────────┘
```

### 🏛️ Key Principles
1. **Upstream First**: External dependencies like **Serena** and **Repomix** are integrated through adapters without modifying upstream source code, featuring resilient built-in fallbacks.
2. **High-Level Semantics**: Prevents "information dumps" (e.g., streaming 50,000 lines of raw code). WinCode distills decisions, call graphs, and risk assessments.
3. **Windows First**: Tailored for Windows 10/11, .NET (WPF, WinUI, WinForms, MSBuild), with future extensibility for FlaUI, Snoop, and PerfView.
4. **Safe Workspace Policy**: Prohibits destructive file deletions. Obsolete files are safely moved to the project's `trash/` directory with complete audit metadata.
5. **Multi-Level Caching**: Uses fingerprinting and mtime hashing to minimize token consumption and avoid redundant project scans.

---

### 🛠️ High-Level MCP Tools

| Tool | Description | Value to Agent |
| :--- | :--- | :--- |
| `workspace_open` | Opens and analyzes a project directory (.NET sln, Node, Python, Git status, metadata, file tree). | Flagship entry point to open & switch target codebases. |
| `wincode_hello_world` | Minimal heartbeat & connectivity test tool. | Instant verification of MCP server health. |
| `wincode_analyze_workspace` | Analyzes project structure, .NET solutions, and architectural layers. | High-level overview without token flooding. |
| `wincode_prepare_context` | Generates goal-oriented, distilled code context for specific tasks. | Minimizes token usage, focuses agent attention. |
| `wincode_find_code_symbol` | Locates symbols (classes, interfaces, methods) with signatures. | Fast and precise symbol navigation. |
| `wincode_find_references` | Finds references and call sites across workspace files. | Accurate dependency and usage tracking. |
| `wincode_analyze_change_impact` | Evaluates blast radius, caller count, and risk levels (`LOW` to `CRITICAL`). | Prevents breaking changes before modifying code. |
| `wincode_diagnose_project` | Diagnoses .NET SDK, Windows toolchains, and project integrity. | Instant health check on developer prerequisites. |
| `wincode_plan_refactoring` | Formulates safe refactoring steps and migration boundaries. | Structured guidance for complex code refactors. |
| `wincode_safe_move_to_trash` | Safely archives files to `trash/` with metadata instead of hard deletion. | Prevents accidental data loss. |

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
│   │   ├── Config.ts                 # Workspace & adapter configuration
│   │   ├── Workspace.ts              # Project detection & safe trash policy
│   │   ├── Cache.ts                  # Multi-level memory & disk caching
│   │   ├── Context.ts                # Semantic context synthesis
│   │   └── ToolRouter.ts             # Central execution router
│   ├── Adapters/
│   │   ├── IAdapter.ts               # Base adapter contract
│   │   ├── RepomixAdapter.ts         # Repomix adapter with resilient fallback
│   │   └── SerenaAdapter.ts          # Serena adapter with built-in AST indexer
│   ├── CompositeTools/
│   │   ├── ArchitectureAnalyzer.ts   # Layer & entry-point analysis
│   │   ├── ImpactAnalyzer.ts         # Blast radius & risk calculation
│   │   ├── ProjectDiagnostics.ts     # Windows & .NET environment diagnostics
│   │   └── RefactorAssistant.ts      # Refactor roadmap & safe boundaries
│   └── Extensions/
│       └── ExtensionManager.ts       # Pluggable Windows desktop extensions
├── tests/
│   └── verify.ts                     # Automated end-to-end verification
└── trash/                            # Safe archive for deleted files (.gitignore)
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

#### 2. Run Verification
```bash
npx tsx tests/verify.ts
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

核心理念在于：**不要让 Agent 被动学习调用几十个低层散碎工具，而是提供少量、高语义、高可靠性的工程决策接口。** Agent 仅需连接一个 MCP 入口，即可一站式获得项目结构分析、代码语义理解、修改影响面评估以及 Windows 原生开发支撑能力。

```
Coding Agent (Codex / Claude Code / 等)
                    │
                    ▼  (统一高语义 MCP 入口)
┌────────────────────────────────────────────────────────┐
│               WinCode MCP Agent Gateway                │
├──────────────────┬──────────────────┬──────────────────┤
│  代码语义理解    │  工程上下文打包  │  影响面与健康度  │
│  (基于 Serena)   │  (基于 Repomix)  │ (Composite Tools)│
└──────────────────┴──────────────────┴──────────────────┘
```

### 🏛️ 核心架构原则
1. **不修改上游源码**：**Serena** 与 **Repomix** 作为外部适配器（Adapters）引入，并内置韧性降级引擎，外部依赖缺失时仍能平滑运行。
2. **高层能力优先**：拒绝向 Agent “倾倒”几万行无序的原始代码，转而输出决策级的关键 Symbol、引用链和风险评级。
3. **Windows 优先**：深度服务 Windows 10/11、.NET 生态（WPF、WinUI、WinForms、MSBuild），预留 FlaUI、Snoop、PerfView 插件扩展点。
4. **安全防误删机制**：代码层严格禁止硬删除文件，所有废弃文件自动归档至项目内的 `trash/` 目录并生成审计元数据。
5. **多级指纹缓存**：内置基于 Git Commit、文件指纹与 mtime 的多级缓存，避免 Agent 在长周期任务中重复扫描，极大节约 Token。

---

### 🛠️ 对外核心 MCP 工具

| 工具名称 | 功能描述 | 核心价值 |
| :--- | :--- | :--- |
| `workspace_open` | 打开并全面分析指定工程（识别 .NET sln、Node、Python、Git 状态、文件树与元数据） | 一号核心工具：动态切换与精准识别目标代码库。 |
| `wincode_hello_world` | 极简心跳与连通性验证工具 | 即刻验证 MCP 服务端运行状态与可用能力。 |
| `wincode_analyze_workspace` | 工作区与架构分层识别 | 快速提取项目结构、.NET 方案分层与核心入口点。 |
| `wincode_prepare_context` | 针对特定任务精炼语义上下文 | 提炼目标符号与强相关代码，极大降低 Token 消耗。 |
| `wincode_find_code_symbol` | 全局代码符号（Symbol）检索 | 精确索引类、接口、方法签名及对应代码行。 |
| `wincode_find_references` | 跨文件符号引用与调用链路追踪 | 精确定位符号在整个代码库中的所有被调用位置。 |
| `wincode_analyze_change_impact` | 代码变更影响度与风险评估 | 计算调用密集度与爆炸半径，评定风险等级（`LOW` ~ `CRITICAL`）。 |
| `wincode_diagnose_project` | Windows / .NET 工程环境健康诊断 | 检查 Windows 原生环境、.NET SDK 与配置完整性。 |
| `wincode_plan_refactoring` | 组件重构方案生成与安全边界规划 | 给出渐进式重构路径与防破坏约束建议。 |
| `wincode_safe_move_to_trash` | 安全文件移动至 `trash/` 目录 | 规范化移入项目回收站并附加元数据，防止误删。 |

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
│   │   ├── Config.ts                 # 工作区配置与默认设置
│   │   ├── Workspace.ts              # 工作区检测与安全 trash 机制
│   │   ├── Cache.ts                  # 多级内存/磁盘缓存管理器
│   │   ├── Context.ts                # Agent 语义上下文提炼引擎
│   │   └── ToolRouter.ts             # 模块调度中枢
│   ├── Adapters/
│   │   ├── IAdapter.ts               # 适配器基础契约与健康检查
│   │   ├── RepomixAdapter.ts         # Repomix 上下文打包（支持内置降级引擎）
│   │   └── SerenaAdapter.ts          # Serena 语义与引用追踪（支持内置多语言解析器）
│   ├── CompositeTools/
│   │   ├── ArchitectureAnalyzer.ts   # 架构分层与工程定位分析
│   │   ├── ImpactAnalyzer.ts         # 修改爆炸半径与风险等级分析
│   │   ├── ProjectDiagnostics.ts     # Windows/.NET 与运行环境健康诊断
│   │   └── RefactorAssistant.ts      # 重构边界评估与操作规划
│   └── Extensions/
│       └── ExtensionManager.ts       # Pluggable Windows 桌面扩展管理器
├── tests/
│   └── verify.ts                     # 端到端自动化验证套件
└── trash/                            # 安全回收站（.gitignore 忽略）
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

#### 2. 执行端到端测试验证
```bash
npx tsx tests/verify.ts
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