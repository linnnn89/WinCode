import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

/** verifyInputChanges: 使用同一自有会话，入口负责顺序、快照代次及最终清理。 */
export async function verifyInputChanges(ctx) {
  const { root, source, code, child, next, query, reload, assertStale, report, ready, burstQuery } = ctx;
  // 非约定后缀的实际 MSBuild Import 用显式列表补齐；其变化必须重载真实编译条件。
  await fs.writeFile(path.join(root, 'build-inputs/custom.rules'), '<Project><PropertyGroup><DefineConstants>$(DefineConstants);EXTRA</DefineConstants></PropertyGroup></Project>');
  await assertStale('explicit custom-extension import invalidates its semantic snapshot');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 3);
  await fs.writeFile(path.join(root, 'build-inputs/custom.rules'), '<Project />');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 2);
  report.scenarios.push('reload applies and removes conditions from the explicitly tracked import');
  await fs.appendFile(path.join(root, 'App/details.data'), 'changed\n');
  await assertStale('loaded AdditionalFiles are tracked regardless of extension');
  await reload();
  await fs.unlink(path.join(root, 'schema.yaml'));
  const missingInput = await query(source.indexOf('Save(int'));
  assert.equal(missingInput.errorCode, 'INPUT_UNAVAILABLE');
  assert.equal(missingInput.references, undefined);
  child.stdin.write(JSON.stringify({ id: 'missing-input-reload', operation: 'reload' }) + '\n');
  assert.equal((await next()).errorCode, 'INPUT_UNAVAILABLE');
  await fs.writeFile(path.join(root, 'schema.yaml'), 'mode: restored\n');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 2);
  report.scenarios.push('missing explicit input blocks reload until restored, without silently dropping the requirement');
  // 反证：预加载等待不能吞掉求值期间的输入事件，即使文件内容散列没有变化。
  await fs.writeFile(path.join(root, 'build-inputs/custom.rules'), '<Project><Target Name="TouchTrackedInput" BeforeTargets="Compile"><Touch Files="$(MSBuildThisFileDirectory)../schema.yaml" /></Target></Project>');
  child.stdin.write(JSON.stringify({ id: 'changed-during-load', operation: 'reload' }) + '\n');
  const changedDuringLoad = await next();
  assert.equal(changedDuringLoad.success, false, JSON.stringify(changedDuringLoad));
  assert.equal(changedDuringLoad.errorCode, 'INPUTS_CHANGED');
  assert.equal((await query(source.indexOf('Save(int'))).errorCode, 'SNAPSHOT_STALE');
  report.scenarios.push('actual MSBuild input touch during reload refuses publication even when content hashes match');
  await fs.writeFile(path.join(root, 'build-inputs/custom.rules'), '<Project />');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 2);
  report.scenarios.push('removing the input-writing target allows explicit recovery without replaying a failed query');
  await fs.writeFile(path.join(root, 'App/Use.cs'), code['App/Use.cs'].replace('Api.Save(3)', 'Other.Save(3)'));
  await assertStale('immediate query after source edit refuses old references');
  const firstSnapshot = ctx.snapshot;
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 1);
  assert.equal((await query(source.indexOf('Save(int'), { snapshot: firstSnapshot })).errorCode, 'SNAPSHOT_STALE');
  report.scenarios.push('reload reflects changed call and permanently expires old snapshot');

  await fs.writeFile(path.join(root, 'App/Extra.cs'), 'class Extra { void Run() { Demo.Api.Save(9); } }');
  await assertStale('new source file invalidates the original reference file set');
  await reload();
  const added = await query(source.indexOf('Save(int'));
  assert.equal(added.totalReferences, 2);
  assert.ok(added.references.some(item => item.file.endsWith('Extra.cs')));
  report.scenarios.push('reloaded MSBuild Compile glob includes new call sites');

  await fs.rename(path.join(root, 'App/Extra.cs'), path.join(root, 'App/Moved.cs'));
  await assertStale('renamed file invalidates old locations');
  await reload();
  const renamed = await query(source.indexOf('Save(int'));
  assert.ok(renamed.references.some(item => item.file.endsWith('Moved.cs')));
  assert.ok(renamed.references.every(item => !item.file.endsWith('Extra.cs')));
  await fs.unlink(path.join(root, 'App/Moved.cs'));
  await assertStale('deleted file invalidates old references');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 1);
  report.scenarios.push('rename and delete reloads return only current paths');

  await fs.appendFile(path.join(root, 'App/obj/project.assets.json'), '\n');
  await assertStale('obj assets changes are tracked before another query');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 1);
  await fs.writeFile(path.join(root, 'Directory.Build.props'), '<Project><PropertyGroup><DefineConstants>TRACE;EXTRA</DefineConstants></PropertyGroup></Project>');
  await assertStale('Directory.Build.props change invalidates compiled conditions');
  await reload();
  const conditional = await query(source.indexOf('Save(int'));
  assert.equal(conditional.totalReferences, 2);
  assert.ok(conditional.references.some(item => item.file.endsWith('Conditional.cs')));
  report.scenarios.push('reload applies actual MSBuild preprocessor configuration');

  const appProject = path.join(root, 'App/App.csproj');
  const originalProject = await fs.readFile(appProject, 'utf8');
  await fs.writeFile(appProject, originalProject.replace('</Project>', '<ItemGroup><Compile Remove="Conditional.cs" /></ItemGroup></Project>'));
  await assertStale('project Compile changes invalidate the loaded project graph');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 1);
  report.scenarios.push('reload respects project file exclusions');

  await fs.writeFile(appProject, '<Project');
  await assertStale('malformed project change refuses the last valid snapshot');
  child.stdin.write(JSON.stringify({ id: 'broken-reload', operation: 'reload' }) + '\n');
  const failedReload = await next(150000);
  report.failedReload = failedReload;
  assert.equal(failedReload.id, 'broken-reload');
  assert.equal(failedReload.success, false);
  assert.equal(failedReload.errorCode, 'PROJECT_LOAD_FAILED');
  assert.equal((await query(source.indexOf('Save(int'))).errorCode, 'SNAPSHOT_STALE');
  await fs.writeFile(appProject, originalProject);
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 2);
  report.scenarios.push('failed reload cannot resurrect old state; repaired input recovers explicitly');

}

