# WinCode

<p align="center">
  <strong>Project structure, running windows, and source evidence for coding agents.</strong><br>
  让 Coding Agent 同时看到项目结构、运行中的窗口与源码证据。
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#简体中文">简体中文</a><br>
  <img src="https://img.shields.io/badge/Platform-Windows%20x64-0078D6" alt="Windows x64">
  <img src="https://img.shields.io/badge/MCP-stdio-black" alt="MCP stdio">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="MIT license"></a>
</p>

## English

WinCode is a local MCP server for Windows and .NET development. It combines project analysis with runtime UI inspection so coding agents can investigate problems using source files, control properties, and screenshots together.

- **Understand the project:** inspect declared project references, locate symbols, and prepare task context within an output budget.
- **Inspect the running app:** discover windows, query a control or subtree, and request a numbered screenshot without activating the target.
- **Review with evidence:** retrieve XAML declaration candidates with paths, lines, and hashes; distinguish ambiguity, truncation, and degraded analysis.

Current source version: **0.9.0**. UI tools are read-only; the separate trash tool moves files. See [CHANGELOG](CHANGELOG.md) for version history.

### Quick start

Requirements: Git and Node.js 18 or newer (local validation used Node.js 24). UI inspection requires Windows x64. Building the UI helper requires the .NET 10 SDK; the framework-dependent helper requires the corresponding .NET runtime where it runs.

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run build

# Build the Windows UI helper
dotnet publish tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj -c Release -r win-x64 --no-self-contained
```

Add a stdio MCP server to your client. For clients accepting `mcpServers` JSON:

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

> **Paths:** `~` is a placeholder for your installation location in these examples. Replace `~/WinCode` with the absolute path to your WinCode installation, such as `I:/WinCode`, and `~/target-project` with your target project's absolute path. Do not copy `~` literally; MCP clients may not expand it automatically.

For a settings form, use:

| Field | Value |
| --- | --- |
| Name / type | `wincode` / `stdio` |
| Command | `node` |
| Argument 1 | `~/WinCode/dist/index.js` |
| Argument 2 | `--workspace` |
| Argument 3 | `~/target-project` |

Replace the paths before saving. Add each argument separately; a CLI registration command does not belong in the command field. Ensure the client can find `node`, or supply its absolute executable path.

The optional [Skill and MCP setup guide](WinCode-Skill制作与MCP配置指南.md) explains installation and task-specific manuals. A Skill provides usage instructions; it does not replace the MCP server connection.

### Try a focused UI inspection

Ask your agent: **“Find my app's window, inspect its Save button without changing focus, and check the declaration in `Views/MainWindow.xaml`.”**

1. Call `wincode_ui_list_windows` with a process or title filter.
2. Use the returned PID and HWND in `wincode_ui_inspect`:

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

3. Request `capture: "annotated"` when an image helps. Use `wincode_ui_review` with `candidateFiles: ["Views/MainWindow.xaml"]` to add source candidates.

Replace the example PID, HWND, control ID, and XAML path with values from your app. Query filters are exact, case-sensitive AND conditions. Only a complete, unique search expands the matching subtree; ambiguous or incomplete searches return candidates. Node IDs belong to one response. Screenshots still cover the target window, with badges on the returned subtree.

`capture: "none"` avoids image input, but JSON still consumes context tokens. Images are separate MCP image blocks, not Base64 embedded in text. `readStates` reads toggle, selection, and expand/collapse states; it does not read input values or execute actions. Unsupported or unreadable states are not reported as false.

### Tools

| Tool | Purpose |
| --- | --- |
| `workspace_open` | Open or switch the analyzed workspace. |
| `wincode_analyze_workspace` | Summarize structure and declared .NET project references. |
| `wincode_prepare_context` | Prepare task-related code context within a requested budget. |
| `wincode_find_code_symbol` | Locate symbols with evidence and completeness metadata. |
| `wincode_find_references` | Find references, including warnings about incomplete coverage. |
| `analyze_change_impact` | Assess change impact; retain UNKNOWN when evidence is insufficient. |
| `wincode_plan_refactoring` | Prepare a refactoring checklist based on impact analysis. |
| `wincode_safe_move_to_trash` | Move workspace files into `trash/` with metadata and path checks. |
| `wincode_ui_list_windows` | Discover visible top-level windows with bounded filters. |
| `wincode_ui_inspect` | Return a control tree, optional states, and an optional screenshot. |
| `wincode_ui_review` | Combine runtime inspection with explicit XAML source candidates. |
| `wincode_hello_world` | Report gateway, cache, and adapter health. |
| `wincode_diagnose_project` | Check project tooling and environment availability. |

`wincode_analyze_change_impact` is an alias of `analyze_change_impact`. Parameter details and workflows: [code](skills/wincode/references/code.md), [UI](skills/wincode/references/ui.md), [diagnostics](skills/wincode/references/diagnostics.md).

### Architecture and resource control

```text
Coding agent ── stdio MCP ── WinCode
                              ├─ Code adapters: Serena / Repomix / local fallbacks
                              ├─ Workspace analysis, context, and impact tools
                              └─ FlaUiAdapter ── stdin/stdout JSON ── .NET UIA helper
                                                                       └─ Window tree + screenshot
