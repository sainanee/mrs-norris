import fs from 'node:fs/promises';
import path from 'node:path';
import { findNodeDeadCode, parseKnipJson } from '../../../src/adapters/node/knip.js';
import type { PackageConfig } from '../../../src/types.js';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');
const TMP_ROOT = path.resolve(import.meta.dirname, '../../../.tmp');

const pkg: PackageConfig = {
  name: 'bloated-app',
  dir: '.',
  language: 'typescript',
  runner: 'vitest',
  packageManager: 'npm',
  commands: { test: 'npm test' },
};

const expected = [
  { kind: 'file', pkgDir: '.', file: 'src/orphan.ts' },
  { kind: 'dependency', pkgDir: '.', file: 'package.json', symbol: 'left-pad' },
  { kind: 'export', pkgDir: '.', file: 'src/math.ts', symbol: 'unusedHelper', line: 4 },
];

async function copyFixture(): Promise<string> {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TMP_ROOT, 'knip-'));
  await fs.cp(path.join(fixtures, 'bloated-app'), dir, { recursive: true });
  return dir;
}

describe('parseKnipJson', () => {
  test('maps files, dependencies and exports from knip output', async () => {
    const raw = await fs.readFile(path.join(fixtures, 'knip/output.json'), 'utf8');
    expect(parseKnipJson(raw, '.')).toEqual(expect.arrayContaining(expected.map((c) => expect.objectContaining(c))));
  });

  test('maps devDependencies and types, and anchors dependencies to the package dir', () => {
    const issue = (over: object) => ({ file: '', files: [], dependencies: [], devDependencies: [], exports: [], types: [], ...over });
    const raw = JSON.stringify({
      issues: [
        issue({ file: 'packages/a/package.json', devDependencies: [{ name: 'eslint', line: 7 }] }),
        issue({ file: 'packages/a/src/t.ts', types: [{ name: 'Opts', line: 3 }] }),
      ],
    });
    expect(parseKnipJson(raw, 'packages/a')).toEqual([
      { kind: 'dependency', pkgDir: 'packages/a', file: 'packages/a/package.json', symbol: 'eslint' },
      { kind: 'export', pkgDir: 'packages/a', file: 'packages/a/src/t.ts', symbol: 'Opts', line: 3 },
    ]);
  });
});

describe('findNodeDeadCode', () => {
  test('finds the bloated-app candidates', async () => {
    const root = await copyFixture();
    const candidates = await findNodeDeadCode(root, pkg, { monorepo: false });
    expect(candidates).toEqual(expect.arrayContaining(expected.map((c) => expect.objectContaining(c))));
  });

  test('throws with knip stderr instead of returning no candidates', async () => {
    const root = await copyFixture();
    await fs.writeFile(path.join(root, 'knip.json'), '{ not json');
    await expect(findNodeDeadCode(root, pkg, { monorepo: false })).rejects.toThrow(/knip failed/);
  });
});
