# 代码与工作区

以下为 MCP 工具名和参数；以客户端实际 Schema 为准。

0.13.1 的本地声明扫描覆盖 .cs/.ts/.tsx/.js/.jsx/.py，屏蔽注释、字符串以及整个 JSX 元素（含其中的表达式），签名与行号仍来自原文。无法可靠定界、未闭合或嵌套超限的文件标记 lexical-uncertainty，queryComplete=false 且不缓存完整空结果；这不是完整语法解析，复杂声明可能省略。引用搜索仍为文本线索，不提供编译器语义或精确身份。

`analyze_change_impact` 及其别名返回一个 JSON 文本块，formattedReport 保留在对象中，不再返回第二份重复 Markdown。没有新增 responseFormat 参数，不要给该工具传 context 专用的格式字段。

## 后端与能力边界

默认 Gateway 使用 WinCode 内置文本能力，`source=local-text`，健康状态明确 semanticConfigured=false。显式启用 Roslyn 后使用直接 Code Host，失败会报错，不会偷偷改换提供方。外部 Serena 连接配置、启动器及旧 `serena-adapter-fallback` 来源已退役；旧调用方须适配。`hello.codeProvider` 标明实例选择，不能根据仓库中存在 Host 推断当前连接已更新。

Roslyn 调用顺序：用 wincode_find_code_symbol 搜索（query 最长 256 字符），根据 signature、file 和 location.project 选择具体声明；再把该项的 name 作为 symbolName、完整 location 对象作为 symbolLocation 传给 wincode_find_references。location 包含 snapshotId（32 位小写十六进制）、project/file（工作区内相对路径）和 position（非负零基 UTF-16）。不手工猜偏移；同名/重载返回候选，不能自动选第一项。简单名称查询在当前不完整范围下只返回候选，单候选也需明确定位；candidatesTruncated=true 时 candidateCount 可能缺省，不能当作全量计数。

受跟踪输入的变化、重载或工作区切换会使 location 失效；无关文件编辑不等于编译输入变化。SNAPSHOT_STALE/INPUTS_CHANGED 后，下一次显式符号搜索执行所需重载；失败请求不自动重放。若源码编辑后直接搜索，首个请求也可能报告过期，再显式搜索恢复。HOST_RESTART_REQUIRED 按诊断手册重新打开工作区。本地文本实例明确拒绝 symbolLocation；旧 namePath/重载序号不能迁移为 Roslyn 身份。semanticContext 保留快照、输入检查点、排除生成器数和范围，queryComplete=false 时零引用仍不能证明可删除。

维护者可用启动参数 `--roslyn-config <配置 JSON 的绝对路径>` 显式选择；不从目标仓库自动发现执行配置。JSON 对应宿主 WinCodeConfig.adapters.roslyn，最多 16 KiB，示例路径须替换成已安装/已构建的实际文件：

```json
{
  "enabled": true,
  "allowProjectEvaluation": true,
  "project": "App/App.csproj",
  "configuration": "Debug",
  "targetFramework": "net10.0",
  "dotnetPath": "C:/dotnet/dotnet.exe",
  "hostPath": "C:/WinCode/tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll",
  "additionalInputs": []
}
```

allowProjectEvaluation 表示允许 MSBuild 设计时求值执行项目 targets，须符合用户授权；不会自动 restore 或下载 SDK。project 是相对当前工作区的固定入口；A→B 切换后使用 B 中同一路径，缺失就报错，不猜其他项目。配置和 TFM 当前固定于实例，要改变它们需更新启动配置并重启 Gateway。dotnetPath/hostPath 必须为绝对普通文件，重解析路径不支持；子进程使用指定 dotnet 的安装根，不改系统环境。可选 loadTimeoutMs 为 1–120000（默认 120000），queryTimeoutMs 为 1–60000（默认 30000），不属于 MCP 请求参数。

维护验收使用 `npm run test:roslyn-host`（独立 Host）和 `npm run test:roslyn-gateway`（真实 stdio MCP）。维护脚本按显式 WINCODE_DOTNET_PATH、项目 .deps、DOTNET_HOST_PATH、PATH 顺序寻找已安装 SDK，并核对 global.json 的精确版本；不下载安装。当前要求 10.0.303。这些脚本只还原生成夹具，保留 test-tmp 报告；Gateway 验收使用完整发布目录的异地副本。此验收不证明当前 Codex 连接已更新或无 SDK 的机器可运行。

