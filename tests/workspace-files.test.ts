import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { WorkspaceManager } from '../src/Core/Workspace.js';
import { getDefaultConfig } from '../src/Core/Config.js';

// 每个功能套件拥有独立缓存；并行文件不能删除彼此正在使用的缓存。
describe('workspace-files', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_workspace-files_${process.pid}`);
  const config = getDefaultConfig(root);
  config.cacheDir = testCacheDir;
  const FIXTURE_DOTNET = path.resolve(root, 'tests/fixtures/dotnet-mini');

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('2. Core: WorkspaceManager & Safe Trash Policy', () => {
    const ws = new WorkspaceManager(config);

    it('should accurately detect project environment and tools', async () => {
      const identity = await ws.identifyProject();
      assert.ok(identity.name);
      assert.ok(identity.frameworks.includes('Node.js / TypeScript'));
      assert.ok(identity.packageManagers.includes('npm/node'));
    });

    it('should scan workspace directory tree with maxDepth', async () => {
      const tree = await ws.getDirectoryTree(2);
      assert.strictEqual(tree.type, 'directory');
      assert.ok(tree.children && tree.children.length > 0);
      const childNames = tree.children.map((c) => c.name);
      assert.ok(childNames.includes('src'));
      assert.ok(!childNames.includes('node_modules'), 'Default ignores like node_modules must be excluded');
      assert.ok(!childNames.includes('.git'), '.git directory must be excluded');
    });

    it('excludes worktree git files by default while preserving explicit ignored listings', async () => {
      const fixture = await fs.mkdtemp(path.join(testCacheDir, 'git-file-'));
      await fs.writeFile(path.join(fixture, '.git'), 'gitdir: ../repository/.git/worktrees/example\n');
      await fs.writeFile(path.join(fixture, 'source.ts'), 'export const value = 1;\n');
      const workspace = new WorkspaceManager(getDefaultConfig(fixture));
      const tree = await workspace.getDirectoryTree(1);
      assert.deepStrictEqual(tree.children?.map(item => item.name), ['source.ts']);
      const listing = await workspace.listDirectory({ includeIgnored: true, maxDepth: 1 });
      assert.ok(listing.entries.some(item => item.path === '.git' && item.type === 'file'));
    });

    it('Security Boundary: Safe moveToTrash must move file and write metadata', async () => {
      const testFile = path.join(root, 'tdd_temp_file_for_trash.txt');
      await fs.writeFile(testFile, 'Crucial content that should never be permanently deleted', 'utf-8');

      const result = await ws.moveToTrash('tdd_temp_file_for_trash.txt', 'TDD safety test');
      assert.strictEqual(result.success, true);
      assert.ok(result.trashPath.includes('trash'));

      // Confirm source file no longer exists
      const srcExists = await fs.stat(testFile).then(() => true).catch(() => false);
      assert.strictEqual(srcExists, false, 'Source file must be moved away');

      // Confirm file exists in trash
      const trashExists = await fs.stat(result.trashPath).then(() => true).catch(() => false);
      assert.strictEqual(trashExists, true, 'File must exist inside trash directory');

      // Confirm audit metadata exists in trash
      const metaPath = `${result.trashPath}.meta.json`;
      const metaExists = await fs.stat(metaPath).then(() => true).catch(() => false);
      assert.strictEqual(metaExists, true, 'Audit metadata file must be created');

      const metaContent = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      assert.ok(metaContent.deletedAt);
      assert.strictEqual(metaContent.reason, 'TDD safety test');
    });

    it('Resilience: moveToTrash on non-existent file within workspace should fail gracefully without throwing', async () => {
      const result = await ws.moveToTrash('non_existent_file_99999.xyz', 'Test non-existent');
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('Failed to move file to trash'));
    });

    it('Security Boundary: moveToTrash strictly accepts only non-empty relative paths within workspace with zero rename calls', async () => {
      // Intercept fs.rename to verify zero calls on rejected inputs
      const originalRename = fs.rename;
      let renameCallCount = 0;
      (fs as any).rename = async (...args: any[]) => {
        renameCallCount++;
        return originalRename.apply(fs, args as any);
      };

      try {
        // 1. Empty or whitespace
        const emptyRes = await ws.moveToTrash('   ', 'Empty path');
        assert.strictEqual(emptyRes.success, false);
        assert.ok(emptyRes.message.includes('Path cannot be empty'));

        // 2. Absolute path (same drive)
        const absRes = await ws.moveToTrash(path.join(root, 'tdd_temp_file_for_trash.txt'), 'Absolute path');
        assert.strictEqual(absRes.success, false);
        assert.ok(absRes.message.includes('Only non-empty relative paths within the workspace are accepted'));

        // 3. Absolute path (different drive / external)
        const extAbsRes = await ws.moveToTrash('C:\\Windows\\System32\\cmd.exe', 'External absolute path');
        assert.strictEqual(extAbsRes.success, false);
        assert.ok(extAbsRes.message.includes('Only non-empty relative paths within the workspace are accepted'));

        // 4. Windows drive-relative path (e.g. C:foo or D:bar)
        const driveRelRes = await ws.moveToTrash('C:some_file.txt', 'Drive-relative path');
        assert.strictEqual(driveRelRes.success, false);
        assert.ok(driveRelRes.message.includes('Only non-empty relative paths within the workspace are accepted'));

        // 5. UNC network share path
        const uncRes = await ws.moveToTrash('\\\\server\\share\\file.txt', 'UNC path');
        assert.strictEqual(uncRes.success, false);
        assert.ok(uncRes.message.includes('Only non-empty relative paths within the workspace are accepted'));

        // 6. Relative ../ escaping workspace root
        const relEscapeRes = await ws.moveToTrash('../outside_secret.txt', 'Parent traversal escape');
        assert.strictEqual(relEscapeRes.success, false);
        assert.ok(relEscapeRes.message.includes('outside the workspace boundary'));

        // 7. Workspace root itself
        const rootRes = await ws.moveToTrash('.', 'Workspace root itself');
        assert.strictEqual(rootRes.success, false);
        assert.ok(rootRes.message.includes('outside the workspace boundary'));

        // 8. Trash directory itself
        const trashDirRes = await ws.moveToTrash('trash', 'Trash directory itself');
        assert.strictEqual(trashDirRes.success, false);
        assert.ok(trashDirRes.message.includes('Cannot move items from or within the trash directory'));

        // 9. Files inside trash directory sub-tree (prevent recursive archiving and metadata corruption)
        const testTrashFile = path.join(ws.trashDir, 'already_trashed.txt');
        await fs.mkdir(ws.trashDir, { recursive: true });
        await fs.writeFile(testTrashFile, 'already in trash', 'utf-8');
        const trashSubRes = await ws.moveToTrash('trash/already_trashed.txt', 'File inside trash');
        assert.strictEqual(trashSubRes.success, false);
        assert.ok(trashSubRes.message.includes('Cannot move items from or within the trash directory'));
        await fs.rm(testTrashFile, { force: true }).catch(() => { });

        // 10. Symlink pointing outside workspace
        const symlinkPath = path.join(root, 'temp_symlink_to_outside.txt');
        const outsideTarget = path.resolve(root, '..', 'temp_outside_real_file.txt');
        await fs.writeFile(outsideTarget, 'outside real file', 'utf-8');
        try {
          await fs.symlink(outsideTarget, symlinkPath, 'file');
          const symlinkRes = await ws.moveToTrash('temp_symlink_to_outside.txt', 'Symlink to outside');
          assert.strictEqual(symlinkRes.success, false);
          assert.ok(symlinkRes.message.includes('resolves outside the workspace via symlink or junction'));
        } catch {
          // On Windows, non-admin symlink creation may require privilege; skip if OS denies
        } finally {
          await fs.rm(symlinkPath, { force: true }).catch(() => { });
          await fs.rm(outsideTarget, { force: true }).catch(() => { });
        }

        // CRITICAL: Verify rename was NEVER called for any of the above invalid/escaping inputs
        assert.strictEqual(renameCallCount, 0, 'fs.rename call count must be ZERO for all rejected boundary inputs');
      } finally {
        (fs as any).rename = originalRename;
      }
    });

    it('Phase 2: openWorkspace parses the portable .NET fixture sln, projects, metadata and tree', async () => {
      const result = await new WorkspaceManager(getDefaultConfig(FIXTURE_DOTNET)).openWorkspace(FIXTURE_DOTNET);
      assert.strictEqual(result.type, 'dotnet');
      assert.strictEqual(result.solution, 'MiniDesk.sln');
      assert.strictEqual(result.language, 'C#');
      assert.strictEqual(result.projects, 3);
      assert.ok(result.metadata.frameworks.includes('WPF'));
      assert.equal(result.metadata.totalFiles, null);
      assert.equal(result.fileTree, undefined);
      assert.ok(result.entryPoints.length <= 8);

      ws.setRoot(root);
    });

    it('fixed workspace managers reject rebinding and isolate cross-project trash operations', async () => {
      const initialTrash = path.resolve(ws.trashDir);
      assert.strictEqual(initialTrash, path.join(root, 'trash'));

      const peerRoot = await fs.mkdtemp(path.join(testCacheDir, 'project-b-'));
      const peer = new WorkspaceManager(getDefaultConfig(peerRoot));
      try {
        await assert.rejects(ws.openWorkspace(peerRoot), (error: any) => error.errorCode === 'WORKSPACE_MISMATCH');
        assert.throws(() => ws.setRoot(peerRoot), (error: any) => error.errorCode === 'WORKSPACE_MISMATCH');
        assert.strictEqual(ws.root, root);
        await peer.openWorkspace(peerRoot);
        assert.strictEqual(peer.trashDir, path.join(peerRoot, 'trash'));

        const rejectCrossProject = await peer.moveToTrash('../../../package.json', 'Try deleting host file from fixture');
        assert.strictEqual(rejectCrossProject.success, false);
        assert.ok(rejectCrossProject.message.includes('outside the workspace boundary'));

        const tempBFile = path.join(peerRoot, 'temp_test_b_file.txt');
        await fs.writeFile(tempBFile, 'File in fixture project', 'utf-8');

        const trashBResult = await peer.moveToTrash('temp_test_b_file.txt', 'Safe deletion in fixture');
        assert.strictEqual(trashBResult.success, true);
        assert.ok(trashBResult.trashPath.startsWith(path.join(peerRoot, 'trash')), 'Must move to fixture trash');
        assert.ok(!trashBResult.trashPath.startsWith(path.join(root, 'trash')), 'Must NOT move to host trash');

        ws.setRoot(root);
        assert.strictEqual(path.resolve(ws.root), root);
        assert.strictEqual(path.resolve(ws.trashDir), path.join(root, 'trash'), 'trashDir stays bound to the original workspace');
      } finally {
        assert.strictEqual(path.dirname(peerRoot), testCacheDir);
        await fs.rm(peerRoot, { recursive: true, force: true });
      }
    });
  });
});
