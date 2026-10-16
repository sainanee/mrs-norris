import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';

const TMP_ROOT = path.resolve(import.meta.dirname, '../../.tmp');

export async function makeTempRepo(files: Record<string, string>): Promise<string> {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TMP_ROOT, 'repo-'));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await git('add', '-A');
  await git('commit', '-m', 'initial');
  return dir;
}
