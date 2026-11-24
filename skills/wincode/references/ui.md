# 窗口与 UI

按任务查阅：[选择目标与取证](#选择目标与取证) · [规范字段表](#规范字段) · [父范围定位](#父范围定位) · [客户端只读配方](#只读配方) · [操作方式与授权](#操作方式与授权) · [单层展开读回](#展开并读回) · [界面与源码对照](#界面与源码对照)。按需启动客户端见 [会话入口](diagnostics.md#skill-按需会话)。

## 选择目标与取证

1. 已知有效 `pid` / `hwnd` 时直接使用；未知时调用 `wincode_ui_list_windows` 按 `processName`（不带 `.exe`）或 `titleContains` 筛选（`maxWindows: 10` 通常足够）。出现多个候选窗口时先消歧，句柄失效后重新列窗。
2. 仅查控件结构传 `capture: "none"`；需核对原始画面传 `"original"`，需带编号标注图传 `"annotated"`。后台取证须同时提供 `pid`、`hwnd` 与 `backgroundOnly: true`。
3. 首轮建议使用 `responseFormat: "compact"`、明确的 `query`（及已知祖先 `scopePath`）与适度深度；需要完整几何坐标时再按返回的 `expansionRequests` 或 `full` 格式重读。

示例（所有 ID 与句柄均为占位符，须替换为实际观察值）：

```json
{"pid":12345,"hwnd":"0x123ABC","backgroundOnly":true,"capture":"none","responseFormat":"compact","query":{"name":"保存","controlType":"Button"},"maxDepth":4,"maxNodes":100}
```

- `query` 中的 `automationId` / `name` / `controlType` 为区分大小写的精确 AND 匹配。仅当 `queryResult.searchComplete: true` 且 `status: "unique"` 时才证明在当前范围内唯一命中；`not-found` 不代表开关为 `Off`，`incomplete` 不证明目标不存在。
- 需要勾选、选中或展开/折叠状态时传 `readStates: true`（`unsupported` / `unknown` 与 `false` 严格区分）。节点 `id` 仅在当次响应内有效。
- 截图始终捕获整个目标窗口（`scopePath` / `query` 仅缩小返回的控件树）。`PrintWindow` 在部分硬件加速或最小化窗口上可能返回黑图或陈旧画面，须结合 `captureMethod`、`captureQuality`（如 `suspect-low-variation`）与 `imageOmitted` 判断，不为截图而激活或还原窗口。

## 规范字段

| 工具 / 字段 | 类型与约束 |
| --- | --- |
| `wincode_ui_list_windows` | 全部可选：`pid` 整数 `1–2147483647`；`processName`、`titleContains` 非空字符串（最长 128）；`maxWindows` 整数 `1–100`（默认 30）。多条件按 AND 组合。 |
| `wincode_ui_inspect` | `pid`（正整数）与 `hwnd`（十六进制如 `"0x123ABC"` 或十进制字符串，最长 32，不可传 JSON 数字）至少填一个；`--background-ui` 或 `backgroundOnly: true` 时两者必填。 |
| `capture` / `responseFormat` | `capture`: `none`（默认）/ `original` / `annotated`；`responseFormat`（仅 `inspect`/`review`）：`full`（默认）/ `compact`。 |
| `scopePath` | `inspect` / `review` / `set_expanded` 可选：`1–50` 个父选择器，每项至少含 `automationId` / `name` / `controlType` 之一（非空精确匹配）。需 `inspectionVersion >= 5`；`click` / `type` / `shortcut` 不支持。 |
| `maxDepth` / `maxNodes` | 可选整数，分别为 `1–50`（默认 6）、`1–5000`（默认 300）。 |
| `readStates` | 可选布尔值（默认 `false`）；只读控件模式状态，不读取输入文本或触发动作。 |
| `query` | 可选对象：至少含 `automationId` / `name` / `controlType` 之一（非空白字符串，最长 256）；可选 `maxSearchNodes` `1–5000`（默认 1000）、`maxMatches` `1–20`（默认 10）。 |
| `wincode_ui_click` | 仅普通连接提供：`pid` / `hwnd` 至少一个；`targetAutomationId` / `targetName` / `targetControlType` 至少一个（非空白，最长 256）。 |
| `wincode_ui_set_expanded` | 仅普通连接提供：定位字段同 `click`（另支持可选 `scopePath`），必填布尔值 `expanded`；仅调用 `ExpandCollapsePattern`（已处于目标状态时为 no-op），需 `inspectionVersion >= 4`（带路径需 `5`）。 |
| `wincode_ui_type` | 定位字段同 `click`，必填 `inputText`（最长 4096 字符）。默认与后台连接必填 `mode: "setValue"`（空字符串清空值，`clearBefore` 仅允许 `false`）；仅启用 `--isolated-keyboard` 时支持 `mode: "type"` 与 `clearBefore: true`。 |
| `wincode_ui_shortcut` | 仅在 `--background-ui` + `--ui-shortcut-window` 连接中提供：必填 `pid`、`hwnd`、`targetAutomationId`（最长 256）；仅触发绑定后台窗口声明的 `WinCode.WpfBackgroundShortcut.v1` 控件，需 `inspectionVersion >= 8`。 |
| `wincode_ui_review` | 除 `inspect` 全部字段外（动态模式另需 `workspacePath`），必填 `candidateFiles`（`1–16` 个工作区内相对 `.xaml` 路径，最长 512）；可选 `candidateCodeFiles`（`1–8` 个相对 `.cs` 路径）、`textQueries`（最多 5 个字面串，最长 80）。 |

参数大小写与类型须严格匹配（如 `automationId` 不能写成 `automationID`）。UI 请求原始 JSON 上限 64 KiB，`query` 另有 2 秒 / 50 层软限制并受 Helper 总超时约束。客户端 JSON 配方遇到未声明字段会直接拒绝。

## 父范围定位

- `scopePath` 必须来自真实观察到的祖先节点：每一步在上一级范围内唯一定位严格后代（可跨布局容器，不重复匹配当前根），每次请求独立解析，不会自动展开折叠节点。
- 检查 `scopeResult.status === "resolved"` 与 `resolvedCount`；解析失败时返回 `SCOPE_NOT_FOUND`、`SCOPE_AMBIGUOUS` 或 `SCOPE_SEARCH_INCOMPLETE`（附 0 起始的 `failedIndex`），**绝不回退为整窗搜索**。若分组标题与条目属于同级兄弟节点，请改用下方的 `sibling-range`。

## 只读配方

客户端配方通过复用既有 MCP 工具在客户端完成聚合（SDK 入口 `WinCodeSession.readonlyUiRecipe`，CLI 入口 `action: "readonly-ui"`，`timeoutMs` 默认 15000、范围 `1–30000`）。均不执行任何 UI 修改动作，调用后需同时检查 `isError`、`report.success`、`steps` 与 `findings`。

### `checkbox-audit`

```json
{"id":"audit1","action":"readonly-ui","recipe":"checkbox-audit","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"scopePath":[{"automationId":"settings"}],"regionAutomationId":"checks","checkboxAutomationIds":["optionA","optionB"]},"timeoutMs":15000}
```

- 必填 `regionAutomationId`，并在 `checkboxAutomationIds`（`1–64` 个不重复 ID）与 `checkboxSelectors`（`1–64` 个不重复精确名称选择器，如 `[{"name":"24 小时制","controlType":"CheckBox"}]`）中二选一。
- 可选 `summaryAutomationId`：总开关为 `On` 才继续读取详情（位于 `details`），为 `Off` 返回 `detailsRequired: false`，状态未知则停止。可选 `scopePath` 同时作用于总开关与详情。`maxDepth` 默认 4（`1–50`），`maxNodes` 默认 300（`1–5000`）。
- 返回 `checkedCount`（包含已禁用但处于 `On` 的项）、`unchecked`、`disabled`（ID 模式返回排序字符串，名称模式按请求顺序返回选择器对象）。允许 `className`/`bounds`/`isOffscreen` 辅助属性缺口并保留在 `steps.evidence`，但身份、`isEnabled`、`On`/`Off` 与搜索完整性缺一不可。

### `sibling-range`

先通过局部 `inspect` 确认容器与前后两个相邻分组标题，再读取两者之间的同级条目：

```json
{"id":"group1","action":"readonly-ui","recipe":"sibling-range","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"containerQuery":{"name":"grid","controlType":"Table","maxSearchNodes":500},"startAfter":{"name":"2024","controlType":"DataItem"},"endBefore":{"name":"2023","controlType":"DataItem"},"maxDepth":4,"maxNodes":160},"timeoutMs":15000}
```

- `startAfter` 与 `endBefore` 在容器子树内须分别唯一、共享同一直接父节点且顺序正确；单次读取返回中间同级节点（不含标题本身，不重复统计子文本）。
- 结果固定标记 `coverage: "observed-range-only"`、`businessGroupComplete: "unknown"`，仅反映当前已加载可见区间（不滚动虚拟列表，边界异常或截断时停止且不视为“空分组”）。

### 自定义只读编排

可信 TypeScript 宿主可调用 `readonlyUiWorkflow(target, program, options)` 串行组合 `reader.inspect` / `review`（客户端专属选项 `allowAuxiliaryPropertyGaps` / `allowPropertyGaps` 仅在宿主侧生效，不可作为 MCP 或 JSON 配方参数传入）。

## 操作方式与授权

仅在用户明确要求操作界面时在授权范围内执行；仅要求排查或查看时保持只读。

| 操作场景 | 工具与约束 |
| --- | --- |
| 点击、勾选、列表选择 | 普通连接调用 `wincode_ui_click`（依次尝试 `Invoke` / `Toggle` / `SelectionItem`，不模拟鼠标坐标，不主动激活窗口，但应用自身事件仍可能弹窗或切到前台）。 |
| 显式展开或折叠容器 | 普通连接调用 `wincode_ui_set_expanded`（`expanded: true/false`，仅用 `ExpandCollapsePattern`）。 |
| 直接写入或清空控件值 | 调用 `wincode_ui_type` 并传 `mode: "setValue"`（`ValuePattern`）；`--background-ui` 连接须预先由启动者绑定 `--ui-write-window <PID>:<HWND>:<FileTime>`。 |
| 触发后台 WPF 声明式快捷键 | 在 `--background-ui` + `--ui-shortcut-window <PID>:<HWND>:<FileTime>` 连接上调用 `wincode_ui_shortcut`，触发目标应用内部路由的 `WinCode.WpfBackgroundShortcut.v1` 控件（返回 `shortcut-requested` 后可 `inspect` 该 `automationId` 查看 `shortcutStatus`；接入方式见 [WPF 快捷键说明](../../../tools/WinCode.UIA.Host/Wpf/README.md)）。 |
| 前台逐键输入 / IME 测试 | 仅在独立隔离会话开启 `--isolated-keyboard` 且目标窗口已位于前台时，调用 `wincode_ui_type`（`mode: "type"`）。 |

- **后台写保护**：在 `--background-ui` 连接上，当目标进程拥有当前前台窗口或前台归属无法核实时，`setValue` 与 `wincode_ui_shortcut` 均会被拒绝（`UI_WRITE_TARGET_DENIED`）；普通 `click` 命中 `WinCode.WpfBackgroundShortcut.v1` 同样会被拒绝。进程重启后须重新绑定窗口。
- **结果核实**：`actionMethod` 仅证明 UIA 调用已被接受，操作后须另行通过 `inspect` 或应用输出核实业务结果；`inputText` 不会在响应或审计中回显（仅报告 `inputLength`）。

| 常见错误码 | 规范处理方式 |
| --- | --- |
| `TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS` | 重新 `inspect` 观察并收紧选择器，切勿盲目遍历点击。 |
| `TARGET_SEARCH_INCOMPLETE` | 用 `scopePath` 缩小范围或调高搜索预算，不得默认挑第一个候选。 |
| `TARGET_DISABLED` / `NO_CLICK_PATTERN` / `NO_VALUE_PATTERN` / `VALUE_READONLY` | 检查界面前置条件与控件支持的 UIA 模式。 |
| `TARGET_NOT_REGISTERED` / `UI_WRITE_TARGET_DENIED` | 确认目标是否为已启用的 `WinCode.WpfBackgroundShortcut.v1` 控件、窗口绑定参数是否匹配当前 PID/HWND/启动时间，以及目标窗口是否退居后台。 |
| `TARGET_EVIDENCE_INCOMPLETE` | 核查 `propertyIssues`，不直接等同于控件被禁用。 |
| `FOCUS_FAILED` | 交由用户处理前台焦点，切勿用脚本循环抢焦点；先读回是否已有部分字符输入。 |
| `ACTION_FAILED` / 执行超时或取消 | 副作用可能已部分发生（如 `clearBefore` 已清空旧值）；必须先只读读回状态，切勿直接重发原动作。 |

原生 Host 的 `REC / WinCoding` 提示浮层与审计记录不可绕过，故障排查见 [诊断手册](diagnostics.md#ui-取证失败)。

## 展开并读回

需要在按需会话中展开折叠分组并读取内部复选框时，使用客户端动作 `expand-ui`（非只读配方，默认预算 15 秒、上限 30 秒，单次请求最多展开一次）：

```json
{"id":"nav1","action":"expand-ui","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"scopePath":[{"automationId":"settings"}],"parentQuery":{"name":"高级","controlType":"Group"},"childQuery":{"automationId":"optionA","controlType":"CheckBox"}},"timeoutMs":15000}
```

- `parentQuery` 与 `candidateQuery` 二选一；若均省略则自动检索范围内折叠的 `Group`（发现多个候选时返回 `selection-required`，需调用方显式选择后带新 `id` 提交，不默认展开首项）。
- 目标已可见时直接读取；父节点已 `Expanded` 时不重复展开；为 `Collapsed` 时展开后重新解析路径并验证子控件归属与 `toggle` 状态（需 `inspectionVersion >= 5`）。仅 `completed` / `success: true` 代表拿到最终 `findings`；若展开后仍存在内层折叠容器，根据 `diagnosis.localObservation` 另发请求，本流程不自动递归。

## 界面与源码对照

需要从控件直接找源码线索时调用 `wincode_ui_review`（无需先单独 `inspect`）。

- XAML 与 C# 匹配结果均为静态文本候选（`runtimeSourceVerified: false`、`runtimeBuildSourceIdentity: "unknown"`、`templateResolution: "unsupported"`）。匹配到事件或简单 `Binding` 名称仅代表候选代码位置，须调用 `wincode_prepare_context`（使用返回的 `nextRequest`）阅读实际代码后再判断 `DataContext` 或 `CanExecute` 逻辑。
- 单文件扫描上限 256 KiB、总计 1 MiB；注意核对 `fileScanComplete`、`searchComplete` 与 `truncated`。
