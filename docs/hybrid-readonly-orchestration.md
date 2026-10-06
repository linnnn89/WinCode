# Hybrid 只读编排测试分支

实验分支：`codex/hybrid-readonly-orchestration`。基线：`038c0ccc7372948da405546cc7ec0add56eea9de`。

本迭代增加客户端只读编排和真实 Windows UI 基准。标准 MCP 工具、schema、Gateway 准入和 UIA helper 生命周期保持既有路径。只有显式调用客户端模块才启用混合模式；本分支独立测试，暂不合并到 `main`。

## 构建与验证

在此分支的仓库根目录运行，使用现有依赖和 `global.json` 固定的已安装 SDK；命令不会安装或下载 SDK：

```powershell
npm run typecheck
npm run build
npm run build:hybrid-fixture
node --import tsx --test tests/hybrid-ui-workflow.test.ts
npm run benchmark:hybrid -- 20
# 已通过进程环境提供获授权的模型配置时：
npm run benchmark:hybrid-model -- 20
```

需要现有的 Release UIA Host 发布目录和 fixture 已完成的 NuGet restore。缺少这些依赖时按常规项目配置处理；基准不自动安装、重试或降级。`benchmark:hybrid -- 1` 是快速工作流验证，不能替代默认 20 次测量。结果写入 `test-tmp/hybrid-ui-<timestamp>/report.json`，同目录保存背景窗口截图及其步骤证据。实验输出不提交到 Git。

## 客户端示例

复用 `WinCodeSession`，先通过 `wincode_ui_list_windows` 取得候选，再由调用方明确选择 PID/HWND。整个工作流固定这一身份，不根据标题重新选择窗口。

```ts
import { WinCodeSession } from '../src/Client/SkillSession.js';

const session = new WinCodeSession({ workspace: selectedWorkspace });
try {
  const result = await session.readonlyUiWorkflow(selectedTarget, async reader => {
    const summary = await reader.inspect({
      query: { automationId: 'hybridSummary' }, readStates: true, maxDepth: 2, maxNodes: 8,
    });
    const state = summary.tree?.states?.toggle;
    if (state === 'Off') return { detailsRequired: false };
    if (state !== 'On') throw new Error('Summary state is unknown.');
    const detail = await reader.inspect({
      query: { automationId: 'hybridChecks' }, readStates: true, maxDepth: 4, maxNodes: 40,
    });
    return { detailsRequired: true, inspectedRegion: detail.tree?.automationId };
  });
  // 向宿主返回整个 content，包括原生图像块；同时处理 isError。
  return result;
} finally {
  await session.close();
}
```

这是项目内 TypeScript API，示例中的 workspace/target 需要由宿主提供。执行的是受信任客户端程序，没有新增执行模型源码的工具、解释器或 sandbox。包装器限制自己的工具入口，不能限制宿主程序在包装器以外的能力，也不能替任意第三方客户端切断模型轮次。

在能执行受信任 TypeScript 的宿主中，优先使用 `session.readonlyUiWorkflow(target, program, options)`。它复用同一个标准 MCP 连接，沿用工作区／构建身份校验、工具验证和完整内容块返回；创建会话及只做客户端处理均不启动 Gateway，首次实际读取才连接。返回值包括 `report`、`content` 和 `isError`，宿主应保留原生 image 内容块。

该入口把会话关闭信号与调用方取消信号合并。`close()` 会取消正在读取、排队及两次读取之间等待的编排，等待已登记工作流形成最终报告，并观察 Gateway 退出。完成步骤的证据保留，后续读取不再分发；关闭后的会话入口拒绝新工作流。调用方仍需保存返回报告；关闭会话不自动替宿主交付附件。客户端回调使用宿主已有的执行能力，signal/race 不能强制终止同步死循环或撤销回调在包装器之外的操作。

已有连接的其他客户端可继续使用独立的 `runReadonlyUiWorkflow(call, target, program, options)`，由宿主提供取消与连接关闭。终端 JSON 入口 `SkillSessionCli.js` 保留原有单工具协议，测试分支另提供以下已安装客户端配方。

### 已安装的复选框检查配方

`session.readonlyUiRecipe(target, 'checkbox-audit', parameters, options)` 与终端入口复用同一配方及会话生命周期。先列出窗口并由调用方选择明确 PID/HWND，然后在同一个终端会话发送：

