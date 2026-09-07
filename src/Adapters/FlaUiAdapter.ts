import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IAdapter, AdapterHealth, AdapterLastError } from './IAdapter.js';
import { WinCodeConfig } from '../Core/Config.js';
import {
  ResourceManager,
  Mutex,
  TimeoutError,
  killProcessTree,
} from '../Core/ResourceManager.js';
import {
  UiInspectRequest,
  UiInspectResult,
  UiErrorCodes,
  UI_INSPECT_DEFAULTS,
} from '../Core/UiContracts.js';

export class FlaUiAdapter implements IAdapter {
  readonly name = 'FlaUiAdapter';
  readonly description =
    'Windows UI Automation (FlaUI.UIA3) runtime inspect adapter for bounded control tree and screenshot evidence.';

  private config: WinCodeConfig;
  private resources?: ResourceManager;
  private activeProcess: ChildProcess | null = null;
  private mutex = new Mutex();
  private shuttingDown = false;
  private healthCache: { at: number; value: AdapterHealth } | null = null;
  lastError: AdapterLastError | null = null;

  constructor(config: WinCodeConfig, resources?: ResourceManager) {
    this.config = config;
    this.resources = resources;
  }

  get isRunning(): boolean {
    return this.activeProcess !== null;
  }

  async initialize(): Promise<void> {
    const health = await this.checkHealth();
    if (!health.available && health.lastError) {
      this.lastError = health.lastError;
    }
  }

  resolveHostCommand(): { command: string; args: string[] } | null {
    if (this.config.adapters.flaui?.customHostPath) {
      const customPath = path.resolve(this.config.adapters.flaui.customHostPath);
      if (fs.existsSync(customPath)) {
        return { command: customPath, args: [] };
      }
    }

    const candidateExes = [
      path.resolve(this.config.workspaceRoot, 'tools/WinCode.UIA.Host/bin/Release/net10.0-windows/win-x64/publish/WinCode.UIA.Host.exe'),
      path.resolve(this.config.workspaceRoot, 'tools/WinCode.UIA.Host/bin/Debug/net10.0-windows/win-x64/WinCode.UIA.Host.exe'),
    ];

    for (const cand of candidateExes) {
      if (fs.existsSync(cand)) {
        return { command: cand, args: [] };
      }
    }

    // Fallback: dotnet run against project file if dotnet is available
    const projPath = path.resolve(this.config.workspaceRoot, 'tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj');
    if (fs.existsSync(projPath)) {
      return { command: 'dotnet', args: ['run', '--project', projPath, '--no-build', '--'] };
    }

    return null;
  }

  async checkHealth(timeoutMs?: number): Promise<AdapterHealth> {
    if (this.healthCache && Date.now() - this.healthCache.at < 5_000) {
      return this.healthCache.value;
    }

    if (process.platform !== 'win32') {
      const val: AdapterHealth = {
        available: false,
        source: 'unavailable',
        details: 'FlaUI UIA Host requires Windows OS.',
        lastError: {
          at: new Date().toISOString(),
          reason: 'unavailable',
          message: 'FlaUI UIA Host requires Windows OS.',
          recoverable: false,
        },
      };
      this.healthCache = { at: Date.now(), value: val };
      return val;
    }

    if (!this.config.adapters.flaui?.enabled) {
      const val: AdapterHealth = {
        available: false,
        source: 'unavailable',
        details: 'FlaUI adapter is disabled in configuration.',
      };
      this.healthCache = { at: Date.now(), value: val };
      return val;
    }

    const host = this.resolveHostCommand();
    if (!host) {
      const val: AdapterHealth = {
        available: false,
        source: 'unavailable',
        details: 'WinCode.UIA.Host binary or project was not found.',
        lastError: {
          at: new Date().toISOString(),
          reason: 'unavailable',
          message: 'WinCode.UIA.Host binary not found. Run dotnet publish first.',
          recoverable: true,
        },
      };
      this.healthCache = { at: Date.now(), value: val };
      return val;
    }

    const probeTimeout = timeoutMs ?? this.config.timeouts?.healthProbeMs ?? 3_000;
    try {
      const res = await this.executeHost(
        {
          schemaVersion: '1.0',
          requestId: 'health-probe',
          action: 'health',
          pid: 0,
        },
        probeTimeout
      );

      if (res.success && res.status === 'healthy') {
        const val: AdapterHealth = {
          available: true,
          source: 'installed',
          version: '1.0.0',
          details: 'WinCode.UIA.Host is available and responsive.',
        };
        this.healthCache = { at: Date.now(), value: val };
        return val;
      }

      throw new Error(res.errorMessage || 'Host probe failed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const val: AdapterHealth = {
        available: false,
        source: 'unavailable',
        details: `Host probe failed: ${msg}`,
        lastError: {
          at: new Date().toISOString(),
          reason: err instanceof TimeoutError ? 'timeout' : 'error',
          message: msg,
          recoverable: true,
        },
      };
      this.healthCache = { at: Date.now(), value: val };
      return val;
    }
  }

