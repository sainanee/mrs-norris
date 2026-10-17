import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseOnly, runMrsNorris, type RunDeps, type RunOptions } from '../../src/commands/run.js';
import { defaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import type { IO } from '../../src/io.js';
import type { DeadCodeCandidate, PackageConfig } from '../../src/types.js';
import { ScriptedAgent } from '../helpers/scriptedAgent.js';
import { makeTempRepo } from '../helpers/tempRepo.js';

const A = '// returns one\nexport const one = 1;\n';
const CHECK = "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('src/a.ts', 'utf8').includes('export const one = 1;') ? 0 : 1);\n";
const NOW = new Date(2026, 9, 16, 14, 32);
const BRANCH = 'mrs-norris/2026-10-16-1432';

const pkg = (dir: string): PackageConfig => ({
  name: dir,
  dir,
  language: 'typescript',
  runner: null,
  packageManager: 'npm',
  commands: { test: 'node check.js' },
});

const signalListeners = () => process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
const listenersAtStart = signalListeners();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(signalListeners()).toBe(listenersAtStart);
});

interface Setup {
  files?: Record<string, string>;
  packages?: PackageConfig[];
  commitConfig?: boolean;
}

async function setup({ files = {}, packages = [pkg('.')], commitConfig = false }: Setup = {}) {
  const root = await makeTempRepo({ 'src/a.ts': A, 'check.js': CHECK, ...files });
  const git = async (...args: string[]) => (await execa('git', args, { cwd: root })).stdout;
  await saveConfig(root, defaultConfig(packages));
  if (commitConfig) {
    await git('add', '-A');
    await git('commit', '-m', 'config');
  }
  const printed: string[] = [];
  const io: IO = {
    print: (msg) => printed.push(msg),
    confirm: () => Promise.reject(new Error('unexpected prompt')),
    input: () => Promise.reject(new Error('unexpected prompt')),
  };
  const run = (opts: Partial<RunOptions> = {}, deps: Partial<RunDeps> = {}) =>
    runMrsNorris(root, { paths: [], ...opts }, { io, agent: trimmer(root), now: () => NOW, findDeadCode: async () => [], ...deps });
  const branches = async () => (await git('branch', '--list', 'mrs-norris/*', '--format=%(refname:short)')).split('\n').filter(Boolean);
  return { root, git, printed, run, branches, head: await git('rev-parse', 'HEAD') };
}

const trimmer = (root: string) =>
  new ScriptedAgent({
    edit: async (_, { allowedPaths: [file] }) => {
      const target = path.join(root, file!);
      await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('// returns one\n', ''));
    },
  });

test('parseOnly accepts known categories and lists the valid ones otherwise', () => {
  expect(parseOnly('dead-code,comments')).toEqual(['dead-code', 'comments']);
  expect(() => parseOnly('cleanup')).toThrow(
    'Unknown category "cleanup". Valid: dead-code, comments, test-writing, simplify, test-pruning',
  );
});

test('a dirty tracked file stops the run', async () => {
  const { root, run } = await setup();
  await fs.writeFile(path.join(root, 'src/a.ts'), 'dirty\n');
  await expect(run()).rejects.toThrow(
    'Working tree has uncommitted changes. Commit or stash them, then run mrs-norris again.',
  );
});

test('a failing baseline prints its problems and creates no branch', async () => {
  const { run, printed, branches } = await setup({ files: { 'check.js': 'process.exit(1);\n' } });
  await expect(run()).rejects.toThrow(
    'Baseline is not green. mrs-norris needs passing tests to prove it preserved behavior.',
  );
  expect(printed).toContain('Tests fail at baseline: node check.js');
  expect(await branches()).toEqual([]);
});

test('without an injected agent the API key is checked before any test command runs', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  const { root, run } = await setup({
    files: { 'check.js': "import { writeFileSync } from 'node:fs';\nwriteFileSync('marker', '');\n" },
  });
  await expect(run({}, { agent: undefined })).rejects.toThrow('ANTHROPIC_API_KEY is not set');
  await expect(fs.access(path.join(root, 'marker'))).rejects.toThrow();
});

