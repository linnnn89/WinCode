using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using WinCode.Native;

internal static class Program
{
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void GuardCycles(int count) { for (int i = 0; i < count; i++) { using var guard = OwnerProcessGuard.Attach(); } }
    [DllImport("kernel32.dll")] private static extern void Sleep(uint duration);
    private static void Report(string stage) { using var p = Process.GetCurrentProcess(); Console.WriteLine(JsonSerializer.Serialize(new {
        stage, pid = p.Id, created = p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() })); Console.Out.Flush(); }
    private static int Main(string[] args)
    {
        try
        {
            var mode = args.FirstOrDefault() ?? "native-block";
            if (mode == "early-owner-death") { Report("before-attach"); Sleep(3000); }
            if (mode == "self-owner") Environment.SetEnvironmentVariable("WINCODE_OWNER_PID", Environment.ProcessId.ToString());
            using var guard = OwnerProcessGuard.Attach();
            Report("attached");
            if (mode == "normal") return 0;
            if (mode == "repeat")
            {
                using var process = Process.GetCurrentProcess();
                // CLR 的 Thread 对象包含由终结器释放的等待句柄；先预热，再比较回收后的稳定值。
                // GC 只在测试中执行，生产 Host 每个进程仅创建一次 owner guard。
                GuardCycles(3);
                GC.Collect(); GC.WaitForPendingFinalizers();
                process.Refresh(); var initialHandles = process.HandleCount;
                GuardCycles(20);
                GC.Collect(); GC.WaitForPendingFinalizers();
                process.Refresh();
                if (process.HandleCount > initialHandles + 2) throw new InvalidOperationException($"Guard handles accumulate: {initialHandles} -> {process.HandleCount}.");
                Report("repeat-complete"); return 0;
            }
            if (mode == "cooperative") { guard!.Token.WaitHandle.WaitOne(); return 0; }
            if (mode == "blocked-callback") guard!.Token.Register(() => Sleep(uint.MaxValue));
            Sleep(uint.MaxValue); // 模拟不响应托管取消的原生 UI/MSBuild 调用。
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}

