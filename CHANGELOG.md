# Changelog

## 0.12.5

- Handle the real Serena 1.7/FastMCP structuredContent.result string envelope before parsing symbols or references. Preserve error, empty-result, malformed and shortened-response semantics; do not discard unknown envelope metadata or silently prefer text over unsupported structured data.
- Add an opt-in real Serena acceptance command using an explicitly supplied installed command. It exercises overloaded C# identities, ambiguity, reference locations, direct upstream body evidence, legitimate empty results, process interruption with unavailable restart, inactive projects and owned-process cleanup. It neither installs dependencies nor reconnects the parent Codex client.

- Acceptance recorded on 2026-09-08: merged main `10496e0` passed 313 core tests with one optional skip; the pinned Serena 1.7.0/Roslyn isolated acceptance passed seven stages. These checks do not verify a pre-existing client connection or other upstream versions.

## 0.12.4

- Repomix health and packing launch an installed JavaScript bin directly with the current Node executable and separate arguments, eliminating the cmd/npx shell chain. Local package bin discovery and explicit absolute customCliPath are supported; shell wrappers and npx caches are no longer invoked. Missing or invalid entries use the builtin packer without installing anything.
- Real child-process regression fixtures cover Unicode, spaces and shell metacharacters in paths/arguments, missing or invalid overrides, local package discovery, timeout and cancellation with PID exit checks. These validate the launcher contract, not an installed upstream Repomix release.
- main protection now requires pull requests, the Node 22/24 regression matrix and all three CodeQL analysis checks, including administrators; force pushes and branch deletion are disabled. Independent approval is not required by GitHub for this single-maintainer workflow.

## 0.12.3

- Add an opt-in six-task TavernDesk acceptance entry point. Discover candidate files with bounded native searches, locate unique live navigation controls, and verify command assignments and method declaration snippets against current source hashes.
- Count native and MCP calls, UTF-16 response characters, elapsed call time and repeated displayed lines. Keep failures and cleanup errors in local reports; this is neither a native-only comparison nor proof of whole-method or runtime binding correctness.
- Validate real isolated WPF repair, fixed-profile TavernDesk UI/source evidence and explicit line coverage. Real Serena remains unverified because no usable local command was found; no upstream or language-server installation was performed.
- An existing Codex connection was confirmed to retain Gateway 0.11.2 while a freshly launched Host reported 0.12.3. A new stdio probe does not establish that the user's existing connection has reloaded.

## 0.12.2

- Support Node 24 as primary and 22 as compatibility runtime; require Node >=22. Pin .NET SDK 10.0.303 and lock native Host/fixture restores without changing declared dependencies.
- Add one core check entry point and separate desktop check, with test inventory coverage, bounded reports and pinned CI report upload.
- Link Gateway JavaScript, the complete published Host directory, managed Skill and build configuration in a delivery manifest. Detect changed/missing files and mismatched Release Host versions; hashes establish local consistency, not authenticity.
- Read actual native assembly identity; production resolves the published Release Host, with Debug fallback available only in explicit development mode.
- Add contributor and formatting conventions, update support/security guidance, and preserve existing extension compatibility without expanding its architecture.
- Branch protection and the existing Repomix CodeQL alert require their separate pending decisions; this version does not claim either resolved.

## 0.12.1

- Make hello passive: report instance identity, capabilities and known adapter observations without spawning probes. Unknown state is explicit; diagnose_project retains active checks.
- Carry client cancellation and a bounded internal deadline through code queries, context packing and upstream RPC. Stop follow-on work and retain request ownership through cleanup; a cancelled pack does not cancel another caller's pack.
- Preserve shutdown failures and bounded per-owner cleanup outcomes, finish other owners and late registrations, clean failed initialization, and verify owned process exit after termination.
- Retain resource-close failures across repeated calls while starting a new close lifetime for a newly connected Serena process. Add real mock-upstream cancellation/reconnect and controlled process-exit regressions.
- Limitations: OS I/O cancellation is cooperative; resetting shared Serena transport can affect other upstream calls. Workspace switch cancellation has a commit boundary. Real Serena semantics remain a separate integration check; Repomix CodeQL alert #1 is not resolved here.

## 0.12.0