test('a run commits on its own branch, writes the report and leaves the user where they were', async () => {
  const { root, git, run, printed, head } = await setup();
  const { branch, reportPath, summary } = await run(
    { only: ['comments'] },
    { findDeadCode: () => Promise.reject(new Error('dead-code pass should not run')) },
  );

  expect(branch).toBe(BRANCH);
  expect(await git('branch', '--show-current')).toBe('main');
  expect(await git('rev-parse', 'HEAD')).toBe(head);
  expect((await git('log', `main..${branch}`, '--format=%s')).split('\n')).toEqual([
    'mrs-norris(comments): Trim redundant comments in src/a.ts',
    'mrs-norris: add configuration',
  ]);
  expect(await git('show', `${branch}:src/a.ts`)).toBe('export const one = 1;');
  expect(summary.after.commentLines).toBe(summary.before.commentLines - 1);

  expect(reportPath).toBe(path.join(root, '.mrs-norris/reports/20261016-143200.md'));
  const report = await fs.readFile(reportPath, 'utf8');
  expect(printed.slice(-2)).toEqual([report, 'Report written to .mrs-norris/reports/20261016-143200.md']);
  // The configuration is back as it was before the run: untracked, with reports ignored.
  expect(await loadConfig(root)).toEqual(defaultConfig([pkg('.')]));
  expect(await git('status', '--porcelain')).toBe('?? .mrs-norris/');
});

test('an edit that throws mid-pass is rolled back and the run completes', async () => {
  const { root, git, run } = await setup();
  const agent = new ScriptedAgent({
    edit: async () => {
      await fs.writeFile(path.join(root, 'src/a.ts'), 'BROKEN\n');
      throw new Error('agent crashed');
    },
  });
  const { branch, summary } = await run({ only: ['comments'] }, { agent });
  expect(summary.log.changes).toMatchObject([{ status: 'rolled-back', detail: 'error: agent crashed' }]);
  expect(await git('show', `${branch}:src/a.ts`)).toBe(A.trimEnd());
  expect(summary.finalCheckOk).toBe(true);
});

test.each([
  { committed: 0, message: `Deleted branch ${BRANCH}: no changes were committed.`, kept: [] },
  { committed: 1, message: `Kept branch ${BRANCH} with the changes committed so far.`, kept: [BRANCH] },
])('a fatal pass error with $committed commits returns the user to a clean original branch', async ({ committed, message, kept }) => {
  const { git, run, printed, branches, head } = await setup({
    files: { 'src/orphan.ts': 'export const x = 2;\n', 'lib/check.js': 'process.exit(0);\n' },
    packages: [pkg('.'), pkg('lib')],
    commitConfig: true,
  });
  const orphan: DeadCodeCandidate = { kind: 'file', pkgDir: '.', file: 'src/orphan.ts' };
  const findDeadCode = async ({ dir }: PackageConfig) => {
    if (dir === 'lib') throw new Error('knip failed');
    return committed ? [orphan] : [];
  };
  const agent = new ScriptedAgent({ judge: () => ({ unused: true, confidence: 'high', reason: 'never imported' }) });

  await expect(run({}, { agent, findDeadCode })).rejects.toThrow('knip failed');
  expect(await git('branch', '--show-current')).toBe('main');
  expect(await git('rev-parse', 'HEAD')).toBe(head);
  expect(await git('status', '--porcelain')).toBe('');
  expect(await branches()).toEqual(kept);
  expect(printed).toContain(message);
});

test.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)('%s rolls back, returns to the original branch, then exits with %i', async (signal, code) => {
  const { root, git, run, branches } = await setup();
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const agent = new ScriptedAgent({
    edit: async () => {
      await fs.writeFile(path.join(root, 'src/a.ts'), 'BROKEN\n');
      process.emit(signal, signal);
      await new Promise(() => {});
    },
  });
  void run({ only: ['comments'] }, { agent });

  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code), { timeout: 10_000 });
  expect(await git('branch', '--show-current')).toBe('main');
  expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toBe(A);
  expect(await branches()).toEqual([]);
  expect(await git('status', '--porcelain')).toBe('?? .mrs-norris/');
});

test('runs started in the same minute get distinct branches', async () => {
  const { run } = await setup();
  expect((await run({ only: ['dead-code'] })).branch).toBe(BRANCH);
  expect((await run({ only: ['dead-code'] })).branch).toBe(`${BRANCH}-2`);
});
