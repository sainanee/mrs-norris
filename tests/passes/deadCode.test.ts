import fs from 'node:fs/promises';
import path from 'node:path';
import { changeId } from '../../src/changeId.js';
import { defaultConfig } from '../../src/config.js';
import { Git } from '../../src/git.js';
import type { PassContext } from '../../src/passes/context.js';
import { runDeadCodePass } from '../../src/passes/deadCode.js';
import { newRunLog } from '../../src/runlog.js';
import type { DeadCodeCandidate, PackageConfig, PlannedChange, PublicSurface } from '../../src/types.js';
import { ScriptedAgent } from '../helpers/scriptedAgent.js';
import { makeTempRepo } from '../helpers/tempRepo.js';

const MATH = 'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function unusedHelper() {\n  return 1;\n}\n';

const FILES = {
  'package.json': '{\n  "name": "app",\n  "private": true\n}\n',
  'src/math.ts': MATH,
  'src/index.ts': "import { add } from './math';\nconsole.log(add(1, 2));\n",
  'src/orphan.ts': 'export const orphan = 1;\n',
};

const HIGH = { unused: true, confidence: 'high', reason: 'Nothing loads it' };

const pkg = (dir = '.'): PackageConfig => ({
  name: dir,
  dir,
  language: 'typescript',
  runner: 'vitest',
  packageManager: 'npm',
  commands: { test: 'true' },
});

const unusedHelper: DeadCodeCandidate = { kind: 'export', pkgDir: '.', file: 'src/math.ts', symbol: 'unusedHelper' };

interface Options {
  files?: Record<string, string>;
  judge?: (prompt: string) => unknown;
  edit?: (prompt: string, opts: { allowedPaths: string[] }) => Promise<void>;
  packages?: PackageConfig[];
  surfaces?: [string, PublicSurface][];
  ignore?: string[];
  inScope?: (file: string) => boolean;
}

async function run(candidates: DeadCodeCandidate[], opts: Options = {}) {
  const root = await makeTempRepo({ ...FILES, ...opts.files });
  const agent = new ScriptedAgent({ judge: opts.judge ?? (() => HIGH), edit: opts.edit });
  const changes: PlannedChange[] = [];
  const config = defaultConfig(opts.packages ?? [pkg()]);
  if (opts.ignore) config.ignore = opts.ignore;
  const ctx: PassContext = {
    root,
    config,
    git: new Git(root),
    agent,
    log: newRunLog(),
    scope: { includes: opts.inScope ?? (() => true) },
    surfaces: new Map(opts.surfaces),
    verify: async (change, apply) => {
      changes.push(change);
      await apply();
      return { id: change.id, category: change.category, title: change.title, reason: change.reason, files: [], status: 'committed' };
    },
    findDeadCode: async (p) => candidates.filter((c) => c.pkgDir === p.dir),
  };
  await runDeadCodePass(ctx);
  const read = (file: string) => fs.readFile(path.join(root, file), 'utf8');
  const exists = (file: string) => fs.access(path.join(root, file)).then(() => true, () => false);
  return { agent, changes, findings: ctx.log.findings, read, exists };
}

test('an unreferenced export judged unused with high confidence is removed by an agent edit', async () => {
  const edit = vi.fn(async () => {});
  const { agent, changes, findings } = await run([unusedHelper], { edit });
  expect(changes).toEqual([
    {
      id: changeId('dead-code', 'src/math.ts', 'unusedHelper'),
      category: 'dead-code',
      title: 'Remove unused export `unusedHelper` from src/math.ts',
      reason: 'Nothing loads it',
      allowedPaths: ['src/math.ts'],
    },
  ]);
  expect(agent.prompts[0]).toContain(MATH);
  expect(edit).toHaveBeenCalledWith(expect.stringContaining('unusedHelper'), { allowedPaths: ['src/math.ts'] });
  expect(findings).toEqual([]);
});

