using FlaUI.Core;
namespace WinCode.UIA.Host;

public static class UiPropertyEvidence
{
    // Never substitute a value-type default for unsupported/failed UIA reads.
    public static void Read<T>(string name, IAutomationProperty<T> property, Action<T> assign, List<string> issues)
    {
        try {
            if (property.TryGetValue(out var value)) assign(value);
            else issues.Add(name + ":unsupported");
        } catch (OperationCanceledException) { throw; }
        catch { issues.Add(name + ":error"); }
    }
}
