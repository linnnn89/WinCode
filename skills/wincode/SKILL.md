---
name: wincode
description: 使用 WinCode MCP 定位项目源码、查询 C# 引用和变更影响，或通过 Windows UI Automation 读取、操作和验证桌面界面。用于代码排查与支持 UIA 的 Windows 应用测试。
---

# WinCode

适用于 0.17.0。优先复用目标工作区已有的 MCP 连接；需要按需启动时，读[会话入口](references/diagnostics.md#skill-按需会话)。仅加载 Skill 不启动进程。

## 按任务读取

| 当前任务 | 手册 |
|---|---|
| 找代码、读上下文、查引用或影响 | [代码与工作区](references/code.md) |
| 找窗口、读控件、统计复选框、读取列表分组或操作界面 | [窗口与 UI](references/ui.md) |
| 启动或关闭按需会话、核对版本、处理错误 | [诊断与恢复](references/diagnostics.md) |

只读当前任务需要的部分。参数以已连接实例的 Schema 为准；不确定时调用 `wincode_hello_world({toolName:"具体工具名"})`。更新磁盘文件不会更新运行中的连接。

## 使用原则

- 连接固定到启动工作区。已知根一致时直接查询；`WORKSPACE_MISMATCH` 时换用对应连接，`workspace_open` 只能确认或恢复原根。
- 代码先定位再定向读取。默认 `local-text` 提供文本线索；Roslyn 引用需要当前搜索结果中的完整 `location`。
- 查看界面保持只读：明确 PID/HWND，使用 `backgroundOnly:true`。操作界面按用户授权执行，动作后读回结果。后台写值显式用 `mode:"setValue"`；默认 `type` 会请求键盘焦点。
- 检查完整结果中的业务状态、范围、截断和缺口。空结果不证明不存在；动作受理不证明业务结果已经发生。结果未知时先观察实际状态，不重发原动作。
- 按需会话在任务内复用，读回 `resultFile` 的完整内容，结束时显式关闭。`readonly-ui` 和 `expand-ui` 是客户端 action，不能作为 MCP 工具名调用。
