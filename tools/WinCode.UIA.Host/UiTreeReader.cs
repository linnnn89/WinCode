using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;
using static WinCode.UIA.Host.HostJson;

namespace WinCode.UIA.Host;

/// <summary>读取控件属性及有界树；完整性和截断计数与最终保留节点一致。</summary>
internal static class UiTreeReader
{
    internal static UiNodeDto? TraverseElement(
        AutomationElement element,
        ITreeWalker walker,
        int? parentId,
        int currentDepth,
        TraversalContext context)
    {
        context.CancellationToken.ThrowIfCancellationRequested();

        if (context.TotalCount >= context.MaxNodes)
        {
            context.Truncated = true;
            context.TruncateReason ??= "maxNodes";
            return null;
        }

        var nodeId = ++context.CurrentId;
        context.TotalCount++;
        if (currentDepth > context.MaxDepthReached)
        {
            context.MaxDepthReached = currentDepth;
        }

        var node = ReadElementProperties(element, nodeId, parentId, context.CaptureOrigin, context.ReadStates);
        context.CollectedNodes.Add(node);

        try
        {
            var child = walker.GetFirstChild(element);
            if (currentDepth >= context.MaxDepth) {
                if (child != null) { context.Truncated = true; context.TruncateReason ??= "maxDepth"; }
                return node;
            }
            while (child != null && context.TotalCount < context.MaxNodes)
            {
                var childNode = TraverseElement(child, walker, nodeId, currentDepth + 1, context);
                if (childNode != null)
                {
                    node.Children.Add(childNode);
                }
                child = walker.GetNextSibling(child);
            }

            if (child != null && context.TotalCount >= context.MaxNodes)
            {
                context.Truncated = true;
                context.TruncateReason ??= "maxNodes";
            }
        }
        catch (OperationCanceledException) { throw; }
        catch {
            context.TraversalErrors++;
            context.Truncated = true;
            context.TruncateReason ??= "enumerationFailed";
        }

        return node;
    }

    internal static bool ValidQuery(UiQueryDto? query) {
        if (query == null) return true;
        var values = new[] { query.AutomationId, query.Name, query.ControlType };
        return values.Any(v => v != null) && values.All(v => v == null ||
            (!string.IsNullOrWhiteSpace(v) && v.Length <= 256 && !v.Any(c => c < 32))) &&
            (query.MaxSearchNodes == null || query.MaxSearchNodes is >= 1 and <= 5000) &&
            (query.MaxMatches == null || query.MaxMatches is >= 1 and <= 20);
    }

    internal static bool? MatchesQuery(AutomationElement element, UiQueryDto query) {
        bool unknown = false;
        bool Test<T>(IAutomationProperty<T> property, string? expected) {
            if (expected == null) return true;
            try {
                // FlaUI false means unsupported, not a failed read: no literal value can match.
                if (!property.TryGetValue(out var value)) return false;
                return string.Equals(value?.ToString(), expected, StringComparison.Ordinal);
            } catch (OperationCanceledException) { throw; }
            catch { unknown = true; return true; }
        }
        if (!Test(element.Properties.AutomationId, query.AutomationId) ||
            !Test(element.Properties.Name, query.Name) || !Test(element.Properties.ControlType, query.ControlType)) return false;
        return unknown ? null : true;
    }

