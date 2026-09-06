# Changelog

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