`additionalInputs` 是可选启动配置，默认空数组。例如自定义构建读取现存的 `schema.yaml` 和非标准导入 `build-inputs/custom.rules`，可填 `["schema.yaml","build-inputs/custom.rules"]`。最多 32 个工作区相对文件路径，数组 JSON 最长 4096 个 UTF-16 字符；不接受根外/绝对路径、重复项、目录、通配符或链接。缺失项报 INPUT_UNAVAILABLE，不静默删除；创建或恢复文件后再显式搜索。切换工作区后列表按新根解释，各根均须具备所列文件。修改列表需更新启动配置并重启 Gateway，普通 MCP 参数不能添加输入或获取项目执行许可。

Host 通过独立进程的 JSON 行协议 v2 工作，非 MCP tools/call：启动参数为 `--allow-project-evaluation ROOT PROJECT CONFIGURATION FRAMEWORK [ADDITIONAL_INPUTS_JSON]`；加载后 ready 帧给出 protocolVersion=2、snapshot 及 inputPolicy={version:1,additionalInputs:[...]}。Gateway 必须核对实际列表；旧 Host 缺少输入策略确认或列表不一致时拒绝接入，即使同为协议 v2 也不能假定兼容。项目求值可能执行 targets，不自动 restore；本维护验收只使用获准的生成夹具。协议及启动方式以源码 `tools/WinCode.Code.Host/Program.cs` 注释为准，尚非稳定公共接口。

| 内部 operation | 请求与结果 |
| --- | --- |
| `symbols` | 必填 id、snapshot、query，可选 kind/file；最多返回 200 个声明，totalFound/truncated 说明截断，location 给出可用于引用的当前快照定位。超时与 references 相同 |
| `references` | 必填 id、snapshot、project、file、position；project/file 是工作区内路径，position 为零基 UTF-16 偏移。返回 line/column 一基，start/length 零基 UTF-16。timeoutMs 为 1–60000，默认 30000；limit 为 1–1000，默认 100，只约束返回条数 |
| `reload` | 必填 id；固定根、入口项目、配置和 TFM 内重新求值，成功返回新的 ready/snapshot，调用者须重新定位符号。timeoutMs 为 1–120000，默认 120000；开始重载后失败或取消不会恢复旧身份 |
| `cancel` | 必填 id、targetId；cancellationRequested 仅确认是否向活动目标发出了取消，目标仍有独立结果，不代表立即完成或回滚 |
| `shutdown` | 必填 id；停止接纳、取消并排空请求、释放工作区后才返回成功。stdin EOF 同样清理，但没有 shutdown 确认帧 |

每帧还须包含 operation；id 为 1–128 字符且活动期间不可重复。队列最多等待 8 项，满时 BUSY；timeoutMs 从接纳起计算，包含排队，Host 本身执行协作取消。Gateway 超时/取消先等待目标收尾，超过 1 秒宽限才回收自有 Host 进程树；初次加载尚不能接收 cancel 时直接回收。Windows Host 在加载前绑定自有 Job，以覆盖普通子进程继承的退出行为；这不是沙盒，也不约束 targets 通过外部服务启动的进程。请求帧最多 65536 个 UTF-16 字符，Node 接收帧最多 1 Mi 字符，超长使通道失效。SDK/global.json、监听或资源释放故障可能要求新进程，不能循环 reload。

Host 监听变化并在查询前后比较内容指纹，变化时丢弃结果并要求显式 reload。每次加载尝试前用最多四个 50 ms 观察窗收敛输入事件，受请求取消预算约束；持续写入仍失败。求值期间的内容/事件检查继续保留，不自动重放请求。freshness.scope=compilation-inputs-and-explicit-files，自动候选包括 .cs/.csproj/.props/.targets、.xaml/.resx/.resw/.resources、.config/.ruleset，global.json、project.assets.json、packages.lock.json、.editorconfig/.globalconfig 及 *.nuget.dgspec.json。同时跟踪实际加载的文档、AdditionalFiles、分析配置、程序集引用和祖先常规构建配置；新增源码仍经 MSBuild 的 Compile 规则决定是否加载，不因发现 .cs 就直接加入项目。

