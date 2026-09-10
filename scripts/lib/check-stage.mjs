import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function testTotals(output) {
  const totals = Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)\r?$/gm)]
    .map(match => [match[1], Number(match[2])]));
  return totals.tests > 0 && ['tests', 'pass', 'fail', 'cancelled', 'skipped']
    .every(key => Number.isSafeInteger(totals[key]) && totals[key] >= 0) ? totals : null;
}

export const testReporters = (directory, name) => ['--test-reporter=tap', '--test-reporter-destination=stdout',
  '--test-reporter=junit', `--test-reporter-destination=${path.join(directory, `${name}.xml`)}`];

/** Persist the captured output and failed-stage summary before propagating failure to check.mjs. */
export async function runCheckStage({ report, directory, root, name, command, args, env,
  timeout = 300000, maxBuffer = 8 * 1024 * 1024 }) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const logFile = `${name}.log`;
  await fs.writeFile(path.join(directory, logFile), output);
  const isTest = args.includes('--test');
  const tests = isTest ? testTotals(result.stdout ?? '') : null;
  const junitFile = isTest && await fs.stat(path.join(directory, `${name}.xml`)).then(stat => stat.isFile(),
    error => { if (error.code === 'ENOENT') return false; throw error; }) ? `${name}.xml` : null;
  const summaryError = isTest && !tests ? 'Test process did not return a complete TAP summary.' : null;
  const success = !result.error && result.status === 0 && !summaryError && (!tests || (!tests.fail && !tests.cancelled));
  const stage = { name, command: [command, ...args].map(arg => arg.replaceAll(root, '<repository>').slice(0, 512)),
    success, durationMs: Date.now() - started, exitCode: result.status, signal: result.signal, logFile,
    outputCaptureComplete: !result.error,
    ...(isTest ? { tests, testSummaryComplete: tests !== null, junitFile } : {}),
    ...(result.error ? { processError: { code: result.error.code ?? null, message: result.error.message.slice(0, 2000) } } : {}),
    ...(success ? {} : { error: (result.error?.message ?? summaryError ?? output.slice(-2000)).slice(0, 2000) }) };
  report.stages.push(stage);
  if (isTest) report.tests = tests;
  if (!success) throw new Error(`${name} failed; see ${path.join(directory, logFile)}`);
  return result.stdout;
}
