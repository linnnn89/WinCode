# 窗口与 UI 取证

UI 工具同样占用每实例 32 个业务受理槽；既有 UI/健康探测互斥保留，排队消耗请求预算。SERVER_BUSY 不表示已启动 Helper，不自动重试。hwnd 最长 32 字符；原始参数合计受 64 KiB UTF-8 JSON 预算限制。

0.16.0 中，每个 Gateway 的源码范围固定于启动根；换项目选择对应连接。目标 PID/HWND 不是工作区身份，UI 源码候选仍按所选连接解释。可选托盘与 UIA 取证 Host 独立，退出托盘不终止 MCP 或卸载正在使用的 Roslyn；手动释放仅影响选定实例的 Code Host。源码缓存修复不证明 UI 候选对应同一运行时状态，多实例窗口隔离仍需单独验收。

## 规范字段

混合只读编排实验分支 `codex/hybrid-readonly-orchestration` 提供客户端 TypeScript 入口 `WinCodeSession.readonlyUiWorkflow(target, program, options)`。适用于能执行受信任客户端程序的宿主：先列出窗口并明确选择 PID/HWND，然后在程序内串行调用 `reader.inspect`／`reader.review`，按明确状态决定是否继续，并返回 findings。入口复用会话，关闭时取消编排并等待收尾；同时处理返回的 `isError`、步骤完整性及全部原生内容块。此能力只在该实验分支提供，使用前核对本机交付源码；详细契约见交付目录的 `docs/hybrid-readonly-orchestration.md`。普通 MCP 和终端 JSON 会话按下面的既有工具字段调用。

参数名称区分大小写；额外字段仅被容忍和忽略，不会被当成筛选条件。不能把 `automationID`、`AutomationId` 或 `title` 当作下面的规范字段。数字、布尔值必须使用真正的 JSON 类型。

| 工具/字段 | 类型与约束 |
| --- | --- |
| `wincode_ui_list_windows` | 所有字段可选：`pid` 为整数 1–2147483647；`processName`、`titleContains` 为非空字符串、最长 128；`maxWindows` 为整数 1–100，默认 30。筛选同时满足，`processName` 不带 `.exe` |
| `wincode_ui_inspect.pid` | 可选正整数；与 `hwnd` 至少提供一个 |
| `hwnd` | 可选非空字符串，十六进制如 `"0x123ABC"` 或十进制字符串；不能传 JSON 数字 |
| `capture` | 可选字符串 `none/original/annotated`，默认 `none` |
| `responseFormat` | inspect/review 可选 `full/compact`，默认 full；只影响 Gateway 输出，不改变原生取证或执行 UI 操作 |
| `maxDepth` / `maxNodes` | 可选整数，分别为 1–50（默认 6）、1–5000（默认 300） |
| `backgroundOnly` | 可选布尔值，默认 `false`；为 `true` 时必须同时提供 `pid` 和 `hwnd` |
| `readStates` | 可选布尔值，默认 `false`；只读状态，不执行动作或读取输入值 |
| `query` | 可选对象；至少有一个规范定位字段 `automationId/name/controlType`，每个为非空白字符串、最长 256；可选 `maxSearchNodes` 整数 1–5000、默认 1000，`maxMatches` 整数 1–20、默认 10。仅有未知字段不构成有效查询 |
| `wincode_ui_click` | `pid`/`hwnd` 至少一个；`targetAutomationId`/`targetName`/`targetControlType` 至少一个，每个为非空白字符串、最长 256 |
| `wincode_ui_set_expanded` | 实验分支：同 click 的定位字段，必填 `expanded` 布尔值；只用 ExpandCollapsePattern 明确设置展开／折叠，已处于所需状态时不操作；需要 inspectionVersion 4 Host |
| `wincode_ui_type` | 具备上述 click 的全部字段，另必填 `inputText`（最长 4096；mode=type 必须非空，mode=setValue 允许空字符串以清空值）；可选 `clearBefore`（布尔，默认 false，仅 mode=type 有效）、`mode`（`type`/`setValue`，默认 `type`） |
| `wincode_ui_review` | 接受上述 inspect 的全部规范字段，另必填 `candidateFiles`：1–16 个相对 `.xaml` 路径、每项最长 512；可选 `candidateCodeFiles`：1–8 个相对 `.cs` 路径、每项最长 512；可选 `textQueries`：最多 5 个非空字面字符串、每项最长 80 |

