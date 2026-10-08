# 代码与工作区

先按目标取证，再按结果中的缺口补读。连接固定到启动工作区；已知正确根就直接查询。workspace_open 用于确认或恢复同根，换项目需对应连接。版本或工作区不符见[诊断手册](diagnostics.md)。

## 选择读取方式

| 已知信息或目标 | 用法 |
|---|---|
| 文件与行号 | prepare_context 的 lineRanges，直接读所需分支 |
| 文件与声明名 | scopeFiles + symbol；仅声明附近片段 |
| 文件但位置未知 | file_outline 后按 nextRequest 续读，或 scopeFiles 预览 |
| 只知道关键词 | search_text 限定 scopePaths，再读命中位置 |
| C# 精确引用 | Roslyn 搜索并消歧，再传完整 location |
| 项目概览或依赖 | workspace_open / list_directory / analyze_workspace |

已有文件读取工具且位置明确时，可直接有界读取，不必绕经 MCP。默认声明窗口通常只有24行，审查异常处理或资源释放时要覆盖相关分支；不要把片段完整当成整个方法完整。取得足够证据后继续分析，不例行拉全文。

## 工具字段

参数以当前 Schema 为准。名称区分大小写，未知字段可能被忽略；scopeFile 不能代替 scopeFiles，symbolName 不能代替查符号时的 query。原始参数总上限64KiB UTF-8 JSON。

| 导航工具 | 必填字段 | 可选字段及范围 |
| --- | --- | --- |
| `wincode_search_text` | `query`：非空白单行字面量，最长 256；不接受正则表达式 | `scopePaths`：1–20 个字面文件或目录，默认工作区；`caseSensitive`：布尔值，默认 false；`maxResults`：整数 1–200，默认 50；`maxOutputChars`：整数 2048–32768，默认 8000 |
| `wincode_file_outline` | `file`：工作区内字面文件 | `maxSymbols`：整数 1–200，默认 100；`maxOutputChars`：整数 2048–32768，默认 8000 |


| 工具 | 必填字段 | 可选字段及类型 |
| --- | --- | --- |
| `workspace_open` | `path`: 非空字符串，最长 4096 | `includeTree`: 布尔值；`maxOutputChars`: 整数 2048–32768，默认 8000 |
| `wincode_list_directory` | 无 | `path`: 非空字符串，最长 4096，默认 `.`；`maxDepth`: 整数 1–5，默认 1；`maxEntries`: 整数 1–500，默认 100；`maxOutputChars`: 整数 2048–32768，默认 8000；`includeIgnored`: 布尔值，默认 false |
| `wincode_analyze_workspace` | 无 | `maxDepth`: 整数 1–5，默认 2；整份 JSON 最多 32768 个 UTF-16 字符 |
| `wincode_find_code_symbol` | `query`: 非空字符串 | `kind`: 字符串，按下述提供方支持范围使用；Roslyn 的 query 最长 256、kind 最长 128。此工具未声明文件范围参数，指定文件取证改用下面的 `scopeFiles` |
| `wincode_find_references` | `symbolName`: 非空字符串 | `relativePath`: 定义文件相对路径（Roslyn 用于限定候选，local-text 不据此缩小引用扫描）；`symbolLocation`: Roslyn 搜索返回的 location 对象（snapshotId/project/file/position 均必填，路径各最长 4096）；同时提供 relativePath 时必须与 location.file 一致；`limit`: 整数 1–1000，Roslyn 默认 100，必须同时提供 symbolLocation，不改变 local-text 扫描；`maxOutputChars`: 整数 2048–32768，默认 8000，两种提供方均适用 |
| `analyze_change_impact` | `target`: 非空字符串 | `symbolLocation`: 搜索返回的完整定位；提供时 target 必须是该符号的简单名称 |
| `wincode_plan_refactoring` | `target`、`goal`: 非空字符串 | `symbolLocation`: 同影响分析 |
| `wincode_safe_move_to_trash` | `filePath`: 工作区内相对路径字符串 | `reason`: 字符串；该工具实际移动文件，须符合用户授权 |

