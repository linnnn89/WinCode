using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Build.Locator;

/// <summary>
/// 自有 C# Host：直接调用 Roslyn，内部协议 v2，由显式启用的 Gateway RoslynAdapter 管理。
/// MSBuild targets 是获准执行的项目代码，本进程不是执行沙盒，也不自动 restore。
/// </summary>
internal static class Program
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly object OutputLock = new();

    /// <summary>一个已接纳请求拥有一个取消源；排队、执行和回收全过程共用其身份。</summary>
    private sealed record Pending(string Id, JsonElement Request, CancellationTokenSource Cancellation);

    /// <summary>验证显式求值许可、固定工作区和配置；按入口项目目录选择 SDK 后启动会话。</summary>
    /// <param name="args">--allow-project-evaluation ROOT PROJECT CONFIGURATION FRAMEWORK [ADDITIONAL_INPUTS_JSON]。</param>
    /// <returns>正常退出 0；启动、协议流或资源释放失败 1。</returns>
    private static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            // 发布验收只读取自身程序集，必须在项目许可校验和 MSBuild 初始化之前返回。
            if (args is ["--identity"])
            {
                Write(new { success = true, hostIdentity = HostBuildIdentity.Current });
                return 0;
            }
            if (args.Length is not (5 or 6) || args[0] != "--allow-project-evaluation")
                throw new ArgumentException("Explicit project evaluation permission required: --allow-project-evaluation ROOT PROJECT CONFIGURATION FRAMEWORK");
            var root = Path.GetFullPath(args[1]);
            var project = WorkspaceInputs.Inside(root, args[2]);
            var additionalInputs = WorkspaceInputs.ParseAdditionalInputs(root, args.Length == 6 ? args[5] : "[]");
            if (!Path.GetExtension(project).Equals(".csproj", StringComparison.OrdinalIgnoreCase) || !File.Exists(project))
                throw new ArgumentException("A C# project is required.");
            if (string.IsNullOrWhiteSpace(args[3]) || string.IsNullOrWhiteSpace(args[4])) throw new ArgumentException("Explicit configuration and framework required.");
            // MSBuild 定位先于 JIT 加载 Workspace；CWD 仅在这个自有进程内改变。
            Directory.SetCurrentDirectory(Path.GetDirectoryName(project)!);
            OwnedProcessJob.Attach();
            MSBuildLocator.RegisterDefaults();
            return await RunAsync(root, project, args[3], args[4], additionalInputs);
        }
        catch (Exception error) { WriteFailure(null, error, "hostError"); return 1; }
    }

    /// <summary>stdout 仅写完整单行 JSON；主读循环的取消确认与工作线程响应串行写入。</summary>
    private static void Write(object value)
    {
        lock (OutputLock) Console.WriteLine(JsonSerializer.Serialize(value, Json));
    }

    /// <summary>按已知异常类型分类，不用自然语言推断恢复。错误响应不携带旧引用。</summary>
    private static void WriteFailure(string? id, Exception error, string type = "result") => Write(new {
        id, type, success = false, errorCode = error switch {
            HostFailure failure => failure.Code,
            OperationCanceledException => "CANCELLED",
            ArgumentException or JsonException or FormatException or InvalidOperationException or KeyNotFoundException => "INVALID_ARGUMENT",
            _ => "QUERY_FAILED"
        }, error = error.Message
    });

    /// <summary>
    /// 持有一个固定根的会话。工作队列最多 8 条，语义操作串行执行；输入线程可立即取消。
    /// shutdown/EOF 停止接纳并取消现有请求，等待它们结束及资源释放后才确认关闭。
    /// </summary>
    /// <remarks>
    /// v2 请求：references 必填 id/operation/snapshot/project/file/position；
    /// symbols 必填 id/operation/snapshot/query，可选 kind/file；最多返回 200 个声明与当前快照定位。
    /// position 是零基 UTF-16 偏移，返回 line/column 一基，start/length 零基 UTF-16。
    /// reload 只需 id/operation，成功返回新的 ready/snapshot，调用者必须重新定位。
    /// cancel 使用 id/operation/targetId，确认仅说明取消已发出，目标请求仍有独立结果。
    /// symbols/references 的 timeoutMs 默认 30000、上限 60000；reload 默认/上限 120000，均至少 1，包含排队时间。
    /// limit 为 1–1000、默认 100，只约束返回量。协作取消不等于进程级硬截止。
    /// </remarks>
    private static async Task<int> RunAsync(string root, string project, string configuration, string framework, string[] additionalInputs)
    {
        var session = new WorkspaceSession(root, project, configuration, framework, additionalInputs);
        var queue = Channel.CreateBounded<Pending>(new BoundedChannelOptions(8) { SingleReader = true, SingleWriter = true });
        var requests = new ConcurrentDictionary<string, CancellationTokenSource>();
        using var stopping = new CancellationTokenSource();
        string? shutdownId = null;
        Task worker = Task.CompletedTask;
        try
        {
            using (var initialDeadline = new CancellationTokenSource(120000))
                Write(await session.ReloadAsync(null, initialDeadline.Token));
            worker = Task.Run(async () => {
                await foreach (var pending in queue.Reader.ReadAllAsync())
                {
                    try
                    {
                        pending.Cancellation.Token.ThrowIfCancellationRequested();
                        var operation = pending.Request.GetProperty("operation").GetString();
                        var response = operation switch {
                            "reload" => await session.ReloadAsync(pending.Id, pending.Cancellation.Token),
                            "references" => await session.ReferencesAsync(pending.Request, pending.Cancellation.Token),
                            "symbols" => await session.SymbolsAsync(pending.Request, pending.Cancellation.Token),
                            _ => throw new ArgumentException("Unknown operation.")
                        };
                        pending.Cancellation.Token.ThrowIfCancellationRequested();
                        Write(response);
                    }
                    catch (Exception error) { WriteFailure(pending.Id, error); }
                    finally
                    {
                        requests.TryRemove(pending.Id, out _);
                        pending.Cancellation.Dispose();
                    }
                }
            });
            while (true)
            {
                var line = ReadFrame();
                if (line == null) break;
                string? id = null;
                try
                {
                    using var json = JsonDocument.Parse(line);
                    var request = json.RootElement;
                    id = request.GetProperty("id").GetString();
                    if (string.IsNullOrWhiteSpace(id) || id.Length > 128) throw new ArgumentException("id must contain 1–128 characters.");
                    if (requests.ContainsKey(id)) throw new HostFailure("DUPLICATE_REQUEST", "Request id is already active.");
                    var operation = request.GetProperty("operation").GetString();
                    if (operation == "shutdown") { shutdownId = id; break; }
                    if (operation == "cancel")
                    {
                        var targetId = request.GetProperty("targetId").GetString() ?? throw new ArgumentException("targetId required.");
                        var cancelled = requests.TryGetValue(targetId, out var cancellation);
                        if (cancelled) try { cancellation!.Cancel(); } catch (ObjectDisposedException) { cancelled = false; }
                        Write(new { id, success = true, targetId, cancellationRequested = cancelled });
                        continue;
                    }
                    if (operation is not ("references" or "symbols" or "reload")) throw new ArgumentException("Unknown operation.");
                    var maximum = operation == "reload" ? 120000 : 60000;
                    var duration = request.TryGetProperty("timeoutMs", out var value) ? value.GetInt32() : operation == "reload" ? 120000 : 30000;
                    if (duration < 1 || duration > maximum) throw new ArgumentException("Invalid timeout.");
                    var source = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
                    source.CancelAfter(duration);
                    requests[id] = source;
                    if (!queue.Writer.TryWrite(new(id, request.Clone(), source)))
                    {
                        requests.TryRemove(id, out _);
                        source.Dispose();
                        throw new HostFailure("BUSY", "Host queue is full.");
                    }
                }
                catch (Exception error) { WriteFailure(id, error); }
            }
        }
        finally
        {
            try { stopping.Cancel(); }
            finally
            {
                queue.Writer.TryComplete();
                try { await worker; }
                finally { session.Dispose(); }
            }
        }
        if (shutdownId != null) Write(new { id = shutdownId, success = true });
        return 0;
    }

    /// <summary>读取最多 65536 个 UTF-16 字符；超长帧终止会话，避免继续解析失去边界的数据。</summary>
    private static string? ReadFrame()
    {
        var buffer = new StringBuilder();
        while (true)
        {
            var ch = Console.Read();
            if (ch == -1) return buffer.Length == 0 ? null : buffer.ToString();
            if (ch == '\n') return buffer.ToString();
            if (buffer.Length >= 65536) throw new ArgumentException("Request frame exceeds 64 Ki characters.");
            buffer.Append((char)ch);
        }
    }
}
