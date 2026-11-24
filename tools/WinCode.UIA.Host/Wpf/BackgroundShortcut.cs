using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;

namespace WinCode.Wpf;

/// <summary>Declares one shortcut that WinCode may route to a control in this window.</summary>
public sealed class BackgroundShortcut : FrameworkElement
{
    public static readonly DependencyProperty TargetProperty = DependencyProperty.Register(
        nameof(Target), typeof(FrameworkElement), typeof(BackgroundShortcut));

    public FrameworkElement? Target
    {
        get => (FrameworkElement?)GetValue(TargetProperty);
        set => SetValue(TargetProperty, value);
    }

    public KeyGesture? Gesture { get; set; }
    public string LastStatus { get; private set; } = "ready";

    public BackgroundShortcut()
    {
        Focusable = false;
        IsHitTestVisible = false;
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new ShortcutPeer(this);

    private sealed class ShortcutPeer : FrameworkElementAutomationPeer, IInvokeProvider
    {
        private BackgroundShortcut Shortcut => (BackgroundShortcut)Owner;
        // A retained UIA reference must not follow a control into another window.
        private HwndSource? source;
        public ShortcutPeer(BackgroundShortcut owner) : base(owner) => source = PresentationSource.FromVisual(owner) as HwndSource;

        protected override string GetClassNameCore() => "WinCode.WpfBackgroundShortcut.v1";
        protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Custom;
        protected override bool IsControlElementCore() => Shortcut.IsVisible;
        protected override string GetAcceleratorKeyCore() => Shortcut.Gesture?.GetDisplayStringForCulture(CultureInfo.InvariantCulture) ?? string.Empty;
        protected override string GetItemStatusCore() => Shortcut.LastStatus;
        protected override string GetNameCore()
        {
            var name = base.GetNameCore();
            return string.IsNullOrEmpty(name) ? GetAcceleratorKeyCore() : name;
        }
        public override object? GetPattern(PatternInterface pattern)
        {
            if (pattern != PatternInterface.Invoke) return base.GetPattern(pattern);
            var current = PresentationSource.FromVisual(Shortcut) as HwndSource;
            source ??= current;
            return current != null && source == current ? this : null;
        }

        public void Invoke()
        {
            var owner = Shortcut;
            owner.Dispatcher.VerifyAccess();
            var target = owner.Target;
            var gesture = owner.Gesture;
            if (target == null || gesture == null || source == null || owner.LastStatus == "pending")
                throw new InvalidOperationException("The shortcut and its target must be available in their original window.");
            var originalSource = source;
            CheckTarget(owner, target, originalSource);
            owner.LastStatus = "pending";
            // UI Automation Invoke must return promptly even when a command handler takes time.
            owner.Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(() =>
            {
                try
                {
                    if (owner.Target != target || owner.Gesture != gesture) throw new InvalidOperationException("The shortcut declaration changed.");
                    Route(owner, target, originalSource, gesture);
                    owner.LastStatus = "routed";
                }
                catch (Exception error)
                {
                    owner.LastStatus = "failed";
                    Trace.TraceWarning("WinCode WPF shortcut failed: {0}", error.GetType().Name);
                }
            }));
        }
    }

    [ThreadStatic] private static bool routing;

    private static void Route(BackgroundShortcut owner, FrameworkElement target, HwndSource source, KeyGesture gesture)
    {
        const ModifierKeys supported = ModifierKeys.Control | ModifierKeys.Shift;
        int virtualKey = KeyInterop.VirtualKeyFromKey(gesture.Key);
        if ((gesture.Modifiers & ~supported) != 0 || virtualKey is <= 0 or >= 256 ||
            gesture.Key is Key.LeftCtrl or Key.RightCtrl or Key.LeftShift or Key.RightShift or Key.LeftAlt or Key.RightAlt or Key.LWin or Key.RWin)
            throw new InvalidOperationException("The declared shortcut must use a non-modifier key and optional Ctrl or Shift.");

        CheckTarget(owner, target, source);
        if (routing) throw new InvalidOperationException("Another shortcut is being routed on this UI thread.");
        var saved = new byte[256];
        if (!GetKeyboardState(saved)) throw new Win32Exception();
        var state = (byte[])saved.Clone();
        // KeyGesture checks the thread's current modifiers. Preserve unrelated key and toggle state.
        foreach (int modifier in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 })
            state[modifier] &= 0x7f;

        void SetDown(int vk, bool down) => state[vk] = (byte)((state[vk] & 0x7f) | (down ? 0x80 : 0));

        void Step(Key key, bool down)
        {
            CheckTarget(owner, target, source);
            SetDown(KeyInterop.VirtualKeyFromKey(key), down);
            if (key == Key.LeftCtrl) SetDown(0x11, down);
            if (key == Key.LeftShift) SetDown(0x10, down);
            if (!SetKeyboardState(state)) throw new Win32Exception();
            var e = new KeyEventArgs(Keyboard.PrimaryDevice, source, Environment.TickCount, key)
                { RoutedEvent = down ? Keyboard.PreviewKeyDownEvent : Keyboard.PreviewKeyUpEvent };
            target.RaiseEvent(e);
            if (e.Handled) return;
            CheckTarget(owner, target, source);
            e.RoutedEvent = down ? Keyboard.KeyDownEvent : Keyboard.KeyUpEvent;
            target.RaiseEvent(e);
        }

        bool ctrl = gesture.Modifiers.HasFlag(ModifierKeys.Control);
        bool shift = gesture.Modifiers.HasFlag(ModifierKeys.Shift);
        // Keep the local keyboard state inside synchronous routed events, including on handler failure.
        using var noNestedDispatcher = target.Dispatcher.DisableProcessing();
        routing = true;
        try
        {
            if (ctrl) Step(Key.LeftCtrl, true);
            if (shift) Step(Key.LeftShift, true);
            Step(gesture.Key, true);
            Step(gesture.Key, false);
            if (shift) Step(Key.LeftShift, false);
            if (ctrl) Step(Key.LeftCtrl, false);
        }
        finally
        {
            routing = false;
            if (!SetKeyboardState(saved)) throw new Win32Exception();
            var restored = new byte[256];
            if (!GetKeyboardState(restored) || !saved.SequenceEqual(restored))
                throw new InvalidOperationException("Could not confirm restoration of the UI thread's keyboard state.");
        }
    }

    private static void CheckTarget(BackgroundShortcut owner, FrameworkElement target, HwndSource source)
    {
        var foreground = GetForegroundWindow();
        if (foreground == 0 || GetWindowThreadProcessId(foreground, out uint pid) == 0 || pid == 0 || pid == Environment.ProcessId ||
            ForeignQueueWindow(GetActiveWindow()) || ForeignQueueWindow(GetFocus()) ||
            source.IsDisposed || !owner.IsVisible || !owner.IsEnabled || !target.IsVisible || !target.IsEnabled ||
            PresentationSource.FromVisual(owner) != source || PresentationSource.FromVisual(target) != source)
            throw new InvalidOperationException("The shortcut requires an enabled target in its original background window with an independent input queue.");
    }

    private static bool ForeignQueueWindow(nint window) => window != 0 &&
        (GetWindowThreadProcessId(window, out uint pid) == 0 || pid != Environment.ProcessId);

    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern nint GetActiveWindow();
    [DllImport("user32.dll")] private static extern nint GetFocus();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetKeyboardState([Out] byte[] state);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetKeyboardState(byte[] state);
}
