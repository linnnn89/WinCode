using System.Text.Json;
using System.IO.Pipes;
using System.Security.Principal;

namespace WinCode.Tray;

/** 仅 --self-test 的隔离命名空间；Node 验收夹具提供两个模拟后端，真实 Roslyn 另行验证。 */
internal static class TrayAcceptance
{
    // 仅隔离 --workflow-test 使用：驱动真实窗口处理函数，不增加线上管道命令。
    public static async Task RunWorkflow(SettingsWindow window, PipeHub hub, string endpoint, string root) {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(8));
        try {
            Directory.CreateDirectory(root);
            Console.WriteLine(JsonSerializer.Serialize(new { pipeName = endpoint, pid = Environment.ProcessId })); Console.Out.Flush();
            int completed = 0;
            while (true) {
                string input = Path.Combine(root, $"command-{completed + 1}.json");
                if (!File.Exists(input)) { await Task.Delay(25, deadline.Token); continue; }
                using var json = JsonDocument.Parse(await File.ReadAllTextAsync(input, deadline.Token));
                string operation = GatewayPeer.Text(json.RootElement, "operation");
                string id = GatewayPeer.Text(json.RootElement, "instanceId");
                if (operation == "hide") window.Hide();
                else if (operation == "show") { window.Show(); await window.RefreshStatus(); }
                else if (operation == "refresh") await window.RefreshStatus();
                else if (operation == "release") {
                    Require(hub.Peers.Any(peer => peer.Id == id && peer.Connected), "Fixture instance is not connected");
                    window.SelectInstance(id); await window.ReleaseSelected();
                } else if (operation != "exit") throw new InvalidDataException("Unsupported fixture command");
                var reply = new { result = window.LastResult, visible = window.Visible,
                    peers = hub.Peers.Select(peer => new { instanceId = peer.Id, pid = peer.Pid, connected = peer.Connected,
                        current = peer.StatusCurrent, observationError = peer.ObservationError, status = peer.Status }) };
                var output = Path.Combine(root, $"reply-{++completed}.json");
                await File.WriteAllTextAsync(output + ".tmp", JsonSerializer.Serialize(reply), deadline.Token);
                File.Move(output + ".tmp", output);
                if (operation == "exit") break;
            }
        } catch (Exception error) {
            Environment.ExitCode = 1; await File.WriteAllTextAsync(Path.Combine(root, "workflow-error.txt"), error.ToString());
        } finally { window.ExitTray(); }
    }
    public static async Task Run(SettingsWindow window, PipeHub hub, string endpoint, string root)
    {
        var scenarios = new List<string>(); string? failure = null;
        try
        {
            Directory.CreateDirectory(root);
            Console.WriteLine(JsonSerializer.Serialize(new { pipeName = endpoint, pid = Environment.ProcessId, hwnd = $"0x{window.Handle.ToInt64():X}" })); Console.Out.Flush();
            var deadline = DateTime.UtcNow.AddSeconds(20);
            while (hub.Peers.Count(peer => peer.Connected) != 2) {
                if (DateTime.UtcNow > deadline) throw new Exception("Two fixture connections did not register: " + hub.LastConnectionError);
                await Task.Delay(50);
            }
            await window.RefreshStatus();
            var idle = hub.Peers.Single(peer => GatewayPeer.Text(peer.Status, "state") == "idle");
            var busy = hub.Peers.Single(peer => GatewayPeer.Text(peer.Status, "state") == "busy");
            Console.Error.WriteLine("[tray-ui] stale status and release preflight");
            await VerifyStaleStatus(window, hub, endpoint, idle.Status);
            scenarios.Add("Connected but unresponsive peer becomes unknown, disables release, preserves observation time, and recovers on explicit refresh without replaying control");
            Console.Error.WriteLine("[tray-ui] repeated rejected registrations");
            for (int attempt = 0; attempt < 12; attempt++) await VerifyRejectedRegistration(hub, endpoint, idle.Status);
            scenarios.Add("Authenticated incompatible registration receives a bounded rejection reason visible to the settings hub");
            Console.Error.WriteLine("[tray-ui] selected instance controls");
            Require(!window.SelectInstance(busy.Id), "Busy instance must disable release");
            await window.ReleaseSelected();
            Require(window.LastResult.Contains("工作"), "Backend must refuse release while busy");
            scenarios.Add("Busy selection disables release and backend independently refuses the command");
            Require(window.SelectInstance(idle.Id), "Idle Roslyn instance must enable release");
            Require(!window.SelectedDetail.Contains(window.LastResult), "Another instance's operation result must not appear in this selection");
            using (var bitmap = new Bitmap(window.Width, window.Height)) {
                window.DrawToBitmap(bitmap, new Rectangle(0, 0, window.Width, window.Height));
                bitmap.Save(Path.Combine(root, "settings.png"));
            }
            await window.ReleaseSelected();
            Require(window.LastResult.Contains("已释放"), "Release result missing");
            Require(!idle.Status.GetProperty("roslynLoaded").GetBoolean(), "Released state was not refreshed");
            Require(busy.Status.GetProperty("roslynLoaded").GetBoolean(), "Another instance was affected");
            scenarios.Add("Settings releases only the selected idle instance and refreshes its state");
            await window.ReleaseSelected();
            Require(window.LastResult.Contains("无需释放"), "Repeated release is not a no-op");
            scenarios.Add("Repeated manual release is harmless");
            Console.Error.WriteLine("[tray-ui] hide and show acknowledgement");
            window.Hide(); await Task.Delay(300);
            Require(idle.Connected && busy.Connected, "Hiding settings disconnected Gateways");
            scenarios.Add("Closing/hiding settings preserves independent Gateway connections");
            var shown = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            void OnVisible(object? sender, EventArgs args) { if (window.Visible) shown.TrySetResult(); }
            window.VisibleChanged += OnVisible;
            try {
                await Task.Run(() => Program.ShowExisting(endpoint));
                await shown.Task.WaitAsync(TimeSpan.FromSeconds(3));
                Require(hub.Peers.Count(peer => peer.Connected) == 2, "Showing existing settings changed instance connections");
            } finally { window.VisibleChanged -= OnVisible; }
            scenarios.Add("Duplicate-launch show path authenticates a .NET client, acknowledges and reopens the existing window without another Tray");
        }
        catch (Exception error) { failure = error.ToString(); Environment.ExitCode = 1; }
        finally {
            await File.WriteAllTextAsync(Path.Combine(root, "tray-ui-report.json"), JsonSerializer.Serialize(new { success = failure == null, scenarios, error = failure,
                limitation = "Actual WinForms controls and secured Named Pipe; simulated Roslyn backends. Physical UIA and real Roslyn tested separately." }, new JsonSerializerOptions { WriteIndented = true }));
            window.ExitTray();
        }
    }
    private static NamedPipeClientStream Client(string endpoint) => new(".", endpoint, PipeDirection.InOut,
        PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, TokenImpersonationLevel.Identification);
    private static async Task Send(Stream pipe, object frame) {
        await pipe.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(frame)); await pipe.WriteAsync(new byte[] { 10 });
    }
    private static async Task VerifyRejectedRegistration(PipeHub hub, string endpoint, JsonElement status) {
        using var pipe = Client(endpoint); using var deadline = new CancellationTokenSource(5000);
        await pipe.ConnectAsync(deadline.Token);
        var id = Guid.NewGuid().ToString("D");
        await Send(pipe, new { v = 1, type = "register", instanceId = id, pid = Environment.ProcessId, version = "0.0.0", status });
        var reply = await new FrameReader(pipe).Read(deadline.Token);
        Require(GatewayPeer.Text(reply, "type") == "register-rejected" && GatewayPeer.Text(reply, "instanceId") == id, "Registration rejection identity missing");
        Require(GatewayPeer.Text(reply, "message").Contains("版本") && hub.LastConnectionError?.Contains("版本") == true, "Version rejection reason missing");
    }
    private static async Task VerifyStaleStatus(SettingsWindow window, PipeHub hub, string endpoint, JsonElement status) {
        using var pipe = Client(endpoint); using var deadline = new CancellationTokenSource(10000);
        await pipe.ConnectAsync(deadline.Token);
        var id = Guid.NewGuid().ToString("D");
        await Send(pipe, new { v = 1, type = "register", instanceId = id, pid = Environment.ProcessId, version = Program.Version, status });
        var reader = new FrameReader(pipe);
        Require(GatewayPeer.Text(await reader.Read(deadline.Token), "type") == "register-accepted", "Registration acknowledgement missing");
        while (!hub.Peers.Any(peer => peer.Id == id)) await Task.Delay(10, deadline.Token);
        var peer = hub.Peers.Single(peer => peer.Id == id); var observed = peer.ObservedAt;
        Require(window.SelectInstance(id), "Fresh idle observation should allow manual release");
        var refresh = window.RefreshStatus();
        Require(GatewayPeer.Text(await reader.Read(deadline.Token), "operation") == "status", "Expected passive refresh");
        await refresh; // 故意保持连接但不响应，走真实的两秒超时路径。
        Require(peer.Connected && !peer.StatusCurrent && peer.ObservationError != null, "Timed-out live peer must become unknown");
        Require(peer.ObservedAt == observed && !window.SelectInstance(id), "Old observation must not be presented as refreshed or release-enabled");
        var release = window.ReleaseSelected();
        Require(GatewayPeer.Text(await reader.Read(deadline.Token), "operation") == "status", "Manual release must preflight with a passive status");
        await release;
        Require(window.LastResult.Contains("超时") && peer.ObservedAt == observed, "A failed preflight must report timeout without executing release");
        refresh = window.RefreshStatus();
        var request = await reader.Read(deadline.Token);
        Require(GatewayPeer.Text(request, "operation") == "status", "Timeout must not replay release");
        await Send(pipe, new { v = 1, type = "response", id = GatewayPeer.Text(request, "id"), instanceId = id, result = status });
        await refresh;
        Require(peer.StatusCurrent && peer.ObservationError == null && window.SelectInstance(id), "Explicit successful refresh must recover availability");
        pipe.Close();
        while (peer.Connected) await Task.Delay(10, deadline.Token);
    }
    private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
}
