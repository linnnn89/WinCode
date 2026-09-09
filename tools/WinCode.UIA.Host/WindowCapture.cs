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

/// <summary>有界截图、标注与图像编码；保留后台取证限制及既有资源释放顺序。</summary>
internal static class WindowCapture
{
    internal const long MaxCapturePixels = 16 * 1024 * 1024; // 64 MiB raw 32bpp bitmap, not total process RSS.
    internal static (Bitmap? Bitmap, string? Method, string? Reason) CaptureWindowArea(IntPtr hwnd, RECT rect, bool backgroundOnly)
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

    internal static void DrawAnnotations(Bitmap bmp, List<UiNodeDto> nodes, RectDto captureOrigin)
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

    internal const int MaxImageBytes = 2 * 1024 * 1024; // 2 MiB
    internal static (string? base64, int? width, int? height, double? scale, bool omitted, string? reason) ProcessImageWithBudget(Bitmap originalBitmap)
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
}
