import path from 'node:path';
import { runCommand } from './exec.js';
import type { Git } from './git.js';
import { runTests } from './runTests.js';
import type { ChangeRecord, PackageConfig, PlannedChange, ProofResult, RunLog, TestRun } from './types.js';

const DETAIL_IDS = 5;
const DETAIL_LINES = 20;

export interface VerifyContext {
  root: string;
  git: Git;
  packages: PackageConfig[];
  flaky: Set<string>;
  /** Test ids that passed in every baseline run. */
  baselinePassing: Set<string>;
  log: RunLog;
  runTests?: typeof runTests;
  runCommand?: typeof runCommand;
}

/** Applies a change, then commits it only if it stays inside allowedPaths and passes the proof and every check; otherwise rolls it back. Every record is appended to ctx.log.changes. */
export async function applyAndVerify(
  ctx: VerifyContext,
  change: PlannedChange,
  apply: () => Promise<void>,
  proof?: () => Promise<ProofResult>,
): Promise<ChangeRecord> {
  const record = await attempt(ctx, change, apply, proof);
  ctx.log.changes.push(record);
  return record;
}

async function attempt(
  ctx: VerifyContext,
  { allowedPaths, ...change }: PlannedChange,
  apply: () => Promise<void>,
  proof?: () => Promise<ProofResult>,
): Promise<ChangeRecord> {
  let files: string[] = [];
  const rolledBack = async (detail: string): Promise<ChangeRecord> => {
    await ctx.git.rollback();
    return { ...change, files, status: 'rolled-back', detail };
  };
  try {
    await apply();
    files = await ctx.git.changedFiles();
    if (files.length === 0) return { ...change, files, status: 'skipped', detail: 'no change produced' };
    const outside = files.filter((file) => !allowedPaths.some((p) => file === p || file.startsWith(`${p}/`)));
    if (outside.length > 0) return await rolledBack(`touched files outside the change: ${outside.join(', ')}`);
    const proved = await proof?.();
    if (proved && !proved.ok) return await rolledBack(proved.reason);
    const failure = await firstFailure(ctx);
    if (failure) return await rolledBack(failure);
    const message = `mrs-norris(${change.category}): ${change.title}\n\n${change.reason}\n\nMrs-Norris-Change-Id: ${change.id}`;
    return { ...change, files, status: 'committed', commit: await ctx.git.commitAll(message) };
  } catch (error) {
    return rolledBack(`error: ${(error as Error).message}`);
  }
}

async function firstFailure(ctx: VerifyContext): Promise<string | undefined> {
  const { runTests: test = runTests, runCommand: exec = runCommand } = ctx;
  for (const pkg of ctx.packages) {
    const cwd = path.join(ctx.root, pkg.dir);
    for (const [label, command] of [['typecheck', pkg.commands.typecheck], ['lint', pkg.commands.lint]] as const) {
      if (!command) continue;
      const { exitCode, stdout, stderr } = await exec(command, { cwd });
      if (exitCode !== 0) return `${label} failed in ${pkg.dir}: ${lastLines([stdout, stderr].join('\n'))}`;
    }
    const problem = testProblem(await test(ctx.root, pkg), pkg, ctx);
    if (problem !== undefined) return `tests failed in ${pkg.dir}: ${problem}`;
  }
}

// A non-zero exit is accepted only when flaky failures fully explain it. A load error outside
// any test fails no id, and a suite that fails to load drops its tests from the report, so at
// least one test must have failed and every baseline-passing test must still pass.
function testProblem(run: TestRun, pkg: PackageConfig, ctx: VerifyContext): string | undefined {
  if (run.ok) return;
  const failed = run.results.filter((r) => r.status === 'failed').map((r) => r.id);
  if (failed.length === 0) return lastLines(run.output);
  const unexplained = failed.filter((id) => !ctx.flaky.has(id));
  if (unexplained.length > 0) return unexplained.slice(0, DETAIL_IDS).join(', ');
  const passed = new Set(run.results.filter((r) => r.status === 'passed').map((r) => r.id));
  // Ids are repo-relative, so another package's baseline tests are never in this run.
  const dir = path.posix.normalize(pkg.dir).replace(/\/$/, '');
  const inPackage = (id: string) => dir === '.' || id.startsWith(`${dir}/`);
  const missing = [...ctx.baselinePassing].filter((id) => inPackage(id) && !passed.has(id));
  if (missing.length > 0) return `missing ${missing.slice(0, DETAIL_IDS).join(', ')}`;
}

function lastLines(text: string): string {
  return text.trim().split('\n').slice(-DETAIL_LINES).join('\n');
}
