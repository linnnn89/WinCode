/** Real SDK/Gateway acceptance for shared disk caches; fixture payloads and cleanup remain under test-tmp. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { verifyDelivery } from './delivery-manifest.mjs';
import { ownedProcesses, observedSurvivors, terminateObserved } from './lib/owned-processes.mjs';

const repo = path.resolve(import.meta.dirname, '..');
assert.equal(process.argv.length, 2, 'This acceptance always runs the complete bounded matrix.');
const parent = path.join(repo, 'test-tmp/shared-cache'); await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-')), sharedCache = path.join(root, 'shared-cache');
const report = { root, startedAt: new Date().toISOString(), success: false, scenarios: [], observed: [], cleanupFailures: [],
  limitations: ['Real published Gateway/Cache modules and SDK stdio, with a fixture entrypoint selecting small cache limits; not an active consumer connection.',
    'Automatic capacity eviction is exercised through real writes. Attachments remain evictable after a completed call; no permanent lease or power-loss durability guarantee.',
    'Generated small C# inputs, local-text context; no new dependencies, models, UI, or filesystem-wide cleanup.'] };
const clients = [];
const hash = data => createHash('sha256').update(data).digest('hex');
const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const remember = rows => { for (const row of rows) if (!report.observed.some(old => old.ProcessId === row.ProcessId && old.CreationDate === row.CreationDate)) report.observed.push(row); };
async function save() { await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
async function scenario(name, run) {
  console.log(`[shared-cache] ${name}`);
  const item = { name, passed: false }; report.scenarios.push(item);
  Object.assign(item, await run()); item.passed = true; await save();
}
async function start(name, tag) {
  const receipt = path.join(root, `${name}-stop.json`);
  const client = new Client({ name, version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(repo, 'tests/fixtures/cache-gateway.mjs'), path.join(root, tag), sharedCache, receipt], cwd: repo, stderr: 'pipe' });
  const peer = { name, tag, client, transport, receipt, stderr: '', closed: false }; clients.push(peer);
  await client.connect(transport);
  transport.stderr?.on('data', chunk => { peer.stderr = (peer.stderr + chunk).slice(-16384); });
  remember(ownedProcesses(transport.pid));
  const hello = await call(peer, 'wincode_hello_world');
  assert.equal(hello.version, report.delivery.version);
  assert.equal(hello.runtime.build.status, 'verified');
  assert.equal(hello.runtime.build.buildId, report.buildId);
  assert.equal(hello.health.workspaceBinding.root, path.join(root, tag));
  peer.instance = hello.runtime.instanceId;
  return peer;
}
async function call(peer, name, args = {}) {
  const response = await peer.client.callTool({ name, arguments: args }, { timeout: 20000 });
  const data = response.structuredContent ?? JSON.parse(response.content[0].text);
  assert.notEqual(response.isError, true, JSON.stringify(data)); return data;
}
async function context(peer, index = 0, version = 'CURRENT') {
  const data = await call(peer, 'wincode_prepare_context', { task: 'Read selected source', candidateFiles: [`Item${index}.cs`], includeFullText: true, maxTokens: 4096 });
  assert.match(data.packedContent, new RegExp(`${peer.tag}_${version}_${index}`));
  assert.doesNotMatch(data.packedContent, new RegExp(`${peer.tag === 'A' ? 'B' : 'A'}_(CURRENT|UPDATED)_`));
  assert.equal(data.metrics.packedFiles, 1); return { fromCache: data.metrics.fromCache, content: data.packedContent };
}
async function records() {
  const names = (await fs.readdir(sharedCache)).filter(name => name.endsWith('.json'));
  return Promise.all(names.map(async name => ({ file: path.join(sharedCache, name), entry: JSON.parse(await fs.readFile(path.join(sharedCache, name), 'utf8')) })));
}
async function backingFor(marker) {
  const found = (await records()).find(({ entry }) => entry.data?.content?.includes(marker));
  assert.ok(found?.entry.data.overflowPath, `No overflow record for ${marker}`); return found.entry.data.overflowPath;
}
async function audit() {
  const entries = await records(); let verified = 0, evictedAttachments = 0;
  for (const { entry } of entries) {
    assert.equal(entry.format, 'wincode-cache-v1'); assert.match(entry.integrity, /^[a-f0-9]{64}$/);
    const file = entry.data?.overflowPath;
    if (!file) continue;
    assert.equal(path.dirname(file), path.join(sharedCache, 'overflow'));
    if (!await exists(file)) { evictedAttachments++; continue; }
    const content = await fs.readFile(file);
    assert.equal(hash(content), entry.backingFile.sha256); assert.equal(content.length, entry.backingFile.size); verified++;
  }
  return { diskEntries: entries.length, verifiedAttachments: verified, evictedAttachments };
}
async function close(peer) {
  if (peer.closed) return;
  await peer.client.close(); peer.closed = true;
  const receipt = JSON.parse(await fs.readFile(peer.receipt, 'utf8'));
  assert.equal(receipt.success, true); assert.equal(receipt.inFlightRequests, 0); assert.equal(receipt.resourcesDisposed, true);
  peer.stop = receipt;
}

let manifest;
try {
  manifest = JSON.parse(await fs.readFile(path.join(repo, 'dist/delivery-manifest.json'), 'utf8'));
  report.delivery = await verifyDelivery(repo, manifest);
  report.buildId = JSON.parse(await fs.readFile(path.join(repo, 'dist/build-manifest.json'), 'utf8')).buildId;
  for (const tag of ['A', 'B']) {
    const workspace = path.join(root, tag); await fs.mkdir(workspace);
    for (let index = 0; index < 32; index++) await fs.writeFile(path.join(workspace, `Item${index}.cs`),
      `public class Item${index} { public string Value = "${tag}_CURRENT_${index}"; }\n` + '// bounded fixture evidence\n'.repeat(1200));
  }
  const a = await start('first-A', 'A'), a2 = await start('second-A', 'A');
  assert.notEqual(a.instance, a2.instance);
  await scenario('same-key concurrent writes and warm reads preserve complete source', async () => {
    const values = await Promise.all(Array.from({ length: 8 }, (_, i) => context(i % 2 ? a : a2)));
    assert.equal((await context(a)).fromCache, true); assert.equal((await context(a2)).fromCache, true);
    return { requests: values.length, ...await audit() };
  });
  await scenario('different keys share the cache during concurrent reads and writes', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => context(i % 2 ? a : a2, i + 1)));
    return { requests: 8, ...await audit() };
  });
  await scenario('peer capacity eviction expires old attachments and subsequent context rebuilds', async () => {
    // Same-key writers may retain different valid attachments. Seed an untouched key
    // through A alone so the disk eviction target is the attachment A actually uses.
    const target = 31, marker = `A_CURRENT_${target}`;
    const initial = await context(a, target), originalAttachment = await backingFor(marker);
    assert.equal(initial.fromCache, false);
    assert.ok(initial.content.includes(originalAttachment), 'the eviction target must belong to the observed reader');
    let misses = 0;
    for (let index = 9; index < 29; index++) {
      const [, value] = await Promise.all([context(a2, index), context(a, target)]);
      if (!value.fromCache) misses++;
    }
    assert.equal(await exists(originalAttachment), false, 'peer automatic pruning must actually remove the original attachment');
    if (!(await context(a, target)).fromCache) misses++;
    assert.ok(misses > 0, 'evicted backing content must cause a rebuild');
    // A peer can evict the disk index while this Gateway retains a valid warm entry.
    for (const { file, entry } of await records())
      if (entry.data?.content?.includes(marker)) await fs.unlink(file);
    assert.equal((await context(a, target)).fromCache, true, 'valid warm reads do not require a retained disk index');
    return { peerWrites: 20, attachmentOwner: a.name, observedRebuilds: misses, originalAttachmentEvicted: true, warmReadAfterIndexEviction: true, ...await audit() };
  });
  await scenario('both warm Gateways reject same-size corrupted backing content', async () => {
    await context(a, 29); await context(a2, 29);
    const file = await backingFor('A_CURRENT_29'), stat = await fs.stat(file), original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, original.replace('A_CURRENT_29', 'Z'.repeat('A_CURRENT_29'.length)));
    await fs.utimes(file, stat.atime, stat.mtime);
    const values = await Promise.all([context(a, 29), context(a2, 29)]);
    assert.ok(values.every(value => !value.fromCache));
    return { rebuiltByBoth: true, ...await audit() };
  });
  await scenario('editing source invalidates both clients and returns the new content', async () => {
    const file = path.join(root, 'A/Item29.cs');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('A_CURRENT_29', 'A_UPDATED_29'));
    const values = await Promise.all([context(a, 29, 'UPDATED'), context(a2, 29, 'UPDATED')]);
    assert.ok(values.every(value => !value.fromCache)); return { updatedByBoth: true };
  });
  await close(a2);
  const b = await start('other-B', 'B');
  await scenario('different workspaces sharing one physical cache do not exchange source', async () => {
    const values = await Promise.all(Array.from({ length: 8 }, (_, i) => context(i % 2 ? a : b, 30)));
    assert.equal((await context(a, 30)).fromCache, true); assert.equal((await context(b, 30)).fromCache, true);
    return { requests: values.length, instances: [a.instance, b.instance], ...await audit() };
  });
  await scenario('one Gateway shuts down cleanly while its peer continues using shared files', async () => {
    await Promise.all([close(b), context(a, 30)]);
    assert.equal((await context(a, 30)).fromCache, true);
    assert.equal((await fs.readdir(sharedCache)).some(name => name.includes('.tmp.')), false);
    return { closed: b.stop, ...await audit() };
  });
  await close(a);
  const cold = await start('cold-A', 'A');
  await scenario('fresh Gateway reads the validated persisted snapshot after both writers exit', async () => {
    assert.equal((await context(cold, 30)).fromCache, true); return await audit();
  });
  await close(cold);
  await verifyDelivery(repo, manifest);
  report.success = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  for (const peer of clients) if (!peer.closed) try { await close(peer); } catch (error) { report.cleanupFailures.push(String(error)); }
  report.survivors = observedSurvivors(report.observed);
  if (report.survivors.length || report.cleanupFailures.length) { report.success = false; process.exitCode = 1; }
  for (const process of report.survivors) terminateObserved(process);
  report.clients = clients.map(({ name, tag, instance, stop, stderr }) => ({ name, tag, instance, stop, stderr }));
  report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ success: report.success, scenarios: report.scenarios.length, error: report.error, report: path.join(root, 'report.json') }));
}
