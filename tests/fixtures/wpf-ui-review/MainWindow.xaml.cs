using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Runtime.InteropServices;
using System.Diagnostics;

namespace wpf_ui_review;

/// <summary>
/// Interaction logic for MainWindow.xaml
/// </summary>
public partial class MainWindow : Window
{
    protected override System.Windows.Automation.Peers.AutomationPeer OnCreateAutomationPeer()
    {
        var marker = Environment.GetEnvironmentVariable("WINCODE_TEST_OWNER_UI_MARKER")
            ?? Environment.GetEnvironmentVariable("WINCODE_TEST_UI_HOLD_MARKER");
        return marker == null ? base.OnCreateAutomationPeer() : new OwnerDeathPeer(this, marker);
    }

    // 仅此隔离夹具启用：实际 UIA 读取进入后提供握手，再模拟不返回的目标提供方。
    private sealed class OwnerDeathPeer(MainWindow window, string marker) : System.Windows.Automation.Peers.WindowAutomationPeer(window)
    {
        protected override string GetNameCore()
        {
            if (System.IO.File.Exists(marker + ".armed"))
            {
                System.IO.File.WriteAllText(marker, Environment.ProcessId.ToString());
                if (Environment.GetEnvironmentVariable("WINCODE_TEST_UI_HOLD_MARKER") == marker)
                {
                    var deadline = Stopwatch.StartNew();
                    while (!System.IO.File.Exists(marker + ".release") && deadline.ElapsedMilliseconds < 15000)
                        System.Threading.Thread.Sleep(10);
                }
                else System.Threading.Thread.Sleep(60000);
            }
            return base.GetNameCore();
        }
    }

    public System.Windows.Input.ICommand ReviewActionCommand { get; private set; } = null!;

    private sealed class FixturePropertyException(string message) : InvalidOperationException(message);
    // Explicit fault fixture: exercise real UIA property failures without changing production readers.
    private sealed class EvidenceExpander(bool enabledUnknown = false) : Expander
    {
        protected override System.Windows.Automation.Peers.AutomationPeer OnCreateAutomationPeer() => new EvidencePeer(this);
        private sealed class EvidencePeer(EvidenceExpander owner) : System.Windows.Automation.Peers.ExpanderAutomationPeer(owner)
        {
            protected override string GetClassNameCore() => throw new FixturePropertyException("Fixture auxiliary property unavailable");
            protected override bool IsEnabledCore() => owner.enabledUnknown
                ? throw new FixturePropertyException("Fixture enabled evidence unavailable") : base.IsEnabledCore();
        }
        private readonly bool enabledUnknown = enabledUnknown;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    private static void ReportForeground()
    {
        var foreground = GetForegroundWindow();
        GetWindowThreadProcessId(foreground, out var pid);
        string name = "unavailable";
        try { using var process = Process.GetProcessById((int)pid); name = process.ProcessName; } catch { }
        Console.WriteLine($"FOREGROUND {pid} 0x{foreground.ToInt64():X} {name}");
        Console.Out.Flush();
    }

