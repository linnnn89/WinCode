# Security Policy / 安全策略

## Supported Versions / 维护版本

The `0.13.x` compatibility line and current `main` (**0.17.1**) are maintained. Older versions do not receive separate backports. Supported runtimes are Node.js 24 (primary) and Node.js 22 (compatibility) on Windows x64; build prerequisites are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

当前维护最新 `0.13.x` 分支与 `main` 分支（源码版本 **0.17.1**），不承诺对更早版本单独回补。支持环境为 Windows x64 上的 Node.js 24（主线）与 Node.js 22（兼容线），构建要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Reporting a Vulnerability / 漏洞报告方式

Report suspected security issues privately via [GitHub Private Vulnerability Reporting](https://github.com/linnnn89/WinCode/security/advisories/new):

- Include the affected version and `buildId`, reproduction steps, expected vs. observed behavior, and a minimal sanitized example.
- Do not upload credentials, personal databases, or unrelated private source code.
- Please coordinate with the maintainer before disclosing exploit details in public issues.
- Reports are triaged based on maintainer availability without a fixed SLA. Confirmed issues and mitigations are shared through the advisory thread and release notes as appropriate. Passing CI scans alone does not imply an open alert is resolved until its code path is verified.

疑似安全漏洞请通过上述 [GitHub 私密报告渠道](https://github.com/linnnn89/WinCode/security/advisories/new) 提交：

- 请附上受影响的版本号与 `buildId`、复现步骤、预期与实际行为，以及脱敏后的最小复现样本。
- 请勿上传凭据、个人数据库或无关私有代码；在协调修复前请勿公开披露利用细节。
- 维护者按可用时间评估与跟进，不承诺固定响应或修复时限。扫描检查通过不代表既有安全告警已关闭，须结合具体代码路径核实。

## Security Boundaries & Non-Goals / 安全边界说明

WinCode enforces application-level guardrails for local coding agents, **not** OS-level multi-tenant sandboxing. Please keep the following boundaries in mind (and report bugs if an implemented check can be bypassed):

- **Workspace & filesystem containment**: Fixed mode binds to `--workspace` (or launch `cwd`) and rejects other roots; `--dynamic-workspace` isolates per-request roots and rejects symlink/junction traversal in managed cache and trash paths. However, path validation is not an atomic kernel sandbox against concurrent filesystem replacement.
- **Explicit execution trust**: Native Git runs only in directories explicitly authorized via `--trust-git`; MSBuild design-time evaluation runs only when `--roslyn-config` explicitly enables `allowProjectEvaluation: true`; Repomix runs via direct Node JS entry rather than shell wrappers.
- **Process ownership**: WinCode terminates only helper processes it spawned (`WinCode.UIA.Host`, `WinCode.Code.Host`, Repomix child) during cancellation or shutdown—never the inspected user application PID.
- **UI inspection, writes, and audit logs**: UI inspection and screenshots can expose live window content, so bug reports should use isolated fixtures. Background writes (`--ui-write-window`) and WPF shortcuts (`--ui-shortcut-window`) require launcher-bound `<PID>:<HWND>:<processStartFileTime>` identities and are refused when the target process owns the foreground window. Local `REC / WinCoding` indicators, `%LOCALAPPDATA%/WinCode/logs/ui-audit` logs, and delivery manifest hashes provide operational visibility and local consistency checks, not tamper-proof audit storage or cryptographic release signatures.
- **Resource & memory limits**: Each Gateway instance caps raw request JSON at 64 KiB (before normalization) and admits up to 32 concurrent business calls plus 4 lightweight status calls. Cache and output limits bound managed storage and serialized replies, not total Node/.NET process RSS or stuck kernel I/O.

WinCode 提供面向本机编程智能体的应用层防护边界，**不构成操作系统级沙盒或多租户强隔离**（若上述已实现的边界检查可被绕过，欢迎按漏洞流程报告）：

- **工作区与文件系统边界**：固定模式绑定启动根目录并拒绝跨根访问；动态模式按请求隔离项目目录，受管缓存与本地回收目录拒绝符号链接/目录联接（Junction）。但应用层路径检查不提供对抗并发恶意文件系统替换的内核级原子隔离。
- **外部执行显式授权**：原生 Git 仅在 `--trust-git` 显式授权的仓库运行；Roslyn MSBuild 设计时项目求值仅在 `--roslyn-config` 显式开启后对指定项目运行；Repomix 直接由 Node 执行 JS 入口，不经过 shell 拼接。
- **子进程归属**：取消与关闭清理仅回收本实例创建的辅助子进程，绝不终止被检查的目标应用进程。
- **桌面取证、后台写保护与本地审计**：UI 检查和截图可读取窗口内容，提交复现材料时请使用隔离测试夹具。后台写值（`--ui-write-window`）与后台 WPF 快捷键（`--ui-shortcut-window`）均须启动者绑定 `<PID>:<HWND>:<processStartFileTime>`，且在目标进程位于前台时拒绝执行。本地 `REC / WinCoding` 浮层、审计日志与交付清单哈希用于运行提示与完整性核对，不具备防篡改或数字签名效力。
- **资源上限边界**：单实例限制原始请求 JSON 不超过 64 KiB，最多并发受理 32 个业务请求与 4 个状态请求；缓存与输出预算不等于进程总物理内存（RSS）硬上限，也无法强制抢占挂起的底层系统 I/O。
