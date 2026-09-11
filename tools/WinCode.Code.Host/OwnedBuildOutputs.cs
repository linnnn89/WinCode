using System.Text.Json;

// One Host owns one namespace. The Gateway retains the same manifest for forced-exit cleanup.
internal sealed class OwnedBuildOutputs : IDisposable
{
    internal static readonly string Instance = Environment.GetEnvironmentVariable("WINCODE_BUILD_INSTANCE") ?? Guid.NewGuid().ToString("N");
    internal static OwnedBuildOutputs? Current;
    private readonly string root, identity, storage;
    private readonly FileStream lease;
    private readonly HashSet<string> paths = new(StringComparer.OrdinalIgnoreCase);
    private OwnedBuildOutputs(string root, string identity)
    {
        if (!Guid.TryParseExact(identity, "N", out _)) throw new ArgumentException("Invalid build output identity.");
        this.root = root; this.identity = identity;
        storage = WorkspaceInputs.Inside(root, Path.Combine(root, ".cache/wincode-build", identity));
        Directory.CreateDirectory(storage);
        lease = new FileStream(Path.Combine(storage, "active.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
    }
    internal static void Record(string root, string identity, IEnumerable<string> directories)
    {
        Current ??= new(root, identity);
        if (Current.root != root || Current.identity != identity) throw new InvalidOperationException("Build output owner changed.");
        foreach (var directory in directories)
        {
            Current.Validate(directory);
            Current.paths.Add(directory);
            if (Current.paths.Count > 128) throw new HostFailure("INPUT_BUDGET_EXCEEDED", "Too many private output roots.");
        }
        var temporary = Path.Combine(Current.storage, "owner.json.tmp");
        File.WriteAllText(temporary, JsonSerializer.Serialize(new { version = 1, instance = identity,
            paths = Current.paths.Select(path => Path.GetRelativePath(root, path)).ToArray() }));
        File.Move(temporary, Path.Combine(Current.storage, "owner.json"), true);
    }
    private void Validate(string directory)
    {
        WorkspaceInputs.Inside(root, directory);
        var suffix = Path.Combine(".cache", "wincode-msbuild", identity);
        if (!directory.EndsWith(Path.DirectorySeparatorChar + suffix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Output directory is not owned by this Host.");
    }
    private void Remove(string directory)
    {
        if (!Directory.Exists(directory)) return;
        var pending = new Stack<string>(); pending.Push(directory); var count = 0;
        while (pending.TryPop(out var current))
        {
            WorkspaceInputs.Inside(root, current);
            foreach (var entry in Directory.EnumerateFileSystemEntries(current))
            {
                if (++count > 16384) throw new IOException("Private cleanup entry budget exceeded.");
                WorkspaceInputs.Inside(root, entry);
                if (Directory.Exists(entry)) pending.Push(entry);
            }
        }
        Directory.Delete(directory, true);
    }
    public void Dispose()
    {
        try
        {
            foreach (var directory in paths) { Validate(directory); Remove(directory); }
        }
        finally { lease.Dispose(); }
        Remove(storage);
        Current = null;
    }
}