默认枚举排除 .git、node_modules、.deps、bin、dist、build、.cache、.vs、.packages、test-tmp、trash；实际加载或显式补充的文件优先于目录排除。非标准扩展名导入、排除目录中的自定义配置，以及自定义 targets 隐式读取的数据，应通过 additionalInputs 补充；不能承诺自动发现任意构建依赖。普通 README、视频和未加载的二进制文件不占输入字节预算。文件清单仍需有界枚举，极大目录仍可能超限；预算为最多 20000 个枚举条目、5000 个输入文件、总计 128 MiB、单个输入 32 MiB。必要输入或显式补充文件超限仍失败，不接受截断快照。内容核查流式计算摘要，仅冻结文档时保留源码正文；不支持重解析路径。

自定义 targets 的任意外部输入和整个磁盘原子快照尚未验证，所以仍保留 diskFreshnessVerified=false、externalCustomInputsVerified=false。queryComplete 当前为 false；排除的分析器/生成器、加载及编译诊断须保留，零引用不证明安全删除。普通 MCP 请求使用下方规范字段；snapshotId 仅出现在 symbolLocation/semanticContext 内，不单独作为顶层参数发送。未知字段可能被忽略，成功响应不证明新参数生效。TS/JS/Python 的限定文件文本取证仍走 prepare_context，不把 Roslyn 声明搜索当成多语言语义服务。

## 规范字段

兼容容忍模式允许额外字段，但会忽略它们，不能据“调用成功”判断参数已经生效。例如 `scopeFile`、`scope_files` 均不是 `scopeFiles`，`symbolName` 不能代替查符号工具的 `query`。未知字段不能补足缺失必填项；已知字段填错类型、空白必填值或违反范围规则仍会报错。下面列出的名称区分大小写，未列出的参数不应发送。

| 工具 | 必填字段 | 可选字段及类型 |
| --- | --- | --- |
| `workspace_open` | `path`: 非空字符串，最长 4096 | `includeTree`: 布尔值；`maxOutputChars`: 整数 2048–32768，默认 8000 |
| `wincode_list_directory` | 无 | `path`: 非空字符串，默认 `.`；`maxDepth`: 整数 1–5；`maxEntries`: 整数 1–500；`maxOutputChars`: 整数 2048–32768；`includeIgnored`: 布尔值 |
| `wincode_analyze_workspace` | 无 | `maxDepth`: 数字，默认 2 |
| `wincode_find_code_symbol` | `query`: 非空字符串 | `kind`: 字符串，常用 `class/interface/method/function/type/enum`；此工具未声明文件范围参数，指定文件取证改用下面的 `scopeFiles` |
| `wincode_find_references` | `symbolName`: 非空字符串 | `relativePath`: 定义文件相对路径；`symbolLocation`: Roslyn 搜索返回的 location 对象（snapshotId/project/file/position 均必填，路径各最长 4096）；同时提供 relativePath 时必须与 location.file 一致 |
| `analyze_change_impact` | `target`: 非空字符串 | `symbolLocation`: 搜索返回的完整定位；提供时 target 必须是该符号的简单名称 |
| `wincode_plan_refactoring` | `target`、`goal`: 非空字符串 | `symbolLocation`: 同影响分析 |
| `wincode_safe_move_to_trash` | `filePath`: 工作区内相对路径字符串 | `reason`: 字符串；该工具实际移动文件，须符合用户授权 |

`wincode_analyze_change_impact` 是 `analyze_change_impact` 的公布别名；`wincode_workspace_open` 是 `workspace_open` 的历史兼容别名。别名共享参数和执行规则，优先使用本连接 tools/list 公布的名称。其余字段名不接受自动拼写纠正。

`wincode_prepare_context` 的完整规范字段如下。路径均为工作区内的字面路径，不是 glob。

