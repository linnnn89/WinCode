using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

namespace WinCode.UIA.Host;

public static class Program
{
    private static UiAudit? currentAudit;
    private static bool indicatorDisplayed;
    private static bool desktopNotice;
    private static string? desktopMessage;
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr owner, string text, string title, uint flags);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public int Width => Right - Left;
        public int Height => Bottom - Top;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiFlag);

    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

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

    private static InspectResponse ListWindows(InspectRequest request)
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

    private static UiNodeDto? TraverseElement(
        AutomationElement element,
        ITreeWalker walker,
        int? parentId,
        int currentDepth,
        TraversalContext context)
    {
        context.CancellationToken.ThrowIfCancellationRequested();

        if (context.TotalCount >= context.MaxNodes)
        {
            context.Truncated = true;
            context.TruncateReason ??= "maxNodes";
            return null;
        }

        var nodeId = ++context.CurrentId;
        context.TotalCount++;
        if (currentDepth > context.MaxDepthReached)
        {
            context.MaxDepthReached = currentDepth;
        }

        var node = ReadElementProperties(element, nodeId, parentId, context.CaptureOrigin, context.ReadStates);
        context.CollectedNodes.Add(node);

        try
        {
            var child = walker.GetFirstChild(element);
            if (currentDepth >= context.MaxDepth) {
                if (child != null) { context.Truncated = true; context.TruncateReason ??= "maxDepth"; }
                return node;
            }
            while (child != null && context.TotalCount < context.MaxNodes)
            {
                var childNode = TraverseElement(child, walker, nodeId, currentDepth + 1, context);
                if (childNode != null)
                {
                    node.Children.Add(childNode);
                }
                child = walker.GetNextSibling(child);
            }

            if (child != null && context.TotalCount >= context.MaxNodes)
            {
                context.Truncated = true;
                context.TruncateReason ??= "maxNodes";
            }
        }
        catch (OperationCanceledException) { throw; }
        catch {
            context.TraversalErrors++;
            context.Truncated = true;
            context.TruncateReason ??= "enumerationFailed";
        }

        return node;
    }

    private static bool ValidQuery(UiQueryDto? query) {
        if (query == null) return true;
        var values = new[] { query.AutomationId, query.Name, query.ControlType };
        return values.Any(v => v != null) && values.All(v => v == null ||
            (!string.IsNullOrWhiteSpace(v) && v.Length <= 256 && !v.Any(c => c < 32))) &&
            (query.MaxSearchNodes == null || query.MaxSearchNodes is >= 1 and <= 5000) &&
            (query.MaxMatches == null || query.MaxMatches is >= 1 and <= 20);
    }

    private static bool? MatchesQuery(AutomationElement element, UiQueryDto query) {
        bool unknown = false;
        bool Test<T>(IAutomationProperty<T> property, string? expected) {
            if (expected == null) return true;
            try {
                // FlaUI false means unsupported, not a failed read: no literal value can match.
                if (!property.TryGetValue(out var value)) return false;
                return string.Equals(value?.ToString(), expected, StringComparison.Ordinal);
            } catch (OperationCanceledException) { throw; }
            catch { unknown = true; return true; }
        }
        if (!Test(element.Properties.AutomationId, query.AutomationId) ||
            !Test(element.Properties.Name, query.Name) || !Test(element.Properties.ControlType, query.ControlType)) return false;
        return unknown ? null : true;
    }

    private static UiNodeDto ReadElementProperties(AutomationElement element, int id, int? parentId,
        RectDto captureOrigin, bool readStates = false)
    {
        var issues = new List<string>();
        var node = new UiNodeDto { Id = id, ParentId = parentId };
        // Unavailable values stay absent; a provider's default false is not evidence.
        void Read<T>(string name, IAutomationProperty<T> property, Action<T> assign) =>
            UiPropertyEvidence.Read(name, property, assign, issues);
        string? Clip(string? value, string name) {
            if (value?.Length > 256) { issues.Add(name + ":truncated"); return value[..256]; }
            return value;
        }
        Read("name", element.Properties.Name, v => node.Name = Clip(v, "name"));
        Read("automationId", element.Properties.AutomationId, v => node.AutomationId = Clip(v, "automationId"));
        Read("className", element.Properties.ClassName, v => node.ClassName = Clip(v, "className"));
        Read("controlType", element.Properties.ControlType, v => node.ControlType = v.ToString());
        Read("isEnabled", element.Properties.IsEnabled, v => node.IsEnabled = v);
        Read("isOffscreen", element.Properties.IsOffscreen, v => node.IsOffscreen = v);
        Read("bounds", element.Properties.BoundingRectangle, rect => {
            node.Bounds = new RectDto(rect.X, rect.Y, rect.Width, rect.Height);
            node.RelativeBounds = new RectDto(rect.X - captureOrigin.X, rect.Y - captureOrigin.Y, rect.Width, rect.Height);
        });
        if (readStates) {
            // Only read pattern state; never invoke actions or fetch input values.
            string State(Func<string> read) {
                try { return read(); }
                catch (OperationCanceledException) { throw; }
                catch { return "unknown"; }
            }
            node.States = new UiStatesDto {
                Toggle = State(() => element.Patterns.Toggle.PatternOrDefault?.ToggleState.Value.ToString() ?? "unsupported"),
                Selection = State(() => element.Patterns.SelectionItem.PatternOrDefault is { } p ?
                    (p.IsSelected.Value ? "selected" : "not-selected") : "unsupported"),
                ExpandCollapse = State(() => element.Patterns.ExpandCollapse.PatternOrDefault?.ExpandCollapseState.Value.ToString() ?? "unsupported")
            };
        }
        node.PropertyIssues = issues.Count == 0 ? null : issues;
        return node;
    }

    private static RECT GetWindowPhysicalRect(IntPtr hwnd)
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

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);

    private const uint PW_RENDERFULLCONTENT = 2;
    private const int SRCCOPY = 0x00CC0020;

    private const long MaxCapturePixels = 16 * 1024 * 1024; // 64 MiB raw 32bpp bitmap, not total process RSS.
    private static (Bitmap? Bitmap, string? Method, string? Reason) CaptureWindowArea(IntPtr hwnd, RECT rect, bool backgroundOnly)
    {
        if (rect.Width <= 0 || rect.Height <= 0) return (null, null, "Invalid capture dimensions.");
        // PNG size is known only after allocation/encoding. Bound raw pixels first and keep
        // the already collected UI tree when a huge window cannot be captured within budget.
        if (rect.Width > 16384 || rect.Height > 16384 || (long)rect.Width * rect.Height > MaxCapturePixels)
            return (null, null, "Raw screenshot exceeds 16777216 pixels or 16384px dimension limit.");

        Bitmap? bmp = null;
        try
        {
            bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppRgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Black);

                // Window-directed capture does not require foreground activation. Success is not
                // proof of usable pixels: rendering support depends on the target application.
                if (hwnd != IntPtr.Zero && IsWindow(hwnd))
                {
                    var hdc = g.GetHdc();
                    try
                    {
                        if (PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT))
                        {
                            return (bmp, "printWindowDwm", null);
                        }

                        if (PrintWindow(hwnd, hdc, 0))
                        {
                            return (bmp, "printWindow", null);
                        }
                    }
                    finally
                    {
                        g.ReleaseHdc(hdc);
                    }
                }

                // A covered screen region belongs to the foreground application (e.g. a game).
                // Fail closed before any screen DC is read; never label those pixels as the target.
                if (backgroundOnly) { g.Dispose(); bmp.Dispose(); return (null, null, null); }

                // Priority 2: BitBlt from screen DC
                var hdcDest = g.GetHdc();
                var hdcSrc = GetDC(IntPtr.Zero);
                try
                {
                    if (hdcSrc != IntPtr.Zero)
                    {
                        if (BitBlt(hdcDest, 0, 0, rect.Width, rect.Height, hdcSrc, rect.Left, rect.Top, SRCCOPY))
                        {
                            return (bmp, "bitBltScreen", null);
                        }
                    }
                }
                finally
                {
                    if (hdcSrc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, hdcSrc);
                    g.ReleaseHdc(hdcDest);
                }

                // Priority 3: CopyFromScreen fallback with 32bppRgb
                try
                {
                    g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(rect.Width, rect.Height), CopyPixelOperation.SourceCopy);
                    return (bmp, "copyFromScreen", null);
                }
                catch
                {
                    // If all fallbacks fail, continue to return null
                }
            }

            bmp.Dispose();
            return (null, null, null);
        }
        catch
        {
            bmp?.Dispose();
            return (null, null, null);
        }
    }

    private static void DrawAnnotations(Bitmap bmp, List<UiNodeDto> nodes, RectDto captureOrigin)
    {
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;

        var fontScale = Math.Clamp(bmp.Height / 600f, 0.8f, 2.0f);
        using var font = new Font(FontFamily.GenericSansSerif, 9f * fontScale, FontStyle.Bold);
        using var rectPen = new Pen(Color.FromArgb(220, 255, 69, 0), 2f);
        using var badgeBgBrush = new SolidBrush(Color.FromArgb(230, 20, 20, 20));
        using var badgeBorderPen = new Pen(Color.FromArgb(255, 255, 215, 0), 1.5f);
        using var textBrush = new SolidBrush(Color.White);

        foreach (var node in nodes)
        {
            if (node.Bounds == null || node.RelativeBounds == null) continue;
            if (node.Bounds.Width <= 2 || node.Bounds.Height <= 2) continue;
            if (node.IsOffscreen == true) continue;

            var rx = node.RelativeBounds.X;
            var ry = node.RelativeBounds.Y;
            var rw = node.RelativeBounds.Width;
            var rh = node.RelativeBounds.Height;

            // Check if within bitmap boundaries
            if (rx + rw <= 0 || ry + rh <= 0 || rx >= bmp.Width || ry >= bmp.Height) continue;

            // Draw bounding box
            g.DrawRectangle(rectPen, rx, ry, rw, rh);

            // Draw badge
            var badgeText = $"#{node.Id}";
            var textSize = g.MeasureString(badgeText, font);
            var badgeW = textSize.Width + 4;
            var badgeH = textSize.Height + 2;

            var badgeX = Math.Clamp(rx, 0, Math.Max(0, bmp.Width - (int)badgeW));
            var badgeY = Math.Clamp(ry, 0, Math.Max(0, bmp.Height - (int)badgeH));

            g.FillRectangle(badgeBgBrush, badgeX, badgeY, badgeW, badgeH);
            g.DrawRectangle(badgeBorderPen, badgeX, badgeY, badgeW, badgeH);
            g.DrawString(badgeText, font, textBrush, badgeX + 2, badgeY + 1);
        }
    }

    private const int MaxImageBytes = 2 * 1024 * 1024; // 2 MiB
    private const int MaxTextJsonBytes = 128 * 1024;    // 128 KiB

    private static (string? base64, int? width, int? height, double? scale, bool omitted, string? reason) ProcessImageWithBudget(Bitmap originalBitmap)
    {
        double[] scaleFactors = [1.0, 0.75, 0.5, 0.25];
        foreach (var factor in scaleFactors)
        {
            int targetW = Math.Max(1, (int)(originalBitmap.Width * factor));
            int targetH = Math.Max(1, (int)(originalBitmap.Height * factor));

            using var memoryStream = new MemoryStream();
            if (Math.Abs(factor - 1.0) < 0.001)
            {
                originalBitmap.Save(memoryStream, ImageFormat.Png);
            }
            else
            {
                using var scaledBmp = new Bitmap(targetW, targetH, PixelFormat.Format32bppArgb);
                using var g = Graphics.FromImage(scaledBmp);
                g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(originalBitmap, new Rectangle(0, 0, targetW, targetH));
                scaledBmp.Save(memoryStream, ImageFormat.Png);
            }

            // Check length before copying; GetBuffer avoids an extra PNG-sized byte array.
            if (memoryStream.Length <= MaxImageBytes)
            {
                return (
                    Convert.ToBase64String(memoryStream.GetBuffer(), 0, (int)memoryStream.Length),
                    targetW,
                    targetH,
                    factor,
                    false,
                    null
                );
            }
        }

        return (
            null,
            originalBitmap.Width,
            originalBitmap.Height,
            1.0,
            true,
            $"Screenshot PNG size exceeds 2MiB limit even after scaling (original: {originalBitmap.Width}x{originalBitmap.Height})."
        );
    }

    private static void EnforceTreeJsonBudget(UiNodeDto root, int maxBytes, TraversalContext context)
    {
        bool fieldsTrimmed = LimitNodeText(root);
        int currentMaxDepth = context.MaxDepthReached;
        bool trimmed = fieldsTrimmed;
        while (currentMaxDepth > 1 && JsonSerializer.SerializeToUtf8Bytes(root, JsonOptions).Length > maxBytes)
        {
            PruneAtDepth(root, currentMaxDepth);
            currentMaxDepth--;
            trimmed = true;
        }
        if (trimmed)
        {
            context.Truncated = true;
            context.TruncateReason = "budgetLimit";
        }
        context.CollectedNodes.Clear();
        context.MaxDepthReached = 0;
        CollectRetained(root, 1, context);
        context.TotalCount = context.CollectedNodes.Count;
    }

    private static bool LimitNodeText(UiNodeDto node)
    {
        bool trimmed = false;
        string? Limit(string? text)
        {
            if (text == null || text.Length <= 256) return text;
            trimmed = true;
            return text[..256];
        }
        node.Name = Limit(node.Name);
        node.AutomationId = Limit(node.AutomationId);
        node.ClassName = Limit(node.ClassName);
        node.ControlType = Limit(node.ControlType);
        foreach (var child in node.Children) trimmed |= LimitNodeText(child);
        return trimmed;
    }

    private static void CollectRetained(UiNodeDto node, int depth, TraversalContext context)
    {
        context.CollectedNodes.Add(node);
        context.MaxDepthReached = Math.Max(context.MaxDepthReached, depth);
        foreach (var child in node.Children) CollectRetained(child, depth + 1, context);
    }

    private static void PruneAtDepth(UiNodeDto node, int targetDepth, int depth = 1)
    {
        if (depth == targetDepth - 1)
        {
            node.Children.Clear();
            return;
        }
        foreach (var child in node.Children)
        {
            PruneAtDepth(child, targetDepth, depth + 1);
        }
    }

    private static IntPtr ResolveTargetWindow(
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

    private class TraversalContext
    {
        public int CurrentId { get; set; }
        public int TotalCount { get; set; }
        public int TraversalErrors { get; set; }
        public bool ReadStates { get; set; }
        public int MaxDepth { get; set; }
        public int MaxNodes { get; set; }
        public int MaxDepthReached { get; set; }
        public bool Truncated { get; set; }
        public string? TruncateReason { get; set; }
        public RectDto CaptureOrigin { get; set; } = null!;
        public CancellationToken CancellationToken { get; set; }
        public List<UiNodeDto> CollectedNodes { get; } = new();
    }
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

public class InspectResponse
{
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
