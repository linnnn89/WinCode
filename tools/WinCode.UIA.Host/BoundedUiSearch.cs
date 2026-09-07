using System.Diagnostics;

namespace WinCode.UIA.Host;

// Request-local traversal: never materialize all children or retain COM elements between calls.
public sealed class BoundedUiSearch<T> where T : class
{
    public int Visited { get; private set; }
    public string? Reason { get; private set; }
    public List<T> Matches { get; } = new();
    public bool Complete => Reason == null;
    private readonly Stopwatch elapsed = Stopwatch.StartNew();

    public void Run(T root, Func<T, T?> first, Func<T, T?> next, Func<T, bool?> match,
        int maxNodes, int maxMatches, CancellationToken cancellation, int maxDepth = 50, int milliseconds = 2000)
    {
        bool halted = false;
        bool Stop() {
            cancellation.ThrowIfCancellationRequested();
            if (halted) return true;
            if (elapsed.ElapsedMilliseconds >= milliseconds) { halted = true; Reason ??= "searchTime"; return true; }
            if (Visited >= maxNodes) { halted = true; Reason ??= "searchNodes"; return true; }
            return false;
        }
        void Visit(T node, int depth) {
            if (Stop()) return;
            Visited++;
            try {
                var matches = match(node);
                if (matches == null) Reason ??= "propertyUnavailable";
                if (matches == true) {
                    if (Matches.Count >= maxMatches) { halted = true; Reason ??= "maxMatches"; return; }
                    Matches.Add(node);
                }
                cancellation.ThrowIfCancellationRequested();
                var child = first(node);
                if (child != null && depth >= maxDepth) { Reason ??= "searchDepth"; return; }
                while (child != null) {
                    if (Stop()) return;
                    Visit(child, depth + 1);
                    if (halted) return;
                    cancellation.ThrowIfCancellationRequested();
                    child = next(child);
                }
            } catch (OperationCanceledException) { throw; }
            catch { Reason ??= "enumerationFailed"; }
        }
        Visit(root, 1);
    }
}
