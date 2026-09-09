import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { killProcessTree, withTimeout } from '../src/Core/ResourceManager.js';

async function entryFixture(run: (child: ChildProcessWithoutNullStreams, exit: Promise<number | null>, logs: () => string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-entry-exit-'));
  const child = spawn(process.execPath, [path.resolve('dist/index.js'), '--workspace', root],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  child.stderr.on('data', data => { logs = (logs + String(data)).slice(-16000); });
  child.stdin.on('error', () => {});
  const exit = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  try { await run(child, exit, () => logs); }
  finally {
    if (child.exitCode === null && child.signalCode === null) await killProcessTree(child);
    await withTimeout(exit, 5000, 'fixture-reap');
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function handshake(child: ChildProcessWithoutNullStreams) {
  let buffer = '';
  const ready = new Promise<void>((resolve, reject) => {
    const read = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n'); buffer = lines.pop()!;
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.id === 1) {
          child.stdout.off('data', read);
          if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve();
        }
      }
    };
    child.stdout.on('data', read);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'entry-exit-test', version: '1' },
  } }) + '\n');
  await withTimeout(ready, 20000, 'entry-handshake');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

it('production entry exits on client EOF without a client kill fallback', { timeout: 35000 }, async () => {
  await entryFixture(async (child, exit, logs) => {
    await handshake(child);
    child.stdin.end();
    assert.equal(await withTimeout(exit, 9000, 'EOF-exit'), 0, logs());
    assert.match(logs(), /shutting down/);
  });
});

it('production entry handles EOF before initialization and does not announce readiness after stop', { timeout: 15000 }, async () => {
  await entryFixture(async (child, exit, logs) => {
    child.stdin.end();
    assert.equal(await withTimeout(exit, 9000, 'early-EOF-exit'), 0, logs());
    const stopping = logs().indexOf('shutting down');
    assert.ok(stopping >= 0, logs());
    assert.doesNotMatch(logs().slice(stopping), / ready\./);
    assert.equal(logs().match(/shutting down/g)?.length, 1);
  });
});
