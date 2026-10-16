import path from 'node:path';
import type { Runner, TestResult } from '../../types.js';

export function reporterArgs(runner: Runner, outFile: string): string[] {
  switch (runner) {
    case 'vitest':
      return ['--reporter=json', `--outputFile=${outFile}`];
    case 'jest':
      return ['--json', `--outputFile=${outFile}`];
    case 'mocha':
      return ['--reporter', 'json', '--reporter-option', `output=${outFile}`];
  }
}

export function appendArgs(command: string, args: string[]): string {
  const separator = /^(npm|pnpm) (run|test)\b/.test(command) ? ' -- ' : ' ';
  return command + separator + args.join(' ');
}

interface JestReport {
  testResults: {
    name: string;
    status: string;
    assertionResults: { fullName: string; status: string; duration?: number | null }[];
  }[];
}

interface MochaTest { fullTitle: string; file: string; duration?: number }
interface MochaReport { tests: MochaTest[]; failures: MochaTest[]; pending: MochaTest[] }

export function parseTestReport(runner: Runner, raw: string, root: string): TestResult[] {
  const report: unknown = JSON.parse(raw);
  return runner === 'mocha' ? parseMocha(report as MochaReport, root) : parseJestShaped(report as JestReport, root);
}

function result(root: string, absFile: string, name: string, status: TestResult['status'], duration = 0): TestResult {
  const file = path.relative(root, absFile);
  return { id: `${file} > ${name}`, file, status, durationMs: Math.round(duration) };
}

function parseJestShaped(report: JestReport, root: string): TestResult[] {
  return report.testResults.flatMap((suite) => {
    // A suite that fails to load reports no assertions; without a result of its own it would vanish.
    if (suite.status === 'failed' && suite.assertionResults.length === 0) {
      return [result(root, suite.name, '(suite failed to load)', 'failed')];
    }
    return suite.assertionResults.map((t) => {
      const status = t.status === 'passed' || t.status === 'failed' ? t.status : 'skipped';
      return result(root, suite.name, t.fullName, status, t.duration ?? 0);
    });
  });
}

function parseMocha(report: MochaReport, root: string): TestResult[] {
  const key = (t: MochaTest) => `${t.file}\0${t.fullTitle}`;
  const failed = new Set(report.failures.map(key));
  const skipped = new Set(report.pending.map(key));
  return report.tests.map((t) =>
    result(root, t.file, t.fullTitle, failed.has(key(t)) ? 'failed' : skipped.has(key(t)) ? 'skipped' : 'passed', t.duration),
  );
}
