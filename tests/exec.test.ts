import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../src/exec.js';

describe('runCommand', () => {
  test('captures output and exit code without throwing on failure', async () => {
    const result = await runCommand('echo out; echo err >&2; exit 3', { cwd: process.cwd() });
    expect(result).toMatchObject({ exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('passes env vars through the shell', async () => {
    const result = await runCommand('echo $GREETING', { cwd: process.cwd(), env: { GREETING: 'hi' } });
    expect(result.stdout).toBe('hi');
  });

  test('a timeout kills the whole command, including child processes', async () => {
    const result = await runCommand('sleep 5; echo x', { cwd: process.cwd(), timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(2000);
    expect(result.exitCode).not.toBe(0);
  });
});

test('runCommand kills running children when the parent process exits', async () => {
  const tmpRoot = path.resolve(import.meta.dirname, '../.tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmpRoot, 'exit-'));
  const pidFile = path.join(dir, 'pid');
  const script = path.join(dir, 'run.mts');
  const execModule = path.resolve(import.meta.dirname, '../src/exec.ts');
  await fs.writeFile(
    script,
    `import { runCommand } from ${JSON.stringify(execModule)};
void runCommand('sleep 30 & echo $! > pid; wait', { cwd: ${JSON.stringify(dir)} });
setTimeout(() => process.exit(0), 500);
`,
  );
  await execa('node', ['--import', 'tsx', script], { cwd: dir });
  const sleepPid = Number(await fs.readFile(pidFile, 'utf8'));
  await vi.waitFor(() => expect(() => process.kill(sleepPid, 0)).toThrow(/ESRCH/));
});