| 字段 | 类型与数量 | 规则 |
| --- | --- | --- |
| `task` | 必填字符串，非空白，最长 8192 | 描述要核对的问题 |
| `candidateFiles` | 可选字符串数组，最多 20，每项最长 1024 | 优先候选，**不排他**；与 `scopeFiles` 同用时须在其内 |
| `scopeFiles` | 可选字符串数组，1–20，每项最长 1024 | 排他范围；不能与 `focusAreas` 同用 |
| `symbol` | 可选字符串，最长 128，不含空白 | 大小写精确声明名；必须有 `scopeFiles`，不能与 `lineRanges` 同用 |
| `lineRanges` | 可选对象数组，1–8 | 每项必填 `file`（字符串）、`startLine/endLine`（正整数）；1 起始闭区间、起点≤终点、每段≤500行，每文件仅一段；若有 scope，必须在 scope 内；不能与 `symbol` 或 `includeFullText:true` 同用 |
| `focusAreas` | 可选字符串数组，最多 5，每项最长 1024 | 文件或目录；不支持通配符 |
| `compress` | 可选布尔值 | 仅在全文且实际使用 CLI 时转发压缩选项；内置降级不做 AST 压缩 |
| `outputFormat` | 可选字符串 `markdown/xml` | 默认 `markdown`，用于打包正文 |
| `includeFullText` | 可选布尔值 | 默认 `false`；`true` 仍受总预算约束 |
| `responseFormat` | 可选字符串 `compact/legacy` | 默认 `compact`；两种形式都计入文本预算 |
| `maxTokens` | 可选整数 512–65536 | 默认 8000；按 UTF-16 字符÷4估算，并非精确模型 token |

不要用 `"2000"` 代替 `2000`、`"false"` 代替 `false`，也不要把 `{name:"Save"}` 当作搜索字符串。额外字段容忍并不会放宽这些类型规则。返回结果中的 `coverage`、`queryComplete`、`runtime` 等是证据字段，不能作为未声明的请求参数获得相应能力。

## 按任务取证

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

选定 Roslyn 重载后，将其 name 和 location 原样传给后续工具：引用使用 symbolName，影响分析及重构使用 target，同时传 symbolLocation。后两者先验证定位再分析，不按名字重选目标；SNAPSHOT_STALE/INPUTS_CHANGED 时须重新搜索。简单名称歧义检查 resolution/candidateCount/candidatesTruncated，不能选第一项。queryComplete=false 不等于零引用。

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

取证路由与停止条件：已知行号直接 lineRanges；只需声明附近片段时用 scopeFiles+symbol。审核已知方法的异常处理、取消或资源释放时，默认 24 行窗口往往不足；若已有文件读取工具，优先用有界 rg 上下文和文件读取一起覆盖所需分支，不必先调用 MCP 再逐段续读。小文件也可用 scopeFiles+includeFullText:true 在预算内读取正文，仍检查截断。仅知道文件用 scopeFiles 预览；需要发现其他文件时才用 candidateFiles/关键词检索。先检查片段是否覆盖问题所需代码，覆盖则继续分析，不例行再拉全文或重复相同范围。重名/缺失时收窄文件或转向已知行号；语义完整性不足需要相应语义工具，重复同一正则请求不能补足。文件修改、工作区切换、截断或新问题需要不同代码时重新取证；本工具没有跨调用证据有效期保证，不能把旧片段当成当前文件。

维护者可运行 npm run benchmark:agent -- 1 做单轮检查，或 -- 3 做三轮对照；报告在 test-tmp/agent-efficiency。它比较十类固定脚本场景（含既有 C# 夹具）的调用、返回字符、重复显示行和证据断言，使用真实 MCP handler 与本地回退，关闭外部后端。数据不代表真实用户任务频率、模型完成率或缓存收益，不据此宣称通用提速。Schema v2 校验当前文件、行号、正文和状态，异常保留为失败记录；复用只依赖受控夹具的可信无变化事件，修改后必须重取，不能作为生产环境的新鲜度判断。

仅知道文件时用 scopeFiles:["src/Service.cs"] 排他限定最多 20 个文件；它跳过全仓库符号搜索，不能与 focusAreas 同用，candidateFiles/lineRanges 必须在其内。需要声明附近片段可加 symbol:"Save"：大小写精确匹配，必须提供 scopeFiles，目前复用 C#/TS/JS/Python 本地声明模式，并非语义解析，queryComplete=false。重名、未找到或不支持语言会返回 fileIssues，不用文件开头冒充命中；可用已知行号进一步消歧。

metrics.selectedFiles 是选择数，packedFiles 是打包器实际处理数（片段模式为片段数），returnedFiles 是返回正文覆盖数；打包器缺少正文位置时为 null。relatedFiles.bodyStatus 表示 complete/partial/omitted/unknown；片段模式的 complete 仅表示该片段完整，不表示整个文件完整。小预算先裁辅助列表，metadataTruncated 提示列表可能不全。

