# Security Policy

## Supported Versions

We release security patches and updates for the active development version.

| Version | Supported          | Notes |
| :---    | :---:              | :---  |
| 0.8.x   | :white_check_mark: | Current active release |
| < 0.8.0 | :x:                | Unsupported; please upgrade to the latest version |

---

## Reporting a Vulnerability

The WinCode team takes the security and integrity of user environments seriously, particularly concerning desktop process management, UI automation, and workspace safety.

### ⚠️ DO NOT Create a Public Issue
If you discover a potential security vulnerability, **please do not create a public GitHub Issue or discuss it publicly** until a coordinated fix is released.

### Disclosure Channel
Please use GitHub's private vulnerability reporting feature:
1. Navigate to the [WinCode Security Advisories](https://github.com/linnnn89/WinCode/security/advisories) page.
2. Click the green **"Report a vulnerability"** button to submit a private report.
3. Reports submitted through this channel are encrypted and only accessible to repository maintainers.

### What to Include in Your Report
To help us triage and resolve the issue quickly, please provide:
- A clear description of the potential vulnerability and its impact.
- Step-by-step instructions to reproduce the issue (including sample code or proof-of-concept if applicable).
- The operating system (Windows 10/11 version, architecture) and Node.js/.NET SDK versions.
- Any suggested mitigations or fixes.

---

## Response & Resolution Process

1. **Initial Acknowledgment**: We will review and acknowledge receipt of your vulnerability report within **48 hours**.
2. **Triage & Verification**: We will confirm the issue, assess the blast radius, and keep you informed of our progress.
3. **Fix & Patch**: A fix will be developed and verified in a private security fork.
4. **Coordinated Disclosure**: Once patched, a new version and an official GitHub Security Advisory will be published with full credit to the reporter (unless anonymity is requested).

---

## WinCode Security Model & Scope

When evaluating potential vulnerabilities in WinCode, please consider its design principles:
- **Target Process Immunity**: UI inspection is strictly non-destructive; gateway processes must never terminate, modify, or inject into user application PIDs.
- **Safe Trash & Path Containment**: All file removals must quarantine to `trash/` with metadata and strictly reject directory traversal (`..`) or symlink escapes.
- **Evidence Honesty**: Output is strictly budget-bounded to prevent local token or memory exhaustion.

---

# 安全策略 (简体中文)

## 支持的版本

我们仅针对最新的开发版本提供安全补丁与稳定性更新。

| 版本    | 支持状态            | 说明 |
| :---    | :---:              | :--- |
| 0.8.x   | :white_check_mark: | 当前活跃发布版本 |
| < 0.8.0 | :x:                | 已停止维护，请升级至最新版本 |

---

## 漏洞报告指引

WinCode 团队高度重视用户系统的安全性与运行环境的完整性，特别是在 Windows 桌面进程管理、UI 自动化取证与工作区防误删方面。

### ⚠️ 请勿提交公开 Issue
如果您发现了潜在的安全漏洞，**请切勿创建公开的 GitHub Issue 或在公开场合讨论**，以免造成 0-day 风险。

### 报告渠道
请使用 GitHub 官方提供的私有漏洞报告通道：
1. 前往仓库的 [Security Advisories](https://github.com/linnnn89/WinCode/security/advisories) 页面。
2. 点击绿色的 **"Report a vulnerability"** 按钮提交私密漏洞报告。
3. 通过该渠道提交的信息全程保密，仅仓库维护者可见。

### 报告时建议包含的信息
- 漏洞的详细描述及其潜在影响；
- 完整的复现步骤或概念验证（PoC）示例；
- 测试所用的系统环境（Windows 10/11 版本、Node.js 与 .NET SDK 版本）；
- 任何您建议的缓解措施或修复补丁。

---

## 响应与处理流程

1. **初始确认**：我们将在 **48 小时内** 审核并确认收到您的漏洞报告。
2. **评估复现**：我们将核实漏洞并评估其影响范围，并在处理期间与您保持同步。
3. **修复发布**：补丁将在私有环境中验证后合入主分支并发布新版本。
4. **协同披露**：新版本发布后，我们将通过 GitHub Security Advisory 正式发布安全通告，并为报告者署名致谢（除非您希望匿名）。

---

## WinCode 的安全设计准则

评估 WinCode 的安全问题时，请参考以下核心设计原则：
- **目标应用 PID 绝对免疫**：UI 取证操作必须是非侵入式的，严禁杀死、注入或篡改被测用户进程。
- **安全防误删与路径边界**：文件清理操作严禁硬删除，必须进入附带元数据的 `trash/` 隔离区，且严格防御路径穿越（`..`）或符号链接逃逸。
- **有界资源预算**：严格限制图片分辨率、文本与传输预算，防御本地内存泄漏与 Token 上下文耗尽。
