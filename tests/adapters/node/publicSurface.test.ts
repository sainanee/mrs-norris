import { nodePublicSurface } from '../../../src/adapters/node/publicSurface.js';
import { makeTempRepo } from '../../helpers/tempRepo.js';

const json = (value: object) => JSON.stringify(value);

describe('nodePublicSurface', () => {
  test('library surface is the entry file plus its re-export closure', async () => {
    const root = await makeTempRepo({
      'package.json': json({ name: 'lib', exports: { '.': { import: './dist/index.js' } } }),
      'src/index.ts': "export * from './util';\nexport { a } from './nested/a.js';\nexport const x = 1;\n",
      'src/util.ts': "export { deep } from './deep/index';\n",
      'src/deep/index.ts': 'export const deep = 1;\n',
      'src/nested/a.ts': 'export const a = 1;\n',
      'src/internal.ts': 'export const hidden = 1;\n',
    });
    expect(await nodePublicSurface(root, '.')).toEqual({
      isLibrary: true,
      files: ['src/deep/index.ts', 'src/index.ts', 'src/nested/a.ts', 'src/util.ts'],
    });
  });

  test('paths are repo-relative for a nested package', async () => {
    const root = await makeTempRepo({
      'packages/lib/package.json': json({ name: 'lib', main: 'lib/main.js' }),
      'packages/lib/src/main.ts': 'export const a = 1;\n',
    });
    expect(await nodePublicSurface(root, 'packages/lib')).toEqual({
      isLibrary: true,
      files: ['packages/lib/src/main.ts'],
    });
  });

  test('directory re-exports resolve index files of any extension', async () => {
    const root = await makeTempRepo({
      'package.json': json({ name: 'lib', main: 'dist/index.js' }),
      'src/index.ts': "export * from './Button';\n",
      'src/Button/index.tsx': 'export const Button = 1;\n',
    });
    expect((await nodePublicSurface(root, '.')).files).toEqual(['src/Button/index.tsx', 'src/index.ts']);
  });

  test('entries under lib fall back to the path as written when no src counterpart exists', async () => {
    const root = await makeTempRepo({
      'package.json': json({ name: 'lib', main: 'lib/index.js' }),
      'lib/index.js': 'export const a = 1;\n',
    });
    expect((await nodePublicSurface(root, '.')).files).toEqual(['lib/index.js']);
  });

  test('wildcard export targets include every matching source file', async () => {
    const root = await makeTempRepo({
      'package.json': json({ name: 'lib', exports: { './features/*': './dist/features/*.js' } }),
      'src/features/a.ts': 'export const a = 1;\n',
      'src/features/b.ts': 'export const b = 1;\n',
      'src/other.ts': 'export const c = 1;\n',
    });
    expect((await nodePublicSurface(root, '.')).files).toEqual(['src/features/a.ts', 'src/features/b.ts']);
  });

  test('private packages are not libraries', async () => {
    const root = await makeTempRepo({
      'package.json': json({ name: 'app', private: true, main: 'dist/index.js' }),
      'src/index.ts': 'export const a = 1;\n',
    });
    expect(await nodePublicSurface(root, '.')).toEqual({ isLibrary: false, files: [] });
  });
});
