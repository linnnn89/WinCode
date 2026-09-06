# WinCode v0.5 稳定性改造任务

请基于当前仓库进行一次以 **生命周期管理、资源释放、缓存边界和长期运行稳定性** 为核心的工程改造。

## 总体原则

当前 v0.4 的产品定位、MCP 高层工具设计、Serena/Repomix Adapter 架构以及“证据不足返回 UNKNOWN”的原则均应保留。

本轮不要扩大功能范围，不要引入 GUI、FlaUI、Snoop、PerfView 或 Roslyn Host，也不要重写现有架构。

目标是：

> 让 WinCode 能作为长期驻留的 Windows MCP Gateway 稳定运行，不出现子进程残留、缓存无限增长、workspace 状态污染或资源无法释放等问题。

---

## 1. 完善统一生命周期管理

新增统一的 ResourceManager 或等价机制，用于管理所有长期资源，包括：

- Serena/MCP 子进程
- MCP Client / Transport
- Timer
- File watcher（如果存在）
- 临时文件
- 长期 Adapter 资源
- 其他需要 dispose/close 的资源

要求：

- 所有资源具有明确 owner
- 支持统一 `dispose()` / `close()`
- shutdown 可重复调用且安全
- WinCode 收到 SIGINT / SIGTERM 时完成 graceful shutdown
- 不允许退出后残留 Serena、Node、Python 等子进程
- 子进程异常退出时不能带崩整个 WinCode

不要在各 CompositeTool 中自行管理 child process。

---

## 2. 审核 Serena Adapter 生命周期

重点确认：

- command found、handshake、project active、semantic query usable 仍然分层报告
- Serena 连接采用合理的 lazy initialization / reuse
- 不应每个 tool call 都重复启动 Serena
- Serena crash / timeout 后能够清理旧状态，并允许后续重新初始化
- workspace 切换时必须正确处理 Serena project/session 状态
- shutdown 时必须可靠关闭 MCP transport 和相关子进程

避免形成僵尸进程或失效连接长期留在内存中。

---

## 3. 增加 Session / Workspace 生命周期概念

当前 active workspace 不应成为不可控的全局状态。

增加轻量 SessionManager 或等价设计，至少明确管理：

- 当前 workspace
- workspace fingerprint
- adapter state
- cache namespace
- createdAt
- lastActivity

第一版不必支持复杂多用户并发，但架构不能假设未来永远只有一个不可切换 workspace。

`workspace_open` 切换项目时，需要明确：

1. 停止或重置旧 workspace 专属资源
2. 清除不能跨 workspace 复用的状态
3. 切换 cache namespace
4. 初始化新 workspace
5. 避免上一项目的 symbol/context 泄漏到下一项目

---

## 4. 加强缓存边界

保留现有：

- TTL
- LRU
- fingerprint
- memory/disk cache

但增加 **容量限制，而不仅是 entry 数量限制**。

至少考虑：

- `maxMemoryBytes`
- `maxDiskBytes`
- 单 entry 最大大小
- cache clear / workspace release
- expired entry cleanup

避免大型 Repomix/context snapshot 作为一个 entry 就占用数百 MB。

对于超大结果，应优先：

- 文件落盘
- 返回摘要/引用
- 避免长期保存完整字符串在 Node heap 中

缓存淘汰后确保对象引用真正释放。

---

## 5. 优化 Workspace Fingerprint

当前 fingerprint 方向保留，但避免连续 MCP 调用反复执行昂贵的：

- `git status`
- 文件 stat
- directory scan

增加很短的 fingerprint memoization / debounce，例如数秒级有效期。

目标：

连续调用：

- prepare_context
- find_symbol
- find_references
- analyze_change_impact

时不要重复执行完全相同的 workspace 扫描。

同时保持代码发生变化后能够及时失效。

---

## 6. 所有外部操作必须具有超时与取消边界

重点审计：

- child_process
- Serena MCP 请求
- Repomix CLI
- git
- dotnet
- 文件扫描

不能存在无限等待。

统一定义合理 timeout，并将失败转化为结构化结果。

例如：

```text
status: failed
reason: timeout
provider: serena
recoverable: true
```

不要因为单个 Adapter 超时导致整个 MCP Server 崩溃。

---

## 7. 增加 Health / Diagnostics 能力

在现有 diagnose 能力基础上，增加或完善一个轻量 health 状态，用于 Agent 和开发者检查长期运行状态。

建议包含：

- active workspace
- process uptime
- Serena commandFound / handshakeOk / projectActive / semanticQueryUsable
- Repomix availability
- cache memory entries / estimated bytes
- disk cache size
- managed child process count
- Node memory usage
- last adapter error

不要把 health tool 做成复杂监控平台。

---

## 8. 并发安全检查

检查可能同时发生的 MCP Tool 调用。

重点避免：

- 两个请求同时初始化 Serena
- 两个请求同时切换 workspace
- 两个请求同时重新生成同一 snapshot
- cache 写入竞争
- shutdown 与正在执行的请求发生 race condition

可使用：

- initialization promise
- per-workspace lock
- single-flight
- AbortController

等简单机制。

不要为了并发做过度复杂的线程模型。

---

## 9. 保持现有 Agent 语义不变

以下原则不能因稳定性改造而退化：

- `source` 不等于 confidence
- fallback 必须显式标识
- 0 references 不代表 safe
- ambiguity / incomplete query 应保持 UNKNOWN
- 不允许 evidence 不足时倾倒整个 repo
- `includeFullText` 仍只能围绕 related files
- Serena 未真正 handshake 时不得报告为 connected

这些属于 WinCode 的核心产品行为。

---

## 10. 测试重点

新增或补充测试覆盖以下情况：

### Lifecycle
- server start → stop
- stop 调用两次
- Serena 启动后正常退出
- Serena crash 后恢复
- workspace A → workspace B

### Cache
- TTL
- entry eviction
- byte limit
- large snapshot
- workspace cache isolation
- clear 后内存引用释放

### Failure
- Serena timeout
- Repomix timeout
- git 不存在
- dotnet 不存在
- malformed workspace
- shutdown during active request

### Regression
确保现有 v0.4 tests 全部继续通过。

---

# 本轮明确不要做

不要：

- 引入 GUI
- 接入 FlaUI / Snoop / PerfView
- 新建 Roslyn Host
- 重写 Serena 或 Repomix
- 大规模修改 MCP Tool 名称
- 增加大量新 Tool
- 建立复杂数据库
- 为未来假设做过度抽象

优先使用当前 TypeScript / Node.js 架构完成稳定性增强。

---

# 完成后输出

完成开发后请：

1. 运行 build、typecheck、现有测试和新增测试。
2. 检查是否存在未处理的 child process / timer / transport。
3. 说明修改过的生命周期模型。
4. 报告缓存限制与淘汰策略。
5. 报告仍存在的已知风险。
6. 如发现当前架构已有足够机制，不要为了满足任务而重复造模块。
7. 最后给出简短的 v0.5 changelog。

本轮评价标准不是“新增多少功能”，而是：

> WinCode 是否能够连续运行较长时间、频繁切换和分析项目，同时保持资源可控、状态可靠、失败可恢复。