Repomix CLI 的 fileCount 使用独立运行摘要中的文件数，不从正文中的 File 标题估算；空包可以为 0。若已安装 CLI 的摘要格式不受支持或被配置静默隐藏，则明确降级为 builtin-fallback，并在适配器 lastError 记录原因。CLI 快照计数正确不代表其每个正文都有 WinCode 可用的位置映射。

bodyStatusScope 明确该字段描述 displayed-snippet 或 packed-file。symbol 请求返回声明附近窗口，symbolCoverage=unknown；即使 bodyStatus=complete 也不能认定整个方法完整。若所需逻辑仍在后方，可使用该证据的 nextRequest 续读最多 80 行；补读从最终尾行之后开始，半截尾行会完整重读。它不推测方法结束位置、不证明调用链完整，fileLineCount 仅为读取时的行数；编辑后重新定位。EOF 不再建议补读，最大预算无法读取完整长行时转用文件读取工具。

2000 是首轮建议预算；证据不足再定向补充，确需文件正文才设 includeFullText=true。中文任务优先附上明确符号。startLine/endLine 是本次片段实际覆盖行，line 是其中的符号声明行；locationKind=file-start 只说明读到文件开头，evidenceInsufficient=false 不保证已取得回答问题所需的代码。完整模式的 packedContent 是正文，候选元数据不保证打包结果完整。

保留 queryComplete、truncated、metadataTruncated、limitationsOmitted、omittedFiles/omittedFileCount 等字段的含义；预算裁剪后不得把缺失当成不存在。根据缺口收窄候选或增加预算，勿例行拉取全文。

检查 source、queryComplete、uniqueResolution/uniqueTypeMatch 与 limitations。source=roslyn 是编译器语义来源，不是文本回退；queryComplete=false 可以表示生成器或加载图等覆盖缺口，不能直接解释为执行中断或要求原样重试。文本回退不保证语义引用完整；零引用、UNKNOWN 或未找到均不证明可安全删除。

影响分析用完整工作区文件路径及可用的项目身份区分组件，targetFile 和组件 name 仍是展示名称；不同目录同名组件可以分别出现，不要按 name 再合并。提供目录的 target 按工作区解析；只有纯文件名才用于候选匹配。Host 冻结源码沿用 Roslyn/MSBuild 的 CodePage 与 BOM 编码，返回位置仍按解码后的 UTF-16 文本计算，不按原始文件字节偏移定位。

若已有影响报告，直接据此规划，不为获得通用清单再次调用 plan_refactoring。该工具仍会做影响分析；它返回的 evidence 保留歧义、降级和 UNKNOWN，不代表已经执行重构。

仅在用户授权移除文件时使用 wincode_safe_move_to_trash({filePath:"相对路径",reason:"原因"})；它会实际移动文件。重构计划本身不执行修改。

trash 响应保留 success/trashPath/message，并用 outcome 区分 completed（移动及元数据完成）、not_moved（本次未移动）、partial（已移动但元数据未完成）。partial 的 errorCode=TRASH_METADATA_FAILED、failureStage=metadata，originalPath/trashPath/metadataPath 给出原位置、实际移动位置及预期元数据位置；metadataPath 不证明元数据完整。立即保留并告知用户实际 trashPath，不把 success=false 当作未执行，不重复移动或自动移回。not_moved 的 trashPath 为空，errorCode=TRASH_NOT_MOVED；先检查 failureStage 和文件实际状态。重启不会自动补写元数据或推断原路径；丢失 partial 响应时，本实现不保证自动恢复原目录映射。

回收站目标名含唯一标识，过长的原文件名展示部分会截短，以给元数据文件名预留空间；完整原路径保存在 originalPath 和成功写入的元数据中。恢复时使用这些路径，不从截短的目标名推断原文件名或扩展名。

交付时保留 Code Host 整个 publish 目录，包括 deps/runtimeconfig、Roslyn 依赖及 BuildHost-netcore 子目录。`npm run check` 生成并核对交付清单；Host ready 身份必须与 Gateway 版本一致且为 Release、协议 v2，否则 HOST_VERSION_MISMATCH。不要仅复制入口 DLL，也不要把版本握手等同于运行时文件防篡改。
