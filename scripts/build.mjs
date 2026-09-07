import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sortRecords = records => records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
export const fingerprint = records => sha256(JSON.stringify(sortRecords([...records])));

async function hashFiles(root, files) {
  if (files.length > 2048) throw new Error('Build fingerprint exceeds 2048 files.');
  const realRoot = await fs.realpath(root);
  let totalBytes = 0;
  const records = [];
  for (const relative of files) {
    const full = await fs.realpath(path.join(root, relative));
    const inside = path.relative(realRoot, full);
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('Build fingerprint path escapes its root.');
    const stat = await fs.stat(full);
    totalBytes += stat.size;
    if (!stat.isFile() || stat.size > 8388608 || totalBytes > 67108864) throw new Error('Build fingerprint exceeds its file-size budget.');
    records.push({ path: relative, sha256: sha256(await fs.readFile(full)) });
  }
  return sortRecords(records);
}

export async function collectBuildInputs(root) {
  const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.mjs'];
  let visitedEntries = 0;
  const walk = async (relative, depth = 0) => {
    if (depth > 32) throw new Error('Build source discovery exceeds 32 directory levels.');
    const directory = await fs.opendir(path.join(root, relative));
    for await (const entry of directory) {
      if (++visitedEntries > 20000) throw new Error('Build source discovery exceeds 20000 entries.');
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Source links are unsupported for reproducible build fingerprints.');
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile() && /\.[cm]?ts$/.test(entry.name)) files.push(child);
      if (files.length > 2048) throw new Error('Build fingerprint exceeds 2048 files.');
    }
  };
  await walk('src');
  return hashFiles(root, files);
}

/** Pure collection step; used by isolated fixtures without compiling or writing dist. */
export async function createBuildManifest(root, inputsBefore, version, revision = null) {
  const inputsAfter = await collectBuildInputs(root);
  const sourceHash = fingerprint(inputsBefore);
  if (sourceHash !== fingerprint(inputsAfter)) throw new Error('Build inputs changed during compilation; rebuild from a stable source tree.');
  const outputFiles = inputsAfter.map(record => record.path)
    .filter(file => file.startsWith('src/') && !/\.d\.[cm]?ts$/.test(file))
    .map(file => file.slice(4).replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.ts$/, '.js'));
  const artifacts = await hashFiles(path.join(root, 'dist'), outputFiles);
  const artifactHash = fingerprint(artifacts);
  const buildId = sha256(JSON.stringify({ version, sourceHash, artifactHash }));
  return { formatVersion: 1, version, buildId, sourceHash, artifactHash, revision, builtAt: new Date().toISOString(), artifacts };
}

export async function build(root = projectRoot) {
  const manifestPath = path.join(root, 'dist', 'build-manifest.json');
  // A failed rebuild must not leave an earlier manifest next to partially emitted JS.
  await fs.rm(manifestPath, { force: true });
  const inputsBefore = await collectBuildInputs(root);
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const config = await fs.readFile(path.join(root, 'src', 'Core', 'Config.ts'), 'utf8');
  if (typeof packageJson.version !== 'string' || config.match(/WINCODE_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] !== packageJson.version) {
    throw new Error('package.json and WINCODE_VERSION must have the same version.');
  }
  const compiler = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(root, 'tsconfig.json')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  if (compiler.error) throw compiler.error;
  if (compiler.status !== 0) throw new Error(`TypeScript build failed (${compiler.status ?? compiler.signal}).`);
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 4096 });
  const revision = git.status === 0 && /^[a-f0-9]{40,64}$/.test(git.stdout.trim()) ? git.stdout.trim() : null;
  const manifest = await createBuildManifest(root, inputsBefore, packageJson.version, revision);
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, manifestPath);
  } finally { await fs.rm(temporary, { force: true }); }
  console.error(`[WinCode build] ${manifest.version} ${manifest.buildId}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch(error => { console.error(error.message); process.exitCode = 1; });
}
