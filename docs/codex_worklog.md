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

- 按用户要求在根目录新增 [WinCode v0.6运行时UI取证实施方案](../WinCode%20v0.6运行时UI取证实施方案.md)，保存完整范围、架构、协议、生命周期、截图预算、测试与后续路线。
- 文档明确为参考方案，v0.6 仅 UI 取证，v0.7 源码联动后置；未实施功能、安装依赖或控制真实应用。
- 验证：文件已生成，核对章节结构；本次仅文档变更，不运行代码测试。

## 2026-09-07 14:00（北京时间）— WinCode v0.6 运行时 UI 取证全量实施交付

- 目标：按照 [WinCode v0.6运行时UI取证实施方案](../WinCode%20v0.6运行时UI取证实施方案.md)，完成 Windows 桌面应用程序 UI 自动化取证功能（C# FlaUI.UIA3 Host、TypeScript UiContracts & FlaUiAdapter、MCP 工具 `wincode_ui_inspect` 及 ToolRouter 深度集成）。
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
