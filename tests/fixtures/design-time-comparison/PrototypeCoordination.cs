using System.Diagnostics;
using System.Text.Json;

// Experimental only: copied into an isolated Host by verify-design-time-concurrency.mjs.
internal sealed class PrototypeCoordination : IDisposable
{
    private readonly FileStream? handle;
    internal static readonly string Mode = Environment.GetEnvironmentVariable("WINCODE_N4_MODE") ?? "baseline";
    internal static readonly string Instance = Environment.GetEnvironmentVariable("WINCODE_N4_INSTANCE") ?? Guid.NewGuid().ToString("N");
    internal static double LastWaitMs;
    internal static string? LastIntermediate;
    private PrototypeCoordination(FileStream? handle) { this.handle = handle; }
    private static void Trace(string stage) => Console.Error.WriteLine("N4TRACE " + JsonSerializer.Serialize(new {
        stage, mode = Mode, instance = Instance, pid = Environment.ProcessId, at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
    }));

    internal static async Task<PrototypeCoordination> EnterAsync(string root, CancellationToken token)
    {
        if (Mode is not ("baseline" or "private" or "private2" or "lock")) throw new InvalidOperationException("Unknown prototype mode.");
        if (Mode != "lock") return new(null);
        var directory = WorkspaceInputs.Inside(root, ".cache/wincode-comparison");
        Directory.CreateDirectory(directory);
        var file = WorkspaceInputs.Inside(root, Path.Combine(directory, "load.lock"));
        var clock = Stopwatch.StartNew();
        var reportedWait = false;
        while (true)
        {
            token.ThrowIfCancellationRequested();
            try
            {
                var stream = new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                LastWaitMs = clock.Elapsed.TotalMilliseconds;
                Trace("gate-acquired");
                return new(stream);
            }
            catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33)
            {
                if (!reportedWait) { Trace("gate-waiting"); reportedWait = true; }
                // Only sharing/lock contention is a wait; access and path failures remain errors.
                await Task.Delay(25, token);
            }
        }
    }

    internal static Dictionary<string, string> Properties(string configuration, string framework)
    {
        Trace("msbuild-start");
        var properties = new Dictionary<string, string> {
            ["Configuration"] = configuration, ["TargetFramework"] = framework,
            ["RunAnalyzers"] = "false", ["RunAnalyzersDuringBuild"] = "false"
        };
        if (Mode is "private" or "private2")
        {
            if (!Guid.TryParseExact(Instance, "N", out _)) throw new InvalidOperationException("Invalid prototype identity.");
            if (configuration.IndexOfAny(['/', '\\', ':']) >= 0 || framework.IndexOfAny(['/', '\\', ':']) >= 0)
                throw new InvalidOperationException("Prototype configuration must be a path segment.");
            // Relative to each evaluated project, including its ProjectReferences.
            LastIntermediate = $".cache/wincode-msbuild/{Instance}/{configuration}/{framework}/";
            properties["IntermediateOutputPath"] = LastIntermediate;
            if (Mode == "private2") properties["CustomBeforeMicrosoftCommonTargets"] = BuildLayout.Current!.Hook;
        }
        return properties;
    }

    public void Dispose() { handle?.Dispose(); if (Mode == "lock") Trace("gate-released"); }
}