```

UI inspection and health probes share a serial lock. Cancellation propagates through request admission and the adapter; cleanup targets the owned helper process tree, not the inspected application's PID. Workspace switching waits for active requests and rejects a switch if draining times out. These controls reduce lifecycle races; they do not guarantee that arbitrary target applications cannot fail.

Code caches use workspace namespaces, estimated serialized memory size, and disk pruning including referenced overflow files. Defaults are 32 MiB for memory accounting and 128 MiB for disk pruning. Watch events are debounced (150 ms by default), and fingerprints are memoized for about 2.5 seconds; invalidation is not instantaneous. There is no persistent UI snapshot cache.

| UI budget | Limit / behavior |
| --- | --- |
| Query search | 1,000 nodes by default, at most 5,000; 10 candidates by default, at most 20. |
| Search traversal | 2-second and 50-level soft limits; the helper deadline covers blocking native calls. |
| Tree text | 128 KiB, with truncation metadata. |
| PNG | 2 MiB; bounded downscaling, then omission if still too large. |
| Helper transport | 6 MiB, counted as bytes. |
| Screenshot allocation | At most 16,777,216 pixels and 16,384 pixels on either side. |

These are scoped budgets, not a total process memory or token cap. `helperPeakWorkingSetBytes` reports the OS peak working set through response preparation, excluding subsequent final serialization. `treeComplete` describes structural/output coverage; `propertyIssues` separately identifies unavailable or clipped fields. Query and state features require helper `inspectionVersion: 2`; rebuild the helper if an older version is rejected.

### Boundaries and visibility

- **Background capture:** `backgroundOnly: true` requires both PID and HWND and uses PrintWindow without activating or restoring the target or falling back to the visible screen. Some renderers may return blank or stale images; minimized windows are rejected. Normal capture may use screen-based fallbacks.
- **UI coverage:** results depend on the app's UIA provider and access permissions. WPF has an isolated test fixture; this does not establish equal coverage for every WinUI, WinForms, or custom-rendered app. DPI-aware capture is implemented, but comprehensive multi-DPI and 4K validation remains outstanding.
- **Source evidence:** XAML matching uses literal declarations in supplied files. It does not evaluate bindings, templates, or resources, and returns `runtimeSourceVerified: false`. Candidates support investigation; they are not a proven runtime-to-source mapping.
- **Project analysis:** project references are extracted from file declarations, not evaluated by MSBuild. Conditions, imports, and unsupported declaration layouts may be missed. Serena and Repomix are optional; local fallbacks report their reduced coverage.
- **Visible notice:** the built-in helper displays a semi-transparent `REC / WinCoding` indicator during UI access. Other overlays or exclusive fullscreen can obscure it; it is not an operating-system security boundary.
- **Local audit:** metadata-only start/end records go to `%LOCALAPPDATA%/WinCode/logs/ui-audit`. At 1 MiB, results suggest cleanup; near 2 MiB, new access is blocked with space reserved for the end record. Nothing is automatically deleted. Logs are not tamper-proof; a start without an end leaves the outcome unknown. The [audit checker](scripts/check-ui-audit.ps1) supports explicit inspection and an optional desktop notice.

### Development and validation

```powershell
npm run build
npm run typecheck
npm test                  # Noninteractive regression

