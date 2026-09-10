import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_IDENTITY } from '../Core/RuntimeIdentity.js';
import type { ToolRouter } from '../Core/ToolRouter.js';

const maxFrame = 64 * 1024;
const validPipe = (value: unknown): value is string => typeof value === 'string' &&
  /^WinCode\.Tray\.v1\.S-1-[0-9-]+\.s\d+(?:\.test-[a-f0-9]{32})?$/.test(value) && value.length <= 240;

/** 只在显式 --tray 时执行一次当前用户/登录会话解析；不启动托盘、不读写真实客户端设置。 */
export async function resolveTrayEndpoint(signal: AbortSignal): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Tray integration requires Windows.');
  const executable = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../../tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe');
  const result = await promisify(execFile)(executable, ['--endpoint'], { windowsHide: true, timeout: 3000, maxBuffer: 4096, signal });
  const data = JSON.parse(result.stdout);
  if (data.version !== RUNTIME_IDENTITY.build.version || !validPipe(data.pipeName)) throw new Error('Tray endpoint/version mismatch; rebuild the optional Tray.');
  return data.pipeName;
}

/** 可选本地控制连接。托盘离线不影响 MCP；无自动释放、进程名称扫描或磁盘状态轮询。 */
export class TrayClient {
  private socket?: net.Socket;
  private retry?: NodeJS.Timeout;
  private disposed = false;
  private retryMs = 1000;
  private lastWarning = '';
  constructor(private readonly pipeName: string, private readonly router: ToolRouter,
    private readonly shutdown: () => void, private readonly warn: (message: string) => void = message => console.error(`[WinCode Tray] ${message}`)) {
    if (!validPipe(pipeName)) throw new Error('Invalid local Tray pipe name.');
  }

  start(): void {
    if (this.disposed || this.socket || this.retry) return;
    this.connect();
  }

  private connect(): void {
    if (this.disposed || this.router.isShuttingDown) return;
    const socket = net.createConnection(`\\\\.\\pipe\\${this.pipeName}`);
    this.socket = socket;
    socket.unref();
    let input = Buffer.alloc(0), pending = 0;
    const seen = new Set<string>();
    const connecting = setTimeout(() => socket.destroy(new Error('Tray connection timed out')), 2000);
    connecting.unref();
    const send = (value: unknown, done?: () => void) => {
      if (this.socket !== socket || socket.destroyed) return;
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      if (bytes.length > maxFrame || socket.writableLength + bytes.length > 2 * maxFrame) { socket.destroy(new Error('Tray output budget exceeded')); return; }
      socket.write(bytes, error => { if (error) socket.destroy(); else done?.(); });
    };
    const receive = (frame: unknown): Promise<void> => {
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid Tray frame');
      const value = frame as Record<string, unknown>;
      if (value.v === 1 && value.instanceId === RUNTIME_IDENTITY.instanceId &&
        (value.type === 'register-accepted' || value.type === 'register-rejected')) {
        if (value.type === 'register-rejected') {
          if (typeof value.message !== 'string') throw new Error('Invalid Tray registration rejection');
          throw new Error(`托盘拒绝连接：${value.message.slice(0, 500)}；MCP 继续独立运行。`);
        }
        this.retryMs = 1000; this.lastWarning = '';
        return Promise.resolve();
      }
      if (value.v !== 1 || value.type !== 'request' || value.instanceId !== RUNTIME_IDENTITY.instanceId ||
        typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.id) ||
        !['status', 'releaseRoslyn', 'shutdown'].includes(String(value.operation)) ||
        Object.keys(value).some(key => !['v', 'type', 'id', 'instanceId', 'operation'].includes(key))) throw new Error('Invalid Tray request');
      if (seen.has(value.id)) throw new Error('Tray command ID was replayed');
      seen.add(value.id); if (seen.size > 64) seen.delete(seen.values().next().value!);
      if (++pending > 8) { pending--; throw new Error('Tray request budget exceeded'); }
      this.retryMs = 1000; this.lastWarning = '';
      return (async () => { try {
        const result = value.operation === 'status' ? this.router.getMemoryControlStatus() : value.operation === 'releaseRoslyn'
          ? await this.router.releaseRoslynMemory() : { success: true, status: 'accepted', message: '已接纳停止请求；最终退出需以连接状态确认。' };
        send({ v: 1, type: 'response', id: value.id, instanceId: RUNTIME_IDENTITY.instanceId, result },
          value.operation === 'shutdown' ? () => { setImmediate(this.shutdown); } : undefined);
      } finally { pending--; } })();
    };
    socket.on('connect', () => {
      clearTimeout(connecting);
      send({ v: 1, type: 'register', instanceId: RUNTIME_IDENTITY.instanceId, pid: process.pid,
        version: RUNTIME_IDENTITY.build.version, buildId: RUNTIME_IDENTITY.build.buildId, startedAt: RUNTIME_IDENTITY.startedAt,
        status: this.router.getMemoryControlStatus() });
    });
    socket.on('data', (chunk: Buffer) => {
      // 一次最多接收两帧预算；逐行解析后只保留不足一帧的尾部。
      if (input.length + chunk.length > 2 * maxFrame) { socket.destroy(new Error('Tray input budget exceeded')); return; }
      input = Buffer.concat([input, chunk]);
      let newline: number;
      while ((newline = input.indexOf(10)) >= 0) {
        if (newline > maxFrame) { socket.destroy(new Error('Tray frame too large')); return; }
        const line = input.subarray(0, newline); input = input.subarray(newline + 1);
        try { void receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))).catch(error => socket.destroy(error)); }
        catch (error) { socket.destroy(error as Error); return; }
      }
      if (input.length > maxFrame) socket.destroy(new Error('Tray frame too large'));
    });
    socket.on('error', error => {
      const message = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '托盘尚未启动；MCP 继续独立运行。' : error.message.slice(0, 500);
      if (!this.disposed && message !== this.lastWarning) { this.lastWarning = message; this.warn(message); }
    });
    socket.on('close', () => {
      clearTimeout(connecting);
      if (this.socket === socket) this.socket = undefined;
      if (this.disposed || this.router.isShuttingDown) return;
      this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, this.retryMs);
      this.retry.unref(); this.retryMs = Math.min(this.retryMs * 2, 60000);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.socket?.destroy(); this.socket = undefined;
  }
}
