import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IAdapter, AdapterHealth, AdapterLastError } from './IAdapter.js';
import { WinCodeConfig } from '../Core/Config.js';
import {
  ResourceManager,
  Mutex,
  TimeoutError,
  AbortError,
  killProcessTree,
} from '../Core/ResourceManager.js';
import {
  UiInspectRequest,
  validateUiQuery,
  UiInspectResult,
  UiErrorCodes,
  UI_INSPECT_DEFAULTS,
  UiListWindowsRequest, validateWindowQuery,
} from '../Core/UiContracts.js';

export class FlaUiAdapter implements IAdapter {
  readonly name = 'FlaUiAdapter';
  readonly description =
    'Windows UI Automation (FlaUI.UIA3) runtime inspect adapter for bounded control tree and screenshot evidence.';

  private config: WinCodeConfig;
  private resources?: ResourceManager;
  private activeProcess: ChildProcess | null = null;
  private cleanupActive: (() => Promise<boolean>) | null = null;
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
      throw new Error(`Configured customHostPath "${customPath}" was not found.`);
    }

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const installRoot = path.resolve(currentDir, '../..');

    const candidateExes = [
      path.resolve(installRoot, 'tools/WinCode.UIA.Host/bin/Release/net10.0-windows/win-x64/publish/WinCode.UIA.Host.exe'),
      path.resolve(installRoot, 'tools/WinCode.UIA.Host/bin/Debug/net10.0-windows/win-x64/WinCode.UIA.Host.exe'),
    ];

    for (const cand of candidateExes) {
      if (fs.existsSync(cand)) {
        return { command: cand, args: [] };
      }
    }

    // Fallback: dotnet run against project file if dotnet is available
    const projPath = path.resolve(installRoot, 'tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj');
    if (fs.existsSync(projPath)) {
      return { command: 'dotnet', args: ['run', '--project', projPath, '--no-build', '--'] };
    }

    return null;
  }

  async checkHealth(timeoutMs?: number): Promise<AdapterHealth> {
    const health = await this.probeHealth(timeoutMs);
    // Availability and recent operation failure are different facts. A successful/cached
    // health probe must not erase a recent inspect timeout or cleanup failure.
    const latest = [health.lastError, this.lastError].filter(Boolean)
      .sort((a, b) => b!.at.localeCompare(a!.at))[0];
    return { ...health, lastError: latest ?? undefined };
  }

  getRuntimeStatus() {
    return { isRunning: this.activeProcess !== null, activePid: this.activeProcess?.pid ?? null,
      shuttingDown: this.shuttingDown, lastError: this.lastError };
  }

  private async probeHealth(timeoutMs?: number): Promise<AdapterHealth> {
    if (this.shuttingDown) return { available: false, source: 'unavailable', details: 'FlaUI is shutting down.' };
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

    let host: { command: string; args: string[] } | null = null;
    try {
      host = this.resolveHostCommand();
    } catch (cfgErr) {
      const msg = cfgErr instanceof Error ? cfgErr.message : String(cfgErr);
      const val: AdapterHealth = {
        available: false,
        source: 'unavailable',
        details: msg,
        lastError: {
          at: new Date().toISOString(),
          reason: 'error',
          message: msg,
          recoverable: false,
        },
      };
      this.healthCache = { at: Date.now(), value: val };
      return val;
    }

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
    const probeAbortController = new AbortController();
    const probeTimer = setTimeout(() => probeAbortController.abort(), probeTimeout);
    probeTimer.unref?.();

    try {
      return await this.mutex.runExclusive(async () => {
        const res = await this.executeHost(
          {
            schemaVersion: '1.0',
            requestId: 'health-probe',
            action: 'health',
            pid: 0,
          },
          probeTimeout,
          probeAbortController.signal
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
      }, probeAbortController.signal);
    } catch (err) {
      const isAbort = err instanceof AbortError || probeAbortController.signal.aborted;
      const msg = isAbort
        ? `Health probe timed out after ${probeTimeout}ms.`
        : err instanceof Error
        ? err.message
        : String(err);
      const val: AdapterHealth = {
        available: false,
        source: 'unavailable',
        details: `Host probe failed: ${msg}`,
        lastError: {
          at: new Date().toISOString(),
          reason: isAbort ? 'timeout' : 'error',
          message: msg,
          recoverable: true,
        },
      };
      this.healthCache = { at: Date.now(), value: val };
      return val;
    } finally {
      clearTimeout(probeTimer);
    }
  }

  async listWindows(request: UiListWindowsRequest, signal?: AbortSignal): Promise<UiInspectResult> {
    try { validateWindowQuery(request); }
    catch (error) {
      return { schemaVersion: '1.0', protocolVersion: '1.0', requestId: randomUUID(), success: false,
        errorCode: UiErrorCodes.INVALID_ARGUMENT, errorMessage: (error as Error).message };
    }
    // Reuse the same queue, cancellation deadline and exit-confirmed cleanup as inspection.
    return this.inspect({ ...request, action: 'listWindows', timeoutMs: 3000 }, signal);
  }

  async inspect(
    request: UiInspectRequest, signal?: AbortSignal
  ): Promise<UiInspectResult> {
    const result = await this.inspectOnce(request, signal);
    if (!result.success) this.lastError = {
      at: new Date().toISOString(),
      reason: result.errorCode === UiErrorCodes.TIMEOUT ? 'timeout' :
        result.errorCode === UiErrorCodes.CANCELLED ? 'cancelled' : 'error',
      message: `${result.errorCode}: ${result.errorMessage ?? 'Inspection failed.'}`.slice(0, 500), recoverable: true,
    };
    return result;
  }

  private async inspectOnce(
    request: UiInspectRequest,
    signal?: AbortSignal
  ): Promise<UiInspectResult> {
    const requestId = request.requestId || randomUUID();
    try { validateUiQuery(request.query, request.readStates); }
    catch (error) { return {schemaVersion: "1.0", protocolVersion: "1.0", requestId, success: false, errorCode: UiErrorCodes.INVALID_ARGUMENT, errorMessage: (error as Error).message}; }
    const normRequest: UiInspectRequest & { requestId: string } = {
      ...request,
      requestId,
    };
    if ((request.backgroundOnly !== undefined && typeof request.backgroundOnly !== 'boolean') ||
        (request.backgroundOnly && (!request.pid || !request.hwnd))) {
      return { schemaVersion: '1.0', protocolVersion: '1.0', requestId, success: false,
        errorCode: UiErrorCodes.INVALID_ARGUMENT, errorMessage: 'backgroundOnly requires explicit pid and hwnd.' };
    }

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

    if (normRequest.action !== 'listWindows' && !normRequest.pid && !normRequest.hwnd) {
      return {
        schemaVersion: '1.0',
        protocolVersion: '1.0',
        requestId,
        success: false,
        errorCode: UiErrorCodes.INVALID_ARGUMENT,
        errorMessage: 'Either pid or hwnd must be provided for UI inspection.',
      };
    }

    if (this.config.adapters.flaui?.enabled === false) {
      return {
        schemaVersion: '1.0',
        protocolVersion: '1.0',
        requestId,
        success: false,
        errorCode: UiErrorCodes.HOST_UNAVAILABLE,
        errorMessage: 'FlaUI adapter is disabled in configuration.',
      };
    }

    const effectiveTimeout =
      normRequest.timeoutMs ??
      this.config.adapters.flaui?.timeoutMs ??
      this.config.timeouts?.flauiInspectMs ??
      UI_INSPECT_DEFAULTS.TIMEOUT_MS;

    const deadline = Date.now() + effectiveTimeout;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(), effectiveTimeout);
    const executionSignal = signal
      ? AbortSignal.any([signal, deadlineController.signal])
      : deadlineController.signal;

    try {
      return await this.mutex.runExclusive(async () => {
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

        const result = await this.executeHost(normRequest, Math.max(1, deadline - Date.now()), executionSignal);
        if (deadlineController.signal.aborted && !signal?.aborted && result.errorCode === UiErrorCodes.CANCELLED) {
          return { ...result, errorCode: UiErrorCodes.TIMEOUT, errorMessage: 'UI inspection deadline exceeded.' };
        }
        return result;
      }, executionSignal);
    } catch (err) {
      if (err instanceof AbortError) {
        return {
          schemaVersion: '1.0',
          protocolVersion: '1.0',
          requestId,
          success: false,
          errorCode: signal?.aborted ? UiErrorCodes.CANCELLED : UiErrorCodes.TIMEOUT,
          errorMessage: signal?.aborted ? 'UI inspection was cancelled.' : 'UI inspection deadline exceeded while queued.',
        };
      }
      return {
        schemaVersion: '1.0', protocolVersion: '1.0', requestId, success: false,
        errorCode: UiErrorCodes.HOST_ERROR,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private async executeHost(
    request: UiInspectRequest & { requestId: string },
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<UiInspectResult> {
    if (this.shuttingDown || this.activeProcess) {
      return {
        schemaVersion: '1.0', protocolVersion: '1.0', requestId: request.requestId,
        success: false, errorCode: this.shuttingDown ? UiErrorCodes.SHUTDOWN : UiErrorCodes.BUSY,
        errorMessage: 'Helper unavailable: shutting down or previous helper exit is not confirmed.',
      };
    }
    let host: { command: string; args: string[] } | null = null;
    try {
      host = this.resolveHostCommand();
    } catch (cfgErr) {
      return {
        schemaVersion: '1.0',
        protocolVersion: '1.0',
        requestId: request.requestId,
        success: false,
        errorCode: UiErrorCodes.HOST_UNAVAILABLE,
        errorMessage: cfgErr instanceof Error ? cfgErr.message : String(cfgErr),
      };
    }

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
      query: request.query,
      readStates: request.readStates,
      backgroundOnly: request.backgroundOnly,
      processName: request.processName,
      titleContains: request.titleContains,
      maxWindows: request.maxWindows,
      pid: request.pid,
      hwnd: request.hwnd,
      capture: request.capture ?? 'none',
      maxDepth: request.maxDepth ?? this.config.adapters.flaui?.maxDepth ?? UI_INSPECT_DEFAULTS.MAX_DEPTH,
      maxNodes: request.maxNodes ?? this.config.adapters.flaui?.maxNodes ?? UI_INSPECT_DEFAULTS.MAX_NODES,
      timeoutMs: timeoutMs,
    });

    let stdoutData = '';
    const stdoutDecoder = new StringDecoder('utf8');
    let outputExceeded = false;
    let stderrData = '';
    let childProc: ChildProcess | null = null;
    let timer: NodeJS.Timeout | null = null;
    let resourceId: string | null = null;
    let exited = false;
    let exitResolve: (() => void) | null = null;
    const exitPromise = new Promise<void>((r) => {
      exitResolve = r;
    });
    const markExited = () => {
      exited = true;
      if (this.activeProcess === childProc) {
        this.activeProcess = null;
        this.cleanupActive = null;
      }
      if (resourceId && this.resources) {
        this.resources.unregister(resourceId);
        resourceId = null;
      }
      if (exitResolve) {
        exitResolve();
        exitResolve = null;
      }
    };

    let killing: Promise<boolean> | null = null;
    const killHelperOnly = (): Promise<boolean> => {
      if (exited || !childProc) return Promise.resolve(exited);
      if (killing) return killing;
      const procToKill = childProc;
      killing = (async () => {
        try { await killProcessTree(procToKill); } catch { /* retain ownership */ }
        let cleanupTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([exitPromise, new Promise<void>(resolve => {
            cleanupTimer = setTimeout(resolve, 1500);
          })]);
        } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
        return exited;
      })().finally(() => { killing = null; });
      return killing;
    };

    const runPromise = new Promise<UiInspectResult>((resolve, reject) => {
      try {
        const cwd = fs.existsSync(this.config.workspaceRoot)
          ? this.config.workspaceRoot
          : path.dirname(fileURLToPath(import.meta.url));

        childProc = spawn(host.command, host.args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd,
        });

        childProc.on('close', markExited);
        childProc.on('exit', markExited);

        this.activeProcess = childProc;
        this.cleanupActive = killHelperOnly;

        if (this.resources && childProc.pid) {
          resourceId = this.resources.registerProcess('FlaUiAdapter', childProc);
        }

        let totalBytes = 0;
        const maxBytes = UI_INSPECT_DEFAULTS.MAX_HOST_TRANSPORT_BYTES;

        childProc.stdout?.on('data', (chunk: Buffer) => {
          if (outputExceeded) return;
          totalBytes += chunk.byteLength;
          if (totalBytes > maxBytes) {
            // Stop retaining output immediately; process termination is asynchronous.
            outputExceeded = true;
            stdoutData = '';
            void killHelperOnly();
            reject(new Error(`Host stdout exceeded transport budget limit of ${maxBytes} bytes.`));
            return;
          }
          // A pipe chunk can split the UTF-8 bytes of one Chinese character.
          stdoutData += stdoutDecoder.write(chunk);
        });

        childProc.stderr?.on('data', (chunk: Buffer) => {
          if (stderrData.length < 64 * 1024) {
            stderrData += chunk.toString('utf8').slice(0, 64 * 1024 - stderrData.length);
          }
        });

        childProc.on('error', (err) => {
          if (!childProc?.pid) markExited();
          reject(err);
        });

        childProc.on('close', (code) => {
          markExited();
          if (outputExceeded) return;
          stdoutData += stdoutDecoder.end();
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
            // Old/custom helpers must not silently ignore a scoped query and return a whole window.
            if ((request.query || request.readStates) && parsed.success && parsed.inspectionVersion !== 2) {
              resolve({ schemaVersion: '1.0', protocolVersion: '1.0', requestId: request.requestId,
                success: false, errorCode: UiErrorCodes.VERSION_MISMATCH,
                errorMessage: 'Query/state inspection requires a v0.9 helper (inspectionVersion 2).', auditNotice: parsed.auditNotice });
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
        childProc.stdin?.on('error', reject); // Early helper exit may otherwise raise an unhandled EPIPE.
        childProc.stdin?.write(payload, 'utf8');
        childProc.stdin?.end();
      } catch (spawnErr) {
        markExited();
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
      timer = setTimeout(() => {
        reject(new TimeoutError('FlaUiAdapter', timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([runPromise, timeoutPromise]);
    } catch (err) {
      await killHelperOnly();
      const isCancelled = signal?.aborted || err instanceof AbortError;
      const isTimeout = err instanceof TimeoutError;
      const isPayloadTooLarge = String(err).includes('transport budget limit');
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
      if (!exited && !(await killHelperOnly())) {
        // Retain the PID/resource registration. New calls fail BUSY until exit.
        throw new Error('Helper cleanup timed out; process remains tracked and new helper calls are blocked.');
      }
    }
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    if (this.cleanupActive && !(await this.cleanupActive())) {
      this.lastError = { at: new Date().toISOString(), reason: 'error', recoverable: true,
        message: 'Helper cleanup timed out during shutdown; exit is not confirmed.' };
      throw new Error('Helper cleanup timed out during shutdown; exit is not confirmed.');
    }
  }
}
