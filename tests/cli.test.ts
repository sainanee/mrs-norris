import { execa } from 'execa';

test('prints the package version', async () => {
  const { stdout } = await execa('npx', ['tsx', 'src/cli.ts', '--version']);
  expect(stdout.trim()).toBe('0.1.0');
});

test.each([[['run', '--only', 'cleanup']], [['src', '--only', 'cleanup']]])(
  '%j reports a bad option without a stack trace and exits 1',
  async (args) => {
    const { exitCode, stderr } = await execa('npx', ['tsx', 'src/cli.ts', ...args], { reject: false });
    expect({ exitCode, stderr }).toEqual({
      exitCode: 1,
      stderr: 'Unknown category "cleanup". Valid: dead-code, comments, test-writing, simplify, test-pruning',
    });
  },
);