test('for an export, the judge must report side effects and the edit keeps them by dropping only `export`', async () => {
  const { agent } = await run([unusedHelper], { edit: async () => {} });
  const [judge, edit] = agent.prompts;
  expect(judge).toContain(
    'Check whether the declaration of `unusedHelper` has side effects: calls, `new`, decorators, assignments to outer state, or top-level statements tied to it. If it has any, name them in the reason.',
  );
  expect(edit).toContain(
    'If the declaration has side effects (calls, `new`, decorators, assignments to outer state, or top-level statements tied to it), remove only its `export` keyword so they still run.',
  );
});

test('an unreferenced file judged unused is deleted', async () => {
  const { changes, exists } = await run([{ kind: 'file', pkgDir: '.', file: 'src/orphan.ts' }]);
  expect(changes).toMatchObject([{ title: 'Delete unused file src/orphan.ts', allowedPaths: ['src/orphan.ts'] }]);
  expect(await exists('src/orphan.ts')).toBe(false);
});

test.each([
  ['a string lookup', unusedHelper, 'src/load.ts', "const f = m['unusedHelper'];\n"],
  ['a short symbol', { ...unusedHelper, symbol: 'get' }, 'src/api.ts', 'client.get(1);\n'],
  ['a $-prefixed symbol', { ...unusedHelper, symbol: '$state' }, 'src/view.svelte', 'let count = $state(0);\n'],
  ['a file basename', { kind: 'file', pkgDir: '.', file: 'src/orphan.ts' }, 'src/load.ts', "await import('./orphan');\n"],
  ['a declaration file basename', { kind: 'file', pkgDir: '.', file: 'src/globals.d.ts' }, 'src/load.ts', "import type { G } from './globals';\n"],
] as const)('%s referenced elsewhere becomes a finding without asking Claude', async (_, candidate, file, content) => {
  const { agent, changes, findings } = await run([candidate], { files: { [file]: content }, ignore: [] });
  expect(findings).toEqual([
    { kind: 'possibly-unused', file: candidate.file, symbol: candidate.symbol, note: `Referenced in: ${file}` },
  ]);
  expect(agent.prompts).toEqual([]);
  expect(changes).toEqual([]);
});

test.each([
  [{ unused: true, confidence: 'medium', reason: 'Maybe loaded by name' }, 'Claude: Maybe loaded by name'],
  [{ unused: false, confidence: 'high', reason: 'Used by the router' }, 'Claude: Used by the router'],
])('verdict %j becomes a finding and is not applied', async (verdict, note) => {
  const { changes, findings } = await run([unusedHelper], { judge: () => verdict });
  expect(findings).toEqual([{ kind: 'possibly-unused', file: 'src/math.ts', symbol: 'unusedHelper', note }]);
  expect(changes).toEqual([]);
});

test('a judge error becomes a finding and the pass moves on to the next candidate', async () => {
  let calls = 0;
  const judge = () => {
    if (++calls === 1) throw new Error('network down');
    return HIGH;
  };
  const { changes, findings } = await run([unusedHelper, { kind: 'file', pkgDir: '.', file: 'src/orphan.ts' }], { judge });
  expect(findings).toEqual([
    { kind: 'possibly-unused', file: 'src/math.ts', symbol: 'unusedHelper', note: 'Claude: error: network down' },
  ]);
  expect(changes).toMatchObject([{ title: 'Delete unused file src/orphan.ts' }]);
});

const libHelper: DeadCodeCandidate = { kind: 'export', pkgDir: 'packages/lib', file: 'packages/lib/src/index.ts', symbol: 'helper' };
const libFiles = { 'packages/lib/src/index.ts': 'export const helper = 1;\n' };

test('an export in the public surface of the package with the longest matching dir is left alone', async () => {
  const { agent, findings } = await run([libHelper], {
    files: libFiles,
    packages: [pkg(), pkg('packages/lib')],
    surfaces: [
      ['.', { isLibrary: false, files: [] }],
      ['packages/lib', { isLibrary: true, files: ['packages/lib/src/index.ts'] }],
    ],
  });
  expect(findings).toEqual([
    {
      kind: 'public-export',
      file: 'packages/lib/src/index.ts',
      symbol: 'helper',
      note: 'Unused public export left alone (set allowPublicApiChanges to allow)',
    },
  ]);
  expect(agent.prompts).toEqual([]);
});

