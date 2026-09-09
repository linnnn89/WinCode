using System.Security.Cryptography;
using System.Text;

/// <summary>携带稳定错误码的内部协议失败；恢复动作由调用方处理，不自动重放请求。</summary>
internal sealed class HostFailure(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// 有界输入清单：跟踪工作区文件（包含 obj）、已加载文档/元数据，以及祖先常规配置。
/// 排除目录只影响默认枚举，显式加载的文件仍加入校验。不能发现任意自定义 target 的隐式外部输入。
/// </summary>
internal sealed record WorkspaceInputs(string Fingerprint, IReadOnlyDictionary<string, byte[]> Files, long Bytes)
{
    public int FileCount { get; init; } = Files.Count;
    private static readonly HashSet<string> IgnoredDirectories = new(StringComparer.OrdinalIgnoreCase)
        { ".git", "node_modules", ".deps", "bin", "dist", "build", ".cache", ".vs", ".packages", "test-tmp", "trash" };
    private static readonly string[] AncestorNames = ["global.json", "Directory.Build.props", "Directory.Build.targets", "Directory.Packages.props", "NuGet.Config"];
    internal const int MaxEntries = 20000;
    internal const int MaxFiles = 5000;
    internal const long MaxBytes = 128L * 1024 * 1024;

    /// <summary>规范化并验证请求源码路径；根外路径或链接路径立即失败。</summary>
    public static string Inside(string root, string requested)
    {
        var full = Path.GetFullPath(requested, root);
        var relative = Path.GetRelativePath(root, full);
        if (relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar) || Path.IsPathRooted(relative))
            throw new HostFailure("OUTSIDE_WORKSPACE", "Path outside workspace.");
        RejectLinks(full);
        return full;
    }

    /// <summary>拒绝现存祖先路径中的重解析点；普通路径不存在由读取阶段按失败处理。</summary>
    private static void RejectLinks(string full)
    {
        for (string? current = full; current != null; current = Path.GetDirectoryName(current))
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new HostFailure("UNSUPPORTED_LINK", "Reparse paths are not supported.");
    }

    /// <summary>仅用于过滤监听噪声；obj 不排除，未知路径事件应由调用方标记失效。</summary>
    public static bool IsIgnored(string root, string full) =>
        Path.GetRelativePath(root, full).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .Any(IgnoredDirectories.Contains);

    /// <summary>
    /// 读取输入内容并计算 SHA-256。超出条目、文件或字节预算直接失败，不生成截断的有效快照。
    /// extraFiles 来自实际加载的文档和 PortableExecutableReference，可包含授权的 SDK/包元数据。
    /// </summary>
    public static async Task<WorkspaceInputs> CaptureAsync(string root, IEnumerable<string> extraFiles, CancellationToken token)
    {
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<string>();
        pending.Push(root);
        var entries = 0;
        while (pending.TryPop(out var directory))
        {
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                token.ThrowIfCancellationRequested();
                if (++entries > MaxEntries) throw new HostFailure("INPUT_BUDGET_EXCEEDED", "Too many workspace entries.");
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.Directory) != 0 && IgnoredDirectories.Contains(Path.GetFileName(entry))) continue;
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new HostFailure("UNSUPPORTED_LINK", "Linked workspace input.");
                if ((attributes & FileAttributes.Directory) != 0) pending.Push(entry);
                else paths.Add(entry);
            }
        }
        foreach (var extra in extraFiles) paths.Add(Path.GetFullPath(extra));
        for (var parent = Directory.GetParent(root); parent != null; parent = parent.Parent)
            foreach (var name in AncestorNames)
            {
                var file = Path.Combine(parent.FullName, name);
                if (File.Exists(file)) paths.Add(file);
            }
        if (paths.Count > MaxFiles) throw new HostFailure("INPUT_BUDGET_EXCEEDED", "Too many input files.");
        var files = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        long bytes = 0;
        using var aggregate = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in paths.Order(StringComparer.OrdinalIgnoreCase))
        {
            token.ThrowIfCancellationRequested();
            RejectLinks(file);
            var length = new FileInfo(file).Length;
            if (length > 32L * 1024 * 1024 || length > MaxBytes - bytes)
                throw new HostFailure("INPUT_BUDGET_EXCEEDED", "Input byte budget exceeded.");
            // 读前长度不阻止文件随后增长，因此流读取也受同一上限约束。
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 8192, true);
            using var contents = new MemoryStream();
            var buffer = new byte[8192];
            int read;
            while ((read = await stream.ReadAsync(buffer, token)) != 0)
            {
                bytes += read;
                if (bytes > MaxBytes || contents.Length + read > 32L * 1024 * 1024)
                    throw new HostFailure("INPUT_BUDGET_EXCEEDED", "Input grew beyond byte budget.");
                contents.Write(buffer, 0, read);
            }
            var data = contents.ToArray();
            files.Add(file, data);
            aggregate.AppendData(Encoding.UTF8.GetBytes(file.ToUpperInvariant() + "\0"));
            aggregate.AppendData(SHA256.HashData(data));
        }
        return new(Convert.ToHexString(aggregate.GetHashAndReset()), files, bytes);
    }

    /// <summary>取得已有 global.json 的内容签名；SDK 已在进程内绑定，变化后必须重启 Host。</summary>
    public string SdkSelection => string.Join(";", Files.Where(pair => Path.GetFileName(pair.Key).Equals("global.json", StringComparison.OrdinalIgnoreCase))
        .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
        .Select(pair => pair.Key + ":" + Convert.ToHexString(SHA256.HashData(pair.Value))));
}