- Register each tool's schema, aliases, validation and execution together; `tools/list`, runtime schema hashes and input validation use the same instance snapshot.
- Keep unknown-field compatibility: ignore undeclared fields, including nested fields, while validating declared types and required/range constraints before request admission. Do not convert objects into search strings or numeric strings into PIDs or numeric UI limits.
- Route Gateway calls through explicit ToolRouter use cases. Context and composite tools depend on small query/packing contracts; existing Adapter type exports remain compatible.
- Document canonical request fields, types, aliases and examples in the existing Skill manuals. Tolerating a field does not mean the connected version supports it.

## 0.11.3

- Bound local Serena fallback across directories, bytes, matches and time; scoped symbol queries read only their requested file, and partial scans report their stop reason instead of claiming completeness.
- Parse valid upstream JSON before recognizing legacy error text, preserving source containing inactive-project messages.
- Enforce disabled Repomix CLI configuration before health probes, cached/in-flight requests and packing.
- Await workspace watcher close events, isolate late events from replaced watchers, and retain cleanup failures while waiting for all owners. Add ten sequential and ten concurrent lifecycle checks to the supported CI matrix.

## 0.11.2

- Keep awaited deadlines active until completion or timeout, then release their timers; an otherwise idle process no longer exits before reporting a timeout.
- Canonicalize the native directory-watch path to avoid Windows short-path alias assertions, while preserving the requested workspace identity and existing failure reporting.
- Add Windows PR/main regression checks for Node.js 20/24, .NET 10 native/console builds and the production stdio contract; interactive UI acceptance remains separate.
- Refine retrieval guidance after a small paired TavernDesk source audit: use bounded native file reads for known methods requiring error/cancellation branches, retaining scoped symbols for declaration previews. No gateway API or dependency change.

## 0.11.1

- Clarify displayed-snippet versus packed-file completeness. Symbol windows explicitly retain unknown method coverage and offer bounded following-line requests based on the final serialized tail and observed EOF.
- Add a bounded raw-pixel quality hint before annotation. Low variation may indicate a blank or legitimate uniform image; preserve screenshots and UIA evidence without activating windows or changing capture policy.
- Add explicit installed-skill checks and backup-first synchronization for four managed documents; preserve extra files and reject linked destinations. Refresh bilingual guidance and current roadmap status.

## 0.11.0

- Extend UI review with optional explicit C# candidate files: follow literal Click/simple Binding names to declarations or assignments and offer scoped context requests.
- Bound file reads, candidate counts and output; validate paths before inspection. Optional code metadata cannot displace UI nodes/image badges or existing XAML evidence.
- Preserve ambiguity, incomplete scans and unsupported bindings. Runtime/source build identity, DataContext, templates and CanExecute causality remain unverified; no new UI actions or full-repository scans.

## 0.10.0

- Migrate server/client, stdio, in-memory tests and scripts to MCP SDK v2.0.0; minimum Node.js is now 20 (runtime verification on Node 24.19.0).
- Replace schema-based handler registration and v1 callTool options with v2 APIs; retain existing tool definitions and legacy protocol negotiation behavior.
- Remove unused direct Zod/v1 SDK dependencies; use the v2 packages' Zod dependency. No new protocol revision or public tool redesign is enabled.

## 0.9.4

- Preserve Serena full name paths and overload identity; reject ambiguous or incomplete automatic reference targets. Limit returned ambiguity candidates while retaining the count.
- Distinguish valid empty results from shortened, malformed or unsupported payloads; use supported symbol search parameters and do not substitute file overview for global search.
- Convert upstream zero-based locations to one-based coordinates and label containing-symbol reference locations. Impact analysis forwards exact identity only after complete unique resolution.

## 0.9.3

- Explicit line-range requests use the available response budget instead of a fixed 4000-character source cap. Final serialization recomputes complete-line coverage, partial tail lines and omission reasons.
- Recoverable gaps offer bounded stateless continuation; missing/EOF inputs and maximum-budget retries cannot silently loop. Non-range excerpts do not claim method/task coverage.
- Add opt-in TavernDesk source acceptance with actual body/range assertions, separate from host-connection and GUI validation.

## 0.9.2

- Build manifests fingerprint source inputs and compiled outputs; runtime identity is frozen at startup and reports unknown for missing, stale or development builds.
- Hello derives capabilities and schema fingerprints from its registered tools snapshot; an optional toolName returns one actual input schema. Unknown hello/context parameters fail explicitly.
- Replace the manual JSON-RPC smoke script with an isolated SDK stdio probe asserting schema agreement and actual symbol/range bodies. No upstream/GUI or separate host-connection claim.

