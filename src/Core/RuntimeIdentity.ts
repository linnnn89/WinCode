import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINCODE_VERSION } from './Config.js';

export interface BuildIdentity {
  status: 'verified' | 'unknown';
  buildId: string | null;
  version: string;
  reason?: string;
  sourceHash?: string;
  artifactHash?: string;
  revision?: string | null;
  builtAt?: string;
}

export interface RuntimeIdentity {
  instanceId: string;
  startedAt: string;
  nodeVersion: string;
  build: Readonly<BuildIdentity>;
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Read this module's build, never the analyzed workspace. Exported for isolated manifest tests. */
export function loadBuildIdentity(moduleUrl = import.meta.url, expectedVersion = WINCODE_VERSION): BuildIdentity {
  const unknown = (reason: string): BuildIdentity => ({ status: 'unknown', buildId: null, version: expectedVersion, reason });
  let modulePath: string;
  try { modulePath = fileURLToPath(moduleUrl); } catch { return unknown('identity-read-failed'); }
  if (/\.[cm]?ts$/i.test(modulePath)) return unknown('development-source');
  const artifactRoot = path.resolve(path.dirname(modulePath), '..');
  const manifestPath = path.join(artifactRoot, 'build-manifest.json');
  try {
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.size > 524288) return unknown('manifest-invalid');
    const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object') return unknown('manifest-invalid');
    const value = manifest as Record<string, unknown>;
    if (value.formatVersion !== 1 || !isHash(value.buildId) || !isHash(value.sourceHash) || !isHash(value.artifactHash) ||
      typeof value.version !== 'string' || typeof value.builtAt !== 'string' || !Number.isFinite(Date.parse(value.builtAt)) ||
      !(value.revision === null || (typeof value.revision === 'string' && /^[a-f0-9]{40,64}$/.test(value.revision))) ||
      !Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > 2048) return unknown('manifest-invalid');
    if (value.version !== expectedVersion) return unknown('version-mismatch');
    const artifacts: Array<{ path: string; sha256: string }> = [];
    const seen = new Set<string>();
    const realRoot = fs.realpathSync(artifactRoot);
    let totalBytes = 0;
    for (const entry of value.artifacts) {
      if (!entry || typeof entry !== 'object') return unknown('manifest-invalid');
      const item = entry as Record<string, unknown>;
      if (typeof item.path !== 'string' || !item.path || item.path.length > 1024 || item.path.includes('\\') ||
        item.path.split('/').some(segment => segment === '..' || segment === '.' || !segment) ||
        /^[a-z]:/i.test(item.path) || !/\.[cm]?js$/.test(item.path) || !isHash(item.sha256) || seen.has(item.path)) return unknown('manifest-invalid');
      seen.add(item.path);
      const full = path.resolve(artifactRoot, item.path);
      const real = fs.realpathSync(full);
      const relative = path.relative(realRoot, real);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return unknown('manifest-invalid');
      const artifactStat = fs.statSync(real);
      totalBytes += artifactStat.size;
      if (!artifactStat.isFile() || artifactStat.size > 8388608 || totalBytes > 67108864) return unknown('artifact-verification-limit');
      if (sha256(fs.readFileSync(real)) !== item.sha256) return unknown('artifact-mismatch');
      artifacts.push({ path: item.path, sha256: item.sha256 });
    }
    // A manifest for an unrelated directory cannot identify the running module.
    const ownRelative = path.relative(artifactRoot, modulePath).replace(/\\/g, '/');
    if (!seen.has(ownRelative)) return unknown('manifest-invalid');
    artifacts.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (sha256(JSON.stringify(artifacts)) !== value.artifactHash ||
      sha256(JSON.stringify({ version: value.version, sourceHash: value.sourceHash, artifactHash: value.artifactHash })) !== value.buildId) return unknown('manifest-invalid');
    return {
      status: 'verified', buildId: value.buildId, version: value.version,
      sourceHash: value.sourceHash, artifactHash: value.artifactHash,
      revision: value.revision as string | null, builtAt: value.builtAt,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return unknown(fs.existsSync(manifestPath) ? 'artifact-mismatch' : 'manifest-missing');
    return unknown(error instanceof SyntaxError ? 'manifest-invalid' : 'identity-read-failed');
  }
}

/** Snapshot once at module initialization: rebuilding files cannot relabel a live process. */
export const RUNTIME_IDENTITY: Readonly<RuntimeIdentity> = Object.freeze({
  instanceId: randomUUID(),
  startedAt: new Date().toISOString(),
  nodeVersion: process.version,
  build: Object.freeze(loadBuildIdentity()),
});
