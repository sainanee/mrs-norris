import fs from 'node:fs/promises';
import path from 'node:path';
import { changeId } from '../../src/changeId.js';
import { defaultConfig } from '../../src/config.js';
import { Git } from '../../src/git.js';
import { runCommentPass } from '../../src/passes/comments.js';
import type { PassContext } from '../../src/passes/context.js';
import { newRunLog } from '../../src/runlog.js';
import type { PlannedChange, ProofResult, PublicSurface } from '../../src/types.js';
import { ScriptedAgent } from '../helpers/scriptedAgent.js';
import { makeTempRepo } from '../helpers/tempRepo.js';

const MATH = [
  '// eslint-disable-next-line no-console',
  "console.log('loaded');",
  '',
  '/** Adds two numbers. */',
  'export function add(a: number, b: number) {',
  '  // add two numbers',
  '  return a + b;',
  '}',
  '',
].join('\n');

interface Options {
  files?: Record<string, string>;
  untracked?: Record<string, string>;
  surfaces?: [string, PublicSurface][];
  inScope?: (file: string) => boolean;
}

async function run(rewrite: (source: string) => string, opts: Options = {}) {
  const root = await makeTempRepo(opts.files ?? { 'src/math.ts': MATH });
  for (const [file, content] of Object.entries(opts.untracked ?? {})) await fs.writeFile(path.join(root, file), content);
  const agent = new ScriptedAgent({
    edit: async (_, { allowedPaths: [file] }) => {
      const target = path.join(root, file);
      await fs.writeFile(target, rewrite(await fs.readFile(target, 'utf8')));
    },
  });
  const config = defaultConfig([]);
  config.style = ['Prefer British spelling.'];
  const changes: PlannedChange[] = [];
  const proofs: ProofResult[] = [];
  const ctx: PassContext = {
    root,
    config,
    git: new Git(root),
    agent,
    log: newRunLog(),
    scope: { includes: opts.inScope ?? (() => true) },
    surfaces: new Map(opts.surfaces),
    verify: async (change, apply, proof) => {
      changes.push(change);
      await apply();
      proofs.push(await proof!());
      return { id: change.id, category: change.category, title: change.title, reason: change.reason, files: [], status: 'committed' };
    },
    findDeadCode: async () => [],
  };
  await runCommentPass(ctx);
  return { agent, changes, proofs };
}

const dropRestating = (source: string) => source.replace('  // add two numbers\n', '');

test('an edit that only removes a restating comment passes the proof', async () => {
  const { agent, changes, proofs } = await run(dropRestating);
  expect(changes).toEqual([
    {
      id: changeId('comments', 'src/math.ts'),
      category: 'comments',
      title: 'Trim redundant comments in src/math.ts',
      reason: 'Removed comments that restate the code.',
      allowedPaths: ['src/math.ts'],
    },
  ]);
  expect(agent.prompts[0]).toContain('src/math.ts');
  expect(agent.prompts[0]).toContain('Prefer British spelling.');
  expect(proofs).toEqual([{ ok: true }]);
});

const DIRECTIVE = '// eslint-disable-next-line no-console';
const TWICE = `${DIRECTIVE}\nconsole.log(1);\n${DIRECTIVE}\nconsole.log(2);\n`;
const TODO_IN_STRING = "// TODO fix\nconst hint = '// TODO fix';\n";

test.each([
  ['also renames a variable', MATH, (s: string) => dropRestating(s).replaceAll('b', 'c'), 'code changed, not just comments'],
  ['removes a tool directive', MATH, (s: string) => s.replace(`${DIRECTIVE}\n`, ''), `removed a protected comment: ${DIRECTIVE}`],
  ['removes one of two identical directives', TWICE, (s: string) => s.replace(`${DIRECTIVE}\n`, ''), `removed a protected comment: ${DIRECTIVE}`],
  [
    'removes a TODO whose text survives in a string',
    TODO_IN_STRING,
    (s: string) => s.replace('// TODO fix\n', ''),
    'removed a protected comment: // TODO fix',
  ],
])('an edit that %s fails the proof', async (_, source, rewrite, reason) => {
  const { proofs } = await run(rewrite, { files: { 'src/math.ts': source } });
  expect(proofs).toEqual([{ ok: false, reason }]);
});

test('JSDoc is protected only in a library public surface file', async () => {
  const dropDoc = (s: string) => s.replace('/** Adds two numbers. */\n', '');
  const surface = (isLibrary: boolean): [string, PublicSurface][] => [['.', { isLibrary, files: ['src/math.ts'] }]];
  expect((await run(dropDoc, { surfaces: surface(false) })).proofs).toEqual([{ ok: true }]);
  expect((await run(dropDoc, { surfaces: surface(true) })).proofs).toEqual([
    { ok: false, reason: 'removed a protected comment: /** Adds two numbers. */' },
  ]);
});

test('processes tracked, in-scope, non-ignored source files with comments, in sorted order', async () => {
  const commented = '// c\nexport const x = 1;\n';
  const { changes } = await run((s) => s, {
    files: {
      'src/b.ts': commented,
      'src/a.test.ts': commented,
      'src/plain.ts': 'export const y = 2;\n',
      'dist/out.js': commented,
      'docs/example.ts': commented,
      'other/c.ts': commented,
      'notes.txt': '// not code\n',
    },
    untracked: { 'src/new.ts': commented },
    inScope: (file) => !file.startsWith('other/'),
  });
  expect(changes.map((c) => c.allowedPaths[0])).toEqual(['src/a.test.ts', 'src/b.ts']);
});
