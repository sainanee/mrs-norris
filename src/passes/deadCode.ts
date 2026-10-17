import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { LOCKFILES, lockfileUpdateCommand, removeDependency } from '../adapters/node/dependencies.js';
import { exists } from '../adapters/node/detect.js';
import { changeId } from '../changeId.js';
import { runCommand } from '../exec.js';
import type { Git } from '../git.js';
import { isTestFile } from '../metrics/classify.js';
import type { DeadCodeCandidate, Finding, PackageConfig } from '../types.js';
import { isEditable, isPublicFile, type PassContext } from './context.js';

export const VerdictSchema = z.object({
  unused: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
});

// Removing such a declaration would also remove behavior, e.g. `export const db = connect()`.
const SIDE_EFFECTS = 'calls, `new`, decorators, assignments to outer state, or top-level statements tied to it';

const LOCKFILE_NAMES = new Set(Object.values(LOCKFILES));

/** Tracked files that mention the candidate as a whole word, apart from its own file, lockfiles and (for dependencies) manifests. */
export async function referencesOutside(git: Git, c: DeadCodeCandidate): Promise<string[]> {
  // A declaration file foo.d.ts is imported as ./foo.
  const term = c.kind === 'file' ? path.posix.parse(c.file).name.replace(/\.d$/, '') : c.symbol!;
  const excluded = (file: string) => {
    const base = path.posix.basename(file);
    return file === c.file || LOCKFILE_NAMES.has(base) || (c.kind === 'dependency' && base === 'package.json');
  };
  const files = (await git.grepWord(term)).map((hit) => hit.file).filter((file) => !excluded(file));
  return [...new Set(files)];
}

export async function runDeadCodePass(ctx: PassContext): Promise<void> {
  for (const pkg of ctx.config.packages) {
    for (const candidate of await ctx.findDeadCode(pkg)) await handle(ctx, pkg, candidate);
  }
}

async function handle(ctx: PassContext, pkg: PackageConfig, c: DeadCodeCandidate): Promise<void> {
  if (!isEditable(ctx, c.file)) return;
  // Test files are pruned by a later pass under a stricter proof.
  if (c.kind === 'file' && isTestFile(c.file)) return;
  const finding = (kind: Finding['kind'], note: string) => {
    ctx.log.findings.push({ kind, category: 'dead-code', file: c.file, symbol: c.symbol, note });
  };

  if (!ctx.config.allowPublicApiChanges && isPublicFile(ctx, c.file)) {
    return finding('public-export', 'Unused public export left alone (set allowPublicApiChanges to allow)');
  }
  const references = await referencesOutside(ctx.git, c);
  if (references.length > 0) return finding('possibly-unused', `Referenced in: ${references.join(', ')}`);
  const contents = await fs.readFile(path.join(ctx.root, c.file), 'utf8');
  let verdict: z.infer<typeof VerdictSchema>;
  try {
    verdict = await ctx.agent.judge(judgePrompt(c, contents), VerdictSchema);
  } catch (error) {
    return finding('possibly-unused', `Claude: error: ${(error as Error).message}`);
  }
  if (!verdict.unused || verdict.confidence !== 'high') return finding('possibly-unused', `Claude: ${verdict.reason}`);

  const { title, allowedPaths, apply } = await removal(ctx, pkg, c);
  await ctx.verify(
    { id: changeId('dead-code', c.file, c.symbol), category: 'dead-code', title, reason: verdict.reason, allowedPaths },
    apply,
  );
}

async function removal(ctx: PassContext, pkg: PackageConfig, c: DeadCodeCandidate) {
  switch (c.kind) {
    case 'export':
      return {
        title: `Remove unused export \`${c.symbol}\` from ${c.file}`,
        allowedPaths: [c.file],
        apply: () => ctx.agent.edit(editPrompt(c), { allowedPaths: [c.file] }),
      };
    case 'file':
      return {
        title: `Delete unused file ${c.file}`,
        allowedPaths: [c.file],
        apply: () => fs.rm(path.join(ctx.root, c.file)),
      };
    case 'dependency': {
      const lockfile = await findLockfile(ctx.root, pkg);
      return {
        title: `Remove unused dependency \`${c.symbol}\``,
        allowedPaths: lockfile ? [c.file, lockfile] : [c.file],
        apply: async () => {
          await removeDependency(path.join(ctx.root, c.file), c.symbol!);
          if (lockfile) await updateLockfile(ctx.root, pkg);
        },
      };
    }
  }
}

// Workspace packages usually share the repo root's lockfile.
async function findLockfile(root: string, pkg: PackageConfig): Promise<string | undefined> {
  const name = LOCKFILES[pkg.packageManager];
  for (const file of [path.posix.join(pkg.dir, name), name]) {
    if (await exists(path.join(root, file))) return file;
  }
}

async function updateLockfile(root: string, pkg: PackageConfig): Promise<void> {
  const command = lockfileUpdateCommand(pkg.packageManager);
  const { exitCode, stderr } = await runCommand(command, { cwd: path.join(root, pkg.dir) });
  if (exitCode !== 0) throw new Error(`${command} failed: ${stderr.trim()}`);
}

function judgePrompt(c: DeadCodeCandidate, contents: string): string {
  return `knip reports this candidate as unused. Decide whether it really is unused.

Kind: ${c.kind}
File: ${c.file}${c.symbol ? `\nSymbol: ${c.symbol}` : ''}

Contents of ${c.file}:
\`\`\`
${contents}
\`\`\`

Static analysis misses dynamic usage, so search the repository for it: string-based imports (import() or require() with a built or literal name, lookups like obj['name']), config files, framework conventions (file-based routing, magic export or file names), and entry points declared in manifests or registrations (package.json bin, exports or scripts, plugin lists).

Set unused to true with confidence "high" only if the candidate is certainly unused. If anything might use it, lower the confidence and say what in the reason.${
    c.kind === 'export' ? `\n\nCheck whether the declaration of \`${c.symbol}\` has side effects: ${SIDE_EFFECTS}. If it has any, name them in the reason.` : ''
  }`;
}

function editPrompt(c: DeadCodeCandidate): string {
  return `In ${c.file}, the export \`${c.symbol}\` is not used anywhere outside this file. Remove its declaration. If \`${c.symbol}\` is still used inside ${c.file}, remove only its \`export\` keyword instead. If the declaration has side effects (${SIDE_EFFECTS}), remove only its \`export\` keyword so they still run. Change nothing else.`;
}
