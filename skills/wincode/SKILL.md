---
name: wincode
description: 使用 WinCode MCP 定位项目源码、查询 C# 引用和变更影响，或通过 Windows UI Automation 读取、操作和验证桌面界面。用于代码排查与支持 UIA 的 Windows 应用测试。
---

# WinCode

适用于 **0.17.1**。优先复用当前客户端已配置的 WinCode MCP 连接；需在交互终端按需启动时，查阅 [Skill 按需会话](references/diagnostics.md#skill-按需会话)。仅读取本手册不会启动进程。

## 按任务查阅分册

| 当前任务 | 参考手册 |
| --- | --- |
| 搜索代码、按范围读上下文、查 C# 引用或变更影响、移入回收目录 | [代码与工作区](references/code.md) |
| 列举窗口、后台检查控件、复选框/列表只读配方、执行受控 UI 操作 | [窗口与 UI](references/ui.md) |
| 按需会话协议、连接/版本核对、Git/Roslyn/UI 错误排查与恢复 | [诊断与恢复](references/diagnostics.md) |

按需读取对应分册，不必一次性加载全部文档。工具参数以当前连接实例的 Schema 为准；不确定时调用 `wincode_hello_world({ toolName: "具体工具名" })`。更新磁盘文件后须重连 MCP 才会生效。

## 核心使用原则

- **工作区参数**：先看 `hello.health.workspaceBinding.mode`。动态模式（`dynamic`）下，除 `workspace_open` 使用 `path` 外，其余项目工具每次调用均须传目标项目的绝对路径 `workspacePath`（源码结果返回的 `nextRequest` 已自带该字段，可直接传给 `wincode_prepare_context`）。固定模式（`fixed`）使用启动根目录，遇 `WORKSPACE_MISMATCH` 时切换对应连接。
- **代码先定位后精读**：默认 `local-text` 提供启发式文本线索；同一任务需查多个声明名时，可将名称放在同一次 `wincode_prepare_context.task` 前部（默认合并最多 4 个提取关键词扫描）。启用 Roslyn 时，查引用与影响须原样传入搜索返回的完整 `symbolLocation`。
- **UI 精确取证与受控操作**：后台检查须同时指定 `pid`、`hwnd` 与 `backgroundOnly: true`。后台赋值（`mode: "setValue"`）与后台 WPF 声明式快捷键（`wincode_ui_shortcut`）分别依赖启动者绑定 `--ui-write-window` 与 `--ui-shortcut-window`，且目标进程处于前台时会被拒绝。全局逐键输入默认关闭。
- **核实完整性与实际状态**：仔细检查返回结果中的 `queryComplete`、`searchComplete`、`coverage`、截断与属性缺口。空结果不等于全局不存在；UI 动作调用成功不代表业务副作用已完成，动作超时或结果未知时先只读观察实际状态，切勿盲目重发。
- **按需会话生命周期**：任务内复用同一个终端会话，务必读取回执中的 `resultFile` 获取完整内容，结束时显式发送 `close`。`readonly-ui` 与 `expand-ui` 是客户端会话 `action`，不是 MCP 工具名。
