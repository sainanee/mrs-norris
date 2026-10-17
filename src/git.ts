import { execa } from 'execa';
import { CONFIG_DIR } from './config.js';

// An untracked config is never committed or cleaned, so it stays as the user left it across
// checkouts. A tracked one is ordinary content: local edits make the tree dirty.
const CONFIG_PREFIX = `${CONFIG_DIR}/`;

export class Git {
  private closed = false;
  private readonly running = new Set<Promise<unknown>>();
  private pinned?: string;

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

  async currentBranch(): Promise<string | null> {
    return (await this.run(['branch', '--show-current'])) || null;
  }

  head(): Promise<string> {
    return this.run(['rev-parse', 'HEAD']);
  }

  branchExists(name: string): Promise<boolean> {
    return this.succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  }

  /** `name`, or `name-2`, `name-3`, … if it is taken. */
  async unusedBranchName(name: string): Promise<string> {
    let candidate = name;
    for (let n = 2; await this.branchExists(candidate); n++) candidate = `${name}-${n}`;
    return candidate;
  }

  async createBranch(name: string): Promise<void> {
    await this.run(['checkout', '-b', name]);
  }

  /** From now on, stage, commit and rollback throw without touching anything unless `branch` is checked out. */
  pinTo(branch: string): void {
    this.pinned = branch;
  }

  private async assertPinned(): Promise<void> {
    if (this.pinned === undefined) return;
    const current = await this.currentBranch();
    if (current !== this.pinned) {
      throw new Error(`The checkout moved to ${current ?? 'a detached HEAD'} while mrs-norris was running; stopping without touching it.`);
    }
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

  private async status(): Promise<string[]> {
    const out = await this.run(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']);
    return out.split('\0').filter((entry) => entry && !entry.startsWith(`?? ${CONFIG_PREFIX}`));
  }

  async changedFiles(): Promise<string[]> {
    return (await this.status()).map((entry) => entry.slice(3));
  }

  /** Files whose working copy differs from the index, untracked ones included. */
  async unstagedFiles(): Promise<string[]> {
    return (await this.status()).filter((entry) => entry[1] !== ' ').map((entry) => entry.slice(3));
  }

  async stage(): Promise<void> {
    await this.assertPinned();
    await this.run(['add', '-A', '--', '.', `:(exclude)${CONFIG_PREFIX}`]);
  }

  /** Commits what is staged. */
  async commit(message: string): Promise<string> {
    await this.assertPinned();
    // User hooks could rewrite verified content or the message, reject the mrs-norris(...)
    // subject, or wait on a terminal prompt; --no-verify skips only some of them.
    await this.run(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', message]);
    return this.head();
  }

  async rollback(): Promise<void> {
    await this.assertPinned();
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
