import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectBuildInputs, createBuildManifest, fingerprint } from './build.mjs';
import { managedFiles } from './sync-skill.mjs';

export const hostDirectory = 'tools/WinCode.UIA.Host/bin/Release/net10.0-windows/win-x64/publish';
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const settings = ['package.json', 'package-lock.json', 'global.json',
  'tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj', 'tools/WinCode.UIA.Host/packages.lock.json'];

async function fileRecord(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..'))
    throw new Error('Invalid delivery file path.');
  const base = await fs.realpath(root);
  const full = await fs.realpath(path.join(root, relative));
  const inside = path.relative(base, full);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('Delivery file escapes its root.');
  const stat = await fs.stat(full);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error(`Invalid delivery file size: ${relative}`);
  return { path: relative, bytes: stat.size, sha256: sha256(await fs.readFile(full)) };
}

async function inventory(root, directory) {
  const files = [];
  let entries = 0;
  async function visit(relative, depth) {
    if (depth > 8) throw new Error('Delivery directory depth exceeded.');
    const handle = await fs.opendir(path.join(root, relative));
    for await (const entry of handle) {
      if (++entries > 512) throw new Error('Delivery directory entry limit exceeded.');
      if (entry.isSymbolicLink()) throw new Error('Delivery links are unsupported.');
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.isFile()) files.push(child);
    }
  }
  await visit(directory, 0);
  return files.sort();
}

async function records(root, files) {
  const result = [];
  let bytes = 0;
  if (files.length > 2048) throw new Error('Delivery file count exceeded.');
  for (const file of [...files].sort()) {
    const record = await fileRecord(root, file);
    if ((bytes += record.bytes) > 256 * 1024 * 1024) throw new Error('Delivery byte budget exceeded.');
    result.push(record);
  }
  return result;
}

export async function collectDelivery(root, hostIdentity, toolchains) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const gateway = JSON.parse(await fs.readFile(path.join(root, 'dist/build-manifest.json'), 'utf8'));
  if (gateway.version !== pkg.version || hostIdentity?.version !== pkg.version || hostIdentity.configuration !== 'Release')
    throw new Error('Gateway, Release Host and package versions must agree.');
  if (fingerprint(await collectBuildInputs(root)) !== gateway.sourceHash) throw new Error('Gateway source changed after build.');
  const actualGateway = await createBuildManifest(root, await collectBuildInputs(root), pkg.version);
  if (actualGateway.buildId !== gateway.buildId) throw new Error('Gateway build identity does not match its artifacts.');
  const gatewayFiles = await records(root, actualGateway.artifacts.map(file => `dist/${file.path}`));
  if (gatewayFiles.some(file => gateway.artifacts.find(item => `dist/${item.path}` === file.path)?.sha256 !== file.sha256))
    throw new Error('Gateway artifacts changed after build.');
  const hostFiles = await inventory(root, hostDirectory);
  for (const required of ['WinCode.UIA.Host.exe', 'WinCode.UIA.Host.dll', 'WinCode.UIA.Host.deps.json', 'WinCode.UIA.Host.runtimeconfig.json'])
    if (!hostFiles.includes(`${hostDirectory}/${required}`)) throw new Error(`Missing Host sidecar: ${required}`);
  return { version: pkg.version, toolchains, components: {
    gateway: { buildId: gateway.buildId, files: gatewayFiles },
    host: { identity: hostIdentity, files: await records(root, hostFiles) },
    skill: { files: await records(root, managedFiles.map(file => `skills/wincode/${file}`)) },
    configuration: { files: await records(root, settings) },
  } };
}

export function deliveryId(delivery) { return sha256(JSON.stringify(delivery)); }

export async function verifyDelivery(root, manifest) {
  if (manifest.formatVersion !== 1 || !manifest.delivery || deliveryId(manifest.delivery) !== manifest.contentId)
    throw new Error('Invalid delivery manifest identity.');
  const actual = await collectDelivery(root, manifest.delivery.components.host.identity, manifest.delivery.toolchains);
  if (deliveryId(actual) !== manifest.contentId) throw new Error('Delivery contents changed or are incomplete.');
  return { contentId: manifest.contentId, version: actual.version, matched: true };
}

function output(command, args, root, input) {
  const result = spawnSync(command, args, { cwd: root, input, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error(`Delivery probe failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout.trim();
}

export async function writeDelivery(root = rootDirectory) {
  const hostResponse = JSON.parse(output(path.join(root, hostDirectory, 'WinCode.UIA.Host.exe'), [], root,
    JSON.stringify({ schemaVersion: '1.0', requestId: 'delivery-check', action: 'health' }) + '\n'));
  if (hostResponse.success !== true || hostResponse.status !== 'healthy') throw new Error('Published Host health failed.');
  const toolchains = { node: process.versions.node, dotnet: output('dotnet', ['--version'], root),
    npm: process.env.npm_execpath ? output(process.execPath, [process.env.npm_execpath, '--version'], root) : null };
  const delivery = await collectDelivery(root, hostResponse.hostIdentity, toolchains);
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 3000 });
  const revision = git.status === 0 && /^[a-f0-9]{40,64}$/.test(git.stdout.trim()) ? git.stdout.trim() : null;
  const manifest = { formatVersion: 1, contentId: deliveryId(delivery), delivery, revision, createdAt: new Date().toISOString() };
  const target = path.join(root, 'dist/delivery-manifest.json');
  const temporary = `${target}.${process.pid}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n'); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
  return verifyDelivery(root, manifest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const run = action === '--verify'
    ? fs.readFile(path.join(rootDirectory, 'dist/delivery-manifest.json'), 'utf8').then(text => verifyDelivery(rootDirectory, JSON.parse(text)))
    : action === undefined ? writeDelivery() : Promise.reject(new Error('Usage: node scripts/delivery-manifest.mjs [--verify]'));
  run.then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
