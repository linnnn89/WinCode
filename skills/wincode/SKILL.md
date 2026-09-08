---
name: wincode
description: 使用 WinCode MCP 分析 Windows/.NET 工作区，或读取桌面窗口、截图与 XAML 源码候选。
---

# WinCode

仓库手册版本：0.12.3。安装内容可用 `node scripts/sync-skill.mjs <安装目录绝对路径>` 核对；仅维护时执行，不在每个任务中例行检查。以当前连接实际 Schema 为准，手册版本不证明 MCP 已重连。

仅按当前任务读取对应手册，不预读全部文件：
- 代码、上下文、引用、影响分析：[code](references/code.md)。
- 窗口发现、截图、UI 源码候选：[ui](references/ui.md)。
- 连接失败、运行状态、审计提醒：[diagnostics](references/diagnostics.md)。

使用客户端已连接的 WinCode MCP 工具；名称前缀以实际暴露为准。
参数采用兼容容忍模式：未声明字段会被忽略，不表示相应功能已生效；已声明字段仍校验类型、必填项和范围。按对应手册的规范字段表构造请求，使用真正的 JSON 数字/布尔值，不传字符串替代。以当前连接 tools/list 的 schema 为准；手册比连接新时，不反复尝试旧实例未支持的参数。
工具不可用时读诊断手册，不用临时脚本绕过 MCP 或审计。
源码操作前确认活动工作区；仅在未知或切换项目时调用 workspace_open。
按需获取小结果，不例行探测、遍历全仓、截图或重复枚举。
保留降级、截断与歧义，不把源码候选当作确定的运行时映射。
