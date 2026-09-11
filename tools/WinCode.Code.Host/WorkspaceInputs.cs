using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>携带稳定错误码的内部协议失败；恢复动作由调用方处理，不自动重放请求。</summary>
internal sealed class HostFailure(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// 有界输入清单：跟踪约定编译输入、实际文档/元数据，以及显式补充文件和祖先配置。
/// 排除目录只影响默认枚举，显式加载的文件仍加入校验。不能发现任意自定义 target 的隐式外部输入。
/// </summary>
internal sealed record WorkspaceInputs(string Fingerprint, IReadOnlyDictionary<string, byte[]> Files, long Bytes)
{
    /// <summary>全部跟踪路径数量，不等于为冻结文档保留正文的 Files.Count。</summary>
    public int FileCount { get; init; }
    /// <summary>独立保留 global.json 内容签名，清除正文缓存后仍能核对 SDK 选择。</summary>
    public string SdkSelection { get; init; } = "";
    private static readonly HashSet<string> IgnoredDirectories = new(StringComparer.OrdinalIgnoreCase)
        { ".git", "node_modules", ".deps", "bin", "dist", "build", ".cache", ".vs", ".packages", "test-tmp", "trash" };
    private static readonly string[] AncestorNames = ["global.json", "Directory.Build.props", "Directory.Build.targets", "Directory.Packages.props", "NuGet.Config"];
    private static readonly HashSet<string> InputExtensions = new(StringComparer.OrdinalIgnoreCase)
        { ".cs", ".csproj", ".props", ".targets", ".xaml", ".resx", ".resw", ".resources", ".config", ".ruleset" };
    private static readonly HashSet<string> InputNames = new(StringComparer.OrdinalIgnoreCase)
        { "global.json", "project.assets.json", "packages.lock.json", ".editorconfig", ".globalconfig" };
    internal const int MaxEntries = 20000;
    internal const int MaxFiles = 5000;
    internal const long MaxBytes = 128L * 1024 * 1024;

    /// <summary>约定构建输入的保守候选集；新 .cs 仍由 MSBuild 判断是否属于 Compile，不在这里加入项目。</summary>
    public static bool IsAutomaticInput(string file) => InputExtensions.Contains(Path.GetExtension(file)) ||
        InputNames.Contains(Path.GetFileName(file)) || file.EndsWith(".nuget.dgspec.json", StringComparison.OrdinalIgnoreCase);

    /// <summary>启动配置只接受有界、去重的根内普通文件路径；存在性在每次核查时验证，不自动忽略缺项。</summary>
    public static string[] ParseAdditionalInputs(string root, string json)
    {
        if (json.Length > 4096) throw new ArgumentException("Additional inputs JSON exceeds 4096 characters.");
        var requested = JsonSerializer.Deserialize<string[]>(json) ?? throw new ArgumentException("Additional inputs must be an array.");
        if (requested.Length > 32) throw new ArgumentException("At most 32 additional inputs are supported.");
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var file in requested)
        {
            if (string.IsNullOrWhiteSpace(file) || file.Length > 4096 || Path.IsPathRooted(file) || file.IndexOfAny(['*', '?', ':', '\0']) >= 0)
                throw new ArgumentException("Additional inputs require literal workspace-relative file paths.");
            var full = Inside(root, file);
            if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase) || !paths.Add(full))
                throw new ArgumentException("Additional input is the root or a duplicate.");
            result.Add(full);
        }
        return result.ToArray();
    }

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
    /// 流式计算 SHA-256；只有待冻结文档保留正文，其他文件不生成完整字节数组。
    /// extraFiles 来自实际项目及显式补充输入；contentFiles 仅在加载冻结文档时提供。
    /// 枚举/文件/字节预算仍有界，不能因候选过滤而声称无限规模或全磁盘覆盖。
    /// </summary>
    public static async Task<WorkspaceInputs> CaptureAsync(string root, IEnumerable<string> extraFiles, CancellationToken token, IEnumerable<string>? contentFiles = null)
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
                else if (IsAutomaticInput(entry) && DesignTimeBuild.IsCandidate(entry)) paths.Add(entry);
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
        var retained = new HashSet<string>(contentFiles ?? [], StringComparer.OrdinalIgnoreCase);
        var sdkFiles = new List<string>();
        var buffer = new byte[8192];
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
            using var contents = retained.Contains(file) ? new MemoryStream() : null;
            using var fileHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long fileBytes = 0;
            int read;
            while ((read = await stream.ReadAsync(buffer, token)) != 0)
            {
                bytes += read;
                fileBytes += read;
                if (bytes > MaxBytes || fileBytes > 32L * 1024 * 1024)
                    throw new HostFailure("INPUT_BUDGET_EXCEEDED", "Input grew beyond byte budget.");
                fileHash.AppendData(buffer, 0, read);
                contents?.Write(buffer, 0, read);
            }
            if (contents != null) files.Add(file, contents.ToArray());
            var digest = fileHash.GetHashAndReset();
            aggregate.AppendData(Encoding.UTF8.GetBytes(file.ToUpperInvariant() + "\0"));
            aggregate.AppendData(digest);
            if (Path.GetFileName(file).Equals("global.json", StringComparison.OrdinalIgnoreCase))
                sdkFiles.Add(file + ":" + Convert.ToHexString(digest));
        }
        return new(Convert.ToHexString(aggregate.GetHashAndReset()), files, bytes) { FileCount = paths.Count, SdkSelection = string.Join(";", sdkFiles) };
    }
}
