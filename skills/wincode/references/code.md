# 代码与工作区

以下为 MCP 工具名和参数；以客户端实际 Schema 为准。

| 目的 | 调用 |
|---|---|
| 打开/切换项目 | workspace_open({path: "I:/project"}) |
| 项目依赖概览 | wincode_analyze_workspace({maxDepth: 2}) |
| 找符号 | wincode_find_code_symbol({query: "Save"}) |
| 查引用 | wincode_find_references({symbolName: "Save", relativePath: "src/Service.cs"}) |
| 变更影响 | wincode_analyze_change_impact({target: "Service"}) |
| 重构步骤 | wincode_plan_refactoring({target: "Service", goal: "拆分保存逻辑"}) |

按目标选工具，不顺序执行整张表。已知文件优先限定范围：

```json
{"task":"查明保存失败原因","candidateFiles":["src/Service.cs"],"includeFullText":false,"maxTokens":2000}
```

上例用于 wincode_prepare_context。2000 是首轮建议预算；证据不足再定向补充，确需文件正文才设 includeFullText=true。中文任务优先提供明确文件/符号。

检查 source、queryComplete、uniqueResolution/uniqueTypeMatch 与 limitations。文本回退不保证语义引用完整；零引用、UNKNOWN 或未找到均不证明可安全删除。

仅在用户授权移除文件时使用 wincode_safe_move_to_trash({filePath:"相对路径",reason:"原因"})；它会实际移动文件。重构计划本身不执行修改。