  async inspect(
    request: UiInspectRequest,
    signal?: AbortSignal
  ): Promise<UiInspectResult> {
    const requestId = request.requestId || randomUUID();
    const normRequest: UiInspectRequest & { requestId: string } = {
      ...request,
      requestId,
    };

    if (this.shuttingDown) {
      return {
        schemaVersion: '1.0',
        protocolVersion: '1.0',
        requestId,
        success: false,
        errorCode: UiErrorCodes.SHUTDOWN,
        errorMessage: 'WinCode is shutting down; UI inspection rejected.',
      };
    }

    if (process.platform !== 'win32') {
      return {
        schemaVersion: '1.0',
        protocolVersion: '1.0',
        requestId,
        success: false,
        errorCode: UiErrorCodes.PLATFORM_NOT_SUPPORTED,
        errorMessage: 'UI inspect is only supported on Windows.',
      };
    }

    if (!normRequest.pid && !normRequest.hwnd) {
      return {
        schemaVersion: '1.0',
        protocolVersion: '1.0',
        requestId,
        success: false,
        errorCode: UiErrorCodes.INVALID_ARGUMENT,
        errorMessage: 'Either pid or hwnd must be provided for UI inspection.',
      };
    }

    const effectiveTimeout =
      normRequest.timeoutMs ??
      this.config.adapters.flaui?.timeoutMs ??
      this.config.timeouts?.flauiInspectMs ??
      UI_INSPECT_DEFAULTS.TIMEOUT_MS;

    return this.mutex.runExclusive(async () => {
      if (this.shuttingDown) {
        return {
          schemaVersion: '1.0',
          protocolVersion: '1.0',
          requestId,
          success: false,
          errorCode: UiErrorCodes.SHUTDOWN,
          errorMessage: 'WinCode is shutting down; UI inspection rejected.',
        };
      }

      if (signal?.aborted) {
        return {
          schemaVersion: '1.0',
          protocolVersion: '1.0',
          requestId,
          success: false,
          errorCode: UiErrorCodes.CANCELLED,
          errorMessage: 'Inspection was cancelled before execution started.',
        };
      }

      return this.executeHost(normRequest, effectiveTimeout, signal);
    });
  }

