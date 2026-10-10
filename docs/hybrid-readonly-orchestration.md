# 客户端 UI 工作流

适用版本：0.17.0。工作流由调用方显式启用，使用既有 MCP 连接，不会自动调用模型。后续任务只看[迭代计划](next-iteration.md)；本页仅描述当前接口。

## 选择入口

| 需求 | 入口 | 当前限制 |
|---|---|---|
| 单次控件读取或源码对照 | 标准 inspect/review | 支持显式 scopePath；字段见 [UI 手册](../skills/wincode/references/ui.md) |
| 自定义只读条件流程 | WinCodeSession.readonlyUiWorkflow(target, program, options) | 可信宿主 TypeScript 回调，reader.inspect/review 均支持可选 scopePath |
| 指定复选框集合统计 | readonlyUiRecipe 或 JSON action: readonly-ui，recipe: checkbox-audit | 可选 scopePath 同时限定摘要与详情 |
| 同级标题之间的列表条目 | readonlyUiRecipe 或 JSON action: readonly-ui，recipe: sibling-range | 显式容器和两个标题，按观察到的兄弟顺序读取；不推断业务分组总量 |
| 目标隐藏在可展开父级下 | expandUiWorkflow 或 JSON action: expand-ui | 显式父路径内最多展开一次；最终结果要求 toggle 状态 |

先取得实际窗口并明确选择 PID/HWND。同一任务复用一个 WinCodeSession；首次业务调用才连接 Gateway。结果同时检查 isError、业务 success、步骤与证据；任务结束显式 close。超时、取消或连接丢失不授权自动重放。

