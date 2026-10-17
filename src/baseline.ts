import path from 'node:path';
import { runCommand } from './exec.js';
import { runTests, statusById } from './runTests.js';
import type { PackageConfig, TestResult } from './types.js';

export interface Baseline {
  pkgDir: string;
  ok: boolean;
  failing: string[];
  flaky: string[];
  /** Ids that passed in every run. */
  passing: string[];
  testCount: number;
  durationMs: number;
  problems: string[];
  warnings: string[];
}

export async function runBaseline(
  root: string,
  pkg: PackageConfig,
  deps: { runTests?: typeof runTests; runCommand?: typeof runCommand; runs?: number } = {},
): Promise<Baseline> {
  const { runTests: test = runTests, runCommand: exec = runCommand, runs: runCount = 2 } = deps;
  const runs = [];
  for (let i = 0; i < runCount; i++) runs.push(await test(root, pkg));

  const problems: string[] = [];
  const warnings: string[] = [];
  const cmd = pkg.commands.test;

  const statuses = new Map<string, TestResult['status'][]>();
  for (const run of runs) {
    for (const [id, status] of statusById(run.results)) statuses.set(id, [...(statuses.get(id) ?? []), status]);
  }
  const idsWhere = (keep: (s: TestResult['status'][]) => boolean) => [...statuses].filter(([, s]) => keep(s)).map(([id]) => id);
  const failing = idsWhere((s) => s.every((x) => x === 'failed'));
  const flaky = idsWhere((s) => new Set(s).size > 1);
  const passing = idsWhere((s) => s.length === runCount && s.every((x) => x === 'passed'));

  if (runs.some((r) => r.reportMissing)) {
    warnings.push(
      `Couldn't read per-test results from \`${cmd}\`. Make sure it runs ${pkg.runner} directly (or edit .mrs-norris/config.yaml). Continuing with exit codes only.`,
    );
  }
  if (statuses.size === 0) {
    const passes = runs.filter((r) => r.ok).length;
    if (passes > 0 && passes < runs.length) problems.push(`Test suite passes only sometimes: ${cmd}`);
    else if (passes === 0) problems.push(`Tests fail at baseline: ${cmd}`);
  } else if (runs.some((r) => !r.ok && !r.results.some((x) => x.status === 'failed'))) {
    // A suite that fails to load vanishes from the report while the command still exits non-zero.
    problems.push(`Test command exits non-zero at baseline: ${cmd}`);
  }

  const cwd = path.join(root, pkg.dir);
  for (const [label, command] of [['Type-check', pkg.commands.typecheck], ['Lint', pkg.commands.lint]] as const) {
    if (command && (await exec(command, { cwd })).exitCode !== 0) problems.push(`${label} fails at baseline: ${command}`);
  }

  return {
    pkgDir: pkg.dir,
    ok: failing.length === 0 && problems.length === 0,
    failing,
    flaky,
    passing,
    testCount: idsWhere((s) => s.some((x) => x !== 'skipped')).length,
    durationMs: runs[0]!.durationMs,
    problems,
    warnings,
  };
}