候选路径必须在工作区内，不得包含通配符或父目录逃逸；参数合法不保证文件存在或运行窗口与源码对应，仍检查结果中的缺口。`query:{automationId:"SaveButton",maxSearchNodes:1000}` 是规范示例；`query:{automationID:"SaveButton"}` 缺少规范定位条件，仍会报错。没有未列出的 UI 工具别名。

## 选择目标与取证

首轮可以显式传 `responseFormat:"compact"`；默认 `full` 保持兼容。精简格式保留全部已返回控件的 ID、层级、名称、AutomationId、状态和同一截图，省略节点 bounds/relativeBounds/className；`summary` 仅统计已返回快照中的无名称按钮、禁用控件和树缺口，不把这些观察自动判为缺陷。需要坐标或更完整信息时使用 `expansionRequests` 中的 tool/arguments；它们重新观察实时 UI，ID 可能变化，查询仍须检查唯一性和完整性。

精简 `codeEvidence.candidates` 是去重后的候选表，`clues[].candidateIds` 引用其 id，候选自身的 `nextRequest` 只保存一份；full 格式仍是 `clues[].candidates`。两种格式都保留运行时/源码身份未验证、歧义、截断与扫描边界。不要把 candidate id 当成源码的持久身份。

已知准确 PID/HWND 就直接使用；未知时调用 wincode_ui_list_windows，以 processName（不带 .exe）、pid 或 titleContains 缩小范围，maxWindows 建议 10。筛选同时满足。候选歧义时先确认目标，标题不证明源码归属；失效句柄才重新发现。

对用户指定窗口调用 wincode_ui_inspect，例如（编号必须替换为真实结果）：

```json
{"pid":12345,"hwnd":"0x123ABC","backgroundOnly":true,"capture":"none","maxDepth":4,"maxNodes":100}
```

只查指定控件时增加 query，例如 {automationId:"SaveButton",controlType:"Button"}；automationId/name/controlType 为区分大小写的精确 AND 条件。搜索默认 1000 节点（上限 5000）、最多返回 10 个候选（上限 20），独立于子树 maxNodes；另有 2 秒/50 层软限制，整个 Helper 仍有硬超时。
queryResult.searchComplete=true 且 status="unique" 才展开子树；ambiguous 返回多个候选，incomplete 不证明唯一，not-found 只限本次搜索范围。treeComplete 仅描述返回子树结构；propertyIssues 单独说明属性不支持、错误或裁剪。节点 id 只在本次结果有效，不作为下次定位凭据。
工具响应 `success:true` 与任务已得到有效观察分别判断：返回 `not-found` 时没有目标状态，不能当作 Off 或统计零。先确认正确页面及折叠／展开状态，再判断是否需要新的观察；运行源码有 AutomationId 不证明当前 UIA 树已暴露该控件。
需要勾选/选中/展开状态时传 readStates=true；states 的 unsupported/unknown 不等于 false，不读取输入框值或执行操作。截图仍是整个目标窗口，局部查询只缩减树和标注范围。旧 Host 不支持时应更新构建，不移除查询参数冒充成功。

先取足够的小树，出现相关截断再增预算。需要看视觉布局才用 capture="original"；需要对应节点编号用 "annotated"。图片直接消费 MCP image 块，不把 Base64 转贴为文本。

后台取证保持 backgroundOnly=true 并同时传 PID/HWND，避免游戏或其他遮挡窗口污染屏幕回退。不要为截图抢前台、还原窗口或操作游戏。PrintWindow 成功仍可能黑屏/陈旧；检查 captureMethod、captureQuality、imageOmitted 与截断。最小化不支持；整个 Helper 超时可能无树，不无界重试。

captureQuality 在标注前检查原始像素，最多采样 1024 点；suspect-low-variation 表示采样 RGB 各通道范围不超过 3，可能是空图，也可能是正常纯色或低对比界面。unknown 不表示图片合格；采样可能漏掉局部内容。提示不丢弃原图或 UIA、不自动切换截图方式。旧 Host 未提供该字段时按未验证处理。