# Publish the isolated WPF fixture before live UI tests
dotnet publish tests/fixtures/wpf-ui-review/wpf-ui-review.csproj -c Release -r win-x64 --no-self-contained
npm run test:ui           # Existing interactive UI suites
npm run test:ui-query     # Separate local-query acceptance with a disposable fixture
npm run test:all          # npm test + test:ui; does not include test:ui-query
```

Live UI tests require an interactive Windows session and may display test windows. In the isolated 222-node fixture, focused output fell from 62,025 to about 1,600 text bytes, while calls remained around 0.78 seconds. This is an output-size observation, not a general speed or token-saving benchmark. Test evidence and unverified cases are recorded in the [work log](docs/codex_worklog.md).

---

## 简体中文

WinCode 是面向 Windows 与 .NET 开发的本地 MCP 服务。它将项目分析与运行时 UI 取证放在同一套工具中，让 Coding Agent 结合源码、控件属性和截图调查问题。

- **理解项目：**读取项目引用声明、定位符号，在输出预算内准备任务上下文。
- **观察实际界面：**发现窗口、查询控件或局部子树，按需获取数字标注截图，无需激活目标窗口。
- **用证据辅助审查：**返回带路径、行号、哈希的 XAML 声明候选，明确报告歧义、截断与降级。

当前源码版本为 **0.9.0**。UI 工具只读；独立的回收站工具会移动文件。版本历史见 [CHANGELOG](CHANGELOG.md)。

### 快速上手

需要 Git、Node.js 18 或更新版本（本地验证使用 Node.js 24）；UI 取证需要 Windows x64。编译 UI Helper 需要 .NET 10 SDK。以下发布方式不自带运行时，运行机器需要对应的 .NET Runtime。

```powershell
git clone https://github.com/linnnn89/WinCode.git
cd WinCode
npm ci
npm run build