  private async executeHost(
    request: UiInspectRequest & { requestId: string },
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<UiInspectResult> {
    const host = this.resolveHostCommand();
    if (!host) {
      return {
        schemaVersion: '1.0',
        protocolVersion: '1.0',
        requestId: request.requestId,
        success: false,
        errorCode: UiErrorCodes.HOST_UNAVAILABLE,
        errorMessage: 'WinCode.UIA.Host executable was not found.',
      };
    }

    const payload = JSON.stringify({
      schemaVersion: request.schemaVersion ?? '1.0',
      requestId: request.requestId,
      action: request.action ?? 'inspect',
      pid: request.pid,
      hwnd: request.hwnd,
      capture: request.capture ?? 'none',
      maxDepth: request.maxDepth ?? this.config.adapters.flaui?.maxDepth ?? UI_INSPECT_DEFAULTS.MAX_DEPTH,
      maxNodes: request.maxNodes ?? this.config.adapters.flaui?.maxNodes ?? UI_INSPECT_DEFAULTS.MAX_NODES,
      timeoutMs: timeoutMs,
    });

    let stdoutData = '';
    let stderrData = '';
    let childProc: ChildProcess | null = null;
    let timer: NodeJS.Timeout | null = null;
    let resourceId: string | null = null;

    const killHelperOnly = async () => {
      if (!childProc) return;
      const procToKill = childProc;
      childProc = null;
      this.activeProcess = null;
      try {
        await killProcessTree(procToKill);
      } catch {
        // Safe catch: only helper process is targeted
      }
    };

    const runPromise = new Promise<UiInspectResult>((resolve, reject) => {
      try {
        childProc = spawn(host.command, host.args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: this.config.workspaceRoot,
        });

        this.activeProcess = childProc;

        if (this.resources && childProc.pid) {
          resourceId = this.resources.registerProcess('FlaUiAdapter', childProc);
        }

        const maxBytes = UI_INSPECT_DEFAULTS.MAX_JSON_BYTES;

        childProc.stdout?.on('data', (chunk: Buffer) => {
          stdoutData += chunk.toString('utf8');
          if (stdoutData.length > maxBytes) {
            void killHelperOnly();
            reject(new Error(`Host stdout exceeded budget limit of ${maxBytes} bytes.`));
          }
        });

        childProc.stderr?.on('data', (chunk: Buffer) => {
          if (stderrData.length < 64 * 1024) {
            stderrData += chunk.toString('utf8');
          }
        });

        childProc.on('error', (err) => {
          this.activeProcess = null;
          reject(err);
        });

        childProc.on('close', (code) => {
          this.activeProcess = null;
          if (signal?.aborted) {
            resolve({
              schemaVersion: '1.0',
              protocolVersion: '1.0',
              requestId: request.requestId,
              success: false,
              errorCode: UiErrorCodes.CANCELLED,
              errorMessage: 'UI inspection was cancelled.',
            });
            return;
          }
          if (!stdoutData.trim()) {
            resolve({
              schemaVersion: '1.0',
              protocolVersion: '1.0',
              requestId: request.requestId,
              success: false,
              errorCode: UiErrorCodes.HOST_ERROR,
              errorMessage: `Host exited with code ${code} without output. Stderr: ${stderrData.slice(0, 500)}`,
            });
            return;
          }

          try {
            const parsed = JSON.parse(stdoutData.trim()) as UiInspectResult;
            if (parsed.protocolVersion && parsed.protocolVersion !== '1.0') {
              resolve({
                schemaVersion: '1.0',
                protocolVersion: '1.0',
                requestId: request.requestId,
                success: false,
                errorCode: UiErrorCodes.VERSION_MISMATCH,
                errorMessage: `Host returned unsupported protocol version: ${parsed.protocolVersion}`,
              });
              return;
            }
            resolve(parsed);
          } catch (jsonErr) {
            resolve({
              schemaVersion: '1.0',
              protocolVersion: '1.0',
              requestId: request.requestId,
              success: false,
              errorCode: UiErrorCodes.HOST_ERROR,
              errorMessage: `Failed to parse host JSON output: ${(jsonErr as Error).message}. Output head: ${stdoutData.slice(0, 300)}`,
            });
          }
        });

        // Write request payload to stdin
        childProc.stdin?.write(payload, 'utf8');
        childProc.stdin?.end();
      } catch (spawnErr) {
        reject(spawnErr);
      }
    });

    const abortHandler = () => {
      void killHelperOnly();
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const timeoutPromise = new Promise<UiInspectResult>((_, reject) => {
      timer = setTimeout(async () => {
        await killHelperOnly();
        reject(new TimeoutError('FlaUiAdapter', timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([runPromise, timeoutPromise]);
    } catch (err) {
      await killHelperOnly();
      const isCancelled = signal?.aborted;
      const isTimeout = err instanceof TimeoutError;
      const isPayloadTooLarge = String(err).includes('exceeded budget limit');
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = {
        at: new Date().toISOString(),
        reason: isCancelled ? 'cancelled' : isTimeout ? 'timeout' : 'error',
        message: msg,
        recoverable: true,
      };

      let errorCode: string = UiErrorCodes.HOST_ERROR;
      if (isCancelled) errorCode = UiErrorCodes.CANCELLED;
      else if (isTimeout) errorCode = UiErrorCodes.TIMEOUT;
      else if (isPayloadTooLarge) errorCode = UiErrorCodes.PAYLOAD_TOO_LARGE;

      return {
        schemaVersion: '1.0',
        protocolVersion: '1.0',
        requestId: request.requestId,
        success: false,
        errorCode,
        errorMessage: isCancelled ? 'UI inspection was cancelled.' : msg,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortHandler);
      if (resourceId && this.resources) {
        this.resources.unregister(resourceId);
      }
      this.activeProcess = null;
    }
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    if (this.activeProcess) {
      const proc = this.activeProcess;
      this.activeProcess = null;
      try {
        await killProcessTree(proc);
      } catch {
        // Safe termination
      }
    }
  }
}
