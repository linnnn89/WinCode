# WinCode v0.6：Windows 运行时 UI 取证实施方案

日期：2026-09-07（北京时间）

状态：供参考的实施方案，不代表功能已经实现、完成验收或授权安装依赖、控制真实应用及发布。后续实施以用户当时的明确授权和当前工作区为准。

## 1. 目标与版本边界

让调用 WinCode 的 Agent 对用户指定的 Windows 应用窗口获取**有界控件树、可选截图及编号对应关系**，并在失败、超时、取消和退出时正确回收辅助进程。

WinCode 负责采集和关联证据，调用它的 Agent 负责视觉理解、问题解释与代码修改。运行时事实、截图、源码证据及模型推理必须区分。

建议分期：

| 阶段 | 范围 | 验收收益 |
| --- | --- | --- |
| v0.6 | FlaUI 运行时 UI 取证 | 指定窗口的控件树与截图可供 Agent 使用 |
| v0.7 | UI 与源码联动审查 | 从控件定位 XAML／C# 候选并组织证据 |
| 后续按需 | 专项诊断、交互、性能优化 | 由实际需求决定，不提前建设 |

本轮实施任务建议只到 v0.6。完成后停止，不自动扩展到 v0.7。

## 2. 实施前确认基线

先只读检查 Git 状态、已有工作记录、相关源码和测试，以**当前工作区实际内容**为基线，不退回旧提交，不覆盖未提交修改。

阅读 `docs/codex_worklog.md`，保留 Stage 1 已有修正：

- 缓存入队前固定 namespace 对应路径与原子写入。
- overflow 生命周期、删除边界、目录联接保护及关联内存失效。
- workspace 切换排空、超时拒绝及 shutdown 协调。
- Git porcelain `-z` 解析和符号路径歧义处理。

已有测试失败和未验证事项应如实保留，不能当作本轮已通过。

## 3. v0.6 必须实现与排除项

必须实现：

1. `FlaUiAdapter`。
2. 一次请求、一次响应、随后退出的小型 .NET UIA Host。
3. 一个 MCP 工具：`wincode_ui_inspect`。
4. 有界 UIA 控件树。
5. 可选原始截图、编号标注截图。
6. 超时、取消、崩溃及 shutdown 清理。
7. 独立可运行的 WPF 测试应用。
8. 自动化回归测试与条件允许的 Windows 实机验证。

本轮排除：

- `UiSourceMapper`、`wincode_ui_review` 和自动 UI → XAML → C# 映射。
- UI 审美评分、完整无障碍扫描。
- 点击、输入、拖动、自动导航。
- 自动构建或启动用户的真实项目。
- Snoop、Axe.Windows、Onlook 整体集成。
- OCR、额外 LLM API、数据库、任务队列及服务平台。
- 常驻 helper、长期 UIA 对象缓存、全桌面事件监听。

## 4. 最小架构与代码落点

```text
WinCode MCP: wincode_ui_inspect
                ↓
          FlaUiAdapter
                ↓ stdin/stdout JSON
        一次性 .NET UIA Host
                ↓
      指定窗口的 UIA 信息与截图
```

| 位置 | 职责 |
| --- | --- |
| `src/Adapters/FlaUiAdapter.ts` | helper 调用、协议验证、超时取消、健康状态与释放 |
| `src/Core/UiContracts.ts` | 请求、快照、图片元数据、错误和截断契约 |
| `tools/WinCode.UIA.Host/` | C# 程序，使用 FlaUI.UIA3 采集目标窗口 |
| `tests/fixtures/wpf-ui-review/` | 独立可运行的 WPF 测试应用 |
| 现有 `Config.ts`、`ToolRouter.ts` | 配置、实例所有权、请求和关闭协调 |
| 现有 `Protocol.ts`、`McpServer.ts` | MCP 注册、参数校验、取消传递及图片返回 |

沿用现有 Adapter、ToolRouter、ResourceManager 和 Gateway 边界。采用 Adapter 的理由是复用现有模式、改动较小；不是断言 ExtensionManager 无法实现。

不为这一项功能扩建插件系统，不无必要抽象多个后端、传输层或执行框架。

## 5. 依赖与构建

使用 FlaUI.UIA3，优先评估 `net10.0-windows` 和 `win-x64`。实施前核对本机 SDK、上游稳定包与目标框架兼容性，并固定经过验证的版本。

