import fs from 'node:fs';
import path from 'node:path';
import { appendArgs, parseTestReport, reporterArgs } from '../../../src/adapters/node/testReport.js';
import type { Runner } from '../../../src/types.js';

const fixture = (runner: Runner) =>
  fs
    .readFileSync(path.join(import.meta.dirname, `../../fixtures/reports/${runner}.json`), 'utf8')
    .replaceAll('__ROOT__', '/repo');

describe('parseTestReport', () => {
  test.each(['vitest', 'jest', 'mocha'] as const)('%s report yields passed, failed and skipped results', (runner) => {
    const results = parseTestReport(runner, fixture(runner), '/repo');
    expect(results.map(({ id, file, status }) => ({ id, file, status }))).toEqual([
      { id: 'tests/a.test.ts > suite works', file: 'tests/a.test.ts', status: 'passed' },
      { id: 'tests/a.test.ts > suite fails', file: 'tests/a.test.ts', status: 'failed' },
      { id: 'tests/a.test.ts > suite is skipped', file: 'tests/a.test.ts', status: 'skipped' },
    ]);
  });

  test('missing durations become 0 and others are rounded', () => {
    const results = parseTestReport('vitest', fixture('vitest'), '/repo');
    expect(results.map((r) => r.durationMs)).toEqual([2, 8, 0]);
  });
});

describe('reporterArgs', () => {
  test.each([
    ['vitest', ['--reporter=json', '--outputFile=/o.json']],
    ['jest', ['--json', '--outputFile=/o.json']],
    ['mocha', ['--reporter', 'json', '--reporter-option', 'output=/o.json']],
  ] as const)('%s', (runner, expected) => {
    expect(reporterArgs(runner, '/o.json')).toEqual(expected);
  });
});

describe('appendArgs', () => {
  test.each([
    ['npm run test', 'npm run test -- --json'],
    ['npm test', 'npm test -- --json'],
    ['pnpm run test', 'pnpm run test -- --json'],
    ['pnpm test', 'pnpm test -- --json'],
    ['npx vitest run', 'npx vitest run --json'],
  ])('%s', (command, expected) => {
    expect(appendArgs(command, ['--json'])).toBe(expected);
  });
});
