import path from 'node:path';
import type { Git } from './git.js';
import type { Scope } from './passes/context.js';

/** Files under one of `paths` (every file when empty) and, with `since`, changed since that ref. */
export async function makeScope(git: Git, paths: string[], since?: string): Promise<Scope> {
  const dirs = paths.map((p) => path.posix.normalize(p).replace(/\/$/, ''));
  const changed = since === undefined ? undefined : new Set(await git.diffNames(since));
  const under = (file: string) =>
    dirs.length === 0 || dirs.some((dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`));
  return { includes: (file) => under(file) && (changed?.has(file) ?? true) };
}
