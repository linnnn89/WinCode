# 代码与工作区

以下为 MCP 工具名和参数；以客户端实际 Schema 为准。

怀疑源码与连接不同步时，先调用 wincode_hello_world({toolName:"wincode_prepare_context"})，对照本连接 tools/list 的参数及 schemaHash，并记录 runtime.instanceId/build.buildId。旧实例没有这些字段时明确为旧契约，不再反复尝试新参数。构建后需要客户端重连；build.status=unknown 不能当成当前源码已运行。test:e2e 只证明它自己启动的隔离 stdio 进程。

lineRanges 查看最终 coverage.allRequestedCovered、completeLines 和 details 中的 missingRanges/nextRequest。末行 endLineComplete=false 时从该整行补取，不能把“行号落入区间”算作完整正文。nextRequest 可能提高预算；maximum-budget-without-progress 表示不要反复提交同一请求。明细缺省还需检查 omittedItemCount。scopeFiles/symbol 的 coverage=null，taskCoverage=null；queryComplete 或非空片段均不证明整个方法覆盖。

| 目的 | 调用 |
|---|---|
| 打开/切换项目 | workspace_open({path: "I:/project"}) |
| 按需浏览目录 | wincode_list_directory({path: "src", maxDepth: 1, maxEntries: 100}) |
| 项目依赖概览 | wincode_analyze_workspace({maxDepth: 2}) |
| 找符号 | wincode_find_code_symbol({query: "Save"}) |
| 查引用 | wincode_find_references({symbolName: "Save", relativePath: "src/Service.cs"}) |
| 变更影响 | wincode_analyze_change_impact({target: "Service"}) |
| 重构步骤 | wincode_plan_refactoring({target: "Service", goal: "拆分保存逻辑"}) |

按目标选工具，不顺序执行整张表。已知文件范围时直接限定：

上游结果有 namePath 时保留原值（如 Service/Save[0]），续查用 symbolName:namePath 加 relativePath:file；不要还原成短名或删除重载索引。简单名称歧义检查 resolution/candidateCount/candidatesTruncated，不能选第一项。queryComplete=false 或解析失败不能解释为零引用；lineKind=containing-symbol 不是精确调用点。

workspace_open 默认返回项目摘要和最多 8 个入口，整份 JSON 默认不超过 8000 个 UTF-16 字符；不生成目录树或统计全仓大小。检查 projectScanComplete，null 统计不等于零。需要目录时用 wincode_list_directory 指定窄路径，查看 scanComplete/truncated/omissions。includeTree:true 可显式取得有界兼容树，不能当成完整仓库清单。maxOutputChars 为 2048–32768；目录 maxDepth 为 1–5，maxEntries 为 1–500。需要生成目录时显式 includeIgnored:true，但不能越过工作区边界。

```json
{"task":"查明保存失败原因","scopeFiles":["src/Service.cs"],"includeFullText":false,"maxTokens":2000}
```

上例用于 wincode_prepare_context。默认 compact 仅返回一个 JSON 文本块；旧客户端需要 JSON 加 Markdown 时显式传 responseFormat:"legacy"。maxTokens 为 512–65536 的整数，约束所有返回文本的字符数÷4，包括 JSON 转义、元数据和旧格式的两个文本块；这是估算，不是真实模型 Token 硬上限。

candidateFiles 最多 20 个，仅表示优先，仍可能追加符号检索结果。focusAreas 最多 5 个现有文件或目录，仅取目录直属代码文件，最多追加 8 个、每目录最多检查 1000 项；不支持 glob，勿传 src/**/*.ts。路径必须在工作区内，缺失/不可读/选择上限查看 fileIssues，不盲目重复相同参数。

已知位置时选择最小取证范围，避免再做全仓库符号查询：

```json
{"task":"核对保存逻辑","lineRanges":[{"file":"src/Service.cs","startLine":50,"endLine":80}],"maxTokens":2000}
```

lineRanges 为闭区间、1 起始行号，最多 8 个文件，每文件一个范围、最多 500 行；越界报告缺口，预算不足仍可能截断。它跳过符号搜索，仅返回指定范围；不能与 symbol 或 includeFullText=true 同用。

取证路由与停止条件：已知行号直接 lineRanges；已知文件和声明名用 scopeFiles+symbol；仅知道文件用 scopeFiles；需要发现其他文件时才用 candidateFiles/关键词检索。先检查片段是否覆盖问题所需代码，覆盖则继续分析，不例行再拉全文或重复相同范围。重名/缺失时收窄文件或转向已知行号；语义完整性不足需要相应语义工具，重复同一正则请求不能补足。文件修改、工作区切换、截断或新问题需要不同代码时重新取证；本工具没有跨调用证据有效期保证，不能把旧片段当成当前文件。

维护者可运行 npm run benchmark:agent -- 1 做单轮检查，或 -- 3 做三轮对照；报告在 test-tmp/agent-efficiency。它比较十类固定脚本场景（含既有 C# 夹具）的调用、返回字符、重复显示行和证据断言，使用真实 MCP handler 与本地回退，关闭外部后端。数据不代表真实用户任务频率、模型完成率或缓存收益，不据此宣称通用提速。Schema v2 校验当前文件、行号、正文和状态，异常保留为失败记录；复用只依赖受控夹具的可信无变化事件，修改后必须重取，不能作为生产环境的新鲜度判断。

仅知道文件时用 scopeFiles:["src/Service.cs"] 排他限定最多 20 个文件；它跳过全仓库符号搜索，不能与 focusAreas 同用，candidateFiles/lineRanges 必须在其内。需要声明附近片段可加 symbol:"Save"：大小写精确匹配，必须提供 scopeFiles，目前复用 C#/TS/JS/Python 本地声明模式，并非语义解析，queryComplete=false。重名、未找到或不支持语言会返回 fileIssues，不用文件开头冒充命中；可用已知行号进一步消歧。

metrics.selectedFiles 是选择数，packedFiles 是打包器实际处理数（片段模式为片段数），returnedFiles 是返回正文覆盖数；打包器缺少正文位置时为 null。relatedFiles.bodyStatus 表示 complete/partial/omitted/unknown；片段模式的 complete 仅表示该片段完整，不表示整个文件完整。小预算先裁辅助列表，metadataTruncated 提示列表可能不全。

2000 是首轮建议预算；证据不足再定向补充，确需文件正文才设 includeFullText=true。中文任务优先附上明确符号。startLine/endLine 是本次片段实际覆盖行，line 是其中的符号声明行；locationKind=file-start 只说明读到文件开头，evidenceInsufficient=false 不保证已取得回答问题所需的代码。完整模式的 packedContent 是正文，候选元数据不保证打包结果完整。

保留 queryComplete、truncated、metadataTruncated、limitationsOmitted、omittedFiles/omittedFileCount 等字段的含义；预算裁剪后不得把缺失当成不存在。根据缺口收窄候选或增加预算，勿例行拉取全文。

检查 source、queryComplete、uniqueResolution/uniqueTypeMatch 与 limitations。文本回退不保证语义引用完整；零引用、UNKNOWN 或未找到均不证明可安全删除。

若已有影响报告，直接据此规划，不为获得通用清单再次调用 plan_refactoring。该工具仍会做影响分析；它返回的 evidence 保留歧义、降级和 UNKNOWN，不代表已经执行重构。

仅在用户授权移除文件时使用 wincode_safe_move_to_trash({filePath:"相对路径",reason:"原因"})；它会实际移动文件。重构计划本身不执行修改。
