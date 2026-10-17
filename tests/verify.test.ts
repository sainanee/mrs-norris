import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { changeId } from '../src/changeId.js';
import { Git } from '../src/git.js';
import { newRunLog } from '../src/runlog.js';
import type { PackageConfig, PlannedChange, TestResult, TestRun } from '../src/types.js';
import { applyAndVerify, type VerifyContext } from '../src/verify.js';
import { makeTempRepo } from './helpers/tempRepo.js';

const ORIGINAL = 'export const a = 1;\n';

const pkg = (dir = '.', commands: Partial<PackageConfig['commands']> = {}): PackageConfig => ({
  name: 'app',
  dir,
  language: 'typescript',
  runner: null,
  packageManager: 'npm',
  commands: { test: 'node check.js', ...commands },
});

async function setup(overrides: Partial<VerifyContext> = {}) {
  const root = await makeTempRepo({
    'src/a.ts': ORIGINAL,
    'check.js': "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('src/a.ts', 'utf8').includes('BROKEN') ? 1 : 0);\n",
  });
  const ctx: VerifyContext = {
    root,
    git: new Git(root),
    packages: [pkg()],
    flaky: new Set(),
    baselinePassing: new Set(),
    log: newRunLog(),
    ...overrides,
  };
  const write = (file: string, content: string) => fs.writeFile(path.join(root, file), content);
  const read = (file: string) => fs.readFile(path.join(root, file), 'utf8');
  return { root, ctx, write, read };
}

const change = (allowedPaths = ['src/a.ts']): PlannedChange => ({
  id: changeId('comments', 'src/a.ts'),
  category: 'comments',
  title: 'T',
  reason: 'R',
  allowedPaths,
});

const result = (id: string, status: TestResult['status']): TestResult => ({ id, file: 'x.test.ts', status, durationMs: 1 });
const stubRun = (ok: boolean, results: TestResult[]) => async (): Promise<TestRun> =>
  ({ ok, results, durationMs: 1, reportMissing: false, output: '' });

test('a valid edit is committed with the change-id trailer', async () => {
  const { root, ctx, write } = await setup();
  const record = await applyAndVerify(ctx, change(), () => write('src/a.ts', 'export const a = 2;\n'));
  expect(record).toMatchObject({ status: 'committed', files: ['src/a.ts'] });
  const { stdout } = await execa('git', ['log', '-1', '--format=%B'], { cwd: root });
  expect(stdout.trimEnd()).toBe(`mrs-norris(comments): T\n\nR\n\nMrs-Norris-Change-Id: ${change().id}`);
  expect(record.commit).toBe(await ctx.git.head());
  expect(await ctx.git.isClean()).toBe(true);
  expect(ctx.log.changes).toEqual([record]);
});

test('an edit that breaks the tests is rolled back', async () => {
  const { ctx, write, read } = await setup();
  const record = await applyAndVerify(ctx, change(), () => write('src/a.ts', 'BROKEN\n'));
  expect(record.status).toBe('rolled-back');
  expect(record.detail).toMatch(/^tests failed in \./);
  expect(await read('src/a.ts')).toBe(ORIGINAL);
  expect(ctx.log.changes).toEqual([record]);
});

test.each([
  ['typecheck', { typecheck: 'exit 1', lint: 'exit 1' }],
  ['lint', { typecheck: 'true', lint: 'exit 1' }],
])('a failing %s is rolled back before later checks and packages run', async (label, commands) => {
  const runTests = vi.fn(stubRun(true, []));
  const { ctx, write, read } = await setup({ packages: [pkg('.', commands), pkg('packages/b')], runTests });
  const record = await applyAndVerify(ctx, change(), () => write('src/a.ts', 'export const a = 2;\n'));
  expect(record.detail).toMatch(new RegExp(`^${label} failed in \\.`));
  expect(runTests).not.toHaveBeenCalled();
  expect(await read('src/a.ts')).toBe(ORIGINAL);
});

test('a check that modifies files is rolled back', async () => {
  const { ctx, write, read } = await setup({ packages: [pkg('.', { lint: 'echo x >> src/a.ts' })] });
  const record = await applyAndVerify(ctx, change(), () => write('src/a.ts', 'export const a = 2;\n'));
  expect(record).toMatchObject({ status: 'rolled-back', detail: 'a check modified files: src/a.ts' });
  expect(await read('src/a.ts')).toBe(ORIGINAL);
  expect(await ctx.git.isClean()).toBe(true);
});

test.each([
  ['apply', () => Promise.reject(new Error('network down')), undefined],
  ['proof', () => Promise.resolve(), () => Promise.reject(new Error('network down'))],
])('%s throwing is rolled back with the error', async (_, fail, proof) => {
  const { ctx, write, read } = await setup();
  const apply = async () => {
    await write('src/a.ts', 'export const a = 2;\n');
    await fail();
  };
  const record = await applyAndVerify(ctx, change(), apply, proof);
  expect(record).toMatchObject({ status: 'rolled-back', detail: 'error: network down' });
  expect(await read('src/a.ts')).toBe(ORIGINAL);
  expect(await ctx.git.isClean()).toBe(true);
});

