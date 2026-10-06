---
name: wincode
description: 使用 WinCode MCP 分析 Windows/.NET 项目源码、引用与变更影响，并通过 Windows UI Automation 检查控件、执行语义点击与表单填写、验证桌面交互流程。适用于源码定位、界面问题排查及支持 UIA 的 Windows 应用测试。
---

# WinCode

适用于 WinCode 0.16.0。已有正确工作区的 MCP 连接时直接使用；采用按需模式时，首次需要 WinCode 才按[诊断手册的会话入口](references/diagnostics.md#skill-按需会话)启动。Skill 被发现或读取不需要预启动任何进程。

本份说明同时描述 `codex/hybrid-readonly-orchestration` 实验构建的客户端配方及展开导航。`readonly-ui`／`expand-ui` 是该分支 CLI action，不是标准 MCP 工具名；第十五轮增加已展开选择续接及局部诊断，第十六轮增加标准 inspect/review 与 setExpanded 的 scopePath 父范围定位（inspectionVersion 5）。客户端配方尚未自动生成父路径或递归执行。使用前按手册核对当前连接／入口能力，旧 main 或旧连接不会因 Skill 更新获得新功能。

只读取与当前任务有关的手册：

- [代码与工作区](references/code.md)：源码搜索、上下文、引用、影响分析和 Roslyn 配置。
- [窗口与 UI](references/ui.md)：窗口与控件定位、语义操作与激活边界、前台键盘输入（需授权）、结果验证和源码候选。
- [诊断与恢复](references/diagnostics.md)：按需会话的启动、复用、结果读取和关闭，以及版本和故障恢复。按需模式先只读该手册首节。

连接固定到启动工作区；已知根一致时直接查询，不例行重复打开。`WORKSPACE_MISMATCH` 时选择目标项目的连接，可参考 `connectionGuide`；`workspace_open` 只能确认或恢复原工作区。

按需模式在一次任务内保留执行会话 ID，多次查询复用同一连接；读取回执中的完整结果文件，保留所有 MCP 内容块与 `isError`。任务结束或放弃时显式关闭；断线后不自动重放，旧符号定位不能跨新连接使用。工具名和参数以运行实例的 Schema 为准，疑问时使用 `wincode_hello_world({toolName:"具体工具名"})`。

默认 `local-text` 提供文本线索；显式启用 Roslyn 才有 C# 语义证据。需要精确引用时先搜索声明，再传回完整 `location`，不猜定位或复用过期快照。

日常导航用 `wincode_search_text` 限定目录查字面量、`wincode_file_outline` 查看行数和声明，再把返回的 `nextRequest` 交给 `wincode_prepare_context`。先看 `summary` 的范围和缺口，再核对正文与覆盖率。UI 首轮可显式用 `responseFormat:"compact"`，需要几何或更多信息时按 `expansionRequests` 展开；仅使用本连接已声明的能力。

优先按文件、符号和行范围获取小结果。参数遵循手册与实际 Schema；保留截断、降级和歧义，UI 源码候选不等于已验证的运行时映射。`SERVER_BUSY` 或超时后先按诊断手册处理，不自动重放请求或重启连接。

用户要求执行或测试界面流程时，可在授权范围内完成定位、点击、输入与结果验证；只要求评估或查看时保持只读。操作前遵循下面的前台边界，字段与流程细节见 [窗口与 UI](references/ui.md)。

## 注意事项：后台取证不等于所有操作都不会抢前台

“工具不主动激活窗口”与“目标应用不会跳到前台”是两件事。不要因使用 WinCode、UIA 或某个 AI 客户端，就承诺所有步骤都不会打扰用户。

- **只看界面或截图时，保持只读。**复用已有实例；对确定的 PID/HWND 使用 `wincode_ui_inspect` 或 `wincode_ui_review`，设置 `backgroundOnly:true`；仅需控件信息时用 `capture:"none"`，需要图像时用 `capture:"original"`。不要为查看而额外点击、换页或填写。
- **后台截图直接用 PrintWindow，不先把窗口提到前台。**`backgroundOnly:true` 禁止屏幕截图回退；它只约束 inspect/review 的取证方式，不是 click/type 的“禁止激活”开关。截图失败、黑图或窗口最小化时报告实际限制，不为了截图调用 `SetForegroundWindow`、恢复窗口或重新启动实例。
- **填写必须明确选择模式。**后台写值使用 `wincode_ui_type` 且显式传 `mode:"setValue"`；省略 mode 会走默认的 `"type"`，请求焦点并发送键盘输入。控件不支持 ValuePattern 时，不自动改成 type、SendKeys 或自写聚焦脚本。setValue 不请求键盘焦点，但写值触发的应用事件仍需验证。
- **语义点击不等于保证不激活。**`wincode_ui_click` 只调用 Invoke/Toggle/SelectionItem，不先聚焦、不模拟鼠标；目标控件的事件、导航、视图装载或弹窗仍可能带来前台变化。已有 WPF 导航按钮的反馈中，自写脚本与 WinCode 对同一按钮使用 InvokePattern 都出现了前台切换，而只读取证未观察到切换。该证据只限具体路径，不能推成“所有 Invoke/Select 都抢前台”，也不能归因于 AI 客户端身份。
- **只授权后台操作时，不擅自进入前台路径。**启动应用、恢复最小化窗口、Focus/SetFocus、键盘或鼠标模拟都可能改变前台状态，不能当成后台步骤的自动补救。某个动作已知会抢前台，就说明该步骤的限制；没有前台授权不再执行它。若执行中观察到抢前台，停止后续动作，先只读检查状态，不反复重放来“确认”。
- **区分复现与根因。**动作返回成功只说明调用被接受；先读回业务状态。没有发现显式 Activate 调用不等于已排除应用或框架；有限采样未见前台变化只能报告“本轮未观察到”，不能保证绝不激活。用户未要求追查时，不自行追加对照实验。