建议中的框架、包版本及计算兼容性均不能当作实测通过。依赖变更限于 Host 与测试应用的必需项目级依赖；需要安装 SDK、全局工具、额外服务或引入其他主要依赖时先说明并请求确认。

提供可重复的构建命令。运行 MCP 工具时不得隐式安装依赖、联网恢复包或临时编译 Host。helper 缺失时明确报告，现有代码分析工具仍应可用。

不自动创建外部 PR、发布 Release 或推送代码；版本号按仓库约定处理。

## 6. 协议与生命周期

采用简单、有界的请求响应协议：

- 请求包含 `schemaVersion`、`requestId`。
- stdin 输入 JSON，stdout 只输出协议数据，日志写 stderr。
- 返回普通可序列化数据，不跨进程传递活的 `AutomationElement`。
- UIA 对象在适当的 MTA 线程中创建、使用和释放，不跨请求保存。
- 输入、输出及诊断日志均有大小上限。
- 非法 JSON、协议不匹配、缺失字段和异常退出均有明确终态。

完整清理链路：

```text
取消／超时／shutdown
        ↓
终止本请求的 helper 及其子进程
        ↓
等待退出，必要时执行有界强制清理
        ↓
释放监听器、计时器和临时资源
```

`withTimeout()` 停止等待不等于底层操作已停止。不能返回超时结果后让 helper 继续运行。

**只清理 WinCode 启动的 helper，不能终止目标应用。**

默认同时最多运行一个 helper。后续请求采用简单、有界的等待或明确 busy 响应，不无限排队；排队也响应取消与 shutdown。

健康状态至少区分平台支持、helper 存在及可启动、协议探测成功、最近错误。健康探测不得读取用户窗口或启动目标应用。

## 7. MCP 工具契约

建议输入示意：

```json
{
  "pid": 12345,
  "hwnd": "可选窗口句柄",
  "capture": "annotated",
  "maxDepth": 6,
  "maxNodes": 300
}
```

具体类型遵循现有协议并做运行时校验：

- 明确指定目标，不默认读取前台窗口或扫描整个桌面。
- 同时提供 PID 和 HWND 时验证归属一致。
- PID 有多个符合条件的顶层窗口时返回候选，不随意取第一个。
- 窗口不存在、退出、权限不足或无法读取时明确报告。
- 不自动提权、抢焦点或恢复最小化窗口。
- `capture` 支持 `none`、`original`、`annotated`，建议默认 `none`。
- 接入现有请求计数、取消和关闭管理，不破坏 workspace 切换协议。

返回 JSON 文本；有截图时同时返回 MCP image 内容块，不能只返回本机文件路径。

## 8. 有界控件树

采集适用且可读取的字段：

- 本次快照内元素编号、父编号。
- 控件类型、名称、AutomationId。
- 位置与尺寸。
- 启用、屏幕外等状态。
- 属性失败、节点失效及截断说明。

编号只保证本次快照内唯一，不宣称跨采集稳定。

遍历同时受深度、节点数和截止时间约束。不能先读取所有后代再截取前 300 个。

属性不支持或读取失败时保留未知／不支持状态，不能默认成 `false`。默认不提取输入框值或文档正文，不主动读取密码值。

UIA 未暴露的控件不能推断为不存在。虚拟化列表只报告实际取得的范围，不为采集自动滚动或展开。

## 9. 截图与编号标注

复用同一次 inspect 的目标窗口及控件快照，不为每个控件重复截图。

- 标注只画在输出图片上，不创建桌面覆盖窗口。
- 附采集开始／结束时间、窗口标识、坐标原点、图片尺寸和缩放信息。
- 将 UIA 屏幕坐标正确转换为图片坐标，支持负屏幕坐标。
- 缩放图片时同步变换标注坐标，不盲目重复应用 DPI 比例。
- 编号与 JSON 元素对应，限制标注数量，避免不可读。

屏幕区域截图可能包含遮挡内容，不能保证获得窗口独立渲染结果。最小化、移动、关闭或遮挡无法可靠判断时保留限制说明。

不为宣称截图可靠而建设复杂遮挡检测；控件树和截图也不是严格原子采集，不能宣称绝对同步。

## 10. 初始资源预算

以下为起始配置建议，不是性能承诺：