会话启动、单工具请求和关闭命令见[诊断手册](../skills/wincode/references/diagnostics.md#skill-按需会话)。JSON 回执中的 resultFile 指向完整结果；必须读取该文件并保留全部 MCP 内容块及图片，不能只凭回执路径判定成功。模型输出的参数文本不是工具调用，不能自动执行。

## 复选框统计

以下 PID/HWND、名称与 ID 全是示例占位值，必须替换为实际观察：

```json
{"id":"audit1","action":"readonly-ui","recipe":"checkbox-audit","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"scopePath":[{"automationId":"voiceSettings"}],"summaryAutomationId":"summary","regionAutomationId":"checks","checkboxAutomationIds":["optionA","optionB"],"maxDepth":4,"maxNodes":40},"timeoutMs":15000}
```

- checkboxAutomationIds：1–64 个互不重复的 ID。每个目标必须在指定区域内唯一，为 CheckBox，isEnabled 已知，toggle 为 On 或 Off。原有 ID 模式的参数、结果形状和属性检查保持不变。
- 没有 AutomationId 的控件可改用 checkboxSelectors，例如 `[{"name":"24 小时制","controlType":"CheckBox"}]`；与 checkboxAutomationIds 二选一。接受 1–64 个互不重复的精确名称，controlType 必须为 CheckBox，不接受其他选择字段。区域仍用 regionAutomationId，摘要仍用可选 summaryAutomationId。
- 名称模式的 unchecked、disabled 返回对应选择器对象，顺序与请求一致；checkedCount 仍统计所有 On，包括禁用目标。原始节点身份、状态和属性缺口保留在 steps.evidence。
- summaryAutomationId 可省略。提供时先读摘要：On 才读详情，Off 返回 detailsRequired:false；未知或缺失停止。
- scopePath 可省略；提供时包含 1–50 个仅使用 automationId/name/controlType 的精确父选择器，摘要和详情共用该祖先范围。每次读取重新解析，不复用摘要的定位对象。不提供路径时沿用原查询范围和调用数。
- maxDepth 默认 4，允许 1–50；maxNodes 默认 300，允许 1–5000。详情区域一次读取后在客户端统计，禁用且 On 的控件仍计入 checkedCount。
- 无摘要时返回 checkedCount、unchecked、disabled；摘要 On 时返回 detailsRequired:true 和 details。字段形状见 [ReadonlyUiRecipes](../src/Client/ReadonlyUiRecipes.ts)。

非法配方参数在连接／读取前拒绝，CLI 保留 requestError，并提供 errorCode、field、errorMessage、recoveryAction、workStarted:false 等信息。调用方可根据反馈构造更正请求；CLI 不自动更正或重试。传输失败／动作结果未知不能一律解释为未执行。

带路径的读取要求 inspectionVersion 5，并确认 scopeResult 已解析全部父级；旧版本返回 VERSION_MISMATCH，缺少范围证据停止为 INCOMPLETE_OBSERVATION。原生 SCOPE_NOT_FOUND／SCOPE_AMBIGUOUS／SCOPE_SEARCH_INCOMPLETE 原样保留，步骤证据包含 scopeResult，不回退整窗。路径不会自动展开隐藏区域，也不裁剪窗口截图；摘要和详情没有合适共同祖先时使用显式单次读取。

ID 模式允许 className、bounds、isOffscreen 的辅助属性缺口，仍在步骤证据中保留原始 propertyIssues 和数量；身份、启用状态、toggle、搜索／遍历完整性、歧义和未分类缺口仍按原规则判断。可信 TypeScript 调用方可在 reader.inspect 中显式设置 allowAuxiliaryPropertyGaps:true 使用同一规则；此选项默认关闭，只在客户端解释，不发送给 MCP，不属于 JSON 配方参数。reader.review 的严格行为不变。

名称模式在区域后代中检查精确名称与 CheckBox 类型；同名 Text 不计入。仅当某个可读字段明确不匹配时才排除节点，身份不全且可能匹配的节点仍阻断唯一性。所选控件必须有可读名称、类型、isEnabled 和确定的 On/Off，区域 ID 也必须可读。已知且无关的属性缺口保留但不阻断；未分类缺口和无法解释的缺口总数仍阻断。该规则只由名称配方通过客户端 allowPropertyGaps 执行，不改变默认 reader、ID 模式或原生工具的行为。

## 同级标题之间的条目

适用于标题和条目在 UIA 中处于同一层的列表。先通过局部 inspect 和必要截图确认容器、条目顺序，以及两个连续分组标题；配方不自动猜测哪一行是标题。以下仍为占位示例：

```json
{"id":"group1","action":"readonly-ui","recipe":"sibling-range","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"scopePath":[{"name":"Library","controlType":"Document"}],"containerQuery":{"name":"grid","controlType":"Table","maxSearchNodes":500},"startAfter":{"name":"2024","controlType":"DataItem"},"endBefore":{"name":"2023","controlType":"DataItem"},"maxDepth":4,"maxNodes":160},"timeoutMs":15000}
```

containerQuery 使用标准 UiQuery；startAfter/endBefore 只接受 automationId、name、controlType 的精确条件，至少一个。两标题必须在容器子树内分别唯一、拥有同一个直接父节点且顺序正确。配方只读取一次，不含两个标题，保留中间所有同级条目的原始顺序，不将条目的子文本重复计数。maxDepth/maxNodes 的默认值及范围与 checkbox-audit 相同。

findings 返回 kind:logical-group、basis:sibling-order、container、parent、startAfter、endBefore、observedCount 与 items。节点保留 id、parentId、name、可用的 automationId/controlType 和 propertyIssues；requestId 对应本次取证，节点 ID 不可跨请求用于定位。coverage 固定为 observed-range-only、businessGroupComplete 固定为 unknown：读取的是提供方当前暴露的区间，不能据此宣称完整业务清单；零条目也不证明分组没有隐藏内容。

名称和边界选择器所需属性必须可读；没有 AutomationId 或状态模式不妨碍按名称读取。此配方使用客户端 reader.inspect 的 allowPropertyGaps:true，自行检查必要属性，原始缺口仍保存在步骤证据。该选项不会发送给 MCP，也不允许出现在 JSON 配方参数中；默认读取、review、checkbox-audit 均沿用原有检查。搜索、父范围、遍历完整性和目标身份检查不放宽。

标题缺失、歧义、不在同一父节点、顺序错误、条目名称不可读或取证截断时，工作流停止且无成功 findings，已观察部分保留在 steps.evidence；不能将其解释为空组。配方不滚动、不展开、不操作条目，也不从视觉加减号伪造原生展开状态。

## 有限展开与读回

```json
{"id":"read1","action":"expand-ui","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"scopePath":[{"automationId":"speechPage"}],"parentQuery":{"automationId":"advanced"},"childQuery":{"automationId":"normalize"}},"timeoutMs":15000}
```

parentQuery 与 candidateQuery 只能提供一个，也可均不提供以有限发现 Collapsed Group。candidateQuery 只能使用返回候选的实际名称／ID／Group 类型。多个候选时先返回 selection-required，由调用方根据任务选择；不默认操作第一个。

scopePath 由实际祖先选择器组成，每项使用 automationId、name、controlType 的组合，1–50 项；逐项搜索严格后代并要求完整唯一，不自动展开祖先。最终父级与路径末项完全一致时复用该根。inspectionVersion 5 才支持父路径；当前 click/type 不支持路径。

可见目标直接读取，父级已经 Expanded 时不重复展开；Collapsed 时设置为 Expanded，再核对父子关系并独立读回。completed 才表示取得最终 findings；stopped 可保留已成功动作和局部观察，不能把导航动作成功当作任务完成。局部内层候选只用于调用方决定后续请求，本请求不递归。

范围缺失／歧义／不完整不回退整窗。动作失败或结果未知先保留事实，不自动重试；后台语义操作也可能因目标应用事件带来前台变化。完整授权和能力边界以 [UI 手册](../skills/wincode/references/ui.md#操作方式与授权)为准。

## 验证入口与边界

类型检查用 npm run typecheck；核心与桌面检查分别为 npm run check、npm run check:desktop；磁盘交付身份用 npm run delivery:verify。运行条件和报告位置见 [CONTRIBUTING](../CONTRIBUTING.md)。检查会构建或启动相应测试进程，不因阅读本页就执行。

工作流、真实 JSON 会话和模型宿主分别由 [hybrid-ui-workflow](../tests/hybrid-ui-workflow.test.ts)、[hybrid-ui-session](../tests/hybrid-ui-session.test.ts)、[hybrid-model](../tests/hybrid-model.test.ts) 覆盖。benchmark:hybrid 是显式 UI 基准，benchmark:hybrid-model 会请求外部模型；后者需先确定授权范围及预算，参数见[脚本](../scripts/benchmark-hybrid-model.ts)。测试夹具通过不代表实际应用迁移或模型性能已验证。

真实应用多候选、条件多控件统计和非 WPF 导航仍待验证；自动递归、其他导航类型与任意数值读取尚未由本编排提供。sibling-range 仅整理已观察的同级条目名称，虚拟化列表的完整加载和视觉分组自动识别不在其范围内。原始本地结果可能含窗口内容，保存在忽略的 test-tmp，不直接作为公开附件。
