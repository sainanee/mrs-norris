import { execa } from 'execa';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const livePids = new Set<number>();

// Detached children no longer die with us, so kill their groups when the process exits.
process.on('exit', () => {
  for (const pid of livePids) killGroup(pid);
});

function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<CommandResult> {
  const start = performance.now();
  // Detached gives the shell its own process group, so the timeout can kill grandchildren
  // that would otherwise keep stdout open after only the shell is killed.
  const child = execa(command, { shell: true, cwd: opts.cwd, env: opts.env, detached: true, reject: false });
  const pid = child.pid!;
  livePids.add(pid);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = killGroup(pid);
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const result = await child.finally(() => {
    clearTimeout(timer);
    livePids.delete(pid);
  });
  return {
    // exitCode is undefined when the process was killed by the timeout
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Math.round(performance.now() - start),
    timedOut,
  };
}
