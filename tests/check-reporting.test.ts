import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { runCheckStage, testReporters, testTotals } = await import(pathToFileURL(path.resolve('scripts/lib/check-stage.mjs')).href);

async function fixture(run: (directory: string, report: any, env: NodeJS.ProcessEnv) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-check-report-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try { await run(directory, { stages: [] }, env); }
  finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('wincode-check-report-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

it('failed checks preserve an early real assertion, full TAP totals, and native JUnit details', async () => fixture(async (directory, report, env) => {
  const file = path.join(directory, 'failure.test.mjs');
  await fs.writeFile(file, `import {it} from 'node:test'; import assert from 'node:assert/strict';
it('early assertion <&', () => assert.equal('actual-marker', 'expected-marker'));
for (let i=0;i<60;i++) it('later passing test '+i+' padding '.repeat(10), () => {});
it.skip('deliberate skip', () => {});`);
  await assert.rejects(runCheckStage({ directory, root: directory, report, name: 'regression', command: process.execPath,
    args: ['--test', ...testReporters(directory, 'regression'), file], env }), /regression failed/);
  assert.deepEqual(report.tests, { tests: 62, pass: 60, fail: 1, cancelled: 0, skipped: 1 });
  const stage = report.stages[0];
  assert.equal(stage.success, false);
  assert.equal(stage.exitCode, 1);
  assert.equal(stage.testSummaryComplete, true);
  assert.equal(stage.outputCaptureComplete, true);
  const log = await fs.readFile(path.join(directory, stage.logFile), 'utf8');
  assert.match(log, /not ok 1 - early assertion/);
  assert.match(log, /actual-marker/);
  assert.doesNotMatch(stage.error, /actual-marker/); // Failure was deliberately placed before the old tail-only report.
  const xml = await fs.readFile(path.join(directory, stage.junitFile), 'utf8');
  assert.match(xml, /<failure/);
  assert.match(xml, /actual-marker/);
  assert.match(xml, /early assertion &lt;&amp;/);
}));

it('successful real tests retain totals and the emitted JUnit path', async () => fixture(async (directory, report, env) => {
  const file = path.join(directory, 'passing.test.mjs');
  await fs.writeFile(file, "import {it} from 'node:test'; it('passing', () => {});");
  await runCheckStage({ directory, root: directory, report, name: 'regression', command: process.execPath,
    args: ['--test', ...testReporters(directory, 'regression'), file], env });
  assert.equal(report.stages[0].success, true);
  assert.equal(report.tests.pass, 1);
  assert.equal(report.stages[0].junitFile, 'regression.xml');
}));

it('a zero exit with missing TAP totals is not treated as a passing suite', async () => fixture(async (directory, report, env) => {
  const file = path.join(directory, 'incomplete.mjs');
  await fs.writeFile(file, "console.log('TAP version 13');");
  await assert.rejects(runCheckStage({ directory, root: directory, report, name: 'regression', command: process.execPath,
    args: [file, '--test'], env }), /regression failed/);
  assert.equal(report.stages[0].exitCode, 0);
  assert.match(report.stages[0].error, /complete TAP summary/);
  assert.equal(report.tests, null);
  assert.equal(report.stages[0].testSummaryComplete, false);
  assert.equal(report.stages[0].junitFile, null);
  assert.equal(testTotals('TAP version 13\n# tests 1\n'), null);
}));

it('capture overflow and launch failures retain explicit process errors', async () => fixture(async (directory, report, env) => {
  await assert.rejects(runCheckStage({ directory, root: directory, report, name: 'overflow', command: process.execPath,
    args: ['-e', "require('node:fs').writeSync(1,'x'.repeat(256*1024))"], env, maxBuffer: 1024 }), /overflow failed/);
  assert.equal(report.stages[0].outputCaptureComplete, false);
  assert.equal(report.stages[0].processError.code, 'ENOBUFS');
  await assert.rejects(runCheckStage({ directory, root: directory, report, name: 'launch',
    command: path.join(directory, 'missing-program'), args: [], env }), /launch failed/);
  assert.equal(report.stages[1].processError.code, 'ENOENT');
  assert.equal(report.stages[1].exitCode, null);
  assert.equal(report.stages[1].outputCaptureComplete, false);
  assert.equal(await fs.readFile(path.join(directory, 'launch.log'), 'utf8'), '');
}));
