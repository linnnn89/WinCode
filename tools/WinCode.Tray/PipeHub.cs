using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace WinCode.Tray;

internal sealed class FrameReader(Stream stream)
{
    private readonly byte[] buffer = new byte[65537];
    private int used;
    public async Task<JsonElement> Read(CancellationToken token)
    {
        while (true)
        {
            int newline = Array.IndexOf(buffer, (byte)10, 0, used);
            if (newline >= 0)
            {
                using var json = JsonDocument.Parse(buffer.AsMemory(0, newline), new JsonDocumentOptions { MaxDepth = 12 });
                var value = json.RootElement.Clone();
                Buffer.BlockCopy(buffer, newline + 1, buffer, 0, used - newline - 1); used -= newline + 1;
                return value;
            }
            if (used >= 65536) throw new InvalidDataException("控制消息超过容量限制。");
            int read = await stream.ReadAsync(buffer.AsMemory(used, buffer.Length - used), token);
            if (read == 0) throw new EndOfStreamException();
            used += read;
        }
    }
}

internal sealed class GatewayPeer(NamedPipeServerStream pipe, string id, int pid, string version, string build, JsonElement status)
{
    public string Id { get; } = id;
    public int Pid { get; } = pid;
    public string Version { get; } = version;
    public string Build { get; } = build;
    public JsonElement Status { get; private set; } = status;
    public bool Connected { get; private set; } = true;
    public DateTime ObservedAt { get; private set; } = DateTime.Now;
    public string? ObservationError { get; private set; }
    // 只影响界面的可信度，不轮询或改变 Gateway/Roslyn 生命周期。
    public bool StatusCurrent => Connected && ObservationError == null && DateTime.Now - ObservedAt < TimeSpan.FromSeconds(30);
    private readonly SemaphoreSlim writer = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> pending = new();
    public event Action? Changed;

    public async Task<JsonElement> Request(string operation)
    {
        if (!Connected) throw new IOException("实例已失联；不能推断它已经退出。");
        if (pending.Count >= 8) throw new IOException("此实例已有过多待完成操作。");
        string requestId = Guid.NewGuid().ToString("N");
        var result = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!pending.TryAdd(requestId, result)) throw new IOException("请求身份冲突。");
        using var timeout = new CancellationTokenSource(operation == "status" ? 2000 : 10000);
        try
        {
            var frame = JsonSerializer.SerializeToUtf8Bytes(new { v = 1, type = "request", id = requestId, instanceId = Id, operation });
            await writer.WaitAsync(timeout.Token);
            try {
                if (!Connected) throw new IOException("实例已失联，未发送控制操作。");
                await pipe.WriteAsync(frame, timeout.Token); await pipe.WriteAsync(new byte[] { 10 }, timeout.Token);
            }
            finally { writer.Release(); }
            var value = await result.Task.WaitAsync(timeout.Token);
            if (operation == "status") { ValidateStatus(value); Status = value; ObservedAt = DateTime.Now; ObservationError = null; Changed?.Invoke(); }
            return value;
        }
        catch (OperationCanceledException) {
            ObservationError = "操作等待超时，状态未知。请刷新状态；不会自动重发控制操作。"; Changed?.Invoke();
            throw new TimeoutException(ObservationError);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or InvalidOperationException or KeyNotFoundException) {
            ObservationError = error.Message; Changed?.Invoke(); throw;
        }
        finally { pending.TryRemove(requestId, out _); }
    }

    public void Accept(JsonElement value)
    {
        if (value.GetProperty("v").GetInt32() != 1 || value.GetProperty("type").GetString() != "response" || value.GetProperty("instanceId").GetString() != Id)
            throw new InvalidDataException("实例响应身份不符。");
        string requestId = value.GetProperty("id").GetString() ?? "";
        if (requestId.Length > 64) throw new InvalidDataException("无效响应身份。");
        // 已超时请求的迟到结果不触发操作重放，也不归入另一个请求。
        if (pending.TryGetValue(requestId, out var completion)) completion.TrySetResult(value.GetProperty("result").Clone());
    }

    public void Disconnect()
    {
        Connected = false;
        ObservationError = "连接已断开，状态未知。";
        foreach (var item in pending.Values) item.TrySetException(new IOException("连接已断开，控制结果未知。"));
        Changed?.Invoke();
    }

    public static string Text(JsonElement value, string name, int max = 4096) =>
        value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String
            ? (field.GetString() ?? "")[..Math.Min(max, field.GetString()!.Length)] : "";

    public static void ValidateStatus(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object || Text(value, "workspace").Length == 0 ||
            Text(value, "provider") is not ("roslyn" or "local-text") || Text(value, "state") is not ("idle" or "busy" or "releasing" or "shutting-down" or "recovery-required") ||
            value.GetProperty("automaticRelease").ValueKind != JsonValueKind.False ||
            value.GetProperty("roslynLoaded").ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("实例状态不符合手动释放协议。");
    }
}

