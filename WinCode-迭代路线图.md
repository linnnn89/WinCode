# WinCode 迭代路线图

更新日期：2026-09-08（北京时间）

用途：后续开发、审查与验收的工作参考。本文记录建议和决策边界，不表示其中功能已经实施或发布。

## 1. 当前结论与优先顺序

下一阶段先解决真实使用中的上下文浪费与版本错配，再修正语义查询正确性，随后扩展 UI 到源码的调查能力。

| 顺序 | 迭代 | 目标 | 完成门槛 |
| --- | --- | --- | --- |
| 1 | R1：首次打开工作区减量 | `workspace_open` 默认只返回身份、项目摘要和少量入口，目录按需读取 | 宽目录和发布产物不能撑爆首次响应；摘要仍足以开始任务 |
| 2 | R2：运行实例与能力核对 | 区分源码、构建产物、运行实例、客户端缓存的工具定义 | 能识别旧构建或旧工具参数，给出准确的重连/重建指引 |
| 3 | R3：精准取证闭环验收 | 在实际连接中重验同一 TavernDesk 任务 | 目标方法和实际源码范围正确；覆盖不足、截断和缺失原因可核对 |
| 4 | R4：Serena 查询契约修复 | 完整保留符号身份，消除自动选首项和虚假零结果 | 同名、重载、解析失败及上游降级均不产生错误的确定性结论 |
| 5 | R5：MCP SDK v2 独立迁移 | 在兼容性方案明确后偿还协议依赖技术债 | 网关与 Serena client 同时迁移，既有工具行为和生命周期通过回归 |
| 6 | R6：UI → XAML → C# 调查链 | 将已有运行时证据与源码候选串联 | 能提供控件状态、XAML 声明及相关 C# 候选，同时保留证据边界 |
| 7 | R7：按需 MSBuild 求值 | 解决真实项目的条件配置和引用偏差 | 用明确 Configuration/TFM 重现声明级解析无法回答的问题 |
| 8 | R8：WPF 深层诊断实验 | 验证 Binding/DataContext 等确有必要的新增证据 | 隔离样本证明诊断价值、运行时兼容性和资源释放，再决定集成 |
| 9 | R9：未知位置任务的 Repo Map | 改善不知道文件位置时的候选排序 | 在相同初始信息和预算下提高取证成功率，已知位置请求不增加扫描 |

R1 → R2 → R3 是用户根据实测明确提出的近期顺序。R4 仍是语义功能继续扩展前的正确性前提：R3 可先验证现有本地范围读取，不能因此宣称 Serena 语义链已经可靠。R5 之后保留原对话最终复核的排序；R7–R9 根据真实需求进入，不按版本号强行排期。

建议按独立小改动推进 R1、R2，并用 R3 作为近期交付验收。本文使用 R1–R9 作为稳定工作编号；原对话的 `0.9.1 / 0.10 / 0.11` 只是建议版本，不沿用为发布承诺。

## 2. 依据、基线与归因

### 2.1 资料与核查范围

