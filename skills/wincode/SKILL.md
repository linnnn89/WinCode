---
name: wincode
description: 使用 WinCode MCP 读取 Windows/.NET 项目源码、引用和变更影响，按需查看桌面 UI。
---

# WinCode

适用于 WinCode 0.15.0。使用已连接的 MCP 工具，名称和参数以该连接实际暴露的 Schema 为准。

只读取与当前任务有关的手册：

- [代码与工作区](references/code.md)：源码搜索、上下文、引用、影响分析和 Roslyn 配置。
- [窗口与 UI](references/ui.md)：窗口选择、截图、控件读取和源码候选。
- [诊断与恢复](references/diagnostics.md)：工具不可用、版本、运行状态及错误恢复。

连接固定到启动工作区；已知根一致时直接查询，不例行重复打开。`WORKSPACE_MISMATCH` 时选择目标项目的连接，可参考 `connectionGuide`；`workspace_open` 只能确认或恢复原工作区。

默认 `local-text` 提供文本线索；显式启用 Roslyn 才有 C# 语义证据。需要精确引用时先搜索声明，再传回完整 `location`，不猜定位或复用过期快照。

日常导航用 `wincode_search_text` 限定目录查字面量、`wincode_file_outline` 查看行数和声明，再把返回的 `nextRequest` 交给 `wincode_prepare_context`。先看 `summary` 的范围和缺口，再核对正文与覆盖率。UI 首轮可显式用 `responseFormat:"compact"`，需要几何或更多信息时按 `expansionRequests` 展开；仅使用本连接已声明的能力。

优先按文件、符号和行范围获取小结果。参数遵循手册与实际 Schema；保留截断、降级和歧义，UI 源码候选不等于已验证的运行时映射。`SERVER_BUSY` 或超时后先按诊断手册处理，不自动重放请求或重启连接。
