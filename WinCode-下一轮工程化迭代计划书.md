# WinCode 下一轮工程化迭代计划书

更新日期：2026-09-09（北京时间）。本地版本 0.13.0，工作分支 codex/roslyn-correctness，基于 main@2235a42。A1/A2、外部 Serena 退役、默认 local-text、职责拆分及 C 已完成本地实现与验收；B 的构建、交付清单、中文异地发布目录及真实 Host/MCP 验收已通过。最新核心 307/307、桌面 35/35、Host 58、MCP 19 场景，回执见工作记录末尾。尚未提交/推送、执行远端 CI 或切换实际客户端。

历史基线结果与默认 SDK 发现失败回执保留；维护脚本已统一选择现有锁定 SDK，不改系统环境。E4 已获准直接采用方案二，当前为实施中快照；真实客户端项目/配置和求值范围仍需明确。早期章节描述对应阶段历史，以本段及末尾更新为准。

已完成的 WP1–WP5、Repomix 安全修复和真实 Serena 隔离验收已从待办移除，历史见 [CHANGELOG](CHANGELOG.md) 与 [工作记录](docs/codex_worklog.md)。方向总览见 [路线图](WinCode-迭代路线图.md)，现状见 [架构说明](WinCode-架构与数据流说明.md)。

## 目标与边界

当前下一轮集中修正已经复现的误导性结果、输入处理问题及 Roslyn 交付缺口，沿用 Gateway → Registry/Router → Core/能力接口 → Adapter/Host 的结构。此前失败恢复与有界负载验收保留，不重复当作未完成任务；不因 Router 较大就机械拆层，不增加微服务、插件框架、消息队列或新数据库。

已确认策略继续有效：Node 24 主支持、22 兼容；未知字段容忍并忽略，已声明字段严格校验且在 Skill 列出；hello 不主动探测；UI 取证不操作目标应用；安装与真实上游使用隔离目录。输出范围、候选与已证实事实必须分开表达。

## E1：工作区切换失败一致性（优先）

**基线风险与本轮证据：** [ToolRouter.openWorkspace](src/Core/ToolRouter.ts) 在工作区根更新后还会重置、初始化和绑定适配器。本轮故障注入已复现失败后仍准入请求、部分根/会话/watcher 不一致和提交后取消未识别；修复后原 13 个 E1/E2 故障用例不再报告这些问题。

1. 在根切换、缓存/会话更新、适配器 dispose/reset/initialize/rebind 各阶段注入失败与取消。
2. 检查失败后的根路径、缓存命名空间、watcher、上游绑定、请求占用和下一次请求行为。
3. 根据复现选择最小恢复策略，并补充回归；禁止错误发生后以“已成功切换”继续返回混合证据。

**验收：** 各故障点结果可解释；后续请求只读同一工作区，或明确拒绝并给出恢复动作；无旧缓存串入、重复 watcher 或自有进程残留。覆盖成功、失败、取消及再次切换。

**2026-09-09 用户已确认并实施：** 变更前失败保留旧工作区；变更后无法确认一致性时拒绝业务请求，重新 workspace_open 完成恢复。hello 可被动读取恢复状态。同根恢复不走快速路径；恢复再次失败仍保持拒绝。取消发生于根变更后同样进入恢复状态。不实施跨适配器自动回滚。

**复核补修：** 内部 Serena 清理或旧 watcher 关闭失败会保留失败状态，返回 recoveryAction=restart_gateway，提示检查自有资源清理后重启 Gateway；不再让 workspace_open 重复修改会话或承诺可以恢复。可重试的 watcher 创建失败仍返回 workspace_open。绑定结束及切换提交前均核对 watcher；创建失败或初始化中 watcher 出错不会成功提交切换。已覆盖内部关闭异常、底层 watcher 创建/关闭失败及初始化期间事件错误。

## E2：trash 部分完成与恢复

**基线风险与本轮证据：** [Workspace.moveToTrash](src/Core/Workspace.ts) 先 rename 再写元数据。本轮已用生成文件复现元数据失败但文件已移动；已增加 completed/not_moved/partial、失败阶段和实际路径，保留旧字段。测试覆盖目录准备失败、移动失败、元数据失败、重复请求、重启后文件保留及同名文件在同一时间戳下分别保留。

1. 注入 rename 失败、rename 成功后元数据失败、恢复步骤失败。
2. 保留源路径、实际目标位置与失败阶段，使已移动文件可找回。
3. 验证再次请求不会把“失败”误当成完全未执行；恢复动作不能覆盖已有文件。

**验收：** 任何结果均能解释文件实际位置；不丢失或覆盖内容；重复请求和重启后恢复有明确边界。

**2026-09-09 用户已确认并实施：** 准确报告部分完成和实际位置，不自动移回；保留 success/trashPath/message 并增加状态字段。仓内 Skill 已补充恢复说明，未部署至用户全局 Skill。丢失部分完成响应且元数据未完成时，不保证自动恢复原目录映射；本次不新增恢复数据库或自动回滚。

**复核补修：** UUID 与时间戳保留唯一性，展示用原文件名按 Unicode 码点截短，为 .meta.json 留出空间；最终元数据文件名不超过 255 UTF-8 字节（同时约束 Windows UTF-16 长度）。完整 originalPath 保留不变。183–255 字符 ASCII 边界及中文/emoji 文件名夹具均验证正文和元数据完整。

## E3：有界混合负载验收

现有有限次数的顺序/并发生命周期测试不能证明真实上游长时间运行稳定，也没有证据据此断言存在泄漏。

先运行一个不超过 5 分钟、100 次调用的小样本，在隔离的两个工作区交替查询、切换、取消，并模拟自有上游退出。记录调用延迟、输出量、Gateway/自有子进程 PID、可取得的内存和句柄趋势、清理结果。预算扩大或安装其他上游前另行确认。

**验收：** 无跨工作区证据污染、请求占用永久不释放、自有进程残留；区分启动增长、缓存稳定平台与持续增长趋势。报告实际采样条件和不可观察项目，不把一次内存峰值当泄漏或把短测当耐久证明。复用现有脚本和报告目录，不建大型基准平台。

固定 Serena 1.7.0/Roslyn 的真实验收已在本轮复测并增加切换检查；固定 Repomix 1.18.0 已完成下述实际打包验收。普通 CI 不自动安装或运行这些上游。

**2026-09-09 本地小样本：** scripts/verify-mixed-load.ts 记录 80 次 Core 操作（另有夹具初始化/握手）、10 轮采样、10 个真实 Node 模拟上游进程退出，结束时无自有子进程残留，查询/切换检查未发现跨根证据。采样仅约 1 秒，RSS 从约 134 MiB 增至 137 MiB、heapUsed 从约 34 MiB 增至 42 MiB；尚未观察稳定平台，不能判断长期增长或宣称无泄漏。Windows 句柄数、子进程 RSS 和真实上游兼容性仍未覆盖。

**复核后交错小样本：** 原脚本的调用前取消和顺序切换不足以验证运行中交错，已改为实际进入模拟上游 RPC 后再发起切换；5 轮运行中取消、5 轮上游退出，均断言切换等待旧请求、旧根在请求占用期间不变、结束后新根查询正确。共记录 70 次 Core 操作、10 个自有进程，1934 ms，结束时无自有进程残留。报告 test-tmp/mixed-load/run-ftSuQB/report.json；此结果只补齐受控交错场景，不是耐久性或真实语义上游验收。

**后续完成（2026-09-09）：** `npm run test:mixed-load -- --sample-interval-ms=10000` 在同一 100 次/5 分钟预算内完成 70 次操作、10 轮、97235 ms。Windows 指定 PID 采样均成功：每轮结束 Gateway 句柄均为 234，dispose 后 233；工作集启动阶段下降后，第 2–9 轮约 103.4→105.2 MiB，仍有小幅增长，不能把这一短窗判为长期稳定平台。10 个上游工作集约 53.9–56.4 MiB，结束时均无残留。报告 `test-tmp/mixed-load/run-NUo0VL/report.json`。指标含采样点而非峰值，无强制 GC、持续高负载或耐久性证明；E3 按原有有界标准完成，不把未授权的长时间压力测试提升为本轮新增验收条件。

用户随后授权补齐环境，所有持久组件最终位于 `.deps`：Python 3.13.15、Serena 1.7.0 固定提交 949a27e、上游锁定 Roslyn 5.5.0-2.26078.4、Repomix 1.18.0。新增组件和下载缓存逻辑大小合计约 716 MiB（硬链接可能重复计数，非物理分配量），已有 SDK/NuGet 不计入。环境回执 `.deps/environment-receipt-20260909.json`；不改系统 PATH、全局 SDK、项目主依赖锁或 Codex 注册。

- Serena：`npm run test:serena-real -- "绝对项目路径/.deps/serena-venv/Scripts/python.exe" "绝对项目路径/scripts/serena-isolated-launcher.py"`。固定 8 项全部通过，包括原 7 项语义检查和 Router A→B→A 的缓存/新查询切换、每次实际重连与自有 PID 退出；报告 `test-tmp/serena-acceptance/1788923903497-28124/report.json`。专用启动器在导入上游之前设置隔离环境，避免 MCP SDK 默认环境白名单丢弃 SERENA_HOME。首轮误生成的用户目录配置/日志已依据创建时间和上游“原文件不存在”日志核对后归档 `.deps/serena-first-attempt`，不遗留全局 Serena 配置。
- Repomix：`npm run test:repomix-real -- "绝对项目路径/.deps/repomix/node_modules/repomix/bin/repomix.cjs"`。10 项通过：安装握手、Markdown/XML/plain、真实压缩、空包、watcher 后缓存失效、封闭候选集、实际 CLI 取消、启动超时与输出清理；报告 `test-tmp/repomix-acceptance/中文 & (real)-hCTcgs/report.json`。实测修复了说明文字被误计为正文文件的问题；使用独立 CLI 摘要，缺少受支持摘要时降级而不猜测数量。未宣称覆盖任意版本、用户配置或所有打包功能。

