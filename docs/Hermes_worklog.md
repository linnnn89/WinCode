# Hermes 协作工作记录

记录 Hermes Agent 在本机（Windows / HERMES_HOME=O:\hermes）围绕本仓库的安装与配置变更。只记与本仓库相关的持久变更；工具语义与恢复手册以仓库 `skills/wincode/` 受管文件为准。

## 2026-09-15 — wincode 技能安装到 Hermes + 不固定工作区的 MCP 使用方式

**目标**：把本仓库的 wincode 技能安装到本机 Hermes；在 Hermes 建立 WinCode MCP 使用方式，不在配置中固定 workspace，每个项目在使用时由会话自行定位到项目文件夹。

**关键变更**

1. 技能安装（受管四份文件）：`npm run skill:sync -- O:/hermes/skills/wincode`。
   - 安装前 `skill:check` 退出码 2（四份均缺失）；安装后退出码 0，哈希一致。
   - 首次安装无旧文件可备份，脚本按既有行为留下空的 `.wincode-backup-<uuid>` 目录（不影响发现，未处理）。
2. Hermes MCP 条目：`mcp_servers.wincode`（`command=node`，`args=[I:/WinCode/dist/index.js]`，`enabled=false`）。
   - 不传 `--workspace`；禁用条目不参与连接/工具注册（源码核对 `mcp_tool_discovery.py:_enabled`、`mcp_tool_registration.py:_server_enabled`），不会自动启动。
   - 原生 stdio 连接在启动时固定工作区且 `workspace_open` 不能改根，因此不配置固定工作区的常驻连接。
3. Hermes 适配技能：`O:/hermes/skills/wincode-hermes/SKILL.md`——按需会话的 Hermes 执行方式（pty + process(submit)）、每项目 `--workspace` 定位、按项目注册原生连接的方法。非受管文件；受管技能手册不手改。

**验证（真实执行，非推测）**

- 会话 1 @ `I:\WinCode`：`SkillSessionCli --workspace I:/WinCode` → `ready` → `wincode_hello_world`：0.15.0、build verified、revision c229198、17 工具、`workspaceBinding source=argument`；`wincode_search_text` 命中 `skills/wincode/references/diagnostics.md:12`；`close` 返回 `closed:true` 且进程退出（exit 0）。
- 会话 2 @ `I:\New-tarven`：同一入口换工作区 → `wincode_list_directory` 返回该项目根 22 个条目（`app/`、`Directory.Build.props`、`global.json` 等）；`close` 同样干净退出。两会话 instanceId 不同、buildId 相同。
- `skills_list` 即时可见 `wincode`、`wincode-hermes`（无需重启）。

**边界与未决**

- 未验证：Hermes 客户端实际启用原生条目时的连接行为（当前禁用）；Roslyn/UI 能力未涉及（默认 local-text）。Hermes 的 venv 已含 `mcp` 2.0.0 SDK（启用原生连接无额外安装前提）。
- 如需为某项目启用常驻原生连接：`node I:/WinCode/dist/index.js --print-connection --workspace <项目绝对路径>`，并按不同条目名注册；改配置后需重启/刷新 Hermes。
- 结果文件保留在 `I:/WinCode/test-tmp/skill-sessions/run-*/`，按本地附件管理，不提交。

## 2026-09-27 — 同步远端 main 并把受管技能分发到本机各 AI 目录

**目标**：把 `I:\WinCode` 同步到 `origin/main`，并把仓库受管技能（`skills/wincode/` 四份文件）更新到本机已安装 wincode 技能的各 AI 目录。

**关键变更**

1. 仓库同步：`git pull --ff-only origin main`，`c229198` → `39e097d`（`#48` Roslyn 诊断/框架引用、`#49` UI 语义点击与输入），39 files changed；工作区仅剩既有的未跟踪 `docs/Hermes_worklog.md`。
2. 受管技能同步（0.15.0 → 0.16.0，四份文件：`SKILL.md`、`references/{code,ui,diagnostics}.md`）：
   - `C:\Users\40218\.agents\skills\wincode`、`C:\Users\40218\.gemini\config\skills\wincode`：全量覆盖，改后 `skill:check` 均 `matched: true`；旧内容备份于 `%TEMP%\wincode-skill-backup-20260927-091727`。
   - `O:\hermes\skills\wincode`：走受管脚本 `node scripts/sync-skill.mjs "O:/hermes/skills/wincode" --apply`，四份均变更，备份目录 `O:\hermes\skills\.wincode-backup-354031b4-…`；复核 check 退出码 0。
   - 全盘扫描 `C:\Users\40218`（排除 AppData/缓存/工具链，深度 7）只发现上述两处含 wincode 技能；`wincode-hermes` 为非受管 Hermes 适配技能，未改。
3. 验证：四处（仓库源 + 三处安装）逐文件 md5 一致；`skill_view('wincode')` 返回 0.16.0 内容。

**边界与未决**

- `dist/` 仍是 2026-09-12 构建产物（对应 0.15.0），而仓库源码已是 0.16.0：手册新描述的 UI 语义动作（`click`、`mode:"setValue"/"type"`）需重新构建后才在运行实例生效。本次未构建（未获授权）。

## 2026-09-27（续）— 重新构建到 0.16.0 并验证 UI 语义动作生效

**目标**：让手册描述的 UI 语义动作（`click` / `type` / `setValue`）在运行实例真正可用——`dist/` 与已发布原生组件需重建到 0.16.0。

**执行与结果**

1. `npm run build`：3.6 秒，dist 0.16.0，buildId `2729d75b146dca6b19…`，sourceHash `9f71d70ac6a5…`，artifactHash `c25b1ba0e2a2…`，revision `39e097daca5a…`。
2. `npm run check`（core）：18 阶段全部 exit 0，45.0 秒。报告 `test-tmp/check/2026-09-27T01-30-09-531Z-core/report.json`。
3. `npm run check:desktop`：7 阶段全部 exit 0，194.9 秒；desktop-tests 40 用例、0 失败/错误。报告 `test-tmp/check/2026-09-27T01-31-55-310Z-desktop/report.json`。

**证据（真实执行）**

- 端到端用例 "clicks, refuses ambiguous/disabled targets and writes text without echoing it" 通过（16.6 秒，真实 WPF 夹具），即语义点击与文本写入真机可用。
- 已发布 Host 实跑只读 `health` 探针：`hostIdentity` version 0.16.0、informationalVersion `0.16.0+39e097daca5a…`、configuration Release、framework .NET 10.0.11、`inspectionVersion 3`（3 才含语义操作）。绕过 Gateway 单独启动被 `OwnerProcessGuard` 拒绝（`WINCODE_OWNER_PID` 校验，预期行为，非缺陷）。
- 交付清单 `verify-delivery` matched（contentId `74b3075a5443…`）；运行时 `toolCount 19`（0.15.0 为 17），dist 新增 `wincode_ui_click`、`wincode_ui_type`；`dist/build-manifest.json` 与 `dist/delivery-manifest.json` 均为本次构建产物。

**边界**：本次未提交、未推送远端，构建产物仅在本机。