## 0.9.1

- Default workspace opening to a compact project summary with at most eight entry paths and an 8,000-character whole-response budget. Skip recursive file-size inventory; retain bounded project-discovery gaps and report unmeasured totals as null.
- Add on-demand `wincode_list_directory` with path, depth, examined-entry and output limits, explicit generated-directory access and real-path boundary checks. The opt-in `includeTree` compatibility response remains bounded.
- Preserve workspace switching, rollback and cache isolation. Add isolated MCP regressions for wide publish folders, useful source recovery, truncation, invalid options and outside junctions.

## Unreleased — agent efficiency, round 1

- Add an isolated ten-scenario agent-efficiency benchmark (`benchmark:agent`) comparing candidate-first and precise-first retrieval, with call counts, unchanged displayed-line overlap, output characters, latency and explicit evidence oracles. Document precise routing and when to stop or refresh evidence; no cross-request cache is introduced.
- Harden benchmark schema v2: validate current file/range/body/status, retain transport/tool/response/cleanup failures in reports, and exercise ten scenarios including existing C# fixtures and trusted no-change reuse versus mandatory refresh after edits. Add fault regressions to the default test suite and synchronize bilingual README usage and measurement limits. Prior six-scenario totals are not directly comparable.

- Follow-up review fixes: trim auxiliary metadata before useful source, preserve declarations at exact newline clipping boundaries, support focus paths through workspace junctions, and distinguish selected/packed/returned files using packer body spans (missing spans remain unknown).
- Add opt-in exclusive `scopeFiles`, exact local declaration `symbol`, and bounded `lineRanges` to `wincode_prepare_context`. Known locations skip workspace symbol queries; ambiguous or missing symbols remain explicit gaps. Existing `candidateFiles` priority semantics are unchanged; scoped symbol matching is explicitly non-semantic.

- Default `wincode_prepare_context` to one compact JSON text block; `responseFormat: "legacy"` retains JSON plus Markdown. All returned text, including metadata and JSON escaping, shares the character-based `maxTokens` estimate. Metrics explicitly identify characters/4 rather than a model tokenizer.
- Preserve truncation, incomplete searches, omitted-file counts and metadata loss under small budgets. Full-text compact responses return the packed body once; empty packs are insufficient evidence.
- Align literal `focusAreas` paths with actual support: reject globs up front, bound immediate-directory selection, and report missing/unreadable/oversized/out-of-workspace files instead of silently returning empty evidence.
- Keep matched symbols, retrieval reasons and displayed line ranges consistent, including long prefixes and clipped excerpts. Refactoring plans retain impact uncertainty and follow the requested goal instead of always prescribing a new interface.
- Add isolated MCP regression coverage for compact/legacy compatibility, total output accounting, Unicode/escaping, target preservation, file boundaries and evidence-based plans. Update the repository skill's on-demand code manual.

## 0.9.0

- Added bounded exact UI queries, local subtree selection and opt-in toggle/selection/expand-collapse state.
- Exposed traversal/property gaps, helper peak RSS and old-helper feature mismatch; retained cancellation and audit boundaries.
- Split noninteractive/default regression from explicit GUI acceptance; updated bilingual README and on-demand skill manuals.

## 0.8.0 (unreleased, stage 1)

- Add mandatory metadata-only UI audit, 1 MiB warning/2 MiB admission limit, bounded reminder cooldown and explicit desktop reminder/checker.

- Add opt-in backgroundOnly inspection/review requiring PID+HWND, disabling screen capture fallback and reporting normal capture failure without discarding the tree.
- Add no-activate background fixture and opt-in live foreground sampling acceptance script.

- Add bounded read-only top-level window discovery with explicit filters, PID/HWND candidates and completeness metadata.
- Reuse helper cancellation, timeout and serialized lifecycle; preserve Unicode window titles.
- Add duplicate-window WPF fixture and stdio MCP acceptance coverage. Local subtree queries and pattern state inspection remain deferred.

## 0.7.2 (unreleased)

- Add optional bounded textQueries to UI review; preserve independent ID candidates and runtime evidence.
- Report literal attributes, unresolved resource references and bindings with source lines/hashes.
- Test contradictory identity/text evidence, duplicate hits, comments, clipping, validation and MCP output budgets.

## 0.7.1 (unreleased)

