using System.Diagnostics;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;

namespace WinCode.UIA.Host;

// Resolve logical descendants afresh in this request; layout wrappers need not appear in the path.
internal static class UiScopeResolver
{
    internal static bool Valid(InspectRequest request) => request.ScopePath == null ||
        ((request.Action == null || request.Action is "inspect" or "setExpanded") &&
         request.ScopePath.Count is >= 1 and <= 50 &&
         request.ScopePath.All(selector => selector != null && UiTreeReader.ValidQuery(selector.AsQuery())));

    internal static AutomationElement? Resolve(AutomationElement root, ITreeWalker walker,
        List<UiScopeSelectorDto>? path, Stopwatch elapsed, CancellationToken cancellation,
        out ScopeResultDto? evidence)
    {
        evidence = path == null ? null : new ScopeResultDto();
        if (path == null) return root;
        var current = root;
        for (int index = 0; index < path.Count; index++) {
            var search = new BoundedUiSearch<AutomationElement>();
            search.Run(current, walker.GetFirstChild, walker.GetNextSibling,
                element => UiTreeReader.MatchesQuery(element, path[index].AsQuery()),
                2000, 2, cancellation, milliseconds: Remaining(elapsed), includeRoot: false);
            evidence!.VisitedNodes += search.Visited;
            if (search.Matches.Count > 1 || !search.Complete || search.Matches.Count == 0) {
                evidence.FailedIndex = index;
                evidence.Status = search.Matches.Count > 1 ? "ambiguous" : !search.Complete ? "incomplete" : "not-found";
                evidence.Reason = search.Reason;
                return null;
            }
            current = search.Matches[0];
            evidence.ResolvedCount++;
        }
        return current;
    }

    // One existing search-time allowance for the whole path and final target, not one per hop.
    internal static int Remaining(Stopwatch elapsed) => (int)Math.Max(0, 2000 - elapsed.ElapsedMilliseconds);
    internal static InspectResponse Failed(InspectRequest request, ScopeResultDto evidence, int pid, string hwnd) => new() {
        RequestId = request.RequestId, Success = false, Action = request.Action ?? "inspect", Pid = pid, Hwnd = hwnd,
        ScopeResult = evidence, ErrorCode = evidence.Status switch {
            "ambiguous" => "SCOPE_AMBIGUOUS", "incomplete" => "SCOPE_SEARCH_INCOMPLETE", _ => "SCOPE_NOT_FOUND" },
        ErrorMessage = $"scopePath[{evidence.FailedIndex}] is {evidence.Status}; no target operation was attempted."
    };
}
