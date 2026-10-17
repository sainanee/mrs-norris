import { execa } from 'execa';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
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
const TMP = path.resolve(import.meta.dirname, '../../.tmp');

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
  return { root, git, io, printed, run, branches, head: await git('rev-parse', 'HEAD') };
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

test.each([
  { file: 'src/a.ts', edit: 'dirty\n' },
  { file: '.mrs-norris/config.yaml', edit: stringify({ ...defaultConfig([pkg('.')]), model: 'edited' }) },
])('a locally edited tracked $file stops the run and keeps the edit', async ({ file, edit }) => {
  const { root, run } = await setup({ commitConfig: true });
  await fs.writeFile(path.join(root, file), edit);
  await expect(run()).rejects.toThrow(
    'Working tree has uncommitted changes. Commit or stash them, then run mrs-norris again.',
  );
  expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(edit);
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
  expect(await git('log', `main..${branch}`, '--format=%s')).toBe('mrs-norris(comments): Trim redundant comments in src/a.ts');
  expect(await git('show', `${branch}:src/a.ts`)).toBe('export const one = 1;');
  expect(summary.after.commentLines).toBe(summary.before.commentLines - 1);

  expect(reportPath).toBe(path.join(root, '.mrs-norris/reports/20261016-143200.md'));
  const report = await fs.readFile(reportPath, 'utf8');
  expect(printed.slice(-2)).toEqual([report, 'Report written to .mrs-norris/reports/20261016-143200.md']);
  // The untracked configuration stays out of the branch, so merging it doesn't collide.
  await git('merge', branch);
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
  { signal: 'SIGINT', code: 130, after: 'reject' },
  { signal: 'SIGINT', code: 130, after: 'resolve' },
  { signal: 'SIGTERM', code: 143, after: 'hang' },
] as const)('$signal mid-edit, then the edit settles with $after: abort once, leave no commit, exit $code', async ({ signal, code, after }) => {
  const { root, git, run, branches, head } = await setup();
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const trim = trimmer(root);
  const agent = new ScriptedAgent({
    edit: async (prompt, opts) => {
      await trim.edit(prompt, opts);
      process.emit(signal, signal);
      if (after === 'reject') throw new Error('claude interrupted');
      if (after === 'hang') await new Promise(() => {});
    },
  });
  const outcome = run({ only: ['comments'] }, { agent }).then(
    () => 'resolved',
    (error: Error) => error.message,
  );

  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code), { timeout: 10_000 });
  if (after !== 'hang') expect(await outcome).toBe('Aborted');
  expect(exit).toHaveBeenCalledTimes(1);
  expect(await git('branch', '--show-current')).toBe('main');
  expect(await git('rev-parse', 'HEAD')).toBe(head);
  expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toBe(A);
  expect(await branches()).toEqual([]);
  expect(await git('status', '--porcelain')).toBe('?? .mrs-norris/');
});

test('after a signal no further change is attempted, and a second signal exits at once', async () => {
  const { root, git, run, head } = await setup({ files: { 'src/b.ts': 'export const unusedThing = 2;\n' } });
  const exits: string[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    exits.push(`${code} ${execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()}`);
  }) as never);
  const edit = vi.fn(async () => {});
  const agent = new ScriptedAgent({
    judge: () => {
      process.emit('SIGINT', 'SIGINT');
      // A repeated Ctrl-C gives up on the cleanup and exits at once.
      process.emit('SIGINT', 'SIGINT');
      return { unused: true, confidence: 'high', reason: 'never imported' };
    },
    edit,
  });
  const candidate: DeadCodeCandidate = { kind: 'export', pkgDir: '.', file: 'src/b.ts', symbol: 'unusedThing' };
  await expect(run({ only: ['dead-code'] }, { agent, findDeadCode: async () => [candidate] })).rejects.toThrow('Aborted');
  expect(edit).not.toHaveBeenCalled();
  expect(await git('rev-parse', 'HEAD')).toBe(head);
  expect(exits).toEqual([`130 ${BRANCH}`, '130 main']);
});

