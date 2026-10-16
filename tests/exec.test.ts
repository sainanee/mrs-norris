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

  test('reports a timeout', async () => {
    const result = await runCommand('sleep 5', { cwd: process.cwd(), timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
