using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace WinCode.Native;

/// <summary>
/// 在重操作前核验自有启动链并持有 owner 的实际进程句柄。只等待该对象，不轮询客户端名称。
/// owner 死亡先广播取消，独立等待线程在两秒后硬退出本 Helper；阻塞的 UI/MSBuild/取消回调不能阻止兜底。
/// </summary>
internal sealed class OwnerProcessGuard : IDisposable
{
    private readonly SafeProcessHandle owner;
    private readonly ManualResetEvent stopped = new(false);
    private readonly CancellationTokenSource cancellation = new();
    private readonly Thread watcher;
    private int disposed;
    public CancellationToken Token => cancellation.Token;

    private OwnerProcessGuard(SafeProcessHandle owner)
    {
        this.owner = owner;
        watcher = new Thread(Watch) { IsBackground = true, Name = "WinCode owner lifetime" };
        try { watcher.Start(); }
        catch { owner.Dispose(); stopped.Dispose(); cancellation.Dispose(); throw; }
    }

    /// <summary>
    /// Gateway 只向自己的子进程传 WINCODE_OWNER_PID；直接运行 Host 时使用实际父进程。
    /// 最多验证八层，支持 dotnet run 包装；每层校验创建时间以拒绝已被复用的祖先 PID。
    /// 无法打开/核实的 owner 在项目求值和 UI 读取前失败，绝不降级到任意存活 PID。
    /// </summary>
    public static OwnerProcessGuard? Attach()
    {
        if (!OperatingSystem.IsWindows()) return null;
        var parents = ParentSnapshot();
        uint current = (uint)Environment.ProcessId;
        if (!parents.TryGetValue(current, out var directParent) || directParent == 0)
            throw new InvalidOperationException("Cannot establish the Helper parent identity.");
        var declared = Environment.GetEnvironmentVariable("WINCODE_OWNER_PID");
        var expected = directParent;
        if (declared != null && (!uint.TryParse(declared, NumberStyles.None, CultureInfo.InvariantCulture, out expected) || expected == 0))
            throw new ArgumentException("WINCODE_OWNER_PID must identify the owning process.");
        var childCreated = Created(GetCurrentProcess());
        for (var depth = 0; depth < 8; depth++)
        {
            if (!parents.TryGetValue(current, out var parent) || parent == 0 || parent == current)
                break;
            var handle = OpenProcess(0x00100000 | 0x1000, false, parent); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
            try
            {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open the owning process.");
                var created = Created(handle.DangerousGetHandle());
                if (created >= childCreated || WaitForSingleObject(handle, 0) != 258)
                    throw new InvalidOperationException("Owning process exited or its PID was reused.");
                if (parent == expected) return new OwnerProcessGuard(handle);
                childCreated = created;
                current = parent;
            }
            catch { handle.Dispose(); throw; }
            handle.Dispose();
        }
        throw new InvalidOperationException("Declared owner is outside the Helper startup chain.");
    }

    /// <summary>一次性收集父子关系；只保留 PID，不使用进程名称或命令行。条目/祖先深度均有上限。</summary>
    private static Dictionary<uint, uint> ParentSnapshot()
    {
        using var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), ExeFile = "" };
        if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var parents = new Dictionary<uint, uint>();
        do
        {
            if (parents.Count >= 32768) throw new InvalidOperationException("Process identity snapshot budget exceeded.");
            parents[entry.ProcessId] = entry.ParentProcessId;
        } while (Process32NextW(snapshot, ref entry));
        var error = Marshal.GetLastWin32Error();
        if (error != 18) throw new Win32Exception(error); // ERROR_NO_MORE_FILES
        return parents;
    }

    private static long Created(IntPtr process)
    {
        if (!GetProcessTimes(process, out var created, out _, out _, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return created;
    }

    private void Watch()
    {
        try
        {
            // owner 句柄一直持有到等待线程结束；不能在另一个线程的 pending wait 中 CloseHandle。
            var result = WaitForMultipleObjects(2, [owner.DangerousGetHandle(), stopped.SafeWaitHandle.DangerousGetHandle()], false, uint.MaxValue);
            if (result == 1) return;
            // owner 已退出或原生等待失败，均不能继续无保护工作；取消回调不能卡住此线程。
            _ = cancellation.CancelAsync().ContinueWith(task => { _ = task.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
            if (!stopped.WaitOne(2000))
                if (!TerminateProcess(GetCurrentProcess(), 72)) // 只终止当前 Helper；Code Host 的 Job 负责其后代。
                    Environment.FailFast("Unable to terminate this orphaned WinCode Helper.");
        }
        finally { owner.Dispose(); stopped.Dispose(); }
    }

    /// <summary>正常退出不触发硬终止；等待线程退出后才释放其正在使用的句柄。</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        stopped.Set();
        watcher.Join();
        cancellation.Dispose();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size, Usage, ProcessId;
        public UIntPtr DefaultHeapId;
        public uint ModuleId, Threads, ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, [MarshalAs(UnmanagedType.Bool)] bool all, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
}
