# 窗口与 UI

按任务选择：[只读取证](#选择目标与取证)、[复选框与列表分组](#只读配方)、[语义操作](#操作方式与授权)、[有限展开](#展开并读回)。需要启动客户端时读[会话入口](diagnostics.md#skill-按需会话)。

## 选择目标与取证

1. 已知有效 PID/HWND 就直接使用；未知时用 `wincode_ui_list_windows` 按进程或标题筛选，`maxWindows:10` 通常足够。多个候选先消歧，失效句柄再重新发现。
2. 只查控件用 `capture:"none"`；需要视觉布局用 `"original"`，需要节点标号用 `"annotated"`。后台取证同时提供 PID/HWND 和 `backgroundOnly:true`。
3. 首轮可用 `responseFormat:"compact"`、小范围 query 和适当深度。根据相关截断增加预算；需要几何字段时使用返回的 `expansionRequests` 重新读取。

以下编号均为占位，须替换为实际观察值：

```json
{"pid":12345,"hwnd":"0x123ABC","backgroundOnly":true,"capture":"none","responseFormat":"compact","query":{"name":"保存","controlType":"Button"},"maxDepth":4,"maxNodes":100}
```

`query` 的 automationId/name/controlType 是区分大小写的精确 AND 条件。只有 `queryResult.searchComplete:true` 且 `status:"unique"` 才证明本次范围内唯一；not-found 不表示 Off，incomplete 不证明不存在。搜索预算与返回子树预算分别计算。

`treeComplete` 描述本次子树遍历，`propertyIssues` 描述属性缺口。节点 id 只在该次结果有效。需要勾选、选中、展开状态时才传 `readStates:true`；unsupported/unknown 不等于 false。compact 保留名称、身份、层级、状态和缺口，省略部分几何字段；图片直接读取 MCP image 块。

截图仍覆盖整个目标窗口，scope/query 只缩小树范围。PrintWindow 可能返回黑图或陈旧内容；核对图片及 captureMethod、captureQuality、imageOmitted。suspect-low-variation 是像素提示，unknown 也不证明图像有效。最小化、取图失败时报告限制，不为截图恢复或激活窗口。

## 规范字段

| 工具/字段 | 类型与约束 |
| --- | --- |
| `wincode_ui_list_windows` | 所有字段可选：`pid` 为整数 1–2147483647；`processName`、`titleContains` 为非空字符串、最长 128；`maxWindows` 为整数 1–100，默认 30。筛选同时满足，`processName` 不带 `.exe` |
| `wincode_ui_inspect.pid` | 可选正整数；与 `hwnd` 至少提供一个 |
| `hwnd` | 可选非空字符串，十六进制如 `"0x123ABC"` 或十进制字符串；不能传 JSON 数字 |
| `capture` | 可选字符串 `none/original/annotated`，默认 `none` |
| `responseFormat` | inspect/review 可选 `full/compact`，默认 full；只影响 Gateway 输出，不改变原生取证或执行 UI 操作 |
| `scopePath` | inspect/review/setExpanded 可选；1–50 个父选择器，每项只含 automationId/name/controlType，至少一个非空精确条件。每一步唯一定位上一范围的严格后代，最后在该父级内查询／展开；需要 inspectionVersion 5。click/type 暂不接受 |
| `maxDepth` / `maxNodes` | 可选整数，分别为 1–50（默认 6）、1–5000（默认 300） |
| `backgroundOnly` | 可选布尔值，默认 `false`；为 `true` 时必须同时提供 `pid` 和 `hwnd` |
| `readStates` | 可选布尔值，默认 `false`；只读状态，不执行动作或读取输入值 |
| `query` | 可选对象；至少有一个规范定位字段 `automationId/name/controlType`，每个为非空白字符串、最长 256；可选 `maxSearchNodes` 整数 1–5000、默认 1000，`maxMatches` 整数 1–20、默认 10。仅有未知字段不构成有效查询 |
| `wincode_ui_click` | `pid`/`hwnd` 至少一个；`targetAutomationId`/`targetName`/`targetControlType` 至少一个，每个为非空白字符串、最长 256 |
| `wincode_ui_set_expanded` | 同 click 的定位字段，必填 `expanded` 布尔值；只用 ExpandCollapsePattern 明确设置展开／折叠，已处于所需状态时不操作；需要 inspectionVersion 4 Host |
| `wincode_ui_type` | 具备上述 click 的全部字段，另必填 `inputText`（最长 4096；mode=type 必须非空，mode=setValue 允许空字符串以清空值）；可选 `clearBefore`（布尔，默认 false，仅 mode=type 有效）、`mode`（`type`/`setValue`，默认 `type`） |
| `wincode_ui_review` | 接受上述 inspect 的全部规范字段，另必填 `candidateFiles`：1–16 个相对 `.xaml` 路径、每项最长 512；可选 `candidateCodeFiles`：1–8 个相对 `.cs` 路径、每项最长 512；可选 `textQueries`：最多 5 个非空字面字符串、每项最长 80 |

字段名和类型按表传入，不把 automationID 当作 automationId，也不用字符串代替数字或布尔值。原生接口可能忽略额外字段；调用成功不证明未知参数生效。客户端配方拒绝额外字段。

UI 请求原始 JSON 总计上限 64 KiB，hwnd 最长 32 字符。query 搜索另有 2 秒／50 层软限制，仍受 Helper 总超时约束。源码候选路径必须是工作区内字面路径，不能含通配符或父目录逃逸。

## 父范围定位

`scopePath` 来自实际观察。每一步唯一定位上一范围的严格后代，可跳过布局包装，不能重复匹配当前根；每次调用重新解析。没有 query 时返回末级范围树；有 query 时可匹配该根及其后代。

检查 `scopeResult.status:"resolved"` 和 resolvedCount；失败的 failedIndex 从 0 开始。`SCOPE_NOT_FOUND`、`SCOPE_AMBIGUOUS`、`SCOPE_SEARCH_INCOMPLETE` 分别表示缺失、多义和搜索不完整，不回退整窗。路径需要 inspectionVersion 5，旧连接不能通过删掉范围继续操作。

路径不会展开隐藏父级。若分组标题和条目是同级节点，用下方 sibling-range 读取逻辑分组，不把标题伪装成原生父节点。

## 只读配方

配方在客户端调用既有 MCP 工具。SDK 入口为 `WinCodeSession.readonlyUiRecipe(target, recipe, parameters, options)`；JSON CLI 使用 `action:"readonly-ui"`。固定 target 为 PID/HWND，timeoutMs 默认 15000、范围 1–30000；每次结果检查 isError、report.success、steps 和 findings。它们不执行界面动作。

### checkbox-audit

```json
{"id":"audit1","action":"readonly-ui","recipe":"checkbox-audit","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"scopePath":[{"automationId":"settings"}],"regionAutomationId":"checks","checkboxAutomationIds":["optionA","optionB"]},"timeoutMs":15000}
```

- 必填 regionAutomationId，另选 checkboxAutomationIds 或 checkboxSelectors，不能同时提供。ID 模式接受 1–64 个不重复的 ID；目标须在区域内唯一，类型为 CheckBox，isEnabled 已知，toggle 为 On/Off。
- 可选 summaryAutomationId：On 才读详情，Off 返回 detailsRequired:false，未知停止。省略则直接统计。
- 可选 scopePath 同时限定摘要和详情，每次重新解析。maxDepth 默认 4、范围 1–50；maxNodes 默认 300、范围 1–5000。
- 返回 checkedCount、unchecked、disabled；带摘要时详情位于 details。禁用且 On 仍计入数量。className/bounds/isOffscreen 缺口保留为证据，不阻断已知状态；身份、必要状态和读取完整性仍需成立。

没有 AutomationId 时，用明确的名称与类型：

```json
{"id":"audit-names","action":"readonly-ui","recipe":"checkbox-audit","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"regionAutomationId":"checks","checkboxSelectors":[{"name":"24 小时制","controlType":"CheckBox"},{"name":"以大屏幕模式启动 Steam","controlType":"CheckBox"}]},"timeoutMs":15000}
```

名称模式接受 1–64 个互不重复的精确选择器，只允许 name 和固定的 controlType:"CheckBox"；ID、名称、PID/HWND 均需来自实际观察。unchecked、disabled 返回选择器对象，保留请求顺序；旧 ID 模式仍返回排序后的 ID 字符串。所选控件的名称、类型、isEnabled、On/Off 与区域 ID 必须可读。同名 Text 可排除，但身份未知且可能匹配的节点会阻断唯一性。非必要的已知属性缺口保留为证据；未分类缺口、搜索／父范围／遍历不完整仍停止。不把未知状态当 Off，也不更改设置。

### sibling-range

先从局部 UIA 树和必要截图确认容器及两个连续分组标题，再调用：

```json
{"id":"group1","action":"readonly-ui","recipe":"sibling-range","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"containerQuery":{"name":"grid","controlType":"Table","maxSearchNodes":500},"startAfter":{"name":"2024","controlType":"DataItem"},"endBefore":{"name":"2023","controlType":"DataItem"},"maxDepth":4,"maxNodes":160},"timeoutMs":15000}
```

containerQuery 使用标准 query；startAfter/endBefore 仅接受 automationId/name/controlType，至少一个精确条件。可加 scopePath；深度和节点预算同 checkbox-audit。两标题须在容器内分别唯一、同一直接父节点、顺序正确。一次读取返回中间所有同级条目，不含标题，不重复计入子文本。

findings 包含 kind:logical-group、basis:sibling-order、边界、原生父节点、items 和 observedCount；每项保留本次 id/parentId、名称及可用身份。coverage 为 observed-range-only，businessGroupComplete 为 unknown：只描述提供方当前暴露的区间，不推断完整清单或标题计数含义。

名称及边界所需属性必须可读，AutomationId 缺失可按名称定位。边界缺失／重复／顺序错误、条目名称不可读或读取截断时停止，无成功 findings；已观察部分保留在 steps.evidence，不解释为空组。配方不自动识别标题、滚动或展开。

### 自定义只读流程

可信 TypeScript 宿主可用 `readonlyUiWorkflow(target, program, options)`，program 内串行调用 reader.inspect/review；两者支持 scopePath。inspect 的客户端选项 allowAuxiliaryPropertyGaps:true 允许上文三类辅助缺口，allowPropertyGaps:true 则由调用方检查任务所需属性。缺口仍留在步骤证据，搜索、范围和遍历检查保留。默认读取与 review 保持严格；这些选项不是 MCP 参数或 JSON 配方参数。

## 操作方式与授权

用户要求执行具体流程时，在已授权范围内完成并验证；只要求查看或评估时保持只读。按任务选择模式：

| 操作 | 用法与限制 |
|---|---|
| 点击、勾选、选择 | `wincode_ui_click` 使用 Invoke/Toggle/SelectionItem，不先请求焦点；应用事件仍可能激活窗口 |
| 后台写值或清空 | `wincode_ui_type` 显式传 `mode:"setValue"`，使用 ValuePattern；空字符串清空 |
| 逐键输入、IME 验证 | `mode:"type"` 会 SetFocus，需用户授权前台交互；默认 mode 也是 type |
| 明确展开或折叠 | `wincode_ui_set_expanded`，expanded:true/false；需要 ExpandCollapsePattern |

`backgroundOnly` 只约束取证，不是 click/type 的禁止激活开关。仅授权后台时，不用启动、恢复、聚焦、坐标或键盘模拟补救失败；ValuePattern 不支持也不自动改用 type。已知会激活的动作先取得前台授权。用户正在游戏、聊天或会议时，不索取焦点；需前台键盘验证时由用户选择时机并切到目标窗口。

动作目标由当前观察的 targetAutomationId/targetName/targetControlType 精确定位。零匹配、多匹配或搜索不完整不操作。动作后按预期检查控件状态、页面或提示；需要等待时做有界只读检查。actionMethod 只说明使用的控件模式，不能代替业务结果。输入内容不回显，inputLength 只报告长度。

| 结果 | 下一步 |
|---|---|
| TARGET_NOT_FOUND / TARGET_AMBIGUOUS | 重新观察、收紧选择器，不逐个试点 |
| TARGET_SEARCH_INCOMPLETE | 缩小范围或调整预算，不能选择首个匹配 |
| TARGET_DISABLED / NO_CLICK_PATTERN / NO_VALUE_PATTERN / VALUE_READONLY | 检查流程前提及受支持操作 |
| TARGET_EVIDENCE_INCOMPLETE | 核对必要属性，不当作实际禁用 |
| FOCUS_FAILED | 由用户处理焦点，不用脚本反复抢前台 |
| ACTION_FAILED、执行中超时或取消 | 可能已部分完成；先读回状态，clearBefore 可能已清空输入，不能重发动作 |

原生 Host 的 REC 提示与审计不可绕过。提示窗失败发生在 UI 读取之前，先保留错误和日志；诊断方法见[诊断手册](diagnostics.md#ui-取证失败)。

## 展开并读回

需要展开目标复选框所在区域时，使用独立的 `expand-ui`，不是只读配方：

```json
{"id":"nav1","action":"expand-ui","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"scopePath":[{"automationId":"settings"}],"parentQuery":{"name":"高级","controlType":"Group"},"childQuery":{"automationId":"optionA","controlType":"CheckBox"}},"timeoutMs":15000}
```

parentQuery/candidateQuery 二选一，也可都省略以发现候选。默认总预算15秒、上限30秒，每请求最多一次展开；显式父级最多5次工具调用，发现／选择最多6次。目标已可见直接读；父级已 Expanded 不重复展开；Collapsed 才设置展开并读回归属及 toggle。

省略父级时只发现 Group：完整搜索后唯一、启用、状态明确的折叠候选才继续。多个候选返回 selection-required、success:false、isError:false。根据实际任务选择带 nextRequest 的候选，补新 id 提交；不默认首项，也不展开全部。candidateQuery 须含名称或 AutomationId，可带 Group 类型，不能带搜索预算。

选择后重新定位：不存在或不唯一为 NAVIGATION_SELECTION_STALE；查询不完整仍按 QUERY_* 报告。祖先 scopePath 贯穿发现、操作和最终读取；内部追加实际父选择器，若与路径末项三个定位字段完全相同则复用根。总路径最多50项；需追加时原路径最多49项。父级读取因此需要 inspectionVersion 5，带路径动作先检查版本。

仅 completed/success:true 表示取得最终 findings。父级展开后仍缺目标时，读 diagnosis.localObservation 与 nextAction；它们保留本次树、状态、匹配和内层候选，不授权递归操作。内层候选没有可执行 nextRequest，需根据新观察另行定位。辅助属性缺口可保留；必要身份、启用、状态和完整性仍检查。

首次发现可能受其他 Group 的未知状态影响；大树也可能超预算。每次请求的预算独立，不是整个任务的累计额度。一次失败不把所有 not-found 都解释成折叠，也不自动重放展开。

## 界面与源码对照

需要源码线索时直接使用 `wincode_ui_review`，不必先 inspect 再重复截图。传相关 candidateFiles，必要时加 candidateCodeFiles/textQueries；路径限当前工作区。已知PID/HWND不证明该窗口来自当前源码。

XAML/C# 候选是文字匹配，runtimeSourceVerified:false，runtimeBuildSourceIdentity:unknown，templateResolution:unsupported。Click/简单 Binding 候选及 relatedSymbol 不证明 DataContext、CanExecute 或完整调用链。使用 nextRequest 阅读准确正文，再判断关系。

检查 fileScanComplete、searchComplete、truncated 和省略标记。单文件256KiB、总计1MiB，输出另有预算。compact 用候选表与 candidateIds 去重，full 保留嵌套候选。已有相同文件的有效正文可复用；文件改变或相关分支未覆盖时再读。