- 路线来源：[WinCode迭代路线图](chatgpt-conversation://6a9ed4e8-dbf8-83ee-8359-3666dca09d24)。已读取可见的四轮内容，以最后一次自我复核为主要参考，同时保留此前关于解析状态、位置转换和验收的有效建议。对话提到的独立研究报告附件未在返回记录中提供，本文不将其视为已审阅的一手报告。
- 实测来源：[优化 Agent 使用效率](thread://01a07c3b-7c6a-78d2-8f06-528c2038cafe?hostId=local)。已读取最近工作记录，并结合用户本次补充的故障表与明确优先顺序。
- 本地基线：`I:\WinCode`，分支 `codex/agent-efficiency-round1`，HEAD `6fba44a7404960257e5c749210892477ad26845c`；`package.json` 和 `WINCODE_VERSION` 均为 `0.9.0`。开始整理时 Git 工作区干净。旧对话引用的 `main@b492491` 不作为本地基线，也不据此声称当前远端最新状态。
- 本次进行了源码、锁文件、文档和官方上游资料的只读核对，并对当前 WinCode MCP 做了工作区打开、版本读取和一次限定行范围读取。没有重跑 TavernDesk、GUI 验收或代码回归。

### 2.2 TavernDesk 实测：分别归因

| 现象 | 归因 | 已有证据与状态 | 对路线图的影响 |
| --- | --- | --- | --- |
| 打开项目返回发布 DLL、`.publish-verify/`、`work/` 等大量目录项 | WinCode 默认输出策略 | 历史实测由用户概括为约 5 万 token；本次未取得原始完整响应重新计量，不将其当作精确模型 token 基准。当前源码仍默认返回目录树 | R1，优先解决 |
| 源码已有精准参数，当时已连接工具未暴露这些参数及新版覆盖信息 | WinCode 构建/部署/连接与能力可见性链路 | 当时无法验证新版精准取证，候选请求返回文件头后又补 `rg` 和定点读取；不能单凭现象确定是旧 `dist`、旧进程还是客户端 schema 缓存 | R2 后接 R3，避免凭源码版本反复试新参数 |
| “角色”完整遍历 66 个节点仍未找到 | TavernDesk UI 可访问性 | 六个导航按钮已在该次工作中补齐名称和稳定标识，随后 `NavCharacters` 唯一命中；本文未再次实机验证 | 保留为 R3 的已知样本；不列为待修 WinCode 查询缺陷 |
| computer use 将 `[TEST] TavernDesk` 归属到 AiPPT，两次无法选窗 | computer use 窗口识别链路 | 该链路失败时，WinCode 仍能按明确 PID/HWND 检查和截图 | 单列外部阻碍，不据此重写 FlaUI 或新增点击功能 |
| 每次重新选择语言、导入角色 | 测试环境组织 | 该次工作已固定 `I:\New-tarven\work\TAVERN-TEST`，验证重启保留角色且不重复导入 | 后续日常验收复用专用隔离目录；首次启动测试另用全新目录 |

“已修复”在本表中指引用工作记录中的完成状态，不代表修改已进入 TavernDesk 发布包，也不代表本次重新验收通过。

### 2.3 当前代码与连接补充核查

| 核查项 | 当前发现 | 解读 |
| --- | --- | --- |
| 工作区打开 | `WorkspaceManager.openWorkspace()` 固定调用 `getDirectoryTree(2)`；网关直接序列化整个结果 | 目录树已有深度限制，但没有总节点数或整响应字符预算。大量同级文件仍可造成巨大输出，不能仅靠调小深度修复 |
| 版本信息 | 当前 MCP `wincode_hello_world` 返回 `0.9.0`、工作区和工具名列表 | 已有版本信息，但缺少构建身份与参数级能力核对；不能写成“完全没有版本接口” |
| 精准参数 | 当前会话暴露的 `wincode_prepare_context` schema 已含 `scopeFiles`、`symbol`、`lineRanges`，本次行范围调用也被接受 | 历史旧连接问题不能直接套用于本会话；这仍不足以证明 TavernDesk 全流程已通过 |
| 范围与覆盖 | 本次请求 `SerenaAdapter.ts` 第 483–705 行，实际返回 483–576，`truncated=true`；同时 `queryComplete=true`、`evidenceInsufficient=false` | 返回已标截断，但这两个字段不能代替请求范围覆盖或任务充分性判断；作为 R3 的具体反证样本 |
| 语义身份 | `CodeSymbol` 无完整 `namePath`；`findReferencesDetailed()` 缺路径时选首个候选，映射代码删除重载后缀 | 静态确认有身份丢失及误选路径；本次未连接真实 Serena 复现误查输出 |
| SDK | 声明为 `@modelcontextprotocol/sdk: ^1.6.1`，锁文件实际为 `1.30.0` | 不能将版本范围误读为运行 1.6.1；仍需区分锁文件与运行实例实际依赖 |

源码定位见 [Workspace.ts](src/Core/Workspace.ts) 的 `openWorkspace/getDirectoryTree`、[McpServer.ts](src/Gateway/McpServer.ts) 的工作区和 hello handler、[Protocol.ts](src/Gateway/Protocol.ts)、[ContextResponse.ts](src/Gateway/ContextResponse.ts) 和 [SerenaAdapter.ts](src/Adapters/SerenaAdapter.ts)。本表记录的是本文基线，后续修改后需更新。

## 3. R1：让首次打开成为紧凑摘要

**目标：打开工作区后，Agent 能确认项目身份并选择下一步，不必先接收目录清单。**

建议最小范围：

1. 默认返回规范化工作区标识、项目类型/语言、主要 solution 或工程摘要、Git 摘要和少量入口路径。树、工程明细和完整统计按需获取。
2. 对整份响应设预算，包含 JSON 转义、路径、项目数组、忽略说明与错误信息，不能只限制 `fileTree`。建议默认不超过 8,000 个 UTF-16 字符，入口不超过 8 个；这是待实施时确认的初始建议值，不是当前能力或模型 token 硬上限。
3. 目录读取复用既有扫描代码，支持指定子目录、深度、节点/条目数及响应预算。返回实际扫描范围、截断与省略原因；优先使用一次小范围浏览，不先制造分页状态服务。
4. 发布产物默认不进入入口预览，但不要把所有 `work/`、未知目录或 DLL 永久排除出用户可请求范围。浏览过滤不得改变符号检索、缓存指纹或源码纳入规则。
5. 避免为简短摘要先递归建立大树、逐项统计发布文件大小再裁掉输出；采集成本和序列化成本分别检查。首轮不引入索引数据库或后台扫描器。
6. 明确默认响应变化及兼容方式。需要旧结构的调用可按需获取有界明细；兼容模式不能恢复无上限输出。目录能力放入现有入口还是独立窄工具，在实施前结合调用方确认。

主要落点：[Workspace.ts](src/Core/Workspace.ts)、[ToolRouter.ts](src/Core/ToolRouter.ts)、[McpServer.ts](src/Gateway/McpServer.ts)、[Protocol.ts](src/Gateway/Protocol.ts)，以及对应测试和使用手册。

**验收：**相同输入下保留项目身份与关键入口；浅层宽目录、发布目录、大工程列表和大量省略说明均受同一预算约束；按需目录仍能取到明确指定的合法路径。记录首次输出字符数、耗时和补取调用数，不能以“输出少了但找不到项目”为成功。未完整扫描的统计标为部分或未知。

**反证：**`maxDepth=1` 下仍存在数百个 DLL；或者树已移除，但 `metadata.projectList/omittedDirectories` 继续随仓库规模增长。

## 4. R2：核对真正运行的实例与工具能力

**目标：在使用新参数前，先知道连接到什么构建、客户端实际能调用什么接口。**

复用现有 hello/diagnose 与 MCP `tools/list`，建议补充三类紧凑信息：

- 运行版本和构建身份：版本号、构建时嵌入的 revision/build 标识，以及必要的启动标识。构建身份未知时明示未知；不能用被分析仓库的 Git HEAD 冒充 WinCode 构建，也不能用后来更新的磁盘文件冒充已加载版本。
- 工具契约标识：从实际注册的工具定义计算 schema 标识，按需返回指定工具的支持参数。默认不重复输出所有工具的完整 JSON schema，不新建 Capability Registry。
- 核对结果：分别记录源码期望能力、运行实例声明、客户端当前暴露的 schema，以及一次实际调用结果。schema 相同不证明实现相同；相同 `0.9.0` 也不证明构建相同。

建议排查顺序：检查运行构建 → 检查实际 `tools/list`/客户端参数 → 必要时构建或重连 → 再核对一次 → 做一个小请求。遇到旧 schema，结束对新参数的重复尝试；不要自动下载更新、重启所有客户端或改全局配置。已在实施任务中获得的授权不重复申请。

验收脚本可复用已安装的 MCP SDK，在同一 stdio 会话中读取 hello、`tools/list` 并调用一个已知小范围，避免把不同进程的信息拼成一次成功核对。独立脚本只能证明它连接的进程；Codex 等宿主实际暴露的参数和真实调用还需单独核对。`tools/list_changed` 可帮助支持该通知的客户端刷新定义，但不能让旧进程自动载入新代码。

主要落点：[Config.ts](src/Core/Config.ts)、[Protocol.ts](src/Gateway/Protocol.ts)、[McpServer.ts](src/Gateway/McpServer.ts)、现有构建流程和 [代码手册](skills/wincode/references/code.md)。构建身份的生成方式应保持轻量，不另建发布平台。

**验收：**同版本不同构建能区分；只有源码更新但旧进程仍运行时不误报升级完成；服务端已更新而客户端 schema 仍旧时有明确提示；不支持的参数不得被静默忽略并返回看似成功的文件头。成功判据必须包含真实小调用，不能只有版本字符串或编译成功。

## 5. R3：验证精准取证闭环与实际覆盖

已有精准能力应先在实际连接上验收，不重新实现一套上下文工具。沿用当前路由：已知行号用 `lineRanges`；已知文件和声明名用 `scopeFiles + symbol`；仅知文件用 `scopeFiles`；不知道文件时才进行发现。

### 5.1 返回范围的最小补强

保留当前 `source`、`queryComplete`、`truncated`、`fileIssues`、`relatedFiles.bodyStatus` 及 selected/packed/returned 文件数的语义，补充可核对的请求范围与实际返回范围。字段名称在实施前确认，但应表达以下区别：

| 信息 | 必须表达的含义 |
| --- | --- |
| 请求范围 | 用户希望读取的文件、行区间或声明目标 |
| 返回范围 | 最终序列化并实际显示的源码区间，不能回显请求终点冒充实际终点 |
| 覆盖状态 | 对请求范围的完整、部分、未返回或无法判断；不等于“已经回答研究/开发问题” |
| 缺口原因 | 响应预算、片段上限、文件越界、缺失、不可读、声明歧义、不支持等实际原因 |
| 后续最小操作 | 缩小范围、补未返回区间或先消歧；只有可靠计算得到的范围才建议补取 |

若请求范围或符号本体在预算裁剪后不完整，应同步更新覆盖信息，不能只在裁剪前计算。重复片段不应被重复计入覆盖。`scopeFiles + symbol` 仍是本地声明模式匹配，不能把范围覆盖完整升级为语义查询完整。

### 5.2 同场景验收

1. 复用 `I:\New-tarven\work\TAVERN-TEST` 专用隔离环境和已导入的固定测试角色；测试前核对专用标记、数据根和启动回执。仅首次启动场景使用全新环境，避免重复初始化混入工具效率测量。
2. 先记录 WinCode 运行构建和客户端工具 schema。使用当前 TavernDesk 源码确定本次目标方法与预期范围，不凭记忆硬编码已经变化的行号。
3. 分别验证已知方法、已知行号、仅知文件、未知文件四种初始信息。已知方法请求应直接命中声明附近，而不是先返回文件头再补 shell 阅读。
4. 覆盖长方法、声明在文件末尾、超过文件末尾的请求、同名方法、小预算截断、末行只返回部分字符、多文件请求只返回一部分、缺文件、修改后重取和工作区切换。行号落在返回区间内也不证明该行正文完整；正文裁剪必须进入覆盖判断。返回不足本身允许发生，错误地宣称覆盖才是失败。
5. UI 复查继续使用当前有效 PID/HWND 和 `NavCharacters` 等稳定 selector；不复用前次响应的节点 ID。computer use 无法选窗单列，不使 WinCode 成功取证被误判失败。
6. 对修复前后使用相同初始信息、相同目标和相同预算。记录成功/失败、首次命中、总调用数、补 `rg`/定点读取次数、文本字符、重复显示行、耗时及初始化耗时。模型 token 如无可靠计量则不报告为精确值。

复用 [benchmark-agent-efficiency.ts](scripts/benchmark-agent-efficiency.ts) 与既有测试结构，先做单轮小样本；实际 TavernDesk 验收结果与合成夹具报告分开。已有十类基准采用本地回退且关闭 GUI，不能替代真实连接验证，也不能据此宣称通用 Agent 提速。

**完成门槛：**R1 输出有界、R2 连接能力已核对、R3 目标与范围正确，且每个失败能区分 WinCode、应用、computer use 或环境来源。先用这些结果决定下一步，不因仍有重复调用就直接增加跨调用缓存。

## 6. R4：修复 Serena 符号身份与解析状态

[Serena 上游源码](https://github.com/oraios/serena/blob/main/src/serena/tools/symbol_tools.py) 使用文件位置和 name path 定位符号，并明确支持重载索引。当前 WinCode 存在首项选择和身份压缩路径，值得作为独立正确性修复。

最小范围：

- `CodeSymbol` 保留上游原始 `name_path`，显示名可另行简化；`[0]`、`[1]`、容器路径不得在身份传递中丢失。
- 已有完整 name path 与文件路径时原样传给引用查询；只有简单名称时，在限定范围内唯一匹配才继续。多候选返回歧义和有界候选列表，零候选与查询失败分别表达。
- 保留 `symbolName`、`relativePath` 的既有入口，新增可选精确身份参数；检查缓存键和调用方，防止选中的身份在下一层又被还原为短名称。候选发现未完成时，单个可见结果也不能直接认定唯一。
- 区分合法空响应、缩略结果、不支持的格式和解析失败；按有证据的上游格式处理分组、kind 和行号规则，不把未知格式自动转成语义成功的空数组。
- 检查 `ImpactAnalyzer` 的身份透传和唯一性判断，不只在 Gateway 增加参数。相同文件并不天然代表唯一符号；不完整或歧义结果继续保留 `UNKNOWN`。

主要落点：[SerenaAdapter.ts](src/Adapters/SerenaAdapter.ts)、[ImpactAnalyzer.ts](src/CompositeTools/ImpactAnalyzer.ts)、[Protocol.ts](src/Gateway/Protocol.ts)、[McpServer.ts](src/Gateway/McpServer.ts)，必要时调整 [Context.ts](src/Core/Context.ts) 的身份透传。复用现有 mock Serena 与 C# 夹具；不引入通用 Symbol Service。

**验收样本：**同文件不同类同名方法、不同文件同名方法、重载、唯一符号、真实零结果、首行/其他行位置、缩略或无效响应，以及 Serena 不可用的本地降级。检查实际发出的 `name_path + relative_path` 和最终返回源码位置。mock 契约通过与真实 Serena/C# 验收分开记录。

## 7. R5：MCP SDK v2 作为独立迁移

截至 2026-09-08，官方将 v2 列为稳定版本线，并说明 v1 在 v2 发布后至少继续维护六个月。因此迁移有现实依据，但不把它描述为本次已确认的紧急漏洞，也不从“至少六个月”推定一个精确停更日。[官方仓库](https://github.com/modelcontextprotocol/typescript-sdk)

官方迁移说明要求 Node.js 20+；项目当前 README 仍声明 Node.js 18+。这意味着不能把迁移写成单纯替换 import 而忽略运行环境兼容性。MCP 包迁移与启用新协议行为也应分开，保持当前协议行为的兼容性验收。[官方迁移指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)、[协议版本迁移说明](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

`USER_DECISION_REQUIRED`：实施 R5 前确认支持的 Node.js 最低版本、SDK/Zod 依赖方案及升级范围；如果必须保留 Node.js 18，需另定维护策略，不能静默抬高门槛。

实施范围包括 Gateway server、Serena MCP client、stdio/in-memory transport、`src/`、`tests/`、`scripts/` 与相关 fixtures。按实际接口选择拆包与 schema 迁移方式；使用 codemod 也要检查整个包及未自动处理的位置。依赖安装和环境变更应纳入随后获批的实施方案，本次未执行。

**验收：**工具名/别名、输入校验、错误、取消、超时、工作区排空、子进程清理、compact/legacy 输出和图片分离均保持既定行为；实际工具列表能正常读取，客户端可以真实调用。Tool Registry 仅在迁移确有必要时局部整理，不单开大重构，也不混入新功能或新协议默认行为。

## 8. R6–R9：后续能力及进入条件

### R6：UI → XAML → C#

复用现有 `UiReview` 的单次 UI 快照及 `UiSourceMapper` 的声明线索：运行时控件 → AutomationId/文本 → XAML 候选 → `Command / Click / Binding` 字符串 → C# 声明候选 → 引用与限定上下文。当前已能提取部分声明，下一步重点是导航和紧凑组合，不能把它们重新列为未实现功能。

第一版先用显式候选文件完成小闭环；如果真实任务表明猜 XAML 文件仍是主要成本，再加有界候选文件建议。用户给定的 UI `candidateFiles` 仍是闭集；不要与代码 `prepare_context.candidateFiles` 的优先语义混淆。源码候选、命令名相似、`CanExecute` 命名惯例都不是运行时因果证明，继续保留 `runtimeSourceVerified=false`。

以“已知禁用按钮”的隔离样本验证状态、XAML、候选实现和修复后复查；同名 Command、模板复用、旧构建对应新源码、Binding 无法静态确定时必须保留缺口。UIA Host 只做为此需要的局部拆分。

### R7：按需 MSBuild 求值

进入条件是实际遇到 `Directory.Build.props/targets`、Condition、imports、多 TFM 或配置相关引用，且现有声明图产生可复现差异。沿用 [DotNetGraph.ts](src/Core/DotNetGraph.ts) 的快速声明模式，优先研究官方 `-getProperty/-getItem` 求值，明确 Configuration、TFM、来源及失败原因；第一版不引入常驻 Roslyn/MSBuild 服务。[Microsoft Learn](https://learn.microsoft.com/en-us/visualstudio/msbuild/evaluate-items-and-properties?view=vs-2022)

求值不自动附带 restore/build；在明确允许求值的工作区执行，复用现有子进程、超时、取消及资源回收。SDK/import 缺失时保留声明级结果和不完整说明，不能自动下载补齐，也不能把不同 TFM 的依赖无说明合并。

### R8：WPF 深层诊断实验

只有 R6 之后仍有真实问题被 Binding、DataContext、属性来源或模板内部信息阻塞时，才做小型实验。参考 [SnoopWPF](https://github.com/snoopwpf/snoopwpf) 和 [WPFVisualTreeMcp](https://github.com/faze79/WPFVisualTreeMcp)，验证一个已知错误 Binding、DataContext 类型/路径、.NET 10 WPF 兼容性及退出后的订阅/连接释放。

这些项目的存在不证明 WinCode 集成已经可行。默认保留 FlaUI 的进程外只读取证；应用内接入或注入属于新的路线，需在专用测试应用上明确启用。首个实验通过前不承诺产品集成，不复制完整注入器或自研 XAML Binding 求值器，也不借机加入点击、输入和属性写入。

### R9：未知位置任务的 Repo Map

仅当真实任务表明未知文件定位仍是主要成本时，参考 [Aider Repo Map](https://aider.chat/docs/repomap.html) 的按相关性选择有限代码信息的方法。优先利用已经可靠的项目关系与符号/引用信息，不直接搬入整套 Python/Tree-sitter 排名工具链。

已知文件、符号或行范围的请求继续走直达路径。验收比较相同初始信息下的定位质量、调用数和输出量；先证明排名有收益，再讨论缓存及失效策略，不增加默认全仓预扫描。

## 9. GitHub 经验综合

本节结合 GPT-6（High）子智能体的一手资料检索补充。只吸收能直接解决 R1–R3 或降低实现风险的机制；上游具体实现同样需要检查边界，不能因为项目成熟就直接复制。

| 上游经验与一手资料 | 本项目的最小吸收方式 | 判断与限制 |
| --- | --- | --- |
| [Serena ListDirTool](https://github.com/oraios/serena/blob/main/src/serena/tools/file_tools.py)：按路径、递归选项和忽略规则读取目录，并限制结果长度 | R1 默认摘要；指定目录按需展开；省略情况有界表达 | 近期采用访问方式。上游先扫描再限长，不能照搬后声称扫描成本有界 |
| [GitHub MCP Server](https://github.com/github/github-mcp-server#tools)：部分列表工具提供分页及 `fields` 字段选择 | R1 默认只选必要摘要字段；宽目录确需续读时再加小型分页契约 | 字段选择思想可先用，不必向 WinCode 暴露通用查询语言。MCP 的列表分页规范不自动成为自定义目录工具的标准 |
| [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md)：从实际连接读取服务信息、列工具、调用工具 | R2 复用当前 SDK 做同会话核对，并另核对真实宿主连接 | 近期采用诊断方法。当前 [Inspector README](https://github.com/modelcontextprotocol/inspector/blob/main/README.md) 要求 Node.js ≥22.19，本文不建议为了诊断顺手引入该依赖或升级环境 |
| [Repomix readRepomixOutputTool](https://github.com/yamadashy/repomix/blob/main/src/mcp/tools/readRepomixOutputTool.ts)：返回总行数、实际读取行数和起止行 | R3 分离请求范围、最终返回范围与可靠可计算的未返回范围，支持无状态补取 | 近期吸收输出信息组织。检索时上游返回 `endLine` 的分支仍可能回显超过 EOF 的请求终点；应作为反例测试，不能照搬 |
| [Aider benchmark](https://github.com/Aider-AI/aider/blob/main/benchmark/benchmark.py)：将版本/配置、尝试成功率、错误、耗时与 token 等一起记录 | R3 先验证固定任务是否正确完成，再比较输出量、调用数与重复取证 | 近期吸收小样本评价方法，不引入大型 benchmark 平台、新模型服务或排行榜；宿主 token 未实测时只记录字符估算 |

目录分页如后续采用，可参考 [MCP 分页规范](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination) 的游标思想，但目录工具的路径、排序、失效与续读条件仍需自行明确；首版不为此维护全仓快照。

综合取舍：这些经验主要细化 R1–R3 的验收与实现边界，支持既定近期排序。子智能体提出的“控件一直定位到 XAML/C#”完整自动调查样本归入 R6；R3 先用现成的定位信息验证已经实现的精准读取，避免把新功能开发混入旧能力验收。[FlaUInspect](https://github.com/FlaUI/FlaUInspect) 的信息组织留给 R6；Snoop/WPF 深检及 Repo Map 仍按进入条件安排。

以上是对上游机制的借鉴建议，具体成本仅能判断为局部适配或需要进一步设计；本轮没有集成或测得性能提升。上游源码会变化，正式实施时按当时版本复核。

## 10. 暂缓项与实施决策

暂缓 Capability Registry、Theia 式 DI/plugin host、OpenHands runtime、Cline Agent 架构、大型 Extension System、通用 Symbol Service、模型专属 tokenizer、Repomix 整体重构，以及没有失效证据支持的跨调用缓存。既有 `ExtensionManager` 也不因本文而顺手改造。

Repomix 的个别有用做法可独立参考；当前显式候选打包会走内置 bounded packer，因此不将切换 Repomix provider 作为近期主线。继续明确字符数/4只是预算估算。

| 事项 | 状态与处理 |
| --- | --- |
| R1 → R2 → R3 的近期顺序 | 用户本次已明确，无需重复确认排序 |
| R1 预算初值、目录入口、旧响应兼容方式 | `USER_DECISION_REQUIRED`：实施前给出小型接口草案和调用方影响；本文数值为建议 |
| R2 构建身份/schema 标识、R3 覆盖字段 | `USER_DECISION_REQUIRED`：新增公开字段需先对齐契约；优先复用现有定义和响应 |
| R4 精确身份参数及歧义响应 | `USER_DECISION_REQUIRED`：确认兼容形态后实施，不静默更换公共接口 |
| R5 最低 Node 版本及依赖升级 | `USER_DECISION_REQUIRED`：有实际兼容性变化，单独处理 |
| R7 求值、R8 新接入、额外依赖或下载 | 只有进入相应阶段且实施范围获确认后执行 |
| Git 提交、推送、发布、全局 MCP 更新 | 本次文档整理不包含这些动作；此前其他任务的发布指令不作为本次执行命令 |

这些是后续实施的决策点，不阻止本次路线图交付。不会因为条目出现在路线图里就自动执行。

## 11. 交付与持续维护口径

- 每轮记录基线、目标、实际改动、使用的运行实例、针对性验证、失败与限制；继续增订 [工作日志](docs/codex_worklog.md)，不要为每个小步骤新增计划文件。
- 区分源码存在、编译通过、隔离测试通过、实际 MCP 接入通过、真实应用 GUI 通过和已发布。mock 测试或本地 benchmark 不替代真实上游和客户端验收。
- 每轮至少核查一个具体反例：输出很短却丢失关键入口；版本相同但构建不同；参数存在但 handler 未实现；范围元数据正确但正文被截断；单个可见候选来自未完成搜索；UI 状态来自旧进程。
- 测试采用现有非交互回归与专用夹具，GUI/真实上游按任务需要单独运行。只复用明确的专用测试资料，避免个人数据库与配置；长期复用测试环境时记录初始状态，避免残留状态掩盖缺陷。
- 以正确对象、足够证据、减少无效调用和受控资源为收益，不以类数、工具数、测试数或引入项目数量评价迭代。

本文编制仅新增路线图并在既有日志中记录；所列实现与验收仍以之后的实际工作结果更新。

## 12. 实施授权与进度（2026-09-08，北京时间）

用户在文档完成后授权按本路线图迭代，每个版本经复测、Debug 后单独推送 PR 并合并。因此第 10 节的文档阶段授权边界由本节更新：R1–R6 按上述最小方案实施，普通接口细节沿用现有契约；R7–R9 仍须满足各自进入条件。全局 MCP 配置与其他应用数据不自动纳入修改范围。

用户随后明确“接受 node20”：R5 采用 Node.js 20 为最低运行版本，允许该阶段所需 SDK v2 依赖迁移；不包含另装 Inspector 或升级系统 Node。

| 版本 | 范围与状态 | 验证边界 |
| --- | --- | --- |
| 0.9.1 / R1 | [PR #14](https://github.com/linnnn89/WinCode/pull/14) 已合并，main 7ce737f | 非交互回归 169 pass、1 skip；最终入口筛选修正后专项 9/9。真实 TavernDesk 独立 MCP 响应 3705 字符，保留 solution、应用项目入口；CodeQL 通过 |
| 0.9.2 / R2 | [PR #15](https://github.com/linnnn89/WinCode/pull/15) 已合并，main 2cbf443 | 专项 8/8，非交互回归 177 pass、1 skip，独立 stdio 契约与实际正文核对通过；CodeQL 通过 |
| 0.9.3 / R3 | 源码覆盖修正已实现并复测，准备 PR；真实宿主验收待办 | 专项 34/34（含既有上下文）；非交互回归 186 pass、1 skip。真实 TavernDesk 新 stdio 8 场景通过，223 行实际完整返回。用户表示无法重连，旧 Codex 0.9.0 连接不作为新版验收 |
| R4–R6 | 按序推进，R4/R6 在仓库外独立 worktree 准备 | 未完成版本不得据此宣称已验证 |
| R7–R9 | 条件阶段，尚未进入 | 依据真实阻塞决定是否实施 |
