# Security policy / 安全策略

The latest 0.13.x version and current `main` are maintained. Older versions do not have a separate backport commitment. Supported runtimes are Node 24 (primary) and Node 22 (compatibility), on Windows x64; build requirements are in [CONTRIBUTING](CONTRIBUTING.md).

目前维护最新 0.13.x 版本与 `main`，不承诺对旧版本单独回补。Windows x64 上以 Node 24 为主要环境、22 为兼容环境；构建要求见贡献指南。

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/linnnn89/WinCode/security/advisories/new). Include the affected version/build identity, reproduction steps, expected and observed behavior, and a minimal sanitized example. Do not include credentials, personal databases or private source unnecessarily. Avoid publishing exploit details in a public issue before coordination with the maintainer.

疑似漏洞请通过上述 GitHub 私密报告渠道提交，附受影响版本/构建身份、复现步骤、预期与实际表现，以及去敏的最小示例。无需上传凭据、个人数据库或无关私有源码；协调修复前避免在公开 Issue 发布利用细节。

Reports are triaged as maintainer availability permits. There is no guaranteed response or patch deadline. Confirmed issues and mitigations will be communicated through the report and, where appropriate, a release or advisory. An open scanning alert remains unresolved until its code path and scanning status have been verified; passing CI alone is insufficient.

维护者按实际可用时间评估与复现，不承诺固定响应或修复时限。确认的问题及缓解措施通过报告沟通，并按需发布补丁或安全公告。扫描任务成功不等于已有告警已关闭。

Relevant boundaries include workspace path containment, shell arguments and process ownership, bounded resource consumption, and UI audit integrity. WinCode may terminate helper processes it owns during cleanup; inspected application PIDs must remain outside that ownership. UI inspection and screenshots can expose application data, so reports should use isolated fixtures. Local audit logs and content hashes are diagnostic evidence, not tamper-proof records or release signatures. Report a violation of these boundaries even when a test currently passes.