    public MainWindow()
    {
        if (Environment.GetCommandLineArgs().Contains("--navigation-evidence") || Environment.GetCommandLineArgs().Contains("--hybrid-evidence"))
        {
            // WPF also reads IsEnabled during event updates. Only handle our injected event fault;
            // UIA property queries still propagate it through WPF's ElementUtil.Invoke to the client.
            Dispatcher.UnhandledException += (_, e) => { if (e.Exception is FixturePropertyException) e.Handled = true; };
        }
        InitializeComponent();
        if (Environment.GetCommandLineArgs().Contains("--code-navigation-fixture"))
        {
            ReviewActionCommand = new SourceRepairCommand(CanExecuteReviewAction);
            DataContext = this;
            btnCodeNavigation.Visibility = Visibility.Visible;
        }
        if (Environment.GetCommandLineArgs().Contains("--background-fixture"))
        {
            // Explicit test mode: never activate or place this fixture above the user's game.
            ReportForeground();
            ShowActivated = false;
            ShowInTaskbar = false;
            Title = "WinCode Background Evidence Fixture";
            SourceInitialized += (_, _) => {
                var handle = new WindowInteropHelper(this).Handle;
                SetWindowLongPtr(handle, -20, new IntPtr(GetWindowLongPtr(handle, -20).ToInt64() | 0x08000000)); // WS_EX_NOACTIVATE
            };
        }
        if (Environment.GetCommandLineArgs().Contains("--window-list-fixture")) Title = "WinCode 窗口发现夹具";
        if (Environment.GetEnvironmentVariable("WINCODE_TEST_UI_LABEL") is string label) Title = label;
        if (Environment.GetCommandLineArgs().Contains("--budget-fixture"))
        {
            var panel = new StackPanel();
            for (int i = 0; i < 350; i++)
            {
                var button = new Button { Content = $"Budget button {i}", Height = 24 };
                System.Windows.Automation.AutomationProperties.SetAutomationId(button, new string('界', 300) + i);
                panel.Children.Add(button);
            }
            Content = panel;
        }
        if (Environment.GetCommandLineArgs().Contains("--action-fixture"))
        {
            // 语义操作夹具：在 code-behind 中替换内容，不改 XAML，避免移动源码审查断言的 XAML 行号。
            // actionEcho 是 TextBlock，其 UIA Name 就是文本，因此"点击/输入是否真的到达应用"
            // 可以由独立的只读取证观察到，而不是只看操作工具自己报告的 success。
            var panel = new StackPanel { Margin = new Thickness(16) };
            void Add(FrameworkElement control, string id)
            {
                System.Windows.Automation.AutomationProperties.SetAutomationId(control, id);
                panel.Children.Add(control);
            }
            var echo = new TextBlock { Text = "idle" };
            Add(echo, "actionEcho");

            // 键盘输入要求目标控件持有键盘焦点。夹具在自己的测试模式下提供一次显式获取焦点的机会，
            // 让"目标应用本来就持有键盘焦点"这一前提在测试中可复现；产品 Host 绝不激活目标窗口，
            // 无法确认焦点时直接拒绝输入。
            var focusGate = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
            var focusAttempts = 0;
            focusGate.Tick += (_, _) =>
            {
                if (IsActive || ++focusAttempts > 25) { focusGate.Stop(); return; }
                Activate();
            };
            var focusButton = new Button { Content = "Focus Window", Height = 30 };
            focusButton.Click += (_, _) => { Activate(); focusGate.Start(); };
            Add(focusButton, "actionFocus");

            var clicks = 0;
            var increment = new Button { Content = "Increment", Height = 30 };
            increment.Click += (_, _) => echo.Text = $"clicked:{++clicks}";
            Add(increment, "actionIncrement");

            // 两个控件共用同一 AutomationId：语义操作必须拒绝歧义，而不是挑第一个。
            var duplicateFirst = new Button { Content = "Duplicate", Height = 30 };
            duplicateFirst.Click += (_, _) => echo.Text = "ambiguous-click";
            Add(duplicateFirst, "actionDuplicate");
            var duplicateSecond = new Button { Content = "Duplicate", Height = 30 };
            duplicateSecond.Click += (_, _) => echo.Text = "ambiguous-click";
            Add(duplicateSecond, "actionDuplicate");

            var toggle = new CheckBox { Content = "Toggle" };
            toggle.Checked += (_, _) => echo.Text = "toggled:true";
            toggle.Unchecked += (_, _) => echo.Text = "toggled:false";
            Add(toggle, "actionToggle");

            var childCheck = new CheckBox { Content = "Normalize", IsChecked = true };
            System.Windows.Automation.AutomationProperties.SetAutomationId(childCheck, "actionNormalize");
            var navigationCandidates = Environment.GetCommandLineArgs().Contains("--navigation-candidates");
            Add(new Expander { Header = navigationCandidates ? "Speech advanced" : "Advanced", Content = childCheck }, "actionAdvanced");
            if (Environment.GetCommandLineArgs().Contains("--navigation-evidence"))
            {
                foreach (var (id, enabledUnknown, isDisabled) in new[] {
                    ("actionAuxiliary", false, false), ("actionEnabledUnknown", true, false), ("actionDisabledExpander", false, true) })
                {
                    var evidenceChild = new CheckBox { Content = "Evidence check", IsChecked = true };
                    System.Windows.Automation.AutomationProperties.SetAutomationId(evidenceChild, id + "Check");
                    Add(new EvidenceExpander(enabledUnknown) { Header = id, Content = evidenceChild, IsEnabled = !isDisabled }, id);
                }
            }
            if (navigationCandidates)
            {
                var displayCheck = new CheckBox { Content = "Dark theme", IsChecked = false };
                System.Windows.Automation.AutomationProperties.SetAutomationId(displayCheck, "actionDarkTheme");
                Add(new Expander { Header = "Display advanced", Content = displayCheck, IsExpanded = true }, "actionDisplayAdvanced");
            }
            if (Environment.GetCommandLineArgs().Contains("--nested-navigation"))
            {
                var nestedCheck = new CheckBox { Content = "Nested normalize", IsChecked = true };
                System.Windows.Automation.AutomationProperties.SetAutomationId(nestedCheck, "actionNestedNormalize");
                var inner = new Expander { Header = "Inner options", Content = nestedCheck };
                System.Windows.Automation.AutomationProperties.SetAutomationId(inner, "actionInnerOptions");
                Add(new Expander { Header = "Outer options", IsExpanded = true, Content = inner }, "actionOuterOptions");
            }
            if (Environment.GetCommandLineArgs().Contains("--scope-navigation"))
            {
                foreach (var (id, regionLabel, value) in new[] { ("scopeSpeech", "Speech", true), ("scopeDisplay", "Display", false) })
                {
                    var check = new CheckBox { Content = "Normalize", IsChecked = value };
                    System.Windows.Automation.AutomationProperties.SetAutomationId(check, "scopeNormalize");
                    var inner = new Expander { Header = "Advanced", Content = new StackPanel { Children = { check } } };
                    System.Windows.Automation.AutomationProperties.SetAutomationId(inner, "scopeAdvanced");
                    Add(new Expander { Header = regionLabel, IsExpanded = true, Content = new StackPanel { Children = { inner } } }, id);
                }
            }

            var disabled = new Button { Content = "Disabled", IsEnabled = false, Height = 30 };
            disabled.Click += (_, _) => echo.Text = "disabled-click";
            Add(disabled, "actionDisabled");

            var readOnly = new TextBox { Text = "read-only", IsReadOnly = true, Height = 28 };
            Add(readOnly, "actionReadOnly");

            var input = new TextBox { Text = "initial", Height = 28 };
            input.TextChanged += (_, _) => echo.Text = "text:" + input.Text;
            Add(input, "actionInput");

            var valueTarget = new TextBox { Text = "initial", Height = 28 };
            valueTarget.TextChanged += (_, _) => echo.Text = "value:" + valueTarget.Text;
            Add(valueTarget, "actionValue");

            Content = panel;
        }
        if (Environment.GetCommandLineArgs().Contains("--query-fixture")) {
            var panel = new StackPanel();
            void Add(FrameworkElement control, string id) {
                System.Windows.Automation.AutomationProperties.SetAutomationId(control, id);
                panel.Children.Add(control);
            }
            Add(new Button { Content = "Normal Action", IsEnabled = false }, "btnNormalAction");
            Add(new Button { Content = "Duplicate" }, "duplicateItem");
            Add(new Button { Content = "Duplicate" }, "duplicateItem");
            Add(new CheckBox { Content = "Checked", IsChecked = true }, "queryToggle");
            Add(new ListBox { Items = { new ListBoxItem { Content = "Selected", IsSelected = true } } }, "queryList");
            Add(new Expander { Header = "Expanded", IsExpanded = true, Content = new TextBlock { Text = "Child" } }, "queryExpand");
            for (int i = 0; i < 100; i++) Add(new Button { Content = "Unrelated " + i }, "unrelated" + i);
            Content = panel;
        }
        if (Environment.GetCommandLineArgs().Contains("--hybrid-fixture")) BuildHybridFixture();
        Loaded += MainWindow_Loaded;
    }