internal sealed class PipeHub : IDisposable
{
    private static readonly int Session = GetSession();
    private static readonly string UserSid = GetUserSid();
    private static int GetSession() { using var process = Process.GetCurrentProcess(); return process.SessionId; }
    private static string GetUserSid() { using var identity = WindowsIdentity.GetCurrent(); return identity.User!.Value; }
    public static string Endpoint => $"WinCode.Tray.v1.{UserSid}.s{Session}";
    private readonly CancellationTokenSource stopped = new();
    private readonly SemaphoreSlim registrations = new(8, 8);
    private readonly NamedPipeServerStream[] listeners;
    private readonly ConcurrentDictionary<string, GatewayPeer> peers = new();
    public event Action? Changed;
    public event Action? ShowRequested;
    public string? LastConnectionError { get; private set; }
    public GatewayPeer[] Peers => peers.Values.OrderByDescending(value => value.Connected).ThenBy(value => value.Id).ToArray();

    public PipeHub(string name)
    {
        var created = new List<NamedPipeServerStream>();
        try
        {
            // 八个 Gateway 加一个唤出窗口的槽；首个实例保持到 Hub 关闭，防止管道被中途重新抢占。
            for (int i = 0; i < 9; i++) created.Add(new NamedPipeServerStream(name, PipeDirection.InOut, 9, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | (i == 0 ? PipeOptions.FirstPipeInstance : PipeOptions.None), 8192, 8192));
            listeners = created.ToArray();
            foreach (var pipe in listeners) _ = Listen(pipe);
        }
        catch { foreach (var pipe in created) pipe.Dispose(); stopped.Dispose(); throw; }
    }

