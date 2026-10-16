import path from 'node:path';
import { runTests } from '../src/runTests.js';
import type { PackageConfig } from '../src/types.js';
import { makeTempRepo } from './helpers/tempRepo.js';

const VITEST = path.resolve(import.meta.dirname, '../node_modules/.bin/vitest');

const pkg = (test: string, overrides: Partial<PackageConfig> = {}): PackageConfig => ({
  name: 'app',
  dir: '.',
  language: 'typescript',
  runner: 'vitest',
  packageManager: 'npm',
  commands: { test },
  ...overrides,
});

test('runs a vitest project and returns per-test results', async () => {
  const root = await makeTempRepo({
    'tests/a.test.ts': `test('one', () => {}); test('two', () => {});`,
  });
  const run = await runTests(root, pkg(`${VITEST} run --globals`));
  expect(run.ok).toBe(true);
  expect(run.reportMissing).toBe(false);
  expect(run.results.map((r) => [r.id, r.status])).toEqual([
    ['tests/a.test.ts > one', 'passed'],
    ['tests/a.test.ts > two', 'passed'],
  ]);
  expect(run.durationMs).toBeGreaterThan(0);
});

test('reports a missing report file when the command does not write one', async () => {
  const root = await makeTempRepo({ 'a.txt': '' });
  const run = await runTests(root, pkg('echo ok'));
  expect(run).toMatchObject({ ok: true, reportMissing: true, results: [] });
  expect(run.output).toContain('ok');
});

test('ids are repo-relative for a package in a subdirectory', async () => {
  const root = await makeTempRepo({
    'packages/app/tests/a.test.ts': `test('one', () => {});`,
  });
  const run = await runTests(root, pkg(`${VITEST} run --globals`, { dir: 'packages/app' }));
  expect(run.results.map((r) => [r.id, r.file])).toEqual([
    ['packages/app/tests/a.test.ts > one', 'packages/app/tests/a.test.ts'],
  ]);
});

test('a failing test gives ok false and a failed result', async () => {
  const root = await makeTempRepo({
    'tests/a.test.ts': `test('bad', () => { expect(1).toBe(2); });`,
  });
  const run = await runTests(root, pkg(`${VITEST} run --globals`));
  expect(run.ok).toBe(false);
  expect(run.results.map((r) => [r.id, r.status])).toEqual([['tests/a.test.ts > bad', 'failed']]);
});

test('a package without a runner runs the plain command and expects no report', async () => {
  const root = await makeTempRepo({ 'a.txt': '' });
  const run = await runTests(root, pkg('echo ok', { runner: null }));
  expect(run).toMatchObject({ ok: true, reportMissing: false, results: [] });
});