- UI source evidence now explains missing/clipped IDs, unsupported values, incomplete file scans, ambiguous candidates and literal misses. Coverage distinguishes evaluated nodes from nodes retained in the final response budget.
- Runtime health exposes passive FlaUI process/error state and workspace watcher failure history. Cached successful health does not erase recent inspection errors; diagnostics never capture a target window.
- Add an opt-in `scripts/verify-ui-runtime.ts` acceptance runner for explicit PIDs, bounded mixed calls, cancellation, workspace switches and resource measurements. It never launches the target or configures model providers.
- Actual isolated TavernDesk main-window validation: 20 review iterations, 4 cancellations and 3 round-trip workspace switches; no retained helpers at sample points. UI-to-source coverage remains limited by absent/literal-unmatched AutomationIds.

## 0.7.0 (unreleased)

- Add `wincode_ui_review`: one UI snapshot plus literal AutomationId source candidates in explicit WPF XAML files. Candidates include real start-tag lines, bounded snippets, SHA-256 and attribute declarations; they do not assert runtime/source identity.
- Reuse inspect cancellation, request slots and image separation. Source lookup failures preserve the UI snapshot; source evidence uses the remaining 128 KiB text budget.
- Bound source reads to 16 files, 256 KiB per file, 1 MiB total, with cancellation/deadline checkpoints. Resolve paths before reading and reject outside-workspace junctions.
- Add source-boundary tests and a real WPF-to-XAML MCP flow. No new dependencies or target-application instrumentation.

## 0.5.1

Patch for the long-running risks called out in 0.5.0. Tool honesty is unchanged.

- **Process trees**: On Windows, `taskkill /T` runs *before* signaling the wrapper process, so `cmd.exe`/`npx` grandchildren are not orphaned (Codex #34614, MCP typescript-sdk #2023). Serena prefers a resolved `.exe` and only uses `cmd /c` for `.cmd` launchers. `customArgs` allows a Node mock server.
- **Fingerprint freshness**: Cheap probe of `.git/HEAD`, `.git/index`, and `package.json`, plus a debounced recursive `fs.watch`, drop the 2.5s memo when the working tree actually changes.
- **Same-path `workspace_open`**: If the fingerprint changed, symbol cache is cleared and Serena `projectActive` is marked stale even when the path is unchanged.
- **Oversized packs**: Snapshots larger than `maxEntryBytes` are written to `cache/overflow/` and the in-memory result keeps a preview only.
- **Tests**: `tests/fixtures/mock-serena-mcp.mjs` covers a real stdio handshake (`source=serena-mcp`) without installing Serena.

## 0.5.0

Stability for a long-running Windows MCP gateway. Product tools and honesty rules from v0.4 are unchanged.

- **Lifecycle**: `ResourceManager` owns child processes, timers, and adapter close hooks. `stop()` / `dispose()` are idempotent. SIGINT/SIGTERM drain in-flight tool calls, then close Serena/Repomix process trees (Windows `taskkill /T`).
- **Serena**: Connect is lazy and single-flight. Crash or RPC timeout resets the old transport so the next call can reconnect. Switching workspace drops the previous MCP session. Layered `commandFound` / `handshakeOk` / `projectActive` / `semanticQueryUsable` is unchanged.
- **Session**: `SessionManager` tracks the active workspace, cache namespace, fingerprint, `createdAt`, and `lastActivity`. `workspace_open` is serialized.
- **Cache**: Byte caps (`maxMemoryBytes`, `maxDiskBytes`, `maxEntryBytes`) in addition to LRU entry counts. Oversized snapshots are not kept in the heap. Keys are namespaced per workspace.
- **Fingerprint**: ~2.5s memo + single-flight so consecutive `prepare_context` / `find_symbol` / `find_references` / `analyze_change_impact` calls do not repeat `git status`.
- **Timeouts**: git, `dotnet --version`, Serena connect/RPC, Repomix CLI, and local file scans. Failures are structured (`reason: timeout`, `recoverable: true`) and must not crash the process.
- **Health**: `wincode_hello_world` includes a runtime snapshot (uptime, cache bytes, managed child processes, Node memory, last adapter error). `wincode_diagnose_project` adds a `runtime` block.

Not in this release: FlaUI, Snoop, PerfView, extra Roslyn, or tool-name removals.

## 0.4.0

Honest query chain for .NET workspaces: layered Serena status, sln/csproj graph, evidence-bounded context, impact `UNKNOWN` when incomplete.