需要源码候选时，确认源码工作区后改用 wincode_ui_review，一次取得快照与证据；无需先 inspect 再重复截图。沿用上述参数，增加 candidateFiles:["Views/MainWindow.xaml"]，必要时 textQueries:["保存"]。
- 候选为 1–16 个工作区内相对 XAML 路径；只传相关文件。
- textQueries 最多 5 个、每个 80 字符，字面量且区分大小写。
- 行号/哈希/AutomationId 候选不证明运行时版本；runtimeSourceVerified=false，保留 ambiguous、unsupported、not-found 等边界。
- 已知相关 C# 文件时可加 candidateCodeFiles:["ViewModels/MainWindowViewModel.cs"]，1–8 个工作区内相对 .cs 路径。codeEvidence 提供 Click/简单 Binding 的文字声明/赋值候选；按实际线索使用其 nextRequest 续查 prepare_context，并核对目标正文。
- 不传 candidateCodeFiles 不读取 C#。单文件 256 KiB、总计 1 MiB，线索/匹配/JSON 均有限额；检查 fileScanComplete、searchComplete、truncated 和省略原因。候选文件无匹配不证明全仓不存在。
- runtimeBuildSourceIdentity=unknown、templateResolution=unsupported；不推定 DataContext 或 CanExecute，也不把构造参数相似当执行链证明。多个同名声明继续保留歧义，不能自动选择首项。
- nextRequest 先读候选所在精确行；relatedSymbol 仅为构造参数文字线索，可能是变量。核对赋值后再明确请求方法，不能因该字段自动认定为方法或完整调用链。复杂插值原始字符串/超出嵌套限制的文字扫描报告不支持。

多个控件若指向同一文件、相邻赋值，可在确认文件未变化后复用当前会话已展示的精确行；有缺口时合并为一次有界 lineRanges 请求。不要因为每个候选都带 nextRequest 就机械重复读取。复用仅限已经核对的正文，不代表这些运行时 UI 证据获得了跨调用有效期保证，也不扩大运行时绑定结论。

## 操作方式与授权

实验分支的展开导航独立于只读取证。目标缺失时先区分完整搜索无匹配、搜索不完整和歧义；只用用户授权范围内的实际父级名称／标识提出候选，不把所有 not-found 当成折叠。`wincode_ui_set_expanded({pid,hwnd,targetName,targetControlType,expanded:true})` 在完整唯一搜索、启用且明确 Expanded／Collapsed 状态成立后才受理；不支持、未知状态或歧义时拒绝，不回退为 click／坐标／焦点。动作回执只表示调用被接受，之后必须读回展开状态及原子控件。超时或失败不自动重放。

客户端 `WinCodeSession.expandUiWorkflow(target,{parentQuery?,childQuery},options)` 接收目标复选框查询，可选明确父级候选；共用固定 PID/HWND、15 秒默认总预算（上限 30 秒）。提供父级时最多 5 次调用；省略父级时最多 6 次。保存首次查询，诊断父级根状态；Collapsed 才设置 Expanded 一次，随后要求完整父级树证明子控件归属，再单独读回子控件的真实 toggle 状态。根状态诊断有意只返回一层，允许仅 maxDepth 截断；这不代表父级子树完整，最终验证仍要求完整子树、唯一匹配和无属性／遍历问题。它不会递归探索任意菜单，且可能因较大的父级树超预算而停止。普通 `readonly-ui` 不触发任何导航动作。

**省略父级的有限发现。** 目标已唯一可见且取证完整时，直接读取，只有 1 次调用。完整搜索未找到目标时，在同一窗口搜索 `Group`（最多搜索 1000 个节点、20 个匹配）；仅当搜索完整、状态已知，且存在唯一启用的 Collapsed Group，才使用实际名称／AutomationId 和类型重新定位并尝试展开。候选唯一不能证明目标在其中，仍须后续归属验证。多个候选返回 `NAVIGATION_CANDIDATE_AMBIGUOUS` 和 `diagnosis.candidates`，由调用方依据额外证据提供 `parentQuery`；零候选、搜索不完整、状态未知或候选无可用标识均停止，不执行点击回退。这个试点只覆盖 Group，不遍历菜单、Tab、TreeItem，不证明任意导航发现能力。

先按任务选定模式，再调用。

| 任务 | 用法 |
| --- | --- |
| 查看界面、定位控件 | `wincode_ui_inspect` |
| 语义点击、勾选、选择条目 | `wincode_ui_click`：Invoke/Toggle/SelectionItem，不先请求焦点；应用响应仍可能激活窗口 |
| 后台写入或清空输入框 | `wincode_ui_type` 且**显式**传 `mode:"setValue"`：ValuePattern，不请求键盘焦点；应用事件仍需验证 |
| 验证逐键输入、快捷键、IME 行为 | `wincode_ui_type` 的 `mode:"type"`：需要前台授权 |
| 控件不支持 ValuePattern 的后台写入 | 报告该步骤无法后台完成，不自动改走键盘输入 |

用户要求执行或测试明确的界面流程时，自主完成定位、点击、输入与结果检查，不为每个常规步骤重复确认；用户只要求评估、查看或审查时保持只读。动作会改变目标应用状态，按影响判断是否需要额外确认：超出任务范围的发布、发送、删除或真实业务提交，先说明再执行。