    internal static UiNodeDto ReadElementProperties(AutomationElement element, int id, int? parentId,
        RectDto captureOrigin, bool readStates = false)
    {
        var issues = new List<string>();
        var node = new UiNodeDto { Id = id, ParentId = parentId };
        // Unavailable values stay absent; a provider's default false is not evidence.
        void Read<T>(string name, IAutomationProperty<T> property, Action<T> assign) =>
            UiPropertyEvidence.Read(name, property, assign, issues);
        string? Clip(string? value, string name) {
            if (value?.Length > 256) { issues.Add(name + ":truncated"); return value[..256]; }
            return value;
        }
        Read("name", element.Properties.Name, v => node.Name = Clip(v, "name"));
        Read("automationId", element.Properties.AutomationId, v => node.AutomationId = Clip(v, "automationId"));
        Read("className", element.Properties.ClassName, v => node.ClassName = Clip(v, "className"));
        Read("controlType", element.Properties.ControlType, v => node.ControlType = v.ToString());
        Read("isEnabled", element.Properties.IsEnabled, v => node.IsEnabled = v);
        Read("isOffscreen", element.Properties.IsOffscreen, v => node.IsOffscreen = v);
        Read("bounds", element.Properties.BoundingRectangle, rect => {
            node.Bounds = new RectDto(rect.X, rect.Y, rect.Width, rect.Height);
            node.RelativeBounds = new RectDto(rect.X - captureOrigin.X, rect.Y - captureOrigin.Y, rect.Width, rect.Height);
        });
        if (readStates) {
            // Only read pattern state; never invoke actions or fetch input values.
            string State(Func<string> read) {
                try { return read(); }
                catch (OperationCanceledException) { throw; }
                catch { return "unknown"; }
            }
            node.States = new UiStatesDto {
                Toggle = State(() => element.Patterns.Toggle.PatternOrDefault?.ToggleState.Value.ToString() ?? "unsupported"),
                Selection = State(() => element.Patterns.SelectionItem.PatternOrDefault is { } p ?
                    (p.IsSelected.Value ? "selected" : "not-selected") : "unsupported"),
                ExpandCollapse = State(() => element.Patterns.ExpandCollapse.PatternOrDefault?.ExpandCollapseState.Value.ToString() ?? "unsupported")
            };
        }
        node.PropertyIssues = issues.Count == 0 ? null : issues;
        return node;
    }

    internal const int MaxTextJsonBytes = 128 * 1024;    // 128 KiB
    internal static void EnforceTreeJsonBudget(UiNodeDto root, int maxBytes, TraversalContext context)
    {
        bool fieldsTrimmed = LimitNodeText(root);
        int currentMaxDepth = context.MaxDepthReached;
        bool trimmed = fieldsTrimmed;
        while (currentMaxDepth > 1 && JsonSerializer.SerializeToUtf8Bytes(root, JsonOptions).Length > maxBytes)
        {
            PruneAtDepth(root, currentMaxDepth);
            currentMaxDepth--;
            trimmed = true;
        }
        if (trimmed)
        {
            context.Truncated = true;
            context.TruncateReason = "budgetLimit";
        }
        context.CollectedNodes.Clear();
        context.MaxDepthReached = 0;
        CollectRetained(root, 1, context);
        context.TotalCount = context.CollectedNodes.Count;
    }

    internal static bool LimitNodeText(UiNodeDto node)
    {
        bool trimmed = false;
        string? Limit(string? text)
        {
            if (text == null || text.Length <= 256) return text;
            trimmed = true;
            return text[..256];
        }
        node.Name = Limit(node.Name);
        node.AutomationId = Limit(node.AutomationId);
        node.ClassName = Limit(node.ClassName);
        node.ControlType = Limit(node.ControlType);
        foreach (var child in node.Children) trimmed |= LimitNodeText(child);
        return trimmed;
    }

    internal static void CollectRetained(UiNodeDto node, int depth, TraversalContext context)
    {
        context.CollectedNodes.Add(node);
        context.MaxDepthReached = Math.Max(context.MaxDepthReached, depth);
        foreach (var child in node.Children) CollectRetained(child, depth + 1, context);
    }

    internal static void PruneAtDepth(UiNodeDto node, int targetDepth, int depth = 1)
    {
        if (depth == targetDepth - 1)
        {
            node.Children.Clear();
            return;
        }
        foreach (var child in node.Children)
        {
            PruneAtDepth(child, targetDepth, depth + 1);
        }
    }

    internal sealed class TraversalContext
    {
        public int CurrentId { get; set; }
        public int TotalCount { get; set; }
        public int TraversalErrors { get; set; }
        public bool ReadStates { get; set; }
        public int MaxDepth { get; set; }
        public int MaxNodes { get; set; }
        public int MaxDepthReached { get; set; }
        public bool Truncated { get; set; }
        public string? TruncateReason { get; set; }
        public RectDto CaptureOrigin { get; set; } = null!;
        public CancellationToken CancellationToken { get; set; }
        public List<UiNodeDto> CollectedNodes { get; } = new();
    }
}