test.each([
  [['src/a.ts'], 'src/other.ts'],
  [['src/a'], 'src/a.ts'],
])('with allowedPaths %j, touching %s is rolled back', async (allowedPaths, outside) => {
  const { root, ctx, write, read } = await setup();
  const apply = async () => {
    await write('src/a.ts', 'export const a = 2;\n');
    await write('src/other.ts', 'export const b = 1;\n');
  };
  const record = await applyAndVerify(ctx, change(allowedPaths), apply);
  expect(record.status).toBe('rolled-back');
  expect(record.detail).toContain(outside);
  expect(await read('src/a.ts')).toBe(ORIGINAL);
  await expect(fs.access(path.join(root, 'src/other.ts'))).rejects.toThrow();
});

test('files under an allowed directory are committed', async () => {
  const { ctx, write } = await setup();
  const record = await applyAndVerify(ctx, change(['src']), () => write('src/other.ts', 'export const b = 1;\n'));
  expect(record).toMatchObject({ status: 'committed', files: ['src/other.ts'] });
});

test('an apply that changes nothing is skipped', async () => {
  const { ctx } = await setup();
  const record = await applyAndVerify(ctx, change(), async () => {});
  expect(record).toMatchObject({ status: 'skipped', detail: 'no change produced', files: [] });
  expect(ctx.log.changes).toEqual([record]);
});

test('a failing proof is rolled back with its reason', async () => {
  const { ctx, write, read } = await setup();
  const record = await applyAndVerify(
    ctx,
    change(),
    () => write('src/a.ts', 'export const a = 2;\n'),
    async () => ({ ok: false, reason: 'code tokens changed' }),
  );
  expect(record).toMatchObject({ status: 'rolled-back', detail: 'code tokens changed' });
  expect(await read('src/a.ts')).toBe(ORIGINAL);
});

test.each([
  ['only a flaky test fails', [pkg()], ['t2']],
  ['other packages keep their baseline tests', [pkg('packages/a')], ['packages/a/x.test.ts > t2', 'packages/b/x.test.ts > t3']],
])('a non-zero test exit is accepted when %s', async (_, packages, baselinePassing) => {
  const runTests = stubRun(false, [result('t1', 'failed'), result(baselinePassing[0]!, 'passed')]);
  const { ctx, write } = await setup({ packages, runTests, flaky: new Set(['t1']), baselinePassing: new Set(baselinePassing) });
  const record = await applyAndVerify(ctx, change(), () => write('src/a.ts', 'export const a = 2;\n'));
  expect(record.status).toBe('committed');
});

test.each([
  ['.', ['t1', 't2'], 't2'],
  ['packages/a', ['packages/a/x.test.ts > t2'], 'packages/a/x.test.ts > t2'],
])('in package %s, a baseline test vanishing beside a flaky failure is rolled back', async (dir, baselinePassing, missing) => {
  const runTests = stubRun(false, [result('flaky', 'failed'), result('t1', 'passed')]);
  const { ctx, write, read } = await setup({
    packages: [pkg(dir)],
    runTests,
    flaky: new Set(['flaky']),
    baselinePassing: new Set(baselinePassing),
  });
  const record = await applyAndVerify(ctx, change(), () => write('src/a.ts', 'export const a = 2;\n'));
  expect(record.status).toBe('rolled-back');
  expect(record.detail).toMatch(new RegExp(`^tests failed in .*missing ${missing}`));
  expect(await read('src/a.ts')).toBe(ORIGINAL);
});

test('a duplicate id whose twin fails is rolled back when the id was never flaky', async () => {
  const runTests = stubRun(false, [result('flaky', 'failed'), result('t1', 'passed'), result('t1', 'failed')]);
  const { ctx, write, read } = await setup({ runTests, flaky: new Set(['flaky']), baselinePassing: new Set(['t1']) });
  const record = await applyAndVerify(ctx, change(), () => write('src/a.ts', 'export const a = 2;\n'));
  expect(record).toMatchObject({ status: 'rolled-back', detail: 'tests failed in .: t1' });
  expect(await read('src/a.ts')).toBe(ORIGINAL);
});

test('a baseline test vanishing from a green run is rolled back', async () => {
  const runTests = stubRun(true, [result('t1', 'passed')]);
  const { ctx, write, read } = await setup({ runTests, baselinePassing: new Set(['t1', 't2']) });
  const record = await applyAndVerify(ctx, change(), () => write('src/a.ts', 'export const a = 2;\n'));
  expect(record).toMatchObject({ status: 'rolled-back', detail: 'tests failed in .: missing t2' });
  expect(await read('src/a.ts')).toBe(ORIGINAL);
});

test('a non-zero test exit with no failed test is rolled back', async () => {
  const runTests = stubRun(false, [result('t1', 'passed')]);
  const { ctx, write, read } = await setup({ runTests, baselinePassing: new Set(['t1']) });
  const record = await applyAndVerify(ctx, change(), () => write('src/a.ts', 'export const a = 2;\n'));
  expect(record.status).toBe('rolled-back');
  expect(record.detail).toMatch(/^tests failed in \./);
  expect(await read('src/a.ts')).toBe(ORIGINAL);
});

test.each([
  [['dead-code', 'src/a.ts', 'foo'], 'mn-5436585c52'],
  [['comments', 'src/a.ts'], 'mn-7910594e4b'],
] as const)('changeId(%j) is the sha256 prefix of category|file|symbol', (args, id) => {
  expect(changeId(...args)).toBe(id);
  expect(changeId(...args)).toMatch(/^mn-[0-9a-f]{10}$/);
});
