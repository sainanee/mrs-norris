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
  const result = await execa(command, {
    shell: true,
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    reject: false,
  });
  return {
    // exitCode is undefined when the process was killed by the timeout
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Math.round(performance.now() - start),
    timedOut: result.timedOut,
  };
}
