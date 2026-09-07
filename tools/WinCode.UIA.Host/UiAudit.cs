using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace WinCode.UIA.Host;

public sealed record AuditNotice(string Directory, long TotalBytes, long WarningBytes, long StopBytes,
    bool Blocked, string? Message);

internal sealed class AuditException(string code, string message, AuditNotice? notice = null) : Exception(message)
{
    public string Code { get; } = code;
    public AuditNotice? Notice { get; } = notice;
}

/// <summary>Small metadata-only audit. The per-directory mutex reserves room for the end record.
/// It deliberately fails busy across independent helpers rather than growing an unbounded queue.</summary>
internal sealed class UiAudit : IDisposable
{
    public const long WarningBytes = 1024 * 1024;
    public const long StopBytes = 2 * 1024 * 1024;
    private const int EndReserve = 384;
    private const string LogName = "access.jsonl", StateName = "notice.state";
    public static string DefaultDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WinCode", "logs", "ui-audit");
    private readonly string directory;
    private readonly Mutex gate;
    private readonly string id = Guid.NewGuid().ToString("N");
    private readonly Stopwatch elapsed = Stopwatch.StartNew();
    private bool owned, finished;

    private UiAudit(string directory)
    {
        this.directory = Path.GetFullPath(directory);
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(this.directory.ToUpperInvariant())));
        gate = new Mutex(false, "Local\\WinCode.UiAudit." + key);
        try { owned = gate.WaitOne(0); }
        catch (AbandonedMutexException) { owned = true; } // Earlier helper died; its start remains evidence of unknown outcome.
        if (!owned) { gate.Dispose(); throw new AuditException("AUDIT_BUSY", "Another UI audit is active; retry after it completes."); }
    }

    public static UiAudit Start(int pid, string? hwnd, string? capture, string operation, string? directory = null)
    {
        var audit = new UiAudit(directory ?? DefaultDirectory);
        try
        {
            System.IO.Directory.CreateDirectory(audit.directory);
            var bytes = Measure(audit.directory);
            var start = Encode(new { v = 1, t = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), id = audit.id,
                phase = "start", helper = Environment.ProcessId, target = pid, hwnd = CanonicalHandle(hwnd),
                op = operation == "listWindows" ? "windows" : "inspect",
                capture = capture is "original" or "annotated" ? capture : "none" });
            var statePath = Path.Combine(audit.directory, StateName);
            int stateReserve = File.Exists(statePath) ? 0 : 32;
            // Check before either file grows; no automatic deletion/rotation of evidence.
            if (bytes + start.Length + EndReserve + stateReserve > StopBytes)
                throw new AuditException("AUDIT_LIMIT_REACHED", "Audit capacity exhausted; UI access refused.", audit.Notice(true, true));
            if (stateReserve > 0) File.WriteAllText(statePath, new string(' ', 32), new UTF8Encoding(false));
            audit.Append(start);
            return audit;
        }
        catch (AuditException) { audit.Dispose(); throw; }
        catch (Exception error) { audit.Dispose(); throw new AuditException("AUDIT_UNAVAILABLE", "Cannot write UI audit: " + error.GetType().Name); }
    }

    public AuditNotice? Finish(bool success, string? errorCode, bool indicatorDisplayed)
    {
        if (finished) return null;
        finished = true; // Never duplicate completion if reporting itself fails.
        try
        {
            var end = Encode(new { v = 1, t = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), id, phase = "end",
                ok = success, code = (errorCode ?? "OK")[..Math.Min(48, (errorCode ?? "OK").Length)],
                ms = elapsed.ElapsedMilliseconds, indicator = indicatorDisplayed });
            if (end.Length > EndReserve || Measure(directory) + end.Length > StopBytes)
                throw new AuditException("AUDIT_LIMIT_REACHED", "No room for audit completion; outcome was not logged.", Notice(true, true));
            Append(end);
            return Notice(false, true);
        }
        catch (AuditException) { throw; }
        catch (Exception error) { throw new AuditException("AUDIT_UNAVAILABLE", "Cannot finish UI audit: " + error.GetType().Name); }
        finally { Dispose(); }
    }

    public static AuditNotice Check(string? directory = null)
    {
        using var audit = new UiAudit(directory ?? DefaultDirectory);
        var result = audit.Notice(false, false);
        return result ?? new AuditNotice(audit.directory, Measure(audit.directory), WarningBytes, StopBytes, false, null);
    }

    private AuditNotice? Notice(bool forceBlocked, bool automatic)
    {
        long bytes = Measure(directory);
        if (bytes < WarningBytes && !forceBlocked) return null;
        bool blocked = forceBlocked || bytes >= StopBytes;
        int level = blocked ? 2 : 1;
        var statePath = Path.Combine(directory, StateName);
        bool due = true;
        if (automatic && File.Exists(statePath))
        {
            // Fixed-size state and a 30-minute cooldown; warning -> blocked can notify immediately.
            var parts = File.ReadAllText(statePath).Trim().Split('|');
            if (parts.Length == 2 && int.TryParse(parts[0], out int oldLevel) && long.TryParse(parts[1], out long at))
                due = level > oldLevel || DateTimeOffset.UtcNow.ToUnixTimeSeconds() - at >= 1800;
            if (due) File.WriteAllText(statePath, $"{level}|{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}".PadRight(32), new UTF8Encoding(false));
        }
        string? message = due || !automatic
            ? $"WinCode 审计日志当前 {bytes / 1048576.0:F3} MiB，建议清理。路径：{directory}。提醒阈值 1 MiB，停止阈值 2 MiB。{(blocked ? "新的 UI 取证已暂停；不会自动删除日志。" : "请确认保留所需证据后再清理。")}" : null;
        return new AuditNotice(directory, bytes, WarningBytes, StopBytes, blocked, message);
    }

    private static string? CanonicalHandle(string? handle)
    {
        if (string.IsNullOrWhiteSpace(handle) || handle.Length > 24) return null;
        try { return "0x" + (handle.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? Convert.ToInt64(handle[2..], 16) : Convert.ToInt64(handle)).ToString("X"); }
        catch { return null; }
    }
    private static byte[] Encode(object value) => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value) + "\n");
    private void Append(byte[] bytes)
    {
        using var stream = new FileStream(Path.Combine(directory, LogName), FileMode.Append, FileAccess.Write, FileShare.Read);
        stream.Write(bytes); stream.Flush(true); // Start is durable before any target UI read.
    }

    private static long Measure(string directory)
    {
        if (!System.IO.Directory.Exists(directory)) return 0;
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new AuditException("AUDIT_UNAVAILABLE", "Audit directory must not be a link.");
        long total = 0; int count = 0;
        foreach (var entry in System.IO.Directory.EnumerateFileSystemEntries(directory))
        {
            // This dedicated directory contains flat metadata files only. Unexpected trees/links
            // are rejected rather than followed or scanned without a bound.
            if (++count > 128 || (File.GetAttributes(entry) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw new AuditException("AUDIT_UNAVAILABLE", "Audit directory contains unexpected directories, links or too many files.");
            var length = new FileInfo(entry).Length;
            if (Path.GetFileName(entry) == StateName && length != 32)
                throw new AuditException("AUDIT_UNAVAILABLE", "Invalid audit notification state file.");
            total = checked(total + length);
        }
        return total;
    }

    public void Dispose()
    {
        if (!owned) return;
        owned = false; gate.ReleaseMutex(); gate.Dispose();
    }
}
