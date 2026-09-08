using System.Drawing;

namespace WinCode.UIA.Host;

public sealed record CaptureQualityResult(string Status, int SampleCount, int? MaxChannelRange, string Message);

/// <summary>A bounded hint on raw pixels, not a blank-image or usability verdict.</summary>
public static class CaptureQuality
{
    public static CaptureQualityResult Inspect(Bitmap bitmap, CancellationToken token = default)
    {
        token.ThrowIfCancellationRequested();
        var samples = 0;
        try
        {
            var columns = Math.Min(32, bitmap.Width);
            var rows = Math.Min(32, bitmap.Height);
            var minR = 255; var minG = 255; var minB = 255;
            var maxR = 0; var maxG = 0; var maxB = 0;
            for (var row = 0; row < rows; row++)
            {
                token.ThrowIfCancellationRequested();
                var y = rows == 1 ? 0 : (int)((long)row * (bitmap.Height - 1) / (rows - 1));
                for (var column = 0; column < columns; column++)
                {
                    var x = columns == 1 ? 0 : (int)((long)column * (bitmap.Width - 1) / (columns - 1));
                    var color = bitmap.GetPixel(x, y);
                    minR = Math.Min(minR, color.R); maxR = Math.Max(maxR, color.R);
                    minG = Math.Min(minG, color.G); maxG = Math.Max(maxG, color.G);
                    minB = Math.Min(minB, color.B); maxB = Math.Max(maxB, color.B);
                    samples++;
                }
            }
            var range = Math.Max(maxR - minR, Math.Max(maxG - minG, maxB - minB));
            return range <= 3
                ? new("suspect-low-variation", samples, range,
                    "Raw capture has little sampled color variation. It may be blank or a legitimate uniform/low-contrast view; retain UIA evidence and inspect the image before drawing visual conclusions.")
                : new("unknown", samples, range,
                    "Sampled pixels vary; this does not establish that the image is usable or belongs to the expected rendering state.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new("unknown", samples, null, "Raw-pixel quality sampling was unavailable; visual usability is unverified.");
        }
    }
}
