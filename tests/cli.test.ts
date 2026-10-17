import { execa } from 'execa';
import path from 'node:path';
import { makeTempRepo } from './helpers/tempRepo.js';

const TSX = path.resolve(import.meta.dirname, '../node_modules/.bin/tsx');
const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');

test('prints the package version', async () => {
  const { stdout } = await execa(TSX, [CLI, '--version']);
  expect(stdout.trim()).toBe('0.1.0');
});

test.each([[['run', '--only', 'cleanup']], [['src', '--only', 'cleanup']]])(
  '%j reports a bad option without a stack trace and exits 1',
  async (args) => {
    const { exitCode, stderr } = await execa(TSX, [CLI, ...args], {
      cwd: await makeTempRepo({ 'a.txt': 'a\n' }),
      env: { ...process.env, ANTHROPIC_API_KEY: '' },
      reject: false,
    });
    expect({ exitCode, stderr }).toEqual({
      exitCode: 1,
      stderr: 'Unknown category "cleanup". Valid: dead-code, comments, test-writing, simplify, test-pruning',
    });
  },
);