    private void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        var helper = new WindowInteropHelper(this);
        var hwnd = helper.Handle;
        if (Environment.GetCommandLineArgs().Contains("--background-fixture"))
        {
            SetWindowPos(hwnd, new IntPtr(1), 0, 0, 0, 0, 0x0010 | 0x0001 | 0x0002); // HWND_BOTTOM, NOACTIVATE/NOSIZE/NOMOVE
            var foregroundTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            foregroundTimer.Tick += (_, _) => ReportForeground();
            Closed += (_, _) => foregroundTimer.Stop();
            foregroundTimer.Start();
            ReportForeground();
        }

        // Print readiness signal to stdout for automated testing
        Console.WriteLine($"READY {Environment.ProcessId} 0x{hwnd.ToInt64():X}");
        Console.Out.Flush();

        var args = Environment.GetCommandLineArgs();
        if (args.Contains("--multi-window") || args.Contains("--window-list-fixture"))
        {
            OpenSubWindow();
        }

        if (args.Contains("--hang-ui"))
        {
            Console.WriteLine("SIMULATING_HANG");
            Console.Out.Flush();
            Thread.Sleep(60000);
        }

        var autoCloseArg = args.FirstOrDefault(a => a.StartsWith("--auto-close="));
        if (autoCloseArg != null && int.TryParse(autoCloseArg.Split('=')[1], out var ms))
        {
            Task.Delay(ms).ContinueWith(_ => Dispatcher.Invoke(Close));
        }
    }

