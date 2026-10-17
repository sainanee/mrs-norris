import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatCount, formatDelta, formatDuration, renderReport, writeReport, type RunSummary } from '../src/report.js';
import type { Metrics } from '../src/types.js';

const before: Metrics = {
  sourceLines: 4300, testLines: 900, commentLines: 700, testCount: 120,
  testDurationMs: 665000, contextTokens: 52000, dependencies: 14,
};
const after: Metrics = {
  sourceLines: 100, testLines: 905, commentLines: 300, testCount: 118,
  testDurationMs: 183000, contextTokens: 9000, dependencies: 13,
};

const summary: RunSummary = {
  branch: 'mrs-norris/2026-10-16-1030',
  baseRef: 'main',
  before,
  after,
  log: {
    changes: [
      { id: 'mn-aaaaaaaaaa', category: 'dead-code', title: 'Remove unused dependency `left-pad`', reason: 'nothing imports it', files: ['package.json'], status: 'committed' },
      { id: 'mn-bbbbbbbbbb', category: 'simplify', title: 'Inline wrapper', reason: 'single caller', files: ['src/a.ts'], status: 'rolled-back', detail: 'tests failed' },
      { id: 'mn-cccccccccc', category: 'comments', title: 'Trim comments', reason: 'restate code', files: ['src/b.ts'], status: 'skipped' },
      { id: 'mn-dddddddddd', category: 'comments', title: 'Trim comments in c', reason: 'restate code', files: ['src/c.ts'], status: 'committed' },
    ],
    findings: [
      { kind: 'possibly-unused', file: 'src/old.ts', symbol: 'legacy', note: 'only referenced dynamically' },
      { kind: 'possibly-unused', file: 'src/whole.ts', note: 'knip flagged, judge unsure' },
      { kind: 'public-export', file: 'src/index.ts', symbol: 'api', note: 'part of the public surface' },
    ],
    flaky: ['tests/a.test.ts > flaky one'],
  },
  usage: { inputTokens: 1234567, outputTokens: 89000, costUsd: 3.456 },
  finalCheckOk: true,
};

test.each([
  [formatDelta(4300, 100), '−4,200'],
  [formatDelta(1, 13), '+12'],
  [formatDelta(5, 5), '±0'],
  [formatCount(4200), '4,200'],
  [formatDuration(42000), '42s'],
  [formatDuration(665000), '11m 5s'],
])('formats %s as %s', (actual, expected) => {
  expect(actual).toBe(expected);
});

describe('renderReport', () => {
  const md = renderReport(summary);

  test('renders the header and metrics table', () => {
    expect(md).toContain('# mrs-norris report');
    expect(md).toContain('Branch: `mrs-norris/2026-10-16-1030` (from `main`)');
    expect(md).toContain('Review with: `git log main..mrs-norris/2026-10-16-1030`');
    expect(md).toContain('| Source lines | 4,300 | 100 | −4,200 |');
    expect(md).toContain('| Test-suite time (local, proxy for CI) | 11m 5s | 3m 3s | −8m 2s |');
    expect(md).toContain('| Agent context tokens (≈) | 52,000 | 9,000 | −43,000 |');
    expect(md).toContain('| Direct dependencies | 14 | 13 | −1 |');
    expect(md).not.toContain('Coverage');
  });

  test('shows a zero time change as ±0s', () => {
    const same = renderReport({ ...summary, after: { ...after, testDurationMs: before.testDurationMs } });
    expect(same).toContain('| 11m 5s | 11m 5s | ±0s |');
  });

  test('lists only committed changes, grouped by category in run order', () => {
    expect(md).toContain('## Changes\n\n### dead-code\n\n- Remove unused dependency `left-pad`: nothing imports it (`mn-aaaaaaaaaa`)');
    expect(md).toContain('### comments\n\n- Trim comments in c: restate code (`mn-dddddddddd`)');
    expect(md.indexOf('### dead-code')).toBeLessThan(md.indexOf('### comments'));
    expect(md).not.toContain('### simplify');
    expect(md).not.toContain('Trim comments:');
  });

  test('lists rolled-back changes with their detail', () => {
    expect(md).toContain('## Rolled back\n\n- Inline wrapper: tests failed (`mn-bbbbbbbbbb`)');
  });

  test('lists findings under their own sections', () => {
    expect(md).toContain(
      '## Not changed: possibly unused or unverified\n\n- `src/old.ts` `legacy`: only referenced dynamically\n- `src/whole.ts`: knip flagged, judge unsure',
    );
    expect(md).toContain('## Public exports left alone\n\n- `src/index.ts` `api`: part of the public surface');
  });

  test('lists flaky tests and the cost', () => {
    expect(md).toContain('## Flaky tests excluded\n\n- tests/a.test.ts > flaky one');
    expect(md).toContain('## Cost\n\n1,234,567 input / 89,000 output tokens · $3.46');
  });

  test('shows None. for every empty section', () => {
    const empty = renderReport({ ...summary, log: { changes: [], findings: [], flaky: [] } });
    for (const heading of ['Changes', 'Rolled back', 'Not changed: possibly unused or unverified', 'Public exports left alone', 'Flaky tests excluded']) {
      expect(empty).toContain(`## ${heading}\n\nNone.`);
    }
  });

  test('puts the failed-final-check warning before the table', () => {
    const warned = renderReport({ ...summary, finalCheckOk: false });
    const warning = '> ⚠️ The final full test run on the branch failed. Review carefully before merging.';
    expect(warned.startsWith(warning)).toBe(true);
    expect(warned.indexOf(warning)).toBeLessThan(warned.indexOf('| Metric |'));
    expect(md).not.toContain('⚠️');
  });
});

test('writeReport creates the reports directory and names the file by timestamp', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'report-'));
  const file = await writeReport(root, '# hi', new Date(2026, 9, 16, 9, 5, 7));
  expect(file).toBe(path.join(root, '.mrs-norris', 'reports', '20261016-090507.md'));
  expect(await fs.readFile(file, 'utf8')).toBe('# hi');
});
