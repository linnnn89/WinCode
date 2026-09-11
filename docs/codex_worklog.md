# Codex 工作记录

## 2026-09-07（北京时间）— 后台取证模式与游戏前台实测

- 用户明确同意将后台模式加入本轮，并要求在游戏运行时实测。新增 inspect/review 可选 backgroundOnly=true，必须同时指定 PID/HWND；TS/Gateway/Host 均校验或透传。模式保持现有不激活/不还原行为，仅允许 PrintWindow，失败时禁止进入屏幕 BitBlt/CopyFromScreen 回退。正常捕获失败返回 imageOmitted 与原因并保留树；原生调用挂起导致整个 Helper 超时仍返回 TIMEOUT，不能宣称该路径也保留树。
- 夹具：新增 --background-fixture，ShowActivated=false、WS_EX_NOACTIVATE、无任务栏按钮、NOACTIVATE 置底，不操作游戏。每 100ms 采样前台 PID/HWND/进程名；脚本只取夹具图片与控件树，不采集游戏画面。取证结果保存在 Git 忽略的 test-tmp/background-*，专用脚本不加入默认回归。
- 实测一（20:27:50 起）：test-tmp/background-1788784070411/report.json；5/5 次读取 32 个控件，5/5 返回 printWindowDwm 图片，UIA 根 AutomationId 与夹具一致。已目视首张图片，确实是后台 WPF 夹具，没有游戏画面。72 次前台采样中，60 次为 Client-Win64-Shipping，另有 ChatGPT/Explorer/空句柄；测试夹具从未成为采样前台。用户随后明确确认主动切换过，因此不把变化自动归因于测试；也不宣称这轮游戏始终前台。
- 实测二（20:30:05 起）：test-tmp/background-1788784205075/report.json；增加等待游戏连续 10 次采样为前台的前置条件。15 秒等待中始终为浏览器，未满足条件，断言拒绝继续，0 次取证；标为未执行而非成功。测试窗口已清理，不再反复等待或强制切回游戏。报告原始 foregroundUnchangedInSamples=true 只描述该次浏览器采样，不能解释为游戏验收成功；随后脚本修正为至少已有一轮取证才允许该字段为 true，保留原始失败报告。
- 验证：C# Host/夹具 Release publish --no-restore、TypeScript build/typecheck 通过；后台策略与源码审查两个无前台窗口套件合计 12/12 通过，覆盖显式身份校验、MCP/Helper 参数传递与缺图保留树契约。图片失效降级为模拟协议测试，尚未在真实窗口强制 PrintWindow 失败。前一阶段窗口发现专项 3/3 通过；本轮未运行会激活窗口的全量 npm test。
- 证据边界：后台 WPF 取证在游戏运行场景有效，不能外推所有应用/最小化/独占全屏渲染行为；100ms 采样无法排除更短暂的焦点变化。PrintWindow 非零返回也不保证内容正确，图片仍需检查。严格全程游戏前台验收尚未完成。没有改游戏、全局配置或个人数据；未提交/推送。

## 2026-09-07（北京时间）— v0.8.0 第一阶段：只读窗口发现

- 授权与范围：用户要求开始迭代，按草案先交付窗口发现；没有实现局部子树查询或控件模式状态。新增 wincode_ui_list_windows，复用 Host/Adapter/Router/MCP 边界，无新增依赖、常驻进程或窗口缓存。
- 实现：PID、进程名精确匹配、标题字面量子串可组合筛选；默认 30、上限 100 个候选；输出 PID/HWND、标题、进程名可用性、窗口状态、采集时间和枚举完整性。Host 软预算 2 秒，Adapter 排队与执行总期限 3 秒，清理时间另计。达到上限时探测额外匹配再标记截断，不虚构总数。中文标题使用 Unicode Win32 接口；输出超过 256 字符标记 titleTruncated。
- 生命周期：新增请求复用现有串行锁、超时取消与进程退出确认，配置禁用时不启动 Helper。只枚举可见顶层窗口，不激活、截图或遍历 UIA；与工作区源码的归属不作推断，发现后使用 PID/HWND 重新校验目标。
- 验证：Host Release publish --no-restore、WPF 夹具 win-x64 Release publish --no-restore、TypeScript build/typecheck 通过。新专项 3/3 通过：参数/禁用/排队取消；真实 Helper 挂起后的取消与超时（OS PID 退出断言）；真实 SDK stdio MCP 两进程四个同名中文窗口、组合筛选、数量上限、目标关闭后的失效处理、目标存活与 Helper 被动状态回收。
- 失败与修正：首次夹具发布未指定 win-x64，验收启动的是旧路径产物；改用显式运行时发布。随后端到端断言发现 Adapter JSON 序列化未透传新增筛选与 maxWindows，已补齐。hello_world 成功时 isError 可省略，测试改为明确禁止 true，并增加实际 Helper 空闲状态断言；未放宽窗口数量/过滤/回收断言。
- 用户新增约束：用户正在全屏游戏，后续暂停会打开窗口的测试。新专项已经执行完毕；本轮尚未运行全量 npm test，避免夹具窗口影响前台。Codex 原生 WinCode 工具本会话尚未接入，不将 SDK stdio 测试冒充原生接入验收。未操作游戏或修改客户端设置，未提交/推送。
- 新发现及 USER_DECISION_REQUIRED：截图现有 PrintWindow 失败后回退 BitBlt/CopyFromScreen，目标被游戏遮挡时可能采集游戏。已建议并询问本轮是否加入后台模式：固定 PID/HWND、不激活/还原窗口、禁止屏幕回退，截图失败保留树；等待用户选择。PrintWindow 成功返回也不等于图像内容必然有效，不承诺所有后台窗口可截图。

## 2026-09-07（北京时间）— v0.7.2 可选界面关键词源码检索

- 授权与范围：用户确认开始迭代。复用 wincode_ui_review、显式 candidateFiles 和现有扫描预算，新增可选 textQueries；保留所有既有未提交修改，没有引入依赖或修改目标应用。
- 实现：UiTextSearch 提供最多 5 个、每个 80 字符的显式关键词；按区分大小写的原始属性子串检索，最多返回 40 项文件/属性行号/片段/SHA256。评论、CDATA 和属性内伪声明不产生命中。资源引用与绑定表达式单独标记，保持 identityMatch=false；不展开资源、不解码实体、不扫描元素正文。
- 生命周期与预算：复用同一次 UI 快照与同一次 XAML 读取；没有新进程、缓存、队列或扫描入口。MCP 在 128 KiB 文本预算内优先裁剪可选文本命中，再执行原有源码证据降级；保留 UI 树、图片和 ID 候选的原有边界。
- 反证验证：运行时 ID=Save 的源码 Content=Cancel、另一按钮 Content=Save 时，文本结果独立返回，原 ID 候选完全不变。补充重复命中、注释/CDATA、动态资源、绑定、字面量特殊字符、行号、长片段裁剪、40 项上限和入参拒绝；MCP 测试验证可选参数贯通、实际 UTF-8 预算和图片分离。
- 验证结果：typecheck/build 通过；源码审查专项 10/10 通过；完整 npm test 为 154 项，153 通过、0 失败、1 跳过，约 30.5 秒。git diff --check 通过，仅现有 CRLF 转换提示。原始测试输出：test-tmp/v072-regression.log。
- 真实项目重放：使用 v0.7.1 保存的隔离语言弹窗快照及当前 FirstRunLanguageDialog.xaml，命中标题资源引用第 5 行与 TavernDesk 字面量第 38 行；简体中文无字面量命中，16 节点仍为 0 身份匹配。报告：test-tmp/v072/replay.json。此项为离线快照/当前源码重放，不是新增实时 GUI 验收；未读取个人数据库或重开应用。
- 文档与版本：README/CHANGELOG、package/config 版本更新为 0.7.2。未提交、推送或发布；独立对话窗口（用户已选择跳过）、多 DPI、4K 和长期稳定性仍未验证。命中计数仅代表已扫描文件内容，应结合 fileScanComplete 与 truncated 解释。

## 2026-09-07（北京时间）— v0.7.1 真实隔离验收与可诊断性

- 授权：用户要求开始 v0.7.1 迭代并验收；保留既有未提交内容。再次核实 New-tarven 的 IsolatedTestStartup 和 Start-IsolatedTest.ps1：全新 test-root 隔离 data/config/logs，不附着已有实例；Release --no-restore 构建 0 警告/错误后，创建 PID 34008，receipt 校验通过。
- 隔离根：I:/New-tarven/work/isolated-test-20260907-193735-88d913aebeba492aabec1d729a64cf4a。未复制个人数据、配置 Provider 或发送模型请求；没有修改 TavernDesk 源码。首次语言弹窗状态 initialized，用户选择语言后变为 window-shown。
- 桌面操作工具将 TavernDesk 窗口错误归属 AiPPT，重绑定后仍报 window ownership 错误，停止自动输入并请用户手动选择语言。WinCode MCP PID 定位及截图正常。初次候选文件路径误写 Views/FirstRunLanguageDialog.xaml，返回 fileScanComplete=false，已记录为错误路径验证，不宣称完成弹窗源码扫描；实际文件位于 App 根目录。
- 第一性原理验证：主窗口 66 节点，仅 4 个带 ID（MinimizeButton/MaximizeButton/MaximizeGlyph/CloseButton），显式候选 MainWindow.xaml/ConversationWindow.xaml 内无字面量声明匹配；因此没有增加模糊匹配或推断 x:Name 身份。截图编号位置已查看，密集控件的编号可能覆盖文本；不等于截图视觉可读性已全面验收。
- 代码：新增 per-node reason，区分缺 ID、疑似裁剪、ID值不支持、文件扫描不完整、字面量无匹配/存在不支持声明、歧义；增加声明扫描与节点覆盖计数，MCP 缩减源码结果后同步 returnedNodes。保持候选语义和旧 status 字段。
- 诊断：FlaUI 被动状态含 activePid/运行/关闭/最近错误，成功缓存探针不抹掉取证错误；WorkspaceWatch 失败保留时间/原因并输出日志，不自动重启。新增 4 项针对性测试，并补预算裁剪后计数断言。
- 实测：scripts/verify-ui-runtime.ts 限制显式 PID、1–20 轮，不启动目标。主窗口 20 次 review、4 次取消后恢复、3 次工作区往返切换；每轮 managedChildProcesses=0，缓存始终 0 内存条目/1 磁盘条目/66 字节；RSS 首 107.71 MiB、末 95.23 MiB、范围 92.92–122.00 MiB；网关退出确认，目标保持存活。只能说明这轮短测未见持续增长。
- 验证：typecheck/build 通过；专项 15 项通过；全量 150 项，149 通过、0 失败、1 跳过，约 28.4 秒。报告在 test-tmp/v071/main/report.json，首次/末次 PNG 与 JSON 保留；test-tmp 新增 Git 排除以防运行时截图随代码发布。
- 待完成：独立对话窗口手动打开后的取证、正确候选路径的弹窗覆盖、最终目标关闭确认。未提交、推送或发布。未做多 DPI 切换、4K 超限或长时测试。
- 收尾：用户明确选择跳过独立对话窗口，列为未验证；对已保存语言弹窗快照使用正确 FirstRunLanguageDialog.xaml 做离线源码重放，fileScanComplete=true、16/16 节点均 missing-automation-id，文件无字面量 ID 声明（不冒充第二次实时窗口取证）。检查目标 PID 的可执行路径与 launch receipt 一致后，仅结束本次隔离实例，targetExited=true；报告保存 language-source-replay.json 与 teardown.json。
- 最终边界：全量回归 149/0/1，主窗口短批量测试通过；没有虚构源码命中。当前运行时 ID 缺失是实际覆盖限制，独立对话、多 DPI 和长期稳定性没有验收结论。保留隔离测试根与截图/报告，不删除证据。验收脚本增加退出终态断言后类型检查通过；未新增模型、服务或依赖。

## 2026-09-07（北京时间）— 工作区浏览降噪与项目类型摘要

- 用户确认“开始改”：仅调整目录浏览/统计与项目摘要，保留先前未提交变更；不修改符号扫描、缓存指纹、目标项目或工具链。
- WorkspaceManager 新增共用目录判断：默认忽略规则沿用；仅当 .dotnet 内同时存在 dotnet.exe/dotnet 普通文件、sdk 与 host 目录时认定本地 SDK。只查元数据，不运行 SDK、不跟随标记链接。树和统计均返回省略原因；统计标明 filtered-depth-limited 与深度 6，省略详情最多 100 条并附总数。
- ArchitectureAnalyzer 复用现有项目图新增 projectSummaries：文件、项目类型与 UseWPF/OutputType/Sdk/ProjectReference 声明依据。不扩大目录名启发式，不将目录分层解释为已验证职责；未显式声明 OutputType 时保持未知，不模拟 MSBuild 导入/条件求值。
- 验证：typecheck/build 通过，cleanup 专项 11 项通过（含新增 SDK 与普通同名目录反例、任意目录名 WPF 识别）。真实 MCP 再读 New-tarven：.dotnet 不再出现在树；过滤后的文件数由前次记录 4635 降至 1180、统计字节由 1079181742 降至 397281787；这是浏览范围统计变化，不是磁盘删除或严格性能基准。
- 实际摘要正确识别 TavernDesk.App 为 WPF executable、AgentHost 为 Console executable；Core/Infrastructure 未显式声明输出类型，保留说明。结果保存 test-tmp/new-tarven-browse-after.json。未启动 TavernDesk 或读取个人数据库内容。
- 全量初跑：144 通过、1 失败、1 跳过；失败为原 MCP 取消测试仅等待固定 200ms 即断言 helper 清空。改为最多 4 秒等待终态，保留退出断言及后续调用验证。重跑全量 146 项：145 通过、0 失败、1 跳过，约 33.4 秒；类型检查通过。日志分别保存 test-tmp/browse-regression.log 和 browse-regression-recheck.log。未提交/推送。

## 2026-09-07 19:13（北京时间）— 真实 MCP 只读访问 New-tarven

- 按用户要求，以 SDK StdioClientTransport 调用本地 dist/index.js，先以 WinCode 目录启动，再 workspace_open 到 I:/New-tarven；缓存保留在 WinCode 内。未启动 TavernDesk、未读取个人数据库内容、未修改目标项目。
- 4 次 MCP 调用均无 isError：workspace_open 约 1722ms、analyze_workspace 25ms、prepare_context 381ms、hello_world 75ms。识别 TavernDesk.sln、4 个项目、WPF/.NET 10、5 条 ProjectReference 边。
- ChatReplyExecutor 任务返回实现文件第 14 行及测试文件第 10 行，2 个证据片段；工具估算 780 tokens（预算 2000，非完整 MCP 输出 token 数）。Serena 未连接，Repomix CLI 不可用，明确使用本地降级；FlaUI health 可用，但本次未进行窗口取证。
- 结束前 managedChildProcesses=0；关闭 SDK transport 后操作系统 PID 检查确认本次网关已退出。结果保存在 test-tmp/new-tarven-read.json。
- 实机观察：工作区目录输出包含 .dotnet 工具链目录，元数据规模有噪声；路径分层启发式未把 TavernDesk.App 等带前缀目录归入 Presentation，但 csproj 依赖图正常。此轮仅记录，不扩展修改范围。

## 2026-09-07（北京时间）— 基础架构、生命周期与缓存复查

- 授权：用户要求复查架构合理性、生命周期、缓存并打好基础。保留上轮 v0.7 未提交内容，只修复与基础边界直接相关的问题。
- 架构结论：保留 Gateway 协议、Router 工作区/请求协调、Adapter 上游所有权、CompositeTool 证据组合分层；保持全局磁盘淘汰及命名空间隔离；UI 快照/源码关联不进入长期代码缓存。未引入额外队列框架、服务、数据库或依赖。
- 生命周期修复：Router 对每个清理所有者逐个尝试，聚合失败，仍执行缓存排空、session 关闭与 ResourceManager 释放；重复 dispose 保留失败结果。taskkill 子命令增加 2 秒上限，避免清理工具自身无限等待。工作区元数据读取失败恢复 root/trash；指纹在修改工作区状态前计算。
- 缓存修复：超大覆盖失效旧键的内存/磁盘值；内存总限额小于单条限额时不突破上限；从磁盘读取时重新估算大小，不信任 byteSize；淘汰前先检查文件大小再解析；写入、prune、clear 共用原有写队列；shutdown 排空已接受写入。目标目录根据入队前固定的文件路径创建。
- FlaUI 传输修复：StringDecoder 保留跨 chunk 的 UTF-8 中文；stdout 超限后立即停止存储后续数据；stderr 严格截断，stdin 早退 EPIPE 有错误处理。
- 针对性测试：增加缓存覆盖/总配额/伪造元数据、清空与排队写入、退出单点失败、工作区读取失败回滚、真实 Node helper 中文拆字与输出洪泛用例；前一轮 13 项专项通过，全量回归进行中。
- 边界说明：磁盘配额仍为初始化及每 20 次写入时的周期淘汰，不是每次写入后的硬配额；本次串行化仅覆盖单 CacheManager，不承诺多个独立网关共用一个目录时的跨进程事务。WorkspaceWatch 自动重启仍后置，未做长时压力测试或多 DPI 肉眼验收；未将这些限制报告为已解决。
- 验证完成：全量 npm test 144 项，143 通过、0 失败、1 跳过，约 25 秒；随后补充重复 dispose 失败结果保持断言并整理局部注释/缩进，typecheck/build 再次通过，受影响的 cleanup/hardening 14 项专项全部通过。无依赖安装、外部发布、提交或推送。

## 2026-09-07（北京时间）— v0.7 方案复核与实施

- 授权：用户要求再次结合 GitHub 经验和第一性原理推敲方案后开始迭代，并要求代码注释与 LOG。范围锁定为 WPF、显式候选 XAML、源码候选证据；本次不推送或发布。
- 复核依据：[Onlook](https://github.com/onlook-dev/onlook#how-it-works) 使用代码插桩建立元素映射；[FlaUI](https://github.com/FlaUI/FlaUI) 提供 UIA 访问；[AutomationId 文档](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/use-the-automationid-property) 提醒 ID 不具备全树唯一性。因此 WinCode 无插桩观察只能返回声明候选，不能宣称精确运行时源码身份。
- 方案收敛：复用 inspect 单次快照、MCP 请求槽位与图片分离；新增 UiSourceMapper 和 UiReview。仅检索 UTF-8 XAML 起始标签的显式字面量 AutomationProperties.AutomationId，返回文件、起始行、片段、哈希与 Command/Binding 等原始属性声明。不是完整 XML/XAML 解析器，不推断 DataContext、模板实例或禁用原因。
- 边界：最多 16 文件，单文件 256 KiB、总读取 1 MiB，2 秒检查点；最多关联 100 节点、每节点返回 5 候选；保留候选总数与截断。真实路径限制工作区内；文件变更/缺失/编码不支持显式记录；被 Host 裁剪的边界长度 ID 不匹配。
- 输出：源码查询失败保留 UI 快照；最终 128 KiB 文本预算先缩减源码证据，不改变已有树/图片对应。注释说明候选语义、固定长度读取、路径限制和生命周期所有权。
- 验证进行中：新增 6 项源码/协议测试已通过，随后执行真实 WPF 端到端和全量回归。未进行 4K/多 DPI 肉眼验收，不改变显示设置或读取用户真实窗口。
- 验证结果：npm run typecheck、npm run build 通过；npm test 137 项，136 通过、0 失败、1 跳过，约 24.9 秒。真实 WPF disabled 控件成功关联本次快照 ID 与 XAML 起始标签行，并读到 IsEnabled 声明；没有据此自动判定缺陷。git diff --check 通过（仅换行风格提示）。
- 反证自审：文件缺失时“单候选”不代表全范围唯一，补充 fileScanComplete；长起始标签的片段可能不含命中属性，候选独立返回 automationId 保留依据；极限大小 UI 快照连省略说明都容不下时优先保留原快照。修改后重新执行类型/构建及专项测试，结果随后补录。
- 最终复核：上述补强后 typecheck/build 再次通过，ui-source-review 与 ui-hardening 共 9 项全部通过。全量 136/0/1 为补强前记录，补强后只重跑受影响专项。未安装依赖、修改 Host、提交或推送；版本统一为本地未发布 0.7.0（同时修正锁文件旧版本元数据）。

## 2026-09-07（北京时间）— v0.6 加固版本提交与合并授权

- 用户明确要求将当前版本推送至 linnnn89/WinCode 并合并。已确认 origin 为目标仓库，默认分支 main，本地 HEAD 与 origin/main 无分歧。
- 本次交付包含 Gemini 加固改动与后续快速修复，沿用上一节记录的 129 通过、0 失败、1 跳过及构建验证；通过 codex/v0.6-ui-hardening 分支创建 PR 后合并，不额外修改功能。

## 2026-09-07 18:38（北京时间）— v0.6 验收边界快速修复

- 授权：用户要求直接快速修复退出确认、排队期限、裁剪后编号一致性及最终文本预算四项问题；保留 Gemini 现有未提交改动。
- FlaUiAdapter：inspect 使用包含排队时间的统一截止时间；区分用户取消与截止时间耗尽。helper 只在退出事件确认后清除活动引用和资源登记；清理超时明确返回错误并保留所有权，后续健康探测/取证拒绝启动新 helper，shutdown 可再次清理。
- UIA Host：先限制字段长度及裁剪控件树，再基于保留节点标注图片；重算节点数、深度和标注列表，为响应元数据预留空间。
- MCP：输出紧凑 JSON 并按最终 UTF-8 字节检查 128 KiB；异常 helper 输出超过预算时返回有界错误，不附带失去对应证据的图片。
- 测试：新增 tests/ui-hardening.test.ts；WPF fixture 增加独立 --budget-fixture 模式，实际验证长字段和大树裁剪后的文本预算及节点计数；取消测试必须取得 helper PID 并确认 process.kill(pid, 0) 返回 ESRCH，不再仅依赖 isRunning。
- 验证：npm run typecheck、npm run build 通过；Host Debug 构建零警告/错误；Host 和 WPF fixture Release win-x64 本地 publish（--no-restore）通过；npm test 共 130 项，129 通过、0 失败、1 跳过，约 25.4 秒；git diff --check 通过。
- 限制：未人为制造操作系统拒绝终止进程，未进行 4K/多 DPI 图片的肉眼标注验收。对未确认退出状态的阻断做了模拟回归，真实正常取消后的 PID 退出已验证。未提交、推送或发布 GitHub 变更。

## 2026-09-07 11:56（北京时间）— Stage 1 快速修正

- 目标：修复审查确认的 overflow 内存失效、删除边界及 shutdown 排队请求问题；保留既有 Stage 1 实现，不接入 FlaUI 或新增依赖。
- CacheManager：统一 overflow 删除入口；删除前失效关联内存条目，限制为本缓存 overflow 目录中的普通文件，拒绝目录联接/符号链接越界。TTL、容量淘汰、孤儿清理及 clear 复用此入口。
- ToolRouter / McpServer：槽位等待前后检查关闭状态；关闭通过既有 workspaceLock 等待进行中的切换完成后再释放资源；槽位获取失败进入 MCP 错误响应，只有实际取得槽位才递减计数。
- 新增 tests/stage1-cleanup.test.ts 并纳入 npm test：覆盖容量淘汰后的读取、TTL/容量清理外部路径保护、Windows junction 保护、关闭与切换/排队请求并发。全部测试使用新建临时目录，结束清理。
- 验证：新增 4 项通过；原 v05-stability 35 项通过；npm run typecheck、npm run build 和 git diff --check 通过。
- 全量 npm test 未通过：旧 tdd-suite 中硬编码外部 Tavern 路径的切换测试、固定项目名 WinCode MCP 的 MCP 架构测试失败；套件输出失败后未退出，已中断。本轮未修改这两个旧测试，也未把全量验证报告为通过。
- 限制：未做真实 Serena 子孙进程树端到端验收；未变更 Stage 2 范围。文件边界校验不承诺抵御恶意进程在校验与删除之间并发替换目录。

## 2026-09-07 12:12（北京时间）— 保存 v0.6 参考方案

- 按用户要求在根目录新增 [WinCode v0.6运行时UI取证实施方案](https://github.com/linnnn89/WinCode/blob/67239e3bcdad2ed6572b7407925906f521567dba/WinCode%20v0.6%E8%BF%90%E8%A1%8C%E6%97%B6UI%E5%8F%96%E8%AF%81%E5%AE%9E%E6%96%BD%E6%96%B9%E6%A1%88.md)，保存完整范围、架构、协议、生命周期、截图预算、测试与后续路线。
- 文档明确为参考方案，v0.6 仅 UI 取证，v0.7 源码联动后置；未实施功能、安装依赖或控制真实应用。
- 验证：文件已生成，核对章节结构；本次仅文档变更，不运行代码测试。

## 2026-09-07 14:00（北京时间）— WinCode v0.6 运行时 UI 取证全量实施交付

- 目标：按照 [WinCode v0.6运行时UI取证实施方案](https://github.com/linnnn89/WinCode/blob/67239e3bcdad2ed6572b7407925906f521567dba/WinCode%20v0.6%E8%BF%90%E8%A1%8C%E6%97%B6UI%E5%8F%96%E8%AF%81%E5%AE%9E%E6%96%BD%E6%96%B9%E6%A1%88.md)，完成 Windows 桌面应用程序 UI 自动化取证功能（C# FlaUI.UIA3 Host、TypeScript UiContracts & FlaUiAdapter、MCP 工具 `wincode_ui_inspect` 及 ToolRouter 深度集成）。
- 架构设计与关键改动：
  1. **Step 1: C# UIA Host 与独立测试夹具 (PR #2)**：
     - 新建 `tools/WinCode.UIA.Host`（.NET 10 console, `net10.0-windows`, `win-x64`, FlaUI.UIA3 5.0.0）。
     - 显式调用 `SetProcessDpiAwarenessContext(PerMonitorV2)` 解决高 DPI / 屏幕缩放坐标物理像素对齐问题。
     - 三级健壮截图管线：`PrintWindow(PW_RENDERFULLCONTENT)` -> `BitBlt` -> GDI+ `CopyFromScreen(Format32bppRgb)`。
     - UIA3 有界遍历：`maxDepth` 与 `maxNodes` 截断，`TruncateReason` 精准标记；`EnumWindows` 过滤输入法及系统浮层；支持仅 HWND 查询时调用 Win32 `GetWindowThreadProcessId` 自动解析并回填归属 PID。
     - 物理像素编号徽章渲染：将 UIA 全局屏幕物理坐标转为窗口相对坐标，在截图上绘制对应 `UiNode.id` 的圆形数字标识徽章。
     - 新建 `tests/fixtures/wpf-ui-review` WPF 独立测试夹具（含普通/禁用按钮、输入框、7 层深度嵌套及启动就绪信号）。
  2. **Step 2: TypeScript UiContracts 与 FlaUiAdapter 封装 (PR #3)**：
     - `src/Core/UiContracts.ts`：定义 `UiRect`, `UiNode`, `UiInspectRequest`, `UiInspectResult`, `UiErrorCodes`（含 `CANCELLED`, `VERSION_MISMATCH`, `PAYLOAD_TOO_LARGE` 等完备错误码），`UI_INSPECT_DEFAULTS`。
     - `src/Core/Config.ts` & `package.json`：升级至 0.6.0，添加 `flauiInspectMs` 及 `adapters.flaui` 配置支持。
     - `src/Adapters/FlaUiAdapter.ts`：实现 `IAdapter`，多级解析 Release/Debug 路径，非侵入健康检查，`Mutex` 串行化防 UIA COM 线程冲突，`killProcessTree` 严格限制仅杀死 Helper 自身进程树（绝不触碰目标应用 PID），支持 AbortSignal 取消与 shutdown 优雅释放。
     - `tests/flaui-adapter.test.ts`：10 项单元与生命周期自动化测试全部通过。
  3. **Step 3: MCP 工具 `wincode_ui_inspect` 与 ToolRouter 集成 (PR #4)**：
     - `src/Gateway/Protocol.ts`：注册 `wincode_ui_inspect`，严格限定入参类型（`integer`、`anyOf` 互斥要求、枚举校验与默认值）。
     - `src/Core/ToolRouter.ts`：实例化 `FlaUiAdapter`，纳入 `initialize()`、`disposeOnce()`、`getRuntimeHealth()`（含 `lastError` 聚合）与 `inspectUi()`。
     - `src/Gateway/McpServer.ts`：注册 `wincode_ui_inspect` 工具调用，按 Grok 4.6 审查意见执行**文本与二进制分离策略**：`content[0]` text 仅包含干净结构化控制树 JSON（剥离 base64 负载并标记 `hasScreenshot: true`，防止模型上下文被巨型字符串撑爆）；`content[1]` 独立以 MCP `image` ContentBlock 交付 Base64 PNG。同时升级 `wincode_hello_world` 暴露 `adapters.flaui` 与 capability。
     - `tests/ui-inspect-mcp.test.ts`：12 项端到端 MCP 协议与并发测试全部通过。
- 结对审查与调试（Grok 4.6 high）：
  - Step 1、Step 2、Step 3 均按规范调用 Grok 4.6 进行深度结对审查。在 Step 3 审查中，Grok 明确提出 Base64 污染 text JSON 会导致上下文膨胀，指导完成文本与图像分离，并补充严格入参校验与并发互斥验证，确保高质量交付。
- 验证证据：
  - `npx tsx --test tests/ui-inspect-mcp.test.ts`：12/12 全部通过（耗时约 4.3s）。
  - `npx tsx --test tests/flaui-adapter.test.ts`：10/10 全部通过（耗时约 1.8s）。
  - `npm test` 全量测试：106 通过，1 跳过（外部可选夹具），0 失败。
  - `npm run build && npm run typecheck`：0 错误。
  - C# UIA Host 发布编译（Release win-x64）：0 错误，正常输出可执行文件。
- 限制与说明：
  - 目前仅支持 Windows 10/11 x64 桌面环境。
  - 目标窗口必须可见且未最小化（最小化窗口 DWM 停止渲染，返回 `WINDOW_MINIMIZED`）。
  - 非管理员权限 Helper 无法读取高权限（UAC 提权）窗口。
  - UI 元素与 XAML 源码精准关联按规划在 v0.7 实施。

## 2026-09-07（北京时间）— v0.7.2 GitHub 发布同步

- 用户明确授权快速推送并合并。核对 origin 为 linnnn89/WinCode，main 与 origin/main 无分歧；发布包含本轮累计的基础加固、v0.7–v0.7.2 源码审查、诊断与测试。
- 复用上一轮 typecheck/build 与全量 153 通过、0 失败、1 跳过结果，不重复运行测试；test-tmp 截图、隔离运行数据与报告由 Git 排除。通过独立 codex 分支和 PR 合并，最终合并状态以 GitHub PR 为准。

## 2026-09-07（北京时间）— 浏览器遮挡 Codex / QQ 的后台截图验收

- 用户明确指定截取浏览器后方 Codex 与左侧 QQ。通过 wincode_ui_list_windows 查找进程并固定各自 PID/HWND，再调用 backgroundOnly=true、capture=original；没有移动、激活、还原目标窗口或操作聊天内容。
- 两个目标均返回成功，captureMethod=printWindowDwm；Codex 1951×1264，QQ 1796×1497。目视确认两张均为完整目标应用界面，包含用户附件中被浏览器覆盖的区域，无浏览器或游戏像素混入。未同步采样本次前台/Z序，不宣称持续遮挡状态已经独立监测。
- UIA 树分别为 12 与 7 节点，只证明本轮返回规模，不代表这些 Chromium 界面的可访问性信息完整。
- 证据保存 test-tmp/occluded-apps-1788784386282/{codex,qq}.{png,json}；包含用户界面内容，仅保留在 Git 忽略目录，日志不抄录聊天内容。未推送截图或提交代码。
## 2026-09-07（北京时间）— GitHub 推送与截图内存优化

- 用户先授权推送已验收版本，再检查资源占用与优化。已将 v0.8 第一阶段及后台模式提交 c16f062，推送 codex/v0.8-background-inspection 并创建 https://github.com/linnnn89/WinCode/pull/9；PR 为 OPEN，未执行合并。本节内存优化在推送后实施，仍为本地未提交状态。
- 审查发现：2 MiB PNG 上限不限制原始 Bitmap 分配；标注 Clone 造成第二份全分辨率位图；MemoryStream.ToArray 在判断 PNG 大小时复制全部缓冲。
- 最小修正：分配前检查 16,777,216 像素/单边 16,384 像素，超限省略图片并保留树。主 32bpp 位图最多约 64 MiB，不是进程总内存上限。原图/标注互斥输出，因此直接原图标注；PNG 先检查 Length，再通过 GetBuffer 转 Base64。Bitmap 分配移入异常处理；窗口发现复用字符串缓冲。没有新依赖或常驻池。
- 既有控制：Helper 串行化并逐次退出，UI 快照不缓存；传输 6 MiB、文本 128 KiB、PNG 2 MiB；缓存默认序列化估算内存 32 MiB、磁盘 128 MiB、单条 2 MiB。这些预算不是整个进程的硬内存上限。
- 验证：Host Release publish --no-restore、TypeScript typecheck 通过；后台/源码专项 12/12、管道/预算/退出边界专项 5/5 通过。后台夹具 10 轮交替原图与标注，10/10 成功，末次标注图已目视确认；每轮 managedChildProcesses=0，缓存均 0 内存条目、1 磁盘条目/66 字节。网关 RSS 首 100.61、峰 102.53、末 91.94 MiB；heapUsed 首 17.56、末 16.85 MiB。报告 test-tmp/background-1788784638642/report.json，输出 test-tmp/v080-memory-run.log。
- 边界：测的是网关请求后 RSS，不含 Helper/GDI 瞬时峰值；没有长期/并发洪峰测试。超大窗口分配前分支经静态检查，未创造超大真实窗口实测。全量 GUI 回归仍暂缓，避免打扰游戏。没有改无关缓存与架构，私人界面截图仍由 Git 忽略。
## 2026-09-07（北京时间）— 强制 WinCoding UI 访问指示器

- 用户要求 UI 调用时在屏幕右上角强制显示红色录制标志与 WinCoding。新增 RecordingIndicator.cs，复用现有 Win32/GDI+，无新依赖；内置 Host 窗口枚举、inspect/review 的实际 UI 取证先创建标志并确认首次绘制，失败拒绝访问，health/ping 不显示，无请求级关闭开关。主屏物理右上角、DPI 缩放、红点 REC 和下方 WinCoding，NOACTIVATE/TOOLWINDOW/layered/topmost，不抢焦点。每次短请求至少保留 600ms；异常/强杀依靠 Helper 所有权回收，没有独立悬浮进程。
- 运行时：专用消息线程避免 UIA 阻塞拖住指示器绘制；每次小尺寸缓冲原子绘制，正常 Dispose 关闭并等待线程退出；自身窗口不进入本 Host 的窗口发现结果。此前内存优化未提交内容保持不变。
- 验证与纠偏：首轮 PowerShell FindWindow 的空类名查询未找到窗口，改为精确 Host PID 类名；探针未设 DPI 感知导致边界虚拟化，修正探针与指示器线程 DPI 后确认物理边界 x=4940..5108、y=12..108。早期探针过早 WM_PRINT 干扰首次绘制，Host 按失败拒绝访问，探针改为等待可见与绘制完成。窗口定向 PrintWindow 探针未完整呈现标签，因此额外只采集指示器所在屏幕小矩形，目视红点/REC/WinCoding；不以不完整探针图冒充视觉通过。
- 实测 scripts/verify-recording-indicator.ps1 四项通过：inspect、listWindows 显示；强杀 Helper 标志移除；health 不显示。每项采样前台均未改变。Host Release publish --no-restore 通过；TS typecheck 与后台/资源边界 7 项通过。最终增加标志后的无激活后台夹具 2 轮成功，记录 test-tmp/indicator-final-background.log。前一轮 3 次报告为 test-tmp/indicator-background.log。没有运行会激活普通夹具的全量 GUI 测试。
- 可见性边界：当前游戏性能 HUD 覆盖标志顶部部分，红点、REC 与 WinCoding 仍可见；不通过反复抢前台解决。普通 topmost 不保证盖过独占全屏、安全桌面或更高层浮层，首次绘制确认也不证明未受遮挡。功能只约束内置 Host，不能阻止恶意程序独立截屏、替换程序或使用其他 Host；未宣称防恶意软件安全边界。用户已授权提示标志，未操作游戏或个人数据。未提交/推送本轮修改。

- 用户要求黑色背景半透明：指示器 layered alpha 从 255 改为 160（约 63% 不透明度）。这是窗口整体透明度，文字与红点同样受影响；位置与生命周期保持原逻辑。Host Release publish --no-restore 通过。
## 2026-09-07（北京时间）— 极简审计日志、容量上限与双渠道提醒

- 用户确认推荐阈值与渠道并要求测试：采用 1 MiB 提醒、2 MiB 停止新 UI 访问，不自动删证据；MCP 原结果返回文本提醒，显式桌面模式弹窗。新增 UiAudit.cs、check-ui-audit.ps1，复用 BCL 和现有 Host，无新 NuGet 包、数据库、后台服务或全局策略。
- 记录：UI 操作前 durable start，结束时追加 end；关联 ID、UTC 毫秒时间、操作、Helper/目标 PID、规范化 HWND、捕获模式、结果码、耗时及标志状态。不写窗口标题、消息文本、截图、Base64 或原始异常详情。典型两条约 300 字节，notice.state 固定 32 字节；本轮真实两次调用后目录共 620 字节。
- 限制：日志在 LocalApplicationData/WinCode/logs/ui-audit，按逻辑文件字节计算。开始前预留 384 字节结束空间，故可略早于 2 MiB 停止；没有自动删除或悄悄停止记账。命名 Mutex 跨 Helper 保护同目录，整个操作占用锁并立即拒绝其他 Helper（AUDIT_BUSY），进程终止后允许接管 abandoned mutex。只有 start 的记录明确视为结果未知。目录扫描限制 128 个平面文件，拒绝子目录/链接。
- 提醒：自动提醒在完成记录后检测，同级 30 分钟冷却；停止等级立即升级提醒。MCP auditNotice.message/目录/字节数保留在返回中，包括载荷超限错误分支；不建立额外任务。--desktop-notice 在记录标志结束后弹窗。独立检查 --audit-check 可显式检查路径，不能改变实际访问的审计目录。手动检查不受自动冷却限制。
- 测试：C# 测试夹具直接链接生产 UiAudit.cs，不引入测试框架包；17 项断言涵盖极简体积、关联、内容排除、阈值/冷却、容量预留、禁止自动删除、缺少 end、只读写入失败、结束容量失败、跨进程并发、异常目录。首次源文件相对路径少算目录层级导致编译失败，修正后通过。TS 审计/MCP 传递、后台与资源边界合计 8 项测试通过；Host Release publish --no-restore、TS build/typecheck 通过。
- 桌面实测：针对 test-tmp/audit-acceptance-01/warning 的弹窗显示 1.001 MiB、建议清理与正确完整路径，原生控件文本核验后自动关闭；报告 test-tmp/audit-dialog-result.json。未填充真实日志目录。MCP 提醒测试使用隔离目录的真实 Host 检查结果透传，不冒充满阈值真实生产调用。
- 实际流程：加入审计后无激活夹具 2 次后台取证成功，日志默认目录 620 字节；报告 test-tmp/audit-live-background.log，具体样本目录 background-1788786428746。全量 GUI 回归未运行，避免打扰前台；默认 npm test 已纳入审计测试。
- 边界：日志为本地追溯材料，不防同权限删除/篡改；第三方写入可使目录超过预算，但 WinCode 新操作会拒绝。文件系统分配空间不等于逻辑文件大小。缺结束记录不能推断成功；强杀后提醒只能在后续请求/显式检测时送达。本轮与此前未提交的指示器/内存优化均保留，未提交/推送。

## 2026-09-07（北京时间）— 快速提交与双语 README 同步

- 按用户要求整理英文/中文独立章节，同步窗口发现、后台截图、半透明强制标志、内存与输出预算、审计阈值及 MCP/桌面提醒；补齐两个工具表，纠正 v0.7 源码候选仍被列为未来功能的旧说明。
- 本次提交包含此前已验证的指示器、截图内存优化、极简审计与相关测试。沿用上节真实验证结果，本次仅做文档与 Git 差异检查，不重复启动 GUI 测试；test-tmp 私人截图、构建产物不纳入提交。

## 2026-09-07（北京时间）— 精简 WinCode Skill 制作与本机安装

- 用户确认制作：仓库 skills/wincode 保留源文件，安装到 C:/Users/40218/.agents/skills/wincode。17 行入口按任务选择 code/ui/diagnostics 三份手册；不复制 README、工具 Schema、源码、构建产物，不引入脚本桥接或依赖。默认自动发现，不改变 MCP 配置。
- 参数对照 Protocol.ts；建议小预算、后台 PID/HWND 定向取证，保留候选/降级/截断边界。明确审计提醒与授权清理，不绕过提示标志或审计。
- 验证：校验器首次因 Windows 默认 GBK 无法读取 UTF-8 中文失败，改用 python -X utf8 后源文件与安装目录均通过；四文件逐字节一致、引用链接存在。未启动 UI、不读取个人数据。客户端是否已重新发现技能尚未验证；仅安装技能不保证 MCP 工具已连接。本轮未提交/推送。

## 2026-09-07（北京时间）— 面向用户的 Skill 与 MCP 独立指南

- 按用户要求在根目录新增 WinCode-Skill制作与MCP配置指南.md，说明渐进读取结构、复制安装、路径适配、STDIO 界面/CLI 二选一配置、验收和审计故障处理。明确 Token 边界与已有技能不直接覆盖。
- 核对现有技能、Protocol/启动入口、README 构建命令和已查证的 CLI 帮助；检查相对链接与 Git 空白差异。本轮仅写文档，不安装依赖、不修改客户端配置、不启动 UI。

- 用户随后授权推送并合并：README 中英章节均加入指南链接；将技能与指南提交至既有 v0.8 分支，经 PR #9 发布。推送前 diff --check 通过；本次文档安装内容未重复执行 GUI 测试，功能验证沿用上文记录。

## 2026-09-07（北京时间）— v0.9 有界局部取证、状态与完整性

- 用户确认上一轮计划后实施。基于已合并 main 新建 codex/v0.9-local-ui；保留既有两份文档删除。README 在执行期间出现并行改版，保留其新版结构，仅追加本轮双语说明，不将整份改版归为本次独立产出。
- 完整性：遍历异常计数并标记 enumerationFailed；OperationCanceledException 继续传播；深度边界仅确有子节点才标记截断。新增 treeComplete（仅结构/输出覆盖）、propertyIssues（不支持/错误/裁剪）和计数。UiPropertyEvidence 保证未读到布尔值不补 false。
- 查询：既有 inspect/review 加可选 query，automationId/name/controlType 精确区分大小写 AND；默认扫描 1000/最多 5000 节点、返回 10/最多 20 候选、2 秒及 50 层软边界。独立于展开子树预算，完整唯一才展开；多个匹配保持歧义，未完成不判唯一。请求内只保留有界候选 COM 引用，不跨请求缓存；达到硬停止条件后不再逐层请求兄弟节点。整个 Helper 截止时间及清理保持原机制。
- 状态：readStates 显式读取 Toggle/SelectionItem/ExpandCollapse 的值，不执行动作、不读取输入框内容；unsupported/unknown 明确。截图仍为整个目标窗口，仅标注返回子树。候选与子树共同计入 128 KiB 文本预算，源码证据继续使用剩余预算。
- 兼容：Host inspectionVersion=2；请求局部查询/状态遇旧 Host 时返回 VERSION_MISMATCH，避免参数被忽略后整窗结果冒充定向结果。版本同步为 0.9.0，没有新增第三方依赖。
- 失败纠偏：首次 Python 读取遇默认 GBK，改为 UTF-8；首次夹具 publish 未带 RID，补用 win-x64 发布到脚本实际目录。实机第一次将 Button 错当叶节点，实际有 Text 子节点，保持真实截断并增加 Text 叶节点断言。另一次将 TryGetValue=false 当成读取异常导致搜索误报不完整；核对 FlaUI v5.0.0 AutomationProperty 源码确认其含义是不支持，改为该属性无字面量可匹配，真实异常仍标记不完整（https://raw.githubusercontent.com/FlaUI/FlaUI/v5.0.0/src/FlaUI.Core/AutomationProperty.cs）。
- 性能：增加响应准备阶段 helperPeakWorkingSetBytes（系统峰值 RSS，不含后续最终序列化，不是硬内存上限）。222 节点夹具全树约 62 KB，局部按钮约 1.6 KB，调用约 0.78 秒，没有证明提速。故不引入 UIA CacheRequest 或跨请求快照缓存；只落实输出缩减与峰值观测。
- 验证：Host Release 发布、TS build/typecheck 通过。非交互默认回归 128 pass、1 skip、0 fail；随后兼容保护及相关变更的五个专项文件 22/22 通过，最终有界搜索停止逻辑及属性语义专项 4/4 通过（内含生产 C# 16 项断言）。前一轮全量结果不冒称包含随后新增的旧 Host 测试。测试脚本分为 npm test 非交互、test:ui 交互、test:all 两者，局部实机另用 test:ui-query。
- 实机：test-tmp/ui-query-1788788783290/report.json，16 次取证全通过，覆盖完整/唯一/歧义/扫描与候选上限/无匹配/叶节点/三类状态/源码联动/标注/重复调用。另两次真实 query 取消和超时确认记录到 Helper PID，结束后 OS 查询为 ESRCH、目标 PID 仍存活；末次 MCP 健康 activePid=null。156 个 100ms 前台采样一致，不证明更短暂变化不存在。review.png 已目视确认窗口图与 #1/#2 局部标注对应，未读取个人应用。
- 维护：README 双语、CHANGELOG、独立安装指南、Skill UI/诊断手册同步；替换安装手册前比较 HEAD 基线，确认无用户编辑，源副本/安装副本一致，技能校验通过。未增加 Skill 入口或默认预读范围。
- 未验证：真实目标控件动态消失的实机注入（搜索/属性失败用生产函数故障注入断言）、本轮新的浏览器遮挡实机、超大 4K/多 DPI 和长期资源走势。未运行会激活窗口的旧 GUI 全量套件。保持本地修改，未提交、推送或合并。


## 2026-09-07（北京时间）— README 双语复核与独立替换稿

- 对照现有源码、配置、脚本和此前验收证据，参考 Playwright MCP、Repomix、FlaUI 的价值说明与快速上手结构，以及 MCP Filesystem 的路径示例。纠正零 Token、绝对免疫、防篡改、MSBuild 求值、即时失效和全进程内存硬上限等超出证据的表述；同步 v0.9 查询、源码候选边界、资源预算与真实测试入口。
- 两次原 README 写入遭工具策略拒绝（blocked by policy，无具体原因），没有执行写入。用户随后明确要求新建 reamdeV2.md 自行覆盖；已按此文件名生成完整中英替换稿，原 README 保留。按用户要求维持 ~ 示例，并明确整段替换为实际绝对路径；修正 Serena 上游链接，不改变代码或客户端配置。
- 验证：15 个本地文档链接存在、4 个 JSON 示例解析通过、所有 npm run 命令与 package.json 一致。反证核查包括后台截图不保证所有渲染器可用、局部查询截图仍覆盖整窗、test:all 不含独立 test:ui-query。仅文档变更，未重复构建或 GUI 测试，未提交或推送。

## 2026-09-07（北京时间）— v0.9 提交与合并

- 用户授权提交合并，并确认删除旧的 v0.6 实施方案与初步构思；两项删除纳入版本记录。用户已将独立替换稿覆盖到 README，提交当前双语版本。
- 本轮验证：typecheck、build、局部查询 4/4 通过；npm test 共 130 项，129 通过、1 跳过、0 失败。未重复运行交互 GUI 套件。提交前确认远端 linnnn89/WinCode、分支 codex/v0.9-local-ui 与 origin/main 无分歧，忽略的临时截图及构建产物不提交。

## 2026-09-07（北京时间）— Agent 效率第一轮

- 目标与范围：用户在迭代方案后要求开始，先落实第一轮现有工具修正；从干净 main（1dca8ab）建立 codex/agent-efficiency-round1。未增加依赖、外部服务或进程常驻机制，未提交/推送。执行期间发现 README 有并行改动，保留且未编辑，本轮文档集中在 CHANGELOG 和仓库 Skill 代码手册。
- 响应：prepare_context 默认 compact 单一 JSON；responseFormat=legacy 保留 JSON + Markdown。新增 ContextResponse 负责最终序列化，完整文本预算包含 JSON 转义、所有文本块及计量字段本身。maxTokens 为 512–65536 的整数，口径为 UTF-16 字符数÷4，显式声明并非模型 tokenizer 或整个协议传输字节上限。兼容模式仍有重复表示，使用方可显式选择。
- 证据：优先同文件中与任务精确匹配的符号，统一 reason/line/startLine/endLine；前缀过长或后续裁剪时保留目标声明。locationKind 区分符号附近、文件开头和全文片段；evidenceInsufficient=false 只表示获得片段，不证明覆盖任务。紧凑全文只返回 packedContent 一份正文，空 pack 保持不足，部分 pack 保留 truncated。
- 参数：candidateFiles 仍为优先候选，未改成排他范围。focusAreas 对齐为最多 5 个字面量文件/目录，不支持 glob，并在检索前拒绝通配符和非法输入；流式读取目录直属项，最多追加 8 个文件，每目录最多检查 1000 项。缺失/不可读/过大/越界/选择上限进入 fileIssues；源码读取校验工作区真实路径，单文件上限与内置打包器的 500000 字节阈值一致。
- 完整性：小预算下保留 queryComplete/truncated/evidenceInsufficient；元数据裁剪显式标记 metadataTruncated、limitationsOmitted，omittedFileCount 保留完整遗漏计数。重构计划返回影响分析的风险、来源、歧义与局限；先提示具体待核证据，取消固定提取接口和零回归承诺。
- 验证过程：先增加 11 个专项场景，旧实现 11 项失败；修复后逐项通过。一次整文件补丁因同路径重复操作被 apply_patch 格式校验拒绝，没有文件变更，改用单文件增量补丁完成。反证自审增加空打包、长前缀挤掉目标、外部 junction 与元数据遗漏计数场景。
- 验证结果：完整默认非交互 npm test 为 145 项，144 通过、1 跳过、0 失败，包含真实 stdio MCP 紧凑/兼容调用；随后补充遗漏列表标志及第 16 个专项场景，最终专项 16/16、typecheck、build 均通过。该全量结果先于最后两项局部补充，不冒称是最终全量重复验收。未启动交互 GUI 或读取个人应用数据。
- 同证据对比：隔离夹具 compact 1493 字符、legacy 2281 字符，证据与局限数组一致，文本量减少约 34.5%。这是本版本两种输出模式的单夹具对照，不是旧版本整体基准，不证明真实模型 Token、调用次数或时延下降。
- 交付与后续：已构建 dist；既有 MCP 进程未重启，需要重新加载连接取得新 Schema/实现。本机安装目录的 Skill 副本未改动，只同步仓库源手册。第二轮精确定位参数/排他范围、第三轮跨调用复用仍未实施；后续效果需固定端到端任务集评估。

## 2026-09-07（北京时间）— Agent 效率复核修补与精确取证

- 授权：用户在四项复核缺陷与第二轮方案后同意继续；保留 candidateFiles 优先语义，新增可选排他范围和精确定位。继续使用现有依赖，未提交、推送、重启 MCP 或更新本机安装 Skill；README 并行修改未触碰。
- 修补：小预算先缩减辅助列表与说明，避免缺失候选元数据挤掉有用正文；修复前缀恰好截至声明前换行时遗漏目标；focusAreas 使用逻辑工作区路径展示、真实路径校验，支持目录联接；打包器提供内部正文位置，分别报告 selectedFiles、packedFiles、returnedFiles 与 bodyStatus，部分打包/最终裁剪后不再把未返回文件标记为已包含。旧缓存键升级以免复用缺少位置清单的结果；无清单的外部结果保持 unknown/null。
- 精确取证：scopeFiles 限定最多 20 个文件并跳过全仓库符号搜索；lineRanges 接受最多 8 个文件、每文件一个 1 起始闭区间、最多 500 行，跳过符号查询，越界返回缺口。symbol 必须结合 scopeFiles，复用本地 C#/TS/JS/Python 声明解析，精确区分大小写；读取内容在本次符号解析和片段生成间复用。重名/未找到/语言不支持不返回误导的文件头，始终声明 queryComplete=false 与非语义局限。未新增语义后端调用，也未把正则匹配称为 Serena 语义解析。
- 参数边界：scopeFiles 不与 focusAreas 混用；candidateFiles/lineRanges 必须在 scopeFiles 内；symbol 与 lineRanges 互斥；lineRanges 不与 includeFullText=true 混用。参数错误在检索前返回，路径仍经真实路径边界校验。
- 反证自审：检索到了一个同名声明并不能保证唯一；覆盖单文件重载、跨文件重名和一文件重名同时另一文件唯一的组合。全文打包成功也不保证预算裁剪后仍有正文；覆盖 Markdown/XML 正文位置、部分 pack、截断至正文之前以及未知位置结果。500 行上限并不保证全部返回，compact/legacy 的 512 预算均保留实际范围与截断状态。
- 验证：专项 25/25；最终 typecheck、build 通过；完整默认非交互 npm test 共 155 项，154 通过、1 跳过、0 失败（约 31.2 秒）。测试中有意注入的 Serena 失败/超时和 watcher 失败被对应断言覆盖，不是未处理故障。git diff --check 通过，仅提示现有 Windows 行尾转换。未重复运行交互 GUI 或读取个人应用数据。
- 效率证据：精确行号及排他文件夹具均记录全仓库符号查询为 0；相同证据夹具 compact 1553、legacy 2341 字符，减少约 33.7%。这是当前两种格式对照，并非旧版本端到端基准；未测真实模型 Token、复杂项目时延或用户任务成功率。
- GitHub 对照复核：Serena（https://github.com/oraios/serena）提供符号级语义检索，Repomix（https://github.com/yamadashy/repomix）提供仓库打包；本轮只复用现有工具边界实现按需取证，没有引入它们的新后端或依赖。不得将当前局部正则定位等同于上游语义能力。
- 后续建议（未实施）：先用固定任务集记录工具调用数、重复范围读取、返回字符量、耗时和完成率；若重复取证占比足以抵消维护成本，再讨论带内容变化校验的跨调用证据复用。公共接口、失效语义和额外资源预算待方案确认。当前 dist 已更新，既有客户端需重新加载 MCP 才能取得新实现/Schema；仓库 Skill 手册已同步，本机安装副本未更新。

## 2026-09-07（北京时间）— 效率改动推送与第三轮测量

- 用户要求先推送，再按建议开始迭代。核对 origin=https://github.com/linnnn89/WinCode.git、分支 codex/agent-efficiency-round1；fetch 后 origin/main 与本轮起点 1dca8ab 一致。仅暂存上一轮 13 个效率相关文件，保留另一任务的 README 修改。
- 推送完成：ff8b7232518157ff2ec586e9c6dd7a7fb4de9c20（feat: bound agent context output and add precise evidence retrieval），已推到 origin/codex/agent-efficiency-round1，ls-remote 核对远端提交一致。没有合并 main。沿用上一轮最终 typecheck/build 和 154 pass、1 skip 的全量结果；推送前 staged diff --check 通过。
- 新迭代：新增 scripts/benchmark-agent-efficiency.ts、tests/agent-efficiency-benchmark.test.ts，提供 npm run benchmark:agent -- 1/3 与 npm run test:benchmark。6 个固定场景：已知符号、已知行号、重名、缺失、重复读取、修改后复查。两种策略具有相同初始位置知识；候选优先仅在证据断言不满足时精确补取，精确优先直接定位。每个场景/策略/轮次独立合成工作区，真实 MCP handler 和本地符号解析，未模拟生产返回；关闭语义上游和 GUI，无新依赖。
- 测量边界：记录 MCP 调用数、内部符号查询调用（包括缓存命中，不能当作磁盘扫描数）、返回 UTF-16 字符、MCP 调用墙钟时间、跨调用重复显示的非空源码行。重复行按文件、实际行号、内容 SHA-256 判定；修改行不计重复。未计模型思考、真实 Token、启动/清理或真实用户任务成功率。重复与编辑场景是人为构造，不据此估计真实用户频率或缓存收益。
- 小样本后正式测量：单轮 12 场景运行均达标，约秒级成本；随后三轮交替策略顺序，共 36 场景运行全部达标。候选优先/精确优先各 18/18 通过最终证据断言，首调用达标 9/18 vs 18/18；MCP 33 vs 24 次（-27.3%），符号查询 21 vs 0 次，返回字符 50760 vs 29841（-41.2%），重复显示行 141/513 vs 15/111。异质场景调用耗时中位数约 25.47 vs 1.99 ms，只作夹具描述，不对真实项目声称同比提速。
- 反证复核：已知符号场景两者均为一次 MCP 调用，精确路径 1791 字符反而比候选路径 1771 字符略多，因为保留了非语义局限；不能宣称所有场景同时省调用、省文本。重复显示行集中于人为重复/修改后复查，不能把所有重复行都认定为无效；文件修改后的核验必须保留。
- 依据结果的实际调整：仓库 Skill 代码手册默认例子改为 scopeFiles，明确行号优先、文件+符号其次、需要发现其他文件才用 candidateFiles；补充取证满足后的停止条件，以及修改、截断、换工作区时的重取条件。尚未部署到本机安装 Skill，不改变当前 MCP 协议或增加缓存。
- 验证：最终 npm run typecheck 通过；新增重复度计量与资源上限测试 2/2；三轮基准的 36 个证据断言通过；git diff --check 通过（仅 Windows 行尾提示）。本轮未修改 src 生产代码，未重复全量回归或 GUI 测试；前轮全量结果不冒称本轮重复执行。
- 报告：[三轮 JSON](../test-tmp/agent-efficiency/1788793544719-3736/report.json)，包含请求参数、逐次耗时/文本量/断言、环境、基线提交、工作区脏标记和脚本 SHA-256；生成目录按既有约定被 Git 忽略。新基准/手册/日志改动目前仅本地，未再次提交或推送。
- 后续建议：先在真实开发任务中沿用同一口径测量实际重复请求，再评估带内容变化校验的复用。当前证据支持调整取证路由，不能证明新增跨调用缓存的维护成本值得承担；缓存接口、失效条件和资源预算仍需具体方案后确认。

## 2026-09-07（北京时间）— 基准审核修补、C# 分层与 README 同步

- 授权：用户同意执行审核建议，同时要求同步 README。本轮修正未提交的基准、测试与手册，保留 README 其他已有改写；没有修改生产 src 接口、安装依赖、启用语义上游或增加跨调用缓存，未提交/推送。
- 成功判定：新增 validateEvidence，核对当前夹具的真实文件、正整数范围、片段行数、正文（含截断前缀）、请求范围、符号所在行、诊断对应文件以及 evidenceInsufficient/queryComplete 状态。单独核对实际响应字符计量与预算。错误响应不再以正文包含标记而通过；正向定位和负向诊断继续使用明确场景断言。
- 失败报告：transport-error/tool-error/invalid-response/scenario/setup/各清理阶段分别记录；无效响应与异常不会被一次成功重试掩盖，只有合法但证据不足才进入有限补取。每个场景结束依次尝试所有清理动作，清理失败保留且场景不通过；后续场景继续运行。CLI 写出含成功与失败场景的 JSON，并依据失败状态设置非零退出码。
- 场景与公平性：从 6 类扩为 10 类，复制既有 dotnet-mini 的 MemoryService.cs、SaveManager.cs 到各自隔离夹具，不修改原件或启动程序。新增 C# 未知文件、已知文件、已知文件与符号、已知行号四层；两种策略只使用各层共同提供的信息。未知文件两者均进行发现，精确策略也不会得到预先泄露的文件路径。
- 停止与新鲜度：repeat-unchanged 中候选策略再次请求，精确策略在受控夹具明确无修改时复用已验证片段并记录 reuse-after-known-no-change；read-after-edit 两者均修改夹具版本、更新校验源并重新请求。此处依赖所有夹具写入受控，不是生产文件新鲜度探测或缓存；实际外部变化、工作区切换仍须重新取证。
- 测试过程：初次新增故障套件 5 pass/1 fail，旧正文注入错误地同时改变了行数，先被 invalid-range 拒绝，没有走到目标 stale-or-wrong-body 断言。改为保持行数、只改正文字符的注入，未降低断言；最终专项 6/6 通过，涵盖原审核的错误范围/错误诊断文件、旧正文、JSON 损坏、传输与工具错误、混合结果报告、无变化复用、编辑重取及清理失败。新增测试接入默认 npm test。
- 最终验证：typecheck/build 通过；默认非交互完整回归 161 项，160 pass、1 skip、0 fail，约 28.9 秒。随后单独运行三轮基准，避免与回归并发干扰耗时；两组各 30/30 场景运行通过（10 类各重复 3 次，并非 30 个独立任务）。MCP 调用 45 vs 33，符号查询调用 30 vs 3，返回字符 67413 vs 42345，重复显示行 141/609 vs 6/186。耗时中位数约 24.67 vs 1.68 ms，仅为本地夹具调用时间。不能将新场景总量与旧六场景报告直接比较，也不能声称真实用户或模型的通用提速。
- 报告：[Schema v2 三轮 JSON](../test-tmp/agent-efficiency/1788794274918-25708/report.json)。仍按既有 test-tmp 忽略规则保存；不覆盖旧报告。场景结果新增 knowledge、errors、actions、reusedEvidence 等字段，保留原始请求和逐调用状态。没有收集个人应用内容。
- README：同步中英文代码上下文路由、compact/legacy、字符预算估计、生产新鲜度限制、基准命令、10 类场景与失败报告说明；明确旧/新版总量不可直接比较，修正本轮涉及的“严格模型 Token 预算”表述。仓库 Skill 与 CHANGELOG 同步；本机安装 Skill 未更新。
- 文档验证：README 6 个 JSON 示例可解析，8 个不同本地链接均存在，git diff --check 通过（仅 Windows 行尾提示）。未运行 GUI 测试。后续如需生产跨调用复用，仍需单独设计可验证的内容变化、工作区隔离、容量与失效规则；本轮没有实现这些接口。

## 2026-09-08（北京时间）— 汇总后续迭代路线图

- 授权与资料：用户要求结合「WinCode迭代路线图」及「优化 Agent 使用效率」的 TavernDesk 实测，新增根目录 Markdown；随后明确要求一个 GPT-6 High 子智能体检索 GitHub 经验。已读取两段对话，按要求使用 gpt-6-astra/high 独立只读研究，综合官方仓库/文档，无额外委派或依赖安装。
- 基线：分支 codex/agent-efficiency-round1，HEAD 6fba44a7404960257e5c749210892477ad26845c，源码版本 0.9.0，SDK 锁文件 1.30.0；不把旧对话 main@b492491 当作本地基线。开始时工作区干净。
- 当前核查：workspace_open 仍默认附带深度 2、宽度及整响应未设预算的目录树；hello 返回 0.9.0 和工具名，缺少构建/schema 身份。当前会话已经暴露 scopeFiles/symbol/lineRanges，本次限定 483–705 行实际只返回 483–576、truncated=true；不能用 queryComplete=true/evidenceInsufficient=false 代替任务覆盖。历史约 5 万 token 为用户提供的实测概括，本次未重测 TavernDesk 或复算原始响应。
- 路线决定：按用户指定将工作区摘要、运行实例/能力核对、精准取证实机验收排在前三；随后 Serena 身份/解析正确性、MCP SDK v2、UI→XAML→C#，MSBuild/WPF 深检/Repo Map 按真实需求进入。应用导航可访问性、computer use 错归窗口与测试环境初始化分别归因，不算成 WinCode 三类新增缺陷。固定测试目录的既有完成状态引用原工作记录，不冒称本轮验证。
- 交付：[WinCode-迭代路线图.md](https://github.com/linnnn89/WinCode/blob/d51f3e105b07b50b1e2535ca541f532ea77b3fc5/WinCode-%E8%BF%AD%E4%BB%A3%E8%B7%AF%E7%BA%BF%E5%9B%BE.md)。包含 R1–R9 目标、最小范围、代码落点、验收反例、GitHub 五项经验、暂缓项和后续 USER_DECISION_REQUIRED。补充同会话诊断与真实宿主验收区别、最终正文范围覆盖、Node 20+ 迁移门槛；不为 Inspector 额外安装或升级环境。
- 文档验证：UTF-8、13 个不同本地链接、占位/冲突标记与围栏检查通过；初次空白检查发现 Markdown 换行末空格，已改为段落分隔。最终复核仅新增路线图并增订本日志。未修改生产代码、配置或锁文件，未运行代码回归、GUI/Serena 实机验收，未提交、推送或更新发布包。

## 2026-09-08（北京时间）— R1 工作区摘要 0.9.1

- 授权：用户要求按路线图逐版本复测、Debug、推送 PR 并合并；随后接受 R5 最低 Node 20。实施前 fetch 核对 origin/main=bae4a87（PR #13 已合并），从该提交新建 codex/r1-workspace-summary，带入本任务路线图和日志；不回退其他任务工作。
- 改动：workspace_open 默认仅工作区身份、项目摘要和最多 8 个入口，完整 JSON 默认 8000 UTF-16 字符（可设 2048–32768）；不再计算全仓文件数/字节数或构造目录树。项目发现限制 2000 项、深度 3、描述文件总读取 256 KiB；未知统计为 null，缺口明确记录。includeTree 为有界兼容选项；新增无状态 wincode_list_directory，遍历与序列化分别限额，不改变源码搜索/缓存过滤。
- Debug 与反例：检查链接逃逸、非法目录参数、宽目录、长 Unicode 项目列表、超大 solution；修正 .slnx 命名/数字实体路径及非法实体处理。真实 TavernDesk 入口曾被多语言 README 挤占，缩减通用 README 入口选择后保留 TavernDesk.App/Core/Infrastructure 等项目。workspace 切换异常仍恢复原根和 trash。
- 验证：typecheck/build 通过；完整非交互回归 170 项，169 pass、1 skip、0 fail；最后 README 入口筛选修正后 build 与专项 9/9 再次通过。报告保存在 test-tmp/r1/（既有忽略目录）。未安装依赖或运行 GUI；版本同步为 0.9.1，README/Skill/CHANGELOG 更新真实契约。
- 真实目录复测：新编译生产 Gateway + SDK InMemoryTransport 的独立 MCP 会话打开 I:/WinCode 和 I:/New-tarven，断言响应预算、无默认树、入口上限及 TavernDesk.sln/项目身份。WinCode 3554 字符；TavernDesk 最终实测见 test-tmp/r1/real-workspaces.json。深度缺口明确为 partial，不把它当全仓盘点。该会话关闭 Serena/FlaUI/Repomix CLI，不代表当前 Codex MCP 连接或真实应用 GUI 已更新。
- 合并：最终 TavernDesk 3705 字符；PR #14 的 C#/TypeScript CodeQL 全部成功后按提交 32b2385 锁定合并，远端确认 MERGED，main=7ce737f1923b0dd31935cd453e39b114ce960091。

## 2026-09-08（北京时间）— R2 运行实例与工具契约 0.9.2

- 从 R1 已合并 main 新建 codex/r2-runtime-contract；继续用户已授权的逐版 PR 流程。R4 在 test-tmp/r4-worktree 独立准备，避免混入本版构建/测试/提交。
- 构建：新增 scripts/build.mjs，复用本地 TypeScript，无依赖安装；指纹包含 WinCode 自身源码、构建配置和锁文件以及实际 JS 产物，编译前后源码变化则失败。manifest 缺失、无效、版本/产物失配或源码模式明确 unknown；RuntimeIdentity 模块初始化时快照并冻结，不读取被分析项目 HEAD，不因重编译磁盘文件而改写旧实例身份。该校验是本地一致性诊断，不是签名或供应链认证。
- 契约：tools/list 与 hello 使用同一已注册定义快照，默认只返回 schemaHash/toolCount；toolName 按需返回单个 inputSchema 和 hash，capabilities 直接源自注册工具。hello/context 未知参数明确失败，避免拼错后静默成功。原手写 JSON-RPC 脚本换成现有 SDK stdio 客户端，隔离夹具且 finally 清理。
- 验证：typecheck/build 通过，身份/契约专项 8/8；完整非交互回归 178 项，177 pass、1 skip、0 fail。test:e2e 启动独立生产 Gateway stdio 进程：initialize、tools/list、hello 参数/hash 对照、scopeFiles+symbol 与 lineRanges 的第 50 行实际正文、未知参数拒绝及末次同实例核对均通过。报告 test-tmp/r2/，该测试关闭上游/GUI。
- 宿主边界：实际调用当前 Codex 的 WinCode hello，仍返回 0.9.0、无新 build/schema 身份，证明重新编译不自动刷新既有连接。未重复尝试新参数；未改全局 MCP 配置或终止宿主进程。后续真实宿主 R3 验收仍需要客户端重连，不能用独立 stdio 成功替代。
- 合并：PR #15 C#/TypeScript CodeQL 全部成功后锁定 9467ede 合并，远端确认 MERGED，main=2cbf443cc983828dd9c9cdb066f2c03f5aecaada。

## 2026-09-08（北京时间）— R3 精准范围覆盖 0.9.3

- 从 R2 合并基线新建 codex/r3-context-coverage。显式 lineRanges 读取使用剩余响应预算，不再固定截为 4000 字符；500 行/500KB 等既有限制保留。序列化每次裁剪后重算最终 coverage，包含请求/完整行数、实际范围、半截尾行、未返回原因和有界补取；超预算可省明细但保留总计。非范围请求 coverage=null、taskCoverage=null，不把声明附近片段当方法本体覆盖。
- 反证：223 行足预算、512 token 半行、newline 边界、重复证据去重、多文件明细裁剪、缺失/EOF、最大预算无进展重试均覆盖；nextRequest 从半截整行补取并在需要时提高预算，达到最大值且不前进时停止建议重复请求。
- 测试组织失败与修复：首次完整回归因 test-tmp 下两个临时 worktree 被既有符号搜索纳入，ToolRouter 出现三处定义而触发 UNKNOWN。没有削弱断言或改搜索语义；核对绝对路径后用 git worktree move 移到 I:/WinCode-worktrees，完整复测恢复正常。该问题归于本次测试环境组织。
- 验证：typecheck/build 通过，专项及既有上下文 34/34；最终完整非交互回归 187 项，186 pass、1 skip、0 fail；独立 stdio 契约与正文探针通过。真实 TavernDesk 源码验收脚本 scripts/verify-tavern-context.ts 通过 8 场景并逐片段与实际源文本核对；当前 ShowCharactersAsync 位于 309–324 行，已知方法首调命中。1–223 行请求实际完整返回，9942 字符；该新增场景没有旧版配对测量。原 7 个场景的基线与新版请求相同，新增覆盖信息使部分响应更长，不主张普遍 token 降低。
- 报告：test-tmp/r3/baseline-1788823132218.json、acceptance-1788823577798.json、regression-final.log、stdio.log；源码只读，哈希和实例身份记录于报告。仅知文件时仍返回文件头，不能替代已知方法时显式传 symbol；未知文件的当前例子首调找到目标，不能推论所有未知任务成功。
- GUI 与归因：复用 I:/New-tarven/work/TAVERN-TEST/profile，经既有脚本 --no-restore 构建 0 警告/0 错误并启动本轮 PID 24964，启动回执核对专用数据/配置/日志路径。当前旧版 WinCode 按该 PID/HWND 查询 NavCharacters，完整遍历 68 节点唯一命中，名称“角色”、isEnabled=true，说明应用可访问性修复有效。后台 PrintWindow 图像几乎空白，不能用于视觉验收；computer use 本轮未调用，不能将空图归为其窗口归属问题。
- 宿主限制：用户表示无法重连当前 Codex WinCode MCP；保留真实宿主新版验收待办，继续以新启动生产 MCP 进程完成可执行复测与已授权 PR 流程。没有终止旧 MCP 或修改全局配置，不能将本版源代码/stdio 成功写成旧连接已升级。
- 合并：PR #16 CodeQL 全部成功后锁定 8bda24d 合并，远端确认 MERGED，main=0351111772a3265418d04bd3d0e35116644f5b0a。

## 2026-09-08（北京时间）— R4 Serena 身份与解析 0.9.4

- 从 R3 合并 main 建立 codex/r4-serena-correctness，整合独立 worktree 的两个生产文件和专项测试。原始 namePath/容器/重载索引完整保留；简单名称先完整唯一语义定位，歧义或查询不完整不再查询第一项引用。完整身份使用前导 / 的精确模式，防止同后缀重定向；ImpactAnalyzer 透传身份且歧义不发引用查询。
- parser 区分合法空 []/{}、未知结构、损坏 JSON、上游缩略输出；部分合法条目不能变成完整唯一结果。find_symbol 使用官方 name_path_pattern，不拿需要具体文件的 overview 替代全局搜索。上游零基坐标改为一基，引用的声明起点另标 lineKind=containing-symbol；现有四个测试坐标断言按真实转换规则对齐。
- 反证修补：同一文件内两个容器/重载按身份计数，不能按文件去重为唯一；歧义候选上限 20，保留 candidateCount/candidatesTruncated，41 个候选也不选择首项。源码片段包含摘要字样不误判为上游摘要。
- 验证：新增专项 27 项（子智能体 26 项加主智能体候选上限测试）；typecheck/build、默认完整回归 214 项（213 pass、1 skip、0 fail）通过；生产新 stdio 契约/正文与 TavernDesk 8 场景再次通过。报告 test-tmp/r4/；未安装/启动真实 Serena LSP，受控响应/现有 mock 握手不能替代真实语言服务器验收。
- 用户新增要求：另开 gpt-6-astra/xhigh 专用只读子代理诊断旧版本连接。初步对照：该新代理实际 Codex MCP hello 已为 0.9.4 且 build.status=verified，主代理同时仍为 0.9.0、旧启动时间不变；配置/进程根因继续核对。新代理连接成功不代表父连接已重启。
- 合并：PR #17 CodeQL 全部成功，锁定 8276992 合并并确认 MERGED，main=95446c3e06628561501eb31a70bc6da6bea1ccd7。

## 2026-09-08（北京时间）— R5 SDK v2 / Node 20，0.10.0

- 用户已明确接受 Node 20 最低版本。核对官方迁移文档和 npm，server/client/core 均有稳定 2.0.0，SDK engines>=20；沿用当前 Node 24.19.0 执行，不下载/切换系统 Node，不宣称单独在 Node 20 跑过。
- 迁移：生产 Gateway/Serena 客户端、stdio/in-memory、测试与脚本全范围更换公开 import；handler 改方法字符串与 ctx.mcpReq.signal，callTool 取消/超时改为 v2 第二参数。直接依赖仅 server/client 2.0.0，移除旧 SDK 和未直接使用的 Zod3，v2 传递依赖统一 Zod4.5.4；没有安装 codemod/Inspector，没有启用新协议默认行为或改变工具参数。schemaHash 与 R4 同为 b640821440bfe6f961683ce22ce6266a3ca6c74f363ceb54d3442bdbca12f191。
- 安装失败与修复：首次并存安装被旧 SDK 依赖链 body-parser@2.3.0 请求未发布 iconv-lite@^0.8.0 阻止；只读 npm 日志及公共 registry 核对后，移除已计划退出的 v1 声明和未用直接 Zod 声明再安装成功，未加不满足上游范围的 override。首次 typecheck 查出三处旧 callTool 三参用法，按 v2 API 修正，保留信号/超时断言。
- 验证：typecheck/build、独立 stdio initialize/list/schema/目标正文、TavernDesk 8 场景通过；完整非交互回归 214 项（213 pass、1 skip）；真实隔离 WPF 的 UI/协议回归 34/34，含图片独立 block、真实客户端取消传递、helper 退出、工作区切换和重复窗口筛选。日志 test-tmp/r5/；GUI测试为专用夹具，不证明 TavernDesk 的后台空白截图已修复。
- 旧连接诊断结论：专用 GPT-6 xHigh 子代理核对同配置同绝对启动路径，旧主连接与新子连接返回不同版本/启动时间；旧进程持续运行是直接解释，不是新版磁盘无法被 Codex 加载。新实例0.9.4与当时manifest一致。官方 config/mcpServer/reload 存在但当前工具未暴露且无单服务器无扰动保证，未调用。详见根路线图第13节；该取证在R5依赖迁移前完成。
- 合并：PR #18 CodeQL 全部成功，锁定 fe78222 合并并确认 MERGED，main=9d9053b87fea1dc9accd7965b8bbcedb0c0782b3。

## 2026-09-08（北京时间）— R6 UI 到源码候选 0.11.0

- 从 R5 合并 main 建立 codex/r6-ui-code-navigation。UiReview 仍只采一次快照，增加可选 candidateCodeFiles（1–8 个明确 .cs 路径）；从已有 XAML 的 Click/简单 Binding 提取文字声明/赋值候选、哈希和下一步限定读取。不提供 DataContext/模板求值，不推定 CanExecute 原因，runtimeSourceVerified=false、runtimeBuildSourceIdentity=unknown。
- 预算与隔离：单文件 256 KiB、总计 1 MiB、40 线索/200 匹配/每线索最多 5 个输出、代码 JSON 16000 字符，受整体 UI 文本 128 KiB 二次约束。非法候选参数在采集前拒绝；无该参数不读 C#，显式候选外不扫描；Gateway 优先省略新增代码元数据，保留 UI 节点与图片标号。
- 独立反证发现并安排修补：插值表达式内嵌字符串泄漏为代码、多赋值伴声明未标歧义、null/超长构造参数被作为 symbol 建议、最后一次文件关闭期间取消未传播。为避免变量遮蔽导致跳错方法，nextRequest 改为赋值所在精确行，relatedSymbol 仅线索；调用方读取赋值后再明确请求候选方法。
- 新 Codex 连接早期验收：构建 990ab3cc9f22ba454f7867fc1013414650bad5c054560a50084eae8ac29101bb（边界修补前），0.11.0/verified、schema 确有 candidateCodeFiles。TavernDesk PID24964/HWND0x100800 完整查询 68 节点、NavCharacters 唯一；XAML116 行 Command → C#127 行赋值/192 行声明 → 实际 ShowCharactersAsync309–324 正文。7 次 MCP 调用含工作区恢复预算2000被拒后改2500成功；本连接最后恢复 I:/WinCode。该证据不能替代后续最终构建，父连接仍旧。
- 隔离 WPF 测试在仓库外复制 6 个源码文件，空本地 NuGet feed 只复用 SDK/缓存；已观察 false→源码副本单行 true→重新编译与启用，首次结束清理因 EXE 短暂占用失败，补退出等待与有限重试后复测。两个旧失败目录的后续 PowerShell 清理被自动审批拒绝（仅 blocked by policy）；未绕过，保留 C:/Users/40218/AppData/Local/Temp/wincode-ui-code-runtime-0oJpM9 与 wincode-ui-code-runtime-EybwBw 作为故障遗留，不影响工作区。
- 最终修补与验证：上述 4 项均修复，普通/verbatim 插值支持有限嵌套屏蔽（深度 12）；复杂插值原始字符串明确不支持。专项 15/15，typecheck/build/独立 stdio 通过；非交互回归 229 项（228 pass、1 skip）；重编译专用 WPF 后 UI/协议 34/34。新源码修复测试 1/1：PID27644 disabled → 读取第38行赋值 → 显式请求谓词正文 → 外部副本 false 改 true → 重新编译 → PID8236 enabled；源码与程序集哈希均变化，精准读取不含旧 false，本次新目录已正常清理。
- 最终构建 aa1bb067cc79e5cab41ed17961a5c4a11c1d2948acee1c908356cf6b22acf49d，在新生产 stdio 上通过 TavernDesk 原有 8 场景及可选真实 UI 验收：UI review、赋值行 nextRequest、显式方法正文共 3 次调用，分别 6164/1877/2181 字符；赋值行覆盖完整，方法正文实际核对通过。报告 test-tmp/r3/acceptance-1788825262426.json；其余日志 test-tmp/r6/。没有将截图空白、旧主连接或真实 Serena LSP 未验收写成已解决。
- 提交与交付：实现 dfeeab1 已推送 [PR #19](https://github.com/linnnn89/WinCode/pull/19)，本次记录补充后按最终提交的远端检查结果合并，实际合并状态以该 PR 为准。R1–R6 均已完成版本实现与复测；R7–R9 尚无新进入证据，继续按路线图条件安排，不擅自启动 MSBuild 求值、进程内 WPF 深检或 Repo Map。
- 最终真实 Codex 身份验收：07:56:53 新代理实例 a90b9128-2d0b-4c02-9676-9512f9c36b6d 实际 hello 返回 0.11.0、verified，buildId 与上述最终 aa1bb067… 完全一致；实际 ui_review schema 含 candidateCodeFiles，整体 schemaHash=2837d4e1e2b0b35bdae5bd9ec451ea7bea9396df26aa4446cbe2d4020c4316b7。仅调用一次 hello，没有重启/修改配置；它确认最终构建可由 Codex 加载，不代表父连接更新。

## 2026-09-08（北京时间）— 当前主连接 TavernDesk 实测验收完成

- 用户要求完成实测问题下一轮迭代。基线 main@8f997d8 已包含 R1–R6，工作区干净；此前对话“下一轮尚未开始”已被当前代码和历史合并记录纠正。本次建立 codex/tavern-host-acceptance，仅更新 README、路线图及本日志，不重复实现已有功能。
- 直接使用本主任务当前连接的 WinCode MCP：首末 hello 均为实例 1b949eb7-14e4-45c6-9cbd-6e6c21eef32a，startedAt=2026-09-08T00:25:54.527Z，version=0.11.0、build.status=verified、revision=8f997d8427301f97cd8d4b4da80b688e83f95c54。buildId=8510232a8a407b93464fbc59a7db9a0dfa51c6eeb5545dca06a666fa4de5ec52；schemaHash=2837d4e1e2b0b35bdae5bd9ec451ea7bea9396df26aa4446cbe2d4020c4316b7，实际参数含 scopeFiles/symbol/lineRanges。不是用独立 stdio 或其他代理替代本连接验收，也没有主动重启 MCP。
- workspace_open(I:/New-tarven) 默认单块 JSON 3705 字符，无目录树、入口最多 8 项；work/.publish-verify 等作为省略项报告，未测总数为 null，项目扫描不完整明确标记。按需列出 ViewModels：访问/返回各 10 项，1193 字符，entry-budget、scanComplete=false、truncated=true。
- 精准取证：ShowCharactersAsync 首调返回第 309 行声明及 301–324 行证据，2137 字符，保留本地模式匹配的语义不完整提示。1–223 行请求返回 223 个完整行、9934 字符，allRequestedCovered=true；512 token 估计预算返回 1510 字符，仅 9 个完整行、第 10 行半截，allRequestedCovered=false。小预算覆盖明细被省略时仍保留总计，不把 queryComplete=true/evidenceInsufficient=false 误判为完整覆盖。
- 原始响应逐条核对 UTF-16 字符预算、实际源码片段/行号、目录截断和同实例身份；源文件 SHA-256=40c34ef90dc3746ab002e9dbcf17e1ff5287faacaa0da71942a59218ae7ff450。证据：[当前宿主原始响应及校验](../test-tmp/tavern-host-acceptance-20260908.json)，按既有 test-tmp 规则忽略。历史约 5 万 token 缺少同口径原始配对，不计算百分比提速。
- 执行 node node_modules/tsx/dist/cli.mjs --test tests/workspace-summary.test.ts tests/runtime-identity.test.ts tests/runtime-contract.test.ts tests/context-coverage.test.ts：26/26 通过，0 失败/跳过，日志 test-tmp/live-tavern-targeted.log。没有生产源码变更，不重复全量回归或重新构建。
- 共 8 次真实 MCP 调用：首末身份 2 次、打开/恢复工作区 2 次、精准取证 3 次、有界浏览 1 次。最终活动工作区恢复 I:/WinCode。仅只读 TavernDesk 源码，未启动 GUI、读取数据库、调用 Provider 或新增依赖。此前后台空白截图、computer use 窗口归属以及真实 Serena LSP 未验收仍保留，不纳入本次完成结论。

## 2026-09-08（北京时间）— 0.11.1 证据边界与使用手册修补

- 授权：用户要求修复重新评估指出的缺口，推送 PR 并合并。从 main@8f997d8 建立 codex/evidence-usage-fixes，包含此前未提交的主连接验收文档；范围限于安装手册一致性、符号片段/补读及截图质量提示。R7–R9 和真实任务/原生工具成本对照仍按进入条件另行评估。
- 片段：保留旧 bodyStatus 枚举以兼容调用方，增加 bodyStatusScope 区分 displayed-snippet 与 packed-file；符号窗口始终 symbolCoverage=unknown。fileLineCount 来自同次源码读取；最终序列化后按实际尾行生成最多 80 行的 nextRequest，半截尾行重读、预算不足提升预算、EOF 不补读，不增加方法解析器或跨调用缓存。
- 反证：113 行方法包含窗口外的错误处理，片段可以 complete，但不能报告整方法覆盖；compact/legacy 两种输出及补读正文均验证。首轮新增测试 18/20，发现 compact 输出被旧 evidence 字段覆盖，修复后上下文定向 36/36 通过。类型检查首次发现 mjs 测试导入缺声明，按仓库既有 build 测试方式使用明确文件 URL 动态导入后通过。
- 截图：标注前至多采样 32×32 个原始像素，RGB 各通道范围不超过 3 时仅标 suspect-low-variation；正常纯色/低对比画面也可能触发，其他情况仍为 unknown，均不证明视觉可用。不丢弃原图/UIA、不激活窗口或自动改用屏幕截图。8 个像素/取消/错误边界检查通过；真实隔离 WPF 的 original/annotated MCP 响应均保留质量字段与图片块。
- 手册：增加 skill:check / skill:sync，仅处理四份受管文档，默认只校验；显式同步先备份再替换并逐文件哈希核对，拒绝链接目标，保留其他文件及 MCP 配置。本机安装四份手册已更新。自审发现备份若仍叫 SKILL.md 可能被再次发现，改为 .bak 后缀；本次早期备份也已原位更名保留。最终同步专项 2/2、安装内容匹配，无重复 Skill.md 备份。
- 版本与文档：package/lock/WINCODE_VERSION 为 0.11.1；README 中英文、Skill、CHANGELOG 及路线图最新状态已同步，原路线图历史章节保留。没有新增依赖或修改全局 MCP 配置。
- 验证：typecheck、Gateway build、Host publish --no-restore 通过；默认非交互回归 234 项，233 pass、1 skip、0 fail；UI/协议 34/34 通过；生产新 stdio initialize/list/契约/目标正文/未知参数拒绝/同实例核对通过；TavernDesk 只读源码 8 场景通过。全量回归在最后 .bak 备份后缀调整前完成，该调整后仅重跑相应同步专项。日志 test-tmp/evidence-*.log，源码报告 test-tmp/r3/acceptance-1788828481850.json，均按既有规则排除。
- 运行边界：本任务现有连接 hello 仍返回 0.11.0（实例 6e7b45f6-2662-43cf-a75c-f0884b1e72d7），没有把新 stdio 的 0.11.1 验证冒称为旧连接升级；后续客户端重连后加载新构建。截图提示修复不等于所有应用的空白截图已消除，computer use 窗口归属及真实 Serena LSP 仍未验收。

## 2026-09-08（北京时间）— PR 自动回归与真实源码审查对照

- 授权：用户同意执行重新评估建议。基线 main@57d6d68 / 0.11.1，工作区干净，建立 codex/ci-real-task-baseline；范围为 CI、升级验收及小规模真实源码审查，据实测调整取证手册。无网关公共接口、运行版本或依赖升级；R7–R9 未启动。
- 当前连接验收：本任务实际 hello 返回 0.11.1、verified，实例 690efd0b-200e-4b15-bd08-a3d608a777cf，启动于 09:17:46（北京时间）；buildId=483b15166ff2f1bb1905d8d6eec2a360c9aee39b82a669be41f7831d008aaea1、revision=57d6d682b6141c72171df176fb57bc5ce5d44efe，与磁盘产物一致。本轮没有重启客户端或修改 MCP 配置。真实连接正文同时验证 bodyStatusScope、symbolCoverage 和 nextRequest，Serena 仍降级。
- CI：Windows 2025、Node.js 20/24 小矩阵、.NET 10；固定 GitHub Actions 提交，contents:read，禁用保留凭据，15 分钟超时并取消同分支旧运行。先发布原生 Host、预构建两个控制台夹具，再运行 npm test 与生产 stdio 契约。沿用现有检查且没有降低断言；交互 UI 不进入无桌面验收。分支保护未修改，远端结果以实际 PR 检查为准。
- 对照设计：四项实际 TavernDesk 源码维护问题，起始信息均为明确文件及声明名。原生路径先用 rg 获取前 8/后 79 行；MCP 路径先按旧 Skill 使用 scopeFiles+symbol、4000 估计 token 预算，缺少分支后执行有界补读。数据根任务两侧继续读复制实现；导入任务两侧增加字段赋值搜索，MCP 路径此步转用原生工具。原始结果、参数、耗时、源码哈希见 test-tmp/maintenance-source-study-20260908.json（按既有规则忽略，不上传 TavernDesk 正文）。四份文件哈希未变化，所有 MCP 正文逐行等于源码。
- 对照结果（调用数 / UTF-16 返回字符）：导入错误条件：原生 2 / 3929，MCP 起步 3 / 7797；回复取消：1 / 3979 对 2 / 7531；数据根迁移：2 / 11397 对 3 / 16135；固定测试根复用：1 / 4430 对 2 / 8121。任务取证共 6 / 23735 对 10 / 39584，MCP 起步一侧含一次原生回退；身份核对与打开/恢复工作区另计。四次初始 24 行窗口均未包含问题关键分支。该结果是同一 Agent 的非盲源码审查、固定窗口策略对照，不是独立模型实验、完整开发任务完成率、真实 Token 或总任务耗时比较；不计算通用提速百分比。
- 审查结论：ImportAsync catch 仅在会话引用未变时写状态，页面离开/书架切换到会话变更的完整生命周期仍未核实，此项保留部分验收。ExecuteAsync 中 Interrupted 和空正文分支均先于持久化；数据库复制/发布先于配置保存，路径修复是独立入口，配置保存失败后的跨文件系统事务回滚不能由本方法保证；测试根需显式 reuse、匹配非链接标记，并拒绝祖先/子项链接。均为源码结论，不冒称 GUI、真实取消或数据迁移运行通过。
- 最小修正：README 中英文与 Skill 明确区分声明预览和异常/取消/释放分支审核；后者有现成文件工具时优先有界原生读取，小文件可按预算取完整正文。保留 MCP 证据边界，没有为长方法增加解析器、工具或配置。
- 本地验证：typecheck、build、默认回归 234 项（233 pass、1 skip、0 fail，28.5 秒）、新生产 stdio 契约通过。日志 test-tmp/ci-regression.log、test-tmp/ci-stdio.log。未重复运行交互 UI；Node.js 20 和全新 Windows runner 的结果待本 PR 实际 CI。
- 已推送 [PR #21](https://github.com/linnnn89/WinCode/pull/21)。首轮 [CI 34176857681](https://github.com/linnnn89/WinCode/actions/runs/34176857681) 在两个版本暴露实际失败：Node 20 在模拟上游挂起时事件循环提前结束，207 pass、26 cancelled、1 skip；Node 24 在 workspace-summary 触发 libuv fs-event 短路径断言，231 pass、1 fail、1 skip。原生 Host 与控制台夹具构建均已通过，失败不是缺少 .NET 环境；CodeQL 通过不能替代这些回归。
- 定位与修复：withTimeout 的 unref 使孤立等待在到达期限前退出，新增真实子进程用例以退出码 13/无超时结果先复现；移除该期限定时器的 unref，保留 finally 清理，并验证已完成操作不会挂到 30 秒期限。WorkspaceWatch 将传给 fs.watch 的路径经 realpathSync.native 规范化，状态仍保留请求路径；真实 junction 写入用例核对规范路径、变化通知和关闭。两项新用例修复前失败、修复后通过。依据：[Node timers](https://nodejs.org/api/timers.html#timeoutunref)、[libuv #5010](https://github.com/libuv/libuv/issues/5010)。未修改测试数据根来隐藏短路径问题，也未放宽断言或屏蔽失败套件。
- 范围更新：CI 发现的问题直接阻碍本轮验收，按既有授权修复两个运行时局部缺口，版本增至 0.11.2；无新依赖或公共参数变化。前述 0.11.1 实际连接验收仍有效，但不能冒称该连接已加载随后新增的 0.11.2 修复。
- 补充计量：两条取证路径的跨调用重复非空源码行均为 0；本样本中的额外调用来自窗口分片和逐次元数据，不据此引入缓存。MCP 身份核对及工作区打开/恢复共 4 次另外记录。安装 Skill 在首次文档修正后同步一致，最终 0.11.2 版本待交付前再核对。
- 修复后本地验证：两个新增回归 2/2、typecheck、0.11.2 build、新生产 stdio 契约通过；默认回归 236 项（235 pass、1 skip、0 fail、0 cancelled，27.6 秒）。日志 ci-deadline-red.log / ci-watch-red.log 保留修复前反例，ci-regression-fixed.log / ci-stdio-fixed.log 保留修复后结果。最终远端验证与合并记录统一见 PR #21 对应提交的 CI/CodeQL 检查，不用本地通过推断远端成功。

## 2026-09-08（北京时间）— 下一轮整体工程化审查与计划

- 用户要求读取「WinCode迭代路线图」最后一次分析，重新审视整体软件工程设计并交付明确计划。实际读取该对话最新分析；当前本地与远端 main 均为 3be2c49 / 0.11.2，开始时工作区干净。本轮是方案编制，没有沿用旧迭代授权直接修改实现或推送。
- 远端复核：CI 34177655445 的 Node 20 在 runtime-contract.test.ts 清理 other 目录时报 EBUSY，234 pass、1 fail、1 skip，stdio 跳过；Node 24 通过，CodeQL 通过。GitHub main protected=false、required checks 为空、branch rules=[]。未修改分支规则；不把 CodeQL 或本地通过当作 CI 全绿，也没有将 EBUSY 直接归因于永久 watcher 泄漏。
- 隔离复现：直接调用当前 Serena 实现，三个目录各 210 处引用返回 202 条却 queryComplete=true/truncated=false；指定 a/Uses.cs 仍读取 a/b/c 三份源码。有效 JSON 的源码包含中英文“未激活”文字均触发错误降级。Repomix useCli=false 在受控 spawn 替身下仍请求 CLI 版本探测，并在模拟成功后进入 CLI packing；没有真正启动外部 CLI。
- 新契约反例：通过实际 SDK InMemoryTransport 调用 find_code_symbol，query 对象未报错，底层收到 "[object Object]"；当前 schema 要求 string。核对已安装 SDK 的公开 AjvJsonSchemaValidator，可直接拒绝错误类型和 schema 明确禁止的未知字段，无新增依赖。探针、结果及日志位于 test-tmp/engineering-review-20260908/，采用专用临时源码且正常清理，没有读取个人数据库或运行真实上游。
- 整体审查覆盖 Gateway/ToolRouter/Adapter 依赖、查询完成/覆盖状态、取消与资源所有权、TS/.NET 构建、CI/测试入口、运行 Host 身份、README/SECURITY 与历史记录。新增计划不是通用插件或大型框架改造；冻结已完成的 R1–R6 和当前不具备进入证据的 R7–R9。
- 交付：[WinCode-下一轮工程化迭代计划书.md](../WinCode-下一轮工程化迭代计划书.md)，并在原路线图增加入口。五个工作包依次为稳定性、工具契约、资源/取消、构建交付规范、真实集成；包含证据表、目标依赖图、修改边界、版本 PR、验收/回退和 9–15 工程日的非承诺估计。Node 支持、严格未知字段政策、分支保护及缺失上游资源均明确为待决定项。
- 本轮未运行完整回归、Windows GUI、Node 20 本机复现或真实 Serena，不宣称这些已经完成。只新增/更新三份 Markdown 与忽略目录内的分析探针；没有修改生产代码、安装依赖、改全局配置、提交或推送。

## 2026-09-08 19:08（北京时间）— WP1 / 0.11.3 稳定性与降级可信度

- 授权：用户要求根据计划逐级实施，延续每版本复测/Debug/独立审查/PR/合并。D1 已同意 Node 升级，先保留 20/24 修复证据，WP4 改 24 主支持与 22 兼容；D2 明确保持未知字段容忍模式，WP2 必须在 Skill 列明规范字段；D3 分支设置仍待决定。
- 实现：Serena 流式目录遍历、有界 UTF-8 文件读取，全局 200 引用/500 符号/5000 遍历项/8 MiB、单文件 256 KiB，限定文件提前生效；超限、截止、读错、编码和跳过链接均不报告完整，v3 缓存隔离旧结果。合法 JSON 中的中英文未激活文字不再触发协议错误。
- Repomix：禁用优先健康缓存、pack 缓存和进行中请求；冻结入口策略防异步变更污染缓存，进程启动前再次检查配置。8 项受控回归不启动真实 npx。
- Watcher：stop 等待 close 事件并有 2 秒故障上限，旧 owner 事件不污染新 owner；Router 切换和释放显式等待。所有关闭用 allSettled 收齐后保留失败。此次没有给 runtime-contract 的 fs.rm 增加重试，没有将 EBUSY 预设为永久泄漏。
- 反例与独立审查：Serena 首轮 12 例有 10 失败，原引用 202、符号 510；关闭首轮 3/3 失败。独立审查找到“旧关闭失败导致新关闭提前结束”和“false→true 配置切换污染 builtin 缓存”，均补测试先红后绿；另修 mkdir 异步边界后禁用仍启动 CLI。复审无未解决实质问题；引用 JSON 测试改为已支持的 preview 字段，没有扩展生产解析器迎合错误 fixture。
- 本地验证：Node 24.19.0，typecheck、build、默认回归 268 项（267 pass、1 skip、0 fail、0 cancelled，28.8 秒），生产 stdio 契约通过。skip 为既有可选 TavernDesk 集成项。10 次顺序及 10 次并发完整 Router 初始化/切换/停止/清理均通过，实际 native watcher close 全部确认，spawn 边界观察为 0。现有实际 Windows 子进程 PID 清理测试也通过。日志：test-tmp/wp1-regression.log、wp1-stdio.log。
- 构建身份：本地 buildId=238d4a12a6a702feb3d422a988567556b2cd33842a5c2e3181f2b3342d9a0a5e，schemaHash=751b916ea659b888da414f2f0696b853962ef38b7570c5b80a992716211af9c7（本包无 schema 修改）。这是提交前源码构建，revision 仍记录基线；最终 PR 按精确提交 CI 验证。
- GitHub 借鉴：[Node watcher](https://github.com/nodejs/node/blob/main/lib/internal/fs/watchers.js) 的真实 close 事件和 [VS Code lifecycle](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/lifecycle.ts) 的 owner/幂等/错误语义，落实到既有机制，没有新增框架或依赖。
- 边界：截止检查仍为协作式，不能中断已经提交 OS 的单次 I/O；端到端取消留 WP3。恰好达到结果上限保守标截断。未运行本轮真实 Serena/交互 GUI，不把 mock 通过视为 WP5 完成。远端 Node 20/24 与 PR/合并结果随后增订。
- 远端首轮 PR #22 / CI 34219091516：Node 20/24 各 266 pass、1 fail、1 skip、0 cancelled。唯一失败为新 scoped-file 测试将 TEMP 的 RUNNER~1 短路径与 scanner 的 runneradmin realpath 直接计算相对路径。生产读取只有目标文件，测试改成比较唯一打开路径与目标 realpath，保持零额外文件读取断言；定向 19/19 通过。两版各 10 次顺序+10 次并发生命周期均通过，原 EBUSY 未出现；CodeQL 通过。未据此跳过整套复测。失败日志 test-tmp/wp1-ci-first-failure.log。
- WP1 最终提交 202e3bd：CI 34219393246 的 Node 20.20.2 / 24.19.0 均 267 pass、1 skip、0 fail、0 cancelled，生产 stdio 与 CodeQL 通过；各版 10 顺序+10 并发生命周期关闭证据确认。2026-09-08 19:14 按精确 head 合并 PR #22，main=31b7dd1fb4d93cf13897ae68498f1fbd52e7e55e。远端日志 test-tmp/wp1-ci-passed.log；未修改分支保护。

## 2026-09-08 19:15（北京时间）— WP2 / 0.12.0 工具契约与模块边界

- 基于已合并 WP1 开始 codex/wp2-tool-contracts。用户选择容忍未知字段，要求 Skill 明确规范字段；因此统一允许额外字段但不转发生效，已声明字段仍类型/必填/范围校验，保留合法旧调用与别名。
- 范围：按工作区/代码/UI 静态分组的工具权威定义与执行；复用既有 SDK Ajv；Gateway 仅访问 ToolRouter 用例。业务查询/打包/健康类型放在小型 Core 契约，Adapter 路径兼容导出，保留原有降级与旧数组查询兼容；不引入插件框架或新依赖。
- Skill 在原有四份手册内补规范字段表、类型、约束和示例，强调 candidateFiles 优先但不排他、scopeFiles 排他、relativePath 为引用定义文件、未知字段不代表功能已生效。
- 新安全事实：用户截图中的 code scanning #1 经 GitHub API 核对，在 main=31b7dd1 仍 open/medium，规则 js/shell-command-injection-from-environment，Repomix 的 cmd 启动入口尚未修复。CodeQL job 成功不等于告警清零；已向用户明确说明。单独只读调查无 shell 启动方案，未关闭/忽略告警，未用 WP1 的禁用 CLI 修复冒称解决启用路径问题。
- 验证完成：Node 24.19.0 下 typecheck/build 通过；默认回归 278 项（277 pass、1 个既有可选 TavernDesk skip、0 fail、0 cancelled）；生产 stdio 验证 15 工具、schema/hash 同源、精准行正文、未知字段忽略与已知类型拒绝。受控真实 WPF / MCP UI 测试 34/34 通过，包含图片独立 block、串行并发、客户端取消后下一请求恢复、跨工作区与实际 helper 退出。没有操作个人应用数据库。日志 test-tmp/wp2-regression.log、wp2-stdio.log、wp2-ui.log。
- 独立审查发现契约矩阵以基准调用自身作比较可能漏掉错误路由，已改为独立列明 16 个名称的期望方法和实参；主代理复核最终矩阵、共享路径校验及既有 realpath/junction 防护，定向 19/19 通过。原测试中三个“未知字段应报错”的旧断言按用户决定改为验证忽略且不改变行为；错误类型与路径边界断言保留。早期集成的 type-only 导出错误已修复，没有将其冒称用户政策反例。
- 构建 buildId=471ba757156a69a8e89d1a7cc2d3d8f6ca4aa4739c71ea5fc90034ff09620063，schemaHash=417b9ad1deafe21006e10ffdc4d17f1d325630b3ddcee9bedf7e1fdd2e5908d3。这是提交前新进程验证，不证明当前 Codex 旧连接已更新。未运行真实 Serena；资源关闭错误保留/端到端代码取消仍属于 WP3；CodeQL #1 仍 open，未修改启动兼容策略。
- 用户补充偏好：尽量避免分出子 agents。现有协作已经收尾，后续默认主代理直接实施和复核，避免额外代理调用；独立审查与自审证据分别记录。

## 2026-09-08 — WP2 合并与 WP3 / 0.12.1

- WP2 最终 head fac36dd8a4bd2ec377ab690926c14d558e9f1688 的 Node 20/24 与 CodeQL 全部通过，PR #23 于北京时间 19:45 合并，main=39d2b20c52ba70ffc9770a5e841107b37c1c17f4。
- 用户明确选择降低健康查询开销：hello 返回被动身份/已知状态；diagnose_project 主动探测。实现 healthObservation 的 known/unknown 与 observedAt，未探测 available/commandFound 为 null，配置禁用保持已知。强制诊断不复用 Repomix/FlaUI 的短时健康缓存，Serena 检查复用现有诊断调用，避免重复。
- 代码操作使用内部 signal/deadline，覆盖符号/引用/上下文/影响/重构和打包。Serena RPC、握手接收 SDK 取消参数；本地读文件及扫描循环协作取消，打包的取消归属不共享。工作区排队/排空及提交前可取消；提交开始后完成一致性收尾。Shutdown 中止活动代码操作并保留排空失败。
- ResourceManager 保留关闭失败、最多 100 条 owner/kind/outcome 与 1024 字符错误、历史省略数；释放期间新登记资源也等清理结束。失败不跳过其他 owner，重复关闭不伪报成功。Gateway 仍尝试关闭传输，初始化失败释放已获取资源。Windows taskkill 使用独立 argv，并核对自有 PID 退出。
- Debug：实际上游取消测试先发现已完成 reset 结果误用于新连接；修正按新连接开启关闭生命周期。完整回归又暴露旧测试断言失败后漏关 watcher、共享 config 未恢复导致连带失败，改 finally 清理而不削弱断言；仅终止了已核对属于本轮的测试进程树。ImpactAnalyzer 的旧双参数断言改为同时验证完整 namePath、定义文件及 operation 转发。
- 更早握手取消测试证实 SDK 关闭过程中清空 transport.pid，进程尚存；现于 transport.start 返回 Promise 后立即记录真实 PID，在握手取消路径回收。曾试验固定 legacy 握手，单独不能解决问题，已撤回该试验、保持默认协议协商；没有改变上游协议兼容政策。定向最终 14/14 通过，包括真实 mock 上游挂起握手/RPC 的 PID 退出与重新连接；fixture 不代表真实 Serena C# 语义。
- 方法依据：[MCP cancellation](https://modelcontextprotocol.io/specification/2024-11-05/basic/utilities/cancellation)、[Node fs](https://nodejs.org/api/fs.html) 与已安装 SDK 2.0.0 的 public ConnectOptions/CallToolRequestOptions/StdioClientTransport 源码。没有新增依赖、全局配置或真实应用数据操作。
- 边界：不能中断已经提交 OS 的单次 I/O；Serena 共用连接重置可影响其他上游请求；不把进程计数归零视为退出。UI 测试 34/34 通过，stdio 通过；最终源码全套结果和 PR 检查随后增订。按用户减少子 agents 的偏好，本包由主代理实施与反证自审，未宣称完成独立模型审核。F12 shell 启动兼容变化与 D3 分支保护仍未获单独确认。
- WP3 本地最终验收：Node 24.19.0，typecheck/build 通过；默认回归 292 项（291 pass、1 个既有可选 TavernDesk skip、0 fail、0 cancelled，36.98 秒），生产 stdio 通过；UI 34/34 通过，后续修正只涉及 Serena 握手。buildId=6a79eb1cf16d42f635b69155b48520559b8e4f22690be87a42a9a74fc1fbd16a，schemaHash=feffc1d2bd2c898d3d339b14b3287da0192a52d7b29741cc577cd029f3211b3a。日志：test-tmp/wp3-final-check.log、wp3-stdio-release.log、wp3-ui.log。PID 提前登记引起旧稳定性测试的活动 PID 残留断言失败，已在真实退出后清空并注销；相关 50/50 复测通过。

## 2026-09-08 — WP3 合并与 WP4 / 0.12.2 交付规范

- WP3 head=0115642f82d0aeec806095599c03191065194ba3 的 Node 20/24 与 CodeQL 全部通过，PR #24 于北京时间 20:16:48 合并，main=227463ed13cacb3f6ea37f17bb560a4d5ac442cd。两版回归各 291 pass、1 skip、0 fail/取消。未增加子代理；自审不冒称独立审查。
- 按用户已批准的 Node 升级，WP4 改为 24 主支持、22 兼容、engines >=22。此前已先修复并验证 Node 20 故障，没有靠删除失败矩阵掩盖缺陷。Host 与三个实际构建夹具加入 NuGet lock；global.json 固定本机已有 SDK 10.0.303、rollForward=disable，遵循 Microsoft 对锁文件的建议。未升级声明的 NuGet/npm 依赖、未安装全局工具。
- 新增 check / check:desktop / test:inventory / delivery:verify。核心入口包含锁定恢复、原生/控制台构建、全部明确归类的非交互测试和新 stdio 进程；桌面入口单独运行隔离 WPF 和 UI→源码闭环。CI Node 22/24 使用同一入口并上传有界报告；不是托管 runner 桌面验收。报告记录命令、环境、构建/schema hash 和关闭前资源观察，后者不冒称进程退出证明。
- 交付清单覆盖 Gateway JS、Host 整个发布目录（含 DLL/sidecar）、四份受管 Skill、版本/SDK/锁文件配置；校验丢失/新增/修改文件与版本不一致。时间戳和绝对检出路径不参与内容身份，Git revision 单独关联。哈希只证明本地内容一致性，不是签名，也不验证另一个 Codex 连接。
- 原生 Host 用程序集 version/informationalVersion/configuration/framework 替代写死版本；生产只选 Release 发布文件，Debug/dotnet-run 仅在显式 --development/npm run dev 模式允许，customHostPath 显式覆盖保留。
- 增补 CONTRIBUTING、行尾/编辑约定，修正 SECURITY 过期支持表和固定 48 小时响应承诺。GitHub private vulnerability reporting 已只读核验开启。保留未使用 ExtensionManager 兼容入口，只修正过期注释，不扩展插件架构。
- 首轮本地核心 check 通过：301 tests，300 pass、1 既有可选 TavernDesk skip、0 fail/取消；桌面 35/35 通过，含真实 WPF 修复闭环。报告 test-tmp/check/2026-09-08T12-30-46-296Z-core/report.json、2026-09-08T12-32-57-103Z-desktop/report.json。新增交付反例 9/9 通过，覆盖 JS/源文件/Skill/SDK/Host DLL 变化、缺失 sidecar、新增 DLL、版本不一致、禁止隐式 Debug 回退。
- 文档批量写入首次因当前 Set-Content 不接受 -NoNewline 未写入三个目标，随后改用明确补丁完成并检查差异；没有把失败写入记为完成。原生编译与锁定恢复首轮成功。后续增加报告字段及文档后仍须以干净检出复核最终版本。
- 尚未完成：干净检出与重复内容身份、最终 CI/PR 合并。D3 分支保护与 F12 无 shell Repomix 兼容取舍仍待用户决定，不修改仓库权限、不关闭旧 CodeQL 告警。
- 干净检出 I:/WinCode-worktrees/wp4-clean-20260908 的首次 npm ci 成功，但回归 299 pass/1 fail/1 skip：旧 tdd-suite 将项目名写死 WinCode/WinCode MCP；实际 identifyProject 按 path.basename(root) 命名，任意其他合法检出目录都会触发假失败。改为精确断言实际目录名，未更改产品行为、未重命名目录绕过。失败报告保留在该检出的 test-tmp/check/2026-09-08T12-37-31-404Z-core/。
- 干净检出修正后完整 check 两次通过（均 300 pass、1 skip、0 fail/取消），报告 2026-09-08T12-39-02-455Z-core 与 12-39-56-230Z-core。两次 Gateway buildId=88c96147c9fc9430c5d5f39f0c27cf17d9b1a2ad5323c548c46fc817a35fe9ec；交付 contentId=5795657ffac19488b24503baf9ca2d867f5d1f24fa2a5deaa3c461783066c043，时间戳变化而内容身份相同。依赖来自该检出的 npm ci 与共享 NuGet 下载缓存，没有借用原工作区 dist/bin；这不是空机器离线构建证明。
- 从系统 Temp（非仓库 cwd）直启该干净检出的发布 Host，health 成功，真实 version=0.12.2、configuration=Release、informationalVersion=0.12.2+b6901cd960da460fa91bb2eeba81e63eac716ae4、framework=.NET 10.0.11。生产 stdio 测试也在独立临时工作目录运行。
- 反证自审：只覆盖 Host 主 EXE 会漏掉依赖 DLL 混用，清单实际枚举整个发布目录并用新增/缺失/替换反例验证；同版本旧内容仍通过哈希检测。未提供签名真实性证明，也未更新父 Codex 连接。最终 PR 的 Node 22/24、CodeQL 结果仍须在提交后核对。

## 2026-09-08 — WP4 合并与 WP5 / 0.12.3 真实应用验收

- WP4 PR #25 的精确 head=8d36bc7727fa5f85ba72ff44992927d760c0614d，Node 22/24、CodeQL 三语言分析及汇总均 success，于北京时间 20:44:51 合并，main=ba94c003a1b4ed130cbd0bd73389506f3f348481。CI 34227530379、CodeQL 34227527264，日志 test-tmp/wp4-ci-passed.log。强制 Host Rebuild 后再次验证，完整交付哈希保持相同；不仅依赖增量构建跳过。
- WP5 增加显式 test:product，复用既有 Client、stdio、EvidenceOverlap；六个固定导航 ID，输入不预先提供 XAML/C# 文件名。每项先用有界 rg 发现 XAML 与 C# 候选，再调用 ui_review、赋值精确行和方法声明窗口。按源码行与 SHA-256 核对正文；错误、耗时、实际返回字符和清理失败留在本地报告。没有新增依赖、插件层、生产缓存或源码映射推断。
- 固定 TavernDesk profile=I:/New-tarven/work/TAVERN-TEST/profile；第一次本轮启动 PID=6512、HWND=0x140B0E，回执核对测试 DB/config/logs 路径，无 Fresh、无重复导入参数。六项通过：NavDashboard、NavChat、NavCampaigns、NavCharacters、NavWorldbooks、NavSettings。每项 2 原生+3 MCP，合计 30 次（12 原生、18 MCP）、67103 UTF-16 字符；第二次最终脚本实测调用耗时合计 5145 ms，连接/打开另计 2 次、8099 字符。显示源码 127 行、重复 42 行。结果 test-tmp/product-tasks/1788871732133-22296/report.json、1788871829665-10888/report.json；单应用、单操作者、脚本固定任务，未做盲试验或纯原生等价对照，不能推算通用提速或模型 token。
- 同一实例上的 test:tavern-context 八种范围场景通过；精确行 2219 字符、allRequestedCovered=true，符号窗口 2453 字符定位方法但全方法覆盖未知，已知整文件请求 2387 字符仍未定位目标。范围正确与任务充分性分开。三次 UI→赋值→方法请求通过；没有把 snippet 非空升级为完整方法。报告 test-tmp/r3/acceptance-1788871741500.json。
- 当前 Codex 的实际 hello 确认为 0.11.2，实例 9706c136-9daf-44e8-9811-2c0f3b755f6d，启动于 2026-09-08T10:33:06.633Z，buildId=186f4bfc8f4d3cbc5ac2f7fe9f96ec98fa28c6fca1e6b862916923f523d778c7。它仍调用旧 Gateway；其新启动的磁盘 Host 实际报告 0.12.3/Release。通过当前旧连接做了一次后台原图检查，printWindowDwm，捕获质量提示 unknown；实际查看可读到 V3 固定样本角色和六个导航，没有仅凭像素变化宣称成功。此证据属于旧 Gateway+新 Host 组合，不混入新 stdio 版本通过项。没有重载客户端、修改 MCP 配置或杀死该旧连接。
- 已按用户“Skill 明确规范字段”的要求，将四份受管手册备份后同步到 C:/Users/40218/.agents/skills/wincode；随后 skill:check matched=true。备份 .wincode-backup-f76fb13c-62fb-4259-bec8-ed514885efa5。规范字段、容忍未知字段以及固定测试 profile 复用指引已进入实际安装手册；它不证明当前 MCP 已重连。
- 本机 PATH 未发现 serena/serena-mcp-server；uv tool list 为空，受限检查 uv archive 中未发现 Serena 包；当前实际 hello 也报告 commandFound=false/handshakeOk=false。真实 Serena/C# 语义集成未运行。上游官方配置说明 C# 使用 .NET 10 与自动下载的 Roslyn Language Server（https://github.com/oraios/serena/blob/main/docs/02-usage/050_configuration.md）；未因此自动下载/安装，已询问可用现有路径，保留未验证项。
- 最终本地 check 再次通过：300 pass、1 个既有可选 TavernDesk skip、0 fail/取消，报告 test-tmp/check/2026-09-08T12-53-08-086Z-core/report.json；交互桌面 35/35，包括真实隔离 WPF 缺陷→源码修复→构建→运行复查，报告 2026-09-08T12-49-49-117Z-desktop。后续改动为文档、测试脚本计数/关闭日志，未改 UI 生产实现。真实业务源码未修改。
- 自审反例：六次命令赋值落在同一构造函数，逐项 nextRequest 仍重复显示 42 行。Skill 因此提醒复用已核对且未变化的正文，必要时合并有界范围；测试继续报告原始重复量，不先删除重复结果美化指标。保留 runtimeSourceVerified=false、wholeMethodCoverage=unknown；不重开 R7–R9 或引入缓存层。
- 用户随后说明导入真实角色卡；先前自有 PID 6512 已正常 CloseMainWindow 退出。复用原 profile 重启为 PID=33672、HWND=0x330A40，后台查看当前仍显示 V3 固定样本；尚未确认用户新卡所在位置，已询问名称/是否在 [TEST] 窗口导入。没有将此重启误称真实角色卡验收通过，没有扫描个人数据库。新卡状态验收待定位后补充。
- F12 API 在 main=ba94c003a1b4ed130cbd0bd73389506f3f348481 仍 state=open；D3 分支保护也未获单独确认。真实 Serena、当前 Codex 连接重载、新角色卡定位均未完成；这些限制不以受控测试替代。遵循减少子代理偏好，本轮只有主代理自审，无新增独立审核。

### WP5 验收矩阵（2026-09-08，后续增订）

| 能力 | 环境 / 数据 | 证据类型 | 结果与范围 |
| --- | --- | --- | --- |
| 构建、契约、取消/资源 | Node 24、本机隔离夹具 | 受控进程与故障注入 | 核心 300 pass、1 skip；远端最终 head 结果待 PR |
| WPF UI→源码修复闭环 | 隔离真实 WPF 窗口 | 真实运行+合成源码 | 35/35 桌面套件，含修复后运行复查 |
| 六项导航→源码 | 固定 TavernDesk / V3 测试样本 | 真实应用+字面源码候选 | 6/6；赋值与方法声明验证，运行时绑定/完整方法未知 |
| 精准范围 | TavernDesk 当前源码、独立新 stdio | 真实源码只读核对 | 8 种场景与 UI 候选闭环通过；整文件请求不保证定位 |
| 后台截图 | 当前旧 Gateway 0.11.2 + Host 0.12.3 | 实际查看原图 | 可读；captureQuality=unknown，不冒充新 Gateway GUI 验收 |
| Serena/C# 重载→引用→正文 | 未找到可用本地命令 | 未验证 | 未安装上游/语言服务器，WP5 语义集成保持未完成 |
| 用户新导入真实角色卡 | 待确定名称及测试 profile | 未验证 | 当前画面仍为固定样本，等待定位信息 |
| 当前 Codex 重连 | 存活 0.11.2 连接 | 实际 hello | 已识别旧实例，未重载 |
- 用户已确认新角色卡在书架中；Computer Use 的 list_windows 再次把测试 HWND=3344960（0x330A40）归给 AiPPTAddin.App.exe，get_window 报“window id 3344960 no longer belongs ... current owner ...”，刷新列表后唯一一次重试同样失败。未构造伪造窗口对象或绕过驱动注入输入，已请用户在该测试窗口打开新角色卡。WinCode 按 PID/HWND 的同窗读取和截图仍正常，故这项障碍归因 Computer Use，不归因 WinCode；真实卡显示验收继续等待界面切换。
- 对最终隔离 WPF 修复测试补充反证检查：临时项目在仓库之外会脱离 global.json，因此现在明确复制已有 SDK 策略与 packages.lock.json，并采用 --locked-mode+原有离线源恢复。没有下载新依赖。test:ui-code 真实修复闭环单项复测通过，typecheck 通过，日志 test-tmp/wp5-locked-ui-code.log。
- 真实角色卡补充验收：用户指明书架中的角色后，实际截图已显示其封面及名称。仅对固定 profile/data/taverndesk.db 使用 SQLite URI mode=ro 与 PRAGMA query_only，精确不区分大小写名称匹配为 1 条；原始卡片 JSON 与导入报告 JSON 可解析，描述 2896 字符、开场白 670 字符均与原卡字段一致。头像路径按 TavernDesk AppDataPaths 规则相对 data 根解析，文件存在且位于专用数据根内；未修改数据库、未公开角色卡正文/图片/原文件路径。
- 该角色名在界面出现为两个 TextBlock，完整搜索 84 个节点后返回 ambiguous、2 matches、不展开 tree。当前连接的截图可读；另用新载入的 0.12.3 生产 Gateway/Host 经 InMemory MCP 验证相同歧义行为，结果 test-tmp/wp5-user-card.json。它不表示重复入库或查询失败，也不证明动态角色卡已有稳定唯一 AutomationId。详情页动作/聊天生成未验收，Computer Use 窗口归属错误仍存在。
- 真实角色卡存在的书架状态下，新 stdio 六导航任务再次 6/6 通过：30 次调用、67083 UTF-16 字符、5134 ms 调用时间合计，重复显示 42 行。报告 test-tmp/product-tasks/1788872623250-36420/report.json。此证据替代上表“新卡位置未知”的当前状态，保留此前历史记录；已确认入库/书架显示，未声称聊天或全部卡片语义兼容。
- 临时探针曾调用不存在的 connectTransport（失败日志 wp5-user-card-probe.log），核对既有 runtime-contract 测试后改为公开 SDK InMemoryTransport 与 Gateway 内已有 server.connect，复测通过；没有为测试添加生产连接 API。头像初检把相对路径误按 WinCode cwd 解析，随后查明 AppDataPaths 的 data 根规则并正确复核；初检 false 不属于应用文件丢失。
- 为让远端检查报告直接提供实际测试数量，check 使用 Node 内置 TAP reporter 并收集 tests/pass/fail/cancelled/skipped 摘要；不只留下“命令退出 0”。缺少完整测试摘要仍报错，不把未运行套件记为通过。
- TAP 报告补充实测：核心 check 通过，report.tests={tests:301,pass:300,fail:0,cancelled:0,skipped:1}（2026-09-08T13-05-15-874Z-core）；桌面 check 通过，report.tests={tests:35,pass:35,fail:0,cancelled:0,skipped:0}（2026-09-08T13-06-36-861Z-desktop）。更新 PR 后重新核对精确 head CI，不沿用先前 head 的成功状态。

## 2026-09-08 21:37 — 0.12.4 安全启动与剩余验收

- 用户要求尝试落实四项检查，按已说明方案推进 F12/D3；随后明确批准 Serena 隔离安装与验收，上限新增磁盘 1 GB、安装 15 分钟，不改全局 PATH。
- main 保护已通过 GitHub API 写入并回读：PR 必需、strict Node 22/24 与 CodeQL csharp/javascript-typescript/actions 五项检查，绑定 GitHub Actions app=15368；enforce_admins=true、禁止 force push/删除、要求解决讨论。单维护者 required_approving_review_count=0，不将其写作独立审核。请求/回执在 test-tmp/security-verification/main-protection-*.json；本轮未新增子代理。
- Repomix 健康与打包改为 process.execPath+独立 argv+shell:false。读取本地 package.bin，显式 customCliPath 仅接受绝对 JS 入口；不再调用 npx 缓存/PATH shell 包装器，不安装 Repomix。保留禁用无进程、降级、缓存策略隔离；随机输出名避免并发碰撞，清理超时文件和取消监听器，持续排空并限制输出。
- 初次新增测试错误使用 CacheManager 构造参数/dispose，修正为现有 API 后 15/15 通过；这些是真实 Node 子进程夹具，不是真实 Repomix 包验收。覆盖特殊字符 argv、安装 bin 发现、无效显式路径、超时与取消后 PID 退出。失败证据保留 repomix-targeted.log。
- 完整检查第一轮暴露两项旧测试依赖 npx 恰好较慢；改为真实挂起脚本，不削弱超时/清理断言。第二轮因隔离 Serena 安装扩大工作区，旧全仓影响分析触发真实 total-byte-limit 并正确返回 UNKNOWN；将该测试改为固定两文件夹具，保留有引用风险评估及置信度约束，未放宽生产扫描上限。第三轮完整 check 通过，报告/日志见 test-tmp/security-verification/full-check-3.log。
- Serena 固定 v1.7.0 commit=949a27ef1e5fda1a6e7b561e777bcece345c6ffd，复用现有 Python 3.13.7，venv/uv-cache/SERENA_HOME/语言服务位于 test-tmp/serena-real；安装完成约 632 MB，.NET 10 复用已有环境。C# Roslyn=5.5.0-2.26078.4，下载校验采用上游固定 SHA-256。握手真实成功，第一次查询发现 structuredContent.result 包裹 JSON 字符串被当成符号对象；上游 content 内实际返回三个完整身份。此新缺陷作为后续兼容修复，不把本 PR 写成 Serena 已验收。
- 当前 Codex 管理 CLI 只有 list/get/add/remove/login/logout，没有受支持的 reconnect 命令。保存配置指向正确 I:/WinCode/dist/index.js；没有用重复注册或杀进程替代重连，也未宣称旧父连接更新。
- 作者反证自审：无 shell 不等于已安装脚本可信或有沙盒；缺失显式 CLI 不应悄悄执行另一安装。CodeQL 任务成功仍需合并后读取 alert #1 的 fixed 状态；PR/远端验收待后续回执。

## 2026-09-08 21:43 — 0.12.5 真实 Serena 兼容闭环

- 0.12.4 PR #27 精确 head=b912343 的 Node 22/24 和三语言 CodeQL 均通过，2026-09-08 21:40:05 在启用保护后正常 squash 合并，main=41602e0af4a1738f2542ae513eec1dda1485df29。未使用 admin bypass。main 扫描后 alert #1 已自动 fixed，fixed_at=2026-09-08T13:41:50Z；未手动 dismiss。
- 真实 Serena 原始返回同时包含 content JSON 和 structuredContent={result:JSON字符串}。旧实现优先序列化整个 structuredContent，误判为不支持的符号结构。现在仅解开唯一 result 字符串包装，其余结构仍执行原有校验；不吞掉未知元数据，不将畸形 structuredContent 的 text 作为成功替代。
- 新增六项回归与既有身份/降级套件合计 52/52：真实包装的符号/引用、合法空数组、未激活错误、截断、非 JSON、额外 metadata。引用坐标仍明确 containing-symbol，不伪装为精确调用行。
- 新增显式 test:serena-real，不安装组件、不修改 Codex 注册。复用已批准隔离安装的 Serena 1.7.0 与 Roslyn，按生产默认连接/调用超时执行专用 C# 项目；七项通过：三个同名/重载身份、歧义不猜测、两个重载分别命中各自调用、直接上游正文与源码逐字一致、合法空符号/零引用、终止自有上游后将测试重启命令设为缺失并确认降级、真实未激活项目。保留 direct upstream body oracle 和 WinCode adapter 查询的证据边界，不宣称新增全方法正文产品接口。
- 报告 test-tmp/serena-acceptance/1788874762075-31176/report.json 与 1788874881144-38796/report.json；每次记录真实结果、PID 退出、dispose 成败，测试 C# 源码保持一致。进一步自审加强为核对引用预览中 > 标记所在行，避免“周围文本同时有另一重载”造成假阳性；最终复测回执另存本地。查询已隔离安装目录对应 python/dotnet 进程，没有残留匹配进程。Serena 环境最终约 632 MB，复用 Python 3.13.7，无全局 PATH 修改、无全局 Serena 启用。
- 首轮 0.12.5 全量回归和 stdio 通过，交付阶段因检查运行期间补充 package.json 维护命令触发源码/构建指纹不一致而失败；这是有效的一致性保护。冻结变更后完整重跑，不绕过交付校验。失败报告 2026-09-08T13-40-56-234Z-core。
- 当前 Codex 旧连接仍需客户端重连；没有提供可调用的重连接口，不用结束 Codex/强杀 Gateway 冒充成功。作者自审，未新增独立审查或子代理。

## 2026-09-08 21:56 — 当前架构、数据流与检查关口说明（北京时间）

- 根据 0.12.5/main 10496e0 源码核对启动、Gateway/Registry、Router、Context/Response、Serena/Repomix/FlaUI、原生 Host、工作区/缓存/资源生命周期和交付脚本，新增根目录 WinCode-架构与数据流说明.md，README 增加入口。
- 五张 Mermaid 图覆盖分层、请求时序、代码证据、桌面取证、构建到连接；配套数据存放表与 G1–G11 检查关口表。区分运行时校验、测试约束、远端保护、客户端授权，明确未知字段容忍、内部/外部 candidateFiles 语义、最终序列化覆盖、候选与运行时绑定、缓存与进程 RSS 等边界。
- 本轮 GitHub 只读回查 main 保护仍生效：strict Node 22/24 与三项 CodeQL，对管理员生效，approval=0；未改变远端设置。架构边界以源码为据，不用历史 README 或测试总数代替实现。
- 自审补充当前限制：Router 职责集中、错误响应尚非单一格式、不同文件路径各自校验、重构计划不执行修改、客户端需自行重连。文档为独立架构参考，不扩展生产功能。
- 验证：文档本地链接、代码围栏及五个图块检查通过；git diff --check 通过。未运行代码回归，未安装 Mermaid 渲染器，未把文本结构检查写成视觉渲染验收。

## 2026-09-08 22:12 — Markdown 当前状态同步（北京时间）

- 按用户要求核对 14 份项目 Markdown，将两份根目录计划收敛为 0.12.5 基线的未完成工作；移出已实现的 R1–R6/WP1–WP5 步骤，历史留在版本记录、工作日志和 Git 中，不另建归档计划。
- 新待办为工作区切换失败一致性、trash 部分完成恢复、有界混合负载、错误契约渐进整理。前两项是静态风险、尚待故障注入；重要恢复策略和公共接口列出待决事项，没有实施或承诺全局重构。
- 更新双语 README 导航及锁定构建入口、Skill/MCP 安装维护指南、Host 协议和截图限制、贡献指南、架构说明与 0.12.5 验收记录。修正 Host“零副作用”和截图成功保证等过度表述。
- 回查本地最终回执：main 10496e0、核心回归 313 通过/1 可选跳过、真实 Serena 七项通过、告警 #1 fixed、分支保护已启用。保留客户端重连、真实 Repomix 包验收及完整成本对照的证据缺口；未重新把旧宿主连接记作最新版本。
- SECURITY 与四份规范 Skill 已符合当前版本和容忍策略，保持正文；skill:check 实测四份安装文件一致，无需重复部署。补修历史日志中两处已删除 v0.6 方案的链接，改指 Git 中已确认存在的原提交，仅修链接、不改当时事件结论。
- 验证：14 份 Markdown 的本地链接与围栏检查、规范命令对照、旧状态扫描、git diff --check；复核既有测试报告，不将其计作本轮新回归。文档外链未做在线存活检查，Mermaid 未重新渲染；本轮没有代码、依赖、环境或远端变更。

## 2026-09-08 — 文档更新上传授权（北京时间）

- 用户要求上传至 linnnn89/WinCode；沿用既有 PR、必需检查通过后合并流程。本次仅提交当前九份 Markdown 变更，不变更软件版本或运行环境。
- 上传前确认 origin 地址正确、本地 main 与 origin/main 一致、无其他打开的 PR，git diff --check 通过。实际远端检查及合并结果以该 PR 回执为准。

## 2026-09-09 09:57 — 拉取最新版与架构建议计划对照（北京时间）

- 用户要求拉取 linnnn89/WinCode 最新仓库并根据“架构分析优化建议”总结下一步计划。确认精确根目录 D:/CODEX PROJECT/WinCode MCP、origin 地址和干净 main 后，执行 git pull --ff-only，从 580e75a 更新至 bbc20ffe99d34842bc68aac213d5fe6989327118（0.12.5）；HEAD 与 origin/main 差异计数 0/0。
- 读取引用对话的两轮完整问答，对照 Registry、CI、代码证据、项目图/影响分析、UI 源码候选、缓存 watcher 和既有 E1–E4 计划。发现多项建议已有基础实现，更新既有计划书的核对基线并增补差距表、执行顺序、验收与待决范围。
- 建议先做 E1–E3 可靠性验证，再通过 E4 渐进整理契约，之后验证有限语义关系与更深 UI 候选链；增量索引按性能证据决定。明确候选映射不等于运行时绑定、引用不等于调用图，未把历史测试数字作为本轮结果。
- 本轮仅同步仓库和整理计划；没有修改生产代码、安装依赖、运行构建/回归、控制目标应用、重连客户端或推送远端。计划实施和重要路线仍待后续授权。

## 2026-09-09 — 启动 E1/E2 故障注入，依赖同步待确认（北京时间）

- 用户要求开始进行。新增 scripts/verify-failure-recovery.ts，设计 11 个工作区切换阶段/取消用例及 2 个 trash 失败用例；禁用外部适配器，使用 test-tmp 下唯一生成目录，记录根、会话、watcher、请求准入与文件实际位置，不将缺陷行为固化为通过的回归断言。
- 实际执行 node node_modules/tsx/dist/cli.mjs scripts/verify-failure-recovery.ts，在模块导入阶段因 ERR_MODULE_NOT_FOUND: @modelcontextprotocol/client 退出；13 个用例均未执行，未复现或修复任何故障。Node 实测 v24.19.0；已有 node_modules 不满足拉取后的 0.12.5 依赖。
- 锁文件为 v3，含 46 个包条目（包括平台可选包），核心 client/server 均为 2.0.0；安装脚本标记出现在 esbuild/fsevents。建议在项目根执行 npm ci --no-audit --no-fund，同步锁定依赖；需要网络及本地 node_modules 重建，实际下载量未核实，不涉及全局安装。
- USER_DECISION_REQUIRED：用户协作契约第四节要求安装依赖事先确认，本次开始实施不明确包含依赖同步；先请求上述操作授权。生产代码未变更，故障脚本运行验证未完成；git diff --check 通过。

## 2026-09-09 10:22 — E1/E2 修复及 E3 小样本（北京时间）

- 用户授权项目内重建依赖；npm ci --no-audit --no-fund 成功安装 20 个当前平台适用包。npm 提示 esbuild postinstall 未获 allowScripts 授权，本轮未修改其脚本授权；现有平台包足以执行 tsx 和编译。package-lock.json 未变更。
- 修复前故障报告 test-tmp/failure-recovery/run-MaSxLX/report.json：13 个用例、15 条症状记录（不是 15 个独立缺陷）。用户随后明确选择：变更前失败保留旧根，变更后失败阻止业务请求、重新打开恢复；trash 部分完成保留实际位置，不自动移回，并保留旧响应字段。
- ToolRouter 记录恢复状态，覆盖根准备后的取消和各绑定阶段失败；MCP 返回 WORKSPACE_RECOVERY_REQUIRED，hello 被动可读，同根重新打开也完整初始化，恢复失败保持阻止。Workspace 返回 completed/not_moved/partial 与失败阶段，目录准备/移动失败不声称已有目标；元数据失败保留实际路径。同名文件加入 UUID 避免同时间戳目的路径碰撞，不实施自动回滚。
- 新增 tests/failure-recovery.test.ts 并纳入 npm test 清单；更新仓内代码/诊断手册、既有计划与路线图，未同步全局 Skill 或重连客户端。13 个原故障用例修复后报告零问题（test-tmp/failure-recovery/run-zRs9nX/report.json）。回归测试首次 8 项失败来自错误预期 resetConnection 只调用一次；核对 Serena.initialize 会 dispose/reset 后，修正为现有两次调用事实，未改变生产生命周期。随后 37 项针对性测试通过；增补同名碰撞测试后的故障恢复与 Skill 测试 16/16 通过，最终 typecheck 通过。
- scripts/verify-mixed-load.ts 小样本：test-tmp/mixed-load/run-cE5x6P/report.json；80 次记录的 Core 操作、10 轮、10 个真实 Node 模拟上游进程，963 ms，结束时无自有子进程残留。未发现被断言检查的跨根证据/占用泄漏；RSS 134→137 MiB、heapUsed 34→42 MiB，未观察稳定平台，不宣称无内存泄漏。真实 Serena/Repomix、Windows 句柄和子进程 RSS 未覆盖。
- npm run check 实际通过 typecheck、build-gateway，restore-host 因 SDK 10.0.303 缺失退出；报告 test-tmp/check/2026-09-09T02-18-41-301Z-core/report.json。未修改 global.json，本机已装 10.0.302。生产 stdio 实测通过（15 工具、契约及构建身份一致），不代表 Codex 当前连接或 UI Host 已更新。
- 全量 npm test 实际为 327 项、324 通过、3 失败（日志 test-tmp/recovery-regression-20260909-101859.log；此时尚未添加最后的同名碰撞用例）。两项 C# 夹具明确受 SDK 缺失阻塞；FlaUI 缓存健康测试依赖 Release Host 的路径解析，当前产物缺失，断言 available=true 失败。保留失败，不跳过或弱化测试。E1/E2 生产代码已实现，但完整交付关口尚未通过。
- USER_DECISION_REQUIRED：为完成交付检查，已询问是否可在项目内隔离安装锁定 SDK 10.0.303 并恢复 NuGet 依赖；等待答复。没有全局环境修改、版本发布、Git 提交/推送或远端变更。E4 其余契约统一及语义/UI 深化仍未实施。

## 2026-09-09 10:34 — 项目隔离 SDK 与核心交付关口完成（北京时间）

- 用户明确授权项目内隔离安装 SDK 10.0.303 并恢复锁定 NuGet 依赖。先按 [微软安装脚本文档](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-install-script) 获取官方脚本，指定版本、x64、项目 .deps/dotnet-10.0.303 和 NoPath；脚本长时间未进入可观察的下载阶段，停止该自有安装进程，未反复重试。
- 官方 releases.json 确认 ZIP 地址 https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.303/dotnet-sdk-10.0.303-win-x64.zip。使用 curl 有界下载 297570534 字节，SHA-512 与官方元数据一致：ad4ef6202e55babde1c65e1be7b468c3ecb738ccc2fb8bd3c2bb408a4f45d247c8c5a5f57fedc54ebee7cb5fc4f487772997f2d053010d2e1903b974cc64216d；解压至同一项目目录，dotnet --version 实测 10.0.303。
- 验证子进程环境：DOTNET_ROOT/DOTNET_ROOT_X64 指向项目 .deps/dotnet-10.0.303，PATH 仅在当前 PowerShell 子进程前置该目录；DOTNET_CLI_HOME、NUGET_PACKAGES、NUGET_HTTP_CACHE_PATH 分别指向项目 .deps/dotnet-cli-home、.deps/nuget-packages、.deps/nuget-http-cache。设置 CLI 遥测退出、关闭 ASP.NET 证书生成与全局工具 PATH 添加；未修改系统 SDK、持久 PATH、global.json 或包锁文件。
- 执行 node scripts/check.mjs（npm run check 的实际入口），12 个阶段全部通过：typecheck、Gateway 编译、3 项 locked restore、Host publish、2 项夹具 build、核心回归、生产 stdio、交付清单生成及校验。报告 test-tmp/check/2026-09-09T02-32-50-227Z-core/report.json；328 tests / 328 pass / 0 fail / 0 skipped，耗时约 60 秒。此前 3 项环境相关失败均消失。
- 交付清单 matched=true，contentId=d70c6fe34050340486b82b79a2c8a232e4d0f8e54818cf5e18e1b25ebe77b35e。更新既有计划与路线图，E1/E2 标记本地核心交付验收完成；E3 真实上游/更长采样、E4 其余契约及语义/UI 方向仍待后续工作。
- 本轮未修改生产代码或测试，未运行不相关的真实桌面闭环、全局 Skill 部署、客户端重连、远端 CI 或 Git 提交/推送。普通新终端仍默认使用系统 SDK；重跑检查须在其子进程中使用上述项目 SDK 环境。git diff --check 通过；核心验收不等同真实桌面、上游兼容性或长时间稳定性证明。

## 2026-09-09 10:54 — 复核问题获准修复与完整复验（北京时间）

- 用户先要求只读复核，再明确“同意修复”。隔离复核报告 test-tmp/review-d92e747f05e04a0e8ca7d17bd66db159/observations.json 证明：内部 client.close 一次失败后，3 次 workspace_open 均失败且 close 只执行一次；190 字符文件名移动后元数据失败、200 字符无法移动，旧命名均成功；底层 fs.watch 创建失败仍曾允许切换提交。复核阶段未修改生产代码。
- 获准后新增 GatewayRestartRequiredError 表达被保留、无法在原实例恢复的清理失败。Serena 内部关闭失败及 watcher 关闭失败返回 restart_gateway；ToolRouter 对永久状态直接拒绝重复 workspace_open，保留原会话与失败信息。提示用户先检查 Gateway 自有资源清理后按客户端正常流程重启；未自动重启、清除失败记录或终止目标应用。一般绑定失败仍允许重新打开恢复。
- bindWatch 及切换提交前检查实际 watcher 绑定；原生创建失败和初始化期间异步 watcher 错误均进入恢复状态。原 watcher 关闭失败与创建失败分别测试，不以替换整个 bindWatch/resetConnection 代替底层异常验证。
- trash 保留 UUID 防碰撞，展示用 basename 按完整 Unicode 码点及 UTF-8 字节预算截短，为 .meta.json 预留空间；去掉截短后尾部点/空格，完整原路径继续保存在响应与元数据。测试覆盖 183、184、190、193、194、200、220、255 字符 ASCII、中文及 emoji，逐项验证正文、元数据和源文件位置。
- 改写 verify-mixed-load.ts：在真实自有 Node 模拟上游 RPC 已开始后发起切换，用受控调度确认旧根与请求占用，再触发运行中取消或观察上游退出。5 轮取消、5 轮退出，共 70 次 Core 操作、10 个自有进程、1934 ms，全部交错断言通过且无自有进程残留。报告 test-tmp/mixed-load/run-ftSuQB/report.json；只证明受控交错，不宣称耐久性、真实 Serena/Repomix 兼容或无内存泄漏。
- 针对性恢复/watcher 测试 23/23，typecheck 通过。第一次完整检查 test-tmp/check/2026-09-09T02-52-33-897Z-core/report.json 为 333 项中 332 通过、1 失败：stage1-cleanup 的关闭时序夹具把 bindWatch 置空，不符合新增实际绑定校验。移除空 mock、使用隔离目录真实 watcher，保持原时序/拒绝/清理断言；该文件 11/11 通过，未弱化生产检查。
- 最终完整检查 test-tmp/check/2026-09-09T02-54-08-398Z-core/report.json：333/333、0 失败/0 跳过，生产 stdio、锁定构建和交付清单均通过。contentId=0b2dd10f93c67daee51a764429d7c9d30028c113b0f31d22a162f87471c91bbb，matched=true。沿用项目隔离 SDK/缓存环境，未增加依赖或修改版本锁。
- 更新仓内代码/诊断手册及现有计划、路线图，未部署全局 Skill、重连客户端、提交/推送或运行真实桌面检查。E1/E2 复核补修完成；E3 真实上游与长期趋势、E4 其余统一契约及语义/UI 深化仍属后续工作。git diff --check 通过。

## 2026-09-09 11:20 — E3 环境与真实验收、E4 盘点（北京时间）

- 用户要求继续完成待办，随后明确“补齐环境”。保留现有架构与 E3 100 次/5 分钟预算；没有启动新架构、独立 Agent 或长期压力服务。E4 涉及公共字段，先完成 10 个响应样例和兼容方案，再通过问题请求确认，当前仍待答复。
- verify-mixed-load 增加可选间隔、指定自有 PID 的 Windows Get-Process 句柄/工作集/私有字节采样及逐轮进度。实际 70 次 Core 操作、10 轮、97235 ms，报告 test-tmp/mixed-load/run-NUo0VL/report.json；采样全部可用、无缺失 PID，每轮结束句柄 234，dispose 后 233，无自有上游残留。工作集前两轮从约 119.8 降至 107.2 MiB，第 2–9 轮约 103.4→105.2 MiB；小幅增长不能判为泄漏，也不能证明长期平台。自有子进程工作集约 53.9–56.4 MiB，采样进程同步结束；不是持续高负载或峰值 RSS。
- 隔离安装：uv 复用已有工具，下载 Python 3.13.15 到 .deps/python；Serena v1.7.0 tag 与 commit 949a27ef1e5fda1a6e7b561e777bcece345c6ffd 一致，uv sync --frozen --no-dev --no-editable 安装 75 包到 .deps/serena-venv，缓存 .deps/uv-cache。Repomix 1.18.0 使用项目子目录 npm install --save-exact --ignore-scripts --no-audit --no-fund，171 包；真实压缩验证证明本次不需要执行安装脚本。两个依赖锁及版本/目录大小回执在 .deps/environment-receipt-20260909.json；主 package-lock、global.json 未改。
- 首次 Serena 直接 exe 连接后查询 15 秒超时，报告 test-tmp/serena-acceptance/1788923155570-17692/report.json。查明 SDK 子进程默认白名单不传 SERENA_HOME/DOTNET_CLI_HOME 等；上游在用户目录新建 .serena。新增 scripts/serena-isolated-launcher.py，在导入前明确设置项目路径；只改变测试启动环境，不扩大全局环境继承或生产公共接口。根据上游日志“configuration file not found, autogenerating”、全部文件的创建时间与精确两文件清单核对，将本次 .serena 归档 .deps/serena-first-attempt；确认用户目录路径不再存在。未删除或覆盖用户已有配置。
- 通过该启动器执行 project index 预热专用生成 C# 项目。Serena 使用其固定 Roslyn 5.5.0-2.26078.4 和 SHA-256 校验下载；预热成功。后续测试保留生产默认超时，没有为通过验收加大超时。新组件加缓存逻辑文件大小 751061663 字节，约 716 MiB（包括可能重复计数的硬链接，不是物理磁盘占用；不含此前 SDK/NuGet）。
- 真实 Serena 原 7 项通过后增补 Router A→B→A。初版用 Marker 查询 Marker0 时命中文件节点，改为不同文件中的同名精确类；下一版把回到 A 的合法缓存命中错误地要求产生第 3 个进程，改为同时检查重复查询及每轮新的 Probe 查询，保留跨根文件名断言并确实触发 3 次连接。最终 8/8 通过，报告 test-tmp/serena-acceptance/1788923903497-28124/report.json；自有 PID 均退出。
- 新增 verify-repomix-real。首个生成根受到父仓 test-tmp 的 Git ignore 影响导致空包，增加独立 git init 后确认两个文件确实打包；发现生产使用 /File: |<file path=/ 把摘要说明也算入文件，导致 0→1、2→3。修复为有界排空 stdout、从独立 CLI 摘要取总数；无受支持摘要时显式降级，不再使用 fileCount||1。缓存键 v4→v5 防止复用错误计数。新增 0/2/1234、正文伪标题、缺失摘要回归；Repomix 套件 19/19、typecheck 通过。
- Repomix 验收补正两处夹具：文件改动后等待实际 WorkspaceWatch 失效（单独 Adapter 没有 Router watcher），取消后等待 ChildProcess close 通知再核对退出（系统终止回执可能先于 Node close 事件）。未放宽计数、内容或清理断言。最终 10/10：Markdown/XML/plain、真实 Tree-sitter 压缩、空包、缓存、候选、取消/超时与清理；报告 test-tmp/repomix-acceptance/中文 & (real)-hCTcgs/report.json。命令 test:repomix-real/test:mixed-load/test:error-contracts 纳入 package.json，均显式 opt-in，不自动安装。
- E4 盘点报告 test-tmp/error-contracts/run-0L5l8H/report.json：10 场景通过；未知工具/代码范围/普通异常还是纯文本，UI 与执行中取消有 errorCode，关闭前拒绝使用旧 reason 形状，歧义和预算/降级为有边界证据。计划书列出映射、例子与建议：仅失败增加 structuredContent，保留旧 content 和成功字段；不从错误文字猜测类型、不把部分证据统一变成失败。USER_DECISION_REQUIRED 已提交，未擅自改公共响应。
- 核心检查 test-tmp/check/2026-09-09T03-16-01-647Z-core/report.json 337/337、0 跳过、生产 stdio 通过；随后 Skill 计数说明变更使旧交付指纹失配，属正确检查，正在冻结文档后刷新完整交付。未运行无关真实桌面、全局 Skill 部署、客户端重连、Git 提交/推送。E3 按原有有界验收完成，未授权的耐久/语义图/UI 研究不升级为本轮必做缺项。
- 最终完整交付报告 test-tmp/check/2026-09-09T03-21-13-851Z-core/report.json：12 阶段全部成功，337/337、0 失败/0 跳过，生产 stdio 与交付清单通过；buildId=3eab83432c39697dab8aa5a7e3ab5cfc7ccf690c7467cb110b22e39736c4803e。按专用命令/路径筛查 Python/Node/Roslyn 未发现本次上游残留，用户 .serena 路径保持不存在。git diff --check 通过。反证自审：正文伪标题不能影响计数；回到旧根复用其自身缓存合法，另以新查询验证实际重连，不能单凭进程数认定污染。仍是作者自审，未宣称独立审核；E4 公共字段确认仍待用户决定。

## 2026-09-09 — 直接 Roslyn 集成设计与 E4 利弊说明（北京时间）

- 用户确认开始设计绕过 Serena 的直接 Roslyn 集成，并要求详细解释此前 E4 兼容方向。本轮只读核对生产调用链后更新既有计划书；没有新增生产依赖、实现 Host、切换提供方或清理已安装上游。当前主分支/未提交实现保持原状。
- 发现已有 CodeQueries 接口可复用，但 source、namePath/重载序号、ImpactAnalyzer 来源判断和健康/生命周期仍耦合 Serena。建议同一产品内自有 WinCode.Code.Host + Roslyn 库，Gateway 通过内部 stdio 调用；不添加另一款用户注册的 MCP。对比复用现有一次请求 UIA Host、独立自有语义 Host、Node/.NET 桥接，提出生命周期隔离的具体理由和构建交付成本。
- 设计首版 C# SDK 项目、显式单配置/TFM、声明/引用/消歧和有边界的影响证据。记录目标 SDK/依赖前置条件、设计时 MSBuild 求值的信任边界、源生成器/根外文件限制、快照身份与失效、取消/切换清理、无 Serena 环境验收、公共 source/ID 迁移。新增依赖精确版本与资源大小在原型阶段验证，未用语言服务器版本冒充 Roslyn 库版本，未把设计稿写成已完成能力。
- 官方核对：Roslyn SymbolFinder 接受符号、Solution 和取消信号；微软项目系统说明设计时构建运行附加 targets 并按 TFM/配置分别取值；MSBuild Locator 的 .NET 与 .NET Framework 发现范围不同。相关链接放在计划书对应段落。未调用实际用户项目的设计时构建，也未运行目标应用。
- E4 对比三种文本/结构化迁移策略。纠正此前“附加字段即可完全兼容”的潜在过度承诺：MCP 建议同时保留结构化 JSON 文本镜像，客户端只读 content 时看不到新增侧字段，严格字段/数组长度校验也可能受影响；字段多一份还需维护一致性与实际模型可见性。建议首批省略含义容易混淆的统一 retryable=false，取消采用检查状态优先；未知工具协议行为暂不混改，成功/歧义/预算结果保持现有语义。
- 反证自审：即使 Roslyn API 查询返回零引用，缺少项目/生成文档或动态调用仍不能推断无影响；即使 SDK 接受 structuredContent，也不能推断当前 Codex 模型能读取它。本轮未跑代码测试；只做 Markdown 结构、链接和 git diff 检查，不把此前 337 项通过算成本轮重新执行。Roslyn 的具体加载/迁移策略及修订 E4 字段仍是待决事项，不重复询问已明确的直接集成总方向。
- 文档检查：两份计划的本地链接/代码围栏通过，git diff --check 通过。历史工作日志有 3 个指向本地未携带 test-tmp 回执的链接（1788793544719-3736、1788794274918-25708、tavern-host-acceptance-20260908），已在 HEAD 历史内容中确认存在；没有伪造补回执或改写历史证据。新增设计段落未引入失效本地链接。

## 2026-09-09 — 社区实践与第一性原理复核（北京时间）

- 用户要求复核直接 Roslyn 与 E4 建议并参考优秀网友经验。本轮以当前工作树、微软文档、csharp-ls、RoslynMcp 作者实测/设计记录、MCP SDK 问题及修复为依据；链接与适用边界增订在既有计划书末尾。社区经验不当作共识，未借用其他项目的性能数字承诺 WinCode 收益。
- 保留自有 Code Host 直接调用 Roslyn 库的方向；收缩首个验证为隔离两项目、单配置的加载/消歧/跨项目引用闭环，先证明主要不确定性，再定公共身份参数和接入。借鉴语义精度与文本广度互补的经验，不要求全部简单查询加载完整工作区，不照搬仍在设计中的多客户端守护服务。
- 当前代码复核发现 WorkspaceWatch 忽略 obj/bin，默认 150 ms 防抖后才通知；与前案要求 assets 变更重载不一致。新增文件的引用会使“只校验返回文件”遗漏反证。记录了立即标记待更新、按加载输入失效和新增/删除文件集合的验收要求；这是未实现设计的缺口，不报告为已复现的 Roslyn 生产故障。
- E4 将“保留旧文本 + structuredContent”从默认建议改为有实际旧消费者需求时的过渡。推荐终态是单一错误对象生成 JSON 文本及可选结构化副本；优先稳定错误码、可读原因和已知恢复动作，保留部分完成/实际位置。仓内未见已知工具依赖旧错误前缀的消费分支，但未知工具有文本断言，外部客户端需求仍未知，未擅自迁移契约。
- 已运行项目现有 client/server 2.0.0 的隔离 InMemoryTransport 探针：正常成功通过，缺少或不匹配成功 structuredContent 被拒，isError=true 的两种错误均原样到达，JSON 文本与结构化对象相等；5/5 通过。[脚本](../test-tmp/review-20260909/e4-sdk-output-schema.mjs)及[回执](../test-tmp/review-20260909/e4-sdk-output-schema-report.json)。因此撤回“必须先有全工具成功/失败联合 schema”的过强推断，保留“失败专用 schema 不能代表成功输出”的判断。只覆盖项目所用低层 Server/Client，不代表高层服务器或 Codex 展示已验收。
- 反证自审：不可变 Solution 不等于实时磁盘快照；准确返回一个方法也不等于完整理解任务；收到错误码不等于可安全原样重试。现有 E1/E2 决策继续保留。此为作者复核及公开来源对照，不冒充独立模型审查。
- 本轮只更新既有计划/路线图/工作日志，生成本地隔离探针和回执；未改生产实现、安装依赖、执行真实项目设计时构建、推送或重连。旧回归 337/337 未重跑，不算本轮验证；具体项目执行政策、公共身份/source、E4 文本兼容仍为 USER_DECISION_REQUIRED。
- 文档验证：3 份 Markdown 代码围栏平衡；新增复核段及路线图共 9 个本地链接均存在，git diff --check 通过。没有重新校验或补造历史工作日志中之前记录的缺失回执。

## 2026-09-09 12:18 — 直接 Roslyn Host 第一阶段实现（北京时间）

- 用户同意按复核方向开始；本阶段只实现已提出的两项目、单配置原型。新增 tools/WinCode.Code.Host/Program.cs、csproj、NuGet 锁，以及 scripts/verify-roslyn-host.mjs 和 npm run test:roslyn-host。现有未提交改动保留，Gateway 默认提供方及 E4 未改。
- 直接使用 Roslyn 5.9.0 与 Locator 1.11.2，加载真实 MSBuild 项目模型；根据项目/文档/UTF-16 位置得到符号，验证重载和跨项目引用，复用固定 Solution。实现输入帧限制、路径约束、请求超时、输出截断、关闭/EOF、加载诊断和不完整标记。显式项目求值许可在初始化前校验；本次只执行生成夹具的设计时求值。
- 构建首次因 Locator 的 MSBL001 失败：传递的 Microsoft.Build.Framework 17.11.48 被复制到运行目录。按其规则增加显式编译引用 ExcludeAssets=runtime/PrivateAssets=all 后通过；没有禁用检查。验收脚本最初误用 build --locked-mode，修正为 RestoreLockedMode=true；首个语义测试误将空 bin 目录等同于编译产物，实际目录无文件，改为验证 App/Lib 的输出文件为空。失败回执仍保留于 test-tmp/roslyn-host/fixture-fhTskw 和 fixture-1FKEin。
- 更新过时 WorkspaceFailed 订阅为 RegisterWorkspaceFailedHandler；诊断集合使用 ConcurrentQueue，避免事件线程与输出枚举竞态。编译前排除 AnalyzerReference，并明确报告排除数；没有将缺少生成源码的结果标为完整。用户要求函数/接口注释后，补齐中文 XML/JSDoc 和内部协议契约，包括坐标、错误、生命周期与执行边界；此要求持续适用于后续代码。
- 最终[验收回执](../test-tmp/roslyn-host/fixture-4E9UyF/report.json) 18 场景通过，构建 0 警告/0 错误；冷就绪 2832.6 ms，有效首查 382 ms，热查落在整数计时 0 ms 档，工作集 125616128 字节。热查的 0 不代表零耗时，冷启动包含测试驱动开销，这些单夹具数字不是跨项目基准。锁定包 22 个，包元数据声明均为 MIT；Host 构建输出 112 文件/26859048 字节，不是最终发布体积或新增存储占用。
- 进程清理反证：早期描述将 BuildHost 一并称为已验证，进一步检查回执发现采样只捕获 Host 与 conhost；已修正场景名称并记录 buildHostObserved=false，仅对观测到的 PID/创建时间作退出断言，未把短寿命未采样进程算作通过。完整辅助进程及 Gateway 硬取消回收仍待接入阶段验证。
- 反证自审：MSBuild 设计时求值可以创建空目录；路径过滤不能约束自定义 targets 的执行；唯一符号/合法零引用不代表全项目完整，当前排除 12 个 SDK 分析器/生成器引用并标记 diskFreshnessVerified=false。固定快照原型不处理新增文件或 obj/assets 失效；没有宣称完整替代 Serena。未执行核心 TypeScript 全回归或真实客户端重连，也未安装全局依赖、提交或推送。

## 2026-09-09 12:23 — 同步 Skill 接口手册（北京时间）

- 用户要求同步新版接口的 Skill 建议，避免旧手册误导调用。按 skill-creator 检查并更新既有 SKILL.md、references/code.md、references/diagnostics.md；不新增手册分支或修改工具实现，UI 手册保持当前内容。
- 区分接口基线 0.12.5 与本地手册修订日期；明确 Gateway 仍使用 Serena 路径、Code Host 为实验性独立协议。补充原型启动许可、请求字段、UTF-16 单位、预算、固定快照及生成代码限制，禁止将原型字段误传到 MCP；维护验收入口不作为日常工具不可用时的绕行方式。
- 明确 E4 尚未统一结构，读取真实 isError/content/可选领域字段，不要求所有错误存在 structuredContent。保留 E1 工作区恢复与 E2 部分完成政策。移除历史机器 I:/WinCode 作为当前安装路径的断言，改为从实际客户端配置取得路径；补充接口变更、手册同步、实际 Schema 和实例身份的维护顺序。
- 检查当前用户 .codex/skills/wincode、.agents/skills/wincode 及历史 C:/Users/40218/.agents/skills/wincode 均不存在；未猜测目标或创建新安装。此次更新的是仓库四份受管文件中的三份，未声称客户端已加载或 MCP 已重连。
- 验证：既有 skill-sync 与 tool-contracts 测试 11/11 通过；quick_validate 首次遇 Windows 默认 GBK 解码错误，改用同一 Python 的 -X utf8 后通过，未改变系统编码配置。手册引用、代码围栏与 git diff --check 通过。反证自审：文档复制成功仍可能连接旧 Gateway，已保留实际 Schema/运行身份核对；未用本地测试替代当前客户端兼容验收。

## 2026-09-09 — README 中英双语 MCP 配置说明（北京时间）

- 按用户要求补充使用时选择项目与启动时指定项目两种 JSON/图形界面配置，统一使用通用占位路径，不写入用户真实路径。
- 明确省略整个 --workspace 参数对、默认进程目录及查询前 workspace_open 的要求；说明单实例单活动工作区与多项目并发边界。保留其他未提交修改。
- 验证：对照当前启动参数解析及 SessionManager；4 个 JSON 配置可解析，中英示例一致，参数数量、代码围栏、README 个人路径筛查和 git diff --check 通过。反证自审：未指定项目并不代表自动跟随聊天项目，已明确提示。仅修改文档，未运行服务连接或代码回归测试。

## 2026-09-09 13:01 — Roslyn Host 变化失效、重载与请求生命周期（北京时间）

- 用户同意开始后，继续已确认的直接 Roslyn 方向，本次完成 Host 内部一致性阶段。保留全部已有未提交修改；新增 WorkspaceInputs.cs、WorkspaceSession.cs，重构 Program.cs 为输入控制和串行操作队列，扩展既有验收脚本，不引入新依赖或改动 Gateway 提供方。
- 对工作区文件集合、源码、obj/assets、项目及常规祖先配置、实际加载的文档/元数据做有界内容校验。查询前后复核，变化或读取失败不返回旧引用；编译前固定文档文本。单次上限 20000 条目/5000 文件/128 MiB、单文件 32 MiB，重解析路径拒绝。监听事件不防抖；不能推导任意外部 targets 输入或全磁盘原子保证。
- 内部 JSON 行协议 v2 增加 reload/cancel。重载从开始起失效，失败不恢复旧快照；global.json/监听/清理故障要求新进程。最多等待 8 项、重复活动 id 拒绝、预算包含排队、关闭取消并排空后释放。排队超时的 reload 在触碰状态前停止；已开始的重载失败留在失效状态。中文 XML/JSDoc 说明函数、字段单位、资源所有权和恢复边界。
- 失败及修复：fixture-zJcQj0 的加载检查把 MSBuild 自身 obj 写入当作不稳定，改为加载阶段比较内容并单独监测配置代次；查询阶段仍检查读取窗口内事件。fixture-B9sBfo 在重命名后继续读取旧文档路径，改为旧查询失效、reload 去掉消失的旧额外输入并重新发现项目集合。fixture-ijEjh2 发现 OpenProjectAsync 对损坏 XML 可返回部分项目，改为读取结构化 workspace.Diagnostics，按 Failure 拒绝 ready；不按语言文本猜错，也不把源码编译错误等同于项目加载失败。失败回执保留。
- 最终 `npm run test:roslyn-host` [回执](../test-tmp/roslyn-host/fixture-09LFFy/report.json) 为 42 场景通过，锁定构建 0 警告/0 错误。新测试验证立即编辑、新增/重命名/删除、assets、真实条件编译、Compile 项移除、损坏后修复、主动取消、排队超时/重复 id/背压、活动请求 EOF，以及 SDK 变化要求重启；19 帧突发全部得到结果。此前的 35/40 项是中间测试，不与最终数量相加。
- 本次冷就绪 4057.0 ms，首个有效引用 484 ms、热查 136 ms、工作集 184123392 字节，初始校验 195 文件/6163683 字节；构建 112 文件/26891268 字节。内容校验增加查询成本，单夹具样本不证明通用性能提升或长期资源稳定。退出采样仅观测 Host/conhost，buildHostObserved=false，不声称完整 BuildHost 回收已验证。
- 按 skill-creator 同步 SKILL.md、references/code.md、references/diagnostics.md；普通 MCP 参数与实验操作明确分开。现有 skill-sync/tool-contracts 11/11、UTF-8 Skill 验证、JS 语法及 git diff --check 通过。受查的本机 .codex/.agents 与历史安装目标均不存在，未创建全局 Skill、改客户端配置或声称已重连。
- 反证自审：仅返回文件哈希会漏掉新文件新增调用，因此本次纳入文件集合并以真实新增调用验证；仅检查取消结果无法证明超时包含排队，因此用已过期的排队 reload 加后续旧身份成功查询验证没有提前破坏工作区。queryComplete/diskFreshnessVerified 仍为 false，生成器与任意外部输入覆盖未补齐。监听溢出、Dispose 故障注入、生产进程树硬回收及 A→B→A 接入未验证；这是作者自审，不是独立审核。
- 更新既有计划/路线图，后续为公共身份/source 与 Gateway 接入、E4、最终交付及无 Serena 环境验收。本次未重跑核心 337 项或刷新生产交付清单，不将独立 Host 测试当成生产链路已替换。没有提交、推送或安装全局依赖。

## 2026-09-09 13:46 — Roslyn 接入现有 MCP 与自有进程生命周期验收（北京时间）

- 用户同意开始后，实施此前建议的公共定位、Adapter/Gateway 接入与端到端验收阶段。新增 RoslynAdapter、RoslynHostClient、OwnedProcessJob、真实 MCP 验收脚本及 7 项契约回归，复用现有 CodeQueries、请求锁、ResourceManager 和 E1 恢复策略。保留已有 README、E1/E2 等未提交修改；无新依赖、全局配置变更、用户项目求值、提交或推送。
- 启动新增 `--roslyn-config <绝对 JSON 路径>`，有界读取用户显式指定的配置；需 enabled/项目求值许可、根内入口 csproj、明确 Configuration/TFM、已有 dotnet/Host 路径。只在配置启用时选 Roslyn，hello 不求值；不自动采用仓内配置，也不通过普通工具参数选择可执行程序。Host 子进程单独设置匹配的 DOTNET_ROOT/DOTNET_HOST_PATH，不改全局环境；Roslyn 路径不初始化/查询外部 Serena，显式文件范围的文本能力仍复用本地解析。
- 保持 15 个 MCP 工具名。符号搜索返回 source=roslyn、location；引用工具新增可选 symbolLocation={snapshotId,project,file,position}，原 symbolName 保留并核对匹配。重载/同名返回候选，旧 Serena 序号身份明确拒绝。Host v2 新增 symbols，按实际语义符号去重 partial；指定文件范围时选择该文件中的声明，避免跳到范围外的另一半声明。两类查询提供 semanticContext 的范围、检查点与排除数；准确调用 span 不等于全仓完整性，影响报告保留 UNCERTAIN/UNKNOWN。
- 生命周期：编辑后旧身份失败，下一次显式搜索才重载，失败业务请求不自动重放；工作区同根重开/A→B→A 关闭旧 Host。传输有界帧、ID/信封校验、取消监听清理与 1 秒协作宽限，超时/初始加载未响应可硬回收。真实关闭/协议错误在进程退出后仍保留清理失败，进入 E1 restart_gateway 阻止后续业务；纯关闭超时在确认硬回收成功后可完成释放。初次项目加载失败按预期失败启动清理，不能把退出码 1 错判成永久恢复失败；损坏项目修复后可显式搜索恢复。
- Windows Host 在初始化 MSBuild 前加入自有匿名、不继承句柄的 Job，KILL_ON_JOB_CLOSE 在 Host 退出/崩溃时回收继承的后代；句柄保持到进程结束，避免在关闭确认前误杀自身。依据微软 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 与 [JOBOBJECT_EXTENDED_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)，未增加 P/Invoke 包或第三方服务。此为自有资源机制，不能约束自定义 targets 通过外部服务创建的进程，也不是项目执行沙盒。
- 失败与修正：首批 62 项定向回归有 1 项失败，ImpactAnalyzer 把额外 undefined 传给旧 Serena 三参数调用；改为仅有 Roslyn 定位时使用第四参数，原断言保持，相关 40/40 后通过。MCP 首两轮 [run-3dIsQZ](../test-tmp/roslyn-gateway/run-3dIsQZ/report.json)、[run-yb8YjT](../test-tmp/roslyn-gateway/run-yb8YjT/report.json) 误把 Gateway 自己的 conhost 计入切换时必须退出的 Host 树；核对父进程后，改为切换检查 Code Host 子树、最终退出检查整个 Gateway 树，仍逐一核对 PID/创建时间。之后 12 场景中间回执通过，最终增加加载失败修复场景至 13；不把中间数量相加。
- 最终 `npm run test:roslyn-gateway` [回执](../test-tmp/roslyn-gateway/run-nP7SpF/report.json) 13 场景全部通过。使用生产 dist/index.js 与新的 SDK stdio 客户端，生成 A/B 两套项目夹具，覆盖精确重载、partial 文件范围、TS 显式上下文、错误位置/旧身份、编辑、A→B→A、初始加载损坏与修复、真实 MSBuild 中取消/崩溃/超时和关闭。后三项各观测 7 个实际自有进程（Host、BuildHost、受控 target 的 cmd/node 及控制台），均确认退出，恢复搜索成功；无 Serena/Python 启动。受控 target 只运行夹具自有等待脚本，不执行目标应用。
- 最终 `npm run check` [回执](../test-tmp/check/2026-09-09T05-41-07-067Z-core/report.json) 12 阶段成功，344/344、0 失败/取消/跳过；锁定恢复、UIA Host 构建、生产 stdio、15 工具 schema 与现有交付清单验证通过。buildId=1c62d2c8e4b10ff345eba1721745a81998368ef3413eef399b000b9fbdac1aa6，delivery contentId=7bafc6bc5d8eb872618bc4cc2b25352491a5a43c1c0d6fe22d0304429e8084ee。现有清单仍是 Gateway/UIA Host/受管 Skill，不把其成功冒充 Code Host 正式交付。构建使用项目内 SDK 10.0.303 与缓存，仅当前命令环境生效。
- 本轮早期独立 Host [42 场景回执](../test-tmp/roslyn-host/fixture-whR9f2/report.json) 通过；其后的 scoped partial 与接入修订由上述最终 MCP 场景和核心回归验证，未声称旧 42 项在最终状态重跑。代码/接口新增中文说明，按 skill-creator 同步 SKILL.md、references/code.md、references/diagnostics.md；Skill/工具/Roslyn 定向测试 18/18 与 Python UTF-8 quick_validate 通过。未找到既有受查 Skill 安装目标，没有新建全局安装或声称当前 Codex 已加载新版。
- 反证自审：引用位置准确但加载图缺少反向依赖/生成器时仍不能判安全删除；因此 semanticContext 与 queryComplete=false 保留，ImpactAnalyzer 只提供已证实的有界证据。Host 崩溃时只确认父进程退出不足以证明释放，因此测试在真实 MSBuild target 阻塞期间采样 BuildHost 和后代再验证退出。初始加载失败也不能误触发永久清理失败，最终 MCP 增加损坏/修复实证。以上是作者自审，未进行独立模型/人工审核。
- 更新既有计划、路线图和本日志。下一阶段为 E4 公共错误迁移、Code Host/Roslyn/BuildHost 正式打包与指纹、无 Serena/Python 干净环境及实际客户端验收，再推进默认后端迁移。当前 SDK 风格单入口/配置/TFM、ProjectReference 可达图和生成夹具证据，不涵盖任意 `.sln`、外部自定义输入/服务创建进程、非 Windows 或真实用户项目。E4 文本兼容及真实项目求值政策仍需在对应范围确认；本轮已有接入授权无需重复申请。
- 收尾核对生产 ToolDefinition 中的实际工具名，并修正计划新增段的简称；3 份计划/日志的代码围栏、18 个本地链接检查通过，`git diff --check` 通过。仅补记非受管文档后再次 `npm run delivery:verify`，上述 contentId 仍 matched=true；没有因文档记录重复执行全套构建或扩展测试范围。

## 2026-09-09 — 当前工作版本提交与推送准备（北京时间）

- 用户明确要求将当前版本推送 GitHub；纳入当前 README、稳定性/恢复机制、Roslyn Host/Gateway 接入、验证脚本与既有文档改动，不升级版本号。目标 origin/main。
- 推送前 npm run typecheck 通过，git diff --check 通过；43 个待提交文件的常见凭据标记及大文件筛查未发现命中，构建产物和测试临时目录由现有忽略规则排除。
- npm test 执行失败：日志报告当前可发现的 .NET SDK 为 10.0.302，缺少 global.json 锁定的 10.0.303，ui-query-check 无法启动。未安装 SDK、放宽版本锁或将历史通过结果作为本轮验证。日志位于本地 test-tmp/pre-push-tests.log。本次推送保存当前工作版本，不表示完整回归或发布验收通过。

## 2026-09-09 — Pro 最新分析对照复核与下一轮规划（北京时间）

- 目标：结合用户提供的网页版 Pro 全文、当前实现和 GitHub 一手经验，复核架构与下一轮优先级。会话读取工具不可用后由用户补充附件全文，现已完成对照；没有把预览截断处当成完整结论。本轮只修改既有计划/路线图/本日志，并在 test-tmp 创建隔离探针与回执，没有修复生产代码或替用户批准公共接口/输入政策变化。
- 基线：[PR #30](https://github.com/linnnn89/WinCode/pull/30) 已于 13:56:43 合并，远端 main 为 `2235a4200c117a1c1389afce1fecd90c45908a73`。本轮开始时本地 bbc20ff 加工作区修改，收尾复查已为 `codex/current-version-20260909@a2d76f6` 且本轮编辑前干净；保留上节提交准备记录。本轮未运行提交/推送/分支切换。两次核对 13 个关键生产/构建文件 Git blob，均与远端基线一致；[比对回执](../test-tmp/review-20260909/pro-baseline-comparison.json)保留初始 HEAD 与各文件哈希，不声称整个工作区完全相同。
- Pro 路径问题已用实际 ImpactAnalyzer 加受控提供方复现：[探针](../test-tmp/review-20260909/impact-identity-audit.mjs)、[回执](../test-tmp/review-20260909/impact-identity-report.json)。四个外部引用文件全部出现在 affectedFiles，但同名 Service.cs 和后缀 NewService.cs 被组件摘要遗漏，两个 Handler.cs 合为一个；不同启动目录下工作区内绝对目标无法解析。此证据验证实际聚合逻辑，不冒充真实 Roslyn 提供方验收。
- [真实 Roslyn/MCP 探针](../test-tmp/review-20260909/roslyn-post-integration-audit.mjs)及[回执](../test-tmp/review-20260909/roslyn-audit-ebBSx0/report.json)仅使用现有构建、项目内 SDK 10.0.303 和生成项目；夹具 NuGet 源清空，未新增持久依赖或执行用户真实项目。正常 Save 引用有一处、source=roslyn，但重构建议误称文本降级和查询中断；新增无关 README 使旧定位 SNAPSHOT_STALE，生成无关 33 MiB 文件使查询 INPUT_BUDGET_EXCEEDED，该文件已移除。
- 新增正确性发现：显式 CodePage=1252 的 Café 类在 dotnet build 中 0 警告/错误，Host 搜 Café 得到零结果和非法字符诊断，搜 Caf 却返回错误类名。源码核对指向 WorkspaceSession 冻结文档时强制 UTF-8，故提升为优先修复；不把这种精确位置结果视为正确符号的充分证据。
- 反证结果：原先怀疑 Gateway 非正常退出可能留下 Code Host/BuildHost。受控 MSBuild 阻塞期间，Gateway 强制退出和客户端关闭两场景各观测 9 个相关进程，3 秒后均无残留，无额外清理动作才通过的情况。此次没有复现孤儿进程问题，不能据上游故障帖子宣称 WinCode 存在该缺陷。源代码显示上游互斥等待未受 Host 队列上限覆盖，但尚未负载验证，只登记为有界探针候选。
- 实际 Codex 连接于 14:39 被动 hello：[回执](../test-tmp/review-20260909/current-client-1439.json)。版本 0.12.5，instanceId=`26920008-5f2c-40d5-85c9-ef63a3e41e6d`，buildId=`1c62d2c8e4b10ff345eba1721745a81998368ef3413eef399b000b9fbdac1aa6`，schemaHash=`d685329e95f1cc93087ea3f62ff96d1647e93dc0c4ad9f683d476ce79b8f3bdc`，15 工具；当前 codeProvider=serena、mode=degraded、semanticQueryUsable=false，Roslyn 未启用。更新旧客户端 0.11.2 待办，区分身份已验证与 Roslyn 功能未验收，未修改用户客户端配置。
- 架构意见：保留现有 Registry/Router/CodeQueries/Adapter/独立 Code Host，不新建能力注册平台、全局图或数据库。清理对象限定为旧 Serena 专用判断/中性依赖命名、纯文本解析耦合、无用注入。ArchitectureAnalyzer 的 `_queries` 尚未使用，不能把静态项目声明图称为已经实现的 Roslyn 语义架构图；不同用途的 watcher 暂不合并。
- GitHub 参考：[Serena #1718 维护者限缩故障范围](https://github.com/oraios/serena/issues/1718#issuecomment-5033051492)与[同步归属讨论](https://github.com/oraios/serena/issues/1718#issuecomment-5032705578)、[csharp-ls #401](https://github.com/razzmatazz/csharp-language-server/issues/401)、[VuDZ/RoslynMcpServer](https://github.com/VuDZ/RoslynMcpServer)、[MadQ 作者实测](https://github.com/MadQ/RoslynMcp/blob/dev/docs/battle-test-results.md)。仅采纳具体职责和验证方法；不照搬 AddDocument、单一版本失效或他人的性能数字，也不把模型诊断/源码对应关系当成构建或运行时因果证据。
- 计划更新：A1 先修路径与来源/覆盖说明；A2 修编码及无关大文件阻断，明确输入集合并保留真实依赖失效；B 把真实脚本接入 CI、统一 SDK 选择、补 Code Host/BuildHost 清单及实际客户端验收；C 贯通可选 symbolLocation，并同步中文注释、Skill 和契约。E4 独立待决；全面性能优化与 WPF 精确导航在这些步骤后按实测需要进入。
- 验证边界：本轮运行上述隔离诊断并完成清理，没有重跑整套 npm check。344/344 和 MCP 13 场景仍是前一接入阶段回执；另一个提交准备流程的默认 npm test SDK 发现失败已核对原日志，纳入 B，不删历史失败、不放宽 global.json、不宣称本轮默认环境通过。Pro 与本轮为不同证据来源，本轮反证自审仍不等于独立模型/人工审核。
- **USER_DECISION_REQUIRED：** 本次为复核与规划，新的修复尚未实施。A2 输入覆盖政策、C 公共参数扩展、E4 文本策略、B 的可选交付形态及实际项目求值范围须在对应实施前明确；已批准直接 Roslyn 方向及项目内依赖权限不重复申请。下一步推荐从 A1/A2 开始，不为完成规划额外申请安装、客户端控制或发布权限。
- 文档收尾：三份文件的代码围栏、新增的 10 个本地链接和 git diff --check 通过，13 个关键实现/构建文件哈希仍与复核基线一致，受管改动仅这三份文档。范围检查首次因 Git 默认将中文路径转义而误报；改用 NUL 分隔的原始路径输出后通过，未放宽范围断言。测试探针/回执仍在既有忽略目录 test-tmp，不列入发布包。

## 2026-09-09 — A1/A2 正确性与可补充输入实施（北京时间）

- 授权与基线：用户要求开始，随后选择“编译相关输入之外允许显式补充文件”。只读 fetch 更新 origin/main 到 2235a42，确认其树与本地原 a2d76f6 一致后建立 codex/roslyn-correctness，保留三份已有计划修改。没有提交、推送、全局安装、客户端配置修改或真实用户项目求值。
- A1：ImpactAnalyzer 改用工作区完整文件身份、可用项目身份作聚合键，名称只展示；修正绝对路径、分隔符/大小写、同名/后缀文件及链接源码组件计数。RefactorAssistant 不把正常 Roslyn 有限结果称为文本回退或中断；未解析的 Roslyn 结果不再附加正则回退说明。Roslyn 已知加载/查询/清理失败按现有 AdapterLastError 汇总，清理失败保留不可恢复标记，不主动探测上游。
- 编码：WorkspaceSession 的冻结文本使用 document.GetTextAsync 所提供的 Encoding，遵循 MSBuild CodePage/BOM；四种生成夹具验证 Café 符号、引用和 UTF-16 偏移，未改写用户源码或引入编码依赖。新增函数/接口与关键身份、缓存语义补充中文注释，Program 的“尚未接入 Gateway”过时说明已修正。
- A2：WorkspaceInputs 采用约定输入候选 + 实际文档/AdditionalFiles/分析配置/程序集 + 祖先配置 + 显式 additionalInputs。非标准 Import 和隐式数据须显式补充，未声称自动识别所有依赖。自动发现 .cs 后仍由 MSBuild Compile 决定加载；未加载的普通二进制和 README 不计输入字节。目录枚举和输入预算保留，必要输入超限不截断。每个文件流式散列，仅冻结源码保存正文，global.json 签名单独保留，不把 Files.Count 当成总输入数。
- 配置与边界：additionalInputs 最多 32 个根内相对文件，JSON 最长 4096；Node 与 Host 均校验字面路径、重复及边界，Host 验证链接和每次存在性。缺失阻断重载，恢复后显式搜索；切换根后按新根解释。只经显式启动 JSON/原生 argv 传递，不接受 MCP 工具参数或自动读取目标仓库配置。ready 的 inputPolicy.version=1 和实际列表必须匹配，旧/漏配 Host 拒绝并清理，协议 v2 和 15 个工具名不变。
- 针对性失败：首轮 36 项有 1 项因 Windows 大写文件名推导符号名而失败，修正匹配后 36/36。中间 [Host 回执](../test-tmp/roslyn-host/fixture-fif5GD/report.json)在恢复补充文件后于第 23 场景返回 INPUTS_CHANGED；当时信息未区分指纹与事件，不能事后断言唯一根因。[八轮隔离恢复](../test-tmp/review-20260909/input-race-kqPHuT/report.json)未再次复现。保留原失败，拆分错误说明，增加每次加载前最多四个 50 ms 的事件稳定观察窗；没有增加业务重放或放松加载后检查。
- 反证自审：非标准 custom.rules 真正作为 MSBuild Import 改变条件与引用数；AdditionalFiles 的非标准后缀仍被跟踪；丢失补充项后 reload 不得通过过滤旧文件而丢掉要求。实际 MSBuild Touch 在内容哈希不变时仍触发拒绝，证明稳定等待没有吞掉求值期间的事件。移除该写入 target 后可显式恢复。此为作者自审，不冒充独立审核或全磁盘原子一致证明。
- 验收：[核心回执](../test-tmp/check/2026-09-09T07-20-21-008Z-core/report.json)12 阶段通过，350/350、0 失败/取消/跳过，覆盖最终 TypeScript、类型检查、锁定构建、生产 stdio 和现有清单。其后 Host 等待补修由[最终 Host 58 场景](../test-tmp/roslyn-host/fixture-sDJxDM/report.json)及[最终真实 MCP 16 场景](../test-tmp/roslyn-gateway/run-fLDNDI/report.json)验证，构建 0 警告/错误；MCP 覆盖补充配置端到端传递、无关 33 MiB 文件、缺失/恢复、绝对目标、有限重构说明、A→B→A 和真实 MSBuild 取消/崩溃/超时后已观测自有进程退出。中间 46/56/14/16 结果不累加为终验数。
- 环境与交付：复用现有项目内 SDK 10.0.303、锁定 NuGet 缓存及已有 Node 依赖，仅当前测试子进程设置 SDK 路径，不改系统 PATH/global.json。先前默认入口发现不到 SDK 的失败仍保留，B 才统一普通入口/CI 选择。仓内 SKILL.md、code/diagnostics 手册、计划和路线图同步；未部署全局 Skill 或声称当前 Codex 已加载新实现。正式清单仍不含 Code Host，不能用现有 delivery matched 代替 B。
- 资料核对：[MSBuild 增量构建](https://learn.microsoft.com/en-us/visualstudio/msbuild/incremental-builds?view=vs-2022)与[Exec](https://learn.microsoft.com/en-us/visualstudio/msbuild/exec-task?view=vs-2022)用于解释自定义输入无法凭扩展名穷尽；编码 API 根据已安装 Roslyn 5.9.0 XML 契约和真实结果核对。没有下载新工具或增加依赖。
- 本阶段 A1/A2 已完成；B/C、默认迁移、E4 仍未实施。输入补充方案已经批准，不再重复询问；后续 E4 文本策略、实际项目求值范围和正式交付形态按对应阶段对齐。持续写入仍可能拒绝，未列入的自定义输入、生成器、运行时动态调用和全规模性能不在本轮保证范围。
- 收尾检查：六份变更文档的围栏及新增 19 个本地链接有效，Skill quick_validate 和 git diff --check 通过。重新生成清单时默认 dotnet 路径再次复现锁定 SDK 发现失败；改为本轮已使用的项目内 SDK 命令环境后生成/验证成功，未声称修好了默认入口。最终 contentId=`a0298c62eaf3c51710befaed42d1a96087902fe78371947645ad74b98184b4ab`，matched=true，回执 `test-tmp/roslyn-input-delivery.json`；仍只证明既有清单范围。最后的文档/注释更新没有改变已验收的功能逻辑，不重复扩展测试预算。

## 2026-09-09 — 交付、去 Serena 与职责拆分实施（北京时间）

- 用户要求将前轮 A1/A2 后续的 B/C 与巨型模块问题逐项处理；没有把握时暂停对应事项询问。
- 已明确三项产品决定：彻底退役外部 Serena；未提供 Roslyn 项目配置时以本地文本模式启动并说明语义未配置；文本 source 改为 local-text，旧调用方需迁移。版本拟同步为 0.13.0。
- 实施顺序：统一 SDK 与脚本辅助函数 → Code Host 发布清单、构建身份及真实 CI → 本地文本能力独立/移除外部接入 → 精确符号贯穿影响与重构 → 工作区/UIA/上下文/历史测试职责拆分 → 真实回归与文档同步。保留前轮全部未提交改动；不发布远端、不修改真实客户端配置。
- 当前 SDK 入口已用项目内现有 10.0.303 验证，无新安装。Code Host 身份、可选完整交付组件与 CI 步骤已编写，尚待整体验证。
- 已提取原有文本扫描预算/路径/编码/取消规则及纯解析函数。删除外部连接实现及专用启动/协议夹具；外部上游格式/握手专属测试随接口退役，通用身份、UNKNOWN 风险、文本边界和工作区恢复测试迁移保留，最终测试数量会相应变化。
- 初次针对性运行 58 项中 57 通过，1 项仍修改旧适配器私有 timeouts 字段；正在迁移该测试注入位置，未削弱扫描截止断言。完整回归、发布目录语义验收与桌面验证尚未完成。


## 2026-09-09 — B/C 与职责拆分本地验收更新（北京时间 17:02）

- 用户已明确选择：彻底退役外部 Serena；缺少 Roslyn 配置时默认 local-text 并提示语义未配置；旧 source 改为 local-text，同步契约、测试与 Skill。版本标记 0.13.0 为本地待发布。旧配置/启动器/外部专用夹具删除；本地文本扫描和明确退化边界保留。
- B 已实现：维护脚本统一选择已安装 SDK（精确 global.json；无下载/全局改动）；check 发布 Code Host 全目录，交付清单覆盖 deps/runtimeconfig/Roslyn/BuildHost 并验证版本、Release、协议。CI 的 Node 22 增加真实 Host/MCP；尚未推送，因此没有本轮远端运行结果。
- C 已实现：影响/重构接受可选 symbolLocation，保留简单名称入口及别名。先验证已选快照再搜索该声明，拒绝过期/错名，保持 UNKNOWN/不完整语义；本地文本模式在扫描前拒绝精确定位。
- 职责拆分：Workspace 保留根变更/Git/trash，分出 Browser/Discovery/Contracts；本地文本分出扫描/声明解析；Cache 分出 WorkspaceFingerprint；Context 拆出符号收集/格式化，响应拆出纯范围覆盖。UIA Host 分出 Win32、窗口定位、抓图、树读取及契约；FlaUiAdapter 提取纯协议解析，保留集中进程生命周期。删除 Architecture/Refactor 未使用的查询注入。Router 锁、排空、恢复仍集中，未机械拆散事务状态。
- 测试和脚本：两份历史大测试按功能拆成 13 份并隔离缓存；退役外部协议测试，保留通用取消/恢复/边界证据。验收脚本共享 SDK/进程观察，Host 和 Gateway 场景分组。没有为追求测试数量保留不存在的连接接口。
- 本轮失败与修复：首轮核心 302/303，TTL 50ms 被并发 I/O 提前耗尽，改用可控时钟保留前后断言；中文异地 Host 查询正常，但 PowerShell 进程观察非 UTF-8 导致匹配失败，已明确编码并通过完整复验。新增版本测试发现旧输入策略 mock 缺少 id:null，纠正该夹具，避免提前协议错误形成假阳性。Skill 校验器默认 GBK 解码失败后以 Python -X utf8 通过，未改全局设置。
- 当前已通过：[核心 307/307](../test-tmp/check/2026-09-09T08-57-16-594Z-core/report.json)，[桌面夹具 35/35](../test-tmp/check/2026-09-09T08-58-14-312Z-desktop/report.json)，[Host 58 场景](../test-tmp/roslyn-host/fixture-sPovtl/report.json)，[真实 MCP 19 场景](../test-tmp/roslyn-gateway/run-NqA7IS/report.json)，[混合负载 70 调用/10 轮](../test-tmp/mixed-load/run-BcmGpg/report.json)。MCP 使用完整发布目录的中文/空格异地副本和不同 cwd，观测真实 BuildHost/targets 子进程退出；仍复用本机 SDK，不能称为干净机器安装验收。末尾无用构造参数清理另由类型检查与针对性测试验证，最终清单将在收尾重建。
- 反证自审：不仅断言成功；验证缺失/混合 BuildHost 文件清单、错误版本/Debug Host、旧重载定位不可被自动搜索替换，以及被拒绝的文本定位不触发扫描。此为作者自审，非独立审核。
- 文档：README、贡献指南、架构图、仓内 Skill 的默认后端/定位/错误/发布目录说明同步，保留 Serena 致谢及历史日志。
- USER_DECISION_REQUIRED：E4 普通错误文本迁移仍未批准，已请求具体选择；本轮不改变该行为。实际 Codex 连接尚未变更：启用 Roslyn 需明确目标项目、Configuration、TFM 和求值授权；发布/推送及全局 Skill 部署尚未执行。

### 同轮最终核对（北京时间 17:05）

- 无用注入清理后[最终核心 307/307](../test-tmp/check/2026-09-09T09-01-27-993Z-core/report.json)通过；此前 53 项针对性回归亦通过。
- 修正 Gateway 验收发布输出写入本轮 fixture 目录，避免改写正式交付 publish；[最终 MCP 19 场景](../test-tmp/roslyn-gateway/run-R15auS/report.json)通过，随后原交付清单仍 matched=true（contentId=53fcfb01f044dd0acb71b9d086397f30d960208d678308ae48e0bd3697e1910c）。
- 48 个本地 TypeScript 模块静态 import/export 图无环；43 个测试文件各登记一次；Skill 校验、相对链接/代码围栏及 git diff --check 通过。桌面验收后仅 UIA Program 尾部空白整理，最终 check 已重新发布。
- 用户回复要求先详细解释 E4 两方案利弊，尚未选择；已保持现有普通错误 content/isError，不提前新增 structuredContent。后续等待明确选择。


## 2026-09-09 — 当前开发状态上传 GitHub（北京时间 17:13）

- 用户确认尚未广泛分发，可以直接采用 E4 方案二；普通 Gateway 异常已开始统一 JSON 文本与 structuredContent，错误码/恢复动作不从消息猜测，UI/trash 领域载荷保留。随后用户要求先上传当前状态，因此停止扩展实现，以草稿 PR 保存当前完整相关变更。
- 本次验证：[错误契约 10 场景通过](../test-tmp/error-contracts/run-Daj6o7/report.json)；[最新核心检查](../test-tmp/check/2026-09-09T09-11-00-925Z-core/report.json)的类型检查、Gateway 构建及 .NET 构建通过，核心回归 306/307。失败为 tests/resource-cleanup.test.ts 的中文文件原地修改指纹未变化，根因尚未定位；不以此前 307/307 覆盖此失败。此轮 check 在 regression 失败后停止，未执行后续 stdio 与清单阶段。
- E4 待完成：错误/恢复分支专项测试、当前 UI 错误双载荷的验收及完整手册核对。旧的桌面 35、Host 58、MCP 19 场景属于 E4 之前的成功基线，不表示该开发快照已全部复验。
- 上传范围为工作分支 codex/roslyn-correctness 的源码、测试、脚本、仓内文档与 CI；.deps、node_modules、dist、test-tmp、缓存继续忽略，不上传本地依赖或生成证据。Serena 专用目录仍未实际删除。main 未合并，实际客户端与全局 Skill 未改动。

## 2026-09-09 20:40 — 结合最新架构评估收敛下一轮计划（北京时间）

- 用户要求读取“架构分析优化建议”最新分析并结合本地实际更新计划；已读取引用聊天，核对本地/远端 main@a23740c、当前声明解析/扫描、Gateway 错误/影响输出、CI、Skill 与既有验收记录。此次规划不修改生产代码、依赖、实际客户端或远端配置，不派生子代理。
- 直接调用当前 parseTextDeclarations 做六个最小观察：C# `// class Ghost {}`、TS `const note = "class Ghost {}";`、Python 三引号内 `class Ghost:` 都错误返回 Ghost；真实 UserCard 函数在 .ts 返回声明，在 .tsx/.jsx 返回空。源码确认符号/引用扩展名集合不一致。将其列为 LocalText 优先修补，同时保留文本引用、复杂词法和降级完整性的边界。
- 本轮实际执行 `npm run test:error-contracts`，10 场景通过；[报告](../test-tmp/error-contracts/run-uZMb3F/report.json)。它证明当前实现的已测分支，不证明标准一致性：unknown tool 的现有断言本身要求 isError，需按协议层修订。持续 CI 和恢复/领域分支仍待补齐。
- 只读核对 [CI 34339009649](https://github.com/linnnn89/WinCode/actions/runs/34339009649)：Node 22/24 成功，Node 22 真实 Host/MCP 步骤成功。CodeQL 34339009257 的三个有效语言成功、Python 历史 job 失败，失败注释明确 exit 32/没有 Python 源码；附带增量缓存提示不能替代该直接证据。
- 与聊天结论的一处更新：GitHub default-setup 当前语言列表已排除 Python，updated_at=2026-09-09T10:13:02Z。将“修改 Python 配置”从待做事项撤下，改为下一次新扫描确认；本轮未改远端设置或触发扫描。当前仓库没有本地 CodeQL workflow，不为历史红叉另建一套流程。
- 对照 MCP 2025-11-25 工具规范确认未知工具属于协议错误、业务输入值校验属于工具错误；保留已批准的 E4 方案二，不重新要求用户选择旧方案。影响报告去掉第二文本块与 unknown tool 的对外兼容调整列为实施前明确项，暂不扩展全工具响应抽象。
- 重写根目录计划和路线图，只保留 0.13 修补方针、实际客户端验收及条件性 UI→Roslyn/性能研究。移除 E1–E3、A1/A2、B/C、Serena 退役和职责拆分的已完成步骤；所有历史实现/失败仍保留本日志与 Git，未把旧失败静默删成成功。
- 本轮未执行完整核心、桌面或真实 Roslyn 套件，也未声称当前客户端已启用。仅用已有远端结果建立版本基线；计划保留隔离项目、求值范围与实际消费者验证关口。
- 文档终验：两份计划的 15 个本地链接、围栏、版本和维护命令核对通过，git diff --check 通过。校验脚本首次按系统默认 GBK 读取含中文 JSON 失败；改为显式 UTF-8 后回执校验通过，未改全局环境。


## 2026-09-09 21:18 — 0.13.1 LocalText 与 E4 稳定化实施（北京时间）

- 用户要求按计划实施，沿用既有逐版本复测/debug、PR 与合并授权。针对客户端验收的询问，用户明确选择“先完成代码与 CI，客户端验收暂缓”；未修改真实 MCP 配置或已安装 Skill，未安装新依赖/SDK，未分出子代理。
- LocalText：复用并提取现有 C# 非代码区屏蔽纯函数；增加有深度/取消边界的 JS/TS/Python 屏蔽。修复注释、字符串、模板、正则及 JSX 展示内容产生假声明；增加 TSX/JSX 扫描与指定文件符号取证。行号/展示签名保留原文；词法边界不确定时文件结果不完整且不缓存，旧 v1 声明缓存失效。插值/JSX 表达式省略，复杂语法仍可能漏检，不主张完整语法或精确引用。
- E4：正常受理时未知工具走 SDK ProtocolError -32602；已知工具保留 isError/领域载荷，关闭/取消的入口优先级不变。专项由 10 扩展为 16 场景，覆盖真实隔离 trash metadata partial 及重试位置、工作区提交失败/阻断/恢复、注入 UI 失败与独立图片。后者只验证序列化，不冒充真实截图。Node 22 CI 新增专项及有界回执上传。
- 影响输出：删除第二份 Markdown 文本，保留 JSON 中 formattedReport、证据字段和别名。固定 dotnet-mini/MemoryService 的同一结果文本从 3194 减至 2511 个 UTF-16 字符，减少 683；[量化回执](../test-tmp/impact-0131-size.json)。这不是实际 token 测量或跨任务性能结论。
- RED/DEBUG 记录：各类 Ghost、TSX、未知工具和输出去重先复现失败后修复。第一次完整 check 的两个失败来自仍要求旧 stdio 结果的断言，按新契约迁移后通过；测试编写中的 evidence.content/impact.data 错误访问由类型/运行检查指出并更正。自审又复现代码块后的正则字面量泄漏，补充反例并修复后重跑完整检查。未删减生产边界或用旧成功覆盖失败。
- 最终本地验收：[核心检查](../test-tmp/check/2026-09-09T13-15-21-646Z-core/report.json)318 项、317 通过、0 失败、1 跳过（未配置固定 TavernDesk 工作区的可选集成）；覆盖类型、锁定构建、生产 stdio 与完整交付。独立[桌面夹具 35/35](../test-tmp/check/2026-09-09T13-09-20-368Z-desktop/report.json)、[真实 Host 58 场景](../test-tmp/roslyn-host/fixture-cB6uto/report.json)、[真实 MCP 19 场景](../test-tmp/roslyn-gateway/run-j1oS63/report.json)、[E4 16 场景](../test-tmp/error-contracts/run-6c5rEY/report.json)通过。后续仅手册/换行整理，最终核心已重新构建核对交付；无实际客户端验收。
- 文档：版本统一 0.13.1；README、CHANGELOG、SECURITY、架构/配置指南与仓内 Skill 对齐；计划仅保留暂缓的客户端关口和条件性后续工作。77 个变更文档本地链接、代码围栏核对通过。历史日志追加而非改写，生成证据仍在忽略目录内。
- 作者反证自审覆盖旧缓存假阳性、词法不确定的假零结果、长字面量取消、未知工具后的连接可用、impact 字段/别名保持，以及部分移动后真实文件位置；不等同独立模型或人工审核。剩余边界：有限词法、文本引用、干净机器/长期耐久性及实际消费者均不扩大声明。
- 发布流程：工作分支 codex/local-text-e4-stabilization；本地通过后推送本版本 PR，等待对应 head 的 Node 22/24、真实 Roslyn/E4 及有效 CodeQL 全部通过再合并。远端完成情况以 PR/Actions 回执为准，此条写入时尚未推送，不提前声明 CI 已绿。


## 2026-09-09 21:28 — 本地 WinCode Skill 与远端同步（北京时间）

- 用户恢复客户端验收后，明确要求先修复远端手册与本地 Skill 脱节。fetch 核对 origin/main 与本地均为 76b343c，四份仓内受管手册与远端一致。
- 已安装位置为 C:/Users/40218/.agents/skills/wincode，原版本 0.12.5；使用现有 sync-skill 脚本更新 SKILL.md、references/code.md、references/diagnostics.md 到 0.13.1 契约，ui.md 原已一致。修改前完成备份，位置：C:/Users/40218/.agents/skills/.wincode-backup-9404b286-f360-42e9-b6a7-13cd35dbe39d；备份采用 .bak 后缀，不注册为重复 Skill。
- 更新后四文件 SHA-256 与仓内一致，skill check 无差异；delivery:verify matched=true。详见[本地同步回执](../test-tmp/skill-sync-0131.json)。无新增依赖，未改 MCP 配置、未重启客户端。
- 实际连接 hello 仍返回 0.12.5，instanceId=17625857-dbe1-48b8-9305-946629711532，wincode_find_references Schema 只有 symbolName/relativePath、没有 symbolLocation。配置仍指向 I:/WinCode/dist/index.js，当前工作区 I:/WinCode，尚未提供 --roslyn-config。因此已完成手册同步，尚未完成实际连接升级或 Roslyn 验收；后续须准备隔离验收配置并正常重连，不能向旧接口传新字段后宣称生效。


## 2026-09-09 21:33 — Skill 功能指引与 0.13.1 实现对照（北京时间）

- 用户要求确认指引与实际项目是否一致。本轮对照四份受管手册、Gateway Registry/Schema/验证器、LocalText/Context、RoslynAdapter/Host、UI 查询和恢复路径；不使用旧连接行为推定新版源码，不派生子代理。
- 发现并修正文档差异：scopeFiles+symbol 段落漏写 TSX/JSX；简单名引用示例未提示 Roslyn 只返回候选；health.text.semanticConfigured 被误读为整个实例配置状态的风险；维护脚本实际还原/构建 Host 及生成夹具，不能称为只还原夹具或完全离线。补充不同提供方 kind/大小写与 queryComplete 边界、目录参数默认值、lineRanges.file 长度，以及 diagnose 不主动加载 Roslyn、MCP 搜索代替内部 reload 的具体操作。
- 验证：源码与 dist 的 15 个公布工具 Schema 哈希一致，四份手册包含所有顶层规范字段；两种别名与恢复规则按源码核对。33 项现有 tool-contracts/local-text 测试全部通过；这不证明未覆盖语法或实际客户端语义。范围及字段清单见[核对回执](../test-tmp/skill-contract-audit.json)，[针对性测试输出](../test-tmp/skill-contract-audit-tests.log)。
- 仅修订仓内 references/code.md 与 references/diagnostics.md，保持公共接口/代码不变。通过现有脚本备份并同步本地 .agents/skills/wincode，四文件相等，Skill 校验、链接/围栏、git diff --check 通过。备份为 .wincode-backup-9fd16a60-2ff6-4bb3-980e-f88fe7f01460。重新生成并验证交付清单 matched=true，contentId=517363f6087c4c8e7976f7d810ae0e70ca290ed2bf6e12a7bf2f60650a1e1694。
- 反证自审：Roslyn 已配置时 text.semanticConfigured 仍为 false；简单名返回 references=[] 实际可能尚未查询引用。修订指引要求读取 codeProvider/health.roslyn 和 resolution/candidates，并使用真实搜索 location，避免把这两种情况误判为后端不可用或零引用。
- 再次实际 hello：连接仍是 0.12.5、instanceId=17625857-dbe1-48b8-9305-946629711532；引用 Schema 仅 symbolName/relativePath，没有 symbolLocation。故“手册与本地 0.13.1 实现对齐”不等于“当前连接可使用新版接口”。本轮未改 MCP 配置、未执行客户端 Roslyn 验收；文档修订尚未提交远端。


## 2026-09-09 21:34 — 将核对问题同步到项目 Skill 指南（北京时间）

- 用户明确要求把发现的问题同步写入项目指南。确认前轮修订已存在于仓内 skills/wincode/references/code.md 与 diagnostics.md，并补齐根目录 WinCode-Skill制作与MCP配置指南.md 的对应说明。
- 根指南同步健康字段归属、Roslyn 简单名候选/精确定位、过期定位恢复、TSX/JSX 与 kind 差异、维护脚本还原/网络边界；更新核对日期并补齐 Code Host 交付目录说明。参数细节继续引用受管代码手册，不另建重复字段表。
- 本次仅增加根指南和工作记录，受管四文件未再变化，本地 Skill 与仓内一致；链接/围栏及 git diff --check 核对通过。沿用前轮已通过的 33 项针对性测试，不因说明同步重复运行代码回归。未修改 MCP 配置或推送远端。


## 2026-09-09 21:42 — 恢复实际客户端验收并准备隔离配置（北京时间）

- 用户要求继续已安排工作，沿用恢复隔离 Roslyn 验收及配置修改的明确授权。保留此前未提交文档修订；不修改生产代码、个人应用数据或真实 TavernDesk 项目。
- 现场环境与旧记录不同：项目内 .deps/dotnet-10.0.303 已不存在，现有系统 C:/Program Files/dotnet/dotnet.exe 经维护脚本核对 SDK 10.0.303 可用；未安装或修改全局工具链。现有 wincode 参数已由此前的含 workspace 改成仅 dist/index.js，本轮以实际读取的版本备份，未恢复过时配置。
- 生成 test-tmp/client-roslyn-20260909/workspace 的 App/Lib 项目：Debug、net10.0、C# 13，两个 Api.Save 重载及 Other.Save 同名方法；整型重载基线引用为 App/Use.cs 第 7、10 行，字符串第 8 行、其他类第 9 行。NuGet.Config 清空包源；还原/构建通过。Code Host --identity 返回 0.13.1/Release；delivery:verify matched=true。[准备回执](../test-tmp/client-roslyn-20260909/preparation.json)。
- 仅修改 C:/Users/40218/.codex/config.toml 的 mcp_servers.wincode.args，加入隔离工作区及 --roslyn-config；其他配置字节保留。原服务器块备份于 C:/Users/40218/.codex/backups/wincode-before-client-roslyn-1b3f90fd-059b-4617-a651-42691eeaadd2.toml，未将完整宿主配置复制进项目。codex mcp get wincode --json 已读出正确新参数。[变更回执](../test-tmp/client-roslyn-20260909/client-config-change.json)。验收完成后恢复此前参数，不保留默认指向测试夹具。
- 实际连接在配置更新前后均返回 0.12.5、instanceId=17625857-dbe1-48b8-9305-946629711532，引用 Schema 只有 symbolName/relativePath，当前工作区仍 I:/WinCode。没有调用旧版不支持的新参数，没有另起脚本模拟实际消费者通过。当前工具没有重连能力，需用户正常重启 Codex 后继续本任务；不强杀宿主或 Gateway。
- 当前完成的是夹具构建、配置准备和读取校验；实际搜索/引用/影响/重构、stale 与恢复尚未执行。计划和路线图同步为“进行中，等待客户端重连”，不再沿用暂缓状态。


## 2026-09-09 22:29 — 0.13.2 连接退出与限时清理（北京时间）

- 用户已确认按顺序实施退出、异常终止验证及空闲回收；沿用逐版本测试、PR、合并授权，单智能体执行，无新依赖。保留并同步此前 Skill/配置指南修订。
- RED：正式 dist/index.js 在客户端 EOF 后 9 秒仍存活；初始化期间 stop 后仍执行后续阶段；卡住的适配器令其他清理无法执行。
- GREEN：统一 EOF/close/管道错误与退出入口；先连接传输、业务请求等待初始化；关闭取消所有 MCP 操作及初始化，晚到资源立即回收；共用 8 秒预算并为所有权清理预留时间。
- 针对性 27 项通过。旧测试预期退出时继续完成工作区重绑，已按批准的取消行为更新为拒绝切换、只执行一次 dispose；保留失败后刷新缓存的既有行为。完整检查、PR/CI 尚待后续记录。
- 纠正前记录：无需一概重启整个 Codex，刷新对应 MCP 连接即可；当前工具未提供已验证可调用的重连入口，未强杀用户宿主。异常进程终止和空闲回收未在本阶段宣称完成。

- 完整检查第一次因已有 40ms TTL 测试在并行负载下先过期而失败（保留 2026-09-09T14-29-49-098Z-core 报告）；改用受控 Date.now，保持过期前/后断言，不延长 TTL。重跑核心 322 项：321 通过、1 可选场景跳过；桌面 35/35。正式入口及生命周期最新针对性 27/27，通过交付清单校验。

## 2026-09-10 08:19 — 本地同步 GitHub 昨晚最新版（北京时间）

- 用户要求对齐本地落后版本。fetch origin 后确认远端 main 为 6e27e06（2026-09-09 22:39，0.13.2）。同步前工作区干净，本地 a2d76f6 与远端 #30 的 2235a42 为补丁等价提交，实际缺少 #31、#32、#33 三次更新。
- 先创建 codex/backup-before-sync-20260910 保留旧 main，再通过 git reset --keep origin/main 对齐；HEAD 与 origin/main 完全一致。无依赖安装、全局配置修改或远端推送。
- npm run typecheck、npm run build 通过；生产入口 EOF 针对性测试 2/2 通过。dist 从旧 0.13.0 刷新为 0.13.2。
- 反证核对：源码同步不能证明旧构建或已运行 MCP 已更新，因此补做 Gateway 构建；本轮未重建 .NET Host、未验证完整交付清单、未执行完整回归或刷新现有客户端连接。上述边界不作为已完成的运行时部署报告。
- 同步后仅本条工作记录为本地未提交变更，源代码保持与 GitHub 一致。

## 2026-09-10 08:29 — 结合网页版讨论更新下一轮迭代计划（北京时间）

- 用户要求读取昨晚本地迭代文件并结合“架构分析优化建议”形成更具体计划。通过 read_thread 取得 9 轮对话（无更多分页），区分早期建议、GPT 后续撤回与用户最终的客户端无关/托盘偏好；只更新既有计划书、路线图和本日志，没有实施生产代码或客户端配置变更。
- 基于 main@6e27e06/0.13.2 核对 Router、RoslynAdapter/Host、UIA、Cache/UiAudit、Gateway、CI 和交付入口。确认可逆释放尚缺、Code Host 初始加载先于 EOF 循环、UIA EOF 是输入边界；已有 Job 不能直接当作 Gateway 死亡即全树退出的证明。
- 纠正跨机器就绪状态：旧记录涉及 C:/Users/40218 与 I:/WinCode，本项目没有 test-tmp/client-roslyn-20260909 的 preparation.json/client-config-change.json；不沿用“本机只等重连”。状态统计会枚举磁盘缓存，现行审计为 1 MiB 提醒/2 MiB 阻断且不自动删除，分别纳入托盘开销与存储政策边界。
- 新计划按 M0 本机基线、M1 异常所有权、M2 实测后局部延迟、M3 Roslyn 可逆释放、M4 托盘 MVP、M5 策略/暂停/存储细化模块、验收、停止与回退条件。版本号为建议，不当作已发布。GPT 已撤回的通用 Lease/FSM、全面工作区休眠不继续安排。
- USER_DECISION_REQUIRED：独立 WinForms/Named Pipe 与启动方式、idle 默认策略、暂停范围、日志保留，以及本机配置/安装/外部操作仍在相应阶段确认；本次未修改真实设置、安装依赖、运行进程强杀或推送。
- 官方只读核查：Microsoft Job Objects、WaitForSingleObject、NotifyIcon、PipeOptions 与 Node net/timers，链接置于计划相关段落；没有沿用网页聊天的隐藏引用标记。
- 反证自审纳入：管道断开不等于进程退出、仅 inFlight 不覆盖切换等待、后台 idle 错误不能绕过 E1、托盘状态不能持续扫盘、配置保存不等于所有实例生效、缓存目录可能被多实例共用。属于作者自审，不是独立模型或运行验收。

- 2026-09-10 08:31 用户补充明确平台范围：README 中英文新增 Windows 11 x64 本地开发/测试基准，说明其他操作系统、Windows 版本与依赖版本不保证一致效果，建议 macOS/Linux 用户 fork 后本地适配；同步平台徽标、计划书和路线图，不安排本轮跨系统移植。
- 文档验证：四个变更文件 UTF-8 可读，README/计划书/路线图代码围栏闭合，51 个本地 Markdown 链接目标存在，中英文平台/依赖/fork 说明完整，git diff --check 通过。没有运行代码测试、跨平台验证或未来功能实验；保留前一轮同步日志，最终变更仅 README、既有计划书、路线图及本日志。

## 2026-09-10 09:17 — 按计划实施 M0/M1，自有原生 Helper 的所属进程退出保护（北京时间）

- 用户授权“开始按计划进行迭代和测试”。保留之前四份文档修改，在 codex/m1-parent-ownership 本地分支实施；使用已有 Node 24.19.0、项目内 .NET SDK 10.0.303 和锁定依赖，没有安装/升级或修改客户端配置。
- M0 原始 0.13.2 完整 check 322/322、生产 stdio 和完整 delivery 校验通过，回执 [core baseline](../test-tmp/check/2026-09-10T00-42-56-585Z-core/report.json)。本机 App/Lib 和后续回执由 scripts/verify-roslyn-gateway.mjs 重建，不使用旧机器路径。
- M0 当前真实 Codex 连接两次 hello 均仍为 0.13.0/local-text，instance fcff4dad-c746-48ed-ac78-c995ea47d54e，build f9860e16528a104cb939d8a53c4e64d9411561287197e531a89860c78bd1b23f。隔离 stdio 的新交付不等于该实例更新；实际消费者语义闭环、客户端重连及已安装 Skill 同步仍未完成。
- M1 新增 tools/Shared/OwnerProcessGuard.cs，由两个 Host 链接共享源文件。Gateway 只向自有子进程传 WINCODE_OWNER_PID；Host 在项目求值/UI 访问前校验最多八层真实祖先、创建时间和存活状态，再持有 owner 进程对象句柄。没有客户端进程名称判断、周期全机监控、新依赖或新增 MCP 工具。
- owner 死亡先 CancelAsync 广播；独立线程宽限两秒后仅 TerminateProcess 当前 Helper，避免原生调用/取消回调卡住兜底。Code Host 继续由既有 Job 覆盖其后代；UIA EOF 保留输入结束语义。Code Host 初始加载与请求取消接入 owner token，内部协议仍 v2。
- 新增 owner-guard-check 原生夹具、13 项隔离测试，涵盖原生阻塞、取消回调阻塞、正常协作退出、父进程在 Attach 前退出、启动包装链、非法/无关 owner、自指 owner、重复释放句柄、两个实例隔离及生产 UIA EOF。夹具 Helper 使用 detached 以防 Windows 控制台连带退出掩盖测试；生产启动方式未改。
- 真实 Code Host/MSBuild 初始加载和 UIA 读取分别通过目标写入握手进入故障阶段，再仅强杀测试 Gateway。按预先记录的每个 PID/创建时间查残留，不能依赖已断开的祖先链。失败清理持有实际 Process.SafeHandle 并核对创建时间；不按名称终止。0.13.4 最终 [MSBuild owner receipt](../test-tmp/owner-death/run-hnEJ0Y/report.json) 无观测残留；[UIA owner receipt](../test-tmp/owner-death/run-6OH4q7/report.json) 无 Helper 残留、目标进程仍在，随后才单独关闭测试目标。
- Repomix 使用真实 RepomixAdapter + 生成 Node CLI 审查，在本机未观测残留，见 [controlled Repomix receipt](../test-tmp/owner-death/run-liokKo/report.json)。没有安装/运行真实 Repomix；这个结果不等于它继承了 .NET guard 或其全部第三方后代受到保障。CLI 路径未改。
- 失败过程：首次强杀后 transport.pid 已清空导致脚本断言失败，已改为强杀前保存 PID；随后发现残留查询不能只从死亡的根递归，改为匹配全部预观测身份。旧 0.13.2 在本机初始加载样本中也未观测残留，因此没有把该样本记作已复现产品缺陷。早期清理脚本把预期的“PID 不存在”当错误退出，修正错误处理后重跑。句柄重复测试原有 CLR Thread 对象延迟回收和 JIT 最后引用滞留，采用测试侧预热、NoInlining 分组与终结器回收后原阈值通过；生产不调用 GC。
- 0.13.3 阶段完整 core 335/335、desktop 35/35、[直接 Roslyn Host 58 场景](../test-tmp/roslyn-host/fixture-6JyqoD/report.json)、Gateway 19 场景及 E4 16 场景通过；CI 文件加入 owner-death 与受控 Repomix 场景/报告上传，但没有推送或运行远端 CI。
- 作者反证自审：正常关闭通过不能证明原生阻塞也退出，因此加入独立阻塞夹具；Helper 退出不能证明全部后代退出，因此按身份逐类报告；目标窗口存活与测试收尾分开记录。真实 PID 复用/权限差异及其他 Windows 版本未实测；仍存活但卡死的 Gateway 不触发本机制。
- 原生接口核对采用 Microsoft [Process32FirstW](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-process32firstw)、[PROCESSENTRY32W](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w)、[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) 与 [WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)；这些文档不是本机运行验收的替代。

## 2026-09-10 09:19 — M2 按启动测量延后 UIA 探测，0.13.4 本地交付（北京时间）

- 在 M1 后做三次 stdio 和源码 Router 分段样本，[改前报告](../test-tmp/runtime-baseline/run-msaLjT/report.json)：连接到 hello 426.7–434.8 ms；Router 初始化 165.7–168.1 ms，其中 FlaUI 158.9–161.2 ms、每次创建一个健康探测进程。缓存约 2–3 ms、指纹约 1–2 ms、watcher 小于 1 ms，没有证据支持把它们一并休眠/延迟。生成夹具规模不能代表大仓库。
- M2 仅修改 FlaUiAdapter 初始化为平台/配置/发布文件校验，不运行原生 probe。尚无运行观察保持 available=null/source=unknown；首次 UI 请求直接执行且成功响应更新已知身份；主动 diagnose 保持探测，非强制并发 probe 在既有 mutex 内复查 memo。ToolRouter 单独保留首次 UI 失败，即使健康仍 unknown；未改 watcher/cache/Roslyn 的启动策略或 MCP Schema。
- 新增 3 项测试，覆盖初始化不探测、并发首次非强制诊断共享观察、缺失文件报告/恢复后首用，以及 first-use timeout 的 unknown/lastAdapterError 边界。作者反证自审修正：失败响应不能自动把未探测 Host 标为已确认不可用，也不能因 health=null 丢掉错误。桌面 hello 测试按真实未探测状态断言 null/unknown，随后原有真实 UI 首用测试照常执行。
- 最终 [core 338/338](../test-tmp/check/2026-09-10T01-13-24-684Z-core/report.json)、[desktop 35/35 + UIA owner-death](../test-tmp/check/2026-09-10T01-15-11-141Z-desktop/report.json)、[真实 Gateway 19 场景](../test-tmp/roslyn-gateway/run-orlRgW/report.json)、[E4 16 场景](../test-tmp/error-contracts/run-CRw4pt/report.json) 全部通过。直接 Host 的 58 场景在 M1/0.13.3 阶段运行，此后 Code Host 仅同步产品版本；没有把它记作再次运行。
- 首组改后采样与其他测试竞争资源，单独保留 [并行负载样本](../test-tmp/runtime-baseline/run-CUJxNy/report.json)，不用于安静对照。待重测试结束后，[改后独立三样本](../test-tmp/runtime-baseline/run-6cXWUA/report.json)：连接到 hello 273.8–289.8 ms，Router 6.7–6.9 ms，FlaUI 静态校验约 0.32 ms，启动原生 probe 为 0。语义冷查询 3.58–4.29 s，热查询 102–108 ms，客户端关闭约 28–32 ms；全部观测进程在关闭后退出。样本共享 OS/SDK 缓存，不给 p95/跨机器性能承诺，未声称改善 Roslyn 语义查询耗时。
- 改后进程 working-set 合计：未用语义约 84.6–85.2 MiB，语义操作后约 193.9–211.9 MiB；进程求和可能重复计算共享页，只是瞬时快照。启动统计只覆盖被包裹的 Node 异步文件方法/spawn，不含全部原生或内核 I/O。Roslyn 可逆释放仍未实现，不能把上述数据当作已节省驻留内存。
- Node 24.19.0/Windows 11 本机最终源码、Gateway 和两个 Host 版本 0.13.4；buildId 07ee0681a89cdc8035d3038f8710a43e923f7e44385a2aaa3ce38eadab90ae19；delivery contentId 7131f0943f56b81aa5033458765c5cb320cb0b37723a1054c8fee1e8f83f14d2 再次校验 matched=true。工具数 15，Schema 哈希与基线相同。test inventory 45 个文件完整覆盖，git diff --check 通过。
- README 保留用户的 Windows 11/其他平台 fork 说明，同步源码版本；CHANGELOG、受管 Skill 源文件、既有计划/路线图和 CONTRIBUTING 更新。未提交/推送、未安装全局 Skill、未改客户端/自启动、未删除用户审计记录。Node 22/远端 CI、跨权限/系统版本、真实 Codex 新版本语义消费尚未验证。
- USER_DECISION_REQUIRED：已发出 D2（建议默认关闭 idle，显式开启后比较 120/300/600 秒）和 D1（建议独立 WinForms/Named Pipe、首版手动启动）的选择题，尚未收到答复。按计划第 9 节及用户协作契约的重大路线边界，M3 自动释放策略和 M4 托盘不据沉默启动；M5 暂停/存储仍按 D3/D4 决定。当前本地增量可评审，当前连接升级仍单独待验。

## 2026-09-10 10:31 — M3 手动释放与 M4 最小设置，0.14.0 本地交付（北京时间）

- 用户已确定“默认关闭自动释放、设置内手动释放；优先 Agent 工作流畅度，同时平衡后台内存；其他细节按最小方案”。D1/D2 已确认，M3 手动路径与 M4 合并为 0.14.0；本轮没有 idle timer/自动释放开关、开机自启动、全局配置写入、暂停、停止全部或存储清理。沿用现有 SDK/框架，没有新增 NuGet 包或安装依赖。
- RoslynAdapter.releaseWarmState 复用现有 mutex/关闭链，覆盖操作排队与异步清理；释放只清 Host/snapshot，保留配置、诊断并保持可再次加载。ToolRouter 保护 MCP 在途、直接语义操作、待执行切换、shutdown/recovery；忙碌直接拒绝，不排队延后释放。被接纳释放之后的新请求等待其完成；关闭失败进入现有 restart_gateway 恢复门。缓存/watcher/Gateway 保留。
- 新增可选 WinCode.Tray，独立 WinForms NotifyIcon 与设置窗口，手动启动；Gateway 仅显式 --tray 时接入。读取内存快照，不启动 Host 或扫描磁盘缓存，隐藏窗口不轮询。八个实例槽加一个唤出窗口槽，控制绑定活连接及 instanceId，管道受当前用户/会话、本机/实际客户端 PID 和额外 User SID 校验保护；限制帧、待决操作、连接退避，断开/超时保留未知，不重放控制。退出 Tray 后 MCP 独立运行。
- 首批失败包括测试夹具相对 Host 路径、管道地址转义、时序断言、测试变量类型标注和文档脚本语法。明显路径/语法/类型问题直接修正；初始超时测试按本轮已记录 PID/创建时间关闭自有测试进程，随后确认无观测残留，没有按客户端名称清理。所有失败回执保留在 test-tmp，不改写为成功。
- 用户新增要求：非简单语法/object 等错误，首次测试失败即主动查官方文档和真实 GitHub 实现/问题记录。已写入 CONTRIBUTING。时序断言依据 [Node net 回调契约](https://github.com/nodejs/node/blob/main/doc/api/net.md)改为等待真实 shutdown 回调，不以额外固定 sleep 粉饰通过。管道本机连接实际返回 229，核对 [Microsoft ERROR_PIPE_LOCAL](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-) 后只接纳这一明确本机结果；其他失败或远程查询成功均拒绝。
- 另查 [dotnet/runtime #123903](https://github.com/dotnet/runtime/issues/123903)，CurrentUserOnly 的历史 Owner SID 行为不能替代实际 User SID，故在读取首帧后按 [RunAsClient 官方用法](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeserverstream.runasclient?view=net-10.0)同步核验客户端 User SID。重复唤出使用 Identification 身份级别并等确认后关闭短连接；不模拟客户端操作文件或执行程序。依据 [构造函数说明](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeclientstream.-ctor?view=net-10.0)核对默认 None 与显式 Identification 的差别。
- [核心 check 356/356](../test-tmp/check/2026-09-10T02-26-26-551Z-core/report.json)通过：包含 8 项手动释放、9 项 TrayClient 和可选 Tray 交付校验；TypeScript、锁定还原/构建、生产 stdio 均通过。核心之后的 Tray 发送前失联复查和重复唤出细化已重新 Release 发布，并以最终 Tray 验收验证；没有把此前核心回执中的旧 delivery ID 称为最终交付 ID。
- [桌面 check 35/35 + UIA owner + Tray](../test-tmp/check/2026-09-10T02-28-08-797Z-desktop/report.json)通过；最终 [Tray 7 个场景](../test-tmp/tray/run-z65Kr8/report.json)再验证真实 WinForms、同用户安全管道、两个独立 stdio MCP、忙碌拒绝/仅选中实例释放/重复释放/隐藏与退出、重复唤出和实际 dist/index.js --tray 的确认后退出。UI 使用模拟 Roslyn 生命周期，真实 Roslyn 由下述独立验收覆盖；不把截图或模拟后端说成真实项目 UI/Roslyn 全链路验证。
- [真实 Roslyn 十轮报告](../test-tmp/manual-release/run-umaOsZ/report.json)通过：每轮查询及引用正确、新 snapshot、旧定位在无 Host 时明确拒绝、所有预观测 Code Host/BuildHost 按 PID/创建时间确认退出，资源登记始终为 3；缓存标记和 namespace、watcher 保持。另覆盖冷态新增源码、释放后 A→B→A。没有观测残留。未重跑未受修改的纯 Host 58 场景；本次 [真实 MCP/Roslyn 19 场景](../test-tmp/roslyn-gateway/run-F36HcB/report.json)和 [E4 16 场景](../test-tmp/error-contracts/run-USNVaz/report.json)已重跑通过。
- 十轮生成小项目：冷查询 3.717–4.112 秒，热查询 109–148 毫秒，手动关闭 21.6–27.2 毫秒；进程工作集合计约 200.2–206.9 MiB → 67.7–69.6 MiB，被关闭的 Host/BuildHost 合计约 132.0–137.5 MiB。共享页可能重复计数，不等同精确回收的独占 RAM；样本共用系统缓存，非大型仓库/p95/跨机承诺。独立 Tray 打开时单次工作集约 51.5 MiB、private bytes 12.7 MiB；Tray 自身有成本，因此继续采用可选手动启动/退出，无自动高频监测。
- 最终 Gateway buildId=458dc48f0d60f0d2cebf98e3b989efafddfcf74646da46c8c871ed475b1bb6bd；完整 delivery contentId=0f4bd8f371eb74d040b64fd7683ca033e6aaaa6d4c1fe0972b79aa058141cefa，0.14.0 matched=true。15 个 MCP 工具和 Schema 哈希保持原值。最终托盘截图已人工视检，无当前截图范围的裁切/重叠；默认系统 DPI 下的程序化渲染不代表全部 DPI 或人工鼠标操作验收。
- 作者反证自审：Agent 两次调用之间可能仍在规划，界面空闲不等于整个任务结束，因此只提供用户手动释放且提示旧定位失效；状态陈旧时后端仍重新判断。畸形帧与随后合法帧同批到达必须停止处理，已有回归；断线重连前的旧待发控制重新检查连接状态。普通 Node 和 .NET 唤出客户端均已本机联调，同权限/跨用户拒绝矩阵、Explorer 重建、八实例上限压力及长期驻留仍未全面实测。
- README 中英文、既有计划书/路线图、CHANGELOG、Skill 源文件及 CONTRIBUTING 同步；真实 Codex 连接、已安装 Skill、客户端 --tray 接入没有改动或升级。本轮没有提交/推送或运行远端 CI；Node 22 与其他 Windows/依赖版本仍未实测。M5/自动策略为延后范围，实际消费者接入保持待验。
- 文档收尾：8 份相关 Markdown 为有效 UTF-8、代码围栏闭合；现行文档及本轮新增日志的 66 个本地链接目标存在，版本/锁文件一致，git diff --check 通过。全历史日志扫描另发现 15 个旧机器 test-tmp 回执未随源码来到本机；保留历史记录，不据此引用其结果作为本轮验证。首次链接脚本把 chatgpt-conversation URI 当成本地路径，已按 URI 类型修正校验器。


## 2026-09-10 11:32 — 0.14.0 稳定性收尾：工作流连续性、状态可信度与原生交付（北京时间）

- 用户确认按分析继续，再次强调优先工作流畅、避免反复启停。保持无自动释放/自动加载策略；仅用户手动释放，忙碌不排队。未增加依赖、全局配置、自启动或 M5 能力，未修改实际 Codex 启动参数、重启客户端或推送远端。
- 设置改为“暂无在途请求”，明确不代表 Agent 整个任务结束。连接保留但刷新失败、观察超过 30 秒时标为未知，保留上次观察时间；释放前重新获取被动状态，超时不继续控制。可见窗口的一秒计时器只重绘时效，隐藏时停止，不向 Gateway 轮询或改变 Host 生命周期。操作结果绑定实例，切换选择不会显示另一实例的结果；调整说明文字换行及表格宽度，避免 PID 列/页脚裁切。
- 本地管道新增注册接纳/拒绝反馈及可见原因；修复 InvalidDataException 未纳入 IOException 过滤导致监听任务退出的问题。连续 12 次不兼容注册后继续服务。拒绝和唤出回复均有界等待客户端读取/关闭，避免立即 Disconnect 丢掉未读回复，不使用不可取消的 WaitForPipeDrain。安全身份校验及正常 MCP 退出入口保持。
- 原生发布改由 scripts/publish-native.mjs 在构建前采集输入、构建后复核并绑定完整产物，check 自动使用该入口。覆盖项目目录（排除 bin/obj）、仓内 Shared、仓内 props/targets/NuGet 配置和现有构建脚本；delivery:verify 复查原生输入/产物，不能通过重新生成交付清单接纳改过 .cs 的旧 DLL。范围是仓内已知输入，不是任意外部 MSBuild 导入/SDK 二进制的签名证明。加入源码/共享源码变化、继承配置变化、构建中变化和输出排除的回归。
- [核心检查 360/360](../test-tmp/check/2026-09-10T03-20-58-314Z-core/report.json)通过，包含类型检查、锁定构建、生产 stdio 与交付验证；此前 [失败回执](../test-tmp/check/2026-09-10T03-19-06-872Z-core/report.json) 保留。旧 watch-invalidation 测试在整个仓库写探针并固定等 500ms，受并行写入/尾沿 debounce 影响；改成隔离 Git 工作区并等待真实 noteFilesystemChange 回调，原失效逻辑继续执行且仍断言指纹不同，未改生产 watcher/缓存或绕过 memo。针对性 5/5 通过后完整重跑通过。
- [桌面 35/35、UIA owner、托盘与贯通验收](../test-tmp/check/2026-09-10T03-22-29-403Z-desktop/report.json)通过。[真实贯通回执](../test-tmp/tray-workflow/run-Ho43hD/report.json)使用正式 dist 的 Router/MCP/TrayClient、原生设置处理函数、同用户安全管道与两个实际 Roslyn 项目：实际并发语义请求拒绝释放且不延后执行；七次间隔查询保持 A/B snapshot 及 Code Host 身份；只释放 A、B 保持热态；旧定位失败不预热，重新搜索后精确引用正确；退出 Tray 后两个 MCP/语义快照继续可用，关闭后全部预观测进程无残留。测试只替换了隔离管道的启动接线，未模拟 Roslyn 生命周期；不是当前 Codex 连接验收。
- 同一贯通运行含冷态、双热态、隐藏驻留、只释放 A、退出 Tray 的进程样本。七次隐藏热态样本的工作集合计约 484.2–491.0 MiB，句柄合计 1981–1988，进程数保持 9，无自动启停。所有工作集合计可能重复计算共享页；这是短时、小项目样本，不能外推大型项目、长期泄漏或唯一物理 RAM 回收。
- 核心之后的托盘显示/回复等待修订已通过上述桌面检查。其后仅实例结果显示隔离及验收诊断修订重新 Release 发布，最终本机 Tray 九场景连续通过三次：[1](../test-tmp/tray/run-mKPJrp/report.json)、[2](../test-tmp/tray/run-rdZu4z/report.json)、[3](../test-tmp/tray/run-xohNR5/report.json)。没有将较早 core/desktop 的交付 ID 称为最终 ID，也未重复未受影响的纯 Host/E4/十轮测试。最终 Gateway buildId=5d8c46b2d68c4c0c490633b0bb4fb8ec56787e9105b756917c94652f7997763f；delivery contentId=132e047e7d81a73a26b3b1cc24623ee464fa653f718049f30af1d1873c54fa7d，matched=true。
- 失败及外部参考：管道两次 EOF 失败回执为 [Apop33](../test-tmp/tray/run-Apop33/report.json)、[WMQdEX](../test-tmp/tray/run-WMQdEX/report.json)。先依据 [DisconnectNamedPipe](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-disconnectnamedpipe) 和 [dotnet/runtime Windows 管道实现](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.Pipes/src/System/IO/Pipes/NamedPipeServerStream.Windows.cs)处理未读回复，再由 [InvalidDataException 类型定义](https://learn.microsoft.com/en-us/dotnet/api/system.io.invaliddataexception?view=net-10.0)定位异常过滤遗漏；修正后重复拒绝验收通过。贯通首次 [nHnQyk](../test-tmp/tray-workflow/run-nHnQyk/report.json) 错把至少两个长期 Host 进程作为条件；查询真实进程树、检索 Roslyn 案例后改为定位实际 Code Host 及预观测子树，不把 conhost 或已退出的临时求值进程误记为常驻 BuildHost。watch 测试参考 [Node fs.watch 契约](https://nodejs.org/api/fs.html)和 [Node 测试指南](https://github.com/nodejs/node/blob/main/doc/contributing/writing-tests.md)。布局参考 [WinForms 布局约束](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/layout)。
- 待观察失败：[VcfIp2](../test-tmp/tray/run-VcfIp2/report.json) 在原生验收时超时，未留下 UI 回执，根因尚未证实。参考 [WinForms 异常处理](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.application.setunhandledexceptionmode) 和 [官方实现](https://github.com/dotnet/winforms/blob/main/src/System.Windows.Forms/System/Windows/Forms/Application.cs)，在仅验收模式启用异常直出、输出阶段和退出/超时原因，后续三次未复现；不能将诊断改进称为已修复该偶发超时。
- 当前 Codex 被动 hello 实测为上一轮 0.14.0、buildId 458dc48f…、local-text；codex mcp get 的实际参数只有 dist/index.js，未启用 Roslyn 或 --tray。[实际客户端验收参数预览](../test-tmp/tray-workflow/run-Ho43hD/client-configuration-preview.json) 与 [Roslyn 配置](../test-tmp/tray-workflow/run-Ho43hD/client-roslyn.json) 已准备，仅指向隔离夹具，applied=false。实际消费者启用/重连、Node 22/远端 CI、跨权限/系统/DPI 和长期驻留仍未验证。当前已构建本地增量可评审，未提交/发布。
- 作者反证自审覆盖：连通但观察失效、失效状态下直接进入释放处理函数、拒绝注册耗尽监听、切换选择混入别的实例结果、全部分层测试通过但真实设置/Roslyn未串联、C#改过而旧DLL仍被清单接纳，以及刷新/隐藏期间意外重启。README、CONTRIBUTING、CHANGELOG、既有计划/路线图同步；不把作者自审称作独立审核。
- 收尾校验：最终 delivery 再次 matched=true；git diff --check 通过；本次六份 Markdown（日志只检查新增段落）的 70 个本地链接均存在，UTF-8 与代码围栏通过。最终 settings.png 已目视核对，PID 列和页脚完整、切换实例不显示其他实例的操作结果；仅覆盖本机默认 DPI。
- VcfIp2 证据补充：旧验收脚本有 35 秒兜底终止，但当时未保存退出码/超时标志，回执只记录缺少原生 UI 报告。因此“超时”属于基于旧脚本行为的推测，不能据此认定具体根因；现已补齐这两个诊断字段，后续三次正常退出且未复现。

## 2026-09-10 11:45 — 多项目、多 Agent 并发诊断（北京时间）

- 用户要求测试多个项目或不同软件 Agent 同时调用 MCP 是否混淆、溢出。本轮只增加 [隔离诊断脚本](../scripts/verify-multi-agent.mjs) 和本日志，未修改生产代码、接口、依赖、实际消费者配置、自动释放策略或远端。使用当前 dist/index.js 真实 stdio、已发布 Code Host、项目内 SDK 和两个离线还原的生成项目；同一测试驱动内的三个 SDK Client 各自启动独立 Gateway，分别代表 A、B、另一软件的 A。不是三个实际第三方软件的接入认证。共享实例情景通过同一合法 stdio Client 交错发送两个逻辑 Agent 的调用，不声称 stdio 本身支持多个独立连接。
- [第一轮八场景回执](../test-tmp/multi-agent/run-9uve7M/report.json)全部完成：三个进程并发冷加载、同名方法引用分别为 A=1/B=2；跨实例定位（包括同项目两个实例）返回 SNAPSHOT_STALE 且不改变健康快照；96 次交错精确引用；单进程 128 个并发搜索和其他实例查询；64 个请求中取消 16 个，余下 48 个正确；共享工作区复现；同路径重开复现；关闭一个客户端后另外两个继续工作。预观测进程最终均无残留。此处 success 指诊断场景完成，不代表没有发现缺陷。
- **已复现：共享进程的多调用任务不具备项目隔离。** A 打开 A，另一个逻辑 Agent 打开 B 后，A 只按 Save 搜索成功返回 B.Api.Save(int)，相对目录查询也返回 only-B.txt；没有自动 WORKSPACE_MISMATCH。传旧精确 symbolLocation 则明确 SNAPSHOT_STALE，说明精确定位有保护，普通名称/相对路径没有任务级绑定。ToolRouter.config.workspaceRoot 是实例全局状态，切换锁只保护在途请求与切换，不覆盖完整 Agent 任务。不能把这个结果泛化为独立进程串项目；另一 A 实例保持原快照和查询结果。
- **已复现：同路径 workspace_open 会主动关闭健康 Code Host。** 明确观察旧 Host PID/创建时间退出、hello 的 processAlive=false、下一次搜索获得新 snapshot，另一个实例仍热态。此行为来自 ToolRouter.ts 的同路径显式 resetConnection，原意是恢复入口，但多个 Agent 重复初始化会造成冷启动，与优先连续工作存在矛盾。第二轮该重新搜索约 3.915 秒；这是小项目单次观察，不是性能承诺。
- **负载边界：有限突发成功，但准入队列缺少长度上限。** 第一轮单实例 128 请求时被动 hello 观察 inFlightRequests=129（包括 hello 本身）；请求结束回到只有 hello 的 1。代码中的 acquireRequestSlot 和 Mutex 计数/串行等待没有队列容量限制，仍有单次操作超时。第二轮集中搜索最长约 13.948 秒；不能把单帧上限、32 MiB 单实例缓存预算或超时等同于进程总内存/队列容量上限。本轮没有制造 OOM，也未证明持续洪峰下不会耗尽内存。Roslyn 精确查询不走语义磁盘缓存，本轮 cache entries=0，不能据此声称已验证跨进程共享缓存写入/清理安全。
- 128 请求场景两轮出现 drain MaxListenersExceededWarning。按用户要求先查 [MCP SDK 真实问题 #842](https://github.com/modelcontextprotocol/typescript-sdk/issues/842)、[官方客户端 stdio 实现](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/stdio.ts)和 [Node 流背压规则](https://nodejs.org/api/stream.html)，再增加测试诊断。第二轮 [完整警告堆栈与前八场景](../test-tmp/multi-agent/run-ffxcyO/report.json)确定警告来自本机 @modelcontextprotocol/client 2.0.0 的 StdioClientTransport.send，事件数超过默认 10，场景结束后监听器为 0；三个 Gateway stderr 没有同类警告。外部 issue 场景是服务端批量通知，只作为相似背压机制参考，不能视为本机相同根因的证据。不抬高监听器阈值、不隐藏警告、不声称已证实持续泄漏。
- 第二轮新增 SDK 帧测试曾失败：测试错误地期待超限后同一连接还能读下一条合法消息，实际为 0 条。核对 [官方服务端 stdio.ts](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/stdio.ts) 和本机包后确认超限应报错并关闭传输，是测试假设错误；生产代码未改。修正为明确断言错误、关闭、后续不执行，并只重跑受影响边界，未反复重跑已通过真实 Host 场景。[边界两场景回执](../test-tmp/multi-agent/run-PxHPQo/report.json)通过：按 64 KiB 分块发送 10 MiB + 64 KiB 后 SDK 发出 10485760 字节上限错误并关闭；该测试用已安装真实 transport 和内存流，未向实际 Codex 连接发大包。
- 同一边界回执通过真实原生托盘安全管道的八注册接纳、第九注册明确拒绝、满员后 show 仍可用、断开一个连接后新注册成功。九条注册通道来自一个自有 Node 测试进程并使用各自 UUID，状态是夹具；这验证原生容量及恢复，不等同九个真实 Roslyn MCP 的资源压力，也不将托盘八槽称为 MCP 全局进程上限。测试托盘使用隔离命名空间，最终无预观测残留。
- 补跑既有 [混合负载十轮 / 70 调用](../test-tmp/mixed-load/run-HT12AB/report.json)，5.754 秒通过，覆盖 Router 在途请求、交错切换、取消、命名空间和释放；该脚本有控制门且不启动外部适配器，作为 Router 层补充，不能冒充真实三客户端 Roslyn 测试。
- 验证：新脚本 node --check、git diff --check、delivery:verify 通过；delivery contentId 仍为 132e047e7d81a73a26b3b1cc24623ee464fa653f718049f30af1d1873c54fa7d，matched=true。生产未变，未重复无关核心/桌面全量构建。可复现命令：node scripts/verify-multi-agent.mjs；仅帧/托盘容量为 node scripts/verify-multi-agent.mjs --boundaries-only。
- 建议次序：目前让并发独立项目使用独立 Gateway，任务期间固定工作区，避免每次查询前重复 workspace_open；下一轮先解决同路径重开的幂等与显式恢复语义，再设计请求工作区绑定和有界排队/取消/可观察等待。**USER_DECISION_REQUIRED（后续实现）**：是否改变现有 workspace_open 恢复契约、增加每请求工作区身份或固定实例模式、采用什么超载拒绝/等待规则；本轮不擅自改变这些公共行为。不建议为了省内存直接合并成全局多项目 Host 或引入自动启停。
- 作者反证自审：单次请求全部正确仍可能在两个调用之间串项目；实例隔离仍可能有共享磁盘缓存或共同源文件的竞争；64 个取消测试只保证指定取消与余下查询正确，不涵盖任意 Host 硬故障；10 MiB 帧防护不能限制大量小请求的总队列；警告消失与进程回收也不能证明长时无泄漏。并发源码写入/共享缓存清理、真实软件接入、UIA 多 Agent 操作同一窗口、长期大项目驻留尚未实测，不能给出“任意多 Agent 并发绝对安全”的结论。

## 2026-09-10 11:57 — 回顾并精简下一轮规划，形成并发治理最终推荐（北京时间）

- 用户要求结合 GitHub 优秀案例给出最终推荐，并写入原规划书、删除已经确定实现的部分。本轮仅修改 [详细计划](../WinCode-下一轮工程化迭代计划书.md)、[简版路线图](https://github.com/linnnn89/WinCode/blob/d51f3e105b07b50b1e2535ca541f532ea77b3fc5/WinCode-%E8%BF%AD%E4%BB%A3%E8%B7%AF%E7%BA%BF%E5%9B%BE.md) 和本日志，没有修改生产代码、测试、依赖、实际客户端配置或远端。
- 复核当前 0.14.0 未发布工作树及现有回执：核心 360/360、桌面 35/35、真实托盘/Roslyn 贯通、最近托盘专项、三实例诊断、第二轮失败、修正后边界和混合负载报告。delivery:verify 再次 matched=true，contentId=132e047e7d81a73a26b3b1cc24623ee464fa653f718049f30af1d1873c54fa7d；不是重跑这些代码测试，不把旧回执套到未经验证的新生产修改。
- 从未来待办删除旧 M0–M4 已完成的本机重建、owner guard、UIA 延迟探测、手动释放、托盘/安全 IPC、状态可信度和原生交付绑定步骤；已验证托盘八注册/拒绝/空位恢复也移出开发队列。删除已过期版本建议、相互矛盾的“没有托盘/缺少可逆释放/仍主动启动探测”等基线，以及 M5 中 2/5/10 分钟自动释放设置的旧执行方案。只保留简短基线和历史链接，不删除既有日志与失败回执。
- 最终推荐为独立 Gateway、连接固定项目、健康 Host 保持热态、有界排队。N1 固定根和错误目标零副作用；N2 同根确认与必要恢复分流；N3 有界受理/公平等待/取消收尾/明确过载；N4 真实共享缓存/源码变更和窗口边界验证；N5 实际消费者、原生未定位失败及交付验收。每项列关键模块和可反证验收。
- GitHub 一手参考：[Playwright MCP](https://github.com/microsoft/playwright-mcp/blob/main/README.md#user-profile)明确同项目并发 profile 需额外隔离；[rust-analyzer reload.rs](https://github.com/rust-lang/rust-analyzer/blob/master/crates/rust-analyzer/src/reload.rs)区分相同工作区、构建数据变化和强制重载；[.NET ConcurrencyLimiter](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Threading.RateLimiting/src/System/Threading/RateLimiting/ConcurrencyLimiter.cs)及 [测试](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Threading.RateLimiting/tests/ConcurrencyLimiterTests.cs)提供队列容量/FIFO/取消归还竞态参考；[SDK #842](https://github.com/modelcontextprotocol/typescript-sdk/issues/842)与 [客户端 stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/stdio.ts)用于区分发送积压警告。仅借鉴机制，不声称这些仓库证明了 WinCode 的实现安全；链接为查阅当日 main/master，不宣称固定发布版本。
- 32 个未完成业务请求、4 个状态槽、64 KiB 参数预算仅为明确的实测起点，需合法调用兼容性与资源验证；传输帧、队列、缓存和进程 RSS 分开。固定根不自动解决同项目共享磁盘或同窗口操作；N4 未预判需要新缓存架构，也不预先复制每个实例的持久缓存。默认自动释放关闭及手动释放保持既有用户选择。
- 保留的真实未完成项：当前消费者最新构建/Roslyn 闭环、两种目标软件项目连接兼容性、共享缓存并发清理/编辑、VcfIp2 根因未定位、Node 22/远端 CI、长期/大项目及其他权限/DPI/Explorer 范围。特别修正旧“超时已定位”式措辞：VcfIp2 原始回执只证明缺少 UI 报告，旧超时归因仍为推测。
- USER_DECISION_REQUIRED 为后续实现的固定根迁移、同根重开语义和过载错误/预算这组推荐契约；本次文档更新不代表已经实现或批准真实客户端操作。若目标软件只支持全局单连接但必须多项目切换，应先重新选择每请求工作区身份，不悄加不安全兼容模式。
- 作者反证自审：固定根后选错工具连接仍需客户端尊重错误；同根快捷返回不得绕过恢复门或输入新鲜度；取消逻辑容量降低不等于等待节点释放；独立 PID 不等于共享存储或 UI 隔离；本地交付身份不等于活动客户端已升级。规划按用户要求删除已完成待办，历史只追加不改写。
- 文档收尾：详细计划 148 行、简版路线图 42 行；两计划及本次新增日志的 UTF-8、代码围栏、27 个本地链接、1 个标题锚点通过，旧 M0–M4 实施段落已移除，N1–N5 两文档一致，git diff --check 通过。仅文档修改，未重复运行代码全套测试。

## 2026-09-10 12:00 — 按用户要求快速推送 GitHub 检查点（北京时间）

- 用户明确授权快速推送当前状态。提交范围为当前 0.14.0 的 owner guard、延迟 UIA 探测、手动释放、原生托盘、交付校验、并发诊断及精简后的 N1–N5 规划；发布到 origin/codex/m1-parent-ownership，不改 main，不创建 Release。
- 推送前 git diff --check、delivery:verify matched=true 和测试 inventory（47 个测试文件）通过；复用此前核心 360/360、桌面 35/35 及专项回执，没有为快速检查点重复运行全套测试。源码与锁文件、原生工程和测试源码一并提交；忽略的 dist/bin/obj、.deps、test-tmp 回执、真实客户端配置和凭据不上传。
- 已知限制随检查点保留：共享实例跨项目会影响后续普通查询，同根重开会重置健康 Host，等待队列缺少容量限制；N1–N5 仅为推荐计划，尚未实现。VcfIp2 原生验收失败未定位，实际消费者最新构建/Roslyn 接入、共享存储竞争及长期资源验证未完成。远端 CI 在推送后独立运行，提交本身不表示 CI 已通过。

## 2026-09-10 13:05 — N2 热态保留与 N3 互斥取消基础（北京时间）

- 用户已明确要求按确认的计划继续实施，N1–N3 方向不再待审批。本轮在干净的 bf220a9 / codex/m1-parent-ownership 基线上先交付可独立验证的 N2 和互斥取消基础；N1 固定根需要同步迁移原有跨项目及完整故障注入覆盖，仍为下一开发项。没有修改实际客户端配置、已安装 Skill、依赖或自动释放策略，也未提交/推送本轮修改。
- `ToolRouter.openWorkspace` 健康同根不再无条件 `resetConnection`；Windows 大小写和分隔符别名沿用现有根的拼写，保持 session/watch 身份。持工作区锁后读取 Adapter 已有的类型化 `restartRequired/cleanupFailed`，需要时才执行重置；十个并发恢复确认只重置一次。`reloadRequired` 保留给显式搜索；既有 `workspaceRecovery/restart_gateway` 门禁保持。Configuration/TFM/可执行文件参数在 Adapter 构造时冻结，修改客户端启动配置仍须重建连接，重复打开不热应用配置文件。
- `Mutex` 的 Promise 尾链改为有序可删除等待集合；取消立即删除等待闭包和监听器，存活请求保持 FIFO。已执行的任务在实际操作及异步清理结束后才交还执行权。增加只读 `pendingCount` 供真实等待节点断言；128 个受控等待者中取消 64 个后，在队首仍阻塞时实际节点已降为 64，剩余依序完成并归零。**没有增加 MCP 总受理上限、参数预算或 SERVER_BUSY；本项不等于完成 N3。**
- 针对性测试 [63/63](../test-tmp/n2-targeted.log)；最终核心 [364/364](../test-tmp/check/2026-09-10T04-58-35-445Z-core/report.json)，包含类型、构建、既有原生锁定还原/发布、stdio 与交付检查；E4 [16 场景](../test-tmp/error-contracts/run-RcGwrj/report.json)通过。新增 UI 失败诊断后另跑 typecheck 通过。首次 typecheck 的 `never[]` 断言收窄错误属测试代码的低级类型问题，改用长度断言，没有改变生产行为；失败回执保留在 `test-tmp/check/2026-09-10T04-54-35-495Z-core/report.json`。
- 真实 Roslyn MCP [22 场景回执](../test-tmp/roslyn-gateway/run-uffy9G/report.json)通过：十次同根打开、四个并发确认夹杂引用保留实际 Host/已观测后代 PID、snapshot、watcher/session；真实 SDK 选择输入变化要求 `HOST_RESTART_REQUIRED → workspace_open` 并回收旧 Host；冷加载损坏、热态旧证据拒绝/重载失败、修复后显式搜索，以及真实 MSBuild 取消/崩溃/超时均验证。它运行在源码逻辑相同、工具描述更新前的构建；最终描述/Schema 由后续核心与三实例回执覆盖，不声称旧消费者已经更新。
- 第一次真实 MCP 回执 [run-2WfcZA](../test-tmp/roslyn-gateway/run-2WfcZA/report.json)在第 16 个场景失败：旧测试借同根打开制造冷态，改动后实际为热态输入失效，返回 SNAPSHOT_STALE 而不是预期 PROJECT_LOAD_FAILED。按用户要求先检索并阅读 [Roslyn #54796](https://github.com/dotnet/roslyn/issues/54796)、[rust-analyzer reload.rs](https://github.com/rust-lang/rust-analyzer/blob/master/crates/rust-analyzer/src/reload.rs)，再结合本地 `WorkspaceSession.EnsureFresh/ReloadAsync` 确认层次。上游 SDK 加载案例只是参考，不是本地错误码的来源。修正前置状态并增加冷、热两种严格断言；生命周期故障先证明旧定位失效，再显式搜索进入真实阻塞 target，未把多种错误合并放行，也没有加入自动重放。
- 最终构建的 [三实例十场景](../test-tmp/multi-agent/run-hnl1r7/report.json)完成：独立 A/B/A 冷加载、96 次交错引用、128 次搜索、64 请求取消 16 个、跨实例定位拒绝、单连接退出及帧/托盘边界。相同路径重开缺陷 `observed=false`，Host PID 15772 保留，snapshot 前后均为 `84e8f7c18ad44533963eeecad5b75b43`；观察过的进程最终 survivors=[]。**共享连接跨项目问题仍 `observed=true`，普通搜索仍可返回 B.Api.Save(int)**；success 代表诊断完成，不能解释为多 Agent 风险全部解决。客户端 SDK drain 警告再次出现，堆栈仍在 `@modelcontextprotocol/client/dist/stdio.mjs:205`，阶段结束监听器归零；未提高阈值或隐藏警告。
- 因 Mutex 同时用于 UIA，补跑桌面回归。首次 [34/35](../test-tmp/check/2026-09-10T04-59-31-835Z-desktop/report.json)的完整树/截图场景只留下 `success=false`，旧断言无领域错误码。检索 [FlaUI #394](https://github.com/FlaUI/FlaUI/issues/394)、[FlaUI AutomationElement](https://github.com/FlaUI/FlaUI/blob/main/src/FlaUI.Core/AutomationElements/AutomationElement.cs) 和 [微软 UIA 等待接口](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationwindowpattern-waitforinputidle) 后，先在测试断言中补 requestId/errorCode/errorMessage/captureMethod，不改生产时序或超时。单套件 [13/13](../test-tmp/n2-desktop-diagnostic.log)未再现。首次失败缺少底层信息，窗口就绪、捕获环境、Mutex 均不能确定为根因；此项与旧 VcfIp2 失败分别保留在 N5。
- 最终本地交付 matched=true，contentId=`9de57af9a81d9966457b0eb8e1a1320d75d04fe76fd8ca3a79ee5504674a8834`；Gateway buildId=`0987e341f543efdd78305937878d722a85cada178ff11e9156cc578f984a7d78`，Schema hash=`e1f7a396188e3bd4ba905935d2e896465a38526b219e54d9047b79bdd85d4411`。对应 revision 是基线 bf220a9，未提交增量由 source/artifact hash 区分。同步更新工具描述、仓库 Skill 诊断源文件、CHANGELOG、原规划和路线图；删除已完成 N2 待办，保留 N1、完整 N3、N4、N5 及新旧未定位失败。
- 作者反证自审：保温不能掩盖 SDK/输入失效，已用真实 SDK 变更与冷热损坏反例验证；取消早返回不能允许新任务进入尚未清理的 Host，单测与真实 UIA/Roslyn 取消分别覆盖。短时小项目及 SDK 模拟不证明长期无泄漏、真实多软件接入、共享缓存/窗口完全隔离；互斥节点可删除不证明业务队列有界。自动释放继续关闭，设置内手动释放行为保留。没有独立模型/人工审查，本轮不把作者自审当独立审核。
- 13:10 补充桌面收尾：第二次完整桌面运行 [35/35 和 owner-death 通过](../test-tmp/check/2026-09-10T05-02-26-806Z-desktop/report.json)，但托盘 [xaa7Wf](../test-tmp/tray/run-xaa7Wf/report.json)确认 35 秒保护超时、退出码为空、最后在隐藏/唤出阶段；不能外推旧 VcfIp2 同因。先查 [微软 WinForms 线程安全调用](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-make-thread-safe-calls) 与 [dotnet/winforms #4631](https://github.com/dotnet/winforms/issues/4631)，再只在隔离 `TrayAcceptance` 加毫秒/线程和 Hide、延迟、ShowExisting 工作线程/确认、VisibleChanged、报告写入的阶段日志，未改线上行为或增加超时。两次专项 [ZvxMdQ](../test-tmp/tray/run-ZvxMdQ/report.json)、[XVjI4K](../test-tmp/tray/run-XVjI4K/report.json)通过；第三次随最终完整桌面运行的 [sTDf8v](../test-tmp/tray/run-sTDf8v/report.json)通过。三次未再现仍不构成根因修复，N5 保留。
- 最终完整 [desktop 检查](../test-tmp/check/2026-09-10T05-07-25-412Z-desktop/report.json) success=true：35/35、owner-death、托盘及真实托盘/Roslyn 工作流全部通过。[工作流四场景](../test-tmp/tray-workflow/run-3jNah3/report.json)包括忙碌释放拒绝、七次间隔热态观察、仅释放 A 后显式查询恢复/B 保持热态，以及退出托盘两个 MCP 继续查询，最终 survivors=[]。托盘诊断源码按标准流程重新发布后，最终 delivery contentId 更新为 `1b5a924800a412c6fd2fffa82663b43c46d29095c1e703d4678ade473a9baeb4`，matched=true；Gateway buildId/Schema 未再变化。UTF-8、本轮文档本地链接和 git diff --check 通过。工作树保持本地可审阅修改，N1/完整 N3 的既有缺口及桌面未定位失败不作为本轮已解决事项。

## 2026-09-10 13:47 — 潜在实际运行缺陷验收（北京时间）

- 用户要求查验既有测试未检测到的实际运行漏洞并给出建议。本轮只读审查生产实现，使用 `test-tmp/runtime-audit/` 下被 Git 忽略的隔离脚本和夹具；保留 `codex/m1-parent-ownership`、基线 `bf220a9` 上原有未提交增量。没有修改生产代码、已有测试、规划书、实际客户端配置或依赖，没有发布或推送。以下 `observed=true` 表示缺陷被复现，不是产品验收通过。
- **P1：缓存成功返回旧代码。** [已有提交的 Git 仓库回执](../test-tmp/runtime-audit/git-uj1Ucy/report.json)中，新建但未暂存的 `src/Target.cs` 从 Gone/OLD_VALUE 改为 PresentNow/NEW_VALUE_WITH_MORE_CHARACTERS；变更前后 `git status` 都为 `?? src/`，显式 watcher 失效通知和 fresh 指纹计算后指纹仍相同，公开 MCP prepare_context 返回旧全文、find_code_symbol 返回已消失的 Gone，且 queryComplete=true、truncated=false。仅暂存夹具文件后，对照查询返回新全文、Gone 数量归零、fromCache=false。另一个 [深层非 Git 文件场景](../test-tmp/runtime-audit/run-jIeKUX/report.json)同样复现旧全文；目录指纹的深度 3/文件数 100 上限未覆盖实际选中文件。当前证据覆盖 local-text 和内置上下文打包，不宣称复现 Roslyn 语义快照失效。根因位置：WorkspaceFingerprint.ts 的 Git 状态目录粒度、前 100 项统计与有界目录扫描；LocalTextAdapter/RepomixAdapter 信任此指纹的缓存命中。建议对实际输入建立依赖/内容身份，利用已读取的有限文件内容校验，watcher 只作加速失效信号；不要每请求全仓哈希，也不要把要求用户 git add 当成修复。
- **P2：共享磁盘缓存清理后返回悬空附件。** [两进程回执](../test-tmp/runtime-audit/run-jIeKUX/report.json)使用两个真实 Node 进程、当前 CacheManager/RepomixAdapter 和同一缓存目录。为确定性触发淘汰，把合法阈值缩为 maxDiskEntries=1、maxEntryBytes=8192；A 打包产生全文附件，B 淘汰磁盘条目和附件，A 的内存命中仍返回 fromCache=true、contentOmitted=true，但 overflowPath 已不存在。未模拟文件系统或修改 TTL。确认的是缺失上下文附件，不是源文件丢失或跨项目污染。建议命中时校验附件存在性/身份，缺失则失效重建，并明确多进程清理所有权；原子写入不能单独解决附件生命周期。
- **P2：取消同根确认误入恢复并重启健康 Roslyn。** 同一回执在实际同根元数据读取完成、Router 的 await 后取消检查前设置可控取消窗口，使用真实已发布 Roslyn Host。未改变根目录或源码，却出现 recovery-required（roslynLoaded=true）、业务请求被阻止；按提示重新打开后变冷，下一查询 Host PID 从 18476 变为 6384，snapshot 也变化。触发来自 rootPrepared=true 后统一进入恢复分支。建议区分无状态变更的同根确认与真实重绑定/清理失败，保留后者的强制恢复保护。此前正常同根保温测试通过仍成立，但 N2 的取消边界验收未通过，应重新列入后续修复范围。本轮是可控 AbortSignal 窗口，不称为真实第三方客户端手势复现。
- **P2：同根确认等待慢请求，连被动状态也阻塞。** [默认超时回执](../test-tmp/runtime-audit/drain-JdeB0m/report.json)通过真实 MCP 处理器及受控慢查询，保持默认 shutdownMs=8000。同根打开在约 8010.7ms 后 TOOL_EXECUTION_FAILED；期间 hello 也等待约 8011.4ms 才成功。放行原查询后查询正常、工作区健康。根因是判断 sameWorkspace 前先设置切换屏障并等待 drain，状态请求也经过屏障。建议尽早分类同根确认，并让被动状态保持有界响应；真正切换/释放仍需排空，不能只增加超时。这是确定性模拟慢业务耗时，不是实测大型项目冷加载耗时。
- 发现非低级逻辑失败后按用户要求查阅真实上游资料：[Git status 官方行为](https://git-scm.com/docs/git-status.html)、[VS Code 文件监听限制](https://github.com/microsoft/vscode/wiki/File-Watcher-Issues)、[VS Code 监听实现说明](https://github.com/microsoft/vscode/wiki/File-Watcher-Internals)、[npm cacache 内容读取实现](https://github.com/npm/cacache/blob/main/lib/content/read.js)。资料支持目录枚举/监听局限和读取缓存实体时校验的设计参考，本地缺陷结论来自本轮回执；未引入这些项目的依赖。
- 验收判断：新确认四类缺陷、五个触发场景；证据正确性与异常时工作连续性尚不满足稳定多 Agent 使用标准。优先修复旧代码缓存，并与已有 N1 任务级项目绑定一起作为正确性门槛；随后处理同根取消/状态阻塞、缓存附件生命周期和完整 N3 准入预算。将本轮反例转为正式回归后，再进行真实消费者及长期驻留验证。既有共享连接跨项目问题、无准入容量上限、未定位的 WPF/托盘偶发失败仍未解决，不重复计为本轮新增发现。
- 限制：本轮没有重复未修改生产代码的完整 364 核心/35 桌面套件；这些数字属于上一轮基线。本轮隔离探针使用真实文件系统、真实缓存进程、真实 Roslyn Host，但部分竞态采用确定性调度、缓存阈值缩小；不能估计生产发生率，不能证明长期无泄漏/OOM，也不是跨权限安全渗透或三个真实软件客户端接入认证。脚本入口为 [主探针](../test-tmp/runtime-audit/probe.mjs)、[Git 输入探针](../test-tmp/runtime-audit/git-input-probe.mjs)、[状态延迟探针](../test-tmp/runtime-audit/confirmation-latency.mjs)。本次为作者反证审查，不是独立模型或人工审核；未实施修复，不静默改写之前的成功记录。


## 2026-09-10 14:01 — 验收缺陷修复与 PR 交付准备（北京时间）

- 用户明确授权继续修复，完成后推送 PR 并合并。本轮收敛为验收新增四类缺陷，保留上一轮未提交的 N2/Mutex/诊断增量；未实施 N1 固定项目和完整 N3 准入限制，也未修改实际消费者配置、安装依赖或开启自动释放。拉取发现 origin/main 已通过 #34 合并同内容基线，确认树与 bf220a9 无差异后，在 origin/main dda0203 创建 codex/runtime-cache-continuity，避免重复引入已合并基线。
- 文本检索每次沿用现有 8 MiB/5000 项等扫描预算枚举并读取输入，避免新建/删除文件和监听遗漏被结果缓存隐藏；声明解析以实际内容 SHA-256 复用，使用 CacheManager 既有 LRU/条目与字节预算，仅存解析结果，不新增独立内存池或持久 AST。简单文本引用直接扫描。旧有界 WorkspaceFingerprint 保留作为变更提示，不能再决定这些源码结果是否有效。
- 内置打包读取实际选中文件后，以有顺序的路径/内容元组计算身份，再复用相同内容的打包/附件；不额外执行一次全仓内容哈希。没有可核验输入清单的 CLI 打包不复用旧结果；显式禁用 CLI 和取消隔离继续生效。缓存读取检查 overflow 实体，peer prune 后内存/磁盘命中均降为未命中重建。本轮未建立跨调用附件租约，不承诺返回的临时文件永久存在或跨文件编辑具有原子快照。
- 健康同根确认在切换屏障之前执行，保留会话、Host 和新鲜度提示；不重复改写相同根的 trash/config，取消确认不进入部分重绑定恢复。已知重启/清理失败、真实 A→B 切换继续使用排空和恢复路径；没有无限放行真正切换期间的状态请求，完整状态准入仍属 N3。
- 新增 [正式回归](../tests/runtime-cache-regressions.test.ts) 8/8，通过公开 MCP 的未跟踪目录/深层文件/超过提示预算、同长度且还原 mtime 的修改、新建删除文件、引用失效、内存预算、缺失附件的内存/磁盘重建、真实双进程淘汰，以及取消/慢查询交错。实际双进程使用 [既有工具链夹具](../tests/fixtures/cache-peer.mjs)，缓存阈值缩小但文件系统/进程均真实。已加入 package.json 的核心 inventory；原有相关测试 87/87。新夹具 windowsHide 在 Node ForkOptions 类型中不受支持，移除该多余属性（子进程 stdio 为管道），属于低级类型错误；之后完整 typecheck 通过。
- [完整核心 372/372](../test-tmp/check/2026-09-10T05-56-37-721Z-core/report.json)通过类型、构建、原生锁定构建、stdio 与交付。E4 [16 场景](../test-tmp/error-contracts/run-mgJSec/report.json)通过；[完整桌面](../test-tmp/check/2026-09-10T05-57-42-090Z-desktop/report.json) 35/35、owner-death、托盘和贯通检查通过。[实际托盘/Roslyn 贯通](../test-tmp/tray-workflow/run-bImEg6/report.json)包含忙碌拒绝、七次间隔保温、仅释放 A、退出托盘不影响 MCP，最终无观察到的残留。这次通过不宣称已定位历史 WPF/托盘偶发失败。
- 修复前后使用同一隔离审查探针：[修复后主回执](../test-tmp/runtime-audit/run-5F2F0c/report.json)中深层旧代码、双进程悬空附件、取消导致健康 Host 重启均 observed=false；真实 Host PID 19200 和 snapshot 79046bfdeee342e99a784779daf617aa 均保留、业务可用。[Git 对照](../test-tmp/runtime-audit/git-p1dvGU/report.json)仍有相同旧提示指纹和 ?? src/，但已返回新源码、Gone 符号消失，证明没有依赖改提示算法或要求用户暂存。报告 observed=false 本身不是通用无缺陷证明，正式断言见新增回归。
- 真实 Roslyn 专项首次 [nWBtRL](../test-tmp/roslyn-gateway/run-nWBtRL/report.json)在第 19 个场景报 Owned process survived: 11848。按要求先查 [MCP 取消规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)、[Process.Kill 文档](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill?view=net-10.0)及 [dotnet/runtime #107992](https://github.com/dotnet/runtime/issues/107992)，再检查客户端取消与真实 Gateway 收尾。定位到旧测试把同根打开当作 drain 屏障，与本轮只读确认语义冲突；现场稍后 PID 已不存在。改为在原有 8 秒预算内观察 Gateway inFlightRequests 回到只有 hello 的 1，再严格核对所有已记录进程退出，未延长预算、主动杀进程帮助断言或放宽退出条件。该调整只在验收脚本，生产清理代码未改。
- 作者反证自审：相同文件长度/mtime、监听遗漏、新增文件、磁盘条目尚存但正文附件缺失，以及取消客户端先结束而服务端仍在收尾。保留真实修改后的输入失效/SDK 重启/清理失败恢复测试；不因同根保温跳过实际故障。规划仅移除已取得证据的完成项，N1、完整 N3、N4 其他存储/UI/源码竞争、N5 真实消费者和长期样本仍保留。

- 14:02 收尾：调整观察方式后的 [真实 Roslyn 22 场景](../test-tmp/roslyn-gateway/run-wNNpAi/report.json)全部通过，包括主动 MSBuild 取消/崩溃/超时及进程退出。最终本地 delivery matched=true，contentId=ace3a662543d5c6df01bda9f23bea28199031c420f976e6a5f4fdb39d3ba19fb；Gateway buildId=717352bcd195475eed76cab88e7c1f96701c8fbaaab8e105a1d34dcccdc34b75。该本地构建在切换等内容基线前产生，revision 元数据为 bf220a9；不把它冒充最终 PR 提交构建，远端 CI 将核验具体提交。git diff --check 通过；推送/合并状态以随后 GitHub 回执为准。


## 2026-09-10 14:10 — 全项目 Markdown 同步（北京时间）

- 用户在 PR #35 等待 CI 时要求同步更新本项目各个 md。核对 Git 管理的 14 份 Markdown，按相关范围更新 README 中英说明、架构和时序图、配置/Skill 指南、四份受管 Skill 文档、贡献与安全说明、UIA Host README、CHANGELOG、规划/路线图及本日志。没有同步已安装手册、修改实际客户端配置或连接。
- 纠正旧 0.13.1 架构/指南/Host 当前版本标题；安全策略保留既有维护承诺，补充 main 的 0.14.0 开发线。源码版本、磁盘产物和运行实例继续分别核验，不把本次 PR 合并写成已发布版本。补充独立托盘/Helper 所有权与手动释放边界，自动释放仍关闭。
- 统一缓存文案：namespace 不等于跨进程物理隔离；有界 fingerprint 不是源码身份；声明按内容复用、内置打包按实际候选内容复用、CLI 无输入清单不缓存、附件失效可重建但没有永久租约。纠正“监听一定及时失效”和“已有生产缓存等于 UI 证据跨调用有效”的过度表述。
- 同根健康确认不排空、不重启、取消不制造恢复状态；真实重绑定/已知故障仍需恢复。N1、完整 N3、N4 剩余交错/UI/源码边界及 N5 消费者/长期验证继续保留。此前 364/360 等历史结果不改写，当前基线明确为核心 372/372、桌面 35/35、真实 Roslyn 22/E4 16。
- 四份受管 Skill 文档属于交付输入，本轮会重跑完整核心检查并重建交付清单；不因只改 Markdown 便沿用旧清单冒充匹配。旧 CI 结果只属于 bcd2fe5，文档提交后的合并等待对应新提交检查。


## 2026-09-10 14:47 — Node 22 远端进程归属误判修复（北京时间）

- PR #35 首个提交 bcd2fe5 的 [CI 34443549607](https://github.com/linnnn89/WinCode/actions/runs/34443549607)中，Node 24 与全部 CodeQL 通过，Node 22 核心/E4/独立 Roslyn Host 58 场景通过，但 Roslyn Gateway 的 timeout 退出断言失败。随后 owner-death、Repomix owner-death、manual-release 因脚本立即退出而没有执行，不能把这些项目写成该轮已通过。
- 下载有界回执后定位：所谓残留 PID 752 是 csrss.exe，创建于 05:59:48；其 ParentProcessId=744，而真正测试中 PID 744 是 06:08:39 才创建的 conhost.exe。旧 ownedProcesses 只用 ParentProcessId 展开，沿这条错误边把 138 个进程纳入 Code Host 子树。此证据支持验收观察器 PID 复用误判，不支持 Roslyn 清理失败；不能通过无限重跑隐藏。
- 按用户要求先查 [Win32_Process 官方 ParentProcessId/CreationDate 说明](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)及 [MicrosoftDocs 原文](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/CIMWin32Prov/win32-process.md)。修复 scripts/lib/owned-processes.mjs：同一 CIM 快照中按父子创建时间校验每条边，缺少相关创建身份时报错，不能悄悄省略未知后代。重放远端回执，138 项缩为实际 7 项，保留 dotnet Code Host、BuildHost、cmd、blocker node 及对应 conhost；没有增加清理宽限或修改产品清理代码。
- 新增确定性 PID 复用/缺少创建身份回归，专项现为 9/9。修改受管文档后的 [核心 372/372](../test-tmp/check/2026-09-10T06-10-43-228Z-core/report.json)通过；加上 PID 回归后的最终 [完整核心 373/373](../test-tmp/check/2026-09-10T06-14-00-192Z-core/report.json)通过类型、构建、原生交付、stdio 和清单校验。修正观察器后的 [真实 Roslyn Gateway 22 场景](../test-tmp/roslyn-gateway/run-qoTd5O/report.json)通过。新增规则依旧严格断言真实子进程退出，不把只读过滤回放当成新的清理证据。
- 全项目 14 份 Markdown 已核对，93 个本地链接、UTF-8、代码围栏通过（历史工作日志只核对新增段，不静默改写旧失败）。文档检查初次因 Git 对中文文件名引用导致路径解析失败，改用 git ls-files -z 取得真实文件名后通过，属于检查脚本路径处理错误。
- 用户补充确认：修复观察器之后，必须在最新提交上完整运行 Node 22 专项链，若真实 Code Host/BuildHost/cmd/blocker 仍存活才继续查产品生命周期。在该链与全部必需检查通过前，PR #35 保持未合并；不沿用 bcd2fe5 的部分 CI 结果。

## 2026-09-10 17:00 — 架构审查第 1–2 批修复（北京时间）

- 用户要求“按照你的设计开始进行迭代or修复”。在已合并 #35 的 main `7d53fdac3017560dbecb138eee0f8bb6f6361af3` 上建立 `codex/architecture-boundaries`，先落实执行/磁盘边界和默认读取可用性。此前 #35 最终提交 `5d1ae37` 的 Node 22/24/CodeQL 已通过并合并，属于历史基线；本轮本地修改尚未提交、推送或应用到实际消费者。
- A1/B1/B2：新增 `GitClient`，从启动时工作区外安装候选解析真实绝对路径，使用 execFile/argv，禁用 shell、可执行 fsmonitor 和可重定向 Git 工作目录的环境变量。要求 Git 2.36+；旧版把 false 当 hook 路径的行为依据 [Git 官方配置文档](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsmonitor)，不自动安装或升级。状态由 Git 自身查询，支持 linked worktree；查询不可用/失败为 unknown，缺少 isClean，不把异常报告为干净。生成仓库的 git.cmd 反例和真实 worktree/损坏配置回归通过；fsmonitor 先用直接 Git 阳性对照确认会生成标记，再确认 Workspace/Fingerprint 两条生产路径都不生成标记。
- A2/A3：新增共用 `FileSystemBoundary`。Cache 初始化、写入、维护和 Repomix overflow 都拒绝 cacheDir/祖先中的链接或 junction，并校验已打开目录的 dev/ino 身份；trash 目标实际位置必须在工作区内，在 mkdir、rename 和 metadata 前复查。JSON 文件名及格式头采用 wincode-v1 所有权标记；清理只处理本版本可识别条目和保留命名的 overflow。旧版/无法识别的 JSON、临时文件及无关文本保留，不计入受管配额，不做迁移。保留移动后元数据失败的 partial、实际位置与既有恢复门。
- A5/A8：旧 identifyProject 归并到有界 ProjectDiscovery；架构目录树和图入口枚举共用 WorkspaceBrowser。项目描述符检查词法/实际根边界；不另读 .sln 外部引用，不求值 MSBuild。发现最多 2000 项、树最多 500 项；图最多 16 个项目文件、单文件 64 KiB、合计 256 KiB，入口枚举合计最多 2000 项。maxDepth 限整数 1–5，整份格式化 JSON 上限 32768 UTF-16 字符，返回 scanComplete/omissions/outputOmissions。Router、Context、结构扫描与目录浏览传递实际取消/deadline；取消后在底层读取返回和句柄关闭前继续持有活动请求资格。
- A4：TextDeclarations 折叠屏蔽后的空白，移除 C# 重叠可选空白匹配；规范化单行超过 16384 字符返回词法不确定/不完整。独立 Node 子进程受外部 5 秒截止约束，并通过真实 MCP 查询与心跳，避免用主线程计时器证明主线程未阻塞。原 2084 字符反例不再超时；最终全量负载中，2048 空格解析约 1.05 ms，65536 空格约 12.56 ms，20 ms 心跳在约 23.86 ms 响应。这是合成输入的实测，不是普遍性能保证。
- 正式新增 [12 项边界回归](../tests/architecture-safety.test.ts)和[独立声明探针](../tests/fixtures/declaration-budget-probe.mjs)，纳入 package.json 的完整 inventory。最初 6 个缺陷场景在修复前均失败；第一批与既有相关测试 67/67 通过。首次完整检查 [382/384](../test-tmp/check/2026-09-10T08-48-35-105Z-core/report.json)保留两项失败：旧“非 Git”夹具实际位于 Git 仓库内；旧 overflow 夹具把任意 txt 当受管附件。依 [rev-parse 官方行为](https://git-scm.com/docs/git-rev-parse)改为真正独立的非 Git 目录；附件改由生产 writeOverflow 创建。未放宽非 Git、过期删除、容量驱逐或内存引用保护断言。
- fsmonitor 阳性夹具首次未生成标记，保留 [失败回执](../test-tmp/architecture-boundaries-recheck.log)。对照 [Git 实现](https://github.com/git/git/blob/master/fsmonitor.c)的 shell 调用以及本地 stderr，确认带空格的 hook 配置未引用，实际尝试启动 D:/CODEX；修正生成夹具的命令引用后，[25/25 相关复测](../test-tmp/architecture-boundaries-recheck-final.log)通过。没有更改真实仓库/全局 Git 配置。
- 作者反证自审发现“紧凑 JSON 已符合预算，格式化 MCP 文本仍超限”：137 个生成项目声明返回 32847 字符，见[修前失败](../test-tmp/architecture-output-budget-before.log)。按实际格式化序列化计数后为 32238，见[修后回执](../test-tmp/architecture-output-budget-after.log)，新增端到端预算回归。不用仅检查内部对象大小代替客户端实际响应。
- 最终 [npm run check](../test-tmp/check/2026-09-10T08-58-28-915Z-core/report.json)通过：Windows x64 / Node 24.19.0，**385/385，0 fail、0 skip**；包含类型检查、Gateway 构建、既有原生组件锁定还原/发布、完整回归、新 stdio 实例、交付清单核验。[E4 16 场景](../test-tmp/error-contracts/run-WnFBU1/report.json)通过，包括真实 partial trash 及恢复行为。最终 buildId=`ce1d898b90951d0419797ab316dfe7172527d939b49c9638b7d7a80935452352`，Schema=`304d4030ad9e3ba8ad55159273a7b9b892bd8f6366980d3b2f9ce2d75a0fe2a9`，delivery contentId=`ddbb283087dcb1e69f632eae7e9cc8db9263b231565a8cf2bb45ec3f87c54d78`、matched=true。revision 仍是基线，未提交增量由 sourceHash/artifactHash 标识。
- 同步 README 中英双语、CHANGELOG、架构说明、计划/路线图及仓库 Skill 源文件；本机安装副本和真实 MCP 连接未更新。剩余 N1 固定项目、完整 N3 准入、A9 生产清理身份、N4/N5 实际消费者/交错/长期样本继续保留。静态链接与目录身份复查不构成对抗并发替换的原子沙盒；合作取消不保证强制中断永久挂起的 OS I/O；overflow 返回后没有永久租约。自动释放仍关闭，默认 local-text 与显式 Roslyn 求值授权不变。
- 17:03 补充验证：[真实 Roslyn MCP 22 场景](../test-tmp/roslyn-gateway/run-NDrihh/report.json)全部通过，包括 Host 热态/精确身份、实际 MSBuild 取消/崩溃/超时后的已观测 Host/BuildHost/后代清理及恢复、最终 Gateway 退出。只生成/求值 test-tmp C# 夹具并使用既有 SDK；不是当前 Codex 连接或干净机器验收。其后 `delivery:verify` 仍 matched=true、contentId 不变；本轮未改原生/UIA/托盘生产代码，未重复桌面验收，历史未定位桌面失败继续保留。当前代码、预算、Schema 与手册经作者自审，未进行独立模型或人工审核。

- 用户随后明确要求先提交目前版本并合并。发布范围为本轮第 1–2 批修复和对应测试/文档；发布前交付清单再次 matched=true，远端 main 仍为 7d53fda。沿用相同生产源码的 385/385、真实 Roslyn 22 和 E4 16 回执；新提交的必需 CI 完成后才合并，真实消费者配置不在本次发布范围内。

## 2026-09-10 19:04 — 下一轮第一批：失败证据、清理身份与客户端预检（北京时间）

- 用户要求“按照你的规划开始工作”。核对 I:/WinCode 初始为干净 main `fb3cd48df3f38b209565b906fbfe3485df48461d`（#36），建立 `codex/runtime-baseline-and-cleanup`。先实现失败证据保留与 A9，真实客户端项目配置验证前置到 N1；保持现有公共切换行为，固定根、完整准入及后续竞争验证尚未实施。本轮未提交、推送、安装依赖或改变实际客户端配置。
- CI 证据：从 `scripts/check.mjs` 抽出小型 `scripts/lib/check-stage.mjs`，在抛出失败前写入阶段退出码/信号、TAP 总数、日志路径与采集完整性；用 [Node 官方多报告器](https://nodejs.org/docs/latest-v24.x/api/test.html#multiple-reporters)同时输出 TAP 与原生 JUnit。CI 的 always 上传保留报告、阶段日志与 XML 七天。维持原有 8 MiB 捕获预算，ENOBUFS、启动失败及超时明确标为采集不完整；缺少完整 TAP 汇总即使退出码为零也失败。JUnit 文件存在不等于该运行完成。
- [四项日志回归](../tests/check-reporting.test.ts)调用真实 Node 测试子进程，覆盖早期失败被大量后续输出挤出旧尾部摘要、JUnit 转义/断言、成功汇总、零退出但缺汇总，以及输出溢出/启动失败。失败测试夹具的 62 项中 60 通过、1 失败、1 跳过，是有意构造的报告验证数据，不是产品回归结果。
- A9：`ResourceManager.disposeOnce` 在实际调用清理函数的微任务内重查注册归属；等待前一清理期间或进入微任务前已经注销的资源不再执行，也不生成虚假的 closed 记录。`killProcessTree` 在入口及异步终止后的检查点优先使用 ChildProcess 的 exitCode/signalCode，不再探测已知退出对象留存的数字 PID；自然退出移除 exit/close 两个归属监听器。保留现有进程树清理、实际退出验证与总时间预算。
- [四项身份回归](../tests/resource-identity.test.ts)在生产修改前均失败，见[修前日志](../test-tmp/baseline-cleanup/resource-identity-before.log)，修后全部通过，见[修后日志](../test-tmp/baseline-cleanup/resource-identity-after.log)。PID 复用反例拦截了 OS 动作，未对真实复用 PID 执行信号。与既有生命周期回归合并[22/22 通过](../test-tmp/baseline-cleanup/targeted.log)，其中真实已拥有子进程退出覆盖仍保持。未增加 Windows 原子进程句柄身份校验，不能把此修复说成消除了全部 processExists/taskkill 之间的 PID 竞争。
- [完整核心检查](../test-tmp/check/2026-09-10T10-52-38-371Z-core/report.json)通过：Windows x64、Node 24.19.0、.NET SDK 10.0.303；共 **393 项，392 pass、0 fail、1 skip、0 cancelled**。跳过项为未提供固定工作区的可选 TavernDesk 集成，未自动访问个人项目或数据库。类型、锁定构建、全量回归、新 stdio 实例和交付清单均通过；不是正在使用的 Codex 连接验收。
- [真实 Roslyn Gateway 22 场景](../test-tmp/roslyn-gateway/run-5FREl5/report.json)、[E4 错误契约 16 场景](../test-tmp/error-contracts/run-D1fPmY/report.json)通过。涉及实际 MSBuild 取消/崩溃/超时后的已观测进程清理及恢复，均使用生成夹具与既有工具链。
- [桌面完整检查失败](../test-tmp/check/2026-09-10T10-55-28-895Z-desktop/report.json)：35 项中 34 通过、1 失败；新 [TAP 日志](../test-tmp/check/2026-09-10T10-55-28-895Z-desktop/desktop-tests.log)及 [JUnit](../test-tmp/check/2026-09-10T10-55-28-895Z-desktop/desktop-tests.xml)保留 `FlaUiAdapter` 第 4 项的 `HOST_ERROR: Recording indicator could not be displayed; UI access refused.`。原生 `RecordingIndicator.cs` 未修改；失败发生在提示窗确认阶段，不能据此断言是截图、WPF 就绪或 Mutex 问题。
- 对该非平凡失败查阅 [Microsoft UpdateWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-updatewindow)、[WM_PAINT](https://learn.microsoft.com/en-us/windows/win32/gdi/wm-paint)及其链接的 [Windows Classic Samples 源码](https://github.com/microsoft/Windows-classic-samples/blob/18cbd05ee44455cd7552804dcf2c9d6db619b412/Samples/Win7Samples/begin/LearnWin32/HelloWorld/cpp/main.cpp)。UpdateWindow 是否发送绘制消息取决于更新区域，资料只能说明要观察绘制/消息循环，不能证明本次失败原因。增加仅在 test-tmp 的原生 stderr 采集预载器后[单套件 13/13](../test-tmp/baseline-cleanup/flaui-native-diagnostic.log)通过，[原生进程记录](../test-tmp/baseline-cleanup/uia-native-stderr.log)无该异常；保留首次失败，不加 sleep、不增加总超时、不放宽断言。根因仍未定位，也未认定与历史桌面失败同因。
- 首次 check:desktop 在失败后未进入后续阶段；随后分别运行[真实 UIA owner-death](../test-tmp/owner-death/run-zFyy30/report.json)、[原生托盘](../test-tmp/tray/run-7T1I4d/report.json)、[真实 Tray/Roslyn 工作流](../test-tmp/tray-workflow/run-WXEXn1/report.json)，均通过。owner-death 的已观测 Helper 子树无存活者且目标夹具仍活着，验收后另行关闭夹具；工作流覆盖两实例、七次间隔观察中的热态保留、忙时拒绝、定向释放/恢复和托盘退出。这些专项不能覆盖掉完整桌面检查的失败，短样本不能证明长期无泄漏。
- 当前磁盘 buildId=`3faff18fa1baf36b130867a1a466837d41314372ea389ea647d8309eaffb60c9`、Schema=`304d4030ad9e3ba8ad55159273a7b9b892bd8f6366980d3b2f9ce2d75a0fe2a9`、delivery contentId=`938bb0acd84d4b65ed1489d3eea806236bf80182cd9c97eab89e741964dc1df4`。文档收尾后再次 `delivery:verify` matched=true。revision 元数据是 fb3cd48，未提交源码增量由 sourceHash/artifactHash 标识，不能把它称为该提交的纯净构建。
- 19:00 前置客户端核验：[预检回执](../test-tmp/baseline-cleanup/client-configuration-preflight.json)记录当前真实 hello 为 **0.13.2**、instance=`2b4f5ded-525e-45bf-a84d-0bf041132345`、buildId=`b3b4024ac8f367e429cc32b7951a16b2d4cec4716a95402911091c154863cc5d`、schema=`ede768d54559a7d33b582ee13fcdb7a29173597eddad10ceceb24fcc940fc84e`、provider=roslyn、根为 `I:/WinCode/test-tmp/client-roslyn-20260909/workspace`。安全读取实际 Codex MCP 配置确认它启动仓库 dist、绑定该旧夹具；未改全局配置或重连。
- Codex CLI 对两个隔离目录的 `.codex/config.toml` 实际解析通过：同名 `wincode_project_preflight` 分别使用 A/B 绝对根，仓库根下查询不存在；未运行模型任务或产生新用户任务。配置样本保存在预检回执同目录，仅作用于两个生成目录。[Codex 官方文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)与[配置优先级](https://learn.chatgpt.com/docs/config-file/config-basic)支持受信任项目配置；[Claude Code 文档](https://code.claude.com/docs/en/mcp)说明项目 `.mcp.json` 及 Desktop Code tab 同名用户级 stdio 优先级例外。CLI 解析通过不等于真实桌面或第二种软件接入通过。
- `USER_DECISION_REQUIRED`：第二种实际客户端已集中询问 Claude Code / Antigravity / Grok，等待选择；当前 PATH 未找到 Claude CLI，不据此推断整个机器未安装。真实客户端配置变更/重连与必要安装仍需对应授权。固定根改造需先完成这一兼容性前提；N3 完整容量、N4 其余竞争及 N5 长期/大项目证据仍保留。
- GitHub 连接器读取当前 CI 时被服务端 HTTP 403 阻断，未改走其他鉴权路线或重复尝试；#36 最新 CI 及 Node 22 本轮验证均未核实。不把本地通过写成已修复聊天中未取得完整日志的远端失败。更新现有 CONTRIBUTING、CHANGELOG、详细计划和路线图，不修改旧工作日志，也未同步四份受管 Skill 或已安装手册。
- 作者反证自审保留两类“看似通过”的风险：晚些出现的大量成功输出掩盖早期失败；资源已注销但旧清理快照仍持有对象。新增测试分别通过真实失败子进程和受控微任务交错验证。实际连线仍旧、完整桌面失败未定、Node 22/远端未验均明确保留；未进行独立模型或人工审核。

## 2026-09-10 19:28 — 第二客户端改为 Grok，完成一次真实查询（北京时间）

- 用户先选择 Antigravity，随后要求“你测一次 GROK 吧”“换成 GROK，先不动 agy cli”。19:04 记录中的第二客户端选择问题已解决；按最新指示以 Grok 继续验收，不再启动或修改 agy CLI。本节追加后续事实，保留前一时点的记录。
- Antigravity 的 A/B 生成目录使用各自 `.agents/mcp_config.json`。`mcp list` 未列出项目项，但两个实际 TUI 的 `/mcp` 均发现 15 工具，观察到 Node PID 30232/28484 分别绑定 A/B。一次 A 模型请求在 MCP 业务调用前失败：`FAILED_PRECONDITION (code 400): User location is not supported for the API use.`；未改账号、代理或模型绕过。B 只做握手，两会话均正常退出。摘要保存在[客户端预检回执](../test-tmp/baseline-cleanup/client-configuration-preflight.json)；客户端日志包含无关历史片段，不复制到文档或外部服务。
- Antigravity 首次启动过程中，其内置后台更新器自行将 CLI 1.1.27 替换为 1.2.0；日志记录启动更新进程，后续文件时间和 B 会话版本一致。没有发出安装/更新命令，但确实发生了环境变化，已向用户明确报告。[官方故障排查](https://antigravity.google/docs/cli/troubleshooting)说明内置后台更新机制。按用户后续指示停止 agy 操作，没有为处理更新而再改配置。
- Grok 使用现有 `C:/Users/40218/.grok/bin/grok.exe`，版本前后均为 1.0.13（5e9a58528b76），SHA-256 均为 `BF43DC75F5478A106EAB1E86D422C963E4DBE9666CF14DAB363733D27BF1E672`。依据[官方无界面运行文档](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)，仅为测试进程设置 `GROK_DISABLE_AUTOUPDATER=1`、`GROK_MEMORY=0`；未写全局环境变量或选择新模型/服务。既有 A/B 生成目录各自初始化空 Git 根和 `.grok/config.toml`，用于限定项目配置发现范围；没有改真实仓库或全局 MCP 定义。
- 首次 Grok doctor 因文件夹未受信任拒绝启动；提示建议的 `--trust` 被本机 1.0.13 参数解析器拒绝。没有反复尝试该参数或手写信任配置，改用正常 TUI 在两个生成目录分别确认信任，然后退出。后续 [A doctor](../test-tmp/baseline-cleanup/grok-doctor-a.json)和 [B doctor](../test-tmp/baseline-cleanup/grok-doctor-b.json)均为 healthy=1/failing=0，确认绝对启动根、协议 2025-11-25、15 工具。受信任目录记录及测试会话历史是本次真实客户端运行产生的状态。
- 只运行一次 A 项目模型任务，保持 default 权限模式，以[官方权限规则](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)定向允许候选服务的 hello 和 find_code_symbol，关闭子代理与 Web 搜索。实际共 5 次工具调用：读取已安装 WinCode SKILL、两次工具发现、两次 MCP 调用；`--tools ''` 没有将客户端能力严格裁剪为仅两个 MCP 工具，不能据参数声称隔离了全部本机能力。没有出现 shell、编辑、workspace_open 或子代理调用；B 不追加模型任务。
- [Grok 验收回执](../test-tmp/baseline-cleanup/grok-acceptance.json)及[原始 MCP 结果](../test-tmp/baseline-cleanup/grok-tool-results.json)经过本地断言核对：hello 为 0.14.0、instance=`2eddc10a-9d01-48f6-a521-c9d937249ca3`，buildId/schemaHash 与本节之前的磁盘构建一致，workspace 为 project-a；Api 查询唯一返回 `Api.cs:2`。provider 为 local-text，结果明确为降级文本声明扫描。本次没有验证 Grok Roslyn、A/B 同时模型查询、同名全局/项目配置冲突或当前 Codex 新构建重连。
- 模型任务 exit=0、stopReason=end_turn，客户端报告默认模型 `grok-4.6-build`、4 个模型回合、累计 74572 tokens（含 37632 cache-read tokens），费用 **0.01651856 USD**；金额为客户端回报，未独立核对账单。两个 Grok TUI 和模型任务均已退出；收尾查询没有发现绑定这两个生成目录的 Node Gateway 残留。临时回执与断言脚本留在既有 test-tmp，不写入已安装 Skill。
- 同步现有详细计划和路线图：第二客户端已选定且最小真实调用通过，N1 固定根、完整 N3 仍未实施；当前 Codex 0.13.2、新构建消费者 Roslyn、完整桌面 34/35 的未定位失败、Node 22/远端 CI 等缺口继续保留。此次客户端验收未修改生产代码，不重复完整测试，也未提交或推送。
- 文档收尾：本轮改动中的 29 个本地 Markdown 链接均存在，`git diff --check` 通过；源码和新增回归经作者复核，没有扩大已通过测试的结论。

## 2026-09-10 20:27 — N1 固定工作区实现与验收（北京时间）

- 用户确认继续，执行已接受的 N1 → 真实客户端检查 → N3 顺序。第二客户端使用 Grok；未再启动或修改 agy CLI。
- 源码契约升级为 0.15.0：Gateway 启动时固定根，显式 --workspace/-w 需要已有目录的绝对路径，缺省固定 cwd 并报告来源。Router 和 WorkspaceManager 共同拒绝其他根；config.workspaceRoot 在运行期不可写。WORKSPACE_MISMATCH 同源文本/structuredContent 附 active/requestedWorkspace 和 select_workspace_connection。拒绝在排队、指纹读取、排空、watcher/cache/trash/Host 变更前发生；保留同根健康热态与故障恢复。此规则不是 OS 原子安全隔离。
- 迁移原切换测试为独立 A/B 实例及同根实际停止监听后的恢复；没有删除清理、取消、故障注入门禁。新增 8 项固定根测试覆盖核心入口、普通文本/相对路径/组合工具、中文空格、Windows 大小写与分隔符、父子目录及 junction、CLI 缺省/非法路径；另补 2 项恢复准备阶段失败门禁。诊断脚本退役未对应当前 LocalText 实现的 text-reset 注入项，保留真实 text-initialize，并在诊断报告注明。
- 最初 5 项新增回归在旧实现全部失败，修改后 5/5；第一轮相关迁移 99/99。首次完整检查 [403 项中 401 通过、1 失败、1 跳过](../test-tmp/check/2026-09-10T12-13-29-501Z-core/report.json)：监听已停止时，排空超时现在保留恢复门，旧断言仍匹配顶层文本。补强断言验证 recovery.phase=drain、原始原因、持有请求未被释放及新业务仍被阻止；[最终核心](../test-tmp/check/2026-09-10T12-14-51-064Z-core/report.json) 403 项中 402 通过、1 项可选 TavernDesk 跳过，0 失败。类型检查、三个 native Release 发布、stdio 及交付校验通过。
- [真实 Roslyn 22 场景](../test-tmp/roslyn-gateway/run-JYtTC8/report.json)、[E4 17 场景](../test-tmp/error-contracts/run-1gdOpi/report.json)、[十次手动释放/重载](../test-tmp/manual-release/run-ArU1cg/report.json)通过。真实 A/B 连接验证拒绝错误根后 A 的 Host/PID、快照、session/watch/cache 不变，B 可继续查询，精确定位跨连接拒绝。故障诊断 12 项无未解决发现；[混合负载](../test-tmp/mixed-load/run-HLx4ss/report.json) 10 轮、70 调用、0 自有存活进程。
- [本次完整桌面检查](../test-tmp/check/2026-09-10T12-21-13-763Z-desktop/report.json)通过，含 35 项 UI 测试和 owner-death、Tray、真实 Tray/Roslyn 工作流。本轮 native 仅同步版本，未修改提示窗绘制；19:04 的提示窗失败及既有托盘偶发失败根因仍未定位，不能以本次通过宣布修复。
- [真实客户端回执](../test-tmp/fixed-workspace/client-acceptance-n1.json)核验 Grok 的 0.15.0 build/schema、固定 A 根、Roslyn Save(int) → 1 引用 → B 根 WORKSPACE_MISMATCH → 原定位仍为 1 引用 → 影响分析。客户端重复读取旧已安装手册及参数 schema，触及预设 12 模型回合后退出；重构步骤未执行，不能称完整八步脚本成功。Grok 默认模型未更换，报告费用 0.03867738 USD；可执行文件哈希前后一致，进程环境禁用自动更新和 memory。
- Codex 首次 CLI 测试无法解析桌面 cua_repl transport；后用官方命令级 --ignore-user-config，仅加载测试 MCP，保留现有 gpt-6-astra/medium 和登录。首次 hello 被权限系统拒绝：MCP tool call requires approval, but approval policy is never。立即停止，没有更改审批策略或绕过；已询问继续 Grok/SDK 并保留待验，或由用户在客户端批准后补验。当前 Codex 桌面连接仍未重连。项目 .codex/.grok 测试配置修改前各保留 config.pre-n1.toml；不修改全局 MCP 或已安装 Skill。
- 同步 README、架构说明、配置指南、CHANGELOG、CONTRIBUTING、安全边界及仓库内四份受管 Skill；历史报告不改写。尚未提交/推送；Node 22、远端 CI、长时大项目、多模型同时 A/B 及完整当前 Codex 消费者闭环仍未验。接着实施 N3，后续源码变化需新的验证报告，不能沿用本节构建身份声称新代码通过。

### 2026-09-10 20:30 — Codex 验收设置澄清

用户选择继续 Grok/SDK，并提供当前 WinCode 配置截图质疑是否为本次 CLI 设置问题。只读核对 codex mcp get 与截图一致：node + dist/index.js + 旧 client-roslyn-20260909 工作区/配置，参数排列正常。用户全局 sandbox_mode 为 danger-full-access，而验收命令显式采用 --ignore-user-config 和 read-only；这不是用户截图配置造成的工具审批失败。OpenAI 官方 MCP/配置参考将工具审批模式与运行审批策略分开，CLI 返回的 never 拒绝只证明本次隔离启动的授权设置不满足调用条件，不能归为 WinCode 兼容性或用户设置错误。已向用户澄清，停止 Codex 补验，不更改其策略。参考：https://learn.chatgpt.com/docs/extend/mcp?surface=cli 及 https://learn.chatgpt.com/docs/config-file/config-reference 。

## 2026-09-10 21:10 — N3 有界准入完成，Grok/SDK 验收与 N4 实际失败（北京时间）

- 按已确认 N1 → 实际客户端验收 → N3 顺序完成当前增量。用户选择继续 Grok/SDK、Codex 单列待验，并指出本次 CLI 设置问题；20:30 澄清继续有效：截图参数未发现错误，隔离 CLI 的 MCP 审批要求与生效 never 策略冲突，不能归为 WinCode 兼容性失败。未再启动 Codex 验收、未改全局配置，先不动 agy CLI。
- 新增 [RequestAdmission](../src/Core/RequestAdmission.ts)：32 个未完成业务请求、4 个 hello/tools/list 状态槽、64 KiB 原始 UTF-8 JSON 参数。容量在准备/执行前获取；复用既有 Mutex 的 FIFO 与物理取消节点，启动共享等待不保留连续取消的 Promise 链。排队/准备/适配器共用总截止时间；SERVER_BUSY 只用于尚未执行的满额请求，REQUEST_TIMEOUT 不自动重试。实际清理完成后才释放占用。workspace_open 占业务容量但不计入其自身等待排空的 inFlight；关闭/手动释放保留等待与清理约束。
- 状态路径不等候慢业务；hello 只读已知缓存状态，未观察的磁盘统计为 null，主动诊断才刷新。统计包含 accepted/completed/rejected/cancelled/timedOut、active/executing/waiting 和等待/执行耗时；executionMs 是非队列墙钟时间（含 I/O/清理），不是 CPU 时间。FlaUI/诊断/Repomix 健康检查沿用调用剩余预算和取消信号。
- [14 项准入回归](../tests/request-admission.test.ts)覆盖原始参数预算、4/8/16 正常突发、128 请求、连续取消补入、执行取消未完成收尾、启动与恢复等待、关闭和状态容量。首轮核心 [415 通过/1 失败/1 条件跳过](../test-tmp/check/2026-09-10T12-47-55-000Z-core/report.json)被架构规则抓到 Gateway 直接访问 workspace；改为 Router.assertWorkspace 后完整重跑通过，没有弱化规则。此前错误契约夹具同步固定根与诊断 signal；真实 Roslyn 脚本的旧“心跳占 1 个业务请求”假设造成 [run-1gklkM 提前检查 PID](../test-tmp/roslyn-gateway/run-1gklkM/report.json)，改为 inFlight=0、business.active=0、waiting=0 后保留严格进程退出断言。新取消场景实际等待 1082 ms 后归零，不能以客户端 Promise 先返回当作清理完成。

| 当前构建的实际验证 | 结果与回执 |
| --- | --- |
| Node 24.19.0 核心/构建/交付 | [417 项，416 通过、1 项可选 TavernDesk 条件跳过](../test-tmp/check/2026-09-10T12-50-13-167Z-core/report.json)；typecheck、三原生组件、stdio 与 delivery 均通过 |
| 真实 Roslyn | [22 场景通过](../test-tmp/roslyn-gateway/run-ystDNe/report.json)，含实际 MSBuild 取消/崩溃/超时及自有后代退出 |
| E4 错误契约 | [17 场景通过](../test-tmp/error-contracts/run-SZG6AN/report.json) |
| 桌面完整检查 | [35/35，后续 owner-death、托盘与双实例工作流全部通过](../test-tmp/check/2026-09-10T13-02-41-136Z-desktop/report.json) |
| 手动释放 | [10 轮通过](../test-tmp/manual-release/run-WQi8n9/report.json)，实际退出、旧定位拒绝/新搜索恢复，已观测 survivors=[] |
| 三实例 SDK | [11 场景通过](../test-tmp/multi-agent/run-IVKMMY/report.json)，限定 A/B 并发冷启动后再启动第二 A Host；已观测 survivors=[] |
| Grok Build 1.0.13 | [7 次真实 MCP 调用通过](../test-tmp/request-admission/grok-acceptance.json)，9 个模型回合正常结束；当前 build/schema/Roslyn 一致，拒绝 B 后 A 原定位仍返回 1 项引用，最终业务占用/等待为 0；客户端报告费用 USD 0.03721436 |

- SDK 具体结果：普通 4/8/16 突发和 96 次交错精确引用通过；128 次单实例搜索受理 32、SERVER_BUSY 96，兄弟实例仍可查询且 Host/快照保持；64 次突发中成功 32、客户端取消 16、过载 16。队列结束归零。采样 Node RSS 约 92.66–111.05 MiB，三实例完成 96 请求时累计最大等待约 12.68 秒；这是离散小项目样本，不是实时峰值或长期趋势。手动释放回执另有 Node/已观测原生进程工作集、私有字节与累计 CPU 快照；并发原生峰值/句柄趋势仍未测。客户端 SDK 发送端仍出现 11 个 drain 监听器警告，阶段后监听器为 0；未抬高阈值或增加客户端限流。
- N4 新失败必须保留：[默认三个 Host 并行冷启动 run-zJc2aM](../test-tmp/multi-agent/run-zJc2aM/report.json)在同物理 A/App.csproj 上竞争 obj/Debug/net10.0/App.GeneratedMSBuildEditorConfig.editorconfig，返回 PROJECT_LOAD_FAILED；结束后已观测 survivors=[]。这是实际共享构建输出冲突，尚未修复。verify-multi-agent 默认继续同根并发；--serialize-same-root-startup 仅分离 N3 与 N4，报告显式记录其限制。未添加跨进程锁、改 MSBuild 属性或复制持久缓存。此前 [run-fgPCWl](../test-tmp/multi-agent/run-fgPCWl/report.json)另因 Tray 夹具硬编码旧 0.14 版本失败，已改读 package.json，不能把该失败和 MSBuild 冲突混同。
- 交付：version=0.15.0；buildId=be08ba26c3d0f82e596161057a595ddb152b7d253d46adc86273ff7c841e151e；schemaHash=4f8a6424c23978ebffe77111f4687c87336de64320f7d24cde8bdeede8ab804f；delivery contentId=24a58650420658f71f3a88c5d2b91bb4a69d5846affccbb3da30c511fdc7376c，收尾 delivery:verify matched=true。版本仍为本地未发布增量，revision 元数据 fb3cd48 不代表干净提交。更新既有 README/架构/配置/Skill 源与计划路线图；未同步已安装 Skill，未安装依赖、提交或推送。
- 作者反证自审：取消响应快但清理尚未结束，可能错误放入新工作；受控测试与真实 MSBuild 退出检查分别覆盖。另一个反例是实例/PID/快照隔离均正确，但 MSBuild 输出仍共享，已用实际失败证据保留 N4。未做独立模型/人工审核。Codex 完整新构建消费、模型 A/B 并发/编辑闭环、同根并发冷加载、共享存储与 UI 其余交错、原生峰值/长期资源、Node 22 和当前增量远端 CI 仍未完成；历史录制提示窗/托盘根因没有因本轮通过而关闭。
- 收尾文档链接检查发现 4 份旧回执在当前工作区缺失（Ho43hD 配置预览、VcfIp2/xaa7Wf 托盘、04-59 桌面检查）；计划改为注明缺失并指向保留的历史工作记录，未补造文件或修改历史日志。当前 SDK/释放 50 个已观测进程身份重新只读核验 survivors=[]。

## 2026-09-10 22:05 — N4 两种隔离原型对照完成，正式方案仍待修订（北京时间）

- 授权来源：用户质疑“是否最优”后，已同意先比较私有设计时输出与跨进程加载锁，并回复“开始吧”。本轮只新增 [比较入口](../scripts/verify-design-time-concurrency.mjs)、[构建/夹具辅助](../scripts/roslyn/design-time-prototypes.mjs)和 [C# 原型插桩](../tests/fixtures/design-time-comparison/PrototypeCoordination.cs)，复制当前 Host 源码到 test-tmp 编译。复用锁定 SDK 10.0.303、已有 NuGet 缓存和生产 RoslynHostClient；没有引入依赖、模型调用或共享服务。正式 Host 源码、Gateway、dist、当前原生构建、全局客户端设置和 agy CLI 均未改动，没有提交/推送。
- 两种原型的实际范围：private 仅覆盖每项目相对 IntermediateOutputPath 为 `.cache/wincode-msbuild/<Host UUID>/<Configuration>/<Framework>/`，保持 restore 的 BaseIntermediateOutputPath/MSBuildProjectExtensionsPath；lock 仅在 ReloadAsync 从加载到快照冻结期间持有工作区根下零字节文件的 FileShare.None，25 ms 可取消等待，仅重试 sharing/lock 错误。正常语义查询不获取该锁；进程结束由 OS 关闭句柄。两者都不是已经进入生产的通用并发协议。
- [首轮 run-elfe3J](../test-tmp/design-time-comparison/run-elfe3J/report.json)为 **验证脚本错误**：从符号顶层读取 project/position，实际定位字段在 location；Save 子串查询还匹配 WPF HandleSave。修正为精确名称/签名及实际 location，并要求基线有效后继续比较。其 12 项失败不计入候选结论，原始回执保留。

| 实际对照 | 结果与证据 |
| --- | --- |
| 语义 12 项 | [run-UcG4RR](../test-tmp/design-time-comparison/run-UcG4RR/report.json)：11 通过、1 候选失败；原实现与锁在普通 C#、项目引用、WPF、自定义目录全部通过；private 在已有自定义 intermediate 目录时 CS0579 特性重复 |
| 并发/退出 13 项 | [run-HdGxkl](../test-tmp/design-time-comparison/run-HdGxkl/report.json)：11 通过、2 候选失败；同根基本项目两种候选通过；根锁在不同入口共享 Lib 时使先加载快照失效，父/子根打开同一实际项目则越过协调；等待取消、实际 MSBuild 后代存在时取消/崩溃、兄弟 Host 继续查询均通过 |
| 外部干扰/编辑 14 项 | [run-k5CDWZ](../test-tmp/design-time-comparison/run-k5CDWZ/report.json)：8 通过、6 未达到候选要求，含原实现的 2 个反例；外部文件占用、真实 dotnet build、先后加载共享项目、不同配置、源码修改及重载期间热查询分别记录 |
| 并发 6 项复核 | [run-BkHrBq](../test-tmp/design-time-comparison/run-BkHrBq/report.json)：修正一处同值自比的快照断言，改比实际引用响应的 snapshot，并保留已关闭 Host 的 trace；4 通过、2 失败。原实现再次在同项目冷加载发生 PROJECT_LOAD_FAILED，这次是 `.NETCoreApp,Version=v10.0.AssemblyAttributes.cs` 写入竞争；根锁共享入口的 SNAPSHOT_STALE 再现。两种候选基本并发通过，private 在关闭/回收兄弟实例后仍保留真实快照及引用 |
| 原精确定位 2 项复核 | [run-zB6QMV](../test-tmp/design-time-comparison/run-zB6QMV/report.json)：两种候选均在编辑后及重载后拒绝原 references 定位，返回 SNAPSHOT_STALE；重新定位后引用由 1 变为 2，编译无错误 |

- [最终汇总](../test-tmp/design-time-comparison/run-zB6QMV/comparison-summary.json)包括原始回执 SHA-256、各场景结果、进程记录和剩余私有产物统计。首批是 39 个不同场景（30 通过、9 未达要求），另有 8 次针对性复核；completed=true/命令正常结束表示诊断实验完成，不能当作候选通过或加入生产核心 417 项计数。原始失败未改写，两个候选均未完成全部验收。
- 私有输出的具体反例：普通项目、跨项目引用、WPF 的 InitializeComponent/事件/精确引用编译通过；自定义 `artifacts/int/...` 已有生成文件后，覆盖 IntermediateOutputPath 改变默认 Compile 排除规则，旧目录生成的特性文件与新目录一起进入编译，CS0579。没有关闭 GenerateAssemblyInfo、删除原构建产物或放宽 compilationErrors 断言以求通过。
- 根锁的具体反例：父根与子根生成不同锁文件，trace 显示同一个实际 csproj 在前一个 Host 的 MSBuild 阻塞期间被另一个 Host 完整加载。对相同工作区，先加载 App 再加载 Peer 或先 Debug 后 Release，新 obj 下的 `.cs` 被现有 WorkspaceInputs 自动候选枚举纳入指纹，前一个 Host 返回 SNAPSHOT_STALE。原实现固定先后加载同样再现，说明它还涉及既有输入判定，不能全部归因于锁本身。
- 外部干扰分开解释：PowerShell 子进程持有默认 editorconfig 的独占句柄时，原实现/锁都 PROJECT_LOAD_FAILED，private 能加载；这是受控故障注入，不是真实 Visual Studio 验收。另一个真实 `dotnet build --no-restore -p:UseSharedCompilation=false -nodeReuse:false` 在指定 target 暂停，Host 加载后放行；private 的快照因默认 obj 新增特性 `.cs` 失效，显式重载后恢复正确 1 项引用；锁原型在该基本项目的共享生成内容未变，本次通过，但未协调外部构建。所有这些拒绝都保留既有输入检查，没有接受陈旧引用。
- 生命周期与成本：两个原型都通过真实 MSBuild 后代的取消/强杀及兄弟继续工作；等待根锁的 Host 取消前尚无 BuildHost 后代。全部 5 份有效报告共记录 207 个进程身份，结束时均 survivors=[]、cleanupFailures=[]。比较父进程在确认实例退出后回收指定私有 UUID 前缀，基本项目 7 文件/1994 字节、图项目 14 文件/4001 字节；兄弟仍能查询。其他私有产物作为取证文件留存，**生产自动回收未实现**，不能用进程退出代替磁盘生命周期验收。工作集约 130–147 MiB 为语义调用时的离散采样；基本双冷加载中锁的后一个 ready 约 6.17 s（含等待约 2.96 s），private 约 3.15–3.59 s。运行顺序/JIT/缓存未控制，不主张性能最优、实时峰值或长期稳定。
- 当前判断：优先继续完善私有输出原型，其隔离覆盖比“按工作区根加锁”更适合现有多连接目标；但不将其直接落入正式代码。下一步需要保留原项目 Compile 排除语义、准确划分实际编译输入与其他构建产物，并明确实例产物回收。反证验收必须含“实际被编译的生成文件改变后旧定位仍失效”，不能直接忽略整个 obj。**USER_DECISION_REQUIRED：本轮授权的两原型比较已完成，正式改变 MSBuild 求值、输入判定或产物生命周期前确认具体修订方案。** 不扩展为全局 Host 池、项目复制或通用跨进程 Lease/FSM。
- 验证范围：脚本语法检查与 git diff --check 通过（另有既存 CRLF 提示）；delivery:verify 再次 matched=true，contentId 仍为 `24a58650420658f71f3a88c5d2b91bb4a69d5846affccbb3da30c511fdc7376c`，报告 productionChanged=false。没有重复完整核心/桌面测试；本轮直接调用隔离 Host，不冒充 Grok/Codex 新 MCP 验收。未测真实 VS、大型项目、多目标框架、自定义 source generator、长期磁盘回收和故障峰值，也未作独立模型/人工复审。详细计划和路线图同步这些实测边界，N4 未关闭。

## 2026-09-10 22:28 — N4 修订原型与正式接入中途交接（北京时间）

- 用户随后以“开始吧”“继续”确认继续修订私有输出方案，22:05 的方案确认项因此已获授权；最新指令为结束今晚工作、写好文档与待办、提交当前进度到 PR。按该指令停止开发和进一步运行测试，保存草稿检查点，不合并、不发布。
- 修订方案复用已安装 SDK 的 Microsoft.Build.dll，通过原项目求值保留自定义 intermediate 的 Compile 排除及原 CustomBefore hook，再为每个 Host 分配 UUID 私有设计时输出。自动候选过滤同时保留实际编译输入、显式 Compile 和无法可靠判定的保守路径，未整体忽略 obj。Native 使用所属 UUID 的清单和活动句柄记录产物，正常关闭回收；Gateway 在确认自有 Host 退出后补偿清理，逐项校验根、UUID、清单及链接边界，不能删除兄弟实例产物。未新增依赖安装或全局服务。

| 修订原型的实际验证 | 结果与本地回执 |
| --- | --- |
| 普通 C#、项目引用、WPF、自定义 intermediate 的三种实现对照 | [run-PpetSI](../test-tmp/design-time-comparison/run-PpetSI/report.json)：12/12 通过，私有输出的原自定义目录 CS0579 反例恢复 |
| 私有输出外部干扰与编辑 | [run-LHMyyy](../test-tmp/design-time-comparison/run-LHMyyy/report.json)：6/6 通过，含外部文件占用、真实构建、共享项目先后加载、不同配置、编辑和重载期间查询 |
| 输入判定反例 | [run-ejjK26](../test-tmp/design-time-comparison/run-ejjK26/report.json)：3/3 通过，实际生成文件修改、新显式 obj/Manual/*.cs 均拒绝旧快照并可重载恢复，原 CustomBefore hook 保留 |
| 并发与产物生命周期 | [run-hJPqME](../test-tmp/design-time-comparison/run-hJPqME/report.json)：5/5 通过，含基本/共享图/嵌套根并发、取消与崩溃；正常及父进程补偿清理后所属私有文件为 0，兄弟仍可查询，survivors=[]、cleanupFailures=[] |

- 正式源码已接入 [DesignTimeBuild](../tools/WinCode.Code.Host/DesignTimeBuild.cs)、[OwnedBuildOutputs](../tools/WinCode.Code.Host/OwnedBuildOutputs.cs)、[DesignTimeArtifacts](../src/Adapters/DesignTimeArtifacts.ts)，并连接 WorkspaceSession、WorkspaceInputs、RoslynHostClient。输入策略协议升为 2，适配器和已有契约夹具同步；旧策略 Host 的专项拒绝测试尚待补充。最后加入的重叠输出目录候选合并、从实际 Imports 解析原 hook 两项修改在本轮原型回执之后，尚未构建验证。
- 已实际执行 `node node_modules/tsx/dist/cli.mjs --test tests/design-time-artifacts.test.ts tests/roslyn-contracts.test.ts`：**23/23 通过**，含仅回收所属 UUID、全量预校验、越根/其他 UUID/链接/损坏清单拒绝及 Roslyn 契约。该命令未生成持久报告；不得将这些 TypeScript 测试当作正式 Native 编译或 MCP 并发验收。
- **当前最终源码为 WIP**：尚未执行正式接入后的 typecheck、Native Release 构建、完整核心检查、默认三 Host 并发冷加载和交付身份核对。磁盘 dist/Native 及前文 417 项、真实客户端等结果对应 N4 接入前构建，不覆盖最后源码；AssemblyAttributes.cs/editorconfig 并发问题仍不能在生产验收层面关闭。
- 明日首先处理两个明确的验证入口问题：旧 buildPrototype 文本锚点已不匹配正式接入后的 WorkspaceSession；原型 WINCODE_N4_INSTANCE 与正式 WINCODE_BUILD_INSTANCE 必须统一到被测 Host 的真实 UUID，避免 blocker/产物清理检查错位。不得把当前源码作为原实现基线。然后正式构建，并按 [2026-09-11 恢复顺序](https://github.com/linnnn89/WinCode/blob/d51f3e105b07b50b1e2535ca541f532ea77b3fc5/WinCode-%E4%B8%8B%E4%B8%80%E8%BD%AE%E5%B7%A5%E7%A8%8B%E5%8C%96%E8%BF%AD%E4%BB%A3%E8%AE%A1%E5%88%92%E4%B9%A6.md#2026-09-11-%E6%81%A2%E5%A4%8D%E9%A1%BA%E5%BA%8F)完成并发、输入、生命周期与交付验收。
- 反证自审保留：原型通过不代表最后两个源码修订正确；动态 ProjectReference、多目标框架、自定义 Compile 仍需检查保守失效行为；Gateway 与 Host 同时硬退出或断电后的孤儿目录未实现自动回收。尚未独立审查、Node 22 验证或当前 PR CI 验证。Codex 继续单列待验，先不动 agy CLI，没有再次更改客户端或权限策略。
- 同步 README、CHANGELOG、架构说明、路线图和计划的当前状态，保留历史失败日志。test-tmp 原始回执仅保留本机、受 Git 忽略，不上传原始模型配置、日志或运行产物；远端 PR 提供结果摘要及可继续执行的待办。当前进度按用户明确授权提交并推送为草稿 PR，等待明日继续。

## 2026-09-11 08:47 — PR #37 本地续作：错误契约修复与私有输出生产验收（北京时间）

- 授权与范围：用户先要求下载昨晚 PR 的进度、与本地对齐并分析计划缺口，随后明确“继续开展工作”。在 `D:/CODEX PROJECT/WinCode MCP` 对齐 `codex/runtime-baseline-and-cleanup` 的 `aa6fc7f457f5a18b122fd791aec2824ed121195d` 后继续本地修复及验证；原 `codex/architecture-boundaries` 分支保留。本轮没有提交、推送、修改 PR 状态、合并或发布，没有安装新依赖、调用模型或改动真实客户端/已安装 Skill/agy CLI。PR #37 实际为 open、draft=false；昨晚“草稿”描述的是 WIP 检查点，不是 GitHub draft 状态。
- 证据对齐：通过 GitHub 连接器读取 [PR #37](https://github.com/linnnn89/WinCode/pull/37) 和 [CI run 34489311570](https://github.com/linnnn89/WinCode/actions/runs/34489311570)。Node 22 核心为 422 项、421 通过/1 条件跳过，构建已完成；真实 Host 在 39 个已完成场景后因损坏项目重载预期 `PROJECT_LOAD_FAILED`、实际 `QUERY_FAILED` 而失败，后续同一步网关/owner-death/释放未执行。Node 24 构建与核心通过。CI 合成 merge 的 tree 与 PR aa6fc7f 相同，这些是原 PR 的证据，不是本轮未推送增量的远端结果。下载的受控 CI JSON 保留在 `test-tmp/pr37-audit-20260911`。昨晚四份修订原型 `run-PpetSI/run-LHMyyy/run-ejjK26/run-hJPqME` 及其他历史 test-tmp 未随 Git 下载到本机，历史工作日志不改写。
- 生产修复：[DesignTimeBuild.cs](../tools/WinCode.Code.Host/DesignTimeBuild.cs) 在实际 `ProjectCollection.LoadProject` 边界将 `InvalidProjectFileException` 映射为 `PROJECT_LOAD_FAILED`，不改变 Program 的 MSBuildLocator 先后顺序。Gateway 与 Native 同时验证 Configuration/TargetFramework 的字面目录段，拒绝点段、尾部点/空白、分隔符、MSBuild 属性/列表/转义字符；私有输出只生成一次并核对规范化后仍在所属 UUID 内。新增缺失/旧 inputPolicy 的拒绝与进程回收测试，错误码保持 `HOST_PROTOCOL_ERROR`，不能持有成功快照。
- 验证入口：[verify-design-time-concurrency.mjs](../scripts/verify-design-time-concurrency.mjs) 改为当前正式发布 Host 和生产 RoslynHostClient 的验收，不再复制/插桩当前源码作为原基线。运行前后核对 delivery/source 身份，blocker 与 owner.json 使用 client 的实际 `WINCODE_BUILD_INSTANCE`；每个选中场景、编译/引用结果、退出及产物清理分别留证。取消/强杀后由生产关闭逻辑清理，验证脚本不通过手工删除私有目录替代被测回收。完成全部选中场景、非空选择、无失败/交付变化/清理失败/已观测残留才 success=true，否则非零退出。旧原型辅助和 C# 夹具保留作历史材料；正式入口仅接受 `--phase`、`--filter`。
- [verify-multi-agent.mjs](../scripts/verify-multi-agent.mjs) 增加交付前置核验和 `--roslyn-only`；该选项保留真实 A/B/A 三 Host 同时冷启动、全部 Roslyn/准入/传输验证，只排除原生 Tray 容量项，默认完整模式不变。CI Node 22 已加入该入口及完整私有输出矩阵，失败报告按 always 上传，15 分钟作业预算未提高；本轮未推送或触发 CI。

| 本轮实际验证 | 结果与本地证据 |
| --- | --- |
| 核心/类型检查/构建/交付 | [core report](../test-tmp/check/2026-09-11T00-17-41-069Z-core/report.json)：425/425，0 跳过；现有锁定 SDK 10.0.303、Node 24.19.0，包含 Gateway 与三 Native 组件的正式发布和交付核验 |
| 产物归属及 Roslyn 契约专项 | `test-tmp/n4-production/contracts-after.log`：26/26；目录段测试先在修改前实际失败，`contracts-before.log` 保留 |
| 真实 Native Host | [fixture-3Rpx5Q](../test-tmp/roslyn-host/fixture-3Rpx5Q/report.json)：59 场景通过，含损坏项目失败/修复链路、原生 16 组非法配置/框架组合在私有目录副作用前拒绝 |
| 真实 MCP Roslyn Gateway | [run-Rse2Ni](../test-tmp/roslyn-gateway/run-Rse2Ni/report.json)：22 场景通过，含实际 MSBuild 取消/崩溃/超时及恢复 |
| E4 错误契约 | [run-bWLzfr](../test-tmp/error-contracts/run-bWLzfr/report.json)：17 场景通过 |
| 真实三个 SDK 客户端 | [run-qwMOna](../test-tmp/multi-agent/run-qwMOna/report.json)：10 场景通过，startupMode=all three hosts parallel，survivors=[]；精确引用 A/B/A=1/2/1，128 请求受理 32、SERVER_BUSY 96，结束占用归零 |
| 完整私有输出生产矩阵 | [run-1toEyr](../test-tmp/design-time-production/run-1toEyr/report.json)：20/20，228.291 秒；语义 5、并发/退出 5、构建/编辑干扰 6、输入反例 4，productionChanged=false、cleanupFailures=[]、survivors=[] |
| 验收入口负例 | [run-GkatiK](../test-tmp/design-time-production/run-GkatiK/report.json)：无匹配场景的 filter 实际退出 1，success=false、cases=[]、observed=[]，该失败符合预期 |
| 手动释放 | [run-TG4ZUS](../test-tmp/manual-release/run-TG4ZUS/report.json)：10 轮通过，已观测残留为空 |
| Gateway 在加载中死亡 | [run-MayNi6](../test-tmp/owner-death/run-MayNi6/report.json)：9 个已观测进程身份全部退出，survivors=[]、cleanup=[] |
| RepomixAdapter owner 死亡 | [run-DS7jFN](../test-tmp/owner-death/run-DS7jFN/report.json)：通过，survivors=[]、cleanup=[]；使用受控 Node CLI，不声称真实 Repomix 或完整 Gateway 集成 |

- 矩阵反证：已有自定义 intermediate 先按与 Host 相同的 Configuration/TargetFramework 连续普通构建两次，再检查生产 Host 编译无错误；双 TFM `net10.0/net10.0-windows` 按条件分别得到 1/2 项引用，关闭兄弟后保留原快照。源码编辑使旧定位失效，重载后引用从 1 变为 2，旧定位继续 `SNAPSHOT_STALE`。项目文件中显式引用 App→Lib 改为 App→Peer→Lib 后，先更新生成夹具的 restore 输入，再重载为 3 个项目/2 项引用；新 Peer 输出进入所属清单并随关闭回收。这不是任意 target 动态生成引用的证明。另按报告内容复核 65 份记录的 compilationErrors 均为空。
- 失败过程保留：`run-Lux8mM` 的输入反例首次返回 `INPUTS_CHANGED`，符合 watcher 事件落在 Capture 期间的既有契约；另一个引用变更场景尚未 restore 更新项目图。修正夹具与断言后要求首次拒绝且不返回证据、紧接着严格 `SNAPSHOT_STALE`，显式重载后引用正确。`run-WDKrAC/run-Y20hsP` 暴露验证脚本遗漏 `runDotnet` 导入，补齐后分别针对性通过，最终由完整 20 项再次覆盖。`run-KuzB7O` 的预构建未显式传入配置/TFM，早期 Directory.Build.props 求值到另一目录；原 MSBuild 求值同样将旧 `.cs` 纳入 Compile。这是夹具条件不一致，未通过改生产排除规则、删除旧产物或关闭特性生成解决；参数统一后 `run-LZbC6v` 及最终矩阵通过。临时筛选变量拼写错误 `run-d411ZJ` 也以失败保留。所有日志位于 `test-tmp/n4-production`，未改写失败回执。
- 交付身份：version `0.15.0`；buildId `65102c51f7d53138fe7874ba656d7a5e9938168dc9f32c5e2c54ad400387baaa`；schemaHash `4f8a6424c23978ebffe77111f4687c87336de64320f7d24cde8bdeede8ab804f`；delivery contentId `0fded67d16aed5d7ca3c98b566fd6ebe57cdaabda8ea7d18ece422de8dc3c522`；发布 Code Host DLL SHA-256 `631814d5b9fd0997b6c952d56a05c412a989123225b8a4fbb35326418d45f5fd`。收尾 `delivery --verify` matched=true。revision 元数据仍为 aa6fc7f，当前源码是该提交上的本地未提交增量，不能称为干净提交构建。同步来源与客户端部署继续区分，codexConnectionVerified=false。
- 剩余范围：具体同项目 MSBuild 输出竞争可以在本地生产回归层面关闭，N4 整体未关闭。共享缓存并发写入/清理/读取、双实例源码编辑、UI 窗口交错、任意 target 动态项目图、自定义生成器及双重硬退出/断电孤儿产物继续开放。当前增量未做 Node 22、远端 CI、真实 Grok/Codex 消费、完整桌面/托盘复验、长期资源或独立模型/人工审核。SDK 在 128 请求突发中仍有 11 个 drain 监听器警告，阶段结束为 0；未调整阈值，短时归零不证明长期无泄漏。本轮无新的 USER_DECISION_REQUIRED；后续若需新的清理政策、依赖、真实客户端配置或外部交付，应明确范围后按有效授权执行。
- 文档同步：更新既有 README、CHANGELOG、架构说明、详细计划和路线图，把已完成的恢复工作移出待办，标记本机缺失的历史报告。历史日志保持原文；本轮回执是本地可核验文件，不随源码提交，也不冒充已上传 CI artifact。
- 最终检查：四个改动的 `.mjs` 入口/辅助文件 `node --check`、`git diff --check` 和当前文档/本节报告链接存在性检查通过。HEAD 与已抓取远端分支提交差异 0/0，工作区保留 14 个文件的本地增量。交付与完整矩阵结束后未再修改生产源码，也未重复无关完整测试。

## 2026-09-11 09:18 — 借鉴维护者经验，补齐缓存完整性与双实例编辑验收（北京时间）

- 授权与范围：按用户“吸取网友的优秀经验，继续工作”，继续 PR #37 检查点上的本地修复。只核查公开一手资料，使用现有 Node 24.19.0、锁定 SDK 10.0.303 和已安装依赖；没有新增存储架构/依赖、调用模型、修改真实客户端、提交、推送、合并或发布。上一节的本地修改全部保留。
- 经验落地：[npm cacache 的读取实现](https://github.com/npm/cacache/blob/main/lib/content/read.js) 将大小和内容摘要纳入校验，启发本轮把“附件还存在”改为可验证的内容完整性。[write-file-atomic 实现](https://github.com/npm/write-file-atomic/blob/main/lib/index.js) 的 activeFiles 排队只在单进程内；[Windows 多进程 #28](https://github.com/npm/write-file-atomic/issues/28) 和 [锁冲突 #227](https://github.com/npm/write-file-atomic/issues/227) 是报告/提议，不当作已合入保证或 WinCode 已复现的故障。保留现有唯一临时文件后 rename 和实例内队列，用真实 Gateway 验证跨进程交错，没有因此增加锁或重试。
- 先复现再修复：[integrity-before.log](../test-tmp/n4-cache/integrity-before.log) 的四个负例在原实现全部失败：同大小且恢复 mtime 的损坏 overflow 被内存/磁盘读者继续当作命中；合法 JSON 正文被修改，或另一个键的整份 JSON 复制到当前文件名，在相同 fingerprint 下返回错误正文。这说明输入身份正确、文件存在和 JSON 可解析都不足以证明缓存正文正确。
- 生产修复：[Cache.ts](../src/Core/Cache.ts) 增加绑定命名空间键、时间/TTL、fingerprint、正文和附件身份的 SHA-256 元数据，内存/磁盘命中都核验；附件通过同一文件句柄，以 64 KiB 缓冲区在既有磁盘预算内流式校验大小/摘要。缺失、损坏或旧条目没有摘要时重算。JSON 读取按已打开大小加一个探测字节限定，读取期间检测到增长/缩小即未命中；新增文件增长反例验证读取量没有随追加内容膨胀。目录格式、MCP 公开契约和清理所有权未改变。
- 修复过程保留：[cleanup-integrity.log](../test-tmp/n4-cache/cleanup-integrity.log) 暴露了第一版补丁提前放弃元数据写入，使超出缓存预算的附件无法立即由原容量清理识别。修正为拒绝缓存复用但保留有界受管元数据，既有 TTL/容量回收恢复；没有扩大孤儿扫描或清理权限。相关反例和有界读取测试共新增 5 项，写入既有 [runtime-cache-regressions.test.ts](../tests/runtime-cache-regressions.test.ts)。
- 新增 [verify-shared-cache.mjs](../scripts/verify-shared-cache.mjs) 和 [cache-gateway.mjs](../tests/fixtures/cache-gateway.mjs)：由测试入口载入正式发布的 ToolRouter/WinCodeMcpServer/Cache 模块，使用真实 SDK stdio 公开工具调用，每个 hello 核对版本、buildId、固定工作区和独立实例。小预算生成夹具用来触发真实写入与自动清理，不是替代 Cache 实现，也不代表实际消费者或标准 CLI 启动配置已验收。关闭回执要求业务占用归零和资源已释放；清理失败、已观测残留或交付变化使验收失败。
- 共享缓存 8 场景：同键 8 个并发请求；不同键 8 个并发请求；兄弟 20 次实际写入触发容量清理并重建已返回附件；两个热 Gateway 拒绝同大小损坏附件；同项目源码编辑后两端回读更新；A/B 共享物理目录无跨项目正文；一端退出时兄弟继续命中；两个写者退出后全新 Gateway 命中已验证的持久缓存。报告没有损坏 JSON、错误正文、遗留临时文件、关闭后占用或已观测残留；四个客户端 stderr 仅有正常启动消息，没有错误或警告。
- 验收入口失败保留：[run-5iBtOC](../test-tmp/shared-cache/run-5iBtOC/report.json) 首次在 hello 断言使用错误字段 runtime.version，尚未进入业务场景；实际版本在 hello.version，构建在 hello.runtime.build。按公开返回结构修正断言后重跑完整 8 场景，没有削弱版本/build 核验；失败运行也取得正常停止回执。
- [verify-design-time-concurrency.mjs](../scripts/verify-design-time-concurrency.mjs) 新增 inputs/peer-source-edit：同项目两个正式 Host 同时加载，初始引用数各为 1；实际编辑生成夹具后，两端旧定位均返回 SNAPSHOT_STALE 且无证据；同时重载后引用各为 2，旧定位继续无效，关闭一个 Host 后另一个保留新快照。默认完整矩阵由 20 增为 21，未改动生产 Roslyn 源码。

| 本次缓存增量后的实际验证 | 结果与本地证据 |
| --- | --- |
| 缓存/预算/运行回归专项 | [integrity-after.log](../test-tmp/n4-cache/integrity-after.log)：24/24；含内容损坏和错误键反例 |
| 清理/边界相关专项 | [cleanup-integrity-corrected.log](../test-tmp/n4-cache/cleanup-integrity-corrected.log)：44/44；包含原容量回收回归与有界读取反例 |
| 完整核心/类型/构建/交付 | [core report](../test-tmp/check/2026-09-11T00-59-55-956Z-core/report.json)：430/430，0 跳过；typecheck、Gateway、Native 发布、stdio、delivery 全部通过，日志为 test-tmp/n4-cache/core-check.log |
| 真实 SDK/Gateway 共享缓存 | [run-xTRbJS](../test-tmp/shared-cache/run-xTRbJS/report.json)：8/8，9.501 秒，8 个已观测进程身份，cleanupFailures=[]、survivors=[] |
| 完整正式 Host 生产矩阵 | [run-CJF7mW](../test-tmp/design-time-production/run-CJF7mW/report.json)：21/21，229.448 秒；89 个已观测进程身份，productionChanged=false、cleanupFailures=[]、survivors=[] |
| E4 错误契约 | [run-pD7oeb](../test-tmp/error-contracts/run-pD7oeb/report.json)：17/17，通过 |

- 当前交付：version=0.15.0，buildId=`09f71cba0339b2bf9f3f9e7d28cd727df7815aa230af1565cda3a04bce6d3187`，sourceHash=`1bd9aa91805d05f3b04955ed4786cc84dffe8e2ea7a2b49f8036a64aadec84c1`，artifactHash=`0924b27f2ce659f5e30cd677513c3fc1c8fedc65f6f388b37e7afe19766d1a6b`，delivery contentId=`8ec5572d5b85ecbc25601208e6f115038d57b2572e1a0fc36ae4303d52b56f5e`。revision 仍为 aa6fc7f，本地生产修改由源码摘要区分；不把当前构建说成干净提交或已部署连接。15 工具/schema 保持，codexConnectionVerified=false。
- 反证自审：两端校验通过仍不能保证已返回附件永远存在。实际容量清理删除了原附件，后续请求重建；这保留现有可过期引用契约。磁盘条目/字节限制是定期清理目标，不是跨进程瞬时硬配额：本次配置 4 条时一度 14 条，全新 Gateway 启动清理后回到 4 条。没有用测试通过掩盖这个边界，也没有擅自新增租约或全局锁。
- 未验证事项：写入中断/掉电持久性、超大附件摘要读取成本、长期缓存/原生资源趋势、多文件多写者原子快照、任意动态项目图、UI 并发取证仍未覆盖。上一节 59/22/SDK 10/释放 10/owner-death 是同日上一构建证据，未在缓存增量后逐项重跑；此前 SDK drain 警告也没有因这 8 个小场景无警告就视为修复。Node 22、远端 CI、独立审核和真实消费者仍待验。当前局部修复没有新的 USER_DECISION_REQUIRED；长期附件保留、硬配额或新清理政策需要先明确需求。
- 文档与持续验收：同步既有 README、CHANGELOG、架构说明、路线图和详细计划，加入一手经验来源并把已完成的存储/编辑验收移出待办。CI Node 22 的并发步骤新增共享缓存入口及 always 报告收集，15 分钟预算不变；当前没有推送触发。test-tmp 回执仅保留本机，历史日志原文保留。
- 最终核对：3 个本轮验收入口/夹具的 node --check、git diff --check、75 个当前文档/本节相对链接存在性检查通过，交付再次 matched=true。HEAD 与已抓取 PR 分支仍为 aa6fc7f、提交差异 0/0；当前保留 16 个已跟踪文件修改和 2 个新增文件，含上一节的未提交增量。完整验证后未再修改生产源码。

## 2026-09-11 09:31 — TDD 红—绿重放、退化检验与完整回归（北京时间）

- 目标与范围：用户明确要求“进行TDD测试验证代码”。针对本轮缓存完整性及双实例编辑进行验证，保留全部已有工作区修改；没有新增依赖、改动生产实现、操作真实消费者或推送外部变更。由于实现已经存在，本次采用隔离副本重放修复前后行为，并刻意移除关键保护检验用例能否发现退化，不声称这是从零开始的测试先行开发。
- 新增 [runtime-cache-regressions.test.ts](../tests/runtime-cache-regressions.test.ts) 的 3 项行为回归：inline/overflow 两类旧缓存缺少 integrity/backingFile 元数据时必须重算，重算后正文正确且再次命中；JSON 在路径大小检查之后追加合法空白，超过 maxEntryBytes 时必须未命中。追加空白不改变 JSON 数据，专门验证读取预算，而非借助正文损坏间接失败。原有文件句柄检查后增长的读取量断言继续保留。
- 可重放实验：[replay.mjs](../test-tmp/tdd-cache/replay.mjs) 复制当前 55 个 TypeScript 源文件（460581 字节）及该测试文件到 test-tmp 独立目录，仅替换 Cache.ts 为 PR aa6fc7f 的版本。其余模块保持当前代码，用相同 7 个反例验证差异；这不是完整历史 PR 或 Native 的重建。测试仍使用现有 tsx 和本机依赖。每个阶段核对实际 TAP 用例/通过/失败/跳过数量及退出码，失败类型均为 ERR_ASSERTION，没有以编译、导入或环境错误充当红阶段。

| 红—绿/退化验证阶段 | 实际结果 |
| --- | --- |
| PR 原版 Cache.ts | 7/7 按预期失败：内存/磁盘同大小附件损坏 2，JSON 正文修改/换键 2，旧缓存两类 2，路径检查后文件增长 1 |
| 当前 Cache.ts | 同一组 7/7 通过，0 跳过 |
| 移除正文完整性校验 | 对应 2 个反例均失败 |
| 摘要不再绑定缓存键 | 换键反例失败 |
| 移除附件摘要比对 | 内存/磁盘两个损坏附件反例均失败 |
| 把有界 JSON 读取改为 readFile | 大小检查后增长反例失败 |
| 恢复当前实现 | 同一组再次 7/7 通过，主工作区 Cache.ts 哈希始终不变 |

- [完整红—绿报告 run-kLuIQ8](../test-tmp/tdd-cache/run-kLuIQ8/report.json)：success=true，7 个阶段，6.627 秒；四种选定退化全部被检出，不作为全项目 mutation coverage。报告包含每阶段日志、实际失败名称、源码/测试 SHA-256 和 productionSourceUnchanged/testsUnchanged=true；副本最后恢复当前实现。正式 Cache.ts 文件摘要为 bbae056552bb3a3eba3a1362fa3ce3dcdb5cd4be3957cee033dbed41ea8212a6，PR 原版为 e84c10c07c856d2b3d389930f5d56adada2ce991023b92f19924f52e7eb1111c。
- 测试自身的失败也保留：[run-XfrwD0](../test-tmp/tdd-cache/run-XfrwD0/report.json) 首轮当前实现 6/7 通过，失败是新增 overflow 用例把包含随机附件路径的 preview 文本要求完全相同。重建会产生新路径，因此改为验证新旧路径不同、实际附件正文逐字节内容相等，inline 仍比较完整正文；继续要求首次未命中和重建后命中。该失败不归为生产缺陷，未通过修改实现迎合测试。

| 追加的当前实现验证 | 结果与证据 |
| --- | --- |
| 完整核心、类型、Gateway/Native 构建、stdio、delivery | [2026-09-11T01-27-26-632Z-core](../test-tmp/check/2026-09-11T01-27-26-632Z-core/report.json)：433/433，0 失败/取消/跳过，45.874 秒；日志 test-tmp/tdd-cache/core-check.log |
| 真实 SDK/Gateway 共享缓存 | [run-awRGKn](../test-tmp/shared-cache/run-awRGKn/report.json)：8/8，7.541 秒，8 个已观测进程身份，cleanupFailures=[]、survivors=[] |
| 双正式 Roslyn Host 编辑/重载专项 | [run-xhNUyA](../test-tmp/design-time-production/run-xhNUyA/report.json)：1/1，10.990 秒，4 个已观测身份；编辑前引用 1/1，旧定位均 SNAPSHOT_STALE，重载后 2/2，关闭一端后兄弟仍为 2；cleanupFailures=[]、survivors=[] |

- 交付与边界：buildId 仍为 09f71cba0339b2bf9f3f9e7d28cd727df7815aa230af1565cda3a04bce6d3187，sourceHash、artifactHash 和 delivery contentId 均与上一节相同，matched=true。没有发现需要修改生产实现的新缺陷；源码只新增上述 3 项测试，并同步 README/路线图/计划当前计数与证据。上一节完整 Host 21 场景和 E4 17 是同一生产构建的既有结果，本次 Host 只重跑 peer-source-edit，不冒充再跑完整 21 场景。
- 反证自审：仅断言未命中可能让“禁用所有缓存”错误实现通过；用例同时要求其他键仍可读取、旧缓存重建后再次命中，并比较实际正文，保留成功路径。隔离副本中的四种刻意退化只证明对应保护被这些测试覆盖，不外推掉电一致性、跨调用附件租约、磁盘瞬时硬配额、UI 并发、长期资源、Node 22、远端 CI 或真实消费者。

## 2026-09-11 09:58 — 整体架构复核与 PR #37 合并就绪判断（北京时间）

- 任务边界：用户要求再次复核整体代码架构、确定下一步并判断是否可以合并。本次检查源码、调用链、已有回执和 GitHub 实时状态，并在 test-tmp 生成小型反例；没有修改生产源码、已有测试或远端 PR，也没有提交/推送/合并。这里只追加复核记录。
- 架构结论：继续保留单连接固定工作区的 Gateway，由 ToolRegistry/McpServer 统一参数与准入，ToolRouter 组织恢复/释放，现有 Adapter 隔离 Roslyn 与 UIA，Native 以快照和 UUID 归属管理语义及输出。静态扫描 55 个 TypeScript 文件、139 条本地非显式 type-only 导入边，没有发现循环；该扫描不覆盖动态依赖或运行时正确性。重点复查了 RequestAdmission/OperationContext/Mutex、Workspace 固定根、Router drain/恢复、Roslyn Host 协议及退出、私有输出输入策略、缓存、UI 请求截止和交付/CI。现有方向可保留，下一步应先收口并发正确性与交付，不需要为了合并扩大架构。
- 新发现 [P2]：[Cache.ts](../src/Core/Cache.ts) 的 get 在保存 memEntry 后 await backingFileMatches，再无条件执行 memoryCache.delete/set。等待期间，set、淘汰或 clear 已可能改变同一 Map；恢复时旧对象会覆盖新值或复活已删除条目，且没有相应恢复 memoryBytes。失败校验分支同样需核对自己删除的是否还是原条目。origin/main 也存在同样 await 后 delete/set 结构；本次是发现此前未覆盖的操作交错，不归因于上一节新增测试。
- 当前正式构建上的确定性反例：[repro-cache-race.mjs](../test-tmp/architecture-review/repro-cache-race.mjs) 直接使用已验证的 dist/Core/Cache.js，只在生成的缓存目录执行公开 CacheManager 方法，无 mock、无生产文件回滚。[run-XoxWYs/report.json](../test-tmp/architecture-review/run-XoxWYs/report.json) 记录三个 reproduced=true：①读旧值与 set(new) 交错，set 已完成后内存仍返回 old，冷读磁盘为 new；②maxMemoryEntries=1 却保留 2 条，报告 2 字节而两个字符串按既有估算合计 4 字节；③clear 已完成后仍返回 old，内存 1 条而统计 0 字节。这是模块行为反例，没有声称已复现跨项目 MCP 错误正文或整个进程 RSS 失控。
- 测试结论修正：上一节 433/433、7 个红—绿反例和四种退化检验仍是其实际覆盖范围内的通过结果；本次新增反例证明它们没有覆盖异步读取与内存状态修改交错。因此不能据旧测试通过直接判定当前本地代码可合并。建议在本 PR 收尾中先将上述 3 个反例纳入正式回归，异步边界后校验条目身份/状态代次，再修改缓存状态；同时检查磁盘回填的同类交错，避免仅修成功内存命中这一条分支。
- GitHub 实时状态：通过 GitHub 连接器及现有 gh 的只读查询核对 [PR #37](https://github.com/linnnn89/WinCode/pull/37)。head=aa6fc7f457f5a18b122fd791aec2824ed121195d，base=fb3cd48df3f38b209565b906fbfe3485df48461d，state=open、draft=false、merged=false、mergeable=MERGEABLE，但 mergeStateStatus=BLOCKED；review/review thread 均为空。Git 无冲突不能代替必需检查通过，本地未提交修复也不是 PR 当前内容。
- 必需检查：gh pr checks --required 返回 5 项，其中 Windows regression (Node 22) 为 FAILURE；Node 24、Analyze (actions/csharp/javascript-typescript) 为 SUCCESS。另一个汇总 CodeQL 也为 SUCCESS。[Node 22 作业 102911583651](https://github.com/linnnn89/WinCode/actions/runs/34489311570/job/102911583651) 的实际日志确认：真实 Host 第 39 个已完成场景后，预期 PROJECT_LOAD_FAILED、实际 QUERY_FAILED，退出 1；该错误映射的本地修复尚未推送。GitHub 状态与昨晚 PR 描述只是远端检查点事实，不作为新的用户指令。
- 当前交付再核验：delivery matched=true，contentId 仍为 8ec5572d5b85ecbc25601208e6f115038d57b2572e1a0fc36ae4303d52b56f5e；读取现有核心 433/433、完整 Host 21/21、共享缓存 8/8 和 TDD 回执确认其成功/清理状态。本次没有重复无关全套测试，三个新的缓存时序反例才是本轮新运行的验证。
- 合并前建议顺序：①修复缓存状态交错并以反例驱动回归，确认正常命中、替换/清空结果和容量计数；②重建/核验最终源码，按影响复跑核心、共享缓存及必要 Host 用例；③在获得提交/推送授权后，把当前增量纳入同一个 PR，更新过时的 WIP 描述与证据；④以新的实际 PR head 核对 5 个必需检查、最终差异和分支保护，再决定合并。当前既有 BLOCKED 状态也有尚未修复的相关缺陷，不建议立即合并。
- 后续验收分层：UI 多实例只读取证、真实消费者/模型闭环、长期/大项目资源和任意动态项目图可以作为后续明确范围的验收；已公开的附件可过期、定期磁盘清理和掉电孤儿产物限制不自动转成此次合并必须完成的新功能。发布或对外承诺相关能力时仍需对应证据。本次为当前助手的架构复核与反例验证，不替代独立模型/人工评审。

## 2026-09-11 10:28 — 缓存状态交错修复、共享截止退化修复与 TDD 验收（北京时间）

- 授权与范围：用户明确要求“好，你开始修复吧”。在原工作区保留全部已有增量，修复上一节缓存 P2；完整检查又暴露一个直接阻碍验收的 N3 超时分类问题，以受控反例确认后局部修复。此次生产代码只新增修改 [Cache.ts](../src/Core/Cache.ts) 和 [ToolRouter.ts](../src/Core/ToolRouter.ts)，未改变公共 MCP 参数/工具数量、缓存布局/清理所有权或并发参数，未新增依赖、服务、跨进程锁或模型调用。没有提交、推送、合并、发布或切换真实消费者。
- Cache 修复：异步附件校验后核对 Map 中是否仍为原条目，失效则未命中，成功刷新及失败删除都不能作用于替换后的条目；旧写入的附件校验失败也只删除自身。磁盘读取先排空已接受写入，使用单一状态代次阻止旧读回填到新值、清空后的内存或新的 namespace/目录。写入、内容记忆更新、prune 和工作区重置使正在进行的磁盘读失效；无每键永久 tombstone。过期/超大记录的删除进入原写队列，在队内再次核对代次，避免旧读删除新落盘值。并行有效读取继续返回数据并遵守同一 LRU 字节/条目预算；发生其他键的修改时，磁盘读可以保守未命中。
- 正式回归位于 [runtime-cache-regressions.test.ts](../tests/runtime-cache-regressions.test.ts)：先添加 12 个交错用例，在修改生产实现之前运行 [red.log](../test-tmp/cache-state/red.log)，12/12 为断言失败；修复后相同 12/12 通过。再补已接受 clear/disk-only write 的排空顺序 2 项及正常并行命中 1 项，共 [15/15](../test-tmp/cache-state/green-final.log)。前三类公开方法交错直接复现，无 mock；需要固定磁盘时序的用例只在真实读完/关闭文件后暂停，再执行真实替换/清空。

| 缓存 TDD / 反证阶段 | 实际结果 |
| --- | --- |
| 修复前 Cache.ts，隔离重放最终 15 项 | 14 项断言失败，正常并行命中 1 项通过；没有编译、导入或环境错误充当红阶段 |
| 修复后相同 15 项 | 15/15，0 取消/跳过 |
| 移除异步内存条目身份检查 | 5 个对应交错均失败 |
| 移除状态代次更新 | 6 个磁盘回填/删除反例均失败 |
| 移除失败写入的条目身份检查 | 1 个反例失败 |
| 磁盘读绕过已接受写队列 | 2 个顺序反例失败 |
| 强制所有读取未命中 | 正常并行命中反例失败 |
| 恢复当前 Cache.ts | 15/15，主工作区 Cache.ts 和缓存测试文件哈希始终未变 |

- [隔离重放脚本](../test-tmp/cache-state/replay.mjs) 与 [run-bH8Dhp/report.json](../test-tmp/cache-state/run-bH8Dhp/report.json)：success=true，8 个阶段。旧 Cache 使用前次已保存副本并验证 SHA-256=bbae056552bb3a3eba3a1362fa3ce3dcdb5cd4be3957cee033dbed41ea8212a6；只复制当前 TypeScript 源码/目标测试并替换隔离 Cache，不回滚主工作区。五种选定退化全部被检出，不等同全项目 mutation coverage；该缓存实验在下面 Router 修复之前完成，不能当作完整最终 Gateway 的旧版本重建。
- 完整检查失败过程保留：[第一轮](../test-tmp/check/2026-09-11T02-12-43-939Z-core/report.json) regression 在 300 秒超时，TAP 总结不完整，日志中 MCP architecture/symbol 两项分别触发原有 8 秒超时，最后仍存活的测试子进程属于 resource-cleanup，超时结束后已不存活。未把它报告为完整通过或确定为缓存死锁。随后单独运行 [resource-cleanup 8/8](../test-tmp/cache-state/resource-cleanup-diagnostic.log) 和 [MCP stdio 12/12](../test-tmp/cache-state/mcp-stdio-diagnostic.log) 均通过，首次全套超时的具体根因仍未确认。
- [第二轮完整检查](../test-tmp/check/2026-09-11T02-19-09-748Z-core/report.json) 正常结束但 **447/448**，唯一失败为排队过期请求预期 REQUEST_TIMEOUT、实际 CANCELLED；15 个新缓存回归均通过。调查发现 RequestLease 与 runCode 对同一截止各设置一次定时器，内层先触发会经 Mutex 转成 AbortError，而准入层尚未标记超时，导致分类和计数错误。
- 在 [request-admission.test.ts](../tests/request-admission.test.ts) 新增受控时序：准入后、适配器入队前推进观察时钟，使重复的剩余预算定时器确定先触发；仍要求旧 owner 保持、队列节点移除、REQUEST_TIMEOUT、timedOut=1、cancelled=0。[修复前](../test-tmp/cache-state/deadline-red.log) 确定得到 CANCELLED 并失败。ToolRouter 仅在截止与准入租约相同的时候复用其计时与原因，独立更短的操作仍保留定时器。修复后缓存、准入、请求并发和生命周期取消 [67/67](../test-tmp/cache-state/cache-admission-green.log)；没有延长超时、放宽错误码或降低计数断言。

| 最终源码/构建验证 | 结果与证据 |
| --- | --- |
| 完整核心、类型、Gateway/Native 构建、stdio、delivery | [2026-09-11T02-23-40-026Z-core](../test-tmp/check/2026-09-11T02-23-40-026Z-core/report.json)：**449/449**，0 失败/取消/跳过，43.543 秒；原命令 node scripts/check.mjs |
| 真实 SDK/Gateway 共享缓存 | [run-08Twxo](../test-tmp/shared-cache/run-08Twxo/report.json)：**8/8**，7.589 秒，8 个已观测进程身份，cleanupFailures=[]、survivors=[] |
| 三个正式 Gateway/Roslyn 同时 A/B/A 冷启动与突发/取消 | [run-aQPfmx](../test-tmp/multi-agent/run-aQPfmx/report.json)：**10/10**，12 个已观测身份，survivors=[]；--roslyn-only 仅排除托盘容量，未串行同根启动 |
| E4 公开错误契约 | [run-0H1tDE](../test-tmp/error-contracts/run-0H1tDE/report.json)：**17/17**；生成输入及现有 SDK，不使用真实 UI/外部适配器 |

- 最终交付：Node 24.19.0、项目锁定 SDK 10.0.303；buildId=9e644bce6df5c01716938b5f3c923cc2ba80f71f24a2323abda93de4d149bb88，sourceHash=c9dda2872d859b0061a9464ab5e43091e36be589e9d6796c015b12cbfc907589，artifactHash=35b9990e8accd58e64b14e7b6b46c9576432dc887c0fb1e8bd24db8df1a8b587。delivery contentId=1f86b5a058d22be12e60b1cf2a2b0c823069d7bf239bdf29692d000aea7fd1de，matched=true；15 tools 与 schemaHash=4f8a6424c23978ebffe77111f4687c87336de64320f7d24cde8bdeede8ab804f 保持。revision 仍是 aa6fc7f 加本地未提交增量，不是一个已推送新提交；codexConnectionVerified=false。
- 保留的限制与反证：首次完整运行超时不因随后通过就被解释为已修复；SDK 128 请求突发仍有 11 个 drain 监听器警告，阶段结束为 0，未调整阈值。全套 449 与上述受控场景不证明 Node 22、真实消费者、UI 并发、长期 RSS/原生资源或断电一致性。前次 Host 21/21 仍作为本次 Cache/Router 修复前的结果保留；本次 Native 源码未改，但未再执行完整 21 场景。身份/代次失效允许保守未命中，不增加附件租约或跨进程硬配额。
- 远端与下一步：本轮 10:17 通过现有 gh 只读核对 PR #37 仍为 OPEN、非 draft、head=aa6fc7f、mergedAt=null、mergeStateStatus=BLOCKED；五个必需检查中 Node 22 FAILURE，Node 24 与三项 Analyze SUCCESS。此次修复已在本地完成，不能声称 PR 当前源码已包含修复或可立即合并。下一步在明确提交/推送授权下整理同一 PR 的新提交与描述，再按新 head 核对检查和最终差异；本轮无新增架构/依赖决策。README、CHANGELOG、架构说明、计划和路线图已同步当前结果及历史证据边界。
- 最后复核（10:31）：远端 head、BLOCKED 与五项必需检查结果保持上述状态。git diff --check、当前交付 matched=true、本节 18 个本地链接存在性通过；保留 18 个已跟踪文件修改及 2 个新增文件，含此前所有未提交工作。最终全套通过后未再修改生产源码或测试，只同步说明与验收记录。

## 2026-09-11 11:02 — 截止结果修复、失败收尾验证与合并前本地收口（北京时间）

- 目标与范围：按用户要求继续自审、修复，达到合理的 PR 合并标准，操作不超出工程项目文件夹。保留上一节全部修改；使用现有 Node 24.19.0、项目 SDK 10.0.303 和已安装依赖，测试进程的 TEMP/TMP 指向工程内 test-tmp/project-temp。没有修改全局配置、下载新运行时、调用模型、操作真实消费者或提交/推送/合并。以已确认的固定工作区、准入、缓存及 Roslyn 输出隔离为本 PR 范围，不要求新增共享服务、通用租约、UI 全覆盖或无限负载证明。
- 本次自审：复查 RequestAdmission/OperationContext/McpServer/ToolRouter 的预算和恢复调用链，Workspace 固定根，Cache 身份与代次，Native DesignTimeBuild/OwnedBuildOutputs/WorkspaceSession/WorkspaceInputs，以及 Gateway Host 生命周期、ResourceManager、Repomix/FlaUi 取消传播、CI 和交付边界。保留原架构和公开 15 工具契约；上一节缓存修复没有再改动。
- 新增三个截止反例，均先在正式 [request-admission.test.ts](../tests/request-admission.test.ts) 中失败，再修生产代码：①准入后推进观察时钟，截止检查先于定时器抛出时仍需计入 timedOut；②状态工具完成时已超出截止，不能返回成功；③更短的适配器排队预算不能经 Mutex 被误报为 CANCELLED，且不得执行已过期回调。原 [deadline-red.log](../test-tmp/merge-review/deadline-red.log) 为 3/3 断言失败，0 跳过，错误和计数断言均未放宽。
- 生产修复：[RequestAdmission.ts](../src/Core/RequestAdmission.ts) 的 release 接收实际失败原因，补齐同步截止和较短预算的超时计数；[McpServer.ts](../src/Gateway/McpServer.ts) 执行返回后再检查截止，并将失败传入租约收尾；[ToolRouter.ts](../src/Core/ToolRouter.ts) 在保留显式恢复错误之后检查实际 operation，保留适配器超时分类。相同截止继续复用租约定时器，独立较短截止仍有自己的定时器。取消/超时不提前归还尚在清理的容量，不增加自动重放。相关准入、取消、并发和恢复 [57/57](../test-tmp/merge-review/deadline-green.log) 通过。
- 资源测试失败收尾：[resource-cleanup.test.ts](../tests/resource-cleanup.test.ts) 四个创建 Router/Server 的用例改为创建后立即注册 t.after，在初始化或断言失败时也释放 watcher。隔离故障注入 [verify-cleanup-failure.mjs](../test-tmp/merge-review/verify-cleanup-failure.mjs) 保持正式生产源码，只把目标断言替换为明确的 intentional failure：旧测试 [cleanup-vR6KmS](../test-tmp/merge-review/cleanup-vR6KmS/report.json) 到 4024 ms 仍不能退出/给出完整 TAP；修正后 [cleanup-PUaE5c](../test-tmp/merge-review/cleanup-PUaE5c/report.json) 在 1091 ms 正常以 exit 1 结束，并完整报告 1 个预期失败。正常专项 [8/8](../test-tmp/merge-review/resource-cleanup-green.log)。这证明失败收尾缺陷已修复，不声称首次 8 秒业务超时的全部性能根因已定位。
- 工程内 TEMP 的一次真实失败：[完整检查 02-43-17](../test-tmp/check/2026-09-11T02-43-17-174Z-core/report.json) 为 451/452，唯一失败是非 Git 夹具在工程内创建后，Git 正确发现了父仓库。[process-failures.test.ts](../tests/process-failures.test.ts) 在该夹具作用域内设置 GIT_CEILING_DIRECTORIES、finally 恢复原值，使测试明确模拟非 Git 工作区；未改变生产 Git 行为或全局环境。相关 [6/6](../test-tmp/merge-review/project-temp-green.log)，随后按原命令重跑全套，没有降低并发或延长超时。

| 最终源码上的本地验证 | 结果与证据 |
| --- | --- |
| 核心、类型、Gateway/Native 构建、stdio、交付 | [02-46-37 core report](../test-tmp/check/2026-09-11T02-46-37-493Z-core/report.json)：452/452，0 失败/取消/跳过；44.088 秒；[完整日志](../test-tmp/merge-review/core-check-final.log) |
| 完整非桌面 CI 命令序列 | [acceptance-5hKQAM](../test-tmp/merge-review/acceptance-5hKQAM/report.json)：11 个步骤退出 0，490.255 秒；每项成功回执和前后交付一致，manifest 文件未变化 |
| E4 错误契约 | [run-TW1FjA](../test-tmp/error-contracts/run-TW1FjA/report.json)：17/17 |
| Native Host / Roslyn Gateway | [fixture-o4h1VG](../test-tmp/roslyn-host/fixture-o4h1VG/report.json)：59/59；[run-HR1YxZ](../test-tmp/roslyn-gateway/run-HR1YxZ/report.json)：22/22 |
| 两类 owner-death | [Roslyn 加载](../test-tmp/owner-death/run-dUQFCo/report.json)、[Repomix 工作](../test-tmp/owner-death/run-aRHJzX/report.json)：各 1/1 |
| 手动释放 | [run-RsbRP1](../test-tmp/manual-release/run-RsbRP1/report.json)：10 个 cycles、2 类 scenarios；每轮及最终已观测 survivors=[] |
| 同时 A/B/A SDK/Roslyn | [run-WfBmSB](../test-tmp/multi-agent/run-WfBmSB/report.json)：10/10；survivors=[]；128 突发受理 32、拒绝 96，业务 active/executing/waiting 最终均 0 |
| 完整正式 Host 生产矩阵 | [run-Q5tOWZ](../test-tmp/design-time-production/run-Q5tOWZ/report.json)：21/21，201.575 秒；89 个已观测身份，productionChanged=false、cleanupFailures=[]、survivors=[] |
| 真实 SDK/Gateway 共享缓存 | [run-wJWGon](../test-tmp/shared-cache/run-wJWGon/report.json)：8/8，8.381 秒；8 个已观测身份，cleanupFailures=[]、survivors=[] |

- 报告口径：原聚合脚本的 scenarios 字段只处理 scenarios/observations，因 Host 使用 cases 而显示 0；实际执行及成功判断由原 Host 回执的 21 个 passed cases 证明。手动释放按 10 cycles 和 2 scenarios 分别报告，不混用计数。原始回执保留，不静默改写历史。
- 最终交付：buildId=`ff308c972a7296bce88891287958c73c1c06fd4766c9c6ecab075f302272dad1`，sourceHash=`0a125d874b28457e70e8d231ac65a72b874236798ae5b659eefe88d077adf273`，artifactHash=`308066c6e065f303f85d539c7eaf84ce6a021a4201e5aabab465f83f03c0b519`，delivery contentId=`9ccaeb481c2f716deeb624b2a7de6363663ca3f0f86fed122680a35926af9096`。version=0.15.0 未发布，revision 仍为 aa6fc7f 加本地未提交增量；不能把它当作已推送新提交或已更新消费者。
- 反证与合理边界：SDK 客户端 @modelcontextprotocol/client 的 StdioClientTransport.send 在 128 请求突发时仍出现 11 个 drain 监听器警告，阶段结束为 0；没有抬高阈值或改依赖来掩盖。已返回附件可被未来容量清理删除，磁盘预算是周期清理目标，现有超时不提供 OS I/O 强制终止。短时受控验收不证明长期原生资源、UI 并发、掉电持久性或任意动态项目图；这些不自动成为本 PR 的新增实现条件。
- 合并判断：当前自审发现的代码缺陷已修复，本地 Node 24 核心及非桌面验收完成，未发现需要进一步扩展架构的阻塞缺陷。PR 当前仍不能据此认定可直接合并：工程目录没有现成 Node 22，未下载新运行时；最新本地修复尚未进入远端。最后远端证据仍是前序 10:31 的旧 head aa6fc7f、BLOCKED/Node 22 FAILURE，本段未重新查询远端。后续只需在新 head 上完成仓库必需检查与最终差异复核，不额外设定完美目标。
- USER_DECISION_REQUIRED：依据用户提供的 AGENTS.md 第四节，需要明确提交/推送授权，才能把本地增量送入同一个 PR #37、更新说明并使用现有 Node 22/24 和 CodeQL CI。推荐直接用仓库现有 CI 获取兼容性证据，避免为了这一步新增本地运行时。合并、发布和真实客户端更新不包含在该建议授权中。README、CHANGELOG、架构、计划及路线图已同步本次结果；所有原始 test-tmp 证据仅保留本地。
- 可审阅交付：[PR 说明草案](../test-tmp/merge-review/pr-body.md) 已按最终范围准备，尚未发送；建议标题为 feat: isolate workspaces and Roslyn builds with bounded request admission。[最终汇总](../test-tmp/merge-review/final-receipt.json) 从原始回执独立读取并断言 452 项、各集成场景数和同一交付身份，保留 pending 与 mergeReady=false；没有修改原始报告。汇总脚本为 [summarize.mjs](../test-tmp/merge-review/summarize.mjs)。
- 收尾核对：git diff --check、delivery matched=true、当前文档及本节 59 个本地链接存在性均通过。HEAD 仍为 aa6fc7f；保留 22 个已跟踪修改和 2 个新增文件，包含前序已完成的本地增量。最终核心/非桌面验证之后仅同步说明和本地证据汇总，没有再改生产源码或正式测试。已提出上述提交/推送授权申请，尚未执行外部变更。

## 2026-09-11 11:39 — PR #37 提交与 CI 清理修正（北京时间）

- 用户已授权提交当前版本 PR，随后只读评估近几个版本的工程复杂度。提交 2d4ee56 已推送同一 PR #37，标题和说明已更新；没有合并。
- 该 head 的 Node 24 与三项 CodeQL 通过；Node 22.23.2 为 450 通过、1 失败、1 可选 TavernDesk 跳过。失败位于 owner-process-guard.test.ts 的 finally：Helper 正常退出后仍启动 PowerShell 查询清理，命令超过 5000 ms，被 SIGTERM 终止；JUnit 明确记录 killed=true、code=null、空 stdout/stderr。原始 [CI report](../test-tmp/pr37-ci-2d4ee56/node22/check/2026-09-11T03-29-15-957Z-core/report.json) 与 regression.xml 保留在本机。未把该失败归为生产 OwnerProcessGuard 故障。
- 对直接阻塞交付的问题只修测试收尾：先用 signal 0 检查 PID，只有 ESRCH 才跳过；存活或未知 PID 仍进入原有持句柄/创建时间核验，保持清理预算。正常/repeat 两个既有用例增加 Helper 已退出断言，没有新增测试。依据 [Node process 文档](https://nodejs.org/api/process.html#processkillpid-signal) 的无副作用存在性检查及 [child_process 文档](https://nodejs.org/api/child_process.html) 的 timeout/killSignal 行为。
- 修正后 owner-guard 原 13 项全部通过（13.757 秒），类型检查和 git diff --check 通过；没有重复无关全套或修改生产源码。新的远端 head 仍需取得自己的必需检查结果。复杂度评估不新增设计文档或直接重构，结果在本次回复交付。

## 2026-09-11 — PR #37 共享缓存验收契约修正

- head 3a3d176 的 Node 22 在 13 分 55 秒后因共享缓存第 3 场景断言失败；未触发总超时。核心、真实 Roslyn/清理、多实例和正式 Host 21 项矩阵均已通过。原始 [CI 回执](../test-tmp/pr37-ci-3a3d176/node22/shared-cache/run-ho390i/report.json) 报 No overflow record for A_CURRENT_0，调用内容断言已通过，清理失败及残留均为空。
- 旧验收要求每次有效内存命中后仍能查到磁盘 JSON 索引，超出现有可淘汰缓存契约。Cache.get 在验证内存条目及附件后直接返回；同类 [npm/cacache get 实现](https://github.com/npm/cacache/blob/main/lib/get.js) 也先返回 memoized 数据再查询索引。该参考仅用于核对层次关系，不替代本地验证或引入依赖。
- 在原场景内确定性删除自有索引、保留有效热条目，旧断言复现同一失败（[red](../test-tmp/shared-cache/run-sO4Dlm/report.json)）。修正为验证实际旧附件淘汰、至少一次重建、索引删除后的正确热命中；其余损坏/修改/跨根/退出场景保留，没有新增自动化测试。
- 原共享缓存验收修正后 8/8 通过（[green](../test-tmp/shared-cache/run-F11W1L/report.json)，8.303 秒；observedRebuilds=1，warmReadAfterIndexEviction=true，cleanupFailures=[]、survivors=[]）；node --check 和 git diff --check 通过。生产源码和 CI 超时预算未改，下一 head 的远端必需检查仍待运行。

## 2026-09-11 — CI 冷启动与完整验收预算核对

- head 211799f 首轮 Node 22 的 Tray --endpoint 子进程超过生产代码的 3000 ms 预算，被 SIGTERM 终止，stdout/stderr 为空；同一用例本地 375.322 ms 通过。该轮 restore-host/publish-host 分别 33.773/38.214 秒，前一轮为 6.009/8.338 秒，因此只重跑一次相同 head 的失败任务验证环境/冷启动波动线索，没有修改 Tray 或重复重跑已成功的检查。重跑核心、真实 Roslyn/清理及多实例通过；这不证明 Tray 首次超时的根因已经解决。
- 重跑的 [逐场景回执](../test-tmp/pr37-ci-211799f-retry/node22/design-time-production/run-1wXhX2/report.json) 显示 WPF 等待就绪触发了验收脚本独有的 20000 ms 限制；生产 RoslynAdapter 默认加载预算为 120000 ms。外层 job 同时被 GitHub 的 15 分钟限制取消，检查注释明确为 The job has exceeded the maximum execution time of 15m0s，完整矩阵未完成。不能只把取消解释为业务用例全部正常，也不能用旧 head 的通过替代此次失败。
- 根据上述新证据，将设计时语义验收加载预算对齐既有生产默认 120 秒；Windows CI 整项预算设为 20 分钟容纳冷启动和完整矩阵。共享缓存移至构建后优先运行，SDK 并发和设计时输出各占独立步骤。依据 [GitHub workflow timeout 定义](https://github.com/github/docs/blob/main/content/actions/reference/workflows-and-actions/workflow-syntax.md#jobsjob_idtimeout-minutes) 区分 job 总预算与业务截止；生产请求/查询/清理的超时和取消行为均未修改，没有新增测试或依赖。
- 验证：YAML 解析通过，并比较确认所有验收命令及 Node 条件、job 名称、报告保留设置与修改前一致；脚本语法与 git diff --check 通过。正式发布 Host 的 WPF 定向场景 [run-nKcqEc](../test-tmp/design-time-production/run-nKcqEc/report.json) 1/1 通过，productionChanged=false。新 head 仍需远端完成五项必需检查；当前未合并。

## 2026-09-11 — 合并后共享缓存淘汰验收归属修正

- PR #37 的 e2bce5a 五项必需检查通过并合并为 9fe9ace；随后 main 的 [CI 34563810434](https://github.com/linnnn89/WinCode/actions/runs/34563810434/job/103151717074) 在 Node 22 共享缓存第 3 场景失败。基础构建和回归已通过，失败断言为 evicted backing content must cause a rebuild。此前交付收尾只确认 PR 检查和合并状态，没有等待该次 main 检查。
- 原场景从磁盘索引取得同键并发写入的最终附件，却只观察客户端 A 的重建次数；两个客户端可以各自持有不同但有效的附件。固定为 A 写入、删除自有索引、B 再写入的顺序后，旧断言确定性失败：[red](../test-tmp/shared-cache/run-v1macn/report.json) 记录 A 附件存在、B 附件已淘汰、A 重建次数为 0。该行为符合 Cache.get 对内存条目及其实际附件的校验；[npm/cacache](https://github.com/npm/cacache/blob/main/lib/get.js) 的内存命中先于索引查询也支持两者不能等同的判断，不引入依赖。
- 修正原有场景：由 A 单独创建此前未使用的 Item31 条目，断言磁盘附件就是 A 返回的附件，再执行同样 20 次对端写入和并发读取。仍严格要求实际附件淘汰、至少一次重建、删除索引后的有效热命中，其余损坏、源修改、跨根和退出验收保持原样。仅修改验收脚本及本工作日志，未改生产缓存、超时、依赖或增加测试数量。
- 本地 Node 24：原完整共享缓存验收 [8/8 通过](../test-tmp/shared-cache/run-WDVkcF/report.json)；固定上述双附件顺序后，修正脚本 [8/8 通过](../test-tmp/shared-cache/run-VjL1Cd/report.json)。两次 cleanupFailures 和 survivors 均为空，脚本语法及 git diff --check 通过。Node 22 和本次 PR 的五项必需检查由新 head 的 CI 验证，合并后还需确认 main 新运行；本记录不将待运行检查计为通过。

## 2026-09-11 — 清理旧计划并更新 0.15.0 文档

- 核对本地代码、测试脚本和 main `d51f3e1` 的 [CI](https://github.com/linnnn89/WinCode/actions/runs/34571066627) / [CodeQL](https://github.com/linnnn89/WinCode/actions/runs/34571066444)：PR #37/#38 已合并，Node 22/24 和三项 CodeQL 检查通过，GitHub Release 列表为空。固定工作区、请求限制、独立设计时输出、共享缓存和合并验证已从待办移除。
- 删除重复的迭代路线图，将原详细计划缩减为后续测试清单。保留实际客户端 Roslyn、双连接 UI、未定位的 UI/托盘失败和 SDK 突发请求警告；大项目、长期运行、特殊 MSBuild 项目和异常退出按实际需求测试。旧计划及研究记录可从 Git 历史查看。
- 更新中英文 README，修正架构说明、CHANGELOG 和安全说明中的版本及合并状态，保留原安全维护承诺。第一版写完后按用户要求润色：删去“绝对免疫”“杜绝大模型产生误判”等过度承诺，将“业务闭环”“取证路由”等改为具体操作；同时按源码纠正影响分析字段，未知风险为 riskLevel=UNKNOWN，置信度为 confidence=UNCERTAIN。历史工作日志仅将三处旧路线图或已删除章节的链接改为固定提交链接，原记录文字保留。
- 本机 WinCode Skill 已在前一轮安装并精简入口，Codex 连接已确认运行 0.15.0 / local-text；完整 Roslyn 流程仍需测试。本次只修改文档，未运行代码或桌面测试，未修改受管 Skill、客户端配置或依赖。
- 文档验证通过：扫描 360 处相对链接和章节链接，本次未新增失效链接；历史文档中原有的 64 处失效链接保留原记录。README 的 8 段 JSON 示例均可解析且与修改前完全一致，12 个 npm 命令均存在于 package.json；源码版本 0.15.0、SDK 10.0.303 与配置一致。Markdown 围栏、UTF-8、历史日志正文保留检查和 git diff --check 均通过。变更仅涉及 8 个 Markdown 文件（含删除 1 个），未提交或推送。

## 2026-09-11 — PR #39 的 CI 清理检查超时

- 文档提交 `26d0a42` 的 [CI 34575235538](https://github.com/linnnn89/WinCode/actions/runs/34575235538) 中，Node 24 和三项 CodeQL 通过，Node 22 在 owner-death 测试结束时失败。Roslyn Host 59 项、Gateway 22 项均通过；owner-death 主场景记录 9 个已观察进程、survivors=[]、success=true。
- 失败来自随后执行的兜底清理检查：`terminateObserved` 启动的 PowerShell 子进程触发 8000 ms 超时，报告 `spawnSync powershell.exe ETIMEDOUT`，导致整组测试按既有规则失败。现有记录不能确定超时发生在 PowerShell 启动还是命令执行阶段，也不能证明运行环境抖动就是根因。报告已下载到本地 `test-tmp/pr39-ci-26d0a42-attempt1`。
- 与已通过的 main `d51f3e1` 比较，生产代码和相关测试脚本完全一致。核对了 Node child_process 超时说明，并检索 GitHub runner-images 的相关记录，未找到可直接确认本次根因的同类案例。先记录失败并重新验证，以检查是否为偶发超时；不更改生产代码、测试断言、清理范围或超时时间，不将重跑通过称为根因已修复。合并仍要求当前 PR 提交的全部必需检查通过。

## 2026-09-11 — Agent 导航、上下文恢复与 UI 精简迭代

- 按用户要求把实际 New-tavern 审查中的操作摩擦分成四阶段实施：上下文恢复与摘要、限定范围的代码导航、独立连接引导、UI 精简与展开。改动位于 WinCode 工作区；没有增加依赖或修改应用数据库。保留已有文档工作，本轮未提交或推送。
- 上下文 EOF 错误保留原始缺口，附实际行数及有效交集的续读请求；起点已超过 EOF 或文件不存在时不盲目重试。最终序列化后生成范围明确的 summary，普通文件开头片段也可续读。原有 512-token 字符估算预算、半行覆盖和未知任务覆盖语义保留。
- 新增 wincode_search_text / wincode_file_outline：字面量搜索、排他文件/目录范围、重叠文件去重、同次读取的行数/字节数和声明概览、可执行的源码续读参数。复用有界 LocalTextScanner；越界范围在读取前拒绝，实际链接再核对真实路径，词法/编码/文件大小等问题按文件报告并保留省略数。导航不启动语义 Host。
- WORKSPACE_MISMATCH 返回 connectionGuide；CLI --print-connection --workspace 输出同一默认 local-text 配置。真实 STDIO 验证从 A 的错误响应直接启动 B，并分别读到 A/B 标记；打印配置不创建目标缓存，不注册或重启客户端。
- UI 增加显式 compact 格式，默认 full 保持兼容。控件 ID、层级、状态及图片保留，节点几何和类名可用 expansionRequests 恢复，重复 C# 候选用 candidateIds 共享。同一六控件夹具中 full=13165、compact=8750 字符，约减少 33.5%；图片字节和节点 ID 不变。这不是普遍 token/延迟收益或长期性能结论。
- 各阶段先执行失败场景再实现：EOF 缺少实际行数/续读、导航工具缺失/词法失败不具名、生产错误缺少可用连接配置、UI 精简仍返回几何及重复候选。相关集合分别通过 36、59、8、37 项检查，集合有重叠，不相加。新增两个 it 场景，其余扩展既有测试及生产 STDIO 驱动。
- 首次完整 core 检查：452/454，通过的实现之外有两处旧测试仍期望 15 个工具；更新为 17。记录：test-tmp/check/2026-09-11T07-58-37-514Z-core/report.json。第二次：453/454，唯一失败为旧恢复测试把整个仓库扫描计入 4 秒阈值，实际 4108 ms；记录：test-tmp/check/2026-09-11T08-02-02-436Z-core/report.json。将该测试改为隔离项目、真实 MCP 调用和实际恢复状态断言，定向通过 1/1；确认排空时 inFlight=0、监听器恢复、后续健康确认不再次排空。没有放宽时间阈值，也没有第三次全量重跑；原始完整检查报告仍保留失败状态。
- 首次 desktop 集合 34/35：新增断言误认为按钮只有一个节点，UIA 实际还返回内部文本。改为对照独立原生计数，定向重跑真实 WPF 流程通过 1/1：compact 候选续读、full 展开恢复真实几何、定位判定方法、隔离副本修改/重新编译后同按钮由禁用变为可用；原仓库夹具哈希保持。记录：test-tmp/check/2026-09-11T08-08-23-380Z-desktop/report.json，原始失败未改写。
- 后续验证通过：最终类型检查；新生产 STDIO 的 17 工具/Schema、搜索到源码、文件概览与 EOF 修正；17 个错误契约场景（test-tmp/error-contracts/run-10DlYB/report.json）；桌面 owner-death（test-tmp/owner-death/run-0toZoN/report.json）；WinForms/Named Pipe 托盘（test-tmp/tray/run-WQWlW7/report.json）；实际 Roslyn 托盘工作流（test-tmp/tray-workflow/run-TuKjVN/report.json）。未重新跑已通过的完整集合，也未把分项通过写成单次全量全绿。
- Gateway/原生 Release 构建完成，交付清单生成与核验 matched=true，contentId=6bc3f0e6aae0d0726a801897581801b8a27e019e3ad71234f49463f2346af106。生产新实例 buildId=866c93db7b87c8a5a5f5975f8c81ad601b01c02477a562b837414fbd9f344ba3，Schema=96d30bd506af37f08afcc02025ed3254d9ba2b9bd6f71732a31ad1a8f749f876。构建基于 8e4b70c 加当前未提交源码，版本仍为 0.15.0 未发布。
- 四份受管 Skill 已备份后同步，安装入口保留精简写法，skill check matched=true；备份在 C:/Users/6/.codex/skills/.wincode-backup-948552f4-4d0b-4c9d-b2ce-3ba47349bba0。当前 Codex 连接仍为实例 4a6e5836-c683-4602-8ddf-696ebcd7d94e、旧 buildId=ff308c972a7296bce88891287958c73c1c06fd4766c9c6ecab075f302272dad1、15 工具且无 UI responseFormat。需要正常刷新连接才能加载新 Schema；未修改 MCP 配置或自动重启。Node 22/远端 CI 和当前 Codex 新接口使用尚未验证。

## 2026-09-11 — 导航与 UI 功能提交前复核

- 按用户确认开始收尾。将原目录 31 个修改文件和 3 个新文件完整保存为本地快照 da2d394，备份分支 codex/backup-navigation-before-delivery-20260911；从 main de14850 建立独立 worktree 和 codex/navigation-delivery-20260911，迁移后 Git tree 与快照一致。原目录保留，依赖和精确 SDK 复用本机现有安装。
- 复核搜索范围、真实路径、扫描与序列化预算、取消传播、EOF 续读、UI 精简/展开和默认 full 兼容。未发现需要增加产品代码修改的缺陷；两份 Skill 手册的 inputPolicy 仍写 1，与 WorkspaceSession 和 RoslynAdapter 的实际版本 2 不符，已改正。未增加依赖、测试或架构层次。
- 本地 Node 24.19.0：Gateway 构建和类型检查通过；上下文、导航、扫描、工具契约与 UI 候选集合 86/86；生产固定工作区集合 8/8；修订后的 MCP 恢复场景 1/1；真实 WPF 源码修改与重编译流程 1/1。正式 STDIO 的 17 工具、搜索/概览/EOF 续读、错误契约 17 场景通过。原生三组件经锁定 restore 和正式 Release 发布，交付清单校验通过。原始失败记录保留；本轮未重复完整本地 core/desktop 集合，完整兼容性检查交给最终 PR 提交的 CI。分阶段回执：test-tmp/navigation-delivery/report.json。
- 实际 Codex 连接已在本次核对前刷新：实例 44103150-ef65-41e1-9f61-db8162ef752f，17 个工具、buildId=866c93db7b87c8a5a5f5975f8c81ad601b01c02477a562b837414fbd9f344ba3，与独立 worktree 构建相同。通过该连接完成限定目录搜索、文件概览、按返回请求读取 25/25 行；针对本轮启动的隔离 WPF 窗口完成 compact 读取及 full 展开，原生查询唯一，控件状态和几何恢复正确。回执：test-tmp/navigation-delivery/live-client.json。未改 MCP 配置；源码和 Schema 无后续变化，不要求再次重启当前连接。
- 安装的 Skill 已通过既有脚本备份并同步，仅更新两份手册的策略版本，入口仍为 22 行；备份 .wincode-backup-946fa519-9d5c-4008-ba14-e3ac6fdf27dd，校验 matched=true。最终 PR-head 的 Node 22/24、三项 CodeQL 和合并后 main 检查仍待运行；不沿用 PR #39 的成功结果。

## 2026-09-11 — 合并后 Node 22 失败与 worktree 浏览修正

- PR #40 的最终提交 7ceeeff 在 Node 22/24 和三项 CodeQL 首次检查全部通过后合并为 0944051；随后 main CI 34584238856 的 Node 22 回归失败。唯一失败项为 Tray 端点解析，耗时 3049.8471 ms，原生进程因生产 resolver 的 3000 ms 超时被终止；尚无证据区分 .NET 冷启动、系统负载或其他启动延迟。
- 将已有的真实端点断言从并行回归移到现有生产 STDIO 阶段，调用编译后的生产 resolver，并将实际耗时写入 check 报告。生产超时、版本与管道断言不变；失败仍阻断 check，无跳过或自动重试。其余九项 Tray 协议测试保留。Node 官方文档说明测试文件默认通过子进程并行运行：https://nodejs.org/download/release/v22.23.2/docs/api/test.html；本调整减少测试启动竞争，不声称已经确定所有端点超时的根因。
- 本地第一次完整 check 失败于原有目录树断言：worktree 的 .git 是文件，现有目录过滤没有排除它。Git 官方说明此布局：https://git-scm.com/docs/git-worktree。新增一个临时文件回归先复现失败，再仅补充 .git 文件的默认排除；includeIgnored=true 仍能列出该文件。相关浏览测试 17/17 通过。
- 最终一次本地完整 check 通过：Node 24.19.0，454/454、无跳过；生产 STDIO 的 Tray 端点 251.4701 ms、17 工具与导航/EOF 检查通过；三组件正式构建和交付清单验证通过。报告 test-tmp/check/2026-09-11T09-42-37-700Z-core/report.json。先前失败报告 test-tmp/check/2026-09-11T09-37-13-728Z-core/report.json 保留。未再次运行无关 desktop 集合。
- 本次修改不增加依赖或架构层次。远端最终 PR-head 和合并后 main 检查仍待运行；当前 Codex 连接已验证 PR #40 的导航与 UI 行为，但最后这条目录过滤需要下一次正常连接加载新构建。
