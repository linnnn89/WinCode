# WinCode.UIA.Host

WinCode **0.17.1** 使用的 Windows 原生辅助程序（基于 FlaUI.UIA3 与 Win32 API）。采用按请求拉起的一次性进程模型：每次启动处理单个窗口发现、UIA 控件读取、受控 UI 操作或受校验的文件移动请求，输出响应后立即退出。实现入口见 [Program.cs](Program.cs)，MCP 工具参数见 [UI 手册](../../skills/wincode/references/ui.md)，整体数据流见 [架构与数据流说明](../../WinCode-架构与数据流说明.md)。

## 职责与边界

- **UIA 取证与受控操作**：从 `stdin` 读取单次 JSON 请求，执行有界窗口枚举、控件树读取或单个语义化 UI 操作，向 `stdout` 输出单行 JSON 后退出。
- **进程归属保护**：启动工作前通过 `OwnerProcessGuard` 校验父进程（Gateway）身份；当所属 Gateway 退出或请求超时取消时，Helper 自动中止并退出，**绝不终止被检查的目标应用进程**。
- **句柄校验文件移动（`--move-to-trash`）**：供 `wincode_safe_move_to_trash` 调用，在原生层校验普通文件句柄与目标边界后将文件移入本地回收目录。
- **后台写保护与键盘隔离**：默认仅执行只读检查。`--background-ui` 模式下禁用普通点击、展开与按键输入；`setValue`（`ValuePattern`）与 `wpfShortcut`（触发目标窗口显式声明的 `WinCode.WpfBackgroundShortcut.v1` 控件）均须核对启动者绑定的 `<PID>:<HWND>:<processStartFileTime>` 且确认目标进程**不处于前台**后才允许执行。逐键输入（`type`）默认关闭，仅在启动者显式传入 `--isolated-keyboard` 的独立交互会话且目标控件已确认前台焦点时可用。

## 内部请求与响应协议

以下为 Gateway 与 Host 之间的**内部 `stdin` 协议示例**（`schemaVersion`、`requestId`、`action`、`timeoutMs` 为内部协议字段，不属于外部 MCP 工具参数）：

```json
{
  "schemaVersion": "1.0",
  "requestId": "example-inspect",
  "action": "inspect",
  "pid": 12345,
  "hwnd": "0x123ABC",
  "capture": "none",
  "backgroundOnly": true,
  "readStates": true,
  "query": { "automationId": "NavCharacters", "maxSearchNodes": 1000, "maxMatches": 10 },
  "maxDepth": 4,
  "maxNodes": 100,
  "timeoutMs": 10000
}
```

语义操作复用同一协议，通过 `action`（`click` / `setExpanded` / `setValue` / `type` / `wpfShortcut`）与精确选择器定位唯一控件：

```json
{
  "schemaVersion": "1.0",
  "requestId": "example-click",
  "action": "click",
  "pid": 12345,
  "hwnd": "0x123ABC",
  "targetAutomationId": "btnSave",
  "timeoutMs": 10000
}
```

- **版本标识**：传输协议版本为 `1.0`；当前 `inspectionVersion` 为 **`8`**（`2` 查询与状态、`3` 基础动作、`4` 展开/折叠、`5` `scopePath` 祖先范围、`7` 后台取证策略与绑定窗口 `setValue`、`8` 绑定窗口后台 WPF 声明式快捷键 `wpfShortcut`）。`hostIdentity` 返回程序集版本、构建配置与目标框架。
- **操作结果解释**：响应中的 `actionMethod` 标明实际调用的 UIA 模式（如 `InvokePattern`、`ValuePattern`、`WpfRoutedKey`），`actionTarget` 记录目标控件属性证据，`inputLength` 记录已写入字符长度（不回显输入原文）。`success: true` 仅代表 UIA 调用本身已完成，需另行调用 `inspect` 核实业务界面变化。
- **拒绝与部分执行区分**：目标未找到、歧义、搜索未完成、控件禁用、缺少所需 Pattern、只读值、未注册快捷键控件或前台/焦点校验未通过均在实际调用前拒绝并返回明确 `errorCode`。若返回 `ACTION_FAILED` 或中途超时，部分副作用（如 `clearBefore` 清空文本或控件内部回调）可能已发生，调用方须先只读检查当前状态，切勿盲目重发动作。

## 截图、DPI 与本地审计

- **DPI 与坐标**：启用 `PerMonitorV2` DPI 感知，返回的矩形与截图尺寸均为物理像素（因 DWM 阴影扩展边框差异，子控件相对窗口根矩形可能出现小幅负偏移）。
- **窗口截图边界**：优先使用 `PrintWindow`；`backgroundOnly: true` 要求同时指定 `pid` 与 `hwnd`，禁用桌面屏幕回退，最小化窗口不作为有效后台截图返回。部分硬件加速窗口可能返回全黑或陈旧画面，须结合 `captureMethod` 与 `captureQuality`（如 `suspect-low-variation`）核对。
- **提示浮层与审计日志**：每次 UI 检查与操作期间均显示无焦点 `REC / WinCoding` 提示浮层，并在 `%LOCALAPPDATA%/WinCode/logs/ui-audit` 写入本地审计记录（多实例并发时由命名 Mutex 互斥，冲突返回 `AUDIT_BUSY`）。
- **独立托盘说明**：可选的 `WinCode.Tray` 是独立的 WinForms 进程，不属于本 UIA Host 的常驻模式；退出托盘不会停止 MCP 或目标应用。

## 构建与校验

在仓库根目录执行 `npm run check` 完成锁定还原、Release 发布与交付清单校验；桌面交互测试执行 `npm run check:desktop`。构建要求 `.NET SDK 10.0.303`，运行发布产物需要 `.NET 10 Windows Desktop` 运行时。生产环境仅加载完整的 Release 发布目录，切勿单独替换某个 DLL（详见 [贡献指南](../../CONTRIBUTING.md)）。