```json
{"id":"audit1","action":"readonly-ui","recipe":"checkbox-audit","target":{"pid":1234,"hwnd":"0x123456"},"parameters":{"summaryAutomationId":"hybridSummary","regionAutomationId":"hybridChecks","checkboxAutomationIds":["hybridCheck0","hybridCheck1","hybridCheck2","hybridCheck3","hybridCheck4","hybridCheck5","hybridCheck6","hybridCheck7"],"maxDepth":4,"maxNodes":40},"timeoutMs":15000}
```

PID/HWND 与 AutomationId 是示例占位值，使用实际选择的窗口和控件。回执仍为 `resultFile`、`isError`、`imageFiles`；读取结果文件的 text JSON 后检查 `success`、`steps` 和 `findings`，不要只根据短回执推断完成。取消和关闭沿用现有 action，`targetId` 指向活动配方请求的 id。

配方接受 1–64 个互不重复的复选框 AutomationId，并只读取指定区域一次；maxDepth 默认 4、范围 1–50，maxNodes 默认 300、范围 1–5000。可选的 summaryAutomationId 先作一次状态观察：On 才读取区域，Off 返回 `detailsRequired:false`，缺失或未知停止。省略摘要时直接返回 `{checkedCount,unchecked,disabled}`；提供摘要且为 On 时返回 `{detailsRequired:true,details:{...}}`。勾选和启用是独立状态，禁用但 On 的控件仍计入 checkedCount。

每个明确选择的 ID 必须在完整区域结果中唯一对应一个 CheckBox，并有确定 On/Off 与 isEnabled；缺失、重名、错误控件类型或未知状态均停止，不输出部分统计。配方名、参数及终端配方请求拒绝未知字段，不接受源码、表达式、任意工具名或改换窗口。终端 timeoutMs 默认 15000，范围 1–30000；沿用已有步骤／数据预算，捕获模式固定 none。普通单工具请求仍保留原有超时和原生图像返回。

本轮 T2/T3 的脚本与模型基准复用 `ReadonlyUiRecipes.ts`，不再维护另一份测试专用统计程序。旧模型测量记录描述当时版本，代码调整后的性能需新测量才能确认。终端配方不需要模型 API key，不保存环境变量；结果文件可包含真实控件文字和节点证据，关闭不会自动删除，应按本地附件管理。

## 执行契约

- 只提供 `inspect` 和 `review`；始终添加固定 PID/HWND、`backgroundOnly:true`、`responseFormat:"compact"`。不接受 action、替换目标或任意工具名。
- 即使程序使用 `Promise.all`，请求也按 FIFO 串行分发。默认最多 16 步，总 deadline 15 秒，最大 30 秒；后续调用继承剩余时间。
- 单步输入不超过 64 KiB，累计中间文本不超过 512 KiB。最终文本默认 32 KiB，最大 128 KiB；最多一张原生图像，沿用 2 MiB 图像上限。
- 同时检查 MCP `isError` 和业务 `success`；成功 JSON text 无需 `structuredContent`。歧义、未找到、不完整查询、属性读取失败、目标变化或传输异常停止工作流，不自动重试。
- 条件判断读取真实响应。缺失或 unknown 状态不能按 false 处理。多个步骤是有序的独立观察，节点编号只属于各自请求，不是跨步骤原子快照。
- 输出保留每步状态、requestId、可用的 capturedAt、节点状态与读取缺口、源码候选及其限制。`completed` 描述已完成读取；`stopped` 不丢弃之前完成的步骤。结果超预算显式返回错误与 `evidenceOmitted`，不报告完整成功。
- screenshot 只经 MCP image 内容块传递。返回图像不等于宿主或模型已经查看图像。
- 取消停止后续分发，并把 signal 传入标准 MCP 客户端。调用方负责关闭连接；helper 是否已退出必须结合 Gateway 状态及实际 PID 检查。模块不承诺任意不配合取消的第三方 caller 已结束执行。

## 基准方法与证据边界

