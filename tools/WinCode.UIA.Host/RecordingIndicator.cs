using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace WinCode.UIA.Host;

/// <summary>Mandatory per-helper notice. No caller switch; no focus, taskbar entry or input interception.</summary>
internal sealed class RecordingIndicator : IDisposable
{
    private readonly ManualResetEventSlim ready = new(false);
    private readonly Thread thread;
    private readonly WndProc procedure;
    private IntPtr window;
    private Exception? failure;
    private bool painted;
    private readonly System.Diagnostics.Stopwatch visible = new();
    private const uint Close = 0x0010;

    private RecordingIndicator()
    {
        procedure = HandleMessage; // Keep native callback alive until the message loop exits.
        thread = new Thread(Run) { IsBackground = true, Name = "WinCoding indicator" };
        thread.Start();
    }

    public static RecordingIndicator Show()
    {
        var indicator = new RecordingIndicator();
        if (!indicator.ready.Wait(1500) || indicator.failure != null || !indicator.painted)
        {
            indicator.Dispose();
            throw new InvalidOperationException("Recording indicator could not be displayed; UI access refused.", indicator.failure);
        }
        return indicator;
    }

    private void Run()
    {
        string className = "WinCoding.Recording." + Environment.ProcessId;
        var instance = GetModuleHandle(null);
        try
        {
            SetThreadDpiAwarenessContext(new IntPtr(-4)); // Dedicated UI thread uses physical screen coordinates.
            var wc = new WindowClass { Procedure = Marshal.GetFunctionPointerForDelegate(procedure), Instance = instance, ClassName = className };
            if (RegisterClass(ref wc) == 0) throw new System.ComponentModel.Win32Exception();
            double scale = Math.Max(1, GetDpiForSystem() / 96.0);
            int width = (int)(112 * scale), height = (int)(64 * scale), margin = (int)(8 * scale);
            // Primary screen's physical upper-right; topmost does not imply visibility over exclusive fullscreen.
            window = CreateWindowEx(0x08000000 | 0x00000080 | 0x00000008 | 0x00000020 | 0x00080000,
                className, "WinCoding Recording", 0x80000000,
                GetSystemMetrics(0) - width - margin, margin, width, height,
                IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
            if (window == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            // Uniform translucency keeps the notice readable while revealing the application beneath.
            if (!SetLayeredWindowAttributes(window, 0, 160, 2)) throw new System.ComponentModel.Win32Exception();
            scale = Math.Max(1, GetDpiForWindow(window) / 96.0);
            width = (int)(112 * scale); height = (int)(64 * scale); margin = (int)(8 * scale);
            if (!SetWindowPos(window, new IntPtr(-1), GetSystemMetrics(0) - width - margin,
                margin, width, height, 0x0010)) throw new System.ComponentModel.Win32Exception();
            ShowWindow(window, 4); // SW_SHOWNOACTIVATE
            UpdateWindow(window);
            if (!painted) throw new InvalidOperationException("Indicator paint did not complete.");
            visible.Start();
            ready.Set();
            while (GetMessage(out var message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }
        catch (Exception error) { failure = error; ready.Set(); }
        finally
        {
            if (window != IntPtr.Zero) DestroyWindow(window);
            window = IntPtr.Zero;
            UnregisterClass(className, instance);
        }
    }

    private IntPtr HandleMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == 0x0084) return new IntPtr(-1); // HTTRANSPARENT: do not consume the user's clicks.
        if (message == 0x0021) return new IntPtr(3); // MA_NOACTIVATE
        if (message is 0x000F or 0x0317 or 0x0318)
        {
            PaintInfo paint = default;
            var dc = message == 0x000F ? BeginPaint(hwnd, out paint) : wParam;
            // Never allow a managed exception to escape through a native window procedure.
            try
            {
                GetClientRect(hwnd, out var rect);
                // Render atomically into one tiny surface so screen and WM_PRINT see the same label.
                using var surface = new Bitmap(rect.Right, rect.Bottom);
                using var graphics = Graphics.FromImage(surface);
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.Clear(Color.FromArgb(35, 35, 39));
                float scale = rect.Right / 112f;
                using var red = new SolidBrush(Color.FromArgb(255, 45, 55));
                graphics.FillEllipse(red, 15 * scale, 12 * scale, 17 * scale, 17 * scale);
                using var titleFont = new Font("Segoe UI", 13 * scale, FontStyle.Bold, GraphicsUnit.Pixel);
                using var labelFont = new Font("Segoe UI", 12 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
                graphics.DrawString("REC", titleFont, Brushes.White, 41 * scale, 12 * scale);
                graphics.DrawString("WinCoding", labelFont, Brushes.WhiteSmoke, 24 * scale, 39 * scale);
                graphics.Flush();
                using var target = Graphics.FromHdc(dc);
                target.DrawImageUnscaled(surface, 0, 0);
                painted = true;
            }
            catch (Exception error) { failure = error; }
            finally { if (message == 0x000F) EndPaint(hwnd, ref paint); }
            return IntPtr.Zero;
        }
        if (message == Close) { DestroyWindow(hwnd); return IntPtr.Zero; }
        if (message == 0x0002) { PostQuitMessage(0); return IntPtr.Zero; }
        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    public void Dispose()
    {
        // Short operations remain noticeable. The helper owns the window, so forced process
        // cleanup also removes it; no independent overlay process can be orphaned.
        if (visible.IsRunning && visible.ElapsedMilliseconds < 600)
            Thread.Sleep((int)(600 - visible.ElapsedMilliseconds));
        if (window != IntPtr.Zero) PostMessage(window, Close, IntPtr.Zero, IntPtr.Zero);
        if (!thread.Join(1500)) throw new InvalidOperationException("Indicator thread failed to exit.");
        ready.Dispose();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WindowClass
    {
        public uint Style; public IntPtr Procedure; public int ClassExtra, WindowExtra;
        public IntPtr Instance, Icon, Cursor, Background;
        public string? MenuName; public string ClassName;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Message
    { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Private; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct PaintInfo
    {
        public IntPtr Dc; public int Erase; public Rect Bounds; public int Restore, Incremental;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] Reserved;
    }
    private delegate IntPtr WndProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClass(ref WindowClass cls);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool UnregisterClass(string name, IntPtr instance);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowEx(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool UpdateWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint color, byte alpha, uint flags);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DefWindowProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr BeginPaint(IntPtr hwnd, out PaintInfo paint);
    [DllImport("user32.dll")] private static extern bool EndPaint(IntPtr hwnd, ref PaintInfo paint);
}
