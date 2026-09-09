"""Explicit environment for the opt-in, project-local Serena installation."""
import os
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
deps = repo / ".deps"
sdk = deps / "dotnet-10.0.303"
os.environ.update({
    "SERENA_HOME": str(deps / "serena-home"),
    "DOTNET_ROOT": str(sdk),
    "DOTNET_ROOT_X64": str(sdk),
    "DOTNET_CLI_HOME": str(deps / "dotnet-cli-home"),
    "NUGET_PACKAGES": str(deps / "nuget-packages"),
    "NUGET_HTTP_CACHE_PATH": str(deps / "nuget-http-cache"),
    "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
    "DOTNET_NOLOGO": "1",
    "DOTNET_GENERATE_ASPNET_CERTIFICATE": "false",
    "DOTNET_ADD_GLOBAL_TOOLS_TO_PATH": "false",
    "PATH": str(sdk) + os.pathsep + os.environ.get("PATH", ""),
})

# Import only after setting paths; upstream modules resolve directories on import.
from serena.cli import top_level

if __name__ == "__main__":
    top_level()
