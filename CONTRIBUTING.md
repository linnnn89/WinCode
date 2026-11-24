# Contributing

## Prerequisites & Baseline

WinCode targets Windows x64 (Windows 11 x64 baseline). Node.js **24** is the primary runtime; Node.js **22** is the supported compatibility line (Node.js 20 is unsupported).

Install prerequisites separately before running repository scripts—no check installs global tools or modifies your MCP client settings:
- Git `>=2.36`
- Node.js `>=22`
- Exact .NET SDK **10.0.303** pinned in `global.json` (`rollForward: "disable"` follows [Microsoft global.json guidance](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json) so [NuGet locked restore](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#locking-dependencies) uses a deterministic graph)
- Matching .NET 10 Windows Desktop runtime (required by the framework-dependent Release helpers and optional Tray)

## Core Build & Verification Workflow

```powershell
npm ci
npm run check
npm run check:desktop
npm run delivery:verify
```

- **`npm run check`**: Verifies test suite registration (`*.test.ts`), runs TypeScript type-checking, builds the Gateway, restores native NuGet packages in locked mode, publishes Release helpers (`WinCode.UIA.Host`, `WinCode.Code.Host`, `WinCode.Tray`) and console fixtures, executes core regression and fresh-process stdio integration tests (including the published Tray pipe endpoint check with its 3-second production timeout), and generates/verifies `dist/delivery-manifest.json`.
- **`npm run check:desktop`**: Requires an interactive Windows desktop session. Verifies the delivery manifest, publishes the isolated WPF fixture, and runs UI inspection/action, UI-to-source correlation, `--desktop` owner-death cleanup, and WinForms Tray tests (`test:tray`, `test:tray-workflow`). Set `WINCODE_TEST_ISOLATED_KEYBOARD=1` only inside an independently isolated desktop session to include live keystroke tests.
- **`npm run test:all`**: Runs `check` followed by `check:desktop`.
- **Stage reports & logs**: Written to `test-tmp/check/<run>/` (8 MiB capture cap; missing TAP summaries or truncated captures fail the stage even on exit code 0). CI retains bounded stage logs and JUnit XML for 7 days and never uploads local workspaces or screenshots.

## Delivery Manifest & Runtime Modes

`dist/delivery-manifest.json` seals the Gateway JS output, all published native Host files (including dependency sidecars), the four managed Skill files under `skills/wincode/`, package/SDK locks, and the Git/toolchain identity:

- Native Release artifacts must be published via `scripts/publish-native.mjs host|codeHost|tray` (invoked automatically by `npm run check`), which verifies repository inputs stayed unchanged during compilation. Regenerating a manifest cannot bless stale DLLs; hashes detect local mismatches and are not cryptographic signatures.
- Production (`npm start`) loads only the published Release helpers. `npm run dev` explicitly enables Debug/`dotnet run` fallback. Rebuilding disk artifacts does not reload an already running MCP client connection.
- When rolling back, restore a complete matching checkout/artifact set rather than mixing old DLLs with a newer Gateway.

## Specialized Test & Benchmark Suites

Run targeted verification scripts when touching specific subsystems:

| Command / Suite | Coverage & Scope Boundaries |
| --- | --- |
| `npm run test:error-contracts` | Protocol errors, matching text/`structuredContent` error payloads, trash move failures, `WORKSPACE_MISMATCH`, and same-root workspace recovery (runs in Node 22 CI). |
| `npm run test:roslyn-host` / `test:roslyn-gateway` | Real Roslyn overloads, stale snapshot rejection, and owned MSBuild descendant cleanup using generated C# projects (gateway check runs from a path containing Chinese characters and spaces). |
| `node scripts/verify-design-time-concurrency.mjs --phase semantics --filter semantics/mixed` | Verifies multi-target Windows entry projects referencing plain .NET class libraries without polluting library target frameworks. |
| `npm run test:manual-release` | 10 Roslyn release/reload cycles, stale locator rejection, retained cache/watcher state, and isolated fixed A/B instances (`test-tmp/manual-release/`). |
| `npm run test:owner-death` | Kills a spawned Gateway mid-MSBuild (or `--repomix` / `--desktop`) and verifies all owned helper descendants exit while inspected target apps stay alive (`test-tmp/owner-death/`). |
| `tests/request-admission.test.ts` & `tests/runtime-cache-regressions.test.ts` | Burst admission (up to 128 calls), 64 KiB UTF-8 payload limits, cancellation/deadline propagation, content-hash cache freshness across same-size writes, and creation-time-checked PID reuse safety. |
| `tests/skill-session.test.ts` | Persistent `SkillSessionCli` lifecycle: deferred Gateway startup, attachment receipts, Roslyn snapshot reuse, and owner-death cleanup (`tty: true` terminal behavior still requires client verification). |
| `node scripts/measure-runtime-baseline.mjs` | Profiles unused/cold/warm/exit phases across 3 fresh stdio clients under `test-tmp/runtime-baseline/` (shares OS/SDK caches; not a clean-machine P95 benchmark). |
| `npm run test:tavern-context` / `test:product` | Opt-in fixed-profile acceptance against an external repository and live window (`<PID> <HWND>`), verifying source hashes without personal databases. |

When investigating nontrivial test failures, check official Microsoft/.NET/MCP documentation and upstream issues first, record observed evidence, and avoid masking races with arbitrary sleeps.

## Architecture, Versioning & Documentation Hygiene

- **Layer boundaries**: Register schemas and validation in `ToolRegistry`; dispatch through `ToolRouter` (fixed per-workspace instance coordinated by `DynamicWorkspaces` in dynamic mode); keep `Core` and `CompositeTools` coupled to narrow capability contracts rather than concrete adapters (`tests/architecture-boundaries.test.ts` enforces this). Unknown request fields are stripped before execution; declared fields are strictly validated without type coercion.
- **Version bumps**: Keep `package.json`, root entries in `package-lock.json`, `src/Core/Config.ts`, `.csproj` `<Version>` tags under `tools/`, `README.md`, Complementary docs, and `skills/wincode/SKILL.md` aligned. Re-run `npm run check` whenever managed Skill files or delivery inputs change.
- **Formatting & dependencies**: Respect `.editorconfig` and `.gitattributes` on touched files without reformatting unrelated files. Dependency updates require an explicit maintenance scope with locked npm/NuGet restore validation.
- **Documentation organization**: Describe current behavior in [WinCode-架构与数据流说明.md](WinCode-架构与数据流说明.md) and [docs/hybrid-readonly-orchestration.md](docs/hybrid-readonly-orchestration.md), user-visible changes in [CHANGELOG.md](CHANGELOG.md), and unfinished work exclusively in [docs/next-iteration.md](docs/next-iteration.md) (remove completed items rather than appending chronological work logs).

## Branch Protection & Pull Requests

`main` branch protection requires pull requests, passing Node 22/24 CI and three CodeQL checks (JavaScript/TypeScript, C#, GitHub Actions) on the exact PR head, resolved review threads, administrator enforcement, and disabled force-pushes/deletions. Under the single-maintainer policy, required GitHub approvals are set to `0`—keep author self-review distinct from independent review, and clearly note any unverified client or desktop integrations in the PR description.
