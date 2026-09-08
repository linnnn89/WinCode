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
- 交付：[WinCode-迭代路线图.md](../WinCode-迭代路线图.md)。包含 R1–R9 目标、最小范围、代码落点、验收反例、GitHub 五项经验、暂缓项和后续 USER_DECISION_REQUIRED。补充同会话诊断与真实宿主验收区别、最终正文范围覆盖、Node 20+ 迁移门槛；不为 Inspector 额外安装或升级环境。
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
