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
        InitializeComponent();
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