## E4：结果与错误契约渐进整理

当前 UI、代码和 Gateway 错误格式不同。先盘点高频失败：范围无效、目标歧义、预算截断、取消、上游不可用、部分完成；为每类明确稳定错误码、来源、可重试条件和恢复提示。

**验收：** 现有成功响应和调用方式兼容，客户端无需解析自然语言识别已纳入的失败；未知/不完整状态不被改写成成功或否定结论。只处理实际用例涉及的字段，不一次性替换所有结果信封。

**USER_DECISION_REQUIRED：** 新公共响应字段及兼容策略需在盘点后确认；不把 MCP 的可选结构化输出能力当作必须全面重写接口的理由。

E1/E2 所需 WORKSPACE_RECOVERY_REQUIRED、TRASH_NOT_MOVED、TRASH_METADATA_FAILED 已按用户确认的兼容方案局部实现；不等于所有工具的错误与证据模型已完成统一。其余范围、歧义、预算和上游错误已完成下述盘点，公共字段兼容方案待确认。

### 2026-09-09 E4 盘点与待确认兼容方案

`scripts/verify-error-contracts.ts` 已通过 InMemory MCP 实测 10 个场景，报告 `test-tmp/error-contracts/run-0L5l8H/report.json`。取消/普通异常使用隔离 Router 的操作错误注入，其余为实际校验、读取或关闭路径；没有操作真实 UI。

| 场景 | 当前可机器读取的事实 | 缺口与处理意见 |
| --- | --- | --- |
| 未知工具、代码参数/范围无效 | MCP isError=true；content 为普通错误文本 | 增加独立 structuredContent，分别使用 UNKNOWN_TOOL / INVALID_ARGUMENT；修正工具名/参数后才能再试 |
| UI 参数无效 | success=false、INVALID_ARGUMENT、errorMessage | 保留现有 content，补相同的附加元数据；不调用原生 UI |
| 目标歧义 | 引用 resolution=ambiguous、candidates；context 的 fileIssues.reason 标识歧义且 evidence 为空 | 保持现有候选/范围信息，不伪造成功命中；按候选缩小范围，暂不重写成功结果信封 |
| 预算不足 | truncated、queryComplete、evidenceInsufficient；行范围还含 missingRanges/nextRequest | 这是部分证据，不统一变成执行失败；继续使用最终序列化后计算的预算和覆盖信息 |
| 上游不可用 | source=serena-adapter-fallback、analysisCompleteness=degraded/incomplete；health 的 upstream/lastError | 来源能区分降级，但并不说明唯一故障原因；不从 queryError 自然语言猜码，不把空本地结果说成语义零结果 |
| 执行中取消 | success=false、CANCELLED；必要时 workspaceRecovery | 保留现有字段；恢复状态优先于一般重试提示 |
| 关闭时拒绝 | status=failed、reason=cancelled、provider=wincode、recoverable=false | 与执行中取消不同；附加 GATEWAY_SHUTTING_DOWN，提示重启，而不是盲目重试 |
| 普通执行异常 | MCP isError=true；content 为普通错误文本 | 附加 TOOL_EXECUTION_FAILED；原因未知时标记 inspect_error，不承诺自动重试 |
| trash 部分完成、切换恢复 | outcome/failureStage/实际路径；WORKSPACE_RECOVERY_REQUIRED/recoveryAction | 继续使用已确认字段，不覆盖实际位置或永久恢复动作 |

**建议的首批公共兼容方案（USER_DECISION_REQUIRED，尚未实施）：** 只给 Gateway 已失败响应增加 `structuredContent={success:false,errorCode,errorMessage,provider:"wincode",retryable:false,recoveryAction}`，旧 content、isError、成功响应及工具参数不变。retryable=false 表示不推荐原样自动重发；recoveryAction 表示先修正参数、检查错误、重新打开或重启后再请求。已执行部分副作用的取消使用现有 workspaceRecovery 动作；trash 不被通用提示覆盖。未知原因仅用 TOOL_EXECUTION_FAILED，绝不凭文字猜测上游错误类型。

例如无效 query 当前仍返回 `Tool Execution Error: ...`；附加结构将为 `{"success":false,"errorCode":"INVALID_ARGUMENT","errorMessage":"原错误信息","provider":"wincode","retryable":false,"recoveryAction":"fix_arguments"}`。取消、关闭、未知工具、普通异常分别用 CANCELLED、GATEWAY_SHUTTING_DOWN、UNKNOWN_TOOL、TOOL_EXECUTION_FAILED；未知工具动作使用 fix_arguments，取消使用 retry_after_cancellation（若已有工作区恢复动作则优先）。此批不增加统一成功信封，不新增工具，不改变预算，也不实施语义图/UI 绑定路线。

验收：旧 content 逐项保持一致；新客户端无需解析自然语言识别上述失败；无效参数在副作用前拒绝；取消/关闭/永久恢复动作不混淆；成功、歧义、预算截断、空降级结果原样保留。未知扩展字段继续容忍并忽略。

## 交付与检查关口

每个工作包独立形成可审查变更，先记录触发问题和失败样例，再做最小修复。影响交付输入时执行 `npm run check`；UI 路径变化增加 `npm run check:desktop`，上游路径变化增加对应 opt-in 实测。文档单独修改只做链接、命令、版本和事实一致性核对。

沿用已授权的版本流程：针对性复测与 debug → 对应版本和 Skill 同步 → PR 精确提交的 Node 22/24 与三项 CodeQL 检查 → 合并 → 主分支交付核对。实际客户端重连另行核对，不能用磁盘版本或新测试会话代替。每步写入既有工作日志；作者自审不等同独立审核。

每包验收失败即停在该包定位原因，不叠加下一包掩盖失败。新依赖、运行环境、重要公共接口或恢复政策超出既有决定时先确认。本计划不预设版本号或工期，避免把尚未复现的风险包装成已确定修复规模。

## 2026-09-09：对照“架构分析优化建议”的后续计划

