import fs from 'node:fs/promises';
import path from 'node:path';
import { findNodeDeadCode } from '../adapters/node/knip.js';
import { nodePublicSurface } from '../adapters/node/publicSurface.js';
import { assertApiKey, createClaudeAgent } from '../agent/claude.js';
import type { Agent } from '../agent/types.js';
import { runBaseline } from '../baseline.js';
import { loadConfig } from '../config.js';
import { killLiveChildren } from '../exec.js';
import { Git } from '../git.js';
import type { IO } from '../io.js';
import { collectMetrics } from '../metrics/collect.js';
import { runCommentPass } from '../passes/comments.js';
import type { PassContext } from '../passes/context.js';
import { runDeadCodePass } from '../passes/deadCode.js';
import { renderReport, writeReport, type RunSummary } from '../report.js';
import { newRunLog } from '../runlog.js';
import { runTests } from '../runTests.js';
import { makeScope } from '../scope.js';
import { CATEGORIES, type Category } from '../types.js';
import { applyAndVerify } from '../verify.js';
import { initProject } from './init.js';

export interface RunOptions {
  paths: string[];
  since?: string;
  only?: Category[];
  model?: string;
  yes?: boolean;
}

export interface RunDeps {
  io: IO;
  agent?: Agent;
  now?: () => Date;
  findDeadCode?: PassContext['findDeadCode'];
}

const PASSES: Partial<Record<Category, (ctx: PassContext) => Promise<void>>> = {
  'dead-code': runDeadCodePass,
  comments: runCommentPass,
};

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

export function parseOnly(value: string): Category[] {
  return value.split(',').map((name) => {
    const category = name.trim();
    if (!(CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`Unknown category "${category}". Valid: ${CATEGORIES.join(', ')}`);
    }
    return category as Category;
  });
}

function branchName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `mrs-norris/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export async function runMrsNorris(
  root: string,
  opts: RunOptions,
  deps: RunDeps,
): Promise<{ reportPath: string; branch: string; summary: RunSummary }> {
  const { io, now = () => new Date() } = deps;
  // Set just before branching. Until then a signal only needs exec.ts's exit cleanup.
  let cleanup: (() => Promise<void>) | undefined;
  let aborting: Promise<void> | undefined;
  const abort = async () => {
    if (cleanup) await (aborting ??= cleanup());
  };
  let signalled = false;
  const handlers = Object.entries(SIGNAL_EXIT_CODES).map(([signal, code]) => {
    const handler = () => {
      // A repeated signal gives up on the cleanup.
      if (signalled) return process.exit(code);
      signalled = true;
      // Stay registered until the cleanup ends: execa's signal-exit hook re-raises the signal,
      // killing us mid-cleanup, once it is the only listener left. process.exit must come
      // last, because exec.ts kills running child processes on 'exit'.
      void abort()
        .catch((error: Error) => {
          console.error(`mrs-norris could not restore your checkout: ${error.message}`);
        })
        .finally(() => {
          removeHandlers();
          process.exit(code);
        });
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };

  try {
    if (!deps.agent) assertApiKey();
    const git = new Git(root);
    const toplevel = await git.toplevel();
    if (toplevel === null) throw new Error(`Not a git repository: ${root}`);
    if (toplevel !== (await fs.realpath(root))) throw new Error(`Run mrs-norris from the repository root: ${toplevel}`);
    const config = (await loadConfig(root)) ?? (await initProject(root, io, { yes: opts.yes ?? false }));
    if (!(await git.isClean())) {
      throw new Error('Working tree has uncommitted changes. Commit or stash them, then run mrs-norris again.');
    }
    const scope = await makeScope(git, opts.paths, opts.since);

    const baselines = [];
    for (const pkg of config.packages) baselines.push(await runBaseline(root, pkg));
    for (const warning of baselines.flatMap((b) => b.warnings)) io.print(warning);
    if (baselines.some((b) => !b.ok)) {
      for (const b of baselines) {
        for (const problem of b.problems) io.print(problem);
        for (const id of b.failing) io.print(`Failing at baseline: ${id}`);
      }
      throw new Error('Baseline is not green. mrs-norris needs passing tests to prove it preserved behavior.');
    }
    const stray = await git.changedFiles();
    if (stray.length > 0) {
      throw new Error(
        `Your test command changed files in the repo (${stray.slice(0, 3).join(', ')}). mrs-norris needs a test run that leaves the tree clean.`,
      );
    }

    const before = await collectMetrics(root, git, config, {
      testCount: sum(baselines.map((b) => b.testCount)),
      durationMs: sum(baselines.map((b) => b.durationMs)),
    });
    const surfaces = new Map(
      await Promise.all(config.packages.map(async (pkg) => [pkg.dir, await nodePublicSurface(root, pkg.dir)] as const)),
    );
    const agent = deps.agent ?? createClaudeAgent({ model: opts.model ?? config.model, root });
    const findDeadCode =
      deps.findDeadCode ?? ((pkg) => findNodeDeadCode(root, pkg, { monorepo: config.packages.length > 1 }));
    const log = newRunLog();
    log.flaky = [...new Set(baselines.flatMap((b) => b.flaky))];
    const original = (await git.currentBranch()) ?? (await git.head());

    const returnToOriginal = async (g: Git) => {
      await g.rollback();
      await g.checkout(original);
    };
    cleanup = async () => {
      killLiveChildren();
      // Waits for a git command already running, so a change in flight can't race the reset.
      await git.close();
      const recovery = new Git(root);
      const branch = await recovery.currentBranch();
      await returnToOriginal(recovery);
      if (branch === null || branch === original) return;
      if ((await recovery.subjects(`${original}..${branch}`)).length > 0) {
        io.print(`Kept branch ${branch} with the changes committed so far.`);
      } else {
        await recovery.deleteBranch(branch);
        io.print(`Deleted branch ${branch}: no changes were committed.`);
      }
    };
    const branch = await git.createBranch(branchName(now()));

    const verifyContext = {
      root,
      git,
      packages: config.packages,
      flaky: new Set(log.flaky),
      baselinePassing: new Set(baselines.flatMap((b) => b.passing)),
      log,
    };
    const ctx: PassContext = {
      root,
      config,
      git,
      agent,
      log,
      scope,
      surfaces,
      verify: (change, apply, proof) =>
        aborting ? Promise.reject(new Error('Aborted')) : applyAndVerify(verifyContext, change, apply, proof),
      findDeadCode,
    };
    for (const category of CATEGORIES) {
      if (config.categories.includes(category) && (opts.only ?? CATEGORIES).includes(category)) {
        await PASSES[category]?.(ctx);
      }
    }

    const finalRuns = [];
    for (const pkg of config.packages) finalRuns.push(await runTests(root, pkg));
    const after = await collectMetrics(root, git, config, {
      testCount: sum(
        finalRuns.map((run) => new Set(run.results.filter((r) => r.status !== 'skipped').map((r) => r.id)).size),
      ),
      durationMs: sum(finalRuns.map((run) => run.durationMs)),
    });
    const summary: RunSummary = {
      branch,
      baseRef: original,
      before,
      after,
      log,
      usage: agent.usage(),
      finalCheckOk: finalRuns.every((run) => run.ok),
    };
    const markdown = renderReport(summary);
    const reportPath = await writeReport(root, markdown, now());
    io.print(markdown);
    io.print(`Report written to ${path.relative(root, reportPath)}`);
    await returnToOriginal(git);
    return { reportPath, branch, summary };
  } catch (error) {
    await abort();
    throw error;
  } finally {
    removeHandlers();
  }
}