| 项目 | 默认建议 |
| --- | ---: |
| 单次请求超时 | 10 秒 |
| 最大深度 | 6 |
| 最大节点数 | 300 |
| JSON 文本结果 | 128 KiB |
| 单张 PNG/JPEG 图片字节数（Base64 编码前） | 2 MiB |
| 同时运行的 helper | 1 |

区分正常执行时限与有限清理时限。明确截断、缩放及省略信息，不截断 JSON 字节串，不为压缩预算无界重复编码。传输预算还应考虑 Base64 膨胀。

UI 树和截图默认不进入长期代码缓存。优先避免中间文件；必须落盘时使用请求独立目录，按所有权清理并防止越界删除。

## 11. 测试与验收

新建 WPF fixture，不把原有代码分析 fixture 改造成复杂 UI 工程。至少包含普通／禁用按钮、输入框、重复名称或 AutomationId、多窗口及可验证截断的控件区域。

运行测试使用全新隔离数据目录。不得默认启动或读取个人项目、数据库或真实业务窗口。

自动化测试至少覆盖：

1. 正常响应、非法 JSON、协议错误与异常退出。
2. helper 挂起、请求取消、排队取消及 shutdown。
3. 采集中目标窗口退出。
4. 深度、节点数及输出大小限制。
5. 单属性失败时保留其他结果。
6. helper 缺失时现有代码工具仍可用。
7. 从操作系统验证 helper 已退出，而非只检查字段清空。
8. 清理不终止目标应用。
9. 图片编号与 JSON 对应关系。

Windows 实测单独报告：

- 标准缩放下真实 WPF 控件树与截图。
- 当前设备可验证的 DPI、多显示器、移动及最小化场景。
- 实际 MCP 客户端图片接收情况。
- 连续调用后的进程、临时文件与资源增长趋势。

先小批量验证，再按耗时决定是否执行 100 次稳定性测试。缺少设备、客户端或权限时写明未验证，不用 mock 通过替代实机结果。

运行构建、类型检查和相关回归。旧测试失败先确定归因，不删断言、放宽条件或伪造结果来实现全绿。

验收目标：

> 对指定 WPF 窗口返回有界控件树、可解释截图及编号对应关系；异常、取消和关闭时回收 helper，目标应用保持存活，原有代码工具保持可用。

## 12. 交付要求

持续更新 `docs/codex_worklog.md`，记录关键变更、决定、真实验证、失败与未验证项。交付列出修改文件、构建配置与调用示例、自动测试、实机结果和剩余限制。

可以按“Host 与生命周期 → UI 取证与图片”两个内部里程碑推进，无须为分期额外建设流程或自动创建 PR。

## 13. v0.7 与后续参考（不属于本轮）

v0.7 再增加 `UiSourceMapper` 与 `wincode_ui_review`：

- 在明确 workspace／候选 View 范围内搜索 XAML。
- 结合 AutomationId、控件类型、容器和候选数量定位，不能精确匹配即宣称高置信。
- 返回文件、真实行号、命中附近片段、匹配依据、完整性和歧义。
- `x:Name` 与运行时 AutomationId 不默认相等。
- 找到 Command／Binding 声明不等于证明运行时 DataContext 或禁用原因。
- 确认目标窗口与源码工作区关联，保留旧构建及不同分支的可能性。
- CompositeTool 汇总同一次采集的证据，不另接 LLM；禁用状态不自动当缺陷，矩形相交不自动当遮挡。

Onlook 值得借鉴的是界面元素与源码关联机制，不整体接入编辑器平台。Axe.Windows、Snoop、交互控制及常驻 helper 均待真实需求出现后独立评估。

## 14. 实施时参考资料

以下是复核入口，具体版本、接口和兼容性须在实施时核验：

- [FlaUI](https://github.com/FlaUI/FlaUI)
- [FlaUI AutomationElement 实现](https://github.com/FlaUI/FlaUI/blob/main/src/FlaUI.Core/AutomationElements/AutomationElement.cs)
- [UIA 线程要求](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
- [UIA 屏幕缩放](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling)
- [AutomationId 使用边界](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/use-the-automationid-property)
- [.NET 支持策略](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)
- [FlaUI.UIA3 NuGet](https://www.nuget.org/packages/FlaUI.UIA3)
- [MCP 工具结果规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Onlook 工作原理](https://github.com/onlook-dev/onlook#how-it-works)
