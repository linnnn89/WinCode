import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.cwd();
const { getDefaultConfig } = await import(pathToFileURL(path.join(repo, 'src/Core/Config.ts')));
const { CacheManager } = await import(pathToFileURL(path.join(repo, 'src/Core/Cache.ts')));
const { RepomixAdapter } = await import(pathToFileURL(path.join(repo, 'src/Adapters/RepomixAdapter.ts')));
const config = getDefaultConfig(process.argv[2]);
config.adapters.repomix.useCli = false;
config.cacheLimits.maxEntryBytes = 8192;
config.cacheLimits.maxDiskEntries = 1;
const cache = new CacheManager(config.cacheDir, 500, 1, config.cacheLimits);
cache.setNamespace(config.workspaceRoot); await cache.initialize();
const packer = new RepomixAdapter(config, cache); await packer.initialize();
process.on('message', async ({ id, operation }) => {
  try {
    let result;
    if (operation === 'pack') {
      const packed = await packer.packWorkspace({ candidateFiles: ['Large.cs'], outputFormat: 'markdown' });
      result = { fromCache: packed.fromCache, contentOmitted: packed.contentOmitted, overflowPath: packed.overflowPath,
        backingFileExists: packed.overflowPath ? !!await fs.stat(packed.overflowPath).catch(() => null) : null };
    } else if (operation === 'prune') {
      await cache.set('newer-small-entry', { marker: 'second process' });
      await cache.pruneDiskCache(); result = await cache.getStats();
    } else if (operation === 'close') {
      await packer.dispose(); await cache.flush();
      process.send({ id, result: 'closed' }, () => process.disconnect()); return;
    }
    process.send({ id, result });
  } catch (error) { process.send({ id, error: String(error.stack) }); }
});
process.send({ ready: true, pid: process.pid });