后台与前台的判断先遵循 [SKILL.md](../SKILL.md) 的独立注意事项：`backgroundOnly` 仅约束 inspect/review 的取证方式，不是动作的禁止激活开关；工具不先请求焦点，不代表目标应用的导航、事件或弹窗不会激活窗口。只授权后台时，不以启动、恢复窗口或聚焦补救失败；已知会激活的动作没有前台授权就停止该步骤。

`mode:"type"` 会向目标控件索取键盘焦点（UIA SetFocus），可能把该窗口带到前台并中断用户当前输入，因此只在用户授权前台交互时使用：

- 用户只授权后台测试时固定用 `setValue`，不因为 `type` 更接近真实输入而擅自切换。
- 授权前确认用户当前没有正在使用该应用。用户正在游戏、聊天（QQ/微信）、会议或演示中时，不索取焦点，也不建议用户为此切走；说明需要前台键盘输入并询问何时方便，由用户决定。
- 授权后由用户把目标窗口切到前台，工具只做一次焦点确认。`FOCUS_FAILED` 表示当时没有确认到焦点：报告它并等用户处理，不重复重试，也不用脚本、快捷键模拟或窗口置顶代替用户切换。
- 前台路径只为验证键盘相关行为；业务结果仍用后台 `inspect` 复核。

## 语义操作

`wincode_ui_click` 与 `wincode_ui_type` 只操作同一次有界搜索证明唯一的控件，命中 0 个或多个时不做任何操作。选择器沿用取证时的 `targetAutomationId`/`targetName`/`targetControlType`（区分大小写的精确 AND 条件）与同一个 PID/HWND。

执行一个动作：

1. 用当前 UI 证据确定目标与预期结果；已有可靠 PID/HWND 就直接用，窗口关闭或句柄失效才重新列窗。
2. 动作后检查预先确定的结果：控件状态、页面变化、新窗口或提示文本。需要等待时做有界只读检查，不重发原动作。
3. 结果符合预期才继续；验收条件满足后停止。观察不到就报告未验证，不把 `success:true` 当成测试通过。

只用 UIA 控件模式与键盘输入：不做坐标鼠标模拟，不以 Shell 方式激活、还原或置顶窗口。结果回报 `actionMethod`（`InvokePattern`/`TogglePattern`/`SelectionItemPattern`/`ValuePattern`/`keyboard:type`/`keyboard:clear+type`）、`actionTarget` 与 `inputLength`；**不回显输入文本**。`clearBefore` 仅 `type` 有效，`setValue` 传空字符串即可清空值。

| 情况 | 处理 |
| --- | --- |
| `TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS` | 重新观察并收紧选择器，有新证据后再试；不逐个试点 |
| `TARGET_SEARCH_INCOMPLETE` | 扩大预算或收窄范围，不把已有的单个匹配当成唯一 |
| `TARGET_DISABLED` / `NO_CLICK_PATTERN` / `NO_VALUE_PATTERN` / `VALUE_READONLY` | 检查流程前提，或改用受支持的路径 |
| `FOCUS_FAILED` | 保持后台约束；只有已授权前台交互时才考虑前台路径 |
| `ACTION_FAILED`、执行中超时或取消 | **可能已经部分完成**：`type` 的 `clearBefore` 可能已清空旧内容，`click` 的调用方也可能已执行一部分；先只读观察实际状态，再决定继续、修正或报告 |
| `SERVER_BUSY` 等繁忙拒绝 | `workStarted:false`，未启动 Helper；按诊断手册处理，不自动重放 |

只有 `TARGET_*`、`TARGET_DISABLED`、`NO_*_PATTERN`、`VALUE_READONLY` 与 `FOCUS_FAILED` 发生在实际调用之前；`ACTION_FAILED` 不等于未执行。常见失败不必都交还用户：勾选失败后先读勾选状态，已达到目标就不再 toggle。

操作与只读取证共用受理槽、互斥、超时与 Helper 回收；请求在收尾阶段过期时仍返回已完成动作的真实结果。审计 `op` 记为 `click`/`type`/`setValue`。旧 Helper 不具备该能力时按 `VERSION_MISMATCH` 拒绝，不把参数改成普通 inspect 冒充成功。

内置 Host 强制显示半透明 REC/WinCoding 标志并记录极简审计，不绕过。审计提示按诊断手册处理。启动测试应用时使用专用隔离数据模式；已有固定测试 profile 时复用它，禁止使用个人数据库。
