# WinCode Skill 制作、安装与 MCP 配置指南

适用于本仓库 v0.8–v0.9 系列。以下以 Windows、Codex 和 `I:/WinCode` 为例；其他用户须替换为自己的仓库路径。客户端界面名称可能随版本变化。

## 1. Skill 与 MCP 各做什么

- **Skill**：指导 Agent 何时、怎样调用工具，按需读取操作手册。
- **MCP**：运行 WinCode，提供实际的代码分析、窗口发现和 UI 取证工具。

两者分别安装。复制 Skill 不会启动或注册 MCP；只有 MCP 也能调用工具，但没有本技能提供的操作指导。不需要把整个项目复制到技能目录，也不需要另建 HTTP 服务。

## 2. 制作一个低上下文开销的 Skill

本仓库已提供可直接使用的 [skills/wincode](skills/wincode/SKILL.md)：

```text
skills/wincode/
├── SKILL.md
└── references/
    ├── code.md          # 工作区、上下文、符号、影响分析
    ├── ui.md            # 窗口、后台截图、XAML 候选
    └── diagnostics.md   # 连接、健康状态、审计提醒
```

`SKILL.md` 的 YAML 头仅声明名称与简短用途，正文仅保留手册路由和共享边界。目前入口为 17 行、约 0.9 KB；文件字节数不等于 Token 数。

```yaml
---
name: wincode
description: 使用 WinCode MCP 分析 Windows/.NET 工作区，或读取桌面窗口、截图与 XAML 源码候选。
---
```

制作或维护原则：

1. 描述用于技能选择，保持精准，不写长功能清单。
2. 入口明确“仅读取当前任务对应手册”，不默认加载全部文件。
3. 每份手册只保留调用顺序、关键参数、必要示例和结果边界。
4. 不复制 README、完整工具 Schema、源码、更新记录或测试报告。
5. 参数变化时修改对应手册，再同步安装副本；公共规则只维护一处。
6. 不增加每次调用必做的健康探测、全仓扫描或截图。代码先取小片段，UI 无视觉需求用 `capture: "none"`。

按需加载取决于客户端和 Agent 的实际执行。Skill 不能消除 MCP Schema、工具结果和图片本身的上下文成本，也不保证固定 Token 消耗。

## 3. 准备 WinCode 程序

先安装项目要求的 Node.js（当前 README 标明 >=18），运行以下命令。UI 取证还需要 Windows x64 与 .NET 10 SDK；下面发布方式依赖本机相应 .NET 运行时。Serena/Repomix 的可选能力和前置条件见 [README](README.md)。

```powershell
Set-Location I:/WinCode
npm ci
npm run build

# 需要 Windows UI 取证时构建 Host
dotnet publish tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj -c Release -r win-x64 --no-self-contained
```

以上命令会安装锁定的 Node 依赖并恢复/构建 .NET 依赖。普通使用不需要构建 WPF 测试夹具。确认存在 `dist/index.js`；UI Host 发布产物位于 `tools/WinCode.UIA.Host/bin/Release/net10.0-windows/win-x64/publish/`。

## 4. 安装 Skill

Codex 本例使用当前用户的 `.agents/skills`。其他 Agent 请使用其支持的技能目录，不能假定所有客户端共用该路径。

首次安装，在 PowerShell 执行：

```powershell
$skillSource = 'I:/WinCode/skills/wincode'
$skillParent = Join-Path $env:USERPROFILE '.agents/skills'
$skillTarget = Join-Path $skillParent 'wincode'
if (Test-Path -LiteralPath $skillTarget) {
    throw '已存在 wincode 技能，请先比较并备份本地修改，再更新。'
}
New-Item -ItemType Directory -Path $skillParent -Force | Out-Null
Copy-Item -LiteralPath $skillSource -Destination $skillTarget -Recurse
```

最终入口必须是 `%USERPROFILE%/.agents/skills/wincode/SKILL.md`，不要多套一层 `wincode` 目录。

**路径适配**：当前 [诊断手册](skills/wincode/references/diagnostics.md) 使用 `I:/WinCode` 的本机示例；仓库放在其他位置时，同步替换安装副本中的启动路径和日志检测脚本路径。工作区示例路径也应按任务替换。

