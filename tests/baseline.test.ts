import { runBaseline } from '../src/baseline.js';
import type { PackageConfig, TestResult, TestRun } from '../src/types.js';

const pkg: PackageConfig = {
  name: 'app',
  dir: 'packages/app',
  language: 'typescript',
  runner: 'vitest',
  packageManager: 'npm',
  commands: { test: 'npm test', typecheck: 'npm run typecheck', lint: 'npm run lint' },
};

const result = (id: string, status: TestResult['status']): TestResult => ({ id, file: 'a.test.ts', status, durationMs: 1 });

const run = (results: TestResult[], overrides: Partial<TestRun> = {}): TestRun => ({
  ok: results.every((r) => r.status !== 'failed'),
  results,
  durationMs: 10,
  reportMissing: false,
  output: '',
  ...overrides,
});

const pass = { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };

const baseline = (runs: TestRun[], runCommand = async () => pass) => {
  const queue = [...runs];
  return runBaseline('/repo', pkg, { runTests: async () => queue.shift()!, runCommand, runs: runs.length });
};

const green = () => run([result('t1', 'passed'), result('t2', 'passed'), result('t3', 'skipped')]);

test('identical passing runs are green', async () => {
  const b = await baseline([green(), green()]);
  expect(b).toMatchObject({
    pkgDir: 'packages/app',
    ok: true,
    failing: [],
    flaky: [],
    passing: ['t1', 't2'],
    testCount: 2,
    durationMs: 10,
    problems: [],
    warnings: [],
  });
});

test('a test failing in only one run is flaky and not passing', async () => {
  const b = await baseline([run([result('t1', 'failed'), result('t2', 'passed')]), run([result('t1', 'passed'), result('t2', 'passed')])]);
  expect(b).toMatchObject({ ok: true, flaky: ['t1'], failing: [], passing: ['t2'] });
});

test('a test failing in every run is failing', async () => {
  const failed = () => run([result('t1', 'failed'), result('t2', 'passed')]);
  const b = await baseline([failed(), failed()]);
  expect(b).toMatchObject({ ok: false, failing: ['t1'], flaky: [], passing: ['t2'], problems: [] });
});

test('a non-zero exit with only passed results means a suite failed to load', async () => {
  const b = await baseline([run([result('t1', 'passed')], { ok: false }), run([result('t1', 'passed')], { ok: false })]);
  expect(b.ok).toBe(false);
  expect(b.problems).toEqual(['Test command exits non-zero at baseline: npm test']);
});

test.each([
  ['typecheck', 'npm run typecheck', 'Type-check fails at baseline'],
  ['lint', 'npm run lint', 'Lint fails at baseline'],
])('a failing %s command is a problem and runs in the package directory', async (_name, cmd, problem) => {
  const calls: [string, string][] = [];
  const runCommand = async (command: string, opts: { cwd: string }) => {
    calls.push([command, opts.cwd]);
    return { ...pass, exitCode: command === cmd ? 1 : 0 };
  };
  const b = await baseline([green(), green()], runCommand);
  expect(b.ok).toBe(false);
  expect(b.problems).toEqual([`${problem}: ${cmd}`]);
  expect(calls).toContainEqual([cmd, '/repo/packages/app']);
});

test('a missing report falls back to exit codes with a warning', async () => {
  const missing = () => run([], { ok: true, reportMissing: true });
  const b = await baseline([missing(), missing()]);
  expect(b.ok).toBe(true);
  expect(b.problems).toEqual([]);
  expect(b.warnings).toHaveLength(1);
  expect(b.warnings[0]).toContain('Continuing with exit codes only');
});

test.each([
  ['mixed exit codes', [true, false], 'Test suite passes only sometimes: npm test'],
  ['all runs failing', [false, false], 'Tests fail at baseline: npm test'],
])('without per-test results, %s is judged by exit code', async (_name, oks, problem) => {
  const b = await baseline(oks.map((ok) => run([], { ok })));
  expect(b.ok).toBe(false);
  expect(b.problems).toEqual([problem]);
});
