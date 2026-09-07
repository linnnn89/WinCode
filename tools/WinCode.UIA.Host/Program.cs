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

    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
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

            if (request.Pid <= 0 && string.IsNullOrWhiteSpace(request.Hwnd))
            {
                WriteErrorResponse(request.RequestId, "INVALID_ARGUMENT", "Either 'pid' or 'hwnd' must be provided.");
                return;
            }

            var timeoutMs = request.TimeoutMs is > 0 ? request.TimeoutMs.Value : 10000;
            using var cts = new CancellationTokenSource(timeoutMs);

            var result = ExecuteInspect(request, cts.Token);
            WriteSuccessResponse(request.RequestId, result);
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
    }

    private static InspectResponse ExecuteInspect(InspectRequest request, CancellationToken ct)
    {
        var targetHwnd = ResolveTargetWindow(request, out var candidateWindows, out var resolveError);
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
                ErrorMessage = $"Target window has invalid physical bounds: {captureRect.Width}x{captureRect.Height}."
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
            CancellationToken = ct
        };

        var walker = automation.TreeWalkerFactory.GetControlViewWalker();
        var rootNode = TraverseElement(rootElement, walker, null, 1, context);

        var captureMode = (request.Capture ?? "none").ToLowerInvariant();
        string? screenshotBase64 = null;
        string? annotatedBase64 = null;
        string? captureMethod = null;

        if (captureMode is "original" or "annotated")
        {
            var capture = CaptureWindowArea(targetHwnd, captureRect);
            if (capture.Bitmap != null)
            {
                using var rawBitmap = capture.Bitmap;
                captureMethod = capture.Method;
                if (captureMode == "original")
                {
                    screenshotBase64 = BitmapToBase64Png(rawBitmap);
                }
                else if (captureMode == "annotated")
                {
                    using var annotatedBitmap = (Bitmap)rawBitmap.Clone();
                    DrawAnnotations(annotatedBitmap, context.CollectedNodes, captureOrigin);
                    annotatedBase64 = BitmapToBase64Png(annotatedBitmap);
                }
            }
        }

        return new InspectResponse
        {
            SchemaVersion = "1.0",
            ProtocolVersion = "1.0",
            RequestId = request.RequestId,
            Success = true,
            Pid = request.Pid,
            Hwnd = $"0x{targetHwnd.ToInt64():X}",
            CaptureOrigin = captureOrigin,
            CaptureMethod = captureMethod,
            Tree = rootNode,
            TotalNodes = context.TotalCount,
            MaxDepthReached = context.MaxDepthReached,
            Truncated = context.Truncated,
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
            return null;
        }

        var nodeId = ++context.CurrentId;
        context.TotalCount++;
        if (currentDepth > context.MaxDepthReached)
        {
            context.MaxDepthReached = currentDepth;
        }

        var node = ReadElementProperties(element, nodeId, parentId, context.CaptureOrigin);
        context.CollectedNodes.Add(node);

        if (currentDepth >= context.MaxDepth)
        {
            context.Truncated = true;
            return node;
        }

        try
        {
            var child = walker.GetFirstChild(element);
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
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[WinCode.UIA.Host] Child traversal error on node {nodeId}: {ex.Message}");
        }

        return node;
    }

    private static UiNodeDto ReadElementProperties(
        AutomationElement element,
        int id,
        int? parentId,
        RectDto captureOrigin)
    {
        var node = new UiNodeDto
        {
            Id = id,
            ParentId = parentId
        };

        try
        {
            var rawName = element.Properties.Name.ValueOrDefault;
            if (rawName != null && rawName.Length > 256)
            {
                rawName = rawName[..256] + "...";
            }
            node.Name = rawName;
        }
        catch { /* ignore property read failure */ }

        try
        {
            node.AutomationId = element.Properties.AutomationId.ValueOrDefault;
        }
        catch { /* ignore */ }

        try
        {
            node.ControlType = element.Properties.ControlType.ValueOrDefault.ToString();
        }
        catch { /* ignore */ }

        try
        {
            node.ClassName = element.Properties.ClassName.ValueOrDefault;
        }
        catch { /* ignore */ }

        try
        {
            node.IsEnabled = element.Properties.IsEnabled.ValueOrDefault;
        }
        catch { /* ignore */ }

        try
        {
            node.IsOffscreen = element.Properties.IsOffscreen.ValueOrDefault;
        }
        catch { /* ignore */ }

        try
        {
            var rect = element.Properties.BoundingRectangle.ValueOrDefault;
            if (rect != System.Drawing.Rectangle.Empty)
            {
                node.Bounds = new RectDto((int)rect.X, (int)rect.Y, (int)rect.Width, (int)rect.Height);
                node.RelativeBounds = new RectDto(
                    (int)rect.X - captureOrigin.X,
                    (int)rect.Y - captureOrigin.Y,
                    (int)rect.Width,
                    (int)rect.Height);
            }
        }
        catch { /* ignore */ }

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

    private static (Bitmap? Bitmap, string? Method) CaptureWindowArea(IntPtr hwnd, RECT rect)
    {
        if (rect.Width <= 0 || rect.Height <= 0) return (null, null);

        var bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppRgb);
        try
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Black);

                // Priority 1: PrintWindow with PW_RENDERFULLCONTENT (handles WPF hardware acceleration & occlusion)
                if (hwnd != IntPtr.Zero && IsWindow(hwnd))
                {
                    var hdc = g.GetHdc();
                    try
                    {
                        if (PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT))
                        {
                            return (bmp, "printWindowDwm");
                        }

                        if (PrintWindow(hwnd, hdc, 0))
                        {
                            return (bmp, "printWindow");
                        }
                    }
                    finally
                    {
                        g.ReleaseHdc(hdc);
                    }
                }

                // Priority 2: BitBlt from screen DC
                var hdcDest = g.GetHdc();
                var hdcSrc = GetDC(IntPtr.Zero);
                try
                {
                    if (hdcSrc != IntPtr.Zero)
                    {
                        if (BitBlt(hdcDest, 0, 0, rect.Width, rect.Height, hdcSrc, rect.Left, rect.Top, SRCCOPY))
                        {
                            return (bmp, "bitBltScreen");
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
                    return (bmp, "copyFromScreen");
                }
                catch
                {
                    // If all fallbacks fail, continue to return null
                }
            }

            bmp.Dispose();
            return (null, null);
        }
        catch
        {
            bmp.Dispose();
            return (null, null);
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

    private static string BitmapToBase64Png(Bitmap bmp)
    {
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return Convert.ToBase64String(ms.ToArray());
    }

    private static IntPtr ResolveTargetWindow(
        InspectRequest request,
        out List<CandidateWindowDto>? candidates,
        out string? errorCode)
    {
        candidates = null;
        errorCode = null;

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
                    return IntPtr.Zero;
                }
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
        var json = JsonSerializer.Serialize(response, JsonOptions);
        Console.WriteLine(json);
        Console.Out.Flush();
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
        var json = JsonSerializer.Serialize(response, JsonOptions);
        Console.WriteLine(json);
        Console.Out.Flush();
    }

    private class TraversalContext
    {
        public int CurrentId { get; set; }
        public int TotalCount { get; set; }
        public int MaxDepth { get; set; }
        public int MaxNodes { get; set; }
        public int MaxDepthReached { get; set; }
        public bool Truncated { get; set; }
        public RectDto CaptureOrigin { get; set; } = null!;
        public CancellationToken CancellationToken { get; set; }
        public List<UiNodeDto> CollectedNodes { get; } = new();
    }
}

public class InspectRequest
{
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
    public UiNodeDto? Tree { get; set; }
    public int? TotalNodes { get; set; }
    public int? MaxDepthReached { get; set; }
    public bool? Truncated { get; set; }
    public string? ScreenshotPngBase64 { get; set; }
    public string? AnnotatedPngBase64 { get; set; }
    public List<CandidateWindowDto>? CandidateWindows { get; set; }
}

public class UiNodeDto
{
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
    public string Hwnd { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string ClassName { get; set; } = string.Empty;
    public RectDto Bounds { get; set; } = null!;
    public bool IsIconic { get; set; }
}

