import { defaultConfig } from '../../src/config.js';
import { Git } from '../../src/git.js';
import { collectMetrics } from '../../src/metrics/collect.js';
import type { PackageConfig } from '../../src/types.js';
import { makeTempRepo } from '../helpers/tempRepo.js';

const pkg = (dir: string): PackageConfig => ({
  name: dir,
  dir,
  language: 'typescript',
  runner: 'vitest',
  packageManager: 'npm',
  commands: { test: 'npm test' },
});

const SOURCE = '// helper\nconst a = 1;\nconst b = 2;\nexport { a, b };\n';
const TEST = "import { a } from '../src/a';\ntest('a', () => expect(a).toBe(1));\n";
const README = 'x'.repeat(40);
const testInfo = { testCount: 7, durationMs: 123 };

test('collects line, token, dependency and test metrics, skipping ignored files', async () => {
  const root = await makeTempRepo({
    'src/a.ts': SOURCE,
    'tests/a.test.ts': TEST,
    'README.md': README,
    'dist/x.js': 'const ignored = 1;\n'.repeat(50),
    'package.json': JSON.stringify({ dependencies: { a: '1' }, devDependencies: { b: '1', c: '1' } }),
  });
  const metrics = await collectMetrics(root, new Git(root), defaultConfig([pkg('.')]), testInfo);
  expect(metrics).toEqual({
    sourceLines: 3,
    testLines: 2,
    commentLines: 1,
    testCount: 7,
    testDurationMs: 123,
    contextTokens: Math.ceil(SOURCE.length / 4) + Math.ceil(TEST.length / 4) + 10,
    dependencies: 3,
  });
});

test('sums dependencies across the root and each package, counting a root package once', async () => {
  const root = await makeTempRepo({
    'package.json': JSON.stringify({ devDependencies: { a: '1' } }),
    'packages/web/package.json': JSON.stringify({ dependencies: { b: '1', c: '1' } }),
    'packages/api/package.json': JSON.stringify({ dependencies: { d: '1' } }),
  });
  const config = defaultConfig([pkg('.'), pkg('packages/web'), pkg('packages/api')]);
  const metrics = await collectMetrics(root, new Git(root), config, testInfo);
  expect(metrics.dependencies).toBe(4);
});

test('counts package manifests when the root has none', async () => {
  const root = await makeTempRepo({ 'packages/web/package.json': JSON.stringify({ dependencies: { b: '1' } }) });
  const metrics = await collectMetrics(root, new Git(root), defaultConfig([pkg('packages/web')]), testInfo);
  expect(metrics.dependencies).toBe(1);
});
