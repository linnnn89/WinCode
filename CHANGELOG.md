# Changelog

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