test('a nested non-library package owns its files over an enclosing library', async () => {
  const { changes, findings } = await run([libHelper], {
    files: libFiles,
    packages: [pkg('packages/lib')],
    surfaces: [
      ['packages', { isLibrary: true, files: ['packages/lib/src/index.ts'] }],
      ['packages/lib', { isLibrary: false, files: [] }],
    ],
    edit: async () => {},
  });
  expect(findings).toEqual([]);
  expect(changes).toMatchObject([{ title: 'Remove unused export `helper` from packages/lib/src/index.ts' }]);
});

test.each([
  ['out of scope', { kind: 'file', pkgDir: '.', file: 'src/orphan.ts' }, { inScope: (file: string) => file !== 'src/orphan.ts' }],
  ['ignored', { kind: 'file', pkgDir: '.', file: 'src/orphan.ts' }, { ignore: ['src/orphan.ts'] }],
  ['a protected doc', { kind: 'file', pkgDir: '.', file: 'docs/old.md' }, { files: { 'docs/old.md': '# Old\n' } }],
  ['a test file', { kind: 'file', pkgDir: '.', file: 'tests/old.test.ts' }, { files: { 'tests/old.test.ts': "test('x', () => {});\n" } }],
] as const)('a candidate that is %s is skipped silently', async (_, candidate, opts) => {
  const { agent, changes, findings, exists } = await run([candidate], opts);
  expect([agent.prompts, changes, findings]).toEqual([[], [], []]);
  expect(await exists(candidate.file)).toBe(true);
});

test('an unused dependency listed in other manifests is removed from every section, with no lockfile command when there is no lockfile', async () => {
  const manifest = {
    name: 'app',
    dependencies: { 'left-pad': '^1.3.0', zod: '^4.0.0' },
    devDependencies: { 'left-pad': '^1.3.0' },
  };
  const { changes, read, exists } = await run([{ kind: 'dependency', pkgDir: '.', file: 'package.json', symbol: 'left-pad' }], {
    files: {
      'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'tools/package.json': '{\n  "dependencies": {\n    "left-pad": "^1.3.0"\n  }\n}\n',
    },
  });
  expect(changes).toMatchObject([{ title: 'Remove unused dependency `left-pad`', allowedPaths: ['package.json'], evidenceOnly: true }]);
  expect(await read('package.json')).toBe(
    '{\n  "name": "app",\n  "dependencies": {\n    "zod": "^4.0.0"\n  },\n  "devDependencies": {}\n}\n',
  );
  expect(await exists('package-lock.json')).toBe(false);
});

test('a workspace dependency updates the root lockfile from the package dir', async () => {
  const lockfile = {
    name: 'root',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'root', workspaces: ['packages/*'] }, 'node_modules/left-pad': { version: '1.3.0' } },
  };
  const { changes, read } = await run(
    [{ kind: 'dependency', pkgDir: 'packages/a', file: 'packages/a/package.json', symbol: 'left-pad' }],
    {
      files: {
        'package.json': '{\n  "name": "root",\n  "private": true,\n  "workspaces": ["packages/*"]\n}\n',
        'package-lock.json': JSON.stringify(lockfile, null, 2),
        'packages/a/package.json': '{\n  "name": "a",\n  "version": "1.0.0",\n  "dependencies": {\n    "left-pad": "^1.3.0"\n  }\n}\n',
      },
      packages: [pkg('packages/a')],
    },
  );
  expect(changes).toMatchObject([{ allowedPaths: ['packages/a/package.json', 'package-lock.json'] }]);
  expect(await read('packages/a/package.json')).not.toContain('left-pad');
  expect(await read('package-lock.json')).not.toContain('left-pad');
});
