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
```

需要现有的 Release UIA Host 发布目录和 fixture 已完成的 NuGet restore。缺少这些依赖时按常规项目配置处理；基准不自动安装、重试或降级。`benchmark:hybrid -- 1` 是快速工作流验证，不能替代默认 20 次测量。结果写入 `test-tmp/hybrid-ui-<timestamp>/report.json`，同目录保存背景窗口截图及其步骤证据。实验输出不提交到 Git。

## 客户端示例

复用 `WinCodeSession`，先通过 `wincode_ui_list_windows` 取得候选，再由调用方明确选择 PID/HWND。整个工作流固定这一身份，不根据标题重新选择窗口。

```ts
import { WinCodeSession } from '../src/Client/SkillSession.js';
import { runReadonlyUiWorkflow } from '../src/Client/ReadonlyUiWorkflow.js';

const session = new WinCodeSession({ workspace: selectedWorkspace });
try {
  const result = await runReadonlyUiWorkflow(session.call.bind(session), selectedTarget, async reader => {
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