导航使用字面路径，不支持 glob 或根外链接；默认跳过生成目录。search_text 单文件256KiB、合计8MiB、最多5000枚举项，输出限制也可能截断。检查 foundItems/returnedItems、fileIssues/fileIssuesOmitted 和扫描完整性。

`kind` 随提供方而异：local-text 支持有限 C#/TS/JS/Python 声明模式；Roslyn 支持 class/interface/struct/enum/type/method/property，构造函数归 method。query 是忽略大小写的名称子串；Roslyn kind 大小写精确，local-text kind 忽略大小写。prepare_context.symbol 则为大小写精确声明名。

wincode_analyze_change_impact 是 analyze_change_impact 的公布别名，wincode_workspace_open 是 workspace_open 的兼容别名；使用实际 tools/list 中的名称。

## 定向上下文

wincode_prepare_context 参数：

| 字段 | 类型与数量 | 规则 |
| --- | --- | --- |
| `task` | 必填字符串，非空白，最长 8192 | 描述要核对的问题 |
| `candidateFiles` | 可选字符串数组，最多 20，每项最长 1024 | 优先候选，**不排他**；与 `scopeFiles` 同用时须在其内 |
| `scopeFiles` | 可选字符串数组，1–20，每项最长 1024 | 排他范围；不能与 `focusAreas` 同用 |
| `symbol` | 可选字符串，最长 128，不含空白 | 大小写精确声明名；必须有 `scopeFiles`，不能与 `lineRanges` 同用 |
| `lineRanges` | 可选对象数组，1–8 | 每项必填 `file`（非空字符串，最长 1024）、`startLine/endLine`（正整数）；1 起始闭区间、起点≤终点、每段≤500行，每文件仅一段；若有 scope，必须在 scope 内；不能与 `symbol` 或 `includeFullText:true` 同用 |
| `focusAreas` | 可选字符串数组，最多 5，每项最长 1024 | 文件或目录；不支持通配符 |
| `compress` | 可选布尔值 | 仅在全文且实际使用 CLI 时转发压缩选项；内置降级不做 AST 压缩 |
| `outputFormat` | 可选字符串 `markdown/xml` | 默认 `markdown`，用于打包正文 |
| `includeFullText` | 可选布尔值 | 默认 `false`；`true` 仍受总预算约束 |
| `responseFormat` | 可选字符串 `compact/legacy` | 默认 `compact`；两种形式都计入文本预算 |
| `maxTokens` | 可选整数 512–65536 | 默认 8000；按 UTF-16 字符÷4估算，并非精确模型 token |

例如，已知保存逻辑所在行：

```json
{"task":"核对保存失败时的资源释放","lineRanges":[{"file":"src/Service.cs","startLine":50,"endLine":80}],"maxTokens":2000}
```

先读 summary 的 scope/status/nextAction，再核对正文与 coverage。requested-lines、packed-files、displayed-snippets 是不同范围；complete 只描述该范围。lineRanges 检查 allRequestedCovered、completeLines、missingRanges；endLineComplete:false 时补读整条尾行。越界可用返回的有效交集 nextRequest；maximum-budget-without-progress 时改用文件读取，不重复原请求。

symbol 只读取声明附近窗口，symbolCoverage:unknown；必要时用 nextRequest 继续。scopeFiles/symbol 的 coverage 可能为 null，不能据 queryComplete 或非空正文认定整个方法已覆盖。candidateFiles 只是优先候选，排他范围必须使用 scopeFiles；focusAreas 仅有限发现目录直属文件。

检查 relatedFiles.bodyStatus/bodyStatusScope、truncated、metadataTruncated、omittedFiles 和 fileIssues。selectedFiles、packedFiles、returnedFiles 含义不同，无法计数时可为 null。maxTokens 是 UTF-16 字符÷4的估算，计入元数据和转义，不是真实模型 token。默认 compact 返回一个JSON块；legacy 还返回Markdown，两者都计入预算。

文本结果不构成跨请求原子快照。文件编辑、更换连接或需要新的代码范围时重新取证；临时 overflow 附件失效时重新获取上下文，不删除整个缓存。

