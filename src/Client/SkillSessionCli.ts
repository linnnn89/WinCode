#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WinCodeSession } from './SkillSession.js';

const argv = process.argv.slice(2);
let workspace: string | undefined, roslynConfig: string | undefined;
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i + 1]) throw new Error('Expected --workspace <absolute directory> [--roslyn-config <absolute file>].');
  if (argv[i] === '--workspace' && !workspace) workspace = argv[i + 1];
  else if (argv[i] === '--roslyn-config' && !roslynConfig) roslynConfig = argv[i + 1];
  else throw new Error(`Unknown or duplicate launch option: ${argv[i]}`);
}
if (!workspace) throw new Error('--workspace is required.');
const session = new WinCodeSession({ workspace, roslynConfig });
let buffer = '', stopping = false, serial = 0;
let active: { id: string; controller: AbortController; done: Promise<void> } | undefined;
let outputDirectory: string | undefined;
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(-8192);

async function respond(id: string, result: Awaited<ReturnType<WinCodeSession['call']>>) {
  const serialized = JSON.stringify(result);
  const images = result.content.filter(item => item.type === 'image');
  // PTYs can wrap/echo even small JSON. Always retain the exact result outside terminal rendering.
  if (!outputDirectory) {
    const parent = fileURLToPath(new URL('../../test-tmp/skill-sessions/', import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    outputDirectory = await fs.mkdtemp(path.join(parent, 'run-'));
  }
  const stem = String(++serial), resultFile = path.join(outputDirectory, `${stem}.json`);
  await fs.writeFile(resultFile, serialized + '\n', { flag: 'wx' });
  const imageFiles = [];
  for (const [index, item] of images.entries()) {
    if (item.type !== 'image') continue;
    const extension = item.mimeType === 'image/png' ? 'png' : item.mimeType === 'image/jpeg' ? 'jpg' : 'image';
    const file = path.join(outputDirectory, `${stem}-${index}.${extension}`);
    await fs.writeFile(file, Buffer.from(item.data, 'base64'), { flag: 'wx' });
    imageFiles.push({ path: file, mimeType: item.mimeType });
  }
  write({ id, isError: result.isError ?? false, resultFile, imageFiles });
}

async function stop(id: string | null) {
  if (stopping) return;
  stopping = true;
  active?.controller.abort(new Error('Skill session stopping.'));
  let failure: string | undefined;
  try { await session.close(); await active?.done; }
  catch (error) { failure = errorText(error); }
  process.stdin.pause();
  process.stdout.write(JSON.stringify({ id, closed: !failure, status: session.status, ...(failure ? { error: failure } : {}) }) + '\n',
    () => process.exit(failure ? 1 : 0));
}

function receive(line: string) {
  let id: string | null = null;
  try {
    if (Buffer.byteLength(line, 'utf8') > 65_536) throw new Error('Session request exceeds 64 KiB.');
    const request = JSON.parse(line);
    if (!request || typeof request.id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(request.id))
      throw new Error('Each request needs an id of 1–64 letters, digits, dots, underscores or hyphens.');
    id = request.id;
    if (stopping) throw new Error('Session is stopping.');
    if (request.action === 'status') { write({ id, status: session.status }); return; }
    if (request.action === 'close') { void stop(id); return; }
    if (request.action === 'cancel') {
      if (!active || request.targetId !== active.id) throw new Error('targetId must identify the active request.');
      active.controller.abort(new Error('Skill request cancelled.'));
      write({ id, cancellationRequested: true, targetId: active.id }); return;
    }
    if (request.action !== undefined) throw new Error('Unknown session action.');
    if (active) throw new Error('A request is already active; await its result or cancel it explicitly.');
    const controller = new AbortController();
    const current = { id: id!, controller, done: Promise.resolve() };
    active = current;
    current.done = (async () => {
      try {
        const result = await session.call(request.tool, request.arguments ?? {}, { signal: controller.signal, timeoutMs: request.timeoutMs });
        try { await respond(current.id, result); }
        catch (error) { write({ id: current.id, resultDeliveryError: errorText(error), toolResponded: true, isError: result.isError ?? false }); }
      }
      catch (error) { write({ id: current.id, transportError: errorText(error) }); }
      finally { if (active === current) active = undefined; }
    })();
  } catch (error) { write({ id, requestError: errorText(error) }); }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
    if (line) receive(line);
  }
  if (Buffer.byteLength(buffer, 'utf8') > 65_536) { write({ requestError: 'Session input exceeds 64 KiB without a newline.' }); void stop(null); }
});
process.stdin.once('end', () => { void stop(null); });
process.stdin.once('error', () => { void stop(null); });
process.stdout.once('error', () => { void stop(null); });
process.on('SIGINT', () => { void stop(null); });
process.on('SIGTERM', () => { void stop(null); });
write({ ready: true, protocol: 'wincode-skill-session/1', ownerPid: process.pid, status: session.status });
