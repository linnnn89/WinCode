/** Opt-in interactive acceptance. Creates only a no-activate disposable fixture; never controls foreground. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { killProcessTree } from '../src/Core/ResourceManager.js';

const output = path.resolve('test-tmp', 'background-' + Date.now());
await fs.mkdir(output, { recursive: true });
const samples: Array<{ at: string; pid: number; hwnd: string; processName: string }> = [];
const rounds: unknown[] = [];
const roundCount = Number(process.argv.find(arg => arg.startsWith('--rounds='))?.split('=')[1] ?? 5);
assert.ok(Number.isInteger(roundCount) && roundCount >= 1 && roundCount <= 20);
const fixture = spawn(path.resolve('tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe'),
  ['--background-fixture', '--auto-close=30000'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const client = new Client({ name: 'background-acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], stderr: 'pipe' });
let failure: string | undefined;
let measurementStart = 0;
try {
  const target = await new Promise<{ pid: number; hwnd: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture did not become ready')), 8000);
    let buffer = '';
    fixture.stdout!.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        const fg = line.match(/^FOREGROUND (\d+) (0x[\dA-F]+) (.+)$/);
        if (fg) samples.push({ at: new Date().toISOString(), pid: +fg[1], hwnd: fg[2], processName: fg[3] });
        const ready = line.match(/^READY (\d+) (0x[\dA-F]+)$/);
        if (ready) { clearTimeout(timeout); resolve({ pid: +ready[1], hwnd: ready[2] }); }
      }
    });
    fixture.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  await client.connect(transport);
  const expectedForeground = process.argv.find(arg => arg.startsWith('--foreground-process='))?.split('=')[1];
  if (expectedForeground) {
    // Observe only: wait for the user to return to their game; never bring any app forward.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !(samples.length >= 10 && samples.slice(-10).every(s => s.processName === expectedForeground)))
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(samples.length >= 10 && samples.slice(-10).every(s => s.processName === expectedForeground), 'Expected foreground did not stabilize');
    measurementStart = samples.length - 1;
  }
  for (let i = 0; i < roundCount; i++) {
    const capture = process.argv.includes('--alternate-capture') && i % 2 ? 'annotated' : 'original';
    const response = await client.callTool({ name: 'wincode_ui_inspect', arguments: {
      ...target, backgroundOnly: true, capture, maxNodes: 100,
    } });
    const blocks = response.content as Array<{ type: string; text?: string; data?: string }>;
    const result = JSON.parse(blocks[0].text!);
    assert.equal(result.success, true); assert.equal(result.backgroundOnly, true);
    assert.equal(result.tree.automationId, 'WinCodeWpfFixtureRoot');
    assert.equal(result.pid, target.pid); assert.equal(result.hwnd, target.hwnd);
    assert.ok(!['bitBltScreen', 'copyFromScreen'].includes(result.captureMethod));
    await fs.writeFile(path.join(output, `snapshot-${i}.json`), JSON.stringify(result, null, 2));
    const image = blocks.find(block => block.type === 'image');
    if (image) {
      assert.ok(['printWindowDwm', 'printWindow'].includes(result.captureMethod));
      await fs.writeFile(path.join(output, `snapshot-${i}.png`), Buffer.from(image.data!, 'base64'));
    } else { assert.equal(result.imageOmitted, true); }
    process.kill(target.pid, 0);
    const healthResponse = await client.callTool({ name: 'wincode_hello_world', arguments: {} });
    const health = JSON.parse((healthResponse.content as Array<{text:string}>)[0].text).health;
    assert.equal(health.flaui.runtime.activePid, null);
    assert.equal(health.flaui.runtime.isRunning, false);
    rounds.push({ index: i, capture, totalNodes: result.totalNodes, captureMethod: result.captureMethod,
      nodeMemory: health.nodeMemory, cache: health.cache, managedChildProcesses: health.managedChildProcesses,
      imageReturned: Boolean(image), imageOmittedReason: result.imageOmittedReason });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(samples.length > 5);
  assert.ok(samples.every(sample => sample.pid !== target.pid), 'Fixture must never become foreground');
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  await client.close();
  await killProcessTree(fixture);
  const measuredSamples = samples.slice(measurementStart);
  const initial = measuredSamples[0];
  const report = { mode: 'live-no-activate-fixture', failure, rounds, samples,
    measurementStart, foregroundUnchangedInSamples: rounds.length > 0 && measuredSamples.length > 0 && measuredSamples.every(s => s.pid === initial.pid && s.hwnd === initial.hwnd),
    limitation: '100ms samples do not prove absence of briefer focus changes. Image content requires visual review.' };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, failure, rounds, initialForeground: initial,
    sampleCount: samples.length, foregroundUnchangedInSamples: report.foregroundUnchangedInSamples }, null, 2));
}
