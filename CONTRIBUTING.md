# Contributing

WinCode targets Windows x64. Node 24 is the primary runtime; Node 22 is the compatibility line, and Node 20 is no longer supported. Install prerequisites separately: Git, Node, and the exact .NET SDK in `global.json` (10.0.303). SDK roll-forward is disabled so locked NuGet restore cannot silently use another SDK's dependency graph. The published Host is framework-dependent and needs the matching .NET Windows Desktop runtime.

```powershell
npm ci
npm run check
npm run check:desktop
npm run delivery:verify
```

`check` inventories every `*.test.ts`, type-checks, builds the Gateway, restores native dependencies in locked mode, builds the Release Host and console fixtures, runs non-interactive regression and fresh-process stdio checks, then creates and verifies `dist/delivery-manifest.json`. `check:desktop` verifies that delivery, publishes the isolated WPF fixture and runs UI plus UI-to-source tests in an interactive Windows session. `test:all` runs both. Real Roslyn Host and MCP checks run on Node 22 in CI; TavernDesk checks remain opt-in. No check installs global prerequisites or changes client configuration.

Reports and bounded stage logs are under `test-tmp/check/<run>/`. CI uploads only the compact report, including failures; it does not upload local workspaces or screenshots. A passing core check does not establish desktop or real-upstream acceptance.

`npm run test:roslyn-host` and `npm run test:roslyn-gateway` use generated C# projects and an already installed SDK selected by `scripts/lib/dotnet.mjs`. The gateway check copies the entire published Code Host into a Chinese path with spaces and checks real overloads, stale identities and owned MSBuild descendants. This is not a clean-machine test or verification of the current Codex connection.

For opt-in fixed-profile TavernDesk acceptance, use `npm run test:tavern-context -- <repository> --ui-pid=<PID> --ui-hwnd=<HWND>` and `npm run test:product -- <repository> <PID> <HWND>`. The latter checks the fixed profile receipt and performs six navigation-to-source tasks without source filenames supplied in advance. Native candidate discovery is counted, source reads used only as the oracle are separate, and all returned bodies are checked against current file hashes. Source candidates remain distinct from verified runtime bindings. The scripts do not install prerequisites, launch the target application or use personal databases.

The delivery manifest covers Gateway JavaScript, all published Host files including dependency sidecars, four managed Skill documents, and package/SDK/Host lock configuration. It records the Git revision and toolchains. Timestamps and checkout paths do not participate in content identity. Hashes detect local mismatches; they are not signatures. Run a complete check after changing delivery inputs. Keep a complete previous checkout/artifact set for rollback; do not mix old DLLs with a new Gateway.

Production startup uses `npm start` and the published Release Host. `npm run dev` explicitly enables Debug/dotnet-run fallback. `customHostPath` remains an explicit configuration override; an old helper must not be mistaken for a verified current release. Rebuilds do not replace a running client's MCP connection.

Keep changes bounded to the problem. Tool registration, schema and validation belong in `ToolRegistry`; Gateway dispatches through `ToolRouter`; Core/composite logic uses narrow capability contracts rather than concrete adapters. Unknown request fields are ignored for compatibility, while declared fields are validated. Update the canonical [Skill fields](skills/wincode/SKILL.md) when contracts change. Unused extension/plugin entry points remain compatibility surfaces, not a supported plugin architecture to expand.

For a version change, align `package.json`, the root entries in `package-lock.json`, `src/Core/Config.ts`, the Host project version, README and Skill. Do not edit dependency metadata to change the product's Node requirement. Dependency changes need an explicit maintenance scope; update npm/NuGet locks there and validate locked restores. `.gitattributes` and `.editorconfig` define formatting for touched files; do not reformat the repository in a functional PR.

Before merging a topic branch, record the problem, changes, failures and actual verification in the existing work log. Require successful Node 22/24 and CodeQL results for the exact PR head. Keep independent review and author self-review distinct, and identify unverified integrations. Changes to repository protection require an owner decision; the verified policy is recorded below. A successful CodeQL run also does not prove existing alerts are closed.

On 2026-09-08, the owner authorized applying main protection. The read-back confirmed required pull requests, strict Node 22/24 regression and three CodeQL analysis checks bound to GitHub Actions, enforcement for administrators, resolved conversations, and disabled force pushes/deletions. The single-maintainer policy requires zero GitHub approvals; this does not constitute an independent review. Re-read GitHub settings when verifying current enforcement.

SDK policy follows [Microsoft global.json guidance](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json); dependency locking uses [NuGet locked restore](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#locking-dependencies).

Current implementation is described in the [architecture guide](WinCode-架构与数据流说明.md). Remaining work is maintained in the [active engineering plan](WinCode-下一轮工程化迭代计划书.md); completed work belongs in CHANGELOG and the append-only work log. For documentation-only changes, verify local links, commands, version claims and evidence boundaries; do not claim a new runtime regression without running it.