## 文本与 Roslyn 引用

默认 source=local-text：有限声明扫描与文本引用线索，不提供编译器身份。lexical-uncertainty、degraded、queryComplete:false 表示实际限制；即使文本扫描完整也不能证明语义完整。实例提供方看 hello.codeProvider，不能只看 health.text.semanticConfigured。

Roslyn 引用流程：

1. `wincode_find_code_symbol({query:"Save"})`，按 signature、file、location.project 选择声明。
2. 原样传回所选 name/location：

```javascript
wincode_find_references({symbolName: selected.name, symbolLocation: selected.location})
wincode_analyze_change_impact({target: selected.name, symbolLocation: selected.location})
```

location 含 snapshotId、project/file 和零基 UTF-16 position；不猜偏移、不选首个同名项。不带 symbolLocation 的 Roslyn 引用请求只返回候选。编辑受跟踪输入、重载、释放 Host 或更换连接后旧定位可能失效；按错误重新搜索。

引用的 limit 与最终 maxOutputChars 分别约束条数和文本。totalReferences 是当前快照发现数，returnedReferences 是返回数；检查 referencesTruncated/outputOmissions，必要时在有效 location 上提高预算。这不是分页，也不扩大生成代码、动态调用或未加载项目的覆盖。影响分析只聚合实际返回引用；未知总数或截断可为 null。已有影响报告时直接据其规划，不为通用步骤再次调用 plan_refactoring。

Roslyn 当前排除分析器／生成器，queryComplete 为 false；零引用不证明可以删除。diagnosticSummary 的 compilationErrorCount/loadDiagnosticCount 是快照计数，samplesDisplayed/samplesOmitted 区分样例与省略。countsComplete 不包括未加载项目、分析器或警告，也不提高查询完整性。多个同名组件按路径和项目身份区分，不按显示名合并。

## 显式配置 Roslyn

仅在用户允许项目求值时用启动参数 `--roslyn-config <绝对JSON路径>`；不从目标仓库自动发现并执行配置。MSBuild 设计时求值可能执行 targets，不会自动 restore 或安装SDK。

```json
{"enabled":true,"allowProjectEvaluation":true,"project":"App/App.csproj","configuration":"Debug","targetFramework":"net10.0","dotnetPath":"C:/dotnet/dotnet.exe","hostPath":"C:/WinCode/tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll","additionalInputs":[]}
```

路径是示例。project 相对固定工作区，dotnetPath/hostPath 为实际绝对普通文件；不支持链接。配置最多16KiB；loadTimeoutMs 默认120000、范围1–120000，queryTimeoutMs 默认30000、范围1–60000。配置、TFM与入口固定于实例，改变后需重建连接。

additionalInputs 用于非标准构建数据：最多32个工作区内相对文件，数组JSON最多4096个UTF-16字符；不接受目录、glob、重复或链接。缺失输入应恢复或修正配置，不静默删除。自动跟踪已加载源码、项目、引用及常规构建配置，不保证发现自定义 targets 的任意外部输入；diskFreshnessVerified/externalCustomInputsVerified 仍为 false。

INPUT_BUDGET_EXCEEDED 时缩小合法输入范围，不接受截断快照。默认发现排除生成／缓存目录，实际加载与显式输入优先。内部 Host 协议不作为 MCP 参数发送；维护时以交付源码为准。交付需完整 Code Host publish 目录，包括依赖和 BuildHost-netcore，不能只复制DLL。

## 文件移除

仅在任务授权移除文件时调用 wincode_safe_move_to_trash；重构计划本身不执行修改。查看 outcome：

- completed：文件移动和元数据均完成。
- not_moved：未移动，检查 failureStage 和实际文件状态。
- partial：已移动但元数据失败。保留 originalPath/trashPath/metadataPath 并告知实际位置，不重复移动或自动移回；metadataPath 不证明内容已写入。

取消或断连不代表回滚。恢复依据完整路径和成功写入的元数据，不从截短的展示文件名猜原路径。
