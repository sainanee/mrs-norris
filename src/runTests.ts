import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendArgs, parseTestReport, reporterArgs } from './adapters/node/testReport.js';
import { runCommand } from './exec.js';
import type { PackageConfig, TestRun } from './types.js';

const OUTPUT_LINES = 200;

export async function runTests(root: string, pkg: PackageConfig): Promise<TestRun> {
  const cwd = path.join(root, pkg.dir);
  // Outside the repo so the working tree stays clean.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mrs-norris-'));
  try {
    const reportFile = path.join(tmpDir, 'report.json');
    const command = pkg.runner ? appendArgs(pkg.commands.test, reporterArgs(pkg.runner, reportFile)) : pkg.commands.test;
    const { exitCode, stdout, stderr, durationMs } = await runCommand(command, { cwd });
    const raw = pkg.runner ? await fs.readFile(reportFile, 'utf8').catch(() => undefined) : undefined;
    return {
      ok: exitCode === 0,
      results: pkg.runner && raw !== undefined ? parseTestReport(pkg.runner, raw, cwd) : [],
      durationMs,
      reportMissing: pkg.runner !== null && raw === undefined,
      output: [stdout, stderr].filter(Boolean).join('\n').split('\n').slice(-OUTPUT_LINES).join('\n'),
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
