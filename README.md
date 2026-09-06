# WinCode Agent Gateway

> Windows-First MCP Gateway for Coding Agents (Codex, Claude Code, etc.)

WinCode 不是简单转发几十个底层工具，而是作为 **Windows 优先的 Agent 高级开发能力网关**。通过整合 **Serena**（代码语义分析）与 **Repomix**（上下文打包），对外提供少量、高语义、面向 Agent 推理的高阶工具。

---

## 核心架构原则

1. **不修改上游源码**：Serena 与 Repomix 作为外部能力适配器（Adapters），WinCode 提供高可用回退保证。
2. **高层能力优先**：对外屏蔽底层细粒度工具，只暴露面向推理的决策级接口。
3. **Windows 优先**：深度适配 Windows 10/11、.NET 生态（WPF、WinUI、WinForms、MSBuild），预留 FlaUI、Snoop、PerfView 插件扩展点。
4. **安全与防误删**：严格遵守安全工作区规范，禁止物理硬删除任何文件；所有文件删除均自动归档至项目内 `trash/` 目录并记录审计元数据。
5. **多级缓存加速**：内置基于指纹、mtime 与哈希的高性能缓存，避免 Agent 重复分析项目。

---

## 项目结构

```
WinCode MCP/
├── src/
│   ├── index.ts                      # MCP CLI 启动入口 (stdio 传输)
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
├── trash/                            # 安全回收站（.gitignore 忽略）
└── package.json
```

---

## 对外暴露的 MCP 工具列表

| 工具名称 | 作用说明 | 核心价值 |
|---|---|---|
| `wincode_analyze_workspace` | 工作区与架构分层分析 | 自动识别 .NET 解决方案、项目分层、入口点与工程类型 |
| `wincode_prepare_context` | 为具体任务提取精准语义上下文 | 避免倾倒大量无效文件，提炼目标 Symbol 与关键代码段 |
| `wincode_find_code_symbol` | 全局代码 Symbol 查询 | 快速定位 Class、Interface、Method、Function 签名及位置 |
| `wincode_find_references` | Symbol 引用与调用链追踪 | 查找指定符号的所有调用处与分布文件 |
| `wincode_analyze_change_impact` | 代码变更影响度与风险评估 | 计算爆炸半径、引用文件数，评定 LOW/MEDIUM/HIGH/CRITICAL 风险 |
| `wincode_diagnose_project` | Windows / .NET 工程环境诊断 | 检查 Windows 特性支持、.NET SDK 版本、Git 状态与项目健康 |
| `wincode_plan_refactoring` | 组件重构助手与安全边界规划 | 提供渐进式重构步骤与安全隔离指引 |
| `wincode_safe_move_to_trash` | 安全文件移动至 trash/ 目录 | 规范化文件移入回收站并自动附带 metadata 审计文件 |

---

## 快速开始

### 1. 安装依赖与构建

```bash
npm install
npm run build
```

### 2. 运行端到端自动化验证

```bash
npx tsx tests/verify.ts
```

### 3. 作为 MCP Server 接入 Agent (例如 Claude Desktop / Codex)

在 Agent 的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": ["d:/CODEX PROJECT/WinCode MCP/dist/index.js", "--workspace", "<你的目标工程路径>"]
    }
  }
}
```
