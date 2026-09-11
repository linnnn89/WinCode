using Microsoft.Build.Evaluation;
using Microsoft.Build.Construction;
using Microsoft.Build.Globbing;
using System.Text;
using System.Xml.Linq;

// Candidate revision: evaluate the original project without running targets, then preserve its exclusions.
internal sealed class BuildLayout
{
    private readonly List<(string Path, bool CustomCompile, IMSBuildGlob[] Globs, HashSet<string> Explicit)> outputs = [];
    internal readonly List<string> PrivateDirectories = [];
    internal string Hook { get; private set; } = "";
    internal static BuildLayout? Current;
    internal static bool IsCandidate(string file)
    {
        if (Current == null || !Path.GetExtension(file).Equals(".cs", StringComparison.OrdinalIgnoreCase)) return true;
        var matched = false;
        foreach (var entry in Current.outputs)
            if (file.StartsWith(entry.Path, StringComparison.OrdinalIgnoreCase))
            {
                matched = true;
                if (entry.CustomCompile || entry.Explicit.Contains(file) || entry.Globs.Any(glob => glob.IsMatch(file))) return true;
            }
        return !matched;
    }

    internal static BuildLayout Prepare(string root, string projectPath, string configuration, string framework, string identity, CancellationToken token)
    {
        var result = new BuildLayout();
        var xml = new XElement("Project");
        using var collection = new ProjectCollection(new Dictionary<string, string> {
            ["Configuration"] = configuration, ["TargetFramework"] = framework,
            ["DesignTimeBuild"] = "true", ["BuildingInsideVisualStudio"] = "true"
        });
        var pending = new Stack<string>(); pending.Push(projectPath);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (pending.TryPop(out var path))
        {
            token.ThrowIfCancellationRequested(); path = WorkspaceInputs.Inside(root, path);
            if (!seen.Add(path)) continue;
            if (seen.Count > 64) throw new HostFailure("INPUT_BUDGET_EXCEEDED", "More than 64 project layouts.");
            var project = collection.LoadProject(path);
            var directory = Path.GetDirectoryName(path)!;
            var intermediate = WorkspaceInputs.Inside(root, Path.GetFullPath(project.GetPropertyValue("IntermediateOutputPath"), directory));
            if (string.Equals(intermediate, directory, StringComparison.OrdinalIgnoreCase))
                throw new HostFailure("INVALID_ARGUMENT", "Intermediate output cannot be the project directory.");
            var customCompile = new[] { project.Xml }.Concat(project.Imports.Select(i => i.ImportedProject)).Any(document =>
                !document.FullPath.StartsWith(collection.Toolsets.First().ToolsPath, StringComparison.OrdinalIgnoreCase) &&
                document.AllChildren.OfType<ProjectItemElement>().Any(item => item.ItemType == "Compile" && item.Include.Length != 0));
            var globs = project.GetAllGlobs("Compile").Select(glob => glob.MsBuildGlob).ToArray();
            var explicitFiles = project.GetItems("Compile").Select(item => Path.GetFullPath(item.EvaluatedInclude, directory)).ToHashSet(StringComparer.OrdinalIgnoreCase);
            result.outputs.Add((intermediate.TrimEnd('\\', '/') + Path.DirectorySeparatorChar, customCompile, globs, explicitFiles));
            // Other configurations under the same base are excluded by default SDK Compile globs too.
            var baseIntermediate = WorkspaceInputs.Inside(root, Path.GetFullPath(project.GetPropertyValue("BaseIntermediateOutputPath"), directory));
            if (!string.Equals(baseIntermediate, directory, StringComparison.OrdinalIgnoreCase))
                result.outputs.Add((baseIntermediate.TrimEnd('\\', '/') + Path.DirectorySeparatorChar, customCompile, globs, explicitFiles));
            var condition = $"'$(MSBuildProjectFullPath)' == '{ProjectCollection.Escape(path)}'";
            var originalHook = project.Imports.FirstOrDefault(import =>
                import.ImportingElement.Project == "$(CustomBeforeMicrosoftCommonTargets)").ImportedProject?.FullPath;
            if (originalHook != null)
                xml.Add(new XElement("Import", new XAttribute("Project", originalHook),
                    new XAttribute("Condition", condition + $" And Exists('{ProjectCollection.Escape(originalHook)}')")));
            xml.Add(new XElement("PropertyGroup", new XAttribute("Condition", condition),
                new XElement("DefaultItemExcludes", "$(DefaultItemExcludes);" + ProjectCollection.Escape(intermediate.Replace('\\', '/')) + "/**")));
            result.PrivateDirectories.Add(WorkspaceInputs.Inside(root, Path.Combine(directory, ".cache/wincode-msbuild", identity)));
            foreach (var reference in project.GetItems("ProjectReference")) pending.Push(Path.GetFullPath(reference.EvaluatedInclude, directory));
        }
        var storage = WorkspaceInputs.Inside(root, Path.Combine(root, ".cache/wincode-build", identity));
        OwnedBuildOutputs.Record(root, identity, result.PrivateDirectories);
        Directory.CreateDirectory(storage);
        result.Hook = Path.Combine(storage, "preserve.targets");
        File.WriteAllText(result.Hook, xml.ToString(), new UTF8Encoding(false));
        Current = result;
        return result;
    }
}
