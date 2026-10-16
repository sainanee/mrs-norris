import path from 'node:path';
import { runTests } from '../src/runTests.js';
import type { PackageConfig } from '../src/types.js';
import { makeTempRepo } from './helpers/tempRepo.js';

const VITEST = path.resolve(import.meta.dirname, '../node_modules/.bin/vitest');

const pkg = (test: string): PackageConfig => ({
  name: 'app',
  dir: '.',
  language: 'typescript',
  runner: 'vitest',
  packageManager: 'npm',
  commands: { test },
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
