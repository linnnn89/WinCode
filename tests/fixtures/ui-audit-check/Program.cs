using System.Diagnostics;
using System.Text.Json;
using WinCode.UIA.Host;

if (args.Length == 2 && args[0] == "busy")
{
    try { using var unexpected = UiAudit.Start(1, null, null, "inspect", args[1]); Environment.Exit(2); }
    catch (AuditException error) { Environment.Exit(error.Code == "AUDIT_BUSY" ? 0 : 3); }
    return;
}
var root = Path.GetFullPath(args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "wincode-audit-" + Guid.NewGuid().ToString("N")));
Directory.CreateDirectory(root);
int passed = 0;
void Check(bool condition, string name) { if (!condition) throw new Exception(name); passed++; Console.WriteLine("PASS " + name); }
string Folder(string name) { var result = Path.Combine(root, name); Directory.CreateDirectory(result); return result; }
void Fill(string folder, long size) { using var file = File.Create(Path.Combine(folder, "padding.bin")); file.SetLength(size); }

var tiny = Folder("tiny");
using (var audit = UiAudit.Start(123, "0x123", "original", "inspect", tiny))
    Check(audit.Finish(true, null, true) == null, "no warning below threshold");
var lines = File.ReadAllLines(Path.Combine(tiny, "access.jsonl"));
Check(lines.Length == 2, "paired start/end records");
Check(new FileInfo(Path.Combine(tiny, "access.jsonl")).Length < 512, "minimal record pair below 512 bytes");
var start = JsonDocument.Parse(lines[0]).RootElement;
var end = JsonDocument.Parse(lines[1]).RootElement;
Check(start.GetProperty("id").GetString() == end.GetProperty("id").GetString(), "correlation ID preserved");
Check(!lines.Any(s => s.Contains("title") || s.Contains("base64") || s.Contains("screenshot") || s.Contains("errorMessage")), "no UI content fields");

var warning = Folder("warning"); Fill(warning, UiAudit.WarningBytes);
using (var audit = UiAudit.Start(1, null, "none", "inspect", warning))
{
    var notice = audit.Finish(false, "WINDOW_NOT_FOUND", true);
    Check(notice?.Message?.Contains(warning) == true && !notice.Blocked, "warning includes exact path and capacity");
}
using (var audit = UiAudit.Start(1, null, "none", "inspect", warning))
    Check(audit.Finish(true, null, true)?.Message == null, "automatic reminder cooldown");
Check(UiAudit.Check(warning).Message != null, "explicit check always reports current warning");

var full = Folder("full"); Fill(full, UiAudit.StopBytes - 100);
try { using var audit = UiAudit.Start(1, null, null, "inspect", full); throw new Exception("capacity was not enforced"); }
catch (AuditException error) { Check(error.Code == "AUDIT_LIMIT_REACHED" && error.Notice?.Blocked == true, "reserve end record before access"); }
Check(!File.Exists(Path.Combine(full, "access.jsonl")), "blocked request writes no growing log");
Check(new FileInfo(Path.Combine(full, "padding.bin")).Length == UiAudit.StopBytes - 100, "no automatic deletion");

var unknown = Folder("unknown");
using (var abandoned = UiAudit.Start(1, null, null, "inspect", unknown)) { }
Check(File.ReadAllLines(Path.Combine(unknown, "access.jsonl")).Length == 1, "incomplete access remains start-only evidence");

var unwritable = Folder("unwritable");
var lockedLog = Path.Combine(unwritable, "access.jsonl");
File.WriteAllText(lockedLog, ""); File.SetAttributes(lockedLog, FileAttributes.ReadOnly);
try
{
    try { using var audit = UiAudit.Start(1, null, null, "inspect", unwritable); throw new Exception("unwritable audit accepted"); }
    catch (AuditException error) { Check(error.Code == "AUDIT_UNAVAILABLE", "start write failure refuses access"); }
}
finally { File.SetAttributes(lockedLog, FileAttributes.Normal); }

var endFailure = Folder("end-failure");
using (var active = UiAudit.Start(1, null, null, "inspect", endFailure))
{
    Fill(endFailure, UiAudit.StopBytes); // Simulate another application consuming the reserved disk budget.
    try { active.Finish(true, null, true); throw new Exception("completion overflow accepted"); }
    catch (AuditException error) { Check(error.Code == "AUDIT_LIMIT_REACHED", "completion failure is explicit"); }
}
Check(File.ReadAllLines(Path.Combine(endFailure, "access.jsonl")).Length == 1, "failed completion does not fabricate success");

var parallel = Folder("parallel");
using (var active = UiAudit.Start(1, null, null, "inspect", parallel))
{
    var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
    if (Path.GetFileNameWithoutExtension(Environment.ProcessPath!).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
        info.ArgumentList.Add(typeof(UiAudit).Assembly.Location);
    info.ArgumentList.Add("busy"); info.ArgumentList.Add(parallel);
    using var child = Process.Start(info)!;
    Check(child.WaitForExit(5000) && child.ExitCode == 0, "cross-process lock rejects concurrent audit");
    active.Finish(true, null, true);
}

var invalid = Folder("invalid"); Directory.CreateDirectory(Path.Combine(invalid, "unexpected"));
try { using var audit = UiAudit.Start(1, null, null, "inspect", invalid); throw new Exception("unexpected tree accepted"); }
catch (AuditException error) { Check(error.Code == "AUDIT_UNAVAILABLE", "bounded flat-directory scan rejects unexpected tree"); }
Console.WriteLine(JsonSerializer.Serialize(new { passed, root }));