重新加载客户端或开启新会话，检查技能列表是否出现 `wincode`，再用 `$wincode` 显式调用。实际发现时机以客户端为准。更新技能时先比较安装副本，保留用户自定义内容；不要直接覆盖整个技能父目录。

## 5. 配置 MCP：图形界面与 CLI 二选一

### 方法 A：Codex 自定义 MCP 界面

打开自定义 MCP 添加页面，逐项填写：

| 字段 | 内容 |
|---|---|
| 名称 | `wincode` |
| 类型 | `STDIO` |
| 启动命令 | `node` |
| 参数 1 | `I:/WinCode/dist/index.js` |
| 参数 2 | `--workspace` |
| 参数 3 | `I:/WinCode` |
| 环境变量、环境变量传递 | 初次配置可留空 |

**每个参数独立一项**。不要把 `codex mcp add ...` 放进“启动命令”，它是注册命令，不是服务器程序。路径含空格时，独立参数字段填写完整路径，不额外输入引号字符。

若客户端找不到 `node`，在终端用 `(Get-Command node).Source` 查出可执行文件绝对路径，填入启动命令。保存并启用后，让客户端重新连接。

### 方法 B：Codex CLI

在终端执行，而不是填到上面的界面里：

```powershell
codex mcp add wincode -- node I:/WinCode/dist/index.js --workspace I:/WinCode
```

路径含空格时使用终端引号，例如 `"D:/My Projects/WinCode/dist/index.js"`。命令会修改 Codex MCP 配置；已有同名服务时先检查现有配置，不重复注册。该语法已通过本机 `codex mcp add --help` 核对。

配置中的 `--workspace` 是初始项目。分析另一个项目时调用 `workspace_open` 切换即可，不需要重新安装 Skill。不同客户端应分别配置，不要同时用两种方法重复添加同一服务。

## 6. 最小验收

1. 技能列表出现 `wincode`：只说明 Skill 已发现。
2. MCP 工具列表出现 `wincode_hello_world`、`wincode_ui_inspect` 等：说明工具已加载。
3. 让 Agent 调用 `wincode_hello_world({})`：检查返回状态；可用或 fallback 不等于 Serena 语义连接成功。
4. 用 `$wincode 打开某项目并查看依赖概览` 验证代码路径；使用自己的真实项目路径。
5. UI 验收另行指定目标窗口；未知 PID/HWND 时先限定进程枚举，再定向取证。不要为连通性测试读取所有窗口内容。

UI 后台截图应同时传真实 PID/HWND 和 `backgroundOnly: true`，不会主动激活或还原目标窗口。遮挡应用可能输出黑图或陈旧图，不能只凭返回成功断定截图正确。内置 Host 访问 UI 会显示 REC/WinCoding 标志并记录审计；不要绕过。

只修改文档时无需运行会影响前台的整套 GUI 测试。若使用 skill-creator 自带校验器，Windows 中文文件建议用 `python -X utf8 <校验器路径>/quick_validate.py <技能目录>`；普通用户安装技能不依赖该校验器。

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| Skill 可见，工具不可用 | 检查 MCP 是否配置、启用并重新连接；Skill 不提供执行后端。 |
| `node` 或 `dist/index.js` 找不到 | 检查绝对路径、Node 安装和 `npm run build` 结果。 |
| `HOST_UNAVAILABLE` | 检查 Host 发布产物、运行时或显式 Host 配置；重复安装 Skill 无效。 |
| `AUDIT_BUSY` | 等当前 Helper 完成；不要杀目标应用。 |
| 日志达到阈值 | 阅读工具返回的大小和路径提醒，按授权保留证据后清理，不静默删除。 |

审计目录为 `%LOCALAPPDATA%/WinCode/logs/ui-audit`，1 MiB 提醒、2 MiB 前预留结束空间并停止新访问。只读检测：

```powershell
pwsh -NoProfile -File I:/WinCode/scripts/check-ui-audit.ps1
```

明确需要桌面弹窗时加 `-Desktop`。检测脚本不删除文件；`test-tmp` 是测试输出目录，与正式审计目录不同。
