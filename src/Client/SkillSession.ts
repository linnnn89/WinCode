import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTimeout } from '../Core/ResourceManager.js';

export interface SkillSessionOptions {
  workspace: string;
  /** An explicitly approved existing Roslyn launch configuration; never discovered from the workspace. */
  roslynConfig?: string;
}

/** SDK close() may return after signalling the child. Observe the actual transport close as well. */
class ObservedTransport extends StdioClientTransport {
  private exitedResolve!: () => void;
  readonly exited = new Promise<void>(resolve => { this.exitedResolve = resolve; });
  override async start(): Promise<void> {
    const previous = this.onclose;
    this.onclose = () => { this.exitedResolve(); previous?.(); };
    await super.start();
  }
}

function absolute(value: string, name: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return path.resolve(value);
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
}

/** A caller can cancel its wait without cancelling another caller's shared connection attempt. */
async function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

/**
 * Importing/constructing this object creates no process, timer, file or connection.
 * Keep one object in the caller's persistent execution context. It never reconnects or replays a call.
 */
export class WinCodeSession {
  readonly workspace: string;
  private readonly roslynConfig?: string;
  private readonly shutdown = new AbortController();
  private client?: Client;
  private transport?: ObservedTransport;
  private connection?: Promise<void>;
  private closing?: Promise<void>;
  private disposal?: Promise<void>;
  private state: 'unused' | 'connecting' | 'connected' | 'failed' | 'closing' | 'closed' = 'unused';
  private stderr = '';
  private failure?: Error;
  private identity: { instanceId: string; buildId: string; schemaHash: string } | null = null;

  constructor(options: SkillSessionOptions) {
    this.workspace = absolute(options.workspace, 'workspace');
    if (options.roslynConfig !== undefined) this.roslynConfig = absolute(options.roslynConfig, 'roslynConfig');
  }

  /** Local observation only; unlike call('wincode_hello_world'), this never opens the session. */
  get status() {
    return { state: this.state, workspace: this.workspace, pid: this.transport?.pid ?? null,
      identity: this.identity ? { ...this.identity } : null, error: this.failure?.message ?? null };
  }

  async call(name: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Supply a tool name.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
    const timeout = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 180_000) throw new Error('timeoutMs must be 1–180000.');
    if (['failed', 'closing', 'closed'].includes(this.state)) throw this.failure ?? new Error('Session is closed; create a new session explicitly.');
    const deadline = Date.now() + timeout;
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    this.connection ??= this.connect();
    await waitFor(this.connection, signal);
    signal.throwIfAborted();
    // Return every MCP content block and isError unchanged. Tool failures are not transport failures.
    return this.client!.callTool({ name, arguments: args }, { signal, timeout: Math.max(1, deadline - Date.now()) });
  }

  private async connect(): Promise<void> {
    this.state = 'connecting';
    try {
      const root = fileURLToPath(new URL('../../', import.meta.url));
      const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/build-manifest.json'), 'utf8'));
      if (!/^[a-f0-9]{64}$/.test(manifest.buildId)) throw new Error('Build WinCode before opening a Skill session.');
      this.shutdown.signal.throwIfAborted();
      const args = [path.join(root, 'dist/index.js'), '--workspace', this.workspace];
      if (this.roslynConfig) args.push('--roslyn-config', this.roslynConfig);
      this.transport = new ObservedTransport({ command: process.execPath, args, cwd: root, stderr: 'pipe' });
      this.transport.stderr!.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
      this.client = new Client({ name: 'wincode-skill-session', version: '1' });
      this.client.onclose = () => {
        if (!this.closing && this.state !== 'failed') {
          this.state = 'failed';
          this.failure = new Error('WinCode connection closed; create a new session and search again.');
        }
      };
      await this.client.connect(this.transport, { signal: this.shutdown.signal, timeout: 30_000 });
      const result = await this.client.callTool({ name: 'wincode_hello_world', arguments: {} },
        { signal: this.shutdown.signal, timeout: 30_000 });
      const text = result.content.find(item => item.type === 'text');
      const hello = text?.type === 'text' ? JSON.parse(text.text) : null;
      if (result.isError || !hello || typeof hello.workspace !== 'string' || !samePath(hello.workspace, this.workspace)
        || hello.runtime?.build?.status !== 'verified' || hello.runtime.build.buildId !== manifest.buildId
        || hello.codeProvider !== (this.roslynConfig ? 'roslyn' : 'local-text'))
        throw new Error('WinCode connection identity does not match the requested workspace, build or provider.');
      this.shutdown.signal.throwIfAborted();
      this.identity = { instanceId: hello.runtime.instanceId, buildId: hello.runtime.build.buildId, schemaHash: hello.toolContract.schemaHash };
      this.state = 'connected';
    } catch (error) {
      this.failure = new Error(`${error instanceof Error ? error.message : String(error)}${this.stderr ? `\n${this.stderr}` : ''}`);
      this.state = 'failed';
      try { await this.disposeTransport(); }
      catch (cleanup) { this.failure = new AggregateError([this.failure, cleanup], 'Skill connection and cleanup failed.'); }
      throw this.failure;
    }
  }

  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.state = 'closing';
    this.shutdown.abort(new Error('Skill session closed.'));
    await this.connection?.catch(() => {});
    await this.disposeTransport();
    this.state = 'closed';
  }

  private disposeTransport(): Promise<void> {
    this.disposal ??= (async () => {
      if (!this.transport) return;
      const started = this.transport.pid !== null;
      try { await this.client?.close(); }
      finally { await this.transport.close(); }
      if (started) await withTimeout(this.transport.exited, 8000, 'Skill Gateway exit');
    })();
    return this.disposal;
  }
}
