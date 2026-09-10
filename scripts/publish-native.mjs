/** Canonical native Release publish: bind source inputs and the complete output at build time. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNativeInputs, nativeComponents, sealNativeBuild } from './delivery-manifest.mjs';
import { resolveDotnet, runDotnet } from './lib/dotnet.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(nativeComponents, component)) throw new Error('Usage: node scripts/publish-native.mjs host|codeHost|tray (locked restore must already be complete)');
const spec = nativeComponents[component];
// 删除的只是已知发布目录内的旧回执；发布失败时不能留下旧的成功证明。
await fs.rm(path.join(root, spec.output, 'native-build-manifest.json'), { force: true });
const inputs = await collectNativeInputs(root, component);
const sdk = resolveDotnet(root);
const output = runDotnet(sdk, ['publish', `${spec.project}/${path.basename(spec.project)}.csproj`, '-c', 'Release',
  ...(component === 'host' ? ['-r', 'win-x64'] : []), '--no-self-contained', '--no-restore',
  '-p:ContinuousIntegrationBuild=true', `-p:PathMap=${root}=/_/WinCode`], root, 180000);
process.stdout.write(output);
await sealNativeBuild(root, component, inputs);
console.log(`[native-build] ${component}: source and published artifacts recorded`);
