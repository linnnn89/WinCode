# WinCode Skill 安装、维护与 MCP 配置指南

适用于 **0.13.1**，核对日期 2026-09-08（北京时间）。以下使用本机 `I:/WinCode` 路径举例；其他机器必须替换路径。客户端界面名称随版本变化，以实际界面为准。

## 1. 三个独立对象

- **Skill 手册**指导 Agent 选择工具和使用规范字段，不启动服务器。
- **磁盘交付物**包含 Gateway、原生 UI Host、构建身份和交付清单。
- **MCP 连接实例**是客户端已经启动的进程；更新源码、构建或复制 Skill 都不会自动更新这个进程。

架构与数据流见 [架构说明](WinCode-架构与数据流说明.md)。待办见 [当前计划](WinCode-下一轮工程化迭代计划书.md)，不要按历史计划重复安装和升级。

## 2. 构建与交付核对

预先准备 Windows x64、Git、Node 24（22 兼容；不再支持 20）以及 `global.json` 锁定的 .NET SDK 10.0.303。已发布的 framework-dependent Host 需要 .NET 10 Windows Desktop 运行时。安装前提组件属于环境准备，不由下列检查隐式完成。

在仓库根目录执行：

```powershell
npm ci
npm run check
npm run delivery:verify
```

`check` 进行类型检查、Gateway 构建、锁定 NuGet restore、Release UIA/Code Host 与控制台夹具构建、核心回归、新 stdio 验证与交付清单生成。交互桌面验收另执行 `npm run check:desktop`，需要可用 Windows 桌面。真实 Roslyn/TavernDesk 验收按对应入口执行，详见 [CONTRIBUTING](CONTRIBUTING.md)。

`npm run build` 只构建 Gateway，不能单独证明原生 Host、Skill 和整个交付物一致。生产使用发布的 Release Host；`npm run dev` 才显式启用开发回退。报告位于 `test-tmp/check/`，内容哈希不是发布签名。

## 3. Skill 的规范来源与同步

仓库维护四份手册：[SKILL.md](skills/wincode/SKILL.md)、[代码](skills/wincode/references/code.md)、[UI](skills/wincode/references/ui.md)、[诊断](skills/wincode/references/diagnostics.md)。入口只负责路由，共享规则与字段按工具族查阅；不把全部手册塞进每次会话。

对本机已约定的安装目录，先检查，再按需同步：

```powershell
npm run skill:check -- C:/Users/40218/.agents/skills/wincode
npm run skill:sync -- C:/Users/40218/.agents/skills/wincode
npm run skill:check -- C:/Users/40218/.agents/skills/wincode
```

这些是路径示例，不是跨机器通用目录。同步只管理四份文件，先备份被修改的已有文件，再写入；额外文件不受管，不修改 MCP 配置。受管文件中的本地修改会被仓库版本替换，因此规范更新应先进入仓库；不要把个人配置混入手册。首次同步也可创建目标目录。受管手册改变后重新生成并核对交付清单。

**未知字段保持容忍，但不会生效。** 参数名称、大小写、类型和范围以手册字段表为准。例如 `automationId` 是规范字段，`automationID` 不会成为筛选条件；仅含未知字段的 query 仍缺少必需条件。适配器配置字段不能伪装成 MCP 请求参数。

## 4. 注册 stdio MCP

在客户端添加 stdio 服务器，分别填写：

| 配置项 | 本机示例 |
| --- | --- |
| 名称 | `wincode` |
| 命令 | `node`，或该机器 Node 可执行文件的绝对路径 |
| 参数 1 | `I:/WinCode/dist/index.js` |
| 参数 2 | `--workspace` |
| 参数 3 | 需要分析的工作区绝对路径，例如 `I:/New-tarven` |

参数应为独立数组项，不要拼成一条 shell 字符串。若客户端接受 `mcpServers` 配置，可使用：

```json
{
  "mcpServers": {
    "wincode": {
      "command": "node",
      "args": ["I:/WinCode/dist/index.js", "--workspace", "I:/New-tarven"]
    }
  }
}
```

不同客户端配置格式可能不同；本例不能直接替代 Codex 自身配置文件格式。不要重复注册多个同名或路径不同的旧实例。WinCode 走 stdio，无需另设 HTTP 服务。

## 5. 验证实际连接

1. 让客户端重新建立 WinCode 连接，再调用 `wincode_hello_world`；核对实例身份、版本、buildId 和工具 schema，而不仅看软件版本字符串。
2. 用 `npm run delivery:verify` 检查磁盘交付物；将磁盘身份与实际连接对应起来。独立启动的新 stdio 会话通过不等于当前宿主已重连。
3. 对目标工作区执行一次规范请求，确认返回的是该工作区及声明范围。需要主动健康探测时调用 `wincode_diagnose_project({})`。

0.12.1 起 hello 不主动启动探测进程；unknown/null 表示未探测，不代表不可用。已知健康结果也可能陈旧。旧版本 hello 的行为不能套用新版说明。

0.13 系列已经退役外部 Serena，默认 local-text；C# 语义使用随产品交付的 Code Host，通过显式 --roslyn-config 配置入口项目、Configuration、TFM、SDK 与求值许可，字段示例见代码手册。真实 Host/MCP 验收通过也不代表实际客户端已启用 Roslyn。0.12.4 起 Repomix 直接执行已安装 JavaScript bin，不再使用 cmd/npx 包装链，也不会自动下载；非标准安装和降级边界见诊断手册。

## 6. 常见偏差

| 现象 | 核对与处理 |
| --- | --- |
| 源码是新版，hello 返回旧版 | 核对实际命令、路径、instanceId 和启动时间；通过客户端重连，不以强杀宿主或复制文件冒充完成 |
| 字段被忽略，结果不像预期 | 对照规范字段表和实际工具 schema；容忍未知字段并不赋予其语义 |
| Host 缺失或身份不符 | 完整执行锁定构建和 delivery:verify；不混用旧 DLL、新 Gateway 或开发 Host |
| Roslyn/Repomix 不可用 | 先核对 provider、显式配置、项目求值许可、已知健康和恢复动作；Roslyn 失败不会暗中换成本地文本，Repomix 降级不代表语义验收成功 |
| UI 查不到或出现多个目标 | 核对 PID/HWND 和大小写准确的查询；只有 complete 且 unique 才能声称唯一定位 |

更新后仍无法核对客户端身份时，保留“客户端未验收”状态与实际证据，不反复尝试未声明参数。

0.13.1 的已知工具失败以同源 JSON 文本和 structuredContent 表达，UI/trash 保留领域信息；未知工具在正常受理时返回 JSON-RPC -32602。未知字段容忍策略与未知工具的协议错误是两回事。影响分析只返回一个 JSON 文本块，formattedReport 在对象内。
