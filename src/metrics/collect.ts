import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Git } from '../git.js';
import type { Metrics } from '../types.js';
import { isDocFile, isSourceFile, isTestFile, matchesAny } from './classify.js';
import { countLines } from './lines.js';

export async function collectMetrics(
  root: string,
  git: Git,
  config: Config,
  testInfo: { testCount: number; durationMs: number },
): Promise<Metrics> {
  const files = (await git.trackedFiles()).filter((file) => !matchesAny(file, config.ignore));
  const metrics: Metrics = {
    sourceLines: 0,
    testLines: 0,
    commentLines: 0,
    testCount: testInfo.testCount,
    testDurationMs: testInfo.durationMs,
    contextTokens: 0,
    dependencies: 0,
  };

  await Promise.all(
    files.map(async (file) => {
      const isSource = isSourceFile(file);
      if (!isSource && !isDocFile(file)) return;
      const text = await fs.readFile(path.join(root, file), 'utf8');
      metrics.contextTokens += Math.ceil(text.length / 4);
      if (!isSource) return;
      const { code, comment } = countLines(text, file);
      metrics[isTestFile(file) ? 'testLines' : 'sourceLines'] += code;
      metrics.commentLines += comment;
    }),
  );

  const dirs = new Set(['.', ...config.packages.map((pkg) => pkg.dir)]);
  for (const dir of dirs) metrics.dependencies += await countDependencies(path.join(root, dir, 'package.json'));
  return metrics;
}

async function countDependencies(manifestPath: string): Promise<number> {
  let text: string;
  try {
    text = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const { dependencies, devDependencies } = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  return Object.keys(dependencies ?? {}).length + Object.keys(devDependencies ?? {}).length;
}
