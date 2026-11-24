# 客户端 UI 工作流

适用版本：**0.17.1**。本页描述随客户端会话提供的显式 UI 编排接口：所有工作流均复用既有 MCP 连接，仅在调用方显式请求时执行，不会在后台自动调用外部模型或更改客户端默认配置。后续待验证事项见 [迭代计划](next-iteration.md)。

## 1. 按场景选择入口

| 目标场景 | 调用入口 | 行为与限制 |
| --- | --- | --- |
| 单次控件读取或关联源码 | 标准 `wincode_ui_inspect` / `wincode_ui_review` | 支持可选 `scopePath`；参数定义见 [UI 手册](../skills/wincode/references/ui.md)。 |
| 自定义只读多步判断 | `WinCodeSession.readonlyUiWorkflow(target, program, options)` | 供可信宿主传入 TypeScript 回调，`reader.inspect` / `review` 均支持可选 `scopePath`。 |
| 指定复选框集合统计 | `readonlyUiRecipe` 或 CLI `action: "readonly-ui", recipe: "checkbox-audit"` | 支持 ID 列表或精确名称选择器；可选 `scopePath` 同时限定摘要与详情读取。 |
| 读取同级标题之间的列表项 | `readonlyUiRecipe` 或 CLI `action: "readonly-ui", recipe: "sibling-range"` | 指定容器与起止同级标题，按当前暴露的兄弟节点顺序读取，不推断完整业务分组总量。 |
| 展开单层折叠容器并读回子项 | `expandUiWorkflow` 或 CLI `action: "expand-ui"` | 在显式父范围内最多展开一次并校验 `toggle` 状态，不自动递归展开。 |

