import fs from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES, type Finding, type Metrics, type RunLog, type Usage } from './types.js';

export interface RunSummary {
  branch: string;
  baseRef: string;
  before: Metrics;
  after: Metrics;
  log: RunLog;
  usage: Usage;
  finalCheckOk: boolean;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function signed(delta: number, magnitude: string, zero: string): string {
  if (delta === 0) return zero;
  return `${delta < 0 ? '−' : '+'}${magnitude}`;
}

export function formatDelta(before: number, after: number): string {
  const delta = after - before;
  return signed(delta, formatCount(Math.abs(delta)), '±0');
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatDurationDelta(before: number, after: number): string {
  const delta = after - before;
  return signed(Math.round(delta / 1000), formatDuration(Math.abs(delta)), '±0s');
}

function section(heading: string, lines: string[]): string {
  return `## ${heading}\n\n${lines.length > 0 ? lines.join('\n') : 'None.'}`;
}

function findingLines(findings: Finding[], kind: Finding['kind']): string[] {
  return findings
    .filter((f) => f.kind === kind)
    .map((f) => `- \`${f.file}\`${f.symbol ? ` \`${f.symbol}\`` : ''}: ${f.note}`);
}

function changesSection(changes: RunLog['changes']): string {
  const committed = changes.filter((c) => c.status === 'committed');
  const groups = CATEGORIES.flatMap((category) => {
    const lines = committed
      .filter((c) => c.category === category)
      .map((c) => `- ${c.title}: ${c.reason} (\`${c.id}\`)${c.evidenceOnly ? ' (evidence-only: not test-verified)' : ''}`);
    return lines.length > 0 ? [`### ${category}\n\n${lines.join('\n')}`] : [];
  });
  return groups.length > 0 ? `## Changes\n\n${groups.join('\n\n')}` : section('Changes', []);
}

export function renderReport(s: RunSummary): string {
  const { before, after, log, usage } = s;
  const count = (label: string, key: keyof Metrics) =>
    `| ${label} | ${formatCount(before[key])} | ${formatCount(after[key])} | ${formatDelta(before[key], after[key])} |`;
  const table = [
    '| Metric | Before | After | Change |',
    '| --- | --- | --- | --- |',
    count('Source lines', 'sourceLines'),
    count('Test lines', 'testLines'),
    count('Comment lines', 'commentLines'),
    count('Tests', 'testCount'),
    `| Test-suite time (local, proxy for CI) | ${formatDuration(before.testDurationMs)} | ${formatDuration(after.testDurationMs)} | ${formatDurationDelta(before.testDurationMs, after.testDurationMs)} |`,
    count('Agent context tokens (≈)', 'contextTokens'),
    count('Direct dependencies', 'dependencies'),
  ].join('\n');

  const rolledBack = log.changes
    .filter((c) => c.status === 'rolled-back')
    .map((c) => `- ${c.title}: ${c.detail} (\`${c.id}\`)`);

  return [
    ...(s.finalCheckOk ? [] : ['> ⚠️ The final full test run on the branch failed. Review carefully before merging.']),
    '# mrs-norris report',
    `Branch: \`${s.branch}\` (from \`${s.baseRef}\`)\nReview with: \`git log ${s.baseRef}..${s.branch}\``,
    table,
    changesSection(log.changes),
    section('Rolled back', rolledBack),
    section('Not changed: possibly unused or unverified', findingLines(log.findings, 'possibly-unused')),
    section('Public exports left alone', findingLines(log.findings, 'public-export')),
    section('Flaky tests excluded', log.flaky.map((id) => `- ${id}`)),
    section('Cost', [`${formatCount(usage.inputTokens)} input / ${formatCount(usage.outputTokens)} output tokens · $${usage.costUsd.toFixed(2)}`]),
  ].join('\n\n') + '\n';
}

export async function writeReport(root: string, markdown: string, now: Date): Promise<string> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dir = path.join(root, '.mrs-norris', 'reports');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp}.md`);
  await fs.writeFile(file, markdown);
  return file;
}