来源：[架构分析优化建议](chatgpt-conversation://6aa0185d-0bb8-83e8-9281-594f16e8c6d2)。已读取两轮完整问答，并与上述源码基线对照。对话中的架构判断作为建议输入；优先级与实施范围以下述核对为准，尚未获得实施新架构的授权。

### 建议与当前实现的差距

| 对话建议 | 当前源码证据 | 真正待完成的工作 |
| --- | --- | --- |
| Capability Registry | Gateway/ToolRegistry.ts 已集中注册、发布、校验、别名和契约哈希；ToolDefinition.ts 已定义执行接口 | 先盘点现有描述和状态信息能否表达适用任务、前置条件、降级路径；仅为真实选择困难补元数据，不另建重复注册体系 |
| Evidence Model | Core/CodeQueries.ts 已表达来源、完整性、截断和局限；UI 映射也有候选状态和文件哈希 | 在 E4 中对齐共有语义及错误码；逐类兼容迁移，不把供应方名称或任意数值置信度当正确性保证 |
| Semantic Graph / Impact Analysis | Core/DotNetGraph.ts 有声明级项目图；Serena 提供符号/引用查询；CompositeTools/ImpactAnalyzer.ts 已有影响报告 | 验证能否复用这些能力构造有来源的有限符号关系；声明依赖、引用和真实调用关系分别标注，不能把当前实现说成全仓调用图 |
| Code ↔ UI Mapping | UiSourceMapper.ts / UiCodeMapper.ts 已提供 XAML 与 C# 候选链 | 当前明确 runtimeSourceVerified=false、运行构建与源码身份未知、模板解析不支持；优先改善候选消歧与语义关联，真实 Binding/DataContext 解析仍是条件性研究 |
| Incremental Index | Cache.ts / WorkspaceWatch.ts 已有缓存、指纹和变化失效 | 这些不等于持久化符号/引用增量索引；先测重复扫描成本，再决定是否需要新索引及存储 |
| 统一错误与 CI | McpServer.ts 取消错误已结构化，普通异常仍返回文本；ci.yml 已运行 Windows Node 22/24 的 npm run check | 错误整理沿用 E4；CI 继续补与改动相匹配的回归，不重复建设已有流水线，真实桌面和上游实测保持独立边界 |

### 建议执行顺序与验收

1. **先处理可靠性底座（E1 → E2 → E3）。** 用隔离夹具证明工作区切换和 trash 部分完成问题，再按确认后的恢复政策修复。验收沿用各工作包，尤其检查“请求报错但状态已改变”的场景。混合负载遵守既有小样本预算；本轮未执行故障注入，也未判定风险已复现。
2. **渐进统一证据、错误与能力描述（E4）。** 先交付字段/失败场景对照表及兼容方案，再做局部实现。优先涵盖取消、上游不可用、歧义、截断和部分完成。验收要求旧客户端仍能调用，新增字段可机器判读，空结果与不完整查询不混淆。能力声明复用既有 Registry 和 Skill；不额外增加同义 MCP 工具。
3. **语义关系最小验证。** 建议先以 C# 小型多项目夹具验证，复用 Serena 符号身份与引用、现有项目图和 ImpactAnalyzer；先支持唯一符号的一跳关系及影响证据。覆盖同名/重载、跨项目、缺失上游、查询截断，确保每条关系可定位来源，未知关系保持未知。先评估可行性，再决定是否扩展关系类型、引入新解析器或持久化图；不承诺完整调用图或确定性“会不会坏”。
4. **深化 UI 到代码的证据链。** 在现有 XAML/C# 候选基础上，验证一个明确 WPF 场景的 AutomationId → XAML → Command 候选 → 语义声明/引用链。覆盖重复标识、多个候选、模板和运行二进制与源码不一致；无法证明运行时绑定时继续标记候选。只有实际任务被阻塞，再评估 R8 的应用内诊断路线。
5. **按测量结果决定增量索引及语言扩展。** 固定任务比较冷/热查询、少量文件变更后的耗时、扫描量和资源趋势；只有现有缓存/上游复用仍不足时才提出索引方案。增量方案须验证文件修改、删除、重命名与工作区切换后不返回旧证据。SQLite、新服务、TypeScript/Python 扩展均不预先列入必做实现。

对话强调的长期价值仍是语义关系、UI 到代码映射和可追溯证据；实施顺序建议先稳住工作区一致性，再逐步增强这些已有能力。继续维持 MCP 能力层定位，当前计划不包含自建 Agent、向量数据库或大量扩增工具。

**USER_DECISION_REQUIRED：** E1/E2 的恢复政策、E4 的公共字段兼容方案，以及后续是否采用 C# 优先的最小语义范围，均在调查形成具体方案后确认。新的依赖、持久化存储或应用内注入另行确认。本次拉取与计划整理不包含安装、构建部署、客户端重连或远端提交授权。

## 2026-09-09：直接集成 Roslyn 的设计稿

**授权与状态：** 用户要求开始设计绕过 Serena、直接集成 Roslyn，并进一步解释 E4 利弊。本节取代上述后续语义路线中“继续经 Serena 实现”的默认建议；历史验收仍保留。当前仅完成设计，尚未新增 Roslyn 生产依赖、编译语义 Host、切换提供方或删除现有 Serena 实现。

**后续复核：** 本文末尾“社区实践与第一性原理复核”修订了首个原型范围、身份设计顺序、监听失效要求及 E4 推荐顺序；涉及这些取舍时以该复核为最新建议，以下保留为原设计记录。

### 目标与第一版能力

WinCode 自行管理 C# 语义查询，使用 Microsoft.CodeAnalysis 系列库；用户不再为这条能力安装 Serena、Python 或独立 Roslyn 语言服务器。产品包携带 WinCode 自有语义 Host 和所需 Roslyn 组件。加载真实项目仍可能需要匹配的 .NET SDK、目标框架引用包和已恢复的项目依赖；“随产品提供分析组件”不等于任意项目零前置条件。

首版建议限于 Windows 上 SDK 风格的 C# `.csproj`/`.sln`：声明查找、重载/同名符号消歧、指定符号的跨项目源码引用、精确引用位置、向现有影响报告提供有范围和完整性标记的证据。无 Serena 条件下完成验收是必要条件。TS/JS/Python 保持已有文本能力，明确不提供 Roslyn 语义分析；VB/.NET Framework 特殊项目、自动重命名/写代码、完整动态调用图、WPF 运行时 Binding、持久化图索引不纳入首版。

### 模块边界与部署

建议调用链：`现有 MCP 工具 → ToolRouter / CodeQueries → RoslynAdapter → WinCode.Code.Host → Roslyn 库`。这是随 WinCode 分发、按需启动的本地子进程，不新增用户注册的 MCP、不监听网络、不要求安装另一款工具。Roslyn 库直接在自有 .NET Host 中执行；采用进程边界是因为当前 Gateway 为 Node.js，也便于超时回收和释放 .NET 工作区资源。

| 方案 | 收益 | 代价/判断 |
| --- | --- | --- |
| 加入现有 UIA Host | 交付上少一个可执行入口 | UI Host 当前为一次请求读取 stdin 到 EOF，并含 DPI、桌面通知、FlaUI；语义 Workspace 需要跨查询驻留。改造成混合生命周期会耦合桌面和编译资源，不推荐 |
| 新增 WinCode.Code.Host（推荐） | C# 工作区独立生命周期，随同一个产品包交付，故障不会占用 UIA 请求 | 增加一个可执行组件及内部协议；MSBuildWorkspace 还可能启动自身 BuildHost，须把后代进程纳入清理，不能声称整个功能只有一个 OS 进程 |
| Node 进程内直接加载 .NET | 减少显式子进程通信 | 引入 FFI/运行时桥接和额外兼容链，现有工具链无此基础，不推荐 |

复用 CodeSymbolQuery/CodeReferenceQuery/ContextCodeQuery、ResourceManager、现有请求占用/切换锁、WorkspaceWatch 和交付指纹。不另建泛化插件框架；只有实际共用逻辑才提取。拟新增 `src/Adapters/RoslynAdapter.ts` 与 `tools/WinCode.Code.Host/`；调整 CodeQueries、ToolRouter、ImpactAnalyzer 和健康报告中的提供方耦合，Gateway 保留现有工具名。

候选依赖为 Microsoft.CodeAnalysis.CSharp.Workspaces、Microsoft.CodeAnalysis.Workspaces.MSBuild、Microsoft.Build.Locator，统一选择兼容版本并锁定 NuGet。版本、完整传递依赖、发布字节数和包许可证清单在实现首个最小原型时核验，不从 Serena 的语言服务器包版本推断 Roslyn 库版本，也不直接依赖 SDK 私有目录内的 DLL。构建沿用项目既有 SDK 策略；分析目标的 SDK 选择另遵从该项目 global.json，缺失时报告，不静默下载或挑任意新版。MSBuild 定位规则参考[微软文档](https://learn.microsoft.com/en-us/visualstudio/msbuild/find-and-use-msbuild-versions?view=visualstudio)。

### 项目加载与事实边界

不能靠枚举 `.cs` 文件和补几个引用就承诺完整语义。真实编译还涉及 Compile 条目、条件符号、引用、imports、目标框架、生成文件。建议使用 MSBuildWorkspace 读取实际项目配置，显式记录 Configuration、Platform、TargetFramework 和加载诊断。多目标框架不能任选一个后把结果说成覆盖全部；首版限定一个明确配置，存在多种且未指定时要求选择。

**重要取舍：** 项目加载通常涉及 design-time build。微软说明其用途是获得源文件/引用/选项，会调用额外 MSBuild targets，并随配置/框架而变化。[设计时构建说明](https://github.com/dotnet/project-system/blob/main/docs/design-time-builds.md)。因此“不调用 dotnet build/restore”不能保证任意用户项目绝无执行副作用；项目自定义 targets 仍是需要信任的代码。

建议政策：未获项目执行信任时仅提供语法/文本证据；明确允许设计时求值后才进入项目语义模式，许可按工作区及加载策略保存，普通查询不重复询问。默认不自动 restore、不编译目标程序、不运行目标程序、不主动运行项目分析器/源生成器；若 MSBuild 自定义目标本身执行代码，这一政策不能当作沙盒保证。源码生成相关引用缺失时标记不完整；已有 obj 生成文件也不能未经身份核对就当作当前源码。首版在已授权的生成夹具中实现，再确认真实用户项目的信任交互。

外部项目引用、链接文件、SDK/NuGet 元数据有不同用途：源码取证范围必须经过根目录包含性校验；根外源码不自动展开，列出范围缺口。授权使用的 SDK/包元数据可参与类型分析，不等于授权读取任意根外源码或加载其中分析器。项目加载失败、依赖缺失、条件配置不明确时不输出 queryComplete=true。

### 查询、身份和变化一致性

1. 声明查找使用语法树与编译符号，显示名只用于展示。重载、泛型、partial、接口实现不能按字符串等同。引用查询采用 Roslyn 的 SymbolFinder.FindReferencesAsync，范围为实际加载的 Solution；精确位置由源码 Location/span 得到，行/列对外统一一基，不能把所在方法起点冒充调用点。[官方引用 API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findsymbols.symbolfinder.findreferencesasync?view=roslyn-dotnet-4.13.0)。这仍不覆盖反射、运行时动态绑定或仓外调用。
2. 建议引入不透明 `symbolId` 与 `snapshotId`，身份绑定工作区、项目/TFM 和文档版本；由当前快照的符号映射解析，不依赖 Serena 的 `/Save[0]` 序号。名称/签名用于显示与可读消歧。ID 在编辑、切换或 Host 重启后可能过期，返回明确失效状态并要求重新定位，不承诺跨版本永久 ID。ID 表有界且随快照释放。
3. 每个 Gateway 最多维护一个活动语义工作区；按需启动 Host，持有可复用 Solution 快照。内部 stdio 协议包含 requestId、workspaceGeneration、snapshotId 和协议版本，stdout 仅协议，stderr 为有界日志；有限帧长度、并发数、队列、取消和超时，不另建网络服务。
4. WorkspaceWatch 收到 `.cs` 变化时更新/失效文档快照；首版可保守重载，优化增量复用后置。`.csproj`、global.json、Directory.Build.*、assets 文件变化触发项目重载。watcher 本身不保证原子文件快照；响应提交时核对代次和参与文档的版本/哈希，发现变化返回不完整或取消，禁止把不同快照的身份与引用拼成一个完整结果。
5. 切换沿用 E1：排空旧请求后释放旧 Host/子进程，再初始化新工作区；释放失败不能假装恢复成功。取消是请求级操作，超时无法收敛时关闭自有 Host 树并废弃快照，后续只读查询再按明确状态重建。预算包括加载与查询时间、返回条数/字节及快照资源；初始值根据生成多项目夹具测量，不宣称仅裁剪输出就限制了内部计算内存。

### 兼容迁移与交付验收

- 保留现有工具名和普通参数；拟为精确引用新增可选 symbolId/snapshotId。旧简单名称继续支持，但歧义必须重新选择。已有 Serena namePath/序号不可静默套到 Roslyn 顺序上，旧身份请求提示重新定位。
- `source` 目前是 Serena 专用枚举，ImpactAnalyzer 也按 serena-mcp 判断语义来源。必须明确引入 Roslyn 来源并修改类型、消费方和回归；不返回假的 serena-mcp。旧客户端若穷举 source，新增值仍可能不兼容，不能宣传为完全无损替换。建议先显式选择 roslyn 验证，再决定切为默认的版本迁移；不自动偷偷回退到 Serena。
- 查询完整性由项目加载、查询范围、诊断和预算共同决定；Roslyn 来源不自动提高 confidence。零引用继续不能推出安全删除。错误契约可复用 E4，但 E4 不需要等待 Roslyn 才实施，Roslyn 原型也不需要先改全部工具信封。
- 首个验证阶段只做自有 Code Host + 生成的两项目 C# 夹具，覆盖同名/重载、泛型、partial、接口、跨项目、合法空结果和精确坐标；以明确预期源码位置为判据，Serena 仅可作可选对照，不能作唯一正确性判据。
- 接入阶段覆盖冷/热查询、编辑/删除/重命名、A→B→A、旧 ID、配置/TFM 切换、缺失 SDK/引用、未信任项目零设计时执行、取消/崩溃/关闭、预算截断。保留 E1/E2 行为与当前核心回归；不运行目标应用。
- 交付阶段将 Code Host、Roslyn 与必要 BuildHost 文件、NuGet 锁、协议/提供方契约纳入版本和交付指纹。现有交付清单有 512 目录条目、单文件 64 MiB、合计 256 MiB 等界限，须按实物发布包审核，不能直接关掉校验。验证无 Python/Serena 可用的干净环境仍能完成首版 C# 验收后，才迁移默认提供方和移除运行依赖。此阶段不自动删除当前 .deps 中用于对照的安装。

**落地前待确认：** 建议首版 C# SDK 项目/单配置、WinCode 自有 Code Host、显式项目设计时求值信任、先可选后默认的迁移。用户已确认直接集成方向；上述范围、执行边界和身份/source 公共字段属于本设计的具体取舍，当前没有把它们当作已获实现批准。

## 2026-09-09：E4 兼容方案的利弊与修订建议

E4 解决的是“不同工具报错方式不同，调用方不得不猜文字”，不提升代码理解能力。当前真实样例包括普通 `Tool Execution Error: ...`、CANCELLED JSON、关闭时 reason=cancelled 的旧对象。成功结果已有自己的范围/歧义/截断事实，这些不应为了统一而删改。

### 三种迁移方式

| 方式 | 好处 | 代价/风险 |
| --- | --- | --- |
| 保留原 content，失败时附加 structuredContent（此前建议，推荐作首批过渡） | 老的文本消费路径变化最小；新客户端可按固定错误码分支；改动集中 Gateway，可独立回退 | 老客户端若只读 content，得不到新收益；严格拒绝未知字段的客户端仍可能不兼容；两个表达必须由同一分类事实生成；需要实测实际宿主是否把结构化部分交给模型 |
| 错误 content 改成规范 JSON，同时提供同一 structuredContent | 文本与结构一致；只读文本的模型也能看到错误码；便于统一 schema | 原来按固定前缀/纯文本解析的客户端要迁移；不属于“旧错误文本完全不变” |
| 保留第一条旧文本，再追加 JSON 文本及 structuredContent | 保留旧首条文本，同时让只读 content 的消费者看到机器字段 | 额外文本与字段重复，模型输入可能更长；只允许一个文本块的客户端仍可能不兼容；只能承诺保留首块，不能承诺 content 数组逐项不变 |

MCP 官方将 structuredContent 与 outputSchema 设为可选，并建议返回 structuredContent 时同时提供其 JSON 文本表示。[工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。因此第一种仅保留旧自然语言的方案是为了迁移而做的取舍，不能声称已经满足“同一 JSON 文本镜像”的兼容建议。也不能因为 SDK 能解析 structuredContent，就保证当前 Codex 会按它执行恢复。上线前需明确选定文本策略并验收实际客户端；测试连接不能冒充用户当前连接。

### 收益、维护成本与语义风险

- 收益：INVALID_ARGUMENT 可提示改参数；WORKSPACE_RECOVERY_REQUIRED 可区分 workspace_open/restart_gateway；关闭状态与普通取消可区分。错误文案修改/翻译不必导致程序分支改变。后续 Roslyn 的加载失败与过期身份可以沿用同一表达办法。字段只帮助调用者选择动作，不能保证 AI 正确执行，也不会自动实施恢复。
- 成本：需要维护错误码、分类映射、字段类型、手册和兼容回归；structuredContent 不是加一个 JSON.stringify 就结束。不得从自然语言匹配关键字猜故障类型，只在明确校验分支/已知错误类型分类。额外结构增加传输字节，实际 token 增量由客户端如何渲染决定，暂不宣称固定 token 成本。
- 成功与副作用：success=false/isError=true 只表示请求没完成预期结果，绝不表示文件没动、工作区没变。trash 的 partial、实际路径及 workspaceRecovery 必须保留且优先，不能被通用恢复提示覆盖。预算截断/候选歧义可能是有用但不完整的结果，不能一律改成失败或自动重试。
- 重试语义：原提案统一 retryable=false 仅想禁止原样自动重发，但很容易被理解为“永远不能再调用”。**修订建议是首批省略这个新增布尔字段，使用明确 recoveryAction；如未来确有自动重试需求，再依据幂等性、执行阶段与副作用设计 retryable。**取消后恢复动作建议 inspect_state（若已有 workspaceRecovery 则用其动作），不笼统写 retry_after_cancellation。已存在的 recoverable 字段保留，不静默重定义。
- provider=wincode 仅表示错误由 Gateway 报告，不代表根因一定在 WinCode；底层原因未知时不可冒充 roslyn/serena 故障。未知普通异常保持 TOOL_EXECUTION_FAILED。错误信息不新增完整栈、凭据或未返回的用户源码。
- outputSchema 若只描述失败对象，会与成功结果不匹配；首批暂不为整工具声明这种不完整 schema，用内部类型/测试校验新增字段。以后明确成功/失败联合结构再发布工具输出 schema。
- 未知工具和真实协议层失败是另一个边界：MCP 规范将未知工具列为协议错误，当前 Gateway 实际返回 isError 文本。此前把 UNKNOWN_TOOL 一并列入只是兼容盘点，不应以 E4 名义悄悄改传输语义；修订后的首批建议先保持它的现有行为，协议规范化单独审查。

**推荐的缩小版首批（未实施）：** 对已知工具的参数错误、执行异常、取消/关闭、工作区恢复，保留旧 content/isError，附加 success、errorCode、errorMessage、provider、recoveryAction；不新增统一 retryable，不重写成功结果，不改未知工具传输行为，不覆盖领域部分完成信息。先验证字段与原文本一致、旧客户端仍能调用、实际模型能否看到新增信息。若需要只读 content 的消费者也获得全部错误码，再由用户选择 JSON 文本迁移或附加第二块，而不是声称第一种已经覆盖所有客户端。

当前用户要求详细解释利弊，尚未批准此修订字段集合或具体文本策略；先保留设计稿。直接 Roslyn 集成和 E4 分别验收，不打包成一次不可分割的大改。

## 2026-09-09：社区实践与第一性原理复核

**状态：** 用户要求复核此前建议、参考优秀社区经验。本节是对设计的修订建议，未实施生产架构或 E4 迁移。只核对当前代码、官方资料、社区作者的一手记录，并使用项目现有依赖执行隔离 SDK 探针。没有以帖子热度、工具数量或其他项目的性能宣传替代 WinCode 验收。

### 从需求推导必要部分

WinCode 要交付的是：在明确的项目配置与源码版本内，确定查询指向哪个符号，返回可核对的声明/引用，并说明未覆盖的范围。三个必要条件是编译上下文正确、符号身份明确、证据没有混用版本；“去掉 Serena”“统一 JSON”是服务这一目标的手段。性能比较还应先保证任务正确完成，再比较冷/热耗时、调用次数、输出量和资源，不用减少依赖层数推导一定更快。

据此保留直接 Roslyn 库 + 随产品交付的 WinCode.Code.Host。当前 Gateway 是 Node，现有 UIA Host 是带桌面状态的一次请求进程，独立 C# 工作区生命周期有具体用途。WinCode 只承担加载、查询、生命周期和证据输出；类型解析、重载匹配、引用查找仍交给 Roslyn。减少 Serena/Python 的部署环节会把项目加载、版本兼容和故障恢复的维护责任转给 WinCode，不等于维护成本归零，也不保证完整语义超越同样使用 Roslyn 的 Serena。

### 采纳的社区经验及适用边界

| 一手资料 | 可采纳经验 | WinCode 的处理意见 |
| --- | --- | --- |
| [csharp-ls 项目说明](https://github.com/razzmatazz/csharp-language-server) | 使用 Roslyn 实现语言服务；诊断分析器可单独关闭，并说明开启的 CPU/延迟成本 | 复用编译器能力，分开查询所需语义、诊断分析器和源生成器的职责；不因要找引用就默认运行全部诊断扩展 |
| [RoslynMcp 作者实测](https://github.com/MadQ/RoslynMcp/blob/dev/docs/battle-test-results.md) | 作者记录了冷启动负担、简单名称搜索的低成本，以及只取指定方法可能漏看邻近代码问题的案例 | 文本检索/文件浏览与语义查询互补；不强制所有查询先加载完整 Solution；精确引用附有界上下文，不把精准片段说成完整任务覆盖。该文为作者测试，性能数值不移植到 WinCode |
| [RoslynMcp 工作区模式](https://github.com/MadQ/RoslynMcp/blob/dev/docs/reference/WORKSPACE_MODES.md) | 自建源码工作区缺少项目配置、NuGet 与项目引用等上下文 | 源码扫描可以给语法证据，不能冒充真实项目语义；缺依赖时说明缺口，不能靠换成 AdhocWorkspace 获得“完整”结果 |
| [共享工作区设计稿](https://github.com/MadQ/RoslynMcp/blob/dev/docs/plans/multi-instance-architecture.md) | 讨论多个客户端重复加载工作区的成本；页面明确仍是后续设计 | 首轮仅在一个 Gateway 内复用一个工作区；没有 WinCode 多进程重复加载的实测需求前，不照搬 named pipe 守护服务、共享缓存或跨客户端资源系统 |
| [MCP SDK 问题 #654](https://github.com/modelcontextprotocol/typescript-sdk/issues/654) 与[已合并修复 #655](https://github.com/modelcontextprotocol/typescript-sdk/pull/655) | 成功输出校验曾遮蔽工具原本的失败信息；修复选择对工具错误跳过该校验 | 错误应完整到达调用者；区分协议文字、当前 SDK 行为及真实宿主行为，不从其中一层推断所有客户端兼容 |

这些是可检查的实现经验，不构成社区共识或推荐安装上述产品。库/API 的行为另由[微软 Workspace 模型](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/work-with-workspace)、[符号位置查询 API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findsymbols.symbolfinder.findsymbolatpositionasync?view=roslyn-dotnet-4.13.0)及前述 MSBuild 文档核对。

### 原方案需要纠正或收缩的部分

1. **先证明加载与引用闭环，再冻结公共身份协议。** 前案把 symbolId/snapshotId 及映射表提前列入首版公共接口；其必要性还没有原型证据。首个 Host 原型建议只使用内部的项目上下文、Document、声明标识符的 UTF-16 位置及当前 Solution 代次取得 ISymbol。路径/行号本身不够：同一文件可在多个项目配置中编译，同一行也可有多个重载。这个内部定位方式需验证后才能决定对外短期句柄或位置参数；不把跨编辑永久 ID、独立符号注册系统或新的公共字段作为原型前置条件。必要的快照代次、请求关联、取消和帧边界仍保留。
2. **不能原样复用现有监听作为语义正确性保证。** 当前 `src/Core/WorkspaceWatch.ts` 忽略 obj/bin，并在默认 150 ms 防抖结束后才调用无路径参数的 onChange。前案同时要求 assets 变化重载，二者不一致。将来接入时，应在相关变更到达即标记语义状态待更新，只对重载防抖；按实际加载输入识别 project.assets.json、生成源码、imports、项目配置和 Compile 文件集合的变化，避免简单去掉所有忽略项引入输出目录事件风暴。文件新增/删除、未知文件名事件、监听失败或无法确认来源的新旧状态，不能当作“无变更”。
3. **不透明 ID 和文件哈希不等于完整性。** Roslyn Solution 的不可变模型可避免查询内部混用逻辑快照，但不能证明磁盘始终没变化。仅复核返回的文件，会漏掉“另一个新文件新增了引用”这种负面证据失效。引用范围的文件集合与加载输入也属于待验证上下文；旧快照必须注明范围/代次，不能宣称磁盘实时完整。源码生成缺失、加载诊断和范围缺口继续显式报告，不能因为 provider=roslyn 就提高 confidence。这里指出的是待实现设计的缺口，未声称已复现一个尚不存在的 RoslynAdapter 故障。
4. **项目执行边界保留，但先在原型中证明。** MSBuild 设计时构建会执行 targets；“不主动 build/restore”或“关闭诊断分析器”均不等于禁止项目代码执行。诊断分析器与为编译贡献源码的生成器也不能混为一谈。首个已授权生成夹具使用不依赖外部生成器的明确配置，并核对加载副作用；对真实项目是否允许设计时求值及生成器的政策仍待用户决定，不预建复杂信任管理系统。对不支持的生成来源如实标记缺口，不以手工拼装引用弥补后宣称完整。
5. **E4 的默认过渡建议需要调整。** “原文本不变 + 新 structuredContent”只有已知消费者确实依赖旧文本时才有明确价值；不能为假设中的旧客户端永久保留两套表达。仓内检查发现多数测试客户端从第一个 text 块 JSON.parse，未找到已知工具必须保留 `Tool Execution Error:` 前缀的消费分支；未知工具另有文本断言，仍单独保持。此调查不证明所有外部客户端都兼容。推荐终态为同一个错误对象生成一份 JSON 文本及可选 structuredContent；只读 content 的调用者也能看到错误码，errorMessage 保留可读解释。是否直接迁移还是短期保留旧文本，由真实兼容要求决定，仍是公共契约待决事项。
6. **撤回“以后必须先有成功/失败联合 schema”的过强推断。** 当前 client/server 2.0.0 的 Client + 项目所用低层 Server，在有成功 outputSchema 时，isError=true 的错误无 structuredContent 或携带不同形状均能原样收到；成功结果的缺失/不匹配仍被拒绝。局部实测 5/5，通过[探针脚本](test-tmp/review-20260909/e4-sdk-output-schema.mjs)与[回执](test-tmp/review-20260909/e4-sdk-output-schema-report.json)可复核。因此 E4 不必绑定全工具成功输出重构。原来“仅失败对象的 schema 不能覆盖成功结果”仍成立；也不能把本机 SDK 的错误豁免说成所有宿主的保证。[2025-11-25 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)有结构化内容的 JSON 文本镜像建议；实际协商版本及宿主展示仍需针对部署验收。

E4 建议进一步精简：新增公共事实优先限于 errorCode、errorMessage，以及有明确定义时的恢复动作；既有 success、recoverable、workspaceRecovery、trash outcome/实际路径按原含义保留。provider=wincode、统一 retryable 和新通用成功包装都不作为必加字段。领域对象已说明实际发生什么时，不重复制造一个可能相互矛盾的恢复结论；未知普通错误不猜测可自动重试。即使请求失败，已移动的文件也不能重移，已变更的工作区也不能忽略恢复状态。

### 修订后的进入顺序与验收

1. **最小独立 Host 验证。** 拟在隔离的两项目、单配置/TFM 夹具完成“加载 → 定位具体重载 → 跨项目找引用 → 返回精确位置与少量上下文”。同名干扰、合法空结果和缺失引用必须表现不同；测冷/热耗时、资源、超时和关闭。使用声明位置及人工定义的调用点为真值，避免只与 Serena 比较。这个阶段不迁移公共参数、不切默认提供方；仍需按已确认方向对具体实现及依赖选择对齐。
2. **一致性与现有入口接入。** 原型证明后，再确定所需身份/source 字段并接到现有 CodeQueries/ToolRouter；覆盖编辑后立即查询、obj/assets 改动、新文件新增引用、A→B→A、旧定位失效、取消/崩溃与 E1 清理失败。文本浏览继续可用，不创建另一套通用插件层。公共范围标记及完整性必须与实际支持的项目配置相符。
3. **独立迁移 E4 与发布验收。** E4 可与 Host 分别实施，不强制先完成全工具重构。按选定的文本策略跑现有失败样例、部分完成样例和真实目标客户端；最后核对完整交付包、必要 BuildHost 文件和无 Serena/Python 环境。是否完成由可运行证据决定，设计稿、SDK 探针、历史 337 项回归均不替代直接 Roslyn 功能验收。

**USER_DECISION_REQUIRED：** 直接集成方向已确认；本文未替用户批准首版具体项目执行政策、公共身份/source 迁移、E4 文本兼容取舍。最新推荐是先做上述小型 Host 验证，E4 以单一错误事实和可见 JSON 为目标，旧文本兼容仅在实际需要时短期保留。本次复核未安装依赖、运行真实项目求值、修改生产代码、切换客户端或提交远端。

## 2026-09-09：第一阶段 Host 原型已实现

用户同意按复核方向开始。本阶段实现并验收自有 C# Host 的最小引用闭环；没有将它切为 Gateway 默认后端，E4 公共错误迁移也尚未实施。此前的“未新增 Host/依赖”为当时状态，当前进展以本节为准。

- 实现位于 [Program.cs](tools/WinCode.Code.Host/Program.cs)，启动参数显式要求允许项目求值、工作区根、入口 csproj、Configuration 和单一 TargetFramework。一次加载后复用 Solution；引用查询使用指定项目中的文档和 UTF-16 偏移，返回准确源码 span、一基行/列和有界上下文。内部 JSON 行协议尚不作为稳定公共 API。
- Roslyn 库固定 5.9.0、Build.Locator 1.11.2；Framework 17.11.48 只作编译引用，设置 ExcludeAssets=runtime/PrivateAssets=all，避免与 Locator 加载的 MSBuild 冲突。依赖通过 [packages.lock.json](tools/WinCode.Code.Host/packages.lock.json)锁定，使用现有项目内 SDK 10.0.303 和 NuGet 路径；没有安装全局 SDK。回执记录 22 个锁定包及其声明的 MIT 许可；本次构建目录为 112 文件、26,859,048 字节，含必要辅助文件，但不是最终发布包或新增磁盘占用的测量。
- 复现入口：`npm run test:roslyn-host`，对应[验收脚本](scripts/verify-roslyn-host.mjs)。脚本仅生成 test-tmp 两项目夹具、还原夹具依赖和构建 Host；不运行 Serena、目标应用或真实用户项目。当前入口要求已具备 `.deps/dotnet-10.0.303`，不是面向任意新机器的安装器。
- 最新[回执](test-tmp/roslyn-host/fixture-4E9UyF/report.json)：18 场景通过。覆盖显式许可缺失、两项目加载、重载/同名类型隔离、精确引用位置、合法零引用、热查询、截断、旧快照、根外文件、无效位置/项目/预算、1 ms 冷查询取消及后续可用、缺失依赖、不生成目标编译文件、关闭/EOF。Build 0 警告、0 错误。最后一次冷就绪约 2.83 秒，后续有效查询 382 ms，热查询低于毫秒整数计时分辨率，工作集约 125.6 MB；这是单个小夹具样本，不是性能承诺。
- 资源检查按 PID 和创建时间核对已观测进程退出；本次采样捕获 Host 与 conhost，未捕获 BuildHost，因此不声称已经验证全部短寿命辅助进程。进程树硬回收和真正 Gateway 取消/切换仍属于接入验收。
- 按用户新增要求，所有新增 C# 函数及主要 JS 验收函数已补充中文 XML/JSDoc 注释；协议注释覆盖必填字段、UTF-16 坐标单位、返回值、失败行为、超时及快照生命周期。后续新增函数和接口沿用此要求，注释应解释契约及非显然约束。

**验收边界：** 这是固定语义快照原型，没有 watcher、重载或磁盘新鲜度保证，响应明确 diskFreshnessVerified=false。编译前移除 AnalyzerReference，以防引用查询间接执行生成器；当前夹具排除了 12 个 SDK 分析器/生成器引用，完整性因而保守标为 false。源生成覆盖、配置扩展、真实项目执行政策和根外导入不作为本阶段已完成能力；自定义 MSBuild targets 仍是用户批准执行的项目代码，源码路径校验不构成执行沙盒。取消为协作超时，返回 limit 不约束 Roslyn 内部搜索内存。

下一阶段先处理变化失效与接入生命周期，再定公共定位/source 字段并连接 CodeQueries/ToolRouter；E4 可独立迁移。完整发布清单、默认后端切换及真正无 Serena 环境验收尚未完成，不把本阶段 18 项结果替代这些工作。

## 2026-09-09：Host 输入一致性、重载与取消已实现

用户同意继续后，本次完成独立 Host 的变化失效与请求生命周期。该进展更新上一节的固定快照限制；公共定位/source、Gateway 提供方和 E4 保持尚未迁移的状态。

- 新增 [WorkspaceInputs.cs](tools/WinCode.Code.Host/WorkspaceInputs.cs) 与 [WorkspaceSession.cs](tools/WinCode.Code.Host/WorkspaceSession.cs)：查询前后检查输入文件集合与内容，包括源码增删改名、obj/assets、csproj、祖先常规配置及实际加载的文档/元数据；文档文本在编译前固定。监听事件直接推进代次，不依赖现有 Gateway watcher 的 150 ms 防抖。结果只能描述检查点覆盖范围，不能证明任意自定义 targets 的外部输入或整个磁盘原子一致。
- 内部协议升级 v2：显式 reload 生成新快照，开始重载后失败保持失效；不自动运行第二次业务请求。MSBuild 返回部分项目而未抛异常时，按 WorkspaceDiagnosticKind.Failure 返回 PROJECT_LOAD_FAILED；源码编译错误仍可随不完整引用保留。global.json 变化、监听或清理失败要求重启 Host。
- [Program.cs](tools/WinCode.Code.Host/Program.cs) 分离输入控制与串行工作队列：最多等待 8 项、重复活动 id 拒绝、预算从接纳时开始、主动 cancel、shutdown/EOF 取消并排空后清理。排队时已到期的 reload 在改动状态前退出，旧快照仍可用；已开始重载后失败不恢复旧身份。取消仍为协作机制，生产进程树硬回收未实现。
- 输入预算为 20000 个枚举条目、5000 个文件、总计 128 MiB、单文件 32 MiB；超限拒绝，不生成部分指纹。freshness 明确覆盖范围；diskFreshnessVerified=false、externalCustomInputsVerified=false、queryComplete=false 保留。排除生成器的限制也保留，不以准确的现有调用位置证明全局覆盖。
- 最终[验收回执](test-tmp/roslyn-host/fixture-09LFFy/report.json) 42 场景通过，锁定构建 0 警告/0 错误。覆盖编辑后立即查询、新文件、重命名/删除、assets 和真实条件编译变化、Compile 排除、损坏项目失败与修复、过期身份、队列超时/冲突/背压、主动取消、活动请求 EOF 清理及 SDK 变更重启要求。突发 19 帧得到 8 个成功、9 个 BUSY、1 个重复 id 和 1 个取消，全部有回执。
- 本次单夹具冷就绪约 4.06 秒、有效首查 484 ms、热查 136 ms、工作集 184123392 字节；初始跟踪 195 文件/6163683 字节。热查询现在包含前后内容校验，不能用此前无校验的亚毫秒样本作同口径性能比较。构建输出仍为 112 文件，26891268 字节，不是最终发布包测量；仅对采样到的 Host/conhost 验证退出，BuildHost 未观测。
- 中文函数/接口注释和仓内 [Skill](skills/wincode/SKILL.md)、代码及诊断手册已同步；手册校验、现有接口/同步测试 11/11、脚本语法与 diff 检查通过。未找到已安装 wincode Skill 的受查目标，没有创建全局安装或声称当前客户端已更新。

后续仍需完成 RoslynAdapter/CodeQueries/ToolRouter 接入、实际 A→B→A 切换与崩溃/硬取消回收、公共身份/source 契约、E4 及完整交付和无 Serena/Python 环境验收。监听溢出与 Dispose 异常的真实注入、任意外部 targets 输入、非当前单配置和生成器覆盖未验证。此前核心 337/337 未在本次重跑，独立 Host 的 42 项不能代替生产入口验收。

## 2026-09-09 13:46：Roslyn 接入现有 MCP 与生命周期验收完成（北京时间）

用户同意开始后，完成公共定位契约、RoslynAdapter/CodeQueries/ToolRouter 接入与真实 MCP 生命周期验证。上节“尚未接入/未硬回收”为当时状态；本节是当前进展。保持 15 个工具名，默认配置仍使用 Serena，只有显式 Roslyn 配置才启用新路径。

- 新增 [RoslynAdapter](src/Adapters/RoslynAdapter.ts) 和 [RoslynHostClient](src/Adapters/RoslynHostClient.ts)，连接自有 Code Host。启动时通过 `--roslyn-config` 指定绝对 JSON 配置路径，显式给出项目求值许可、根内入口 csproj、Configuration、单一 TFM、已有 dotnet 和 Host 路径；配置示例见 [Skill 代码手册](skills/wincode/references/code.md)。不自动读取仓内配置以获得执行许可，也不允许普通 MCP 查询改可执行路径。
- `wincode_find_code_symbol` 返回 `source:"roslyn"` 与精确 `location={snapshotId,project,file,position}`；`wincode_find_references` 新增可选 `symbolLocation`，仍保留 `symbolName`。position 为零基 UTF-16 偏移，行/列仍为一基；同名/重载返回候选供选择，旧 Serena 序号身份明确拒绝，名字与位置不匹配不会被静默忽略。内部 v2 协议补充 symbols 操作，partial 去重且指定文件范围时返回该文件中的真实声明位置。
- 两类查询均携带 `semanticContext`，说明加载快照、排除的分析器/生成器和有界输入检查点。ImpactAnalyzer 可使用已定位符号的真实引用，但保持 `queryComplete=false`、`UNCERTAIN/UNKNOWN`，不因来源为 Roslyn 推断完整。显式 TS/JS/Python 范围仍可使用现有本地文本能力，Roslyn 模式不启动或回退到 Serena。
- 编辑后拒绝旧证据；下一次显式符号搜索才重载并产生新定位，不自动重放失败请求。`workspace_open` 同根重开及 A→B→A 均关闭旧 Host、失效旧身份。hello 只报告已知提供方/状态，不触发项目求值。清理失败保留 E1 的 `WORKSPACE_RECOVERY_REQUIRED/restart_gateway`，不能用重复打开掩盖失败。
- 取消先发请求取消，超时或无响应时硬回收自有进程树；启动阶段未进入协议循环也能取消。Windows Host 在 MSBuild 初始化前进入自有 Job，Host 崩溃时由系统关闭 Job 清理其继承的子进程；这是资源所有权机制，不是任意项目代码的执行沙盒。实现依据 [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 和 [扩展限制结构](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)。
- 新增 [真实 MCP 验收脚本](scripts/verify-roslyn-gateway.mjs) 与 [契约回归](tests/roslyn-contracts.test.ts)。最终 `npm run test:roslyn-gateway` [回执](test-tmp/roslyn-gateway/run-nP7SpF/report.json) 13 场景通过，覆盖真实重载/引用、编辑、切换、加载失败修复、实际 MSBuild 执行中的取消/崩溃/超时及最终关闭。后三类各捕获 7 个自有进程，包含 Host、BuildHost、测试 target 的 cmd/node 和控制台，按 PID/创建时间确认退出；这次已实际观测 BuildHost，不再沿用此前未捕获的证明缺口。
- 最终 `npm run check` [回执](test-tmp/check/2026-09-09T05-41-07-067Z-core/report.json) 12 阶段通过，344/344、0 失败/0 跳过；生产 stdio 的 15 工具契约和现有交付指纹匹配。该交付清单仍覆盖现有 Gateway/UIA Host/受管 Skill，不代表 Code Host 已纳入正式发布。独立 Host 在本轮早期另通过 42 场景（[回执](test-tmp/roslyn-host/fixture-whR9f2/report.json)）；后续位置范围及接入修订以最终 13 场景和核心回归为证，未把中间结果重复计数。
- 新函数、接口及生命周期约束配中文注释；仓内 Skill、代码与诊断手册同步完成。相关定向测试 18/18、Skill UTF-8 验证通过。实现期间发现并修复旧 Serena 调用多传一个 undefined 的兼容问题；进程验收初次误把 Gateway 自身控制台计入切换时必须退出的 Code Host 树，按真实父子关系修正后通过。失败回执和自审细节见工作日志，没有削弱 Code Host 子树的退出断言。

**剩余范围：** 本轮只在生成的 SDK 风格 C# 两项目、单入口/配置/TFM 夹具中验证；入口 ProjectReference 可达图不等于完整仓库、所有反向依赖或 `.sln`。生成器、任意外部 targets 输入、通过外部服务创建的进程、非 Windows 平台和真实用户项目未在本轮证明。此为作者自审，没有独立审核；新 stdio 测试连接也不是当前 Codex 连接。

**下一阶段：** 按已讨论方向分别推进 E4 公共错误迁移及 Code Host 正式交付，把 Roslyn/BuildHost、锁文件、协议和 Skill 纳入可核对的安装包，再完成无 Serena/Python 的干净环境与实际客户端验收。默认后端切换及旧运行依赖移除在这些证据齐备后处理；具体 E4 文本兼容策略和真实项目求值授权仍需按实际范围确认。本轮未引入新依赖、修改全局环境/客户端配置或提交推送。

## 2026-09-09：Pro 最新分析对照复核与下一轮工作计划（北京时间）

本节更新上一节的执行顺序，状态为**已完成复核与规划，代码修复尚未开始**。依据为用户提供的 Pro 分析全文、当前源码、GitHub 一手记录，以及本轮生成夹具的实际结果。Pro 未在 Windows 完整运行项目；本轮补充验证也不是全配置验收或独立人工审核。

### 基线与证据范围

- GitHub [PR #30](https://github.com/linnnn89/WinCode/pull/30) 于 2026-09-09 13:56:43 合并，远端 main 为 `2235a4200c117a1c1389afce1fecd90c45908a73`。本轮早期本地是 `bbc20ff` 加工作区修改；收尾时已变为该 PR 的 head `a2d76f6`，原有提交准备记录保留。本轮没有执行提交、推送或分支切换。
- 两次核对 ImpactAnalyzer、RefactorAssistant、Router、两个 Roslyn Adapter/Client、CodeTools、三个 Code Host 文件、check、delivery-manifest、package.json 与 CI，共 13 个文件的 Git blob；均与 Pro 基线相同。[比对回执](test-tmp/review-20260909/pro-baseline-comparison.json)记录初始状态及文件哈希；这不表示整份工作区与远端完全相同。后续实施先按远端合并基线建立工作分支并保留本地计划修改，不能盲目 reset 或重复合入 PR #30。
- [实际 ImpactAnalyzer 探针](test-tmp/review-20260909/impact-identity-report.json)使用生产分析类和受控查询提供方，验证聚合逻辑；[真实 Roslyn/MCP 探针](test-tmp/review-20260909/roslyn-audit-ebBSx0/report.json)使用现有构建和项目内 SDK，只求值本轮生成的项目。两类证据不互相冒充。
- [14:39 实际客户端观测](test-tmp/review-20260909/current-client-1439.json)确认 Codex 已连接 0.12.5、15 个工具，构建身份 verified，支持引用工具的 symbolLocation；当前提供方仍为 Serena 文本降级，Roslyn 未启用。旧“当前客户端 0.11.2”已经过时；新版身份核对已完成，实际客户端的 Roslyn 功能验收仍待完成。

### Pro 建议的取舍及新增发现

| 项目 | 本轮核对结果 | 处理意见 |
| --- | --- | --- |
| 影响分析的文件身份 | 已复现：`src/B/Service.cs` 及 `src/C/NewService.cs` 被误排除；两个目录中的 Handler.cs 合成一个组件；启动目录不同的绝对目标无法解析。affectedFiles 仍含全部四个引用文件，错误发生在组件摘要/目标解析 | 优先修复。完整规范路径负责身份，短名称只展示；有项目身份时保留项目维度，避免同一链接文件跨项目被误合并 |
| Roslyn 被称为文本降级、有限覆盖被称为中断 | 真实 Roslyn 查询正常返回后，RefactorAssistant 仍给出这两类错误说明；源码条件与 Pro 判断一致 | 优先修正消费逻辑。分开来源、执行状态和覆盖范围；不把 queryComplete 全改为 true，不由覆盖不足推导自动重试 |
| Roslyn 健康汇总遗漏 | Router 的聚合 lastAdapterError 未纳入 Roslyn；它已有独立状态 | 复用现有健康错误模型，补齐聚合，不另造监控层 |
| **新增：源码编码被改写** | 带 CodePage=1252 的 Café 类在真实 dotnet build 中 0 警告/错误；Host 搜 Café 得到零结果及错误字符诊断，搜 Caf 却返回错误名称。WorkspaceSession 冻结正文时强制 UTF-8 | 提前修复正确性。遵循项目/Roslyn 选定的编码冻结源码；不支持的编码明确失败，禁止静默替换字符再声称找到了精确符号 |
| 输入指纹范围和成本 | 新增无关 README 使旧身份 SNAPSHOT_STALE；无关 33 MiB bin 文件使符号查询 INPUT_BUDGET_EXCEEDED。当前扫描/保留所有非排除文件正文的代码与 Pro 描述一致 | 大文件阻断已是可用性问题，提前处理；重复 I/O 和瞬时内存成本仍需基准，不称为已证明的泄漏 |
| 真实验收与交付 | 真实 Roslyn 脚本未接入标准 CI；Code Host 不在正式清单内。默认 npm test 的 SDK 发现失败又说明本地专用路径和普通入口不一致 | 保留模拟协议测试，复用真实脚本补 CI；统一显式 SDK 选择并纳入 Code Host/BuildHost 身份与完整性校验 |
| 已选符号向组合工具传递 | find_references 已接受位置；影响分析/重构公共入口仍只有名称。内部唯一目标已会传位置 | 后续增加可选精确目标，保留字符串调用；属于接口扩展，不描述成整个 Roslyn 组合路径尚未接入 |
| 进程退出疑虑 | 真实 MSBuild 阻塞期间强制退出 Gateway、关闭客户端，两场景各观测 9 个相关进程，3 秒后均无残留，未靠额外清理才能通过 | 本轮未复现孤儿进程缺陷；保留回归场景，不据猜测重写生命周期管理 |

### 架构判断与应控制的冗余

保留 MCP → ToolRouter/CodeQueries → RoslynAdapter → RoslynHostClient → 自有 C# Host → Roslyn。Node/C# 运行时边界、语义工作区生命周期和进程回收各有明确责任；现有 ToolRegistry、领域证据与 SymbolLocation 已具备基础能力。当前没有证据支持另造注册平台、全局语义图、数据库或公共状态机框架。

需要收敛的是接入遗留：以 serena 命名的中性查询依赖、仅为纯文本解析仍构造 SerenaAdapter、未使用的 `_queries` 构造参数。ArchitectureAnalyzer 当前主要输出项目文件声明图；注入查询接口不等于已经用 Roslyn 得到语义架构图。优先在相关变更内清理命名、提取现有纯函数和删除确认无用的注入，避免以“脱离 Serena”为由删除仍有价值的文本探索或兼容路径。

Gateway watcher 服务仓库/文本缓存，Host watcher 与指纹服务语义输入，包括 obj 和配置；它们职责不同，暂不机械合并。详细查询接口与旧数组接口并存则需要调用方盘点：旧无位置引用入口在 Roslyn 下可能只返回空数组，当前主要消费者已用详细结果，但不能把这种潜在误用风险当作已复现的现行业务漏报。

另有尚未实测的准入风险：Host 的 8 项队列不能约束在 Adapter 互斥锁外等待的请求数。先用 16–32 个受控并发请求记录排队、取消及恢复；只有确认缺口后，才在现有准入层增加明确上限，不新增队列服务，也不据静态代码宣称内存泄漏。

### GitHub 经验的具体用途

- Serena [#1718 维护者复核](https://github.com/oraios/serena/issues/1718#issuecomment-5033051492)缩小了原帖所称的失效范围；[讨论](https://github.com/oraios/serena/issues/1718#issuecomment-5032705578)强调在语言服务管理层处理同步。采纳“先复现具体调用、在工作区生命周期层集中维护新鲜度”，不把原帖标题当成全部查询都会过期的事实。
- csharp-ls [#401](https://github.com/razzmatazz/csharp-language-server/issues/401)展示了只看项目版本会遗漏文档变化对依赖项目结果的影响。WinCode 优化指纹时必须覆盖源码集合及依赖变化，不能简单改为时间戳或单一版本号判断。
- [VuDZ/RoslynMcpServer](https://github.com/VuDZ/RoslynMcpServer)区分文档编辑和项目图变化，值得借鉴；不能直接把磁盘新增 .cs 一律 AddDocument，否则会破坏 Compile 排除与条件配置。仍以 MSBuild/Roslyn 的实际项目语义为准。
- [MadQ/RoslynMcp 的作者实测](https://github.com/MadQ/RoslynMcp/blob/dev/docs/battle-test-results.md)用于设计任务对照：同时看正确完成、冷/热耗时、调用和输出成本。其样本收益不能成为 WinCode 的性能承诺，普通文本搜索仍有适用场景。

### 下一轮三个里程碑

**里程碑 A：结果正确、输入可靠。** 建议先做 A1，再做 A2，分别保持可审查的变更范围。

- **A1：组合结果修补。** 修改 ImpactAnalyzer、RefactorAssistant 及 Roslyn 健康聚合相关位置。验收不同目录同名/后缀文件、不同启动目录、Windows 分隔符/大小写；同一份 affectedFiles 与 affectedComponents 一致。覆盖 Roslyn/Serena/文本、正常有限结果/截断/超时/取消，说明与实际状态一致，保留已有公共字段和恢复语义。
- **A2：Host 源码及输入处理。** 先修编码，复用真实项目夹具覆盖 UTF-8 有无 BOM、UTF-16 与 CodePage=1252，比较编译器和查询所得符号及 UTF-16 位置。再将输入清单、指纹和冻结正文分开：正文保留给编译文档，其他必要输入采用有界流式摘要；以实际文档/引用、项目/导入/配置、assets 及新增源码发现规则界定覆盖。源码增删改名、Compile 排除、条件配置、监听异常及过期身份仍需正确失效。
- **A2 的重要边界：** “不是 .cs”不等于“与编译无关”，自定义 targets 可能读取资源。实施前明确输入覆盖政策和无法验证的范围；不能简单忽略所有非 C# 文件、放大预算或只信 watcher。验收生成夹具中的无关 README/33 MiB 文件不再无谓失效或阻断查询，真实依赖变化仍可检测；必要输入超限依旧明确失败。完整增量索引及大规模性能改造后置。

**里程碑 B：持续验收与正式 Roslyn 交付。**

- 复用 `test:roslyn-host`、`test:roslyn-gateway`，使已有 SDK 路径可显式传入并用于相关构建/夹具子进程；保留 global.json 和锁文件，不靠放宽版本或跳过测试消除 SDK 失败。至少一个 Windows CI 任务真实构建 Code Host 并完成语义闭环；Node 22/24 网关兼容矩阵保留，是否两组都跑完整真实套件按耗时决定。
- 把 Code Host、Roslyn/BuildHost 运行依赖和协议/构建身份纳入对应交付清单，覆盖缺文件、错配版本、哈希不符和缺 SDK 的明确诊断。复用现有 manifest/build-info 机制；内部握手是否加字段在协议边界内评估，不引入通用插件安装器。
- 在隔离解压目录验证中文/空格路径、启动目录不同、无 Serena/Python 情况下的真实符号与引用；记录仍需的目标 SDK/引用包。再在实际 Codex 连接显式启用 Roslyn，核对身份并跑代表性调用。干净目录 smoke 与真正新机器环境分别记录，不互相替代。

**里程碑 C：已经选中的符号贯穿操作。**

- 影响分析和重构建议新增可选 `symbolLocation`，沿用引用工具身份结构和原 target/goal；不增加一组重复工具。位置与名称、项目、快照不一致时明确拒绝，过期后要求重新定位，不静默切成另一个同名目标。
- 验收同名类、重载、多项目/链接源码、正常零引用、修改后旧位置失败，以及旧字符串客户端的原有行为。特别验证“搜索选中的 Save(string)”进入后续报告时仍是该重载。
- 新增函数/接口沿用中文契约注释；同步仓内 Skill、code/diagnostics 手册、schema/契约测试及交付清单，再报告客户端实际加载状态。计划文档不提前把尚未实现的字段写成可调用接口。

**E4 与条件性后续：** E4 仍作为独立兼容迁移处理，不阻塞 A 的说明纠错。沿用已有建议：稳定错误码、明确 recoveryAction、成功与副作用结果保留，不新增含糊 retryable；JSON 文本/旧文本及 structuredContent 的具体组合仍待选择。完成 A–C 后，先测冷启动、热查询、单文件变化恢复、峰值内存及输入读取量，再决定增量优化；UI 只考虑一个固定 WPF 应用的 Click/Command 候选到精确符号，不由源码关联推断运行时 CanExecute 故障原因。

### 决策点、退出标准与本轮交付

**USER_DECISION_REQUIRED：** 当前请求授权复核与规划；上述新一轮代码修改尚未实施。建议首先实施 A1/A2；A2 输入覆盖政策须在实际改动前明确。B 推荐基础交付保留、Roslyn 为明确可选组件，默认切换放在验收之后；C 的可选参数为公共接口扩展。E4 文本兼容策略、实际用户项目/配置及其求值范围在进入对应工作包前确认，已有直接集成方向和项目内依赖授权不重复申请。

各里程碑独立验收，按修改点运行针对性测试并完成必要回归；不能用“有注入接口”“模拟 Host 通过”“已有 manifest matched”分别冒充语义能力、真实编译器验收或 Code Host 完整交付。反证重点是：精确位置仍可能来自错误解码；完整文件列表仍可能配有错误组件摘要；有界 Host 队列仍可能留下上游无界等待；构建身份正确也不证明当前客户端选择了 Roslyn。

本次只新增隔离探针/回执并修改既有计划、路线图和日志，没有修改生产代码、安装依赖、求值真实用户项目、改变客户端配置或执行外部发布。已完成探针清理，两个退出场景未见自有残留；344/344 是此前指定环境的成功回执，本轮不重新宣称全套通过，默认入口 SDK 发现失败保留在后续验收范围。

## 2026-09-09：第一阶段 A1/A2 实施与验收（北京时间）

用户授权开始实施后，从更新后的 origin/main@2235a42 建立 `codex/roslyn-correctness`，保留上一轮三份计划文档的修改。用户随后明确选择“在编译相关输入之外允许显式补充文件”；该项不再待决。此节更新上一节“尚未修复”的状态，未实施 B/C、E4 或默认客户端迁移。

- **A1 已完成。** ImpactAnalyzer 以工作区根解析完整文件身份，按可用项目身份区分组件；展示名保留。同名/后缀文件不再误判内部引用，不同目录的 Handler.cs 不再合并；绝对/相对路径和 Windows 分隔符/大小写别名有回归。RefactorAssistant 保留 queryComplete=false 的覆盖限制，不把 Roslyn 称为文本降级或把有限结果称为中断；Roslyn 加载、查询、清理错误纳入已有 lastAdapterError。
- **编码已修正。** WorkspaceSession 冻结正文时沿用 Roslyn/MSBuild 选定的编码和 BOM，验证 UTF-8 有无 BOM、UTF-16 BOM 和 CodePage=1252 下 Café 的声明及引用 UTF-16 位置；没有把源码改写成 UTF-8 文件。
- **A2 已完成。** 约定编译输入、实际文档/AdditionalFiles/分析配置/程序集及祖先配置自动跟踪；非标准后缀导入和自定义数据通过可选 `additionalInputs` 补齐。数组最多 32 个根内相对文件，JSON 最长 4096 字符；拒绝重复、通配符、目录、越界和链接，缺失项明确失败。配置只通过显式启动 JSON 传入，切换后按新根解释，不增加 MCP 业务参数。ready 的 inputPolicy.version=1 及实际列表必须匹配，旧 Host 不能静默漏用补充配置。
- **内容成本与边界。** 非加载的 README/视频/普通二进制不占输入字节预算；实际候选集和排除目录见[代码手册](skills/wincode/references/code.md)。保留 20000 个枚举条目、5000 个输入、128 MiB 总量和 32 MiB 单输入上限，必要/补充文件超限仍失败。元数据等流式散列，只有冻结编译文档时保留正文；未测完整性能收益，不宣称全磁盘覆盖、任意自定义依赖自动发现或无内存泄漏。
- **重载边界。** 每次加载尝试前最多四个 50 ms 事件稳定观察窗，继续受请求取消预算约束；持续变化则失败。没有增加业务自动重试，加载后的指纹/配置事件检查仍在。真实 MSBuild Touch 在内容哈希不变时也会触发拒绝，不能把等待窗口当成跳过新鲜度校验。
- **验收。** [核心回执](test-tmp/check/2026-09-09T07-20-21-008Z-core/report.json)350/350、0 失败/跳过，含类型检查、构建、生产 stdio 及现有交付验证。后续 Host 收敛补修由[58 场景回执](test-tmp/roslyn-host/fixture-sDJxDM/report.json)及[最终 MCP 16 场景](test-tmp/roslyn-gateway/run-fLDNDI/report.json)验证；覆盖实际非标准 Import 条件改变、缺失补充输入阻断/修复、AdditionalFiles、无关 33 MiB 文件、源码集合与 Compile 排除、编码、旧身份、切换及真实 MSBuild 取消/崩溃/超时清理。场景数量不跨套件累加。
- **失败与限制保留。** Windows 文件名大小写首轮曾使唯一解析失败，已修复并复测。另一轮 Host 在恢复补充文件后拒绝发布快照，旧回执未区分内容变化和事件变化，不能断言唯一根因；八轮隔离恢复未再次复现。保留该失败，拆分诊断原因，加入有界事件收敛和真实求值期 Touch 反证后，58/16 终验通过；仍可能在持续写入时返回 INPUTS_CHANGED，需稳定输入后显式恢复。

中文函数/接口注释与仓内 Skill/代码/诊断手册已经同步。当前改动尚未提交或推送；未安装新依赖、求值真实用户项目、写入全局 Skill 或改变客户端配置。现有 delivery 清单仍不包含 Code Host，不能把 matched=true 当成 B 的正式交付完成。下一步建议实施 B，C 的公共可选定位参数、E4 文本策略和实际用户项目求值范围仍在对应阶段明确。

## 2026-09-09：B/C、外部 Serena 退役与职责拆分开始实施

用户已批准外部 Serena 完全退役、默认本地文本/显式 Roslyn、source=local-text 三项取舍。以上旧章节的待决状态由本节更新。实现和验证进展持续记录于 [工作日志](docs/codex_worklog.md)，发布及当前客户端切换尚未实施。


## 2026-09-09 B/C、退役与拆分验收更新

用户三项迁移选择均已实施，本地版本 0.13.0。B 的构建、完整 Code Host 交付身份、异地发布目录和真实 MCP 验收已通过；C 的精确重载连续分析及职责拆分已完成。核心 307、桌面 35、Host 58、MCP 19、混合负载 70 调用的回执与失败过程见 [工作记录末尾](docs/codex_worklog.md)。早期“默认 Serena”“Code Host 不在清单”“C 尚未实现”已被本节取代。

尚未完成：远端 CI 实际运行、发布/客户端启用；E4 文本兼容方案等待用户本次选择。不得用本地验收替代以上关口。实际客户端项目/配置及求值范围须明确后才启用 Roslyn。


2026-09-09 发布开发快照更新：用户确认可直接采用 E4 方案二后，基础实现已开始；随后要求先将当前状态上传 GitHub。本次保存所有相关源码/测试/文档，以草稿 PR 交付，不将 E4 或整体发布判为完成。
