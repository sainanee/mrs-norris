import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Git } from '../src/git.js';
import { makeScope } from '../src/scope.js';
import { makeTempRepo } from './helpers/tempRepo.js';

const FILES = { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'tests/a.test.ts': 't\n' };

test.each([[['src']], [['./src/']]])('paths %j keep files under src only', async (paths) => {
  const git = new Git(await makeTempRepo(FILES));
  const scope = await makeScope(git, paths);
  expect(Object.keys(FILES).filter((file) => scope.includes(file))).toEqual(['src/a.ts', 'src/b.ts']);
});

test('since keeps only files changed since the ref', async () => {
  const root = await makeTempRepo(FILES);
  const git = new Git(root);
  const base = await git.head();
  await fs.writeFile(path.join(root, 'src/b.ts'), 'changed\n');
  await execa('git', ['commit', '-am', 'change b'], { cwd: root });
  const scope = await makeScope(git, [], base);
  expect(Object.keys(FILES).filter((file) => scope.includes(file))).toEqual(['src/b.ts']);
});
