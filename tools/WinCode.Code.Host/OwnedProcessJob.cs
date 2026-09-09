using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

/// <summary>
/// Host 在启动 MSBuild 前加入仅属于自己的 Windows Job；正常退出或被强制终止时回收其后代。
/// 只管理通过普通进程创建继承的后代，不是执行沙盒，也不限制 targets 借助外部服务启动进程。
/// </summary>
internal static class OwnedProcessJob
{
    // 句柄不可继承且由静态字段保活；不能在 Host 返回关闭确认前 Dispose，否则会终止自身。
    // 进程终止时 Windows 关闭最后一个句柄，KILL_ON_JOB_CLOSE 清理该 Job 中的进程。
    private static SafeFileHandle? lifetime;

    /// <summary>一次性绑定本进程；无法建立所有权边界时在任何项目求值前失败。</summary>
    public static void Attach()
    {
        if (!OperatingSystem.IsWindows() || lifetime != null) return;
        var job = CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed.");
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
        try
        {
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()) ||
                !AssignProcessToJobObject(job, GetCurrentProcess()))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to protect owned process tree.");
            lifetime = job;
        }
        catch { job.Dispose(); throw; }
    }

    /// <summary>Win32 JOBOBJECT_BASIC_LIMIT_INFORMATION；指针尺寸字段使用 UIntPtr 保持平台布局。</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    /// <summary>Win32 IO_COUNTERS；扩展限制结构必须保留全部六个 64 位计数器。</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }

    /// <summary>Win32 JOBOBJECT_EXTENDED_LIMIT_INFORMATION；仅设置关闭时终止标志，不设资源配额。</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    /// <summary>创建匿名、不可继承的 Job 句柄。</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);
    /// <summary>写入 Job 扩展限制，信息类别 9 对应 ExtendedLimitInformation。</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimits limits, uint length);
    /// <summary>把本 Host 关联到 Job；后续普通子进程默认继承该关联。</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    /// <summary>取得当前进程的伪句柄，无需 CloseHandle。</summary>
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
}
