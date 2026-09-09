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
using static WinCode.UIA.Host.WindowResolver;
using static WinCode.UIA.Host.WindowCapture;
using static WinCode.UIA.Host.UiTreeReader;
using static WinCode.UIA.Host.HostJson;

namespace WinCode.UIA.Host;

public static class Program
{
    private static UiAudit? currentAudit;
    private static bool indicatorDisplayed;
    private static bool desktopNotice;
    private static string? desktopMessage;
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr owner, string text, string title, uint flags);

    public static void Main(string[] args)
    {
        try
        {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        catch { /* Fallback on older OS versions */ }

        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);

        InspectRequest? request = null;
        try
        {
            desktopNotice = args.Contains("--desktop-notice");
            if (args.Contains("--audit-check"))
            {
                // Directory override is read-only and only available to the explicit checker.
                int directoryIndex = Array.IndexOf(args, "--audit-directory");
                var directory = directoryIndex >= 0 && directoryIndex + 1 < args.Length ? args[directoryIndex + 1] : null;
                WriteSuccessResponse(null, new InspectResponse { Success = true, Action = "auditCheck", AuditNotice = UiAudit.Check(directory) });
                return;
            }
            var input = Console.In.ReadToEnd();
            if (string.IsNullOrWhiteSpace(input))
            {
                WriteErrorResponse(null, "EMPTY_INPUT", "No input received via stdin.");
                return;
            }

            request = JsonSerializer.Deserialize<InspectRequest>(input, JsonOptions);
            if (request == null)
            {
                WriteErrorResponse(null, "INVALID_JSON", "Failed to parse input JSON.");
                return;
            }

            if (request.Action == "health" || request.Action == "ping")
            {
                WriteSuccessResponse(request.RequestId, new InspectResponse
                {
                    SchemaVersion = "1.0",
                    RequestId = request.RequestId,
                    Success = true,
                    Action = request.Action,
                    Status = "healthy"
                });
                return;
            }

            if (request.Action == "listWindows")
            {
                currentAudit = UiAudit.Start(request.Pid, request.Hwnd, "none", "listWindows");
                using var notice = RecordingIndicator.Show();
                indicatorDisplayed = true;
                WriteSuccessResponse(request.RequestId, ListWindows(request));
                return;
            }

            if (request.Pid <= 0 && string.IsNullOrWhiteSpace(request.Hwnd))
            {
                WriteErrorResponse(request.RequestId, "INVALID_ARGUMENT", "Either 'pid' or 'hwnd' must be provided.");
                return;
            }
            if (request.BackgroundOnly && (request.Pid <= 0 || string.IsNullOrWhiteSpace(request.Hwnd)))
            {
                WriteErrorResponse(request.RequestId, "INVALID_ARGUMENT", "backgroundOnly requires explicit pid and hwnd.");
                return;
            }

            if (!ValidQuery(request.Query)) {
                WriteErrorResponse(request.RequestId, "INVALID_ARGUMENT", "Invalid query filters or budgets.");
                return;
            }
            var timeoutMs = request.TimeoutMs is > 0 ? request.TimeoutMs.Value : 10000;
            currentAudit = UiAudit.Start(request.Pid, request.Hwnd, request.Capture, "inspect");
            using var cts = new CancellationTokenSource(timeoutMs);
            using var recordingNotice = RecordingIndicator.Show();
            indicatorDisplayed = true;

            var result = ExecuteInspect(request, cts.Token);
            WriteSuccessResponse(request.RequestId, result);
        }
        catch (AuditException error)
        {
            WriteSuccessResponse(request?.RequestId, new InspectResponse { Success = false,
                ErrorCode = error.Code, ErrorMessage = error.Message, AuditNotice = error.Notice });
        }
        catch (OperationCanceledException)
        {
            WriteErrorResponse(request?.RequestId, "TIMEOUT", "UI inspection timed out.");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[WinCode.UIA.Host] Unhandled exception: {ex}");
            WriteErrorResponse(request?.RequestId, "HOST_ERROR", ex.Message);
        }
        finally
        {
            currentAudit?.Dispose();
            // All recording indicators have left their scopes before a desktop cleanup prompt.
            if (desktopNotice && desktopMessage != null)
                MessageBox(IntPtr.Zero, desktopMessage, "WinCode 日志清理提醒", 0x40);
        }
    }

    private static InspectResponse ExecuteInspect(InspectRequest request, CancellationToken ct)
    {
        var targetHwnd = ResolveTargetWindow(request, out var resolvedPid, out var candidateWindows, out var resolveError);
        if (targetHwnd == IntPtr.Zero)
        {
            return new InspectResponse
            {
                SchemaVersion = "1.0",
                RequestId = request.RequestId,
                Success = false,
                ErrorCode = resolveError ?? "WINDOW_NOT_FOUND",
                ErrorMessage = $"Could not resolve target window for PID {request.Pid} / HWND {request.Hwnd}.",
                CandidateWindows = candidateWindows
            };
        }

        if (IsIconic(targetHwnd))
        {
            return new InspectResponse
            {
                SchemaVersion = "1.0",
                RequestId = request.RequestId,
                Success = false,
                ErrorCode = "WINDOW_MINIMIZED",
                ErrorMessage = "Target window is minimized and cannot be captured."
            };
        }

        var captureRect = GetWindowPhysicalRect(targetHwnd);
        if (captureRect.Width <= 0 || captureRect.Height <= 0)
        {
            return new InspectResponse
            {
                SchemaVersion = "1.0",
                RequestId = request.RequestId,
                Success = false,
                ErrorCode = "WINDOW_EMPTY_BOUNDS",
                ErrorMessage = "Target window has empty or zero bounds."
            };
        }

        var captureOrigin = new RectDto(captureRect.Left, captureRect.Top, captureRect.Width, captureRect.Height);

        using var automation = new UIA3Automation();
        var rootElement = automation.FromHandle(targetHwnd);
        if (rootElement == null)
        {
            return new InspectResponse
            {
                SchemaVersion = "1.0",
                RequestId = request.RequestId,
                Success = false,
                ErrorCode = "UIA_ELEMENT_NOT_AVAILABLE",
                ErrorMessage = "Unable to create UIA AutomationElement from target window handle."
            };
        }

        var maxDepth = request.MaxDepth is > 0 ? request.MaxDepth.Value : 6;
        var maxNodes = request.MaxNodes is > 0 ? request.MaxNodes.Value : 300;

        var context = new TraversalContext
        {
            MaxDepth = maxDepth,
            MaxNodes = maxNodes,
            CaptureOrigin = captureOrigin,
            CancellationToken = ct,
            ReadStates = request.ReadStates
        };

        var walker = automation.TreeWalkerFactory.GetControlViewWalker();
        QueryResultDto? queryResult = null;
        AutomationElement? selected = rootElement;
        if (request.Query is { } query) {
            var search = new BoundedUiSearch<AutomationElement>();
            search.Run(rootElement, walker.GetFirstChild, walker.GetNextSibling,
                element => MatchesQuery(element, query), query.MaxSearchNodes ?? 1000, query.MaxMatches ?? 10, ct);
            queryResult = new QueryResultDto {
                SearchComplete = search.Complete, VisitedNodes = search.Visited, Reason = search.Reason,
                Status = search.Matches.Count > 1 ? "ambiguous" : !search.Complete ? "incomplete" : search.Matches.Count == 0 ? "not-found" : "unique"
            };
            int candidateId = 0;
            foreach (var match in search.Matches)
                queryResult.Matches.Add(ReadElementProperties(match, ++candidateId, null, captureOrigin, request.ReadStates));
            // No guess from the first hit: uniqueness requires a complete bounded search.
            selected = search.Complete && search.Matches.Count == 1 ? search.Matches[0] : null;
        }
        var rootNode = selected == null ? null : TraverseElement(selected, walker, null, 1, context);

        ct.ThrowIfCancellationRequested();
        if (rootNode != null)
        {
            // Reserve room for the response envelope; annotate only retained nodes.
            EnforceTreeJsonBudget(rootNode, MaxTextJsonBytes - 8 * 1024 -
                (queryResult == null ? 0 : JsonSerializer.SerializeToUtf8Bytes(queryResult, JsonOptions).Length), context);
        }

        var captureMode = (request.Capture ?? "none").ToLowerInvariant();
        string? screenshotBase64 = null;
        string? annotatedBase64 = null;
        string? captureMethod = null;
        CaptureQualityResult? captureQuality = null;
        int? imageWidth = null;
        int? imageHeight = null;
        double? imageScale = null;
        bool? imageOmitted = null;
        string? imageOmittedReason = null;

        if (captureMode is "original" or "annotated")
        {
            var capture = CaptureWindowArea(targetHwnd, captureRect, request.BackgroundOnly);
            if (capture.Bitmap != null)
            {
                using var rawBitmap = capture.Bitmap;
                captureMethod = capture.Method;
                // Sample before labels can make a blank raw image appear informative.
                captureQuality = CaptureQuality.Inspect(rawBitmap, ct);
                if (captureMode == "original")
                {
                    var (b64, w, h, scale, omitted, reason) = ProcessImageWithBudget(rawBitmap);
                    screenshotBase64 = b64;
                    imageWidth = w;
                    imageHeight = h;
                    imageScale = scale;
                    imageOmitted = omitted ? true : null;
                    imageOmittedReason = reason;
                }
                else if (captureMode == "annotated")
                {
                    // A request returns either original or annotated, never both. Annotate in
                    // place instead of retaining a second full-resolution bitmap (4 bytes/pixel).
                    DrawAnnotations(rawBitmap, context.CollectedNodes, captureOrigin);
                    var (b64, w, h, scale, omitted, reason) = ProcessImageWithBudget(rawBitmap);
                    annotatedBase64 = b64;
                    imageWidth = w;
                    imageHeight = h;
                    imageScale = scale;
                    imageOmitted = omitted ? true : null;
                    imageOmittedReason = reason;
                }
            }
            else
            {
                imageOmitted = true;
                imageOmittedReason = capture.Reason ?? (request.BackgroundOnly
                    ? "Window capture failed; screen fallback disabled by backgroundOnly."
                    : "Window capture failed.");
            }
        }

        ct.ThrowIfCancellationRequested();
        return new InspectResponse
        {
            SchemaVersion = "1.0",
            ProtocolVersion = "1.0",
            RequestId = request.RequestId,
            Success = true,
            Pid = resolvedPid > 0 ? resolvedPid : request.Pid,
            Hwnd = $"0x{targetHwnd.ToInt64():X}",
            CaptureOrigin = captureOrigin,
            CaptureMethod = captureMethod,
            CaptureQuality = captureQuality,
            BackgroundOnly = request.BackgroundOnly,
            ImageWidth = imageWidth,
            ImageHeight = imageHeight,
            ImageScale = imageScale,
            ImageOmitted = imageOmitted,
            ImageOmittedReason = imageOmittedReason,
            QueryResult = queryResult,
            TreeComplete = rootNode != null ? !context.Truncated && context.TraversalErrors == 0 : null,
            TraversalErrors = context.TraversalErrors,
            PropertyIssueCount = context.CollectedNodes.Sum(n => n.PropertyIssues?.Count ?? 0),
            Tree = rootNode,
            TotalNodes = context.TotalCount,
            MaxDepthReached = context.MaxDepthReached,
            Truncated = context.Truncated,
            TruncateReason = context.TruncateReason,
            ScreenshotPngBase64 = screenshotBase64,
            AnnotatedPngBase64 = annotatedBase64
        };
    }

    private static void WriteSuccessResponse(string? requestId, InspectResponse response)
    {
        if (currentAudit != null)
        {
            var audit = currentAudit;
            currentAudit = null;
            try { response.AuditNotice = audit.Finish(response.Success, response.ErrorCode, indicatorDisplayed); }
            catch (AuditException error) { response.Success = false; response.ErrorCode = error.Code;
                response.ErrorMessage = error.Message; response.AuditNotice = error.Notice; }
        }
        // OS high-water RSS through response preparation, not a hard process memory limit.
        using (var process = Process.GetCurrentProcess()) response.HelperPeakWorkingSetBytes = process.PeakWorkingSet64;
        var json = JsonSerializer.Serialize(response, JsonOptions);
        Console.WriteLine(json);
        Console.Out.Flush();
        // MCP never sets this command-line flag. A desktop wrapper opts in explicitly;
        // cooldown lives in the audit state, and the dialog contains no collected UI content.
        if (desktopNotice && response.AuditNotice?.Message is string message) desktopMessage = message;
    }

    private static void WriteErrorResponse(string? requestId, string errorCode, string errorMessage)
    {
        var response = new InspectResponse
        {
            SchemaVersion = "1.0",
            RequestId = requestId,
            Success = false,
            ErrorCode = errorCode,
            ErrorMessage = errorMessage
        };
        WriteSuccessResponse(requestId, response);
    }

}
