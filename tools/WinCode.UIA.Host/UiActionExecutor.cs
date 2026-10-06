using System.Diagnostics;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;
using static WinCode.UIA.Host.WindowResolver;

namespace WinCode.UIA.Host;

/// <summary>
/// 语义化 UI 操作：先用有界搜索取得唯一目标控件，再只用 UIA 控件模式或键盘输入操作它。
/// 不做坐标鼠标模拟，不激活或还原目标窗口；无法确认键盘焦点落在目标控件时拒绝输入，
/// 避免把调用方文本送进未知窗口。成功只代表调用被接受，不代表应用已产生预期副作用。
/// </summary>
internal static class UiActionExecutor
{
    private const int MaxSearchNodes = 2000;
    /// <summary>只需要区分 0/1/多个；命中多个即视为歧义，不继续扩大搜索。</summary>
    private const int MaxMatches = 2;
    private const int FocusWaitMs = 500;
    private const int FocusPollMs = 20;
    private const int MaxInputLength = 4096;
    private const int MaxMessageLength = 200;

    internal static bool IsAction(string? action) => action is "click" or "type" or "setValue" or "setExpanded";

    /// <summary>协议层前置校验：定位条件组合、字段形状与输入文本长度必须先成立。</summary>
    internal static bool ValidActionRequest(InspectRequest request)
    {
        if (request.Pid <= 0 && string.IsNullOrWhiteSpace(request.Hwnd)) return false;
        var selectors = new[] { request.TargetAutomationId, request.TargetName, request.TargetControlType };
        if (!selectors.Any(value => value != null)) return false;
        if (selectors.Any(value => value != null && !ValidSelector(value!))) return false;
        return request.Action switch
        {
            "click" => request.InputText == null,
            "setExpanded" => request.InputText == null && !request.ClearBefore && request.Expanded != null,
            "type" => request.InputText is { Length: > 0 and <= MaxInputLength },
            "setValue" => request.InputText is { Length: <= MaxInputLength },
            _ => false,
        };
    }

    private static bool ValidSelector(string value) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= 256 && !value.Any(character => character < 32);

    internal static InspectResponse Execute(InspectRequest request, CancellationToken cancellationToken)
    {
        var targetHwnd = ResolveTargetWindow(request, out var resolvedPid, out var candidateWindows, out var resolveError);
        if (targetHwnd == IntPtr.Zero)
            return Failed(request, resolveError ?? "WINDOW_NOT_FOUND",
                $"Could not resolve target window for PID {request.Pid} / HWND {request.Hwnd}.", candidateWindows);

        using var automation = new UIA3Automation();
        var root = automation.FromHandle(targetHwnd);
        if (root == null)
            return Failed(request, "UIA_ELEMENT_NOT_AVAILABLE",
                "Unable to create UIA AutomationElement from target window handle.");

        var identity = new ResolvedWindow(resolvedPid > 0 ? resolvedPid : request.Pid, $"0x{targetHwnd.ToInt64():X}");
        var query = new UiQueryDto
        {
            AutomationId = request.TargetAutomationId,
            Name = request.TargetName,
            ControlType = request.TargetControlType,
        };
        var walker = automation.TreeWalkerFactory.GetControlViewWalker();
        var search = new BoundedUiSearch<AutomationElement>();
        search.Run(root, walker.GetFirstChild, walker.GetNextSibling,
            element => UiTreeReader.MatchesQuery(element, query), MaxSearchNodes, MaxMatches, cancellationToken);

        if (search.Matches.Count > 1)
            return Failed(request, "TARGET_AMBIGUOUS",
                "Selector matched multiple controls; only a unique target may be acted on.", identity);
        if (!search.Complete)
            return Failed(request, "TARGET_SEARCH_INCOMPLETE",
                $"Target search stopped early ({search.Reason ?? "unknown"}); uniqueness is unproven.", identity);
        if (search.Matches.Count == 0)
            return Failed(request, "TARGET_NOT_FOUND", "No control in the target window matched the selector.", identity);

        var target = search.Matches[0];
        var evidence = Describe(target);
        cancellationToken.ThrowIfCancellationRequested();

        return request.Action switch
        {
            "click" => Click(request, target, evidence, identity),
            "type" => Type(request, automation, target, query, evidence, identity, cancellationToken),
            "setValue" => SetValue(request, target, evidence, identity),
            "setExpanded" => SetExpanded(request, target, evidence, identity),
            _ => Failed(request, "UNKNOWN_ACTION", $"Unknown action: {request.Action}", identity),
        };
    }