/** verifyBudgetsAndEncoding: 使用同一自有会话，入口负责顺序、快照代次及最终清理。 */
export async function verifyBudgetsAndEncoding(ctx) {
  const { root, source, code, child, next, query, reload, assertStale, report, ready, burstQuery } = ctx;
  const excessive = path.join(root, 'oversized-input.bin');
  const handle = await fs.open(excessive, 'wx');
  try { await handle.truncate(33 * 1024 * 1024); } finally { await handle.close(); }
  const beforeUnrelated = await query(source.indexOf('Save(int'));
  await fs.writeFile(path.join(root, 'README.md'), '# unrelated notes\n');
  const afterUnrelated = await query(source.indexOf('Save(int'));
  assert.equal(beforeUnrelated.success, true, JSON.stringify(beforeUnrelated));
  assert.equal(afterUnrelated.success, true, JSON.stringify(afterUnrelated));
  assert.equal(afterUnrelated.snapshot, ctx.snapshot);
  assert.equal(afterUnrelated.freshness.fingerprint, beforeUnrelated.freshness.fingerprint);
  assert.equal(afterUnrelated.totalReferences, 2);
  await fs.unlink(excessive);
  report.scenarios.push('unrelated 33 MiB binary and README do not block or invalidate semantic queries');
  const requiredHandle = await fs.open(path.join(root, 'schema.yaml'), 'w');
  try { await requiredHandle.truncate(33 * 1024 * 1024); } finally { await requiredHandle.close(); }
  assert.equal((await query(source.indexOf('Save(int'))).errorCode, 'INPUT_BUDGET_EXCEEDED');
  await fs.writeFile(path.join(root, 'schema.yaml'), 'mode: restored\n');
  await reload();
  report.scenarios.push('input byte cap still rejects an oversized explicit input without a partial fingerprint');

  // 原始字节按项目 CodePage/BOM 解码；同一个非 ASCII 符号及引用必须保持 UTF-16 身份。
  const encodedSource = '// café\npublic class Café {}\nclass EncodedUse { Café value = new Café(); }\n';
  const libraryProject = path.join(root, 'Lib/Lib.csproj');
  const libraryXml = await fs.readFile(libraryProject, 'utf8');
  for (const [label, codePage, bytes] of [
    ['UTF-8 without BOM', 65001, Buffer.from(encodedSource, 'utf8')],
    ['UTF-8 BOM', 65001, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encodedSource, 'utf8')])],
    ['UTF-16 BOM', 65001, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(encodedSource, 'utf16le')])],
    ['CodePage 1252', 1252, Buffer.from(encodedSource, 'latin1')],
  ]) {
    await fs.writeFile(libraryProject, libraryXml.replace('</PropertyGroup>', `<CodePage>${codePage}</CodePage></PropertyGroup>`));
    await fs.writeFile(path.join(root, 'Lib/Encoded.cs'), bytes);
    const encodedReady = await reload();
    assert.deepEqual(encodedReady.compilationErrors, [], label);
    const symbolId = `encoded-${ctx.nextId()}`;
    child.stdin.write(JSON.stringify({ id: symbolId, operation: 'symbols', snapshot: ctx.snapshot, query: 'Café' }) + '\n');
    const symbols = await next();
    assert.equal(symbols.id, symbolId);
    assert.equal(symbols.success, true, JSON.stringify(symbols));
    assert.equal(symbols.symbols.length, 1, label);
    assert.equal(symbols.symbols[0].name, 'Café');
    assert.equal(symbols.symbols[0].location.position, encodedSource.indexOf('Café'));
    const refs = await query(encodedSource.indexOf('Café'), { file: 'Lib/Encoded.cs', symbolName: 'Café' });
    assert.equal(refs.success, true, JSON.stringify(refs));
    assert.equal(refs.totalReferences, 2, label);
    for (const reference of refs.references) assert.equal(encodedSource.slice(reference.start, reference.start + reference.length), 'Café');
    report.scenarios.push(`${label} preserves compiler symbol and exact UTF-16 references`);
  }
  await fs.unlink(path.join(root, 'Lib/Encoded.cs'));
  await fs.writeFile(libraryProject, libraryXml);
  await reload();

}
