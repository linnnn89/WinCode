using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;

namespace wpf_ui_review;

/// <summary>
/// Interaction logic for MainWindow.xaml
/// </summary>
public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
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
        Loaded += MainWindow_Loaded;
    }

    private void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        var helper = new WindowInteropHelper(this);
        var hwnd = helper.Handle;

        // Print readiness signal to stdout for automated testing
        Console.WriteLine($"READY {Environment.ProcessId} 0x{hwnd.ToInt64():X}");
        Console.Out.Flush();

        var args = Environment.GetCommandLineArgs();
        if (args.Contains("--multi-window"))
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
            Title = "SubWindow Dialog",
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