test('a signal before the branch exists only exits', async () => {
  const check = "import { writeFileSync } from 'node:fs';\nwriteFileSync('.git/check-started', '');\nsetTimeout(() => {}, 600);\n";
  const { root, run } = await setup({ files: { 'check.js': check } });
  const state: string[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: root, encoding: 'utf8' });
    state.push(`${code} ${branches.trim()}`);
  }) as never);
  const running = run({ only: ['dead-code'] });
  await vi.waitFor(() => fs.access(path.join(root, '.git/check-started')));
  process.emit('SIGINT', 'SIGINT');
  await running;
  expect(state).toEqual(['130 main']);
});

test('a signal during a git or other non-detached command still runs the cleanup before exiting', async () => {
  const { git, run, head, branches } = await setup();
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  // execa's signal-exit hook re-raises the signal at the process when it believes it is the last listener.
  const realKill = process.kill.bind(process);
  const kill = vi
    .spyOn(process, 'kill')
    .mockImplementation(((pid: number, signal?: string | number) => pid === process.pid || realKill(pid, signal)) as never);
  const findDeadCode = async () => {
    const child = execa('sleep', ['0.3']);
    process.emit('SIGINT', 'SIGINT');
    await child.catch(() => {});
    return [];
  };
  await expect(run({ only: ['dead-code'] }, { findDeadCode })).rejects.toThrow('Aborted');
  expect(kill.mock.calls.filter(([pid]) => pid === process.pid)).toEqual([]);
  expect(exit.mock.calls).toEqual([[130]]);
  expect(await git('branch', '--show-current')).toBe('main');
  expect(await git('rev-parse', 'HEAD')).toBe(head);
  expect(await git('status', '--porcelain')).toBe('?? .mrs-norris/');
  expect(await branches()).toEqual([]);
});

test.each([
  { where: 'a subdirectory', dir: (root: string) => path.join(root, 'src'), message: async (root: string) => `Run mrs-norris from the repository root: ${await fs.realpath(root)}` },
  { where: 'a directory outside any repository', dir: () => fs.mkdtemp(path.join(TMP, 'plain-')), message: async (_: string, dir: string) => `Not a git repository: ${dir}` },
])('running from $where is refused', async ({ dir, message }) => {
  const { root, io } = await setup();
  const target = await dir(root);
  await expect(runMrsNorris(target, { paths: [] }, { io, agent: trimmer(root) })).rejects.toThrow(
    await message(root, target),
  );
});

test('a test command that changes files at baseline stops the run before branching', async () => {
  const { run, branches } = await setup({
    files: { 'check.js': "import { writeFileSync } from 'node:fs';\nwriteFileSync('stray.txt', '');\n" },
  });
  await expect(run()).rejects.toThrow(
    'Your test command changed files in the repo (stray.txt). mrs-norris needs a test run that leaves the tree clean.',
  );
  expect(await branches()).toEqual([]);
});

test("files the final test run changes reach neither branch", async () => {
  // The third run is the final one: two baseline runs come first and no change is verified.
  const check = [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    "let runs = 0;",
    "try { runs = Number(readFileSync('.git/check-runs', 'utf8')); } catch {}",
    "writeFileSync('.git/check-runs', String(runs + 1));",
    "if (runs === 2) appendFileSync('src/a.ts', 'export const stray = 1;\\n');",
  ].join('\n');
  const { git, run, head } = await setup({ files: { 'check.js': check } });
  const { branch } = await run({ only: ['dead-code'] });
  expect(await git('rev-parse', 'HEAD')).toBe(head);
  expect(await git('status', '--porcelain')).toBe('?? .mrs-norris/');
  expect(await git('show', `${branch}:src/a.ts`)).toBe(A.trimEnd());
});

test('runs started in the same minute get distinct branches', async () => {
  const { run } = await setup();
  expect((await run({ only: ['dead-code'] })).branch).toBe(BRANCH);
  expect((await run({ only: ['dead-code'] })).branch).toBe(`${BRANCH}-2`);
});