    private static InspectResponse SetExpanded(InspectRequest request, AutomationElement target, UiTargetDto evidence, ResolvedWindow identity)
    {
        // Unknown enabled/state evidence must not authorize navigation.
        if (evidence.IsEnabled != true || evidence.PropertyIssues?.Count > 0)
            return Failed(request, "TARGET_DISABLED", "Target is disabled or its enabled state is unproven; no navigation was attempted.", identity, evidence);
        if (!target.Patterns.ExpandCollapse.TryGetPattern(out var pattern))
            return Failed(request, "NO_EXPAND_COLLAPSE_PATTERN", "Target has no ExpandCollapsePattern; no click fallback was attempted.", identity, evidence);
        var state = pattern.ExpandCollapseState.Value;
        if (state != ExpandCollapseState.Expanded && state != ExpandCollapseState.Collapsed)
            return Failed(request, "EXPAND_STATE_UNSUPPORTED", "Only an observed Expanded or Collapsed state permits navigation.", identity, evidence);
        var expanded = request.Expanded == true;
        if ((state == ExpandCollapseState.Expanded) == expanded)
            return Succeeded(request, evidence, identity, "ExpandCollapsePattern:no-op", expanded ? "already-expanded" : "already-collapsed");
        return RunPattern(request, evidence, identity, expanded ? "ExpandCollapsePattern.Expand" : "ExpandCollapsePattern.Collapse",
            expanded ? "expand-requested" : "collapse-requested", () => { if (expanded) pattern.Expand(); else pattern.Collapse(); });
    }

    private static InspectResponse Click(InspectRequest request, AutomationElement target, UiTargetDto evidence, ResolvedWindow identity)
    {
        if (Disabled(target))
            return Failed(request, "TARGET_DISABLED", "Target control is disabled; no click pattern was invoked.", identity, evidence);
        if (target.Patterns.Invoke.TryGetPattern(out var invoke))
            return RunPattern(request, evidence, identity, "InvokePattern", "clicked", () => invoke.Invoke());
        if (target.Patterns.Toggle.TryGetPattern(out var toggle))
            return RunPattern(request, evidence, identity, "TogglePattern", "toggled", () => toggle.Toggle());
        if (target.Patterns.SelectionItem.TryGetPattern(out var selection))
            return RunPattern(request, evidence, identity, "SelectionItemPattern", "selected", () => selection.Select());
        // 坐标鼠标模拟被有意排除：它会移动真实指针、可能激活目标窗口，且无法证明命中了同一个控件。
        return Failed(request, "NO_CLICK_PATTERN",
            "Target control exposes none of Invoke, Toggle or SelectionItem; coordinate mouse simulation is not supported.",
            identity, evidence);
    }

    private static InspectResponse Type(InspectRequest request, UIA3Automation automation, AutomationElement target,
        UiQueryDto query, UiTargetDto evidence, ResolvedWindow identity, CancellationToken cancellationToken)
    {
        if (Disabled(target))
            return Failed(request, "TARGET_DISABLED", "Target control is disabled; no text was sent.", identity, evidence);
        if (!FocusConfirmed(automation, target, query, cancellationToken))
            return Failed(request, "FOCUS_FAILED",
                "Keyboard focus could not be confirmed on the target control; no text was sent.",
                identity, evidence);

        var text = request.InputText!;
        try
        {
            // 焦点已确认落在目标控件，后续键盘输入才会进入该控件。
            if (request.ClearBefore) ClearFocusedInput();
            Keyboard.Type(text);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception error)
        {
            return Failed(request, "ACTION_FAILED", Shorten(error.Message), identity, evidence);
        }
        return Succeeded(request, evidence, identity, request.ClearBefore ? "keyboard:clear+type" : "keyboard:type", "typed", text.Length);
    }

    private static InspectResponse SetValue(InspectRequest request, AutomationElement target, UiTargetDto evidence, ResolvedWindow identity)
    {
        if (Disabled(target))
            return Failed(request, "TARGET_DISABLED", "Target control is disabled; its value was not written.", identity, evidence);
        if (!target.Patterns.Value.TryGetPattern(out var value))
            return Failed(request, "NO_VALUE_PATTERN",
                "Target control does not expose ValuePattern; use the type action instead.", identity, evidence);

        bool readOnly = false;
        try { readOnly = value.IsReadOnly.Value; }
        catch (OperationCanceledException) { throw; }
        catch { /* 读取失败不构成只读证据，交由写入结果说明。 */ }
        if (readOnly)
            return Failed(request, "VALUE_READONLY", "Target control reports a read-only value.", identity, evidence);

        try { value.SetValue(request.InputText!); }
        catch (OperationCanceledException) { throw; }
        catch (Exception error)
        {
            return Failed(request, "ACTION_FAILED", Shorten(error.Message), identity, evidence);
        }
        return Succeeded(request, evidence, identity, "ValuePattern", "value-set", request.InputText!.Length);
    }

