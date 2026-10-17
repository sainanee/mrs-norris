import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findNodeDeadCode } from '../src/adapters/node/knip.js';
import { runMrsNorris } from '../src/commands/run.js';
import { defaultConfig, saveConfig } from '../src/config.js';
import type { IO } from '../src/io.js';
import { ScriptedAgent } from './helpers/scriptedAgent.js';

const REPO = path.resolve(import.meta.dirname, '..');
const BIN = path.join(REPO, 'node_modules/.bin');

// Keyed by a phrase from each pass's edit prompt; any other edit is a no-op that verify skips.
const EDITS: [marker: string, remove: string][] = [
  ['`unusedHelper`', "\nexport function unusedHelper() {\n  return 'never called';\n}\n"],
  ['Trim comments', '// add two numbers\n'],
];

async function copyFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(REPO, '.tmp/e2e-'));
  await fs.cp(path.join(REPO, 'tests/fixtures/bloated-app'), root, { recursive: true });
  const git = (...args: string[]) => execa('git', args, { cwd: root });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await git('add', '-A');
  await git('commit', '-m', 'initial');
  await saveConfig(
    root,
    defaultConfig([
      {
        name: 'bloated-app',
        dir: '.',
        language: 'typescript',
        runner: 'vitest',
        packageManager: 'npm',
        commands: { test: `${BIN}/vitest run`, typecheck: `${BIN}/tsc --noEmit` },
      },
    ]),
  );
  return root;
}

// Runs knip, tsc and the fixture's vitest once per change, which takes longer than the global 30s.
test('a run on the bloated fixture removes its dead code and redundant comment on a green branch', { timeout: 120_000 }, async () => {
  const root = await copyFixture();
  const git = async (...args: string[]) => (await execa('git', args, { cwd: root })).stdout;
  const head = await git('rev-parse', 'main');
  const io: IO = {
    print: () => {},
    confirm: () => Promise.reject(new Error('unexpected prompt')),
    input: () => Promise.reject(new Error('unexpected prompt')),
  };
  const agent = new ScriptedAgent({
    judge: () => ({ unused: true, confidence: 'high', reason: 'no references' }),
    edit: async (prompt, { allowedPaths: [file] }) => {
      const target = path.join(root, file!);
      const remove = EDITS.find(([marker]) => prompt.includes(marker))?.[1] ?? '';
      await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace(remove, ''));
    },
  });

  const { branch, reportPath, summary } = await runMrsNorris(
    root,
    { paths: [], yes: true },
    { io, agent, findDeadCode: (pkg) => findNodeDeadCode(root, pkg, { monorepo: false }) },
  );

  const log = await git('log', `main..${branch}`, '--format=%s|%(trailers:key=Mrs-Norris-Change-Id,valueonly,separator=)');
  const commits = log.split('\n').map((line) => line.split('|'));
  expect(commits.map(([subject]) => subject)).toEqual([
    'mrs-norris(comments): Trim redundant comments in src/math.ts',
    'mrs-norris(dead-code): Remove unused export `unusedHelper` from src/math.ts',
    'mrs-norris(dead-code): Remove unused dependency `left-pad`',
    'mrs-norris(dead-code): Delete unused file src/orphan.ts',
  ]);
  for (const [, id] of commits) expect(id).toMatch(/^mn-[0-9a-f]{10}$/);
  expect(summary.log.findings).toContainEqual(expect.objectContaining({ kind: 'possibly-unused', symbol: 'loadedByName', note: 'Referenced in: mrs-norris.plugins.json' }));
  const report = await fs.readFile(reportPath, 'utf8');
  expect(report).toContain('| Source lines |');
  expect(report).toContain('−');
  expect(report).toMatch(/- Remove unused dependency `left-pad`: .*\(evidence-only: not test-verified\)\n/);
  expect(await git('branch', '--show-current')).toBe('main');
  expect(await git('rev-parse', 'main')).toBe(head);

  await git('checkout', branch);
  expect((await execa(`${BIN}/vitest`, ['run'], { cwd: root, reject: false })).exitCode).toBe(0);
});
