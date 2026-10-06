using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;

namespace wpf_ui_review;

public partial class MainWindow
{
    // Isolated benchmark mode; existing XAML and acceptance fixture identities remain intact.
    private void BuildHybridFixture()
    {
        var panel = new StackPanel { Margin = new Thickness(16) };
        var summary = new CheckBox { Content = "Details required", IsChecked = true };
        AutomationProperties.SetAutomationId(summary, "hybridSummary");
        panel.Children.Add(summary);
        var rows = new StackPanel();
        for (var i = 0; i < 8; i++)
        {
            var row = new CheckBox { Content = "Check " + i, IsChecked = i != 3, IsEnabled = i != 6 };
            AutomationProperties.SetAutomationId(row, "hybridCheck" + i);
            rows.Children.Add(row);
        }
        var region = new GroupBox { Header = "Eight checks", Content = rows };
        AutomationProperties.SetAutomationId(region, "hybridChecks");
        panel.Children.Add(region);
        var sourceButton = new Button { Content = "Normal Action", IsEnabled = false };
        AutomationProperties.SetAutomationId(sourceButton, "btnNormalAction");
        panel.Children.Add(sourceButton);
        for (var i = 0; i < 2; i++)
        {
            var duplicate = new Button { Content = "Duplicate" };
            AutomationProperties.SetAutomationId(duplicate, "hybridDuplicate");
            panel.Children.Add(duplicate);
        }
        Content = panel;
        var changeFile = Environment.GetCommandLineArgs().FirstOrDefault(arg => arg.StartsWith("--hybrid-state-file="))?.Split('=', 2)[1];
        if (changeFile != null)
        {
            var changes = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(50) };
            changes.Tick += (_, _) => {
                if (!System.IO.File.Exists(changeFile)) return;
                summary.IsChecked = false;
                Console.WriteLine("STATE_CHANGED");
                Console.Out.Flush();
                changes.Stop();
            };
            Closed += (_, _) => changes.Stop();
            changes.Start();
        }
    }
}