    private static InspectResponse RunPattern(InspectRequest request, UiTargetDto evidence, ResolvedWindow identity,
        string method, string status, Action operation)
    {
        try { operation(); }
        catch (OperationCanceledException) { throw; }
        catch (Exception error)
        {
            return Failed(request, "ACTION_FAILED", Shorten(error.Message), identity, evidence);
        }
        return Succeeded(request, evidence, identity, method, status);
    }

    /// <summary>请求焦点后复查 UIA 键盘焦点确实落在同一选择器上，才允许后续输入。</summary>
    private static bool FocusConfirmed(UIA3Automation automation, AutomationElement target, UiQueryDto query, CancellationToken cancellationToken)
    {
        try { target.Focus(); }
        catch (OperationCanceledException) { throw; }
        catch { return false; }

        var elapsed = Stopwatch.StartNew();
        while (elapsed.ElapsedMilliseconds < FocusWaitMs)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var focused = automation.FocusedElement();
                if (focused != null && UiTreeReader.MatchesQuery(focused, query) == true) return true;
            }
            catch (OperationCanceledException) { throw; }
            catch { /* 焦点窗口切换过程中读取失败可重试。 */ }
            Thread.Sleep(FocusPollMs);
        }
        return false;
    }

    private static void ClearFocusedInput()
    {
        Keyboard.TypeSimultaneously(VirtualKeyShort.CONTROL, VirtualKeyShort.KEY_A);
        Keyboard.Type(VirtualKeyShort.DELETE);
        Thread.Sleep(FocusPollMs);
    }

    private static bool Disabled(AutomationElement element)
    {
        try { return element.Properties.IsEnabled.TryGetValue(out var enabled) && !enabled; }
        catch (OperationCanceledException) { throw; }
        catch { return false; }
    }

    private static UiTargetDto Describe(AutomationElement element)
    {
        var issues = new List<string>();
        var dto = new UiTargetDto();
        void Read<T>(string name, IAutomationProperty<T> property, Action<T> assign) =>
            UiPropertyEvidence.Read(name, property, assign, issues);
        static string? Clip(string? value) => value?.Length > 256 ? value[..256] : value;
        Read("automationId", element.Properties.AutomationId, value => dto.AutomationId = Clip(value));
        Read("name", element.Properties.Name, value => dto.Name = Clip(value));
        Read("className", element.Properties.ClassName, value => dto.ClassName = Clip(value));
        Read("controlType", element.Properties.ControlType, value => dto.ControlType = value.ToString());
        Read("isEnabled", element.Properties.IsEnabled, value => dto.IsEnabled = value);
        Read("isOffscreen", element.Properties.IsOffscreen, value => dto.IsOffscreen = value);
        Read("bounds", element.Properties.BoundingRectangle, rect => dto.Bounds = new RectDto(rect.X, rect.Y, rect.Width, rect.Height));
        if (issues.Count > 0) dto.PropertyIssues = issues;
        return dto;
    }

    private static string Shorten(string message) =>
        message.Length <= MaxMessageLength ? message : message[..MaxMessageLength];

    private static InspectResponse Succeeded(InspectRequest request, UiTargetDto target, ResolvedWindow identity,
        string method, string status, int? inputLength = null) => new()
    {
        SchemaVersion = "1.0",
        ProtocolVersion = "1.0",
        RequestId = request.RequestId,
        Success = true,
        Action = request.Action,
        Status = status,
        ActionMethod = method,
        ActionTarget = target,
        InputLength = inputLength,
        Pid = identity.Pid,
        Hwnd = identity.Hwnd,
    };

    private static InspectResponse Failed(InspectRequest request, string errorCode, string errorMessage,
        ResolvedWindow identity, UiTargetDto? target = null, List<CandidateWindowDto>? candidateWindows = null) => new()
    {
        SchemaVersion = "1.0",
        ProtocolVersion = "1.0",
        RequestId = request.RequestId,
        Success = false,
        Action = request.Action,
        ErrorCode = errorCode,
        ErrorMessage = errorMessage,
        ActionTarget = target,
        CandidateWindows = candidateWindows,
        Pid = identity.Pid,
        Hwnd = identity.Hwnd,
    };

    /// <summary>无法解析窗口时仍未确定目标，故用请求值报告边界。</summary>
    private static InspectResponse Failed(InspectRequest request, string errorCode, string errorMessage,
        List<CandidateWindowDto>? candidateWindows = null) =>
        Failed(request, errorCode, errorMessage,
            new ResolvedWindow(request.Pid, request.Hwnd ?? string.Empty), null, candidateWindows);

    private readonly record struct ResolvedWindow(int Pid, string Hwnd);
}
