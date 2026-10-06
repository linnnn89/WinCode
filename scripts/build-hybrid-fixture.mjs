import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDotnet, runDotnet } from './lib/dotnet.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.stdout.write(runDotnet(resolveDotnet(root), ['publish', 'tests/fixtures/wpf-ui-review/wpf-ui-review.csproj',
  '-c', 'Release', '--no-self-contained', '--no-restore', '-p:ContinuousIntegrationBuild=true'], root));
