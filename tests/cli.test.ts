import { execa } from 'execa';

test('prints the package version', async () => {
  const { stdout } = await execa('npx', ['tsx', 'src/cli.ts', '--version']);
  expect(stdout.trim()).toBe('0.1.0');
});
