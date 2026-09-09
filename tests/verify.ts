import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';

async function runVerification() {
  console.log('=== [WinCode MCP Gateway Verification] ===');

  const config = getDefaultConfig(process.cwd());
  const router = new ToolRouter(config);

  console.log('1. Initializing ToolRouter...');
  await router.initialize();
  console.log('✓ ToolRouter initialized successfully.');

  console.log('2. Testing WorkspaceManager...');
  const identity = await router.workspace.identifyProject();
  console.log('   Project identity:', JSON.stringify(identity, null, 2));
  assert.ok(identity.name, 'Project name should exist');
  assert.ok(identity.frameworks.includes('Node.js / TypeScript'), 'Should detect Node.js / TypeScript framework');
  console.log('✓ WorkspaceManager identified project.');

  console.log('3. Testing CacheManager...');
  await router.cache.set('test_key', { hello: 'world' });
  const cached = await router.cache.get<{ hello: string }>('test_key');
  assert.strictEqual(cached?.hello, 'world', 'Cache should store and retrieve data');
  console.log('✓ CacheManager verified.');

  console.log('4. Testing LocalTextAdapter Symbol Indexing & References...');
  const symbols = await router.text.findSymbols('ToolRouter');
  console.log(`   Found ${symbols.length} symbols matching "ToolRouter":`, symbols.map(s => `${s.kind} ${s.name} (${s.file}:${s.line})`));
  assert.ok(symbols.length > 0, 'Should find ToolRouter class');

  const refs = await router.text.findReferences('ToolRouter');
  console.log(`   Found ${refs.length} references to "ToolRouter"`);
  assert.ok(refs.length > 0, 'Should find references to ToolRouter');
  console.log('✓ LocalTextAdapter symbol search & reference tracking verified.');

  console.log('5. Testing RepomixAdapter & ContextManager...');
  const context = await router.context.prepareContext({
    task: 'Refactor ToolRouter to add extensions',
    candidateFiles: ['src/Core/ToolRouter.ts', 'package.json'],
    outputFormat: 'markdown',
  });
  console.log(`   Estimated tokens: ${context.metrics.estimatedTokens}, packedFiles: ${context.metrics.packedFiles}, evidence=${context.evidence.length}`);
  assert.ok(context.formattedContent.length > 0, 'Should have packed context content');
  assert.ok(context.evidence.length > 0, 'Should have file-backed evidence for candidate files');
  assert.strictEqual(context.evidenceInsufficient, false);
  console.log('✓ ContextManager & RepomixAdapter verified.');

  console.log('6. Testing ArchitectureAnalyzer...');
  const archReport = await router.architecture.analyze();
  console.log('   Architecture report layers:', archReport.layers.map(l => `${l.name} (${l.matchedFiles.length} files)`));
  assert.ok(archReport.layers.length > 0, 'Architecture report should have layers');
  console.log('✓ ArchitectureAnalyzer verified.');

  console.log('7. Testing ImpactAnalyzer...');
  const impact = await router.impact.analyzeImpact('ToolRouter');
  console.log(`   Impact for ToolRouter: Risk=${impact.riskLevel}, Confidence=${impact.confidence}, Refs=${impact.referencesCount}, Affected=${impact.affected.join(', ')}`);
  assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'].includes(impact.riskLevel));
  assert.ok(impact.recommendations.length > 0, 'Impact analyzer should report recommendations');
  assert.ok(!impact.formattedReport.includes('Safe for targeted in-place refactoring'));

  // Verify unknown symbol returns UNKNOWN
  const unknownImpact = await router.impact.analyzeImpact('NonExistent_Probe_Symbol_999');
  assert.strictEqual(unknownImpact.riskLevel, 'UNKNOWN', 'Unindexed symbol must be reported as UNKNOWN');
  assert.strictEqual(unknownImpact.confidence, 'UNCERTAIN');
  console.log('✓ ImpactAnalyzer verified (including UNKNOWN safety guard).');

  console.log('8. Testing ProjectDiagnostics...');
  const diag = await router.diagnostics.runDiagnostics();
  console.log(`   Project diagnostics (healthy=${diag.overallHealthy}):`, diag.diagnostics.map(d => `[${d.status}] ${d.message}`));
  assert.ok(diag.diagnostics.length > 0, 'Diagnostics should run');
  console.log('✓ ProjectDiagnostics verified.');

  console.log('9. Testing Safe Trash Policy (File removal must move to trash)...');
  const tempTestFile = path.join(process.cwd(), 'temp_test_to_trash.txt');
  await fs.writeFile(tempTestFile, 'This is a temporary file to verify safe trash move policy.', 'utf-8');
  assert.ok(await fs.stat(tempTestFile).then(() => true).catch(() => false), 'Temp file should exist');

  const trashResult = await router.workspace.moveToTrash('temp_test_to_trash.txt', 'Automated verification test of trash policy');
  console.log('   Trash operation result:', trashResult.message);
  assert.ok(trashResult.success, 'Trash operation should succeed');

  const existsOriginal = await fs.stat(tempTestFile).then(() => true).catch(() => false);
  const existsInTrash = await fs.stat(trashResult.trashPath).then(() => true).catch(() => false);
  assert.strictEqual(existsOriginal, false, 'Original file should no longer exist in original path');
  assert.strictEqual(existsInTrash, true, 'File should now exist inside trash/ folder');
  console.log('✓ Safe trash policy strictly verified.');

  await router.dispose();
  console.log('\n=== ALL 9 VERIFICATION CHECKS PASSED SUCCESSFULLY! ===');
}

runVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