    private void BtnSpawnDialog_Click(object sender, RoutedEventArgs e)
    {
        OpenSubWindow();
    }

    private bool CanExecuteReviewAction()
    {
        return false; // R6_SOURCE_DEFECT
    }

    private sealed class SourceRepairCommand(Func<bool> canExecute) : System.Windows.Input.ICommand
    {
        public bool CanExecute(object? parameter) => canExecute();
        public void Execute(object? parameter) { }
        public event EventHandler? CanExecuteChanged { add { } remove { } }
    }

    private void OpenSubWindow()
    {
        var subWin = new Window
        {
            Title = Environment.GetCommandLineArgs().Contains("--window-list-fixture") ? Title : "SubWindow Dialog",
            Width = 300,
            Height = 200,
            Owner = this,
            WindowStartupLocation = WindowStartupLocation.CenterOwner
        };
        System.Windows.Automation.AutomationProperties.SetAutomationId(subWin, "SubDialogWindow");

        var panel = new StackPanel { Margin = new Thickness(10) };
        var label = new TextBlock
        {
            Text = "This is a secondary dialog window.",
            Margin = new Thickness(0, 0, 0, 10)
        };
        System.Windows.Automation.AutomationProperties.SetAutomationId(label, "subDialogLabel");

        var closeBtn = new Button
        {
            Content = "Close SubWindow",
            Height = 30
        };
        System.Windows.Automation.AutomationProperties.SetAutomationId(closeBtn, "subDialogCloseBtn");
        closeBtn.Click += (_, _) => subWin.Close();

        panel.Children.Add(label);
        panel.Children.Add(closeBtn);
        subWin.Content = panel;
        subWin.Show();
    }
}