| 任务 | 两条路径共同使用的最佳现有查询 |
|---|---|
| T1 | 单个已知 CheckBox，scoped/compact 一次读取 |
| T2 | 一次读取共同父区域，检查 8 个控件；不人为增加 8 次原生调用 |
| T3 | 读取摘要，根据明确 On/Off 状态决定是否读取详情 |
| T4 | 既有 `ui_review`，限定一个控件和明确 XAML 文件 |

两条路径执行相同工具工作量、使用同一连接，交替先后顺序。固定 fixture 的预期结果独立定义：8 个控件中 7 个勾选，`hybridCheck3` 未勾选，`hybridCheck6` 禁用。T4 仅验证字面源码候选，保留 `runtimeSourceVerified:false`。

报告记录逐次耗时、调用数、中间/交付文本 UTF-8 字节数，以及按 nearest-rank 计算的 P50/P95。连接冷启动单独记录，helper 审计 start 数仅统计本次拥有的 fixture PID，不归因到单个样本。未安装 tokenizer，字节数不换算为 token。

`scriptedObservationBatches` 是脚本规定的结果交付次数；T3 可以从 2 次变为 1 次。未调用 LLM，所以 `measuredModelTokens`、`measuredModelDecisionRounds`、`measuredModelLatencyMs` 为 null。原生对照的交付量是各工具文本总量，混合对照是步骤证据和 findings 的最终文本量；两边都未包含最终模型回答、生成程序和规划成本。不能据此宣称真实任务 token 或端到端模型耗时达到规划阈值。

故障验证使用隔离 fixture：选择器歧义、查询不完整、控件状态改变、窗口关闭、真实 UIA provider 进入后的客户端取消和工作流 deadline，以及直接适配器的 native helper 超时。检查后续调用不再分发，完成证据保留，并确认自有 helper/Gateway PID 退出。背景模式不主动激活 fixture；前台采样未观察到变化也不保证没有瞬时变化。

第一轮默认保持客户端 PoC。只有接入实际模型/宿主后证明收益，并确认普通 MCP 客户端需要同类能力，才考虑共享执行层和服务器只读 batch。UIA 并行、discovery、写操作、持久化副作用恢复和通用 runtime 均未在本迭代开放。

## 本地验证结果（2026-10-06）

Node 24.19.0、SDK 10.0.303：类型检查、Gateway 构建、fixture Release 发布通过；完整回归 467/467 通过，其中新增自动化测试 3 项。最终真实 UI 基准每任务每路径 20 次，共 160 个样本全部通过；7 类故障/状态场景通过，Gateway 和 6 个自有 fixture 的退出均由实际 PID 检查确认。审计观察到 211 次 helper start。前台采样未观察到 fixture 进入前台。

| 任务 | 原生 P50 / P95（ms） | 混合 P50 / P95（ms） | 平均交付文本字节减少 |
|---|---|---|---|
| T1 | 825.86 / 890.63 | 827.59 / 887.71 | 28.17% |
| T2 | 828.06 / 926.99 | 828.08 / 968.03 | 17.98% |
| T3 | 1641.38 / 1747.78 | 1646.75 / 1740.14 | 25.40% |
| T4 | 827.11 / 847.74 | 826.74 / 860.57 | 18.16% |

两条路径的 UIA 调用数相同，中位工具耗时基本持平。T3 的脚本观察结果交付次数从 2 次变为 1 次，其他用例均为 1 次。这些结果验证了客户端编排的执行行为和输出投影；未证明真实模型 token 或完整任务耗时达到原规划的投入阈值，当前决策维持客户端 PoC。

第二轮增加会话级入口及 3 项行为测试：冷会话在客户端等待期间关闭；复用真实 Gateway 完成条件读取并交付原生截图；真实 UIA provider 阻塞期间关闭，保留首步证据并停止排队的第三次读取。最后一项确认 Gateway 和 native helper 的实际 PID 已退出，fixture 也显式回收。类型检查、构建及构建指纹核对通过；原有完整回归 467/467、新增会话行为测试 3/3 通过，测试清单共 58 个文件。这轮验证宿主接入与关闭行为，未运行 LLM A/B，第一轮模型指标仍为 null。

## 第三轮：真实模型与预置客户端工作流 A/B

