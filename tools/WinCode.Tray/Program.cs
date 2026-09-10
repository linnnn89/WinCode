using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Security.Principal;
using System.Text.Json;

namespace WinCode.Tray;

internal static class Program
{
    public static string Version => typeof(Program).Assembly.GetName().Version!.ToString(3);
    internal static void ShowExisting(string endpoint)
    {
        using var existing = new NamedPipeClientStream(".", endpoint, PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, TokenImpersonationLevel.Identification);
        existing.Connect(2000);
        existing.Write(JsonSerializer.SerializeToUtf8Bytes(new { v = 1, type = "show" })); existing.WriteByte(10);
        using var timeout = new CancellationTokenSource(3000);
        var reply = new FrameReader(existing).Read(timeout.Token).GetAwaiter().GetResult();
        if (reply.GetProperty("v").GetInt32() != 1 || reply.GetProperty("type").GetString() != "show-accepted")
            throw new IOException("已有托盘没有确认显示请求。");
    }
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.SequenceEqual(new[] { "--endpoint" })) { Console.WriteLine(JsonSerializer.Serialize(new { version = Version, pipeName = PipeHub.Endpoint })); return 0; }
            if (args.SequenceEqual(new[] { "--identity" })) {
                Console.WriteLine(JsonSerializer.Serialize(new { version = Version, configuration = typeof(Program).Assembly.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration, protocolVersion = 1 })); return 0;
            }
            var selfTest = args.Length == 2 && args[0] is "--self-test" or "--workflow-test" && Path.IsPathFullyQualified(args[1]);
            if (!selfTest && args.Length != 0 && !args.SequenceEqual(new[] { "--show" })) throw new ArgumentException("Supported: --show, --endpoint, --identity, --self-test ABSOLUTE_REPORT_DIRECTORY");
            string endpoint = PipeHub.Endpoint + (selfTest ? ".test-" + Guid.NewGuid().ToString("N") : "");
            using var single = new Mutex(true, "Local\\" + endpoint, out var created);
            if (!created) {
                ShowExisting(endpoint);
                return 0;
            }
            if (selfTest) Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            ApplicationConfiguration.Initialize();
            using var hub = new PipeHub(endpoint);
            using var window = new SettingsWindow(hub);
            if (selfTest) {
                window.Shown += async (_, _) => {
                    if (args[0] == "--workflow-test") await TrayAcceptance.RunWorkflow(window, hub, endpoint, args[1]);
                    else await TrayAcceptance.Run(window, hub, endpoint, args[1]);
                };
                Application.Run(window);
            } else {
                var context = new ApplicationContext();
                window.FormClosed += (_, _) => { if (window.ExitRequested) context.ExitThread(); };
                _ = window.Handle; // 隐藏时也接受“显示设置”和实例变化消息。
                if (args.Contains("--show")) window.Open();
                Application.Run(context);
            }
            single.ReleaseMutex();
            return Environment.ExitCode;
        }
        catch (Exception error) {
            Console.Error.WriteLine(args.Any(arg => arg is "--self-test" or "--workflow-test") ? error.ToString() : error.Message);
            if (args.Length == 0 || args.SequenceEqual(new[] { "--show" })) MessageBox.Show(error.Message, "WinCode 托盘启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
