# WinCode.UIA.Host

0.15.0 的 Windows UI Automation（FlaUI.UIA3）一次性取证进程。实现入口为 [Program.cs](Program.cs)，面向 Agent 的规范参数见 [UI 手册](../../skills/wincode/references/ui.md)，整体数据流见 [架构说明](../../WinCode-架构与数据流说明.md)。

## 职责和边界

接收 stdin JSON，执行有界窗口发现或 UIA 取证，输出 stdout JSON 后退出。Gateway 的 FlaUIAdapter 管理自有 Host 的超时、取消和进程回收；被检查的应用不属于其进程所有权。原生 Helper 在开始工作前验证所属 Gateway 的进程身份；所属进程退出时取消并按既有宽限清理自身。Gateway 启动保留配置/交付检查，实际 UIA 健康探测延后到显式诊断或首次操作。

Host 不点击、不输入、不写目标控件属性，不主动启动或终止目标应用。它会产生自身进程、审计日志及按策略显示的取证提示，因此不应描述为“零副作用”。审计和内容哈希是诊断证据，不是防篡改或来源签名。

## 请求与结果

下面是内部 stdin 请求示例，PID/HWND 必须替换为实际目标；`schemaVersion`、`requestId`、`action` 和 `timeoutMs` 是内部 Host 协议字段，不应照搬为 MCP 工具参数。

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

协议版本 `1.0`、取证结构 `inspectionVersion: 2` 和程序集产品版本是不同概念。实际 Host 的 `hostIdentity` 用于核对版本、构建配置和框架，不能从请求或磁盘文件名推断响应身份。

结果应结合 `success/errorCode`、目标窗口、搜索完整性与匹配数量、截断原因、状态证据、截图信息和审计状态解释。查询字段按大小写精确 AND 匹配；只有遍历完整且唯一才展开命中子树。截断后的单个候选不能认定唯一，未知状态不等于 false，多窗口歧义不能自动挑第一个。

## 截图与坐标

采用 PerMonitorV2 DPI 感知，矩形和截图坐标为物理像素。DWM 扩展边框与 UIA 根矩形可能不同，因此相对坐标出现负偏移不自动意味着定位错误。

截图优先尝试 PrintWindow；成功与图像内容取决于目标应用及渲染状态，不能保证所有 GPU/WPF 窗口都可正确捕获。`backgroundOnly=true` 要求明确 PID/HWND，禁用桌面屏幕回退；最小化窗口不作为后台截图成功处理。非后台限制模式才允许按实现尝试桌面 DC/屏幕回退。

读取 `captureMethod` 和 `captureQuality`，区分截图 API 返回成功与画面内容可信；质量检测不是语义识别。树查询、截图、审计分别有自己的结果边界，不因获得一张 PNG 就宣称全部取证完成。

可选 WinForms Tray 是另一个发布组件，不是本 UIA Host 的常驻模式；关闭托盘不应关闭 MCP 或被检查应用。跨实例 HWND 隔离、非默认 DPI 与历史偶发捕获失败的验证范围见工作记录，不能由核心测试通过推断全部支持。

## 构建与验证

从仓库根目录运行 `npm run check` 完成锁定还原、Release Host 构建与交付校验；需要交互桌面时另运行 `npm run check:desktop`。构建要求固定 SDK 10.0.303，framework-dependent Host 需要 .NET 10 Windows Desktop 运行时。完整命令与报告边界见 [贡献指南](../../CONTRIBUTING.md)。

生产默认只使用发布的 Release Host；Debug/dotnet-run 回退需显式开发模式。更新 Host 后核对完整交付文件集和实际响应身份，不能只替换一个 DLL。