    private async Task Listen(NamedPipeServerStream pipe)
    {
        while (!stopped.IsCancellationRequested)
        {
            GatewayPeer? peer = null;
            bool registeredSlot = false, authenticated = false;
            string? registrationId = null;
            try
            {
                await pipe.WaitForConnectionAsync(stopped.Token);
                if (!GetNamedPipeClientSessionId(pipe.SafePipeHandle, out var session) || session != Session ||
                    !GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid)) throw new IOException("拒绝不同登录会话的连接。");
                var computer = new StringBuilder(256);
                bool gotComputer = GetNamedPipeClientComputerNameW(pipe.SafePipeHandle, computer, (uint)computer.Capacity);
                int computerError = Marshal.GetLastWin32Error();
                // 本机连接的 Win32 返回值是 ERROR_PIPE_LOCAL (229)，而非返回本机名称的成功结果。
                // 查询成功意味着远程连接；其余查询失败均拒绝，不通过名称比较放宽边界。
                if (gotComputer || computerError != 229) throw new IOException($"仅支持本机连接（Win32 {computerError}）。");
                var reader = new FrameReader(pipe);
                using var handshake = CancellationTokenSource.CreateLinkedTokenSource(stopped.Token); handshake.CancelAfter(3000);
                var registration = await reader.Read(handshake.Token);
                // CurrentUserOnly 在部分 .NET 版本使用 Owner SID；额外核验实际客户端 User SID。
                // 仅在同步委托内读身份；不以客户端身份操作文件或启动程序。
                string? clientSid = null;
                pipe.RunAsClient(() => { using var identity = WindowsIdentity.GetCurrent(true); clientSid = identity?.User?.Value; });
                if (clientSid != UserSid) throw new IOException("拒绝不同用户或无法核验身份的连接。");
                authenticated = true;
                registrationId = GatewayPeer.Text(registration, "instanceId", 64);
                if (registration.GetProperty("v").GetInt32() != 1) throw new InvalidDataException("控制协议版本不符。");
                if (GatewayPeer.Text(registration, "type") == "show") {
                    ShowRequested?.Invoke();
                    await pipe.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(new { v = 1, type = "show-accepted" }), handshake.Token);
                    await pipe.WriteAsync(new byte[] { 10 }, handshake.Token);
                    // 同样等待唤出客户端读完确认后关闭，避免 Disconnect 丢弃确认帧。
                    _ = await pipe.ReadAsync(new byte[1], handshake.Token);
                    continue;
                }
                if (!(registeredSlot = registrations.Wait(0))) throw new IOException("最多连接八个实例。");
                var id = GatewayPeer.Text(registration, "instanceId", 64);
                var version = GatewayPeer.Text(registration, "version", 64);
                if (GatewayPeer.Text(registration, "type") != "register" || !Guid.TryParseExact(id, "D", out _) ||
                    registration.GetProperty("pid").GetInt32() != pid || version != Program.Version)
                    throw new InvalidDataException("注册身份或产品版本不符。");
                var status = registration.GetProperty("status").Clone(); GatewayPeer.ValidateStatus(status);
                if (peers.TryGetValue(id, out var existing) && existing.Connected) throw new InvalidDataException("重复的实例身份。");
                peer = new GatewayPeer(pipe, id, (int)pid, version, GatewayPeer.Text(registration, "buildId", 64), status);
                peer.Changed += OnChanged;
                await pipe.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(new { v = 1, type = "register-accepted", instanceId = id }), handshake.Token);
                await pipe.WriteAsync(new byte[] { 10 }, handshake.Token);
                peers[id] = peer;
                foreach (var old in peers.Values.Where(item => !item.Connected).OrderBy(item => item.ObservedAt).Take(Math.Max(0, peers.Count - 32))) peers.TryRemove(old.Id, out _);
                OnChanged();
                while (!stopped.IsCancellationRequested) peer.Accept(await reader.Read(stopped.Token));
            }
            catch (Exception error) when (error is IOException or InvalidDataException or OperationCanceledException or JsonException or InvalidOperationException or KeyNotFoundException or ObjectDisposedException or FormatException or UnauthorizedAccessException or System.Security.SecurityException) {
                if (!stopped.IsCancellationRequested && error is not EndOfStreamException) {
                    LastConnectionError = error.Message[..Math.Min(500, error.Message.Length)]; OnChanged();
                    if (authenticated && peer == null && registrationId != null) {
                        try {
                            using var replyDeadline = new CancellationTokenSource(1000);
                            await pipe.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(new { v = 1, type = "register-rejected", instanceId = registrationId, message = LastConnectionError }), replyDeadline.Token);
                            await pipe.WriteAsync(new byte[] { 10 }, replyDeadline.Token);
                            // DisconnectNamedPipe 会丢弃尚未读取的数据。让客户端读完拒绝原因后关闭，
                            // 最多等一秒；不使用不可取消的 WaitForPipeDrain 阻塞托盘。
                            _ = await pipe.ReadAsync(new byte[1], replyDeadline.Token);
                        } catch (Exception replyError) when (replyError is IOException or OperationCanceledException or ObjectDisposedException) { }
                    }
                }
            }
            finally
            {
                peer?.Disconnect();
                if (registeredSlot) registrations.Release();
                if (!stopped.IsCancellationRequested) { try { if (pipe.IsConnected) pipe.Disconnect(); } catch (IOException) { } }
            }
        }
    }

    private void OnChanged() => Changed?.Invoke();
    public void Dispose() { stopped.Cancel(); foreach (var pipe in listeners) pipe.Dispose(); }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint session);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientComputerNameW(SafePipeHandle pipe, StringBuilder name, uint length);
}
