import { createRequire } from 'node:module';
import path from 'node:path';
import { runCommand } from '../../exec.js';
import type { DeadCodeCandidate, PackageConfig } from '../../types.js';

interface KnipItem { name: string; line?: number }
interface KnipIssue {
  file: string;
  files: KnipItem[];
  dependencies: KnipItem[];
  devDependencies: KnipItem[];
  exports: KnipItem[];
  types: KnipItem[];
}

const STDERR_TAIL_CHARS = 2000;

const toPosix = (file: string) => file.split(path.sep).join('/');

export function parseKnipJson(raw: string, pkgDir: string): DeadCodeCandidate[] {
  const { issues } = JSON.parse(raw) as { issues: KnipIssue[] };
  const candidates: DeadCodeCandidate[] = [];
  for (const issue of issues) {
    const file = toPosix(issue.file);
    for (const { name } of issue.files) {
      candidates.push({ kind: 'file', pkgDir, file: toPosix(name) });
    }
    for (const { name } of [...issue.dependencies, ...issue.devDependencies]) {
      candidates.push({ kind: 'dependency', pkgDir, file, symbol: name });
    }
    for (const { name, line } of [...issue.exports, ...issue.types]) {
      candidates.push({ kind: 'export', pkgDir, file, symbol: name, line });
    }
  }
  return candidates;
}

export async function findNodeDeadCode(
  root: string,
  pkg: PackageConfig,
  opts: { monorepo: boolean },
): Promise<DeadCodeCandidate[]> {
  // knip's "exports" map hides package.json, so locate the bin relative to its main entry (dist/index.js).
  const bin = path.resolve(path.dirname(createRequire(import.meta.url).resolve('knip')), '../bin/knip.js');
  const workspace = opts.monorepo ? ` --workspace ${JSON.stringify(pkg.dir)}` : '';
  const result = await runCommand(`node ${JSON.stringify(bin)} --reporter json --no-exit-code${workspace}`, {
    cwd: root,
  });
  try {
    return parseKnipJson(result.stdout, pkg.dir);
  } catch {
    throw new Error(`knip failed (exit ${result.exitCode}): ${result.stderr.slice(-STDERR_TAIL_CHARS)}`);
  }
}