# 编译 Windows UI Helper
dotnet publish tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj -c Release -r win-x64 --no-self-contained
```

在客户端添加 stdio MCP 服务。支持 `mcpServers` JSON 的客户端可以参考：

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

> **路径说明：**这里的 `~` 仅作为安装位置的占位符。请将 `~/WinCode` 替换为你实际安装 WinCode 的绝对路径，例如 `I:/WinCode`；将 `~/target-project` 替换为待分析项目的绝对路径。不要直接照抄 `~`，MCP 客户端不一定会自动展开它。

如果通过设置界面添加：

| 字段 | 填写内容 |
| --- | --- |
| 名称 / 类型 | `wincode` / `stdio` |
| 启动命令 | `node` |
| 参数 1 | `~/WinCode/dist/index.js` |
| 参数 2 | `--workspace` |
| 参数 3 | `~/target-project` |

保存前替换路径，每个参数独立添加；不要把 CLI 注册命令填进“启动命令”。客户端需要能够找到 `node`，否则填写它的可执行文件绝对路径。

可选的 [Skill 与 MCP 配置指南](WinCode-Skill制作与MCP配置指南.md) 介绍安装与分功能手册。Skill 提供使用说明，MCP 连接提供实际执行能力，两者需要分别配置。

### 试一次局部 UI 取证

可以直接告诉 Agent：**“找到我的应用窗口，不切换前台，查看保存按钮，并核对 `Views/MainWindow.xaml` 中的声明。”**

1. 调用 `wincode_ui_list_windows`，按进程或窗口标题筛选。
2. 将返回的 PID、HWND 填入 `wincode_ui_inspect`：

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

3. 需要图片时改用 `capture: "annotated"`；需要源码证据时调用 `wincode_ui_review`，追加 `candidateFiles: ["Views/MainWindow.xaml"]`。

示例 PID、HWND、控件 ID 和 XAML 路径都需要替换为实际值。query 条件是区分大小写的精确 AND 匹配；完整且唯一命中才展开子树，歧义或搜索未完成时返回候选。节点 ID 仅属于当前响应。截图仍覆盖整个目标窗口，数字标注对应返回的局部子树。

`capture: "none"` 避免图片输入，但 JSON 仍占用上下文 Token。图片通过独立 MCP image 块传递，不将 Base64 塞进文本块。`readStates` 仅读取勾选、选中与展开/折叠状态，不读取输入框值、不执行操作；不支持或读取失败不会被当成 false。

### 工具一览

| 工具 | 用途 |
| --- | --- |
| `workspace_open` | 打开或切换待分析工作区。 |
| `wincode_analyze_workspace` | 汇总工程结构与 .NET 项目引用声明。 |
| `wincode_prepare_context` | 在指定预算内准备任务相关代码上下文。 |
| `wincode_find_code_symbol` | 定位符号，附带证据来源与完整性信息。 |
| `wincode_find_references` | 查找引用并提示覆盖不足。 |
| `analyze_change_impact` | 评估改动影响，证据不足时保留 UNKNOWN。 |
| `wincode_plan_refactoring` | 根据影响分析准备重构检查清单。 |
| `wincode_safe_move_to_trash` | 校验路径后将工作区文件移入带元数据的 trash/。 |
| `wincode_ui_list_windows` | 有界枚举并筛选可见顶层窗口。 |
| `wincode_ui_inspect` | 返回控件树、可选状态与可选截图。 |
| `wincode_ui_review` | 组合运行时取证与指定 XAML 文件的声明候选。 |
| `wincode_hello_world` | 查看网关、缓存与适配器健康状态。 |
| `wincode_diagnose_project` | 检查项目工具链及环境可用性。 |

`wincode_analyze_change_impact` 是 `analyze_change_impact` 的别名。参数与工作流程见分功能手册：[代码分析](skills/wincode/references/code.md)、[UI 取证](skills/wincode/references/ui.md)、[诊断](skills/wincode/references/diagnostics.md)。

### 架构与资源控制

```text
Coding Agent ── stdio MCP ── WinCode
                               ├─ 代码适配器：Serena / Repomix / 本地降级
                               ├─ 工作区分析、上下文与影响分析工具
                               └─ FlaUiAdapter ── stdin/stdout JSON ── .NET UIA Helper
                                                                        └─ 控件树 + 截图
