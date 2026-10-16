import { detectNodePackages, guessNodeCommands } from '../../../src/adapters/node/detect.js';
import { makeTempRepo } from '../../helpers/tempRepo.js';

const json = (value: object) => JSON.stringify(value);

describe('detectNodePackages', () => {
  test('single TypeScript app', async () => {
    const root = await makeTempRepo({
      'package.json': json({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1' } }),
      'tsconfig.json': '{}',
    });
    const packages = await detectNodePackages(root);
    expect(packages).toEqual([
      { name: 'app', dir: '.', language: 'typescript', runner: 'vitest', packageManager: 'npm' },
    ]);
    expect(await guessNodeCommands(root, packages[0]!)).toEqual({
      test: 'npm run test',
      typecheck: 'npx tsc --noEmit',
    });
  });

  test('pnpm monorepo expands workspace globs and picks each package runner', async () => {
    const root = await makeTempRepo({
      'package.json': json({ name: 'mono', private: true }),
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'packages/a/package.json': json({ name: 'a', devDependencies: { jest: '^29' } }),
      'packages/b/package.json': json({ devDependencies: { mocha: '^10' } }),
      'packages/notes/readme.txt': 'not a package',
    });
    const packages = await detectNodePackages(root);
    expect(packages).toEqual([
      { name: 'a', dir: 'packages/a', language: 'javascript', runner: 'jest', packageManager: 'pnpm' },
      { name: 'b', dir: 'packages/b', language: 'javascript', runner: 'mocha', packageManager: 'pnpm' },
    ]);
  });

  test.each([
    ['array', ['libs/*']],
    ['object', { packages: ['libs/*'] }],
  ])('reads package.json workspaces as %s', async (_, workspaces) => {
    const root = await makeTempRepo({
      'package.json': json({ name: 'mono', workspaces }),
      'yarn.lock': '',
      'libs/x/package.json': json({ name: 'x' }),
    });
    expect(await detectNodePackages(root)).toEqual([
      { name: 'x', dir: 'libs/x', language: 'javascript', runner: null, packageManager: 'yarn' },
    ]);
  });

  test('inherits tsconfig and runner from the root', async () => {
    const root = await makeTempRepo({
      'package.json': json({ workspaces: ['packages/*'], devDependencies: { vitest: '^1' } }),
      'tsconfig.json': '{}',
      'packages/a/package.json': json({ name: 'a' }),
    });
    expect(await detectNodePackages(root)).toMatchObject([{ language: 'typescript', runner: 'vitest' }]);
  });
});

describe('guessNodeCommands', () => {
  test('leaves test empty without a test script and uses declared typecheck and lint scripts', async () => {
    const root = await makeTempRepo({
      'package.json': json({ name: 'app', scripts: { typecheck: 'tsc', lint: 'eslint .' } }),
      'pnpm-lock.yaml': '',
    });
    const [pkg] = await detectNodePackages(root);
    expect(await guessNodeCommands(root, pkg!)).toEqual({
      test: '',
      typecheck: 'pnpm run typecheck',
      lint: 'pnpm run lint',
    });
  });
});