`benchmark:hybrid-model` 使用现有 Chat Completions 服务和隔离 Windows fixture，不启动另一个代理，也不安装依赖、修改客户端配置或新增服务。本轮验证 DeepSeek，请求使用其 `thinking:disabled` 扩展；其他提供方尚未验证。通过进程环境提供 `WINCODE_MODEL_BASE_URL`、`WINCODE_MODEL_NAME` 和 `WINCODE_MODEL_API_KEY`；凭据仅放入 HTTP Authorization，不写入报告或命令参数。端点使用 HTTPS，本地 API stub 可使用 loopback HTTP；禁止携带凭据的 URL 和重定向，不自动重试。缺少配置时在启动窗口前拒绝。模型调用／结果回填采用 [DeepSeek 官方工具调用协议](https://api-docs.deepseek.com/guides/tool_calls/)。

默认每任务每路径 20 次，共 160 个样本；显式传入 1–19 次仅作小样本验证。每个任务最多 8 次模型请求、120 秒，单次模型输出上限 2048 token，保持 `temperature:0`、`thinking:disabled`。每个样本使用新对话，交替两条路径先后顺序，共享已校验的连接和明确选择的 PID/HWND。正式运行期间保持基准源码稳定；报告记录脚本 SHA-256、Gateway 构建身份、请求模型名及各响应实际返回的模型／fingerprint。模型别名不保证固定权重版本。

- A：模型获得当前注册表中的 `wincode_ui_inspect`／`wincode_ui_review` 完整 schema，使用明确 scoped query、compact、合理预算和既有 review。宿主只允许固定目标、无截图及 fixture 的明确 XAML 候选文件，仍经过标准 MCP 和只读观察校验。
- B：模型获得 `run_readonly_workflow` 私有基准入口及 T1–T4 的完整配方说明，选择已安装的匹配配方。可信 TypeScript 程序在内部完成相同查询、条件分支与统计，再返回步骤证据和 findings。该入口仅属于基准宿主；没有注册为 WinCode MCP 工具。
- 两边任务提示给出相同的选择器、最佳查询和独立状态计数规则。预期值只在宿主断言中存在，不发给模型；最终 JSON 除值正确外，还必须有任务要求的真实读取证据。

模型发出同一轮多个工具调用时，宿主先执行一项观察，随后对每个尚未执行的 call ID 返回 `DEFERRED_AFTER_OBSERVATION` 和 `workStarted:false`。模型读取观察和延期回执后，自己重新决定后续请求；宿主不把旧计划自动加入队列。这是该基准的保守客户端策略，不能解释成服务器已支持整轮调度。

报告写入 `test-tmp/hybrid-model-<timestamp>/report.json`，逐次 JSON transcript 保留请求正文、模型响应、usage 和工具回执。实际 token 按提供方返回的每次 `prompt_tokens + completion_tokens` 累加，包含 schema、配方说明、重复历史、工具结果、最终回答和缓存命中的 prompt token；没有完整 usage 时返回 null，不从字节估算。`modelRequests` 包括最终回答及失败请求，`modelToolRounds` 只计带工具调用的完成响应；耗时统计覆盖整个任务，共同冷连接和窗口发现单列。

比较表只用成功样本计算 P50/P95，同时报告失败数量；任一侧未完成全部计划样本，`validComparison:false`，收益百分比为 null。每个样本后检查 helper 已无活动 PID，收尾观察 Gateway 和 fixture 实际退出。前台采样只描述本轮观察。报告、API 凭据和本机配置均不提交到仓库。

**解释边界：** B 测量的是预先开发好的领域工作流，包含运行时配方说明的上下文成本；没有测量模型生成程序、开发配方或生产宿主的完整成本。两边给模型的工具目录大小不同，token 收益包含 schema 减少与输出投影，不能全部归因为条件编排。该实验没有隔离这些因素，也未证明普通 MCP 客户端对 batch 的需求。结果用于判断是否继续客户端路线，不直接触发服务器 batch 或通用 runtime。

第三轮新增 3 项自动化契约／场景测试：真实本地 HTTP stub 下的 A/B 往返和 usage 计量；依赖调用延期及写操作／目标变化的分发前拒绝；缺失 usage、HTTP 错误与请求期间取消。后者验证不重试、不记录凭据及保留部分计量。

### 第三轮本地测量结果（2026-10-06）

类型检查、构建、源码／产物指纹核对通过；完整自动化回归 470/470 通过，含本轮新增 3 项测试，清单共 59 个测试文件。真实测量使用 Node 22.23.1、`deepseek-flash`、非 thinking、temperature 0。每任务每路径 20 次，共 160 个样本和 345 次真实模型请求。混合路径 80/80 通过；原生路径 77/80 通过，T3 的第 10、16、19 次输出为自然语言，未满足约定的最终 JSON 格式。失败回合保留，不重跑覆盖；因此整个报告 `success:false`，T3 的 `validComparison:false`、收益百分比为 null。这是基准记录的模型输出契约失败，不能报告为 WinCode UIA 操作失败，也不能算成全部任务通过。

| 任务 | 通过数：原生 / 混合 | 平均实际总 token：原生 / 混合 | token 减少 | 原生 P50 / P95（ms） | 混合 P50 / P95（ms） | 中位耗时减少 |
|---|---|---|---|---|---|---|
| T1 | 20 / 20 | 5304.60 / 2353.80 | 55.63% | 2713.48 / 3277.36 | 2253.00 / 2534.53 | 16.97% |
| T2 | 20 / 20 | 6863.50 / 3721.00 | 45.79% | 2763.69 / 3176.00 | 2380.80 / 2802.57 | 13.85% |
| T3 | 17 / 20 | 11724.06 / 4219.40 | 不判定 | 4805.06 / 6778.73 | 3316.77 / 3700.01 | 不判定 |
| T4 | 20 / 20 | 5986.30 / 2891.15 | 51.70% | 2934.90 / 3169.75 | 2500.70 / 2754.69 | 14.79% |

T3 原生行的均值／分位数仅描述 17 个成功样本；未包含 3 次失败的代价，不能用于达标或整体成功率推断。所有逐次记录均保留失败请求的 usage 和完整耗时。

T1、T2、T4 每条路径均为 1 次工具观察轮次、2 次模型请求（含最终回答）；最佳原生 T2 已一次读取共同父区域，编排没有减少其轮次。T3 混合为 1 次工具观察轮次、2 次模型请求；原生成功样本平均为 2.12 次工具观察轮次、3.12 次模型请求。两条路径的底层调用仍分别为 1、1、2、1，共 200 次 MCP UI 调用。工具目录 JSON 为原生 6043 字节、混合 1802 字节，因此不能将 token 减少全部归因为少一次模型往返。

Native audit 观察到 201 次 helper start（含窗口发现）。独立的收尾检查用审计 helper PID／开始时间和当前 Windows 进程创建时间排除 PID 重用，201 次启动对应 186 个不同 PID，未发现残留。Gateway 和 fixture 实际退出，4458 次前台采样未观察到 fixture 进入前台。证据保存在本次 `test-tmp/hybrid-model-1791283297644/` 下的 report、逐次 transcript 和 `helper-exit-check.json`。

**当前决策：继续客户端领域工作流。** 完成的 T1/T2/T4 在本配置下达到 token 门槛，但 T2 未减少模型轮次，T3 原生路径存在输出契约失败，且普通 MCP 客户端对 batch 的需求未验证。实验支持保留并使用预置客户端配方；服务器只读 batch、discovery 和通用 runtime 的进入条件仍未满足。

## 第四轮：终端接入预置客户端配方（2026-10-06）

增加参数化 `checkbox-audit` 配方及 `WinCodeSession.readonlyUiRecipe`，现有 JSON 会话通过 `action:"readonly-ui"` 使用同一实现。T2/T3 的两套基准共用此配方；保留标准 MCP、单工具协议、固定目标、步骤证据、取消和关闭行为。没有新增依赖、服务器工具、解释器或写操作。

本轮新增 3 项行为测试：明确控件集合与条件分支的完整性；真实终端会话的执行前拒绝、配方及原生调用复用；真实 UIA 阻塞后的取消／关闭和进程回收。配方接入后的完整回归 471/471 通过，清单仍为 59 个测试文件。首次回归与构建并行且未采用项目 SDK，曾因暂缺 build-manifest 与系统 10.0.302 失败；最终回归在构建完成后通过 `scripts/lib/dotnet.mjs` 验证并使用本地 10.0.303 SDK，未调整 global.json 或安装 SDK。

短程基准还复现了已有总 deadline 分类竞争：MCP 先抛出 `Request timed out`、而总截止时间已过且工作流 timer 尚未处理时，原来误报 WORKFLOW_ERROR。现按实际截止时间统一返回 DEADLINE_EXCEEDED，并在原有预算测试中加入可控时钟场景，保留完成证据、停止后续分发且不重试；基准在断言前保存实际超时结果便于核查。

该修正后的最终复核：类型检查及构建通过；工作流与模型 HTTP 契约测试 7/7，通过真实 Windows 会话测试 5/5；`benchmark:hybrid -- 1` 的 8 个正常路径样本及 7 类故障／状态场景全部通过，审计观察到 21 次 helper start，实际 helper/Gateway 退出检查通过。最终短程报告位于 `test-tmp/hybrid-ui-1791285314223/report.json`，回归及会话日志位于 `test-tmp/hybrid-recipe-checks/`。短程检查不作为性能测量，本轮没有请求真实模型，也没有更新第三轮 token 或缓存结论。

## 第五轮：错误模型回复的测试先行验收（2026-10-06）

本轮只调整模型基准宿主 `scripts/lib/hybrid-model.ts`，不改变原生 MCP 工具、客户端只读配方、Gateway 或 UIA 生命周期。新增 3 项自动化测试，固定回复矩阵共 24 个场景，先运行测试再修改实现；不使用真实模型 API 或个人凭据。

| 测试 | 实现修改前 | 修复后 |
|---|---|---|
| 被拒绝或部分失败的观察，随后收到碰巧正确的最终答案 | 失败；12 个矩阵场景中 10 个被误判成功 | 通过；不能用拒绝证据满足任务要求 |
| 响应标记截断／中断或与工具调用不一致，但参数看似可执行 | 失败；10 个矩阵场景都启动了读取 | 通过；0 次 MCP 分发，保留已收到的 usage |
| 工具文字诱导模型换目标或调用写操作，固定回复故意照做 | 已通过；两条路径均在分发前拒绝 | 保留回归，无需为制造红灯修改守卫 |

红灯基线为 `e798f991126968a71216e6bc994bf3b535d5f01e`。`test-tmp/hybrid-tdd-checks/` 保存 red.log、baseline.json、原始实现与测试快照、green.log、完整回归和真实窗口回放记录。首次运行结果为 3 项测试中 2 项失败、1 项通过，随后修复后该文件共 6 项测试全部通过；测试场景与预期不变，类型检查期间仅补充 MCP text 内容块的类型断言。

修复后的有效观察登记以通过校验的完整工作流报告为依据，并读取实际节点 AutomationId；底层响应自报 success 不能直接成为最终答案的证据。配方整体失败时不登记部分步骤作为成功配方证据，步骤报告本身仍保留。带工具调用的模型响应必须以 `finish_reason:"tool_calls"` 完整结束，其他完成原因在分发前拒绝；无工具调用的最终回答仍要求 stop。此约束依据 [DeepSeek Chat Completions 官方完成原因定义](https://api-docs.deepseek.com/api/create-chat-completion/)。

真实窗口验收使用隔离 WPF 的实际只读响应，在客户端注入歧义或诱导文字，再以固定回复回放模型犯错的动作；不声称夹具本身产生了恶意文字，也不测量真实模型受诱导的概率。原生／混合路径各 3 个场景，共 6 个全部通过：截断回复 0 次 UI 分发，诱导出的写操作及目标变化均 workStarted=false。4 次合法实际读取的 helper、Gateway 与夹具窗口均已确认退出；本地回复不提供 usage，避免将模拟数字冒充实测 token。

类型检查与构建通过。第一次完整回归 473/474，已有 lifecycle-cancellation 测试在默认并发下超过 1 秒子进程退出等待；该文件单独复核 14/14。未修改无关代码或放宽断言，最终采用已验证的项目 SDK 10.0.303、测试文件并发数 4，完整回归 474/474。首次失败日志保留，不能声称默认并发首轮全通过。

本轮验证错误执行的拒绝与实验结果可信性，不证明所有第三方客户端具备相同守卫，也不更新第三轮真实模型通过率、token 或缓存收益。原始日志可能包含本机路径，所有实验附件保持 Git 忽略，不自动视为匿名分享材料。
