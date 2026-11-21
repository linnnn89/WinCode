import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A reviewable launch recipe only: no client discovery, registration, process spawn or workspace change. */
export function connectionGuide(workspace?: string) {
  const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
  if (workspace === undefined) return {
    workspace: null,
    configuration: { command: process.execPath, args: [entry, '--dynamic-workspace'] },
    verification: { tool: 'wincode_hello_world', arguments: {}, expectedMode: 'dynamic' },
    nextAction: 'Pass the absolute current task directory as workspacePath on each project tool call. workspace_open takes path.',
  };
  const root = path.resolve(workspace);
  return {
    workspace: root,
    configuration: { command: process.execPath,
      args: [entry, '--workspace', root] },
    verification: { tool: 'wincode_hello_world', arguments: {}, expectedWorkspace: root },
    codeProvider: 'local-text',
    nextAction: 'Select an existing connection for this workspace, or configure a separate STDIO connection using configuration. Then verify its workspace.',
    limitations: 'This recipe does not check directory existence or create a connection. It uses default local-text settings; project-specific Roslyn, development and Tray options are not copied.',
  };
}
