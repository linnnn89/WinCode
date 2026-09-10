---
name: wincode
description: 使用 WinCode MCP 分析 Windows/.NET 工作区，或读取桌面窗口、截图与 XAML 源码候选。
---

# WinCode

源码契约：0.15.0（连接固定启动工作区，其他根返回 WORKSPACE_MISMATCH）；手册修订：2026-09-10。此版本号不代表当前连接已升级，以实际 Schema 为准。外部 Serena 已退役。仅维护时用 node scripts/sync-skill.mjs <安装目录绝对路径> 核对安装内容。

默认以本地文本模式启动，source=local-text；明确配置 Roslyn 后，才通过 WinCode.Code.Host 提供 C# 语义证据。搜索返回的 location 可作为引用、影响分析和重构工具的 symbolLocation；不要猜测定位、复用旧快照或使用已退役的 namePath。内部 reload/cancel 不是 MCP 工具字段。配置与验收边界见代码手册。

仅按当前任务读取对应手册，不预读全部文件：
- 代码、上下文、引用、影响分析：[code](references/code.md)。
- 窗口发现、截图、UI 源码候选：[ui](references/ui.md)。
- 连接失败、运行状态、审计提醒：[diagnostics](references/diagnostics.md)。

使用客户端已连接的 WinCode MCP 工具；名称前缀以实际暴露为准。
参数采用兼容容忍模式：未声明字段会被忽略，不表示相应功能已生效；已声明字段仍校验类型、必填项和范围。按对应手册的规范字段表构造请求，使用真正的 JSON 数字/布尔值，不传字符串替代。以当前连接 tools/list 的 schema 为准；手册比连接新时，不反复尝试旧实例未支持的参数。
工具不可用时读诊断手册，不用临时脚本绕过 MCP 或审计。
源码操作前核对所选连接的工作区。workspace_open 只确认或恢复启动根，健康同根确认保留 Host，不是强制重启或清理完成屏障。WORKSPACE_MISMATCH 表示连接不属于目标项目；选择对应连接，不得忽略错误继续声称正在操作另一项目，也不自动改配置或重试。hello.health.workspaceBinding 标明固定根及来源（argument/cwd/configuration）；已知根一致时直接查询，不例行重复打开。每实例最多 32 个未完成业务请求，hello/tools/list 共享 4 个轻量槽；原始参数含未知字段按 UTF-8 JSON 限制为 64 KiB。SERVER_BUSY 表示本次尚未执行，按需稍后重试，不自动重放或重启；REQUEST_TIMEOUT 包括排队耗时，不证明业务没有执行。
按需获取小结果，不例行探测、遍历全仓、截图或重复枚举。
保留降级、截断与歧义，不把源码候选当作确定的运行时映射。
