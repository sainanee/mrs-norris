import { execa } from 'execa';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<CommandResult> {
  const start = performance.now();
  // Detached gives the shell its own process group, so the timeout can kill grandchildren
  // that would otherwise keep stdout open after only the shell is killed.
  const child = execa(command, { shell: true, cwd: opts.cwd, env: opts.env, detached: true, reject: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill(-child.pid!, 'SIGKILL');
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const result = await child.finally(() => clearTimeout(timer));
  return {
    // exitCode is undefined when the process was killed by the timeout
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Math.round(performance.now() - start),
    timedOut,
  };
}
