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

namespace WinCode.UIA.Host;

/// <summary>同一协议的 JSON 选项；入口和树预算计算必须一致。</summary>
internal static class HostJson
{
    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };
}

public class InspectRequest
{
    public UiQueryDto? Query { get; set; }
    public bool ReadStates { get; set; }
    public bool BackgroundOnly { get; set; }
    public string? ProcessName { get; set; }
    public string? TitleContains { get; set; }
    public int? MaxWindows { get; set; }
    public string? SchemaVersion { get; set; }
    public string? RequestId { get; set; }
    public string? Action { get; set; } // "inspect" | "health" | "ping"
    public int Pid { get; set; }
    public string? Hwnd { get; set; }
    public string? Capture { get; set; } // "none" | "original" | "annotated"
    public int? MaxDepth { get; set; }
    public int? MaxNodes { get; set; }
    public int? TimeoutMs { get; set; }
}

public sealed record HostBuildIdentity(string Version, string? InformationalVersion, string? Configuration, string Framework)
{
    public static HostBuildIdentity Current { get; } = new(
        typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "unknown",
        typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
        typeof(Program).Assembly.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration,
        RuntimeInformation.FrameworkDescription);
}

public class InspectResponse
{
    public HostBuildIdentity HostIdentity { get; } = HostBuildIdentity.Current;
    public int InspectionVersion { get; set; } = 2;
    public long? HelperPeakWorkingSetBytes { get; set; }
    public QueryResultDto? QueryResult { get; set; }
    public bool? TreeComplete { get; set; }
    public int? TraversalErrors { get; set; }
    public int? PropertyIssueCount { get; set; }
    public AuditNotice? AuditNotice { get; set; }
    public bool? BackgroundOnly { get; set; }
    public List<CandidateWindowDto>? Windows { get; set; }
    public string? CapturedAt { get; set; }
    public bool? EnumerationComplete { get; set; }
    public string SchemaVersion { get; set; } = "1.0";
    public string ProtocolVersion { get; set; } = "1.0";
    public string? RequestId { get; set; }
    public bool Success { get; set; }
    public string? Action { get; set; }
    public string? Status { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public int? Pid { get; set; }
    public string? Hwnd { get; set; }
    public RectDto? CaptureOrigin { get; set; }
    public string? CaptureMethod { get; set; }
    public CaptureQualityResult? CaptureQuality { get; set; }
    public int? ImageWidth { get; set; }
    public int? ImageHeight { get; set; }
    public double? ImageScale { get; set; }
    public bool? ImageOmitted { get; set; }
    public string? ImageOmittedReason { get; set; }
    public UiNodeDto? Tree { get; set; }
    public int? TotalNodes { get; set; }
    public int? MaxDepthReached { get; set; }
    public bool? Truncated { get; set; }
    public string? TruncateReason { get; set; }
    public string? ScreenshotPngBase64 { get; set; }
    public string? AnnotatedPngBase64 { get; set; }
    public List<CandidateWindowDto>? CandidateWindows { get; set; }
}

public class UiNodeDto
{
    public List<string>? PropertyIssues { get; set; }
    public UiStatesDto? States { get; set; }
    public int Id { get; set; }
    public int? ParentId { get; set; }
    public string? AutomationId { get; set; }
    public string? Name { get; set; }
    public string? ControlType { get; set; }
    public string? ClassName { get; set; }
    public RectDto? Bounds { get; set; }
    public RectDto? RelativeBounds { get; set; }
    public bool? IsEnabled { get; set; }
    public bool? IsOffscreen { get; set; }
    public List<UiNodeDto> Children { get; set; } = new();
}

public class RectDto
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }

    public RectDto() { }

    public RectDto(int x, int y, int width, int height)
    {
        X = x;
        Y = y;
        Width = width;
        Height = height;
    }
}

public class CandidateWindowDto
{
    public bool? TitleTruncated { get; set; }
    public int? Pid { get; set; }
    public string? ProcessName { get; set; }
    public string? ProcessNameStatus { get; set; }
    public string Hwnd { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string ClassName { get; set; } = string.Empty;
    public RectDto Bounds { get; set; } = null!;
    public bool IsIconic { get; set; }
}


public class UiQueryDto {
    public string? AutomationId { get; set; }
    public string? Name { get; set; }
    public string? ControlType { get; set; }
    public int? MaxSearchNodes { get; set; }
    public int? MaxMatches { get; set; }
}
public class QueryResultDto {
    public string Status { get; set; } = "incomplete";
    public bool SearchComplete { get; set; }
    public int VisitedNodes { get; set; }
    public string? Reason { get; set; }
    public List<UiNodeDto> Matches { get; set; } = new();
}
public class UiStatesDto {
    public string Toggle { get; set; } = "unknown";
    public string Selection { get; set; } = "unknown";
    public string ExpandCollapse { get; set; } = "unknown";
}
