using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;
using static WinCode.UIA.Host.NativeWindows;

namespace WinCode.UIA.Host;

/// <summary>只读定位及列出候选窗口；不改变焦点或启动目标程序。</summary>
internal static class WindowResolver
{
    internal static InspectResponse ListWindows(InspectRequest request)
    {
        int limit = request.MaxWindows ?? 30;
        if (request.Pid < 0 || limit < 1 || limit > 100 ||
            new[] { request.ProcessName, request.TitleContains }.Any(s => s != null &&
                (string.IsNullOrWhiteSpace(s) || s.Length > 128 || s.Any(char.IsControl))))
            return new InspectResponse { Success = false, ErrorCode = "INVALID_ARGUMENT", ErrorMessage = "Invalid window filters." };

        var windows = new List<CandidateWindowDto>();
        var watch = Stopwatch.StartNew();
        string? stopReason = null;
        // Reuse bounded native string buffers across candidates instead of allocating per window.
        var title = new StringBuilder(32769);
        var className = new StringBuilder(257);
        // No UIA COM objects or activation. Native enumeration is bounded independently of output.
        // Do not throw across a native callback; the parent additionally enforces the 3s deadline.
        bool completed = EnumWindows((handle, _) =>
        {
            if (watch.ElapsedMilliseconds >= 2000) { stopReason = "timeout"; return false; }
            if (!IsWindowVisible(handle)) return true;
            GetWindowThreadProcessId(handle, out var pid);
            if (pid == 0 || pid == Environment.ProcessId || (request.Pid > 0 && pid != request.Pid)) return true;
            if (!GetWindowRect(handle, out var rect)) return true;
            title.Clear();
            GetWindowText(handle, title, title.Capacity);
            if (request.TitleContains != null && !title.ToString().Contains(request.TitleContains, StringComparison.OrdinalIgnoreCase)) return true;
            string? processName = null;
            try { using var process = Process.GetProcessById((int)pid); processName = process.ProcessName; }
            catch (Exception) { /* A vanished or inaccessible process must not fail other candidates. */ }
            if (request.ProcessName != null && !string.Equals(processName, request.ProcessName, StringComparison.OrdinalIgnoreCase)) return true;
            // Discover one extra match before marking the output cap, rather than claiming a total.
            if (windows.Count == limit) { stopReason = "maxWindows"; return false; }
            className.Clear();
            GetClassName(handle, className, className.Capacity);
            GetWindowThreadProcessId(handle, out var finalPid);
            if (finalPid != pid || !IsWindowVisible(handle)) return true;
            windows.Add(new CandidateWindowDto { Pid = (int)pid, Hwnd = $"0x{handle.ToInt64():X}",
                Title = title.ToString()[..Math.Min(256, title.Length)], TitleTruncated = title.Length > 256, ClassName = className.ToString(),
                ProcessName = processName, ProcessNameStatus = processName == null ? "unavailable" : "available",
                Bounds = new RectDto(rect.Left, rect.Top, rect.Width, rect.Height), IsIconic = IsIconic(handle) });
            return true;
        }, IntPtr.Zero);
        return new InspectResponse { Success = true, Action = "listWindows", Windows = windows,
            CapturedAt = DateTimeOffset.UtcNow.ToString("O"), EnumerationComplete = completed,
            Truncated = !completed, TruncateReason = stopReason ?? (completed ? null : "enumerationFailed") };
    }

    internal static RECT GetWindowPhysicalRect(IntPtr hwnd)
    {
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out RECT dwmRect, Marshal.SizeOf<RECT>()) == 0)
        {
            if (dwmRect.Width > 0 && dwmRect.Height > 0)
            {
                return dwmRect;
            }
        }

        GetWindowRect(hwnd, out RECT winRect);
        return winRect;
    }
    internal static IntPtr ResolveTargetWindow(
        InspectRequest request,
        out int resolvedPid,
        out List<CandidateWindowDto>? candidates,
        out string? errorCode)
    {
        candidates = null;
        errorCode = null;
        resolvedPid = request.Pid;

        if (!string.IsNullOrWhiteSpace(request.Hwnd))
        {
            var raw = request.Hwnd.Trim();
            long hwndVal;
            if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                hwndVal = Convert.ToInt64(raw[2..], 16);
            }
            else
            {
                hwndVal = Convert.ToInt64(raw);
            }

            var handle = new IntPtr(hwndVal);
            if (handle != IntPtr.Zero)
            {
                GetWindowThreadProcessId(handle, out var windowPid);
                if (request.Pid > 0 && windowPid != request.Pid)
                {
                    errorCode = "HWND_PID_MISMATCH";
                    resolvedPid = 0;
                    return IntPtr.Zero;
                }
                resolvedPid = (int)windowPid;
                return handle;
            }
        }

        var targetPid = (uint)request.Pid;
        var foundWindows = new List<CandidateWindowDto>();

        EnumWindows((hWnd, _) =>
        {
            GetWindowThreadProcessId(hWnd, out var winPid);
            if (winPid == targetPid && IsWindowVisible(hWnd))
            {
                GetWindowRect(hWnd, out var r);
                if (r.Width > 0 && r.Height > 0)
                {
                    var sbTitle = new StringBuilder(256);
                    GetWindowText(hWnd, sbTitle, 256);
                    var sbClass = new StringBuilder(256);
                    GetClassName(hWnd, sbClass, 256);

                    foundWindows.Add(new CandidateWindowDto
                    {
                        Hwnd = $"0x{hWnd.ToInt64():X}",
                        Title = sbTitle.ToString(),
                        ClassName = sbClass.ToString(),
                        Bounds = new RectDto(r.Left, r.Top, r.Width, r.Height),
                        IsIconic = IsIconic(hWnd)
                    });
                }
            }
            return true;
        }, IntPtr.Zero);

        if (foundWindows.Count == 0)
        {
            errorCode = "NO_VISIBLE_WINDOWS";
            return IntPtr.Zero;
        }

        // Filter out system overlays / zero-titled tooltips
        var appWindows = foundWindows.Where(w =>
            !w.ClassName.Contains("IME", StringComparison.OrdinalIgnoreCase) &&
            !w.ClassName.Contains("InputIndicator", StringComparison.OrdinalIgnoreCase) &&
            !w.ClassName.Contains("Tooltip", StringComparison.OrdinalIgnoreCase) &&
            !string.IsNullOrWhiteSpace(w.Title)
        ).ToList();

        if (appWindows.Count == 1)
        {
            var h = Convert.ToInt64(appWindows[0].Hwnd[2..], 16);
            return new IntPtr(h);
        }

        if (appWindows.Count > 1)
        {
            candidates = appWindows;
            errorCode = "MULTIPLE_WINDOWS";
            return IntPtr.Zero;
        }

        if (foundWindows.Count == 1)
        {
            var h = Convert.ToInt64(foundWindows[0].Hwnd[2..], 16);
            return new IntPtr(h);
        }

        // Multiple windows found: return candidates so caller can disambiguate
        candidates = foundWindows;
        errorCode = "MULTIPLE_WINDOWS";
        return IntPtr.Zero;
    }

}
