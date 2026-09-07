using WinCode.UIA.Host;
using FlaUI.Core;
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
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new {passed}));
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
