using WinCode.UIA.Host;
using FlaUI.Core;
using System.Drawing;
int passed = 0;
void Check(bool condition) { if (!condition) throw new Exception("Assertion " + (passed + 1)); passed++; }
var root = new Node("root", new Node("match"), new Node("match"), new Node("other"));
BoundedUiSearch<Node> Search(Node target, int budget = 20, int matches = 10, Func<Node, bool?>? match = null,
    Func<Node, Node?>? first = null, CancellationToken token = default, int depth = 50, int time = 2000) {
    var s = new BoundedUiSearch<Node>();
    s.Run(target, first ?? (n => n.Children.FirstOrDefault()), n => n.Next,
        match ?? (n => n.Name == "match"), budget, matches, token, depth, time);
    return s;
}
var all = Search(root); Check(all.Complete && all.Matches.Count == 2 && all.Visited == 4);
var small = Search(root, budget:2); Check(!small.Complete && small.Matches.Count == 1 && small.Reason == "searchNodes");
var capped = Search(root, matches:1); Check(!capped.Complete && capped.Matches.Count == 1);
Check(Search(new Node("match"), budget:1).Complete);
Check(Search(new Node("match"), depth:1).Complete);
Check(!Search(root, depth:1).Complete);
Check(Search(root, match: _ => false).Matches.Count == 0);
Check(!Search(root, match: n => n.Name == "other" ? null : false).Complete);
Check(!Search(root, first: n => n.Name == "root" ? n.Children[0] : throw new Exception("gone")).Complete);
Check(!Search(root, time:0).Complete);
using var cts = new CancellationTokenSource(); cts.Cancel();
try { Search(root, token:cts.Token); throw new Exception("cancel ignored"); } catch (OperationCanceledException) { passed++; }
try { Search(root, first: _ => throw new OperationCanceledException()); throw new Exception("cancel swallowed"); } catch (OperationCanceledException) { passed++; }
bool? observed = null; var issues = new List<string>();
UiPropertyEvidence.Read("enabled", new BoolProperty(false), v => observed = v, issues);
Check(observed == null && issues.SequenceEqual(new[]{"enabled:unsupported"}));
issues.Clear();
UiPropertyEvidence.Read("enabled", new BoolProperty(true), v => observed = v, issues);
Check(observed == false && issues.Count == 0);
observed = null;
UiPropertyEvidence.Read("enabled", new BoolProperty(true, new Exception("disappeared")), v => observed = v, issues);
Check(observed == null && issues.SequenceEqual(new[]{"enabled:error"}));
try { UiPropertyEvidence.Read("enabled", new BoolProperty(true, new OperationCanceledException()), _ => {}, issues); throw new Exception("cancel swallowed"); }
catch (OperationCanceledException) { passed++; }
var qualityPassed = 0;
void QualityCheck(bool condition) { if (!condition) throw new Exception("Capture assertion " + (qualityPassed + 1)); qualityPassed++; }
using (var image = new Bitmap(64, 64))
{
    using var graphics = Graphics.FromImage(image);
    graphics.Clear(Color.Black);
    var black = CaptureQuality.Inspect(image);
    QualityCheck(black.Status == "suspect-low-variation" && black.SampleCount == 1024);
    graphics.Clear(Color.White);
    QualityCheck(CaptureQuality.Inspect(image).Status == "suspect-low-variation");
    graphics.Clear(Color.FromArgb(100, 100, 100));
    using var lowContrast = new SolidBrush(Color.FromArgb(103, 103, 103));
    graphics.FillRectangle(lowContrast, 0, 0, 32, 64);
    QualityCheck(CaptureQuality.Inspect(image).Status == "suspect-low-variation");
    graphics.Clear(Color.White);
    graphics.FillRectangle(Brushes.Black, 0, 0, 32, 64);
    var varied = CaptureQuality.Inspect(image);
    QualityCheck(varied.Status == "unknown" && varied.MaxChannelRange == 255);
    QualityCheck(image.GetPixel(0, 0).ToArgb() == Color.Black.ToArgb() && image.GetPixel(63, 63).ToArgb() == Color.White.ToArgb());
    using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
    try { CaptureQuality.Inspect(image, cancelled.Token); throw new Exception("capture cancellation ignored"); }
    catch (OperationCanceledException) { qualityPassed++; }
}
using (var pixel = new Bitmap(1, 1)) QualityCheck(CaptureQuality.Inspect(pixel).SampleCount == 1);
var disposed = new Bitmap(1, 1); disposed.Dispose();
QualityCheck(CaptureQuality.Inspect(disposed).Status == "unknown");
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new {passed, qualityPassed}));
class Node {
    public string Name; public Node[] Children; public Node? Next;
    public Node(string name, params Node[] children) { Name = name; Children = children;
        for (int i=0; i+1<children.Length; i++) children[i].Next=children[i+1]; }
}

class BoolProperty(bool supported, Exception? error = null) : IAutomationProperty<bool> {
    public bool Value => false;
    public bool ValueOrDefault => false;
    public bool IsSupported => supported;
    public bool TryGetValue(out bool value) { if(error != null) throw error; value = false; return supported; }
}