```

UI 取证与健康探测共用串行锁；取消信号贯穿请求准入和适配器。清理只针对自身持有的 Helper 进程树，不以目标应用 PID 为清理对象。切换工作区前等待在途请求，排空超时则拒绝切换。这些措施用于降低生命周期竞态，不代表任意目标应用绝不会异常。

代码缓存按工作区区分命名空间，按序列化大小估算内存，磁盘清理同时计算被引用的 overflow 文件。默认内存计量预算 32 MiB、磁盘清理预算 128 MiB。文件监听默认去抖 150 ms，指纹约缓存 2.5 秒，并非即时失效。UI 快照不跨请求缓存。

| UI 预算 | 限制与行为 |
| --- | --- |
| 局部搜索 | 默认扫描 1,000 节点、最多 5,000；默认 10 个候选、最多 20。 |
| 搜索遍历 | 2 秒、50 层软限制；阻塞原生调用由整个 Helper 截止时间兜底。 |
| 控件树文本 | 128 KiB，附带截断信息。 |
| PNG | 2 MiB；有限缩小后仍超限则省略图片。 |
| Helper 传输 | 6 MiB，按真实字节计量。 |
| 截图分配 | 总像素最多 16,777,216，任一边最多 16,384 像素。 |

这些是具体环节的预算，不是整个进程的内存或 Token 硬上限。`helperPeakWorkingSetBytes` 记录响应准备阶段的系统峰值工作集，不包含随后最终序列化。`treeComplete` 描述结构与输出覆盖，`propertyIssues` 单独说明属性不可用或被裁剪。查询与状态功能要求 Helper `inspectionVersion: 2`，旧版被拒绝时需重新编译 Helper。

### 能力边界与可见提示

- **后台截图：**`backgroundOnly: true` 要求同时指定 PID 与 HWND，只使用 PrintWindow，不激活、不恢复窗口，也不回退到屏幕截图。部分渲染器可能返回空白或旧画面；最小化窗口会被拒绝。普通截图模式可能回退到屏幕采集。
- **UI 覆盖：**结果取决于应用的 UIA Provider 与访问权限。已有独立 WPF 夹具，不代表所有 WinUI、WinForms 或自绘应用都具有相同覆盖。已实现 DPI 感知，但完整的多 DPI、4K 验证仍待补充。
- **源码证据：**在指定 XAML 文件中匹配字面量声明，不求值 Binding、模板或资源，并返回 `runtimeSourceVerified: false`。候选用于辅助核对，不等于已证明运行时控件对应某行源码。
- **工程分析：**从项目文件声明提取引用，不执行 MSBuild 求值；条件、导入和未支持的声明排列可能漏识别。Serena、Repomix 为可选上游，本地降级会报告覆盖不足。
- **可见提示：**内置 Helper 在 UI 访问期间显示半透明 `REC / WinCoding` 标志。更高层浮窗或独占全屏可能遮挡它；它不是操作系统级安全边界。
- **本地审计：**仅记录启动/结束元数据，目录为 `%LOCALAPPDATA%/WinCode/logs/ui-audit`。1 MiB 时在结果中建议清理；接近 2 MiB 时预留结束记录空间并停止新访问。不自动删除日志，也不防同权限篡改；仅有启动记录时，结果视为未知。[检测脚本](scripts/check-ui-audit.ps1) 支持显式检查与可选桌面提醒。

### 开发与验证

```powershell
npm run build
npm run typecheck
npm test                  # 非交互回归

# 实机 UI 测试前发布隔离 WPF 夹具
dotnet publish tests/fixtures/wpf-ui-review/wpf-ui-review.csproj -c Release -r win-x64 --no-self-contained
npm run test:ui           # 既有交互 UI 套件
npm run test:ui-query     # 单独运行局部查询验收，使用一次性夹具
npm run test:all          # npm test + test:ui，不包含 test:ui-query
```

实机 UI 测试需要交互式 Windows 会话，可能显示测试窗口。222 节点隔离夹具中，局部查询文本由 62,025 字节降至约 1,600 字节，调用仍约 0.78 秒；这只说明该样本的输出缩减，不代表普遍提速或精确 Token 节省。测试证据与未验证项见[工作记录](docs/codex_worklog.md)。

---

## Acknowledgements / 致谢

- [FlaUI](https://github.com/FlaUI/FlaUI) — Windows UI Automation library / Windows UI 自动化基础库。
- [Serena](https://github.com/oraios/serena) — Optional semantic code navigation / 可选的语义代码导航。
- [Repomix](https://github.com/yamadashy/repomix) — Optional repository context packing / 可选的代码库上下文打包。

## License / 许可

[MIT](LICENSE)
