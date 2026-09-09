using System.Reflection;
using System.Runtime.InteropServices;

/// <summary>自有 Host 的程序集身份；读取身份不加载项目，也不执行 MSBuild targets。</summary>
internal sealed record HostBuildIdentity(string Version, string? InformationalVersion,
    string? Configuration, string Framework, int ProtocolVersion)
{
    public static HostBuildIdentity Current { get; } = new(
        typeof(HostBuildIdentity).Assembly.GetName().Version?.ToString(3) ?? "unknown",
        typeof(HostBuildIdentity).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
        typeof(HostBuildIdentity).Assembly.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration,
        RuntimeInformation.FrameworkDescription, 2);
}
