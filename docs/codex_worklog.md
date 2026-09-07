# Codex 工作记录

## 2026-09-07 11:56（北京时间）— Stage 1 快速修正

- 目标：修复审查确认的 overflow 内存失效、删除边界及 shutdown 排队请求问题；保留既有 Stage 1 实现，不接入 FlaUI 或新增依赖。
- CacheManager：统一 overflow 删除入口；删除前失效关联内存条目，限制为本缓存 overflow 目录中的普通文件，拒绝目录联接/符号链接越界。TTL、容量淘汰、孤儿清理及 clear 复用此入口。
- ToolRouter / McpServer：槽位等待前后检查关闭状态；关闭通过既有 workspaceLock 等待进行中的切换完成后再释放资源；槽位获取失败进入 MCP 错误响应，只有实际取得槽位才递减计数。
- 新增 tests/stage1-cleanup.test.ts 并纳入 npm test：覆盖容量淘汰后的读取、TTL/容量清理外部路径保护、Windows junction 保护、关闭与切换/排队请求并发。全部测试使用新建临时目录，结束清理。
- 验证：新增 4 项通过；原 v05-stability 35 项通过；npm run typecheck、npm run build 和 git diff --check 通过。
- 全量 npm test 未通过：旧 tdd-suite 中硬编码外部 Tavern 路径的切换测试、固定项目名 WinCode MCP 的 MCP 架构测试失败；套件输出失败后未退出，已中断。本轮未修改这两个旧测试，也未把全量验证报告为通过。
- 限制：未做真实 Serena 子孙进程树端到端验收；未变更 Stage 2 范围。文件边界校验不承诺抵御恶意进程在校验与删除之间并发替换目录。

## 2026-09-07 12:12（北京时间）— 保存 v0.6 参考方案

- 按用户要求在根目录新增 [WinCode v0.6运行时UI取证实施方案](../WinCode%20v0.6运行时UI取证实施方案.md)，保存完整范围、架构、协议、生命周期、截图预算、测试与后续路线。
- 文档明确为参考方案，v0.6 仅 UI 取证，v0.7 源码联动后置；未实施功能、安装依赖或控制真实应用。
- 验证：文件已生成，核对章节结构；本次仅文档变更，不运行代码测试。

## 2026-09-07 14:00（北京时间）— WinCode v0.6 运行时 UI 取证全量实施交付

- 目标：按照 [WinCode v0.6运行时UI取证实施方案](../WinCode%20v0.6运行时UI取证实施方案.md)，完成 Windows 桌面应用程序 UI 自动化取证功能（C# FlaUI.UIA3 Host、TypeScript UiContracts & FlaUiAdapter、MCP 工具 `wincode_ui_inspect` 及 ToolRouter 深度集成）。
- 架构设计与关键改动：
  1. **Step 1: C# UIA Host 与独立测试夹具 (PR #2)**：
     - 新建 `tools/WinCode.UIA.Host`（.NET 10 console, `net10.0-windows`, `win-x64`, FlaUI.UIA3 5.0.0）。
     - 显式调用 `SetProcessDpiAwarenessContext(PerMonitorV2)` 解决高 DPI / 屏幕缩放坐标物理像素对齐问题。
     - 三级健壮截图管线：`PrintWindow(PW_RENDERFULLCONTENT)` -> `BitBlt` -> GDI+ `CopyFromScreen(Format32bppRgb)`。
     - UIA3 有界遍历：`maxDepth` 与 `maxNodes` 截断，`TruncateReason` 精准标记；`EnumWindows` 过滤输入法及系统浮层；支持仅 HWND 查询时调用 Win32 `GetWindowThreadProcessId` 自动解析并回填归属 PID。
     - 物理像素编号徽章渲染：将 UIA 全局屏幕物理坐标转为窗口相对坐标，在截图上绘制对应 `UiNode.id` 的圆形数字标识徽章。
     - 新建 `tests/fixtures/wpf-ui-review` WPF 独立测试夹具（含普通/禁用按钮、输入框、7 层深度嵌套及启动就绪信号）。
  2. **Step 2: TypeScript UiContracts 与 FlaUiAdapter 封装 (PR #3)**：
     - `src/Core/UiContracts.ts`：定义 `UiRect`, `UiNode`, `UiInspectRequest`, `UiInspectResult`, `UiErrorCodes`（含 `CANCELLED`, `VERSION_MISMATCH`, `PAYLOAD_TOO_LARGE` 等完备错误码），`UI_INSPECT_DEFAULTS`。
     - `src/Core/Config.ts` & `package.json`：升级至 0.6.0，添加 `flauiInspectMs` 及 `adapters.flaui` 配置支持。
     - `src/Adapters/FlaUiAdapter.ts`：实现 `IAdapter`，多级解析 Release/Debug 路径，非侵入健康检查，`Mutex` 串行化防 UIA COM 线程冲突，`killProcessTree` 严格限制仅杀死 Helper 自身进程树（绝不触碰目标应用 PID），支持 AbortSignal 取消与 shutdown 优雅释放。
     - `tests/flaui-adapter.test.ts`：10 项单元与生命周期自动化测试全部通过。
  3. **Step 3: MCP 工具 `wincode_ui_inspect` 与 ToolRouter 集成 (PR #4)**：
     - `src/Gateway/Protocol.ts`：注册 `wincode_ui_inspect`，严格限定入参类型（`integer`、`anyOf` 互斥要求、枚举校验与默认值）。
     - `src/Core/ToolRouter.ts`：实例化 `FlaUiAdapter`，纳入 `initialize()`、`disposeOnce()`、`getRuntimeHealth()`（含 `lastError` 聚合）与 `inspectUi()`。
     - `src/Gateway/McpServer.ts`：注册 `wincode_ui_inspect` 工具调用，按 Grok 4.6 审查意见执行**文本与二进制分离策略**：`content[0]` text 仅包含干净结构化控制树 JSON（剥离 base64 负载并标记 `hasScreenshot: true`，防止模型上下文被巨型字符串撑爆）；`content[1]` 独立以 MCP `image` ContentBlock 交付 Base64 PNG。同时升级 `wincode_hello_world` 暴露 `adapters.flaui` 与 capability。
     - `tests/ui-inspect-mcp.test.ts`：12 项端到端 MCP 协议与并发测试全部通过。
- 结对审查与调试（Grok 4.6 high）：
  - Step 1、Step 2、Step 3 均按规范调用 Grok 4.6 进行深度结对审查。在 Step 3 审查中，Grok 明确提出 Base64 污染 text JSON 会导致上下文膨胀，指导完成文本与图像分离，并补充严格入参校验与并发互斥验证，确保高质量交付。
- 验证证据：
  - `npx tsx --test tests/ui-inspect-mcp.test.ts`：12/12 全部通过（耗时约 4.3s）。
  - `npx tsx --test tests/flaui-adapter.test.ts`：10/10 全部通过（耗时约 1.8s）。
  - `npm test` 全量测试：106 通过，1 跳过（外部可选夹具），0 失败。
  - `npm run build && npm run typecheck`：0 错误。
  - C# UIA Host 发布编译（Release win-x64）：0 错误，正常输出可执行文件。
- 限制与说明：
  - 目前仅支持 Windows 10/11 x64 桌面环境。
  - 目标窗口必须可见且未最小化（最小化窗口 DWM 停止渲染，返回 `WINDOW_MINIMIZED`）。
  - 非管理员权限 Helper 无法读取高权限（UAC 提权）窗口。
  - UI 元素与 XAML 源码精准关联按规划在 v0.7 实施。