**通用调用约定**：
- 先通过 `wincode_ui_list_windows` 确认目标窗口的 `pid` 与 `hwnd`。同一任务内复用单个 `WinCodeSession`（首次业务调用时才启动并连接 Gateway），结束时显式调用 `close`。
- 按需终端会话的启动与关闭方式见 [诊断与恢复手册](../skills/wincode/references/diagnostics.md#skill-按需会话)。CLI 回执中的 `resultFile` 指向完整 JSON 结果，请读取该文件并同时核对 `isError`、业务 `success`、`steps` 与 `findings`。超时、取消或断连后不会自动重放请求。

## 2. 复选框统计（`checkbox-audit`）

以下示例中的 `pid`、`hwnd`、ID 与名称均为占位值，调用时需替换为实际窗口中的观察值：

```json
{
  "id": "audit1",
  "action": "readonly-ui",
  "recipe": "checkbox-audit",
  "target": { "pid": 1234, "hwnd": "0x123456" },
  "parameters": {
    "scopePath": [{ "automationId": "voiceSettings" }],
    "summaryAutomationId": "summary",
    "regionAutomationId": "checks",
    "checkboxAutomationIds": ["optionA", "optionB"],
    "maxDepth": 4,
    "maxNodes": 40
  },
  "timeoutMs": 15000
}
```

- **两种选择器模式（二选一）**：
  - **ID 模式（`checkboxAutomationIds`）**：传入 1–64 个不重复的 `AutomationId`。每个目标在 `regionAutomationId` 区域内必须唯一、类型为 `CheckBox`、`isEnabled` 已知且 `toggle` 状态为确定的 `On` 或 `Off`。返回的 `unchecked` 与 `disabled` 为排序后的 ID 字符串数组。
  - **名称模式（`checkboxSelectors`）**：适用于无 `AutomationId` 的复选框，传入 1–64 个不重复的精确选择器（如 `[{"name": "24 小时制", "controlType": "CheckBox"}]`，仅接受 `name` 与固定的 `controlType: "CheckBox"`）。返回的 `unchecked` 与 `disabled` 保留请求顺序的选择器对象。同名 `Text` 节点会被排除，但身份属性缺失且无法排除匹配的节点仍会阻断唯一性判定。
- **可选总开关（`summaryAutomationId`）**：提供时先读取总开关；状态为 `On` 才继续读取详情区域（返回 `detailsRequired: true` 与 `details`），为 `Off` 则跳过详情读取（返回 `detailsRequired: false`），状态未知或缺失时直接停止。省略该参数则直接读取统计结果（`checkedCount`、`unchecked`、`disabled`；处于禁用但已勾选 `On` 的项仍计入 `checkedCount`）。
- **父范围与遍历预算**：`scopePath` 可选（1–50 个仅含 `automationId`/`name`/`controlType` 的精确祖先选择器），总开关与详情读取各自重新解析该路径。`maxDepth` 默认 `4`（1–50），`maxNodes` 默认 `300`（1–5000）。
- **属性缺口容忍边界**：`className`、`bounds`、`isOffscreen` 等辅助属性缺失不会阻断统计，但原始 `propertyIssues` 仍保留在 `steps.evidence` 中；身份、启用状态、`toggle` 状态及搜索/遍历完整性不完整时仍按严格规则停止（TypeScript 调用方可在 `reader.inspect` 中显式传 `allowAuxiliaryPropertyGaps: true` 复用该客户端规则，不属于 MCP 或 JSON 配方参数）。

## 3. 同级标题区间读取（`sibling-range`）

适用于分组标题与数据行在 UIA 树中处于同一父节点下的扁平列表。调用前需先通过局部 `inspect`（必要时配合截图）确认容器及前后两个相邻分组标题：

```json
{
  "id": "group1",
  "action": "readonly-ui",
  "recipe": "sibling-range",
  "target": { "pid": 1234, "hwnd": "0x123456" },
  "parameters": {
    "scopePath": [{ "name": "Library", "controlType": "Document" }],
    "containerQuery": { "name": "grid", "controlType": "Table", "maxSearchNodes": 500 },
    "startAfter": { "name": "2024", "controlType": "DataItem" },
    "endBefore": { "name": "2023", "controlType": "DataItem" },
    "maxDepth": 4,
    "maxNodes": 160
  },
  "timeoutMs": 15000
}
```

- `containerQuery` 使用标准 `UiQuery`；`startAfter` 与 `endBefore` 各需至少一个精确条件（`automationId`/`name`/`controlType`），且在容器子树内分别唯一、共享同一直接父节点、排列顺序正确。
- 单次读取返回两标题之间的所有同级条目（不含起止标题本身，不重复计入子文本节点）。
- 返回的 `findings` 固定标记 `coverage: "observed-range-only"`、`businessGroupComplete: "unknown"`：结果仅反映 UIA 当前暴露的可见区间，不自动滚动加载虚拟化列表，也不证明某分组为空或已全部加载。边界缺失、重复、乱序、条目名称不可读或遍历截断时停止且不生成成功 `findings`。

## 4. 单层展开与读回（`expand-ui`）

```json
{
  "id": "read1",
  "action": "expand-ui",
  "target": { "pid": 1234, "hwnd": "0x123456" },
  "parameters": {
    "scopePath": [{ "automationId": "speechPage" }],
    "parentQuery": { "automationId": "advanced" },
    "childQuery": { "automationId": "normalize" }
  },
  "timeoutMs": 15000
}
```

- `parentQuery` 与 `candidateQuery` 二选一；若均省略，则先在范围内发现启用且处于折叠状态的 `Group`（若存在多个候选则返回 `selection-required`，由调用方明确选择，不默认展开第一项）。
- 若目标子控件已可见则直接读取；父容器已处于 `Expanded` 时不重复操作；处于 `Collapsed` 时调用 `ExpandCollapsePattern` 展开一次，随后重新解析父路径并读回子控件及其 `toggle` 状态。仅 `status: "completed"` 代表已取得最终 `findings`。
- 带 `scopePath` 的读取与展开要求 `WinCode.UIA.Host` 的 `inspectionVersion >= 5`（旧版本返回 `VERSION_MISMATCH`，范围解析失败返回 `SCOPE_*` 错误，绝不回退到整窗搜索）。

## 5. 参数校验与测试覆盖边界

- 非法配方参数在建立连接或读取窗口前即被拒绝，CLI 回执包含 `requestError`、`errorCode`、`field`、`recoveryAction` 与 `workStarted: false`。
- 相关实现由 [hybrid-ui-workflow.test.ts](../tests/hybrid-ui-workflow.test.ts)、[hybrid-ui-session.test.ts](../tests/hybrid-ui-session.test.ts) 与 [hybrid-model.test.ts](../tests/hybrid-model.test.ts) 覆盖；`npm run benchmark:hybrid` 为本地 UI 基准，`npm run benchmark:hybrid-model` 会实际调用外部模型 API（运行前需确认授权与配额）。
- 当前未提供跨层自动递归展开、自动滚动或通用任意数值抽取；非 WPF 真实应用的兼容性与性能仍需按目标应用单独验证（详见 [迭代计划](next-iteration.md)）。
