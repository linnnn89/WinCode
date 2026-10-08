using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;

namespace wpf_ui_review;

public partial class MainWindow
{
    private sealed class EvidenceCheckBox(bool enabledUnknown = false) : CheckBox
    {
        private readonly bool enabledUnknown = enabledUnknown;
        protected override System.Windows.Automation.Peers.AutomationPeer OnCreateAutomationPeer() => new EvidencePeer(this);
        private sealed class EvidencePeer(EvidenceCheckBox owner) : System.Windows.Automation.Peers.CheckBoxAutomationPeer(owner)
        {
            protected override string GetClassNameCore() => throw new FixturePropertyException("Fixture auxiliary property unavailable");
            protected override bool IsEnabledCore() => owner.enabledUnknown
                ? throw new FixturePropertyException("Fixture enabled evidence unavailable") : base.IsEnabledCore();
        }
    }

    // Isolated benchmark mode; existing XAML and acceptance fixture identities remain intact.
    private void BuildHybridFixture()
    {
        if (Environment.GetCommandLineArgs().Contains("--hybrid-scopes")) { BuildScopedHybridFixture(); return; }
        var panel = new StackPanel { Margin = new Thickness(16) };
        var propertyGaps = Environment.GetCommandLineArgs().Contains("--hybrid-evidence");
        CheckBox summary = propertyGaps ? new EvidenceCheckBox() : new CheckBox();
        summary.Content = "Details required";
        summary.IsChecked = !Environment.GetCommandLineArgs().Contains("--hybrid-summary-off");
        AutomationProperties.SetAutomationId(summary, "hybridSummary");
        panel.Children.Add(summary);
        var rows = new StackPanel();
        for (var i = 0; i < 8; i++)
        {
            CheckBox row = propertyGaps && i == 0
                ? new EvidenceCheckBox(Environment.GetCommandLineArgs().Contains("--hybrid-enabled-unknown")) : new CheckBox();
            row.Content = "Check " + i; row.IsChecked = i != 3; row.IsEnabled = i != 6;
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

    private void BuildScopedHybridFixture()
    {
        var panel = new StackPanel { Margin = new Thickness(16) };
        foreach (var voice in new[] { true, false })
        {
            var content = new StackPanel();
            var summary = new CheckBox { Content = "Details required", IsChecked = voice };
            AutomationProperties.SetAutomationId(summary, "hybridSummary");
            content.Children.Add(summary);
            var rows = new StackPanel();
            for (var i = 0; i < 2; i++)
            {
                var row = new CheckBox { Content = "Check " + i, IsChecked = voice ? i == 0 : i == 1, IsEnabled = voice || i == 0 };
                AutomationProperties.SetAutomationId(row, "hybridCheck" + i);
                rows.Children.Add(row);
            }
            var region = new GroupBox { Header = "Checks", Content = rows };
            AutomationProperties.SetAutomationId(region, "hybridChecks");
            content.Children.Add(region);
            var parent = new GroupBox { Header = "Settings", Content = content };
            AutomationProperties.SetAutomationId(parent, voice ? "hybridVoice" : "hybridDisplay");
            panel.Children.Add(parent);
        }
        Content = panel;
    }
}
