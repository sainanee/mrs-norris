import { execa } from 'execa';
import { CONFIG_DIR } from './config.js';

// An untracked config is never committed or cleaned, so it stays as the user left it across
// checkouts. A tracked one is ordinary content: local edits make the tree dirty.
const CONFIG_PREFIX = `${CONFIG_DIR}/`;

export class Git {
  private closed = false;
  private readonly running = new Set<Promise<unknown>>();

  constructor(private readonly root: string) {}

  private exec(args: string[], reject = true) {
    if (this.closed) return Promise.reject(new Error('Aborted'));
    const call = execa('git', args, { cwd: this.root, reject });
    const done = () => this.running.delete(call);
    this.running.add(call);
    void call.then(done, done);
    return call;
  }

  private async run(args: string[]): Promise<string> {
    return (await this.exec(args)).stdout;
  }

  private async succeeds(args: string[]): Promise<boolean> {
    return (await this.exec(args, false)).exitCode === 0;
  }

  /** Rejects every later command and resolves once the commands already running have finished. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.running);
  }

  async toplevel(): Promise<string | null> {
    const { stdout, exitCode } = await this.exec(['rev-parse', '--show-toplevel'], false);
    return exitCode === 0 ? stdout : null;
  }

  async isClean(): Promise<boolean> {
    return (await this.changedFiles()).length === 0;
  }

  async currentBranch(): Promise<string | null> {
    return (await this.run(['branch', '--show-current'])) || null;
  }

  head(): Promise<string> {
    return this.run(['rev-parse', 'HEAD']);
  }

  async createBranch(name: string): Promise<string> {
    let candidate = name;
    for (let n = 2; await this.succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]); n++) {
      candidate = `${name}-${n}`;
    }
    await this.run(['checkout', '-b', candidate]);
    return candidate;
  }

  async checkout(ref: string): Promise<void> {
    await this.run(['checkout', ref]);
  }

  async deleteBranch(name: string): Promise<void> {
    await this.run(['branch', '-D', name]);
  }

  async subjects(range: string): Promise<string[]> {
    return lines(await this.run(['log', '--format=%s', range]));
  }

  async changedFiles(): Promise<string[]> {
    const out = await this.run(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']);
    return out
      .split('\0')
      .filter((entry) => entry && !entry.startsWith(`?? ${CONFIG_PREFIX}`))
      .map((entry) => entry.slice(3));
  }

  async commitAll(message: string): Promise<string> {
    await this.run(['add', '-A', '--', '.', `:(exclude)${CONFIG_PREFIX}`]);
    // User hooks could rewrite verified content or the message, reject the mrs-norris(...)
    // subject, or wait on a terminal prompt; --no-verify skips only some of them.
    await this.run(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', message]);
    return this.head();
  }

  async rollback(): Promise<void> {
    await this.run(['reset', '--hard', 'HEAD']);
    await this.run(['clean', '-fd', '-e', `/${CONFIG_PREFIX}`]);
  }

  async trackedFiles(): Promise<string[]> {
    return lines(await this.run(['ls-files']));
  }

  async grepWord(term: string): Promise<{ file: string; line: number }[]> {
    const { stdout, exitCode } = await this.exec(['grep', '-n', '-I', '-F', '-w', '-e', term], false);
    if (exitCode !== 0 && exitCode !== 1) throw new Error(`git grep failed with exit code ${exitCode}`);
    return lines(stdout).map((hit) => {
      const [, file, line] = /^(.+?):(\d+):/.exec(hit)!;
      return { file, line: Number(line) };
    });
  }

  async diffNames(since: string): Promise<string[]> {
    return lines(await this.run(['diff', '--name-only', `${since}...HEAD`]));
  }
}

function lines(text: string): string[] {
  return text.split('\n').filter(Boolean);
}
