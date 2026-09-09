using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

/// <summary>
/// 一个工作区的串行语义会话；加载、重载和引用操作不能并发修改本对象。
/// 监听只提供变化提示，查询前后仍检查内容指纹。加载失败后保留失效状态，禁止返回旧证据。
/// </summary>
internal sealed class WorkspaceSession : IDisposable
{
    private readonly string root, projectPath, configuration, framework;
    private readonly FileSystemWatcher watcher;
    private MSBuildWorkspace? workspace;
    private Solution? solution;
    private WorkspaceInputs? inputs;
    private string[] extraFiles = [];
    private string? sdkSelection;
    private string? snapshot;
    private volatile bool invalidated = true;
    private volatile string? watchError;
    private Exception? cleanupFailure;
    private long generation;
    private long configurationGeneration;
    private int excludedAnalyzers;
    private string[] loadDiagnostics = [], compilationErrors = [];

    /// <summary>绑定固定根及配置并启动监听；不在构造时执行 MSBuild，求值由 ReloadAsync 显式启动。</summary>
    public WorkspaceSession(string root, string projectPath, string configuration, string framework)
    {
        this.root = root; this.projectPath = projectPath; this.configuration = configuration; this.framework = framework;
        watcher = new(root) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size };
        watcher.Changed += (_, e) => Changed(e.FullPath);
        watcher.Created += (_, e) => Changed(e.FullPath);
        watcher.Deleted += (_, e) => Changed(e.FullPath);
        watcher.Renamed += (_, e) => { Changed(e.OldFullPath); Changed(e.FullPath); };
        watcher.Error += (_, e) => { watchError = e.GetException().Message; Interlocked.Increment(ref generation); };
        watcher.EnableRaisingEvents = true;
    }

    /// <summary>立即推进变更代次，不防抖；重载仅由显式请求执行，避免每个保存事件都运行 targets。</summary>
    private void Changed(string file)
    {
        if (!WorkspaceInputs.IsIgnored(root, file))
        {
            Interlocked.Increment(ref generation);
            if (Path.GetExtension(file).ToLowerInvariant() is ".csproj" or ".props" or ".targets" or ".json" or ".config")
                Interlocked.Increment(ref configurationGeneration);
        }
    }

    /// <summary>监听或清理失败不可通过重新使用旧会话恢复，要求所属 Host 重启。</summary>
    private void CheckHealth()
    {
        if (watchError != null || cleanupFailure != null)
            throw new HostFailure("HOST_RESTART_REQUIRED", watchError ?? cleanupFailure!.Message);
    }

    /// <summary>校验窗口内事件代次没有变化；散列期间有写入则拒绝这个不稳定检查点。</summary>
    private async Task<WorkspaceInputs> CaptureAsync(CancellationToken token, bool checkEvents = true)
    {
        CheckHealth();
        var before = Interlocked.Read(ref generation);
        var captured = await WorkspaceInputs.CaptureAsync(root, extraFiles, token);
        CheckHealth();
        if (checkEvents && before != Interlocked.Read(ref generation))
            throw new HostFailure("INPUTS_CHANGED", "Inputs changed while reading; reload after writes finish.");
        if (sdkSelection != null && captured.SdkSelection != sdkSelection)
            throw new HostFailure("HOST_RESTART_REQUIRED", "global.json changed; restart Host to select MSBuild again.");
        return captured;
    }

    /// <summary>
    /// 废弃旧快照后重新加载。至多两次尝试，用于首次设计时生成文件/发现元数据的稳定化。
    /// 取消、文件变化或加载失败都不恢复旧身份。SDK 选择变化需要新进程，不能本进程热切换。
    /// </summary>
    public async Task<object> ReloadAsync(string? id, CancellationToken token)
    {
        invalidated = true;
        CheckHealth();
        ReleaseWorkspace();
        // 删除的旧文档必须使查询失效，但不能阻止新项目模型重新发现当前输入集合。
        extraFiles = extraFiles.Where(File.Exists).ToArray();
        var clock = Stopwatch.StartNew();
        for (var attempt = 0; attempt < 2; attempt++)
        {
            token.ThrowIfCancellationRequested();
            // 设计时构建会触碰 obj 缓存；加载阶段按内容比较，另单独拒绝配置求值期间的配置写入。
            var configurationBefore = Interlocked.Read(ref configurationGeneration);
            var before = await CaptureAsync(token, checkEvents: false);
            sdkSelection ??= before.SdkSelection;
            workspace = MSBuildWorkspace.Create(new Dictionary<string, string> {
                ["Configuration"] = configuration, ["TargetFramework"] = framework,
                ["RunAnalyzers"] = "false", ["RunAnalyzersDuringBuild"] = "false"
            });
            try
            {
                await workspace.OpenProjectAsync(projectPath, cancellationToken: token);
                // OpenProjectAsync 可能返回部分项目而不抛异常；结构化加载失败不能伪装成 ready。
                ReadLoadDiagnostics();
                var candidate = workspace.CurrentSolution;
                excludedAnalyzers = candidate.Projects.Sum(p => p.AnalyzerReferences.Count);
                var required = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var project in candidate.Projects.ToArray())
                {
                    required.Add(WorkspaceInputs.Inside(root, project.FilePath!));
                    foreach (var document in project.Documents) required.Add(WorkspaceInputs.Inside(root, document.FilePath!));
                    foreach (var metadata in project.MetadataReferences.OfType<PortableExecutableReference>())
                        if (metadata.FilePath != null) required.Add(metadata.FilePath);
                    candidate = candidate.WithProjectAnalyzerReferences(project.Id, []);
                }
                extraFiles = required.ToArray();
                var captured = await CaptureAsync(token, checkEvents: false);
                if (before.Fingerprint != captured.Fingerprint)
                {
                    ReleaseWorkspace();
                    if (attempt == 0) continue;
                    throw new HostFailure("INPUTS_CHANGED", "Inputs did not stabilize during load.");
                }
                // 显式固定每份文档文本，防止 FileTextLoader 在首次查询时才读取更新后的磁盘文件。
                foreach (var document in candidate.Projects.SelectMany(p => p.Documents).ToArray())
                {
                    using var content = new MemoryStream(captured.Files[document.FilePath!], false);
                    candidate = candidate.WithDocumentText(document.Id, SourceText.From(content, Encoding.UTF8, throwIfBinaryDetected: true));
                }
                var errors = new List<string>();
                foreach (var project in candidate.Projects)
                {
                    var compilation = await project.GetCompilationAsync(token);
                    errors.AddRange(compilation!.GetDiagnostics(token).Where(d => d.Severity == DiagnosticSeverity.Error).Take(20).Select(d => d.ToString()));
                }
                var after = await CaptureAsync(token, checkEvents: false);
                if (captured.Fingerprint != after.Fingerprint || configurationBefore != Interlocked.Read(ref configurationGeneration))
                    throw new HostFailure("INPUTS_CHANGED", "Inputs changed during compilation.");
                var completedDiagnostics = ReadLoadDiagnostics();
                solution = candidate;
                // 稳定快照只保留摘要，文档已固定；不长期保留 SDK/包程序集的大块字节数组。
                inputs = after with { Files = new Dictionary<string, byte[]>() };
                snapshot = Guid.NewGuid().ToString("N");
                loadDiagnostics = completedDiagnostics;
                compilationErrors = errors.ToArray();
                invalidated = false;
                return new { id, type = "ready", success = true, protocolVersion = 2, snapshot,
                    projects = candidate.ProjectIds.Count, configuration, framework, loadMs = clock.ElapsedMilliseconds,
                    loadDiagnostics, compilationErrors, excludedAnalyzers, scope = "loaded-solution-snapshot",
                    processTreeGuard = OperatingSystem.IsWindows(), diskFreshnessVerified = false, freshness = Freshness(after) };
            }
            catch { ReleaseWorkspace(); throw; }
        }
        throw new HostFailure("INPUTS_CHANGED", "Reload required.");
    }

    /// <summary>按 Roslyn 的诊断类别拒绝项目加载失败；源码编译错误由 compilationErrors 单独保留。</summary>
    private string[] ReadLoadDiagnostics()
    {
        var diagnostics = workspace!.Diagnostics.ToArray();
        var failures = diagnostics.Where(d => d.Kind == WorkspaceDiagnosticKind.Failure).Take(20).ToArray();
        if (failures.Length > 0)
            throw new HostFailure("PROJECT_LOAD_FAILED", string.Join(Environment.NewLine, failures.Select(d => d.ToString())));
        return diagnostics.Select(d => d.ToString()).ToArray();
    }

    /// <summary>描述检查的明确范围；自定义 targets 的任意外部输入、环境与整个磁盘不在保证范围内。</summary>
    private static object Freshness(WorkspaceInputs value) => new {
        status = "checked", scope = "workspace-files-loaded-metadata-and-ancestor-config",
        fingerprint = value.Fingerprint, files = value.FileCount, bytes = value.Bytes,
        externalCustomInputsVerified = false
    };

    /// <summary>比较当前输入与已加载模型；任何读取失败或变化都会使该身份永久失效，直到显式 reload。</summary>
    private async Task EnsureCurrentAsync(string requestedSnapshot, CancellationToken token)
    {
        if (invalidated || snapshot != requestedSnapshot || inputs == null || solution == null)
            throw new HostFailure("SNAPSHOT_STALE", "Snapshot expired; reload and relocate the symbol.");
        try
        {
            var current = await CaptureAsync(token);
            if (current.Fingerprint != inputs.Fingerprint)
                throw new HostFailure("SNAPSHOT_STALE", "Workspace inputs changed; reload and relocate the symbol.");
        }
        catch (OperationCanceledException) { throw; }
        catch (IOException error) { invalidated = true; throw new HostFailure("SNAPSHOT_STALE", "Tracked input unavailable: " + error.Message); }
        catch { invalidated = true; throw; }
    }

    /// <summary>
    /// 在固定编译上下文中检索声明，返回可直接用于引用的声明标识符偏移。
    /// partial 声明按同项目 ISymbol 去重；不同项目仍保留独立身份。截断与生成器缺口不隐瞒。
    /// </summary>
    public async Task<object> SymbolsAsync(JsonElement request, CancellationToken token)
    {
        var requestedSnapshot = request.GetProperty("snapshot").GetString()!;
        await EnsureCurrentAsync(requestedSnapshot, token);
        var query = request.GetProperty("query").GetString();
        if (string.IsNullOrWhiteSpace(query) || query.Length > 256) throw new HostFailure("INVALID_ARGUMENT", "Query must contain 1–256 characters.");
        var kind = request.TryGetProperty("kind", out var filter) ? filter.GetString() : null;
        var scopeFile = request.TryGetProperty("file", out var file) ? WorkspaceInputs.Inside(root, file.GetString()!) : null;
        var symbols = new List<object>();
        var totalFound = 0;
        foreach (var project in solution!.Projects.OrderBy(p => p.FilePath, StringComparer.OrdinalIgnoreCase))
        {
            var seen = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            foreach (var document in project.Documents.OrderBy(d => d.FilePath, StringComparer.OrdinalIgnoreCase))
            {
                if (scopeFile != null && !string.Equals(scopeFile, document.FilePath, StringComparison.OrdinalIgnoreCase)) continue;
                var syntax = await document.GetSyntaxRootAsync(token);
                var model = await document.GetSemanticModelAsync(token);
                foreach (var node in syntax!.DescendantNodes().OfType<MemberDeclarationSyntax>())
                {
                    token.ThrowIfCancellationRequested();
                    if (node is not (BaseTypeDeclarationSyntax or DelegateDeclarationSyntax or MethodDeclarationSyntax or ConstructorDeclarationSyntax or PropertyDeclarationSyntax)) continue;
                    var originalDeclaration = model!.GetDeclaredSymbol(node, token);
                    var declared = originalDeclaration;
                    if (declared is IMethodSymbol method) declared = method.PartialDefinitionPart ?? method;
                    if (declared == null || !declared.Name.Contains(query, StringComparison.OrdinalIgnoreCase) || !seen.Add(declared)) continue;
                    var declaredKind = DeclarationKind(declared);
                    if (declaredKind == null || (!string.IsNullOrEmpty(kind) && kind != declaredKind && !(kind == "type" && declared is INamedTypeSymbol))) continue;
                    // 限定 partial 所在文件时使用该声明的源位置；不能偷偷改成另一个文件里的首个声明。
                    var location = scopeFile == null ? declared.Locations.FirstOrDefault(l => l.IsInSource) :
                        originalDeclaration!.Locations.FirstOrDefault(l => l.IsInSource && string.Equals(l.SourceTree?.FilePath, scopeFile, StringComparison.OrdinalIgnoreCase));
                    if (location == null) continue;
                    var position = location.GetLineSpan().StartLinePosition;
                    totalFound++;
                    if (symbols.Count == 200) continue;
                    symbols.Add(new { name = declared.Name, kind = declaredKind,
                        file = Path.GetRelativePath(root, location.SourceTree!.FilePath), line = position.Line + 1, column = position.Character + 1,
                        signature = declared.ToDisplayString(), containerName = declared.ContainingType?.ToDisplayString(),
                        location = new { snapshotId = snapshot, project = Path.GetRelativePath(root, project.FilePath!),
                            file = Path.GetRelativePath(root, location.SourceTree.FilePath), position = location.SourceSpan.Start } });
                }
            }
        }
        await EnsureCurrentAsync(requestedSnapshot, token);
        return new { id = request.GetProperty("id").GetString(), success = true, snapshot, symbols, totalFound,
            truncated = totalFound > symbols.Count, queryComplete = false, loadDiagnostics, compilationErrors, excludedAnalyzers,
            scope = "loaded-solution-snapshot", diskFreshnessVerified = false, freshness = Freshness(inputs!) };
    }

    /// <summary>映射当前公共声明类别；没有支持的成员不伪装成方法或类型。</summary>
    private static string? DeclarationKind(ISymbol symbol) => symbol switch {
        INamedTypeSymbol type => type.TypeKind switch { TypeKind.Class => "class", TypeKind.Interface => "interface", TypeKind.Struct => "struct", TypeKind.Enum => "enum", TypeKind.Delegate => "type", _ => null },
        IMethodSymbol => "method", IPropertySymbol => "property", _ => null
    };

    /// <summary>
    /// 在指定项目的文档中以零基 UTF-16 偏移定位符号，返回一基行列和原始 span。
    /// 查询前后都验证输入；结束时变更则丢弃计算结果，绝不附带旧引用作为成功响应。
    /// </summary>
    public async Task<object> ReferencesAsync(JsonElement request, CancellationToken token)
    {
        var clock = Stopwatch.StartNew();
        var requestedSnapshot = request.GetProperty("snapshot").GetString()!;
        await EnsureCurrentAsync(requestedSnapshot, token);
        var requestedProject = WorkspaceInputs.Inside(root, request.GetProperty("project").GetString()!);
        var file = WorkspaceInputs.Inside(root, request.GetProperty("file").GetString()!);
        var project = solution!.Projects.SingleOrDefault(p => string.Equals(p.FilePath, requestedProject, StringComparison.OrdinalIgnoreCase))
            ?? throw new HostFailure("INVALID_ARGUMENT", "Project is not in the loaded snapshot.");
        var document = project.Documents.SingleOrDefault(d => string.Equals(d.FilePath, file, StringComparison.OrdinalIgnoreCase))
            ?? throw new HostFailure("INVALID_ARGUMENT", "Document is not in the selected project.");
        var position = request.GetProperty("position").GetInt32();
        var limit = request.TryGetProperty("limit", out var value) ? value.GetInt32() : 100;
        if (limit < 1 || limit > 1000) throw new HostFailure("INVALID_ARGUMENT", "Invalid limit.");
        var text = await document.GetTextAsync(token);
        if (position < 0 || position >= text.Length) throw new HostFailure("INVALID_ARGUMENT", "Invalid UTF-16 position.");
        var symbol = await SymbolFinder.FindSymbolAtPositionAsync(document, position, token)
            ?? throw new HostFailure("SYMBOL_NOT_FOUND", "No symbol at position.");
        if (request.TryGetProperty("symbolName", out var expected) && symbol.Name != expected.GetString())
            throw new HostFailure("SYMBOL_MISMATCH", "Location does not identify the requested symbol; search again.");
        var found = await SymbolFinder.FindReferencesAsync(symbol, solution, token);
        var locations = found.SelectMany(r => r.Locations).Where(r => r.Location.IsInSource)
            .DistinctBy(r => (r.Document.Id, r.Location.SourceSpan)).ToArray();
        var references = new List<object>();
        foreach (var location in locations.Take(limit))
        {
            var source = await location.Document.GetTextAsync(token);
            var span = location.Location.SourceSpan;
            var lineSpan = source.Lines.GetLinePositionSpan(span);
            var preview = source.Lines[lineSpan.Start.Line].ToString();
            references.Add(new { project = Path.GetRelativePath(root, location.Document.Project.FilePath!),
                file = Path.GetRelativePath(root, location.Document.FilePath!), start = span.Start, length = span.Length,
                line = lineSpan.Start.Line + 1, column = lineSpan.Start.Character + 1, preview = preview[..Math.Min(300, preview.Length)] });
        }
        await EnsureCurrentAsync(requestedSnapshot, token);
        return new { id = request.GetProperty("id").GetString(), success = true, snapshot, symbol = symbol.ToDisplayString(), references,
            totalReferences = locations.Length, truncated = locations.Length > limit,
            queryComplete = false, loadDiagnostics, compilationErrors, excludedAnalyzers,
            scope = "loaded-solution-snapshot", diskFreshnessVerified = false, freshness = Freshness(inputs!),
            queryMs = clock.ElapsedMilliseconds, workingSetBytes = Environment.WorkingSet };
    }

    /// <summary>释放当前 MSBuildWorkspace；失败留存，禁止后续重载伪装成清理成功。</summary>
    private void ReleaseWorkspace()
    {
        var previous = workspace;
        workspace = null;
        solution = null;
        inputs = null;
        if (previous == null) return;
        try { previous.Dispose(); }
        catch (Exception error) { cleanupFailure = error; throw new HostFailure("HOST_RESTART_REQUIRED", error.Message); }
    }

    /// <summary>关闭监听与工作区；调用方必须先排空当前操作。失败向 Host 退出状态传播。</summary>
    public void Dispose()
    {
        invalidated = true;
        try { watcher.Dispose(); }
        catch (Exception error) { cleanupFailure ??= error; }
        finally { ReleaseWorkspace(); }
        if (cleanupFailure != null) throw new HostFailure("HOST_RESTART_REQUIRED", cleanupFailure.Message);
    }
}
