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

按目标选工具，不顺序执行整张表。已知文件时优先提供候选：

```json
{"task":"查明保存失败原因","candidateFiles":["src/Service.cs"],"includeFullText":false,"maxTokens":2000}
```

上例用于 wincode_prepare_context。默认 compact 仅返回一个 JSON 文本块；旧客户端需要 JSON 加 Markdown 时显式传 responseFormat:"legacy"。maxTokens 为 512–65536 的整数，约束所有返回文本的字符数÷4，包括 JSON 转义、元数据和旧格式的两个文本块；这是估算，不是真实模型 Token 硬上限。

candidateFiles 最多 20 个，仅表示优先，仍可能追加符号检索结果。focusAreas 最多 5 个现有文件或目录，仅取目录直属代码文件，最多追加 8 个、每目录最多检查 1000 项；不支持 glob，勿传 src/**/*.ts。路径必须在工作区内，缺失/不可读/选择上限查看 fileIssues，不盲目重复相同参数。

已知位置时选择最小取证范围，避免再做全仓库符号查询：

```json
{"task":"核对保存逻辑","lineRanges":[{"file":"src/Service.cs","startLine":50,"endLine":80}],"maxTokens":2000}
```

lineRanges 为闭区间、1 起始行号，最多 8 个文件，每文件一个范围、最多 500 行；越界报告缺口，预算不足仍可能截断。它跳过符号搜索，仅返回指定范围；不能与 symbol 或 includeFullText=true 同用。

仅知道文件时用 scopeFiles:["src/Service.cs"] 排他限定最多 20 个文件；它跳过全仓库符号搜索，不能与 focusAreas 同用，candidateFiles/lineRanges 必须在其内。需要声明附近片段可加 symbol:"Save"：大小写精确匹配，必须提供 scopeFiles，目前复用 C#/TS/JS/Python 本地声明模式，并非语义解析，queryComplete=false。重名、未找到或不支持语言会返回 fileIssues，不用文件开头冒充命中；可用已知行号进一步消歧。

metrics.selectedFiles 是选择数，packedFiles 是打包器实际处理数（片段模式为片段数），returnedFiles 是返回正文覆盖数；打包器缺少正文位置时为 null。relatedFiles.bodyStatus 表示 complete/partial/omitted/unknown；片段模式的 complete 仅表示该片段完整，不表示整个文件完整。小预算先裁辅助列表，metadataTruncated 提示列表可能不全。

2000 是首轮建议预算；证据不足再定向补充，确需文件正文才设 includeFullText=true。中文任务优先附上明确符号。startLine/endLine 是本次片段实际覆盖行，line 是其中的符号声明行；locationKind=file-start 只说明读到文件开头，evidenceInsufficient=false 不保证已取得回答问题所需的代码。完整模式的 packedContent 是正文，候选元数据不保证打包结果完整。

保留 queryComplete、truncated、metadataTruncated、limitationsOmitted、omittedFiles/omittedFileCount 等字段的含义；预算裁剪后不得把缺失当成不存在。根据缺口收窄候选或增加预算，勿例行拉取全文。

检查 source、queryComplete、uniqueResolution/uniqueTypeMatch 与 limitations。文本回退不保证语义引用完整；零引用、UNKNOWN 或未找到均不证明可安全删除。

若已有影响报告，直接据此规划，不为获得通用清单再次调用 plan_refactoring。该工具仍会做影响分析；它返回的 evidence 保留歧义、降级和 UNKNOWN，不代表已经执行重构。

仅在用户授权移除文件时使用 wincode_safe_move_to_trash({filePath:"相对路径",reason:"原因"})；它会实际移动文件。重构计划本身不执行修改。
