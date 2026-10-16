import { execa } from 'execa';

export class Git {
  constructor(private readonly root: string) {}

  private async run(args: string[]): Promise<string> {
    return (await execa('git', args, { cwd: this.root })).stdout;
  }

  private async succeeds(args: string[]): Promise<boolean> {
    return (await execa('git', args, { cwd: this.root, reject: false })).exitCode === 0;
  }

  async isClean(ignorePrefixes = ['.mrs-norris/']): Promise<boolean> {
    const files = await this.changedFiles();
    return files.every((file) => ignorePrefixes.some((prefix) => file.startsWith(prefix)));
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

  async changedFiles(): Promise<string[]> {
    const out = await this.run(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']);
    return out.split('\0').filter(Boolean).map((entry) => entry.slice(3));
  }

  async commitAll(message: string): Promise<string> {
    await this.run(['add', '-A']);
    // User hooks could rewrite verified content or reject the mrs-norris(...) subject.
    await this.run(['commit', '--no-verify', '-m', message]);
    return this.head();
  }

  async rollback(): Promise<void> {
    await this.run(['reset', '--hard', 'HEAD']);
    await this.run(['clean', '-fd', '-e', '.mrs-norris/']);
  }

  async trackedFiles(): Promise<string[]> {
    return lines(await this.run(['ls-files']));
  }

  async grepWord(term: string): Promise<{ file: string; line: number }[]> {
    const { stdout, exitCode } = await execa('git', ['grep', '-n', '-I', '-F', '-w', '-e', term], {
      cwd: this.root,
      reject: false,
    });
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
