# mrs-norris — Plan 2: Coverage, test writing and simplification (TS/JS)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run measures coverage with tools it installs temporarily, simplifies code the tests cover, writes tests first for code they don't, and skips only the affected passes, per package, when coverage isn't available.

**Architecture:** Coverage comes from each runner's own coverage (vitest, jest) or c8 (mocha), all read as istanbul `coverage-final.json` into a position-keyed `Coverage` map. Missing coverage tools are added with the package manager, every file the install touched is restored from HEAD, and the tools are removed after the run. Test writing and simplification run as one pass, target by target. Each simplification goes through the existing `applyAndVerify` loop with a proof that checks coverage of the changed lines before and after, the public exports, the line count, and a Claude review.

**Tech Stack:** As in Plan 1 (Node ≥22, TypeScript ~5.9 strict ESM, commander, zod, yaml, execa, fast-glob, picomatch, knip, @anthropic-ai/claude-agent-sdk, vitest). This plan adds the dev dependency `@vitest/coverage-v8@5.0.5`, which matches vitest 5.0.5. It backs this repo's own `npm run coverage` and the tests that need real coverage.

**Spec:** `docs/superpowers/specs/2026-10-16-mrs-norris-design.md`. Plan 1's decisions and open items are in `docs/superpowers/plans/2026-10-16-mrs-norris-plan-1-followups.md`. Read both.

## Scope

- **Tasks 1–6** close the Plan 1 open items marked "before or during Plan 2". Task 1 (failed suites whose assertions all pass) must land before the simplify pass. One item stays open: the narrow post-checkout failure that reports a false "checkout moved". It needs a failing `git branch -D` after checkout to reproduce, and the fix isn't worth a hook-based test yet.
- **Tasks 7–14** deliver the roadmap row for Plan 2:
  - coverage measurement
  - temporary tool provisioning (§5.6)
  - the report's Coverage row and Tools installed section
  - graceful per-package degradation (§5.7)
  - the simplification pass (§4.4) with the coverage rule (§5.2)
  - the test-writing pass (§4.3)
  - style overrides
- **Not here:**
  - Plan 1's "smaller items"
  - mutation testing and test pruning (Plan 3)
  - affected-test selection (Plan 3). Until then every check runs every package's full suite.

## Decisions this plan makes (my calls)

1. **Test writing and simplification are one pass**, registered under `simplify` and run in its slot. For each target, the tests go in first if the target needs them, and the simplification follows. Each test commit then sits right before the commit that relies on it (§5.5). `test-writing` without `simplify` does nothing, and the run says so.
2. **"Covered" means every statement and every branch arm that overlaps the line ran at least once.** Removed and modified lines are checked against the coverage of the tree before the change. Added lines are checked against a fresh coverage run with the change staged. A file missing from coverage is uncovered.
3. **Simplifications change one file.** Merging duplicated logic across files is left for later and noted as a follow-up.
4. **A simplification must not add code lines, and must pass a Claude review** that answers two questions: does it preserve behavior, and is it clearer and not just shorter? This is the guard against "chasing the number".
5. **Coverage is measured whenever a package's runner is known,** even in a dead-code-only run, so the report always has the Coverage row.
6. **Tool installs are restored generically.** Every file the install command changed is restored from HEAD, and the tool must still be in `node_modules` afterwards. Yarn Plug'n'Play therefore degrades with a reason. Tools are removed after the run.
7. **A test command that breaks when mrs-norris adds reporter arguments** makes the package exit-code-only for that run: it gets no per-test checks and no coverage.

## Global Constraints

- Everything in Plan 1's Global Constraints still holds: commit format, change ids, branch naming, `.mrs-norris/` handling, protected docs, the default model, and category order `dead-code`, `comments`, `test-writing`, `simplify`, `test-pruning`.
- §5.2: "Code may only be simplified if the lines being changed are covered by tests — either existing tests or ones written in §4.3. Tests, type-check, and lint must all pass after the change."
- §5.6: tools are installed "temporarily into their … `node_modules` for the run, then restores manifests and lockfiles exactly. Nothing tool-related ever lands on the mrs-norris branch. The report lists what was installed."
- §4.3 tests:
  - "Pin the code's **current** behavior and must pass against the unmodified code before simplification begins."
  - "Test behavior through public interfaces, not implementation details; minimal mocking; parametrized rather than copy-pasted."
  - "Are **kept** in the repo as their own commits, before the simplification commit that relies on them."
  - "Follow the repo's existing test framework, file layout, and naming."
- §5.5: "where a commit depends on another (e.g. a simplification depends on the tests written for it), the message says so."
- §5.7 degradation: "No coverage data → also skip test writing and simplification (§4.3–4.4)". "Dead-code removal and comment trimming still run". The report says what was skipped, per package.
- §4.4: matches the repo's own conventions by default. The config's `style` rules take precedence (§6.1).
- Supported runners: Jest, Vitest, Mocha. Coverage output is istanbul JSON written to a temp dir outside the repo.
- This repo's own standards (CLAUDE.md) apply to every task: no dead code, no speculative abstraction, comments only for *why*, one test per distinct bug, mocks only at process and network boundaries.

## Review Focus

1. **A coverage-tool install changes more than the manifest and lockfile, or leaves the tool unresolvable** (for example Yarn Plug'n'Play, `.yarn/install-state.gz`, or a pnpm workspace root). Expected: everything the install changed is restored, and the package degrades with a reason instead of the run failing. Tested in Task 9.
2. **The user's coverage config gets in the way**: thresholds fail, or the coverage run writes files into the repo. Expected: that package degrades with the reason, the files are discarded, and the run carries on. Tested in Task 11.
3. **The repo is opened through a symlinked path** (macOS `/tmp`, `/var`), while the runners report real paths. Expected: coverage still matches repo-relative files. If it didn't, every simplification would be refused as uncovered. Tested in Task 7.
4. **The run errors or stops after tools were installed.** Expected: tools are removed once, after the checkout is back on the user's branch, and the manifests and lockfile are byte-identical. Tested in Task 11.
5. **Claude proposes a test file that isn't a test file, sits in another package, or matches an ignore glob.** Expected: nothing is written, and the target becomes an "unverified" finding. Tested in Task 13.

---

## Shared types

These additions go into `src/types.ts`, each in the task named. Later tasks import them and don't redefine them.

```ts
// Task 5
export interface DeadCodeCandidate { kind: 'file' | 'export' | 'dependency'; pkgDir: string; file: string; symbol?: string; line?: number;
  section?: 'dependencies' | 'devDependencies' }  // set for dependencies

// Task 7
/** A statement or branch arm: 1-based inclusive lines and how often it ran. */
export interface Span { startLine: number; endLine: number; hits: number }
/** Spans keyed by exact source position, so runs of the same code merge by summing hits. */
export interface FileCoverage { statements: Map<string, Span>; branches: Map<string, Span> }
export type Coverage = Map<string, FileCoverage>; // key: repo-relative file

// Task 8
export interface TestRun { /* …existing… */ coverage?: Coverage } // set when coverage was asked for and read

// Task 10
export interface Finding { kind: 'possibly-unused' | 'public-export' | 'unverified'; file: string; symbol?: string; note: string }
export interface SkippedPass { pkgDir: string; categories: Category[]; reason: string }
export interface RunLog { changes: ChangeRecord[]; findings: Finding[]; flaky: string[]; installed: string[]; skipped: SkippedPass[] }
export interface Metrics { /* …existing… */ coverage: { line: number; branch: number } | null } // percentages, 1 decimal
```

---

### Task 1: Report a failed suite even when its tests passed

**Files:**
- Modify: `src/adapters/node/testReport.ts`
- Test: `tests/adapters/node/testReport.test.ts`, `tests/runTests.test.ts`

**Interfaces:**
- Produces: `parseTestReport` keeps its signature with two new rules:
  - **Jest-shaped report:** a suite with `status: 'failed'` and no failed assertion adds a result `{ id: '<file> > (suite failed)', status: 'failed', durationMs: 0 }` alongside its assertion results. This one id replaces the old `(suite failed to load)` id.
  - **Mocha report:** entries in `failures[]` that are not in `tests[]` become failed results under their own `fullTitle`, for example hook failures like `"after all" hook in "s"`.

- [ ] **Step 1: Write the failing tests**
  - `runTests` on a real vitest temp repo with `tests/a.test.ts` = `test('a', () => {}); afterAll(() => { throw new Error('teardown'); });` (command `${VITEST} run --globals`). Expected: `ok` is false and results are `[['tests/a.test.ts > a', 'passed'], ['tests/a.test.ts > (suite failed)', 'failed']]`. Vitest 5.0.5 marks this suite `failed` with its assertion `passed`; this was checked while writing the plan.
  - Update the existing jest-fixture expectation for a suite with no assertions so it expects `<file> > (suite failed)`.
  - A mocha report with `tests: []`, `pending: []`, `failures: [{ fullTitle: '"after all" hook in "s"', file: '<root>/test/s.js' }]` gives `[{ id: 'test/s.js > "after all" hook in "s"', status: 'failed' }]`.
- [ ] **Step 2: Run them.** `npx vitest run tests/runTests.test.ts tests/adapters/node/testReport.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement both rules in `parseJestShaped` and `parseMocha`.**
- [ ] **Step 4: Run them.** Expected: PASS. `npm test && npm run typecheck` are clean.
- [ ] **Step 5: Commit.** `fix: report a failed suite even when its tests passed`

---

### Task 2: Fall back to exit codes when reporter arguments break the test command

**Files:**
- Modify: `src/adapters/node/testReport.ts`, `src/baseline.ts`, `src/commands/run.ts`
- Test: `tests/adapters/node/testReport.test.ts`, `tests/baseline.test.ts`, `tests/commands/run.test.ts`

**Interfaces:**
- Produces:
  - `appendArgs`: if the command already contains ` -- `, it adds a single space instead of a second ` -- `.
  - `Baseline.exitCodeOnly: boolean`. When any baseline run has `reportMissing`, `runBaseline` returns the result of `runBaseline(root, { ...pkg, runner: null }, deps)` with `exitCodeOnly: true`. That result carries this one warning instead of the old one: `` `<cmd>` didn't write per-test results with mrs-norris's reporter arguments, so <dir> continues with exit codes only (no per-test checks or coverage). Make the test command run <runner> directly to enable them. ``
  - `run.ts`: from the baseline on, each package whose baseline has `exitCodeOnly` runs as `{ ...pkg, runner: null }`. This covers the verify context, the final runs, and coverage in later tasks.

- [ ] **Step 1: Write the failing tests**
  - `appendArgs('npm run test -- --globals', ['--reporter=json'])` returns `'npm run test -- --globals --reporter=json'`.
  - Baseline with runner `vitest` and command `node strict.js`, where `strict.js` exits 1 if `process.argv.length > 2` and 0 otherwise. Expected: `ok: true`, `exitCodeOnly: true`, and `warnings[0]` contains `continues with exit codes only`.
  - The same setup with a script that always exits 1. Expected: `ok: false`, and `problems` contains `Tests fail at baseline: node strict.js`.
  - Run, `only: ['comments']`, one package with runner `vitest` and a test command that fails when given arguments and otherwise runs the existing `check.js` logic. Expected: the comment change is committed. Before the fix, every verification failed.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Update the old `Continuing with exit codes only` assertion.
- [ ] **Step 5: Commit.** `fix: fall back to exit codes when reporter arguments break the test command`

---

### Task 3: Check each package against its own must-pass tests

**Files:**
- Modify: `src/verify.ts`, `src/commands/run.ts`
- Test: `tests/verify.test.ts`

**Interfaces:**
- Produces: `VerifyContext.baselinePassing` becomes `mustPass: Map<string, Set<string>>`, keyed by package dir. Its doc comment: "Test ids each package's run must still pass: those that passed in every baseline run, plus every non-flaky id that passed when a change was committed." Behavior:
  - `testProblem` checks a package's run only against `mustPass.get(pkg.dir)`. The directory-prefix `inPackage` check goes away.
  - After a commit, every id that passed in that verification (minus `ctx.flaky`) joins its package's set. This makes Task 13's new tests protected like baseline tests.
  - `run.ts` builds the map from `Baseline.pkgDir` and `Baseline.passing`.

- [ ] **Step 1: Write the failing tests.** Each test uses a stubbed `runTests` keyed by `pkg.dir`.
  - Packages `.` and `packages/a`, with must-pass sets `{'tests/x.test.ts > t'}` and `{'packages/a/t.test.ts > u'}`. Each stub run passes only its own id. Expected: committed. Before the fix, the `.` run missed the `packages/a` id.
  - Change 1's run also passes `tests/new.test.ts > n` and is committed. Change 2's run lacks it. Expected: change 2 rolls back with detail `tests failed in .: missing tests/new.test.ts > n`.
  - A flaky id that passed in a committed run and is absent from the next run doesn't cause a rollback.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `firstFailure` also returns the ids that passed per package, so `attempt` can add them on commit.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `fix: check each package's run against its own must-pass tests`

---

### Task 4: Accept only comment deletions in the comment proof

**Files:**
- Modify: `src/adapters/node/comments.ts`, `src/passes/comments.ts`
- Test: `tests/adapters/node/comments.test.ts`, `tests/passes/comments.test.ts`

**Interfaces:**
- Produces: `onlyCommentsRemoved(before: string, after: string, fileName: string): boolean`. It returns true when `after` equals `before` with some of `before`'s comments deleted.
  - **Which comments were deleted:** walk `before`'s comments in order against `after`'s. The next `after` comment with the same text is kept; anything else is deleted. Any `after` comments left over make the result false.
  - **How a deleted comment is cut:**
    - With code before it on its line: the comment plus the horizontal whitespace before it.
    - Otherwise, with code after it on its line: the comment plus the horizontal whitespace after it.
    - Otherwise: its whole line or lines, including the line break.
  - The comment pass proof checks it after `codeTokensEqual` and fails with `changed more than comments`. `codeTokensEqual` stays because deleting a block comment that holds a line break can change ASI.

- [ ] **Step 1: Write the failing tests** (`test.each`)
  - True for: deleting a whole-line `  // a` together with its line; deleting a trailing ` // a` after `x();`; deleting a leading `/* a */ ` before `x();`; deleting nothing.
  - False for: a reindented code line; `\n` turned into `\r\n`; a protected comment moved to another line; a blank line left where a comment line was; a new comment added.
  - Comment pass: a rewrite that drops `// add two numbers` and also reindents `return a + b;`. Expected: rolled back with `changed more than comments`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** using `parseSource(...).comments` ranges.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `fix: accept only comment deletions in the comment proof`

---

### Task 5: Dependency evidence and package-manager commands

**Files:**
- Modify: `src/types.ts` (`section`), `src/adapters/node/knip.ts`, `src/adapters/node/dependencies.ts`, `src/passes/deadCode.ts`
- Test: `tests/adapters/node/knip.test.ts`, `tests/adapters/node/dependencies.test.ts`, `tests/passes/deadCode.test.ts`

**Interfaces:**
- Produces:
  - `parseKnipJson` sets `section` from knip's `dependencies` or `devDependencies` array.
  - `removeDependency(pkgJsonPath: string, name: string, section: 'dependencies' | 'devDependencies')` deletes the name from that section only.
  - `manifestMentions(manifest: string, name: string): boolean` is true when `name` appears as a whole word in the manifest JSON after the four dependency sections are removed. Whole-word boundaries are the same as `git grep -w`: not next to `[A-Za-z0-9_]`.
  - `referencesOutside` for a dependency: every `package.json` hit, its own manifest included, counts only when `manifestMentions` is true. Lockfiles stay excluded.
  - `pmCommand(root: string, pm: PackageManager, action: 'lockfile' | 'add' | 'remove', args: string[] = []): Promise<string>` replaces `lockfileUpdateCommand`. It returns the base command plus `' ' + args.join(' ')` when there are args. Yarn means Berry when `<root>/.yarnrc.yml` exists, and Classic otherwise.

| pm | lockfile | add | remove |
|---|---|---|---|
| npm | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | `npm install --save-dev --ignore-scripts --no-audit --no-fund` | `npm uninstall --ignore-scripts --no-audit --no-fund` |
| pnpm | `pnpm install --lockfile-only --ignore-scripts` | `pnpm add --save-dev --ignore-scripts` | `pnpm remove` |
| yarn Classic | `yarn install --ignore-scripts` | `yarn add --dev --ignore-scripts` | `yarn remove` |
| yarn Berry | `yarn install --mode update-lockfile` | `YARN_ENABLE_SCRIPTS=0 yarn add --dev` | `YARN_ENABLE_SCRIPTS=0 yarn remove` |

- [ ] **Step 1: Write the failing tests** for the evidence fixes
  - Dead-code pass, dependency `husky` (section `devDependencies`), root `package.json` with `"scripts": { "prepare": "husky" }`. Expected: no change, and a `possibly-unused` finding with note `Referenced in: package.json`.
  - Dependency `left-pad` that is also listed in another workspace manifest's `dependencies`. Expected: removed (verify stubbed green).
  - `removeDependency` with `foo` in both `devDependencies` and `peerDependencies`, section `devDependencies`. Expected: `peerDependencies.foo` is kept.
  - `parseKnipJson` on the existing fixture: dependency candidates carry the right `section`.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `fix: count manifest scripts as dependency references and remove only the flagged section`
- [ ] **Step 6: Write the failing test** `test.each` over the four table rows, checking `pmCommand(root, pm, 'lockfile')` and `pmCommand(root, pm, 'add', ['c8'])`. For Berry, create `.yarnrc.yml` in the temp dir.
- [ ] **Step 7: Run it.** Expected: FAIL. **Step 8: Implement `pmCommand`** and switch the dead-code pass to it. **Step 9: Run it.** Expected: PASS.
- [ ] **Step 10: Commit.** `fix: use package-manager commands that exist for yarn classic and berry`

---

### Task 6: A report for zero-commit and stopped runs

**Files:**
- Modify: `src/report.ts`, `src/commands/run.ts`
- Test: `tests/report.test.ts`, `tests/commands/run.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RunSummary {
  branch: string | null;      // null when nothing was committed, so the branch was deleted
  baseRef: string;
  before: Metrics;
  log: RunLog;
  usage: Usage;
  end: { after: Metrics; finalCheckOk: boolean } | { error: string };
}
```

- `renderReport`:
  - With `branch === null`, the Branch and Review lines are replaced by `No changes were committed, so no branch was kept.`
  - The Branch and Review lines are now separate paragraphs.
  - With `'error' in end`, the report opens with `> ⚠️ mrs-norris stopped early: <error>. The branch keeps the changes committed before that.` and has no metrics table.
- `writeReport` uses `CONFIG_DIR`.
- `runMrsNorris`: if an error is thrown after the branch exists and at least one change was committed, it writes and prints a stopped-early report before cleanup, then rethrows.

- [ ] **Step 1: Write the failing tests**
  - `renderReport` with `branch: null` contains `No changes were committed, so no branch was kept.` and no `Review with`.
  - `renderReport` with `end: { error: 'boom' }` starts with the stopped-early banner and has no `| Metric |`.
  - A run whose only edit is a no-op has a report containing `No changes were committed` and not `mrs-norris/2026-10-16-1432`.
  - Two files with comments, where the agent's second edit runs `git checkout feature`, the same move the existing branch-switch test uses. Expected: rejects with `The checkout moved`. A report under `.mrs-norris/reports/` contains `stopped early` and the first file's `Trim redundant comments` title.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `fix: write a report for zero-commit and stopped runs`

---

### Task 7: Coverage data

**Files:**
- Create: `src/coverage.ts`, `tests/fixtures/coverage/coverage-final.json`
- Modify: `src/types.ts` (Task 7 types)
- Test: `tests/coverage.test.ts`

**Interfaces:**
- Produces:
  - `parseIstanbul(raw: string, root: string): Coverage`
    - Input: istanbul `coverage-final.json`, which maps an absolute path to `{ statementMap, s, branchMap, b }`. Each `statementMap` and `branchMap` entry has `loc`, `locations[]` and `start`/`end` objects of `{ line, column }`.
    - Statement key: `<start.line>:<start.column>-<end.line>:<end.column>`.
    - Branch-arm key: the branch's `loc` key + `#<arm index>`. An arm location without `start.line` uses the branch's `loc` lines.
    - File key: relative to `fs.realpathSync(root)` when the path is under it, otherwise relative to `root`. Files outside both are dropped.
  - `mergeCoverage(maps: Coverage[]): Coverage` sums `hits` for equal keys.
  - `uncoveredLines(coverage: Coverage, file: string, lines: number[]): number[]` returns the given lines that are spanned by a statement or arm with `hits === 0`. When the file isn't in `coverage`, it returns all of them.
  - `coverageTotals(coverage: Coverage, ignore: string[]): { line: number; branch: number }`
    - Only files where `isSourceFile && !isTestFile && !matchesAny(file, ignore)` count.
    - Line %: a line is any statement's start line, and it is covered when some statement starting there has hits.
    - Branch %: arms that ran over all arms.
    - Both are rounded to 1 decimal, and are 100 when there is nothing to count.

- [ ] **Step 1: Write the fixture.** Two files under a fake root `/repo` and one under `/elsewhere`:
  - `/repo/src/a.ts`: statements on lines 1 (hits 1), 2 (hits 0) and 3–5 (hits 2), plus one `if` branch whose `loc` and both arm locations sit on line 3, with arm hits `[2, 0]`.
  - `/repo/src/a.test.ts`: one statement with hits 1.
- [ ] **Step 2: Write the failing tests**
  - `parseIstanbul(raw, '/repo')` has keys `['src/a.ts', 'src/a.test.ts']`. The `/elsewhere` file is dropped.
  - `parseIstanbul` with `root` a symlink to a temp dir and the fixture's paths rewritten to the real path gives the same keys.
  - `uncoveredLines` (`test.each`): `[1]` → `[]`; `[2]` → `[2]`; `[3, 4]` → `[3]` (the arm); `[6]` → `[]` (no statement); `'src/missing.ts'` with `[1, 2]` → `[1, 2]`.
  - `mergeCoverage` of two parses where line 2's statement has hits 0 and 4 gives `uncoveredLines(…, [2])` → `[]`.
  - `coverageTotals(parse, [])` → `{ line: 66.7, branch: 50 }` (test file excluded), and `coverageTotals(new Map(), [])` → `{ line: 100, branch: 100 }`.
- [ ] **Step 3: Run them.** Expected: FAIL. **Step 4: Implement.** **Step 5: Run them.** Expected: PASS.
- [ ] **Step 6: Commit.** `feat: read istanbul coverage into position-keyed spans`

---

### Task 8: Coverage runs

**Files:**
- Create: `src/adapters/node/coverage.ts`
- Modify: `src/runTests.ts`, `src/coverage.ts`, `src/types.ts` (`TestRun.coverage`), `package.json` (dev dependency `@vitest/coverage-v8@5.0.5`, script `"coverage": "vitest run --coverage"`)
- Test: `tests/adapters/node/coverage.test.ts`, `tests/runTests.test.ts`, `tests/coverage.test.ts`

**Interfaces:**
- Consumes: `parseIstanbul`, `mergeCoverage` (Task 7), `appendArgs` (Task 2).
- Produces:
  - `withCoverage(runner: Runner, command: string, outDir: string): string`. In each case the output is `<outDir>/coverage-final.json`.
    - vitest: `appendArgs(command, ['--coverage.enabled', '--coverage.reporter=json', '--coverage.reportsDirectory=<outDir>', '--coverage.thresholds.autoUpdate=false'])`
    - jest: `appendArgs(command, ['--coverage', '--coverageReporters=json', '--coverageDirectory=<outDir>'])`
    - mocha: `npx --no c8 --reporter=json --report-dir=<outDir> --temp-directory=<outDir>/tmp <command>`
  - `runTests(root: string, pkg: PackageConfig, opts: { coverage?: boolean } = {}): Promise<TestRun>`. The reporter arguments are appended first, then `withCoverage` wraps the result, so mocha's c8 prefix wraps the reporter arguments too. Coverage goes into a sibling of the report file in the same temp dir. `coverage` is set only when the runner is known and the file parses.
  - `interface CoverageRun { ok: boolean; coverage: Coverage; detail: string }`
  - `measureCoverage(root: string, packages: PackageConfig[]): Promise<CoverageRun>` runs each package with coverage and merges the results. `ok` is true only when every run passed and produced coverage. Otherwise `detail` names the first failure as `<dir>: tests failed: <last 20 output lines>` or `<dir>: no coverage report`.

- [ ] **Step 1: Write the failing tests**
  - `withCoverage` (`test.each`): vitest on `npm run test -- --reporter=json`, jest on `npx jest`, and mocha on `npm run test`, with outDir `/t`. Each gives the exact string from the rules above.
  - `runTests` with coverage on a real vitest temp repo. `src/a.ts` has `export function sign(x: number) {` / `  if (x > 0) return 'pos';` / `  return 'neg';` / `}`, and a test calls `sign(1)`. Expected: `uncoveredLines(run.coverage!, 'src/a.ts', [1, 2, 3, 4])` contains 3 and not 1.
  - `measureCoverage` with two real vitest packages `packages/a` and `packages/b`, each testing its own file. Expected: `ok: true`, and `coverage` has `packages/a/src/a.ts` and `packages/b/src/b.ts`.
  - `measureCoverage` failures (`test.each`): a failing test gives `detail` starting `packages/a: tests failed:`; runner `jest` with command `echo ok` gives `.: no coverage report`.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement**, and add the dev dependency and the `coverage` script. **Step 4: Run them.** Expected: PASS. `npm run lint` (knip) is clean, and `npm run coverage` runs.
- [ ] **Step 5: Commit.** `feat: run test suites with coverage`

---

### Task 9: Temporary tool provisioning

**Files:**
- Create: `src/adapters/node/tools.ts`
- Modify: `src/git.ts`, `src/adapters/node/coverage.ts`
- Test: `tests/adapters/node/tools.test.ts`, `tests/adapters/node/coverage.test.ts`, `tests/git.test.ts`

**Interfaces:**
- Consumes: `pmCommand` (Task 5), `runCommand`.
- Produces:
  - `Git.discard(files: string[]): Promise<void>` restores the tracked files among `files` to HEAD and deletes the untracked ones. It is a no-op for `[]`.
  - `interface Tool { name: string; spec: string }`, in `tools.ts`.
  - `installedVersion(root: string, pkgDir: string, name: string): Promise<string | undefined>` reads `node_modules/<name>/package.json`. It looks in `pkgDir`, then each parent directory up to the repo root, and stops there.
  - `coverageTool(root: string, pkg: PackageConfig): Promise<Tool | null>`, in `adapters/node/coverage.ts`:
    - vitest: `null` if `@vitest/coverage-v8` or `@vitest/coverage-istanbul` is installed. Otherwise `{ name: '@vitest/coverage-v8', spec: '@vitest/coverage-v8@<installed vitest version>' }`, or no `@version` when vitest isn't found.
    - jest: `null`, because coverage is built in.
    - mocha: `null` if `c8` is installed, otherwise `{ name: 'c8', spec: 'c8' }`.
  - `installTools(root: string, git: Git, pkg: PackageConfig, tools: Tool[]): Promise<void>`
    1. Run `pmCommand(root, pm, 'add', specs)` in the package dir, with a 10-minute timeout.
    2. Always discard every file that is changed now but wasn't before.
    3. Throw `Couldn't install <specs> in <dir>: <reason>`. The reason is either the last 20 stderr lines or `<name> isn't in node_modules afterwards (Yarn Plug'n'Play isn't supported)`.
  - `removeTools(root: string, git: Git, pkg: PackageConfig, names: string[]): Promise<void>` runs `pmCommand(…, 'remove', names)` with the same discard step, and throws on a non-zero exit.

- [ ] **Step 1: Write the failing tests.** The tools tests use real npm, offline. The temp repo has:
  - `package.json` with no dependencies
  - a `package-lock.json` made by `npm install --package-lock-only` during setup, before the initial commit
  - `.gitignore` with `node_modules/`
  - a tracked local tool `tools/fake-cov/package.json` with `{"name":"fake-cov","version":"1.0.0"}`

  Tests:
  - `Git.discard(['a.ts', 'new.ts'])` restores modified `a.ts` and deletes untracked `new.ts`, while leaving modified `b.ts` alone.
  - `installTools(…, [{ name: 'fake-cov', spec: 'file:./tools/fake-cov' }])`: `installedVersion(root, '.', 'fake-cov')` is `'1.0.0'`, `git status --porcelain` is empty, and `package.json` and `package-lock.json` are byte-identical to before.
  - Then `removeTools(…, ['fake-cov'])`: `node_modules/fake-cov` is gone, and the tree is clean.
  - Spec `file:./tools/missing` rejects with `Couldn't install file:./tools/missing in .`, and the tree is clean.
  - Name `other-name` with spec `file:./tools/fake-cov` rejects with `other-name isn't in node_modules afterwards` (Review Focus 1), and the tree is clean.
  - `coverageTool` (`test.each`, with `node_modules/<name>/package.json` stubs written under the temp root):
    - vitest 5.0.5 alone → `@vitest/coverage-v8@5.0.5`
    - vitest with `@vitest/coverage-istanbul` → `null`
    - jest → `null`
    - mocha without `c8` → `{ name: 'c8', spec: 'c8' }`
    - mocha with `packages/a` and `c8` in the root `node_modules` → `null`
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: install coverage tools temporarily and restore what the install changed`

---

### Task 10: Coverage, skipped passes and tools in the report

**Files:**
- Modify: `src/types.ts` (Task 10 types), `src/runlog.ts`, `src/metrics/collect.ts`, `src/report.ts`, `src/commands/run.ts` (pass `coverage: null` for now)
- Test: `tests/report.test.ts`, `tests/metrics/collect.test.ts`

**Interfaces:**
- Produces:
  - `newRunLog()` includes `installed: []` and `skipped: []`.
  - The `collectMetrics` parameter `testInfo` gains `coverage: Metrics['coverage']`, which is copied into the result.
  - `renderReport`:
    - Coverage row, right after the test-suite time row: `| Coverage (line / branch) | 71.2% / 60.0% | 74.0% / 61.5% | +2.8 / +1.5 pts |`. If either side is `null`, that cell shows `n/a` and the change shows `n/a`. An unchanged value shows `±0`.
    - `## Passes skipped` comes after Rolled back. Each line is ``- `<dir>`: <categories joined by ', '> skipped: <reason>``.
    - The "Not changed: possibly unused or unverified" section lists both `possibly-unused` and `unverified` findings.
    - `## Tools installed for this run` comes before Cost. It opens with `Removed afterwards; manifests and lockfiles were restored.`, then lists `- <entry>` for each `log.installed` entry. With no entries it shows `None.`.

- [ ] **Step 1: Write the failing tests**
  - The coverage row for `{71.2, 60}` → `{74, 61.5}` is exactly the row above. For `null` → `{50, 50}` it is `| Coverage (line / branch) | n/a | 50.0% / 50.0% | n/a |`.
  - A log with `skipped: [{ pkgDir: 'packages/a', categories: ['test-writing', 'simplify'], reason: 'no coverage report' }]` renders ``- `packages/a`: test-writing, simplify skipped: no coverage report``.
  - An `unverified` finding appears under "Not changed".
  - `installed: ['c8 in packages/a']` renders the Tools installed section with `- c8 in packages/a`.
  - `collectMetrics(…, { testCount: 1, durationMs: 1, coverage: { line: 50, branch: 100 } })` returns that coverage.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: show coverage, skipped passes and installed tools in the report`

---

### Task 11: Provision, measure and degrade in a run

**Files:**
- Create: `tests/helpers/fakeJest.mjs`
- Modify: `src/commands/run.ts`, `src/passes/deadCode.ts`
- Test: `tests/commands/run.test.ts`, `tests/passes/deadCode.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 7–10.
- Produces:
  - `RunDeps.coverageTool?: (pkg: PackageConfig) => Promise<Tool | null>`, defaulting to `coverageTool(root, pkg)`. It is the seam for the network install, just as `findDeadCode` is the seam for knip.
  - `tests/helpers/fakeJest.mjs`, run as `node <path>`:
    - It writes a passing jest-shaped report for `tests/a.test.ts > a` to `--outputFile=`.
    - With `--coverageDirectory=<d>`, it turns the repo's tracked `fake-coverage.json` (istanbul keyed by repo-relative paths) into `<d>/coverage-final.json` keyed by absolute paths.
    - If the repo has a tracked `fake-stray` file, a coverage run also writes `coverage/x.json` into the cwd.
- `runMrsNorris` order, with every step after the dirty-tree check:
  1. **Provision.** For each package with a runner, call `deps.coverageTool`. If it returns a tool, `installTools` it and push `<spec> in <dir>` to `log.installed`. If the install fails, the package has no coverage.
  2. **Baseline** (unchanged), with the Task 2 fallback.
  3. **Measure coverage per package.** Use `measureCoverage(root, [pkg])` for each package that still has a runner after the baseline and whose provisioning didn't fail.
     - If `git.changedFiles()` is then non-empty, discard those files. The package has no coverage, with reason `coverage run changed files in the repo: <files>`.
     - Packages that pass make up `coveragePackages`.
     - `before.coverage` is `coverageTotals(merged, config.ignore)`, or `null` when `coveragePackages` is empty.
  4. **Record each package without coverage** as `log.skipped` with the enabled subset of `['test-writing', 'simplify']` (nothing if that subset is empty) and print the line. The reason is one of:
     - `test runner not recognised`
     - `per-test results unavailable`
     - the install error
     - the `measureCoverage` detail
     - the stray-files reason
  5. **Passes** (unchanged).
  6. **Measure "after" coverage.** After the final runs, `after.coverage` is the totals of `measureCoverage(root, coveragePackages)` when it is `ok`, and `null` otherwise.
  7. **Remove tools exactly once, on every exit path:** success, error and signal. This happens after the checkout is back on the original branch, using an unpinned `new Git(root)`. If the branch was never created, it happens straight away. A failed removal prints ``Couldn't remove <names> from <dir>: <error>. Run `<pm> install` to resync node_modules with your lockfile.``
- Dead-code pass: when `findDeadCode(pkg)` throws, it records `{ pkgDir, categories: ['dead-code'], reason: 'knip failed: <message>' }` in `log.skipped` and moves on to the next package.

- [ ] **Step 1: Write the failing tests**
  - Default run, runner `null`: `summary.log.skipped` equals `[{ pkgDir: '.', categories: ['test-writing', 'simplify'], reason: 'test runner not recognised' }]`, and `before.coverage` is `null`.
  - Runner `jest` with test `node <fakeJest>`, `only: ['comments']`, and `fake-coverage.json` giving `src/a.ts` two statements on lines 1 and 2 with hits 1 and 0. Expected: `before.coverage` is `{ line: 50, branch: 100 }`, and so is `after.coverage`.
  - The same setup plus a tracked `fake-stray` (Review Focus 2). Expected: the skipped reason is `coverage run changed files in the repo: coverage/x.json`, the comment change is still committed, and `git status --porcelain` on `main` is empty after the run.
  - npm repo (Task 9 setup) with `coverageTool: async () => ({ name: 'fake-cov', spec: 'file:./tools/fake-cov' })`, `only: ['comments']`, and runner `jest` via fakeJest. After the run:
    - `node_modules/fake-cov` doesn't exist
    - `git diff main <branch> --name-only` lists neither `package.json` nor `package-lock.json`
    - the report lists `- file:./tools/fake-cov in .`
  - The same with a test command that fails at baseline (Review Focus 4). Expected: rejects with `Baseline is not green`, `node_modules/fake-cov` doesn't exist, and `package.json` is byte-identical.
  - Dead-code pass with `findDeadCode` throwing `new Error('boom')`. Expected: `log.skipped` contains `{ pkgDir: '.', categories: ['dead-code'], reason: 'knip failed: boom' }`, and the pass returns normally.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS. Existing run tests that assert printed lines may need the new skip line.
- [ ] **Step 5: Commit.** `feat: provision coverage tools, measure coverage and degrade per package`

---

### Task 12: The simplification pass

**Files:**
- Create: `src/diff.ts`, `src/passes/simplify.ts`
- Modify: `src/git.ts`, `src/adapters/node/publicSurface.ts`, `src/passes/context.ts`, `src/passes/comments.ts`, `src/commands/run.ts`
- Test: `tests/diff.test.ts`, `tests/adapters/node/publicSurface.test.ts`, `tests/passes/simplify.test.ts`, `tests/commands/run.test.ts`

**Interfaces:**
- Consumes: `uncoveredLines`, `CoverageRun` (Tasks 7–8), `countLines` (`src/metrics/lines.ts`), `applyAndVerify` via `ctx.verify`.
- Produces:
  - `Git.stagedDiff(file: string): Promise<string>`, which is `git diff --cached -- <file>`.
  - `changedLines(diff: string): { before: number[]; after: number[] }`. It walks each hunk body: `-` lines are old-file line numbers, `+` lines are new-file line numbers, and context lines advance both.
  - `exportedNames(source: string, fileName: string): string[]` returns names exported by the file, sorted and unique, using the TS parser:
    - declarations with `export`
    - `default`
    - `export { a as b }` gives `b`
    - `export * from './m'` gives `*:./m`
  - In `context.ts`:
    - `styleRules(style: string[]): string`. It returns `''` for none. Otherwise it returns `\n\nThese style rules from .mrs-norris/config.yaml take precedence over the repository's own conventions:\n- …`. The comment pass switches to it.
    - `PassContext` gains `coveragePackages: PackageConfig[]`, `measureCoverage: () => Promise<CoverageRun>` and `writeTests: boolean`. `run.ts` sets them: `measureCoverage` is `() => measureCoverage(root, coveragePackages)`, and `writeTests` is whether `test-writing` is enabled.
  - `runSimplifyPass(ctx: PassContext): Promise<void>`, registered as `PASSES.simplify`.
    - `run.ts` stops listing `test-writing` as unavailable.
    - When `test-writing` is enabled without `simplify`, the run prints `test-writing only writes tests for code the simplify pass is about to change; enable simplify to use it.`

**Pass flow:**
1. **Files:** tracked files where `isSourceFile && !isTestFile && isEditable`, whose package (longest `dir` prefix in `config.packages`) is in `coveragePackages`. Stop if there are none.
2. **Coverage:** `let coverage = await ctx.measureCoverage()`. If it isn't `ok`, record `log.skipped` for every coverage package (`['simplify']`, plus `'test-writing'` when `writeTests`) with reason `coverage run failed on the branch: <detail>`, and return.
3. **Targets:** per file, call `ctx.agent.judge(targetsPrompt, TargetsSchema)`. A judge error becomes an `unverified` finding with note `Claude: error: <message>`.
   - `TargetsSchema = z.object({ targets: z.array(z.object({ symbol: z.string(), startLine: z.number().int(), endLine: z.number().int(), idea: z.string() })), testFile: z.string() })`
   - Drop targets whose range falls outside the file, whose `symbol` repeats, or that overlap a target already kept. Then process the rest by descending `startLine`, so earlier ranges don't shift.
4. **Uncovered target:** if `uncoveredLines(coverage, file, range)` is non-empty and `!ctx.writeTests`, record an `unverified` finding with note ``\`<symbol>\` (lines a–b) isn't covered by tests: lines <first 10, comma-separated>`` and move on. The `writeTests` branch is added in Task 13.
5. **Simplify** with `ctx.verify(change, edit, proof)`:
   - Id: `changeId('simplify', file, symbol)`
   - Title: ``Simplify `<symbol>` in <file>``
   - Reason: the `idea`
   - `allowedPaths`: `[file]`
   - On commit, `coverage` becomes the proof's fresh coverage.
6. **Proof**, cheapest check first. Each check fails with the reason shown:
   1. `changedLines(stagedDiff)`. Uncovered `before` lines in the current `coverage` → `changed lines not covered by tests: <lines>`.
   2. More code lines (`countLines(...).code`) than before → `the simplification made the code longer`.
   3. For a public file with `allowPublicApiChanges` false, any change in `exportedNames` → `changed the public exports of a library file`.
   4. `ctx.agent.judge(reviewPrompt(diff), ReviewSchema)` where `ReviewSchema = z.object({ preservesBehavior: z.boolean(), clearer: z.boolean(), reason: z.string() })`. Either false, or a thrown error → `review: <reason or error>`.
   5. `ctx.measureCoverage()` not ok → `tests failed with coverage: <detail>`. Uncovered `after` lines in the fresh coverage → `new lines not covered by tests: <lines>`.

**Prompts.** Write the wording yourself. Each prompt must say:
- **Targets prompt:**
  - the file with line numbers
  - the §4.4 list: merge duplicated logic within the file; remove needless abstractions, wrappers, indirection, and defensive code that can't trigger; shorten verbose code
  - clearer, not just shorter
  - behavior must not change
  - non-overlapping ranges, each `symbol` unique in the file
  - an empty `targets` list when nothing is worth changing
  - `testFile`: where tests for this file belong under the repo's existing layout and naming, an existing file if one already tests it
- **Edit prompt:**
  - the symbol, its lines and the idea
  - preserve behavior for every input: return values, thrown errors and their messages, side effects and their order, async timing
  - change only that region, plus the imports it needs
  - keep exported names and signatures
  - match the surrounding conventions
  - no clever one-liners or cramming
  - `styleRules(config.style)`
- **Review prompt:**
  - the staged diff
  - the two questions, with "clearer" meaning a reader understands it faster, not that it has fewer characters

- [ ] **Step 1: Write the failing tests**
  - `changedLines` on a real `git diff` with one modified line (old 3 becomes new 3), one deleted line (old 7), and a pure insertion after old line 9. Expected: `{ before: [3, 7], after: [3, 9] }`.
  - `exportedNames` for `export function a() {}; export default 1; export { c as d }; export * from './m';` is `['*:./m', 'a', 'd', 'default']`.
  - `tests/passes/simplify.test.ts` uses:
    - a real `Git` and `applyAndVerify`, with runner `null` and `node check.js` as in `verify.test.ts`
    - a `ScriptedAgent` whose `judge` answers by prompt (targets or review) and whose `edit` rewrites the file
    - a `measureCoverage` stub that serves queued `CoverageRun`s built with Task 7's types. Coverage measurement is a process boundary, like `findDeadCode`.

    Tests:
    - A covered verbose `isEven` (an `if`/`else` returning `true`/`false`, 7 lines) rewritten as `return n % 2 === 0;` is committed with subject ``mrs-norris(simplify): Simplify `isEven` in src/a.ts``. Its message body contains the idea.
    - Proof failures (`test.each`), each rolled back with the detail shown:
      - the edit also changes an uncovered line outside the target → `changed lines not covered by tests: 12`
      - the rewrite adds a line → `the simplification made the code longer`
      - a library public file whose rewrite renames an export → `changed the public exports of a library file`
      - the review answers `clearer: false, reason: 'cramming'` → `review: cramming`
      - the fresh coverage marks the new line 0-hit → `new lines not covered by tests: 2`
      - the fresh `CoverageRun` has `ok: false, detail: 'x'` → `tests failed with coverage: x`
    - An uncovered target with `writeTests: false` gives an `unverified` finding and no `edit` call.
    - Two targets (lines 2–4 and 8–10), one beyond EOF, and one repeated symbol. Expected: edits run for 8–10, then 2–4, and only those.
    - `config.style = ['Prefer early returns.']` appears in the edit prompt after `take precedence over the repository's own conventions`.
    - The first `measureCoverage` returns `ok: false, detail: 'x'`. Expected: `log.skipped` has `coverage run failed on the branch: x`, and the agent isn't called.
    - Run: `only: ['test-writing']` prints the enable-simplify line, and no longer prints `Skipping test-writing`.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS. Add the three new `PassContext` fields to the existing pass tests' contexts.
- [ ] **Step 5: Commit.** `feat: simplify covered code under the coverage rule`

---

### Task 13: Write tests before simplifying uncovered code

**Files:**
- Modify: `src/passes/simplify.ts`
- Test: `tests/passes/simplify.test.ts`

**Interfaces:**
- Consumes: Task 12's pass, and `isTestFile`, `isSourceFile`, `matchesAny` and `PROTECTED_DOCS`.
- Produces: the `writeTests` branch of step 4 in the pass flow. It applies when a target is uncovered and `ctx.writeTests` is set.
  1. **Validate `testFile` once per file.** It must be a normalised relative path with no `..`, and pass `isTestFile && isSourceFile`. It must belong to the same package as the source file and must not match `[...config.ignore, ...PROTECTED_DOCS]`. If it fails, record an `unverified` finding ``\`<symbol>\` isn't covered by tests, and Claude proposed <testFile>, which isn't a test file in <dir>``, then skip the target.
  2. **Write the tests** with `ctx.verify`:
     - Id: `changeId('test-writing', file, symbol)`
     - Title: ``Add tests for `<symbol>` in <file>``
     - Reason: ``Pins the current behavior of `<symbol>` before it is simplified (<simplify id>).``
     - `allowedPaths`: `[testFile]`
     - Edit prompt: write tests in `testFile` that pin the current behavior of `symbol` (lines a–b, uncovered lines listed) and pass against the current code. Cover every branch in those lines. Test through the module's exports, mock minimally, and parametrize instead of copy-pasting. Use the framework, style and naming of the existing tests. Don't touch `file`. Include `styleRules`.
     - Proof: `measureCoverage()` not ok → `tests failed with coverage: <detail>`. Any remaining `uncoveredLines(fresh, file, range)` → ``the new tests leave lines <lines> of `<symbol>` uncovered``.
  3. **If the tests are committed,** `coverage` becomes the proof's fresh coverage. The simplify reason gets `\n\nDepends on <test id>, which added the tests that cover it.`
  4. **If they aren't committed,** record an `unverified` finding ``\`<symbol>\` isn't covered by tests, and the tests written for it were rolled back``. No simplification is attempted.

- [ ] **Step 1: Write the failing tests**
  - An uncovered target, and an `edit` that writes `tests/a.test.ts` when the prompt says `Add tests`, then simplifies. The coverage stub returns the target covered after the test run. Expected:
    - commit subjects, oldest first: ``mrs-norris(test-writing): Add tests for `label` in src/a.ts`` then ``mrs-norris(simplify): Simplify `label` in src/a.ts``
    - the simplify body contains `Depends on mn-`, followed by the test-writing id
    - the test-writing body names the simplify id
  - The fresh coverage still marks line 3 uncovered. Expected: the test change rolls back with ``the new tests leave lines 3 of `label` uncovered``, an `unverified` finding is recorded, and no simplify edit runs.
  - Review Focus 5 (`test.each` over `testFile`): `src/b.ts` (not a test file), `packages/other/a.test.ts` (another package), `tests/fixtures/a.test.ts` (ignored) and `../a.test.ts`. Each gives the "which isn't a test file in" finding and no `edit` call.
  - `config.style` appears in the test-writing prompt.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: write tests that pin uncovered code before simplifying it`

---

### Task 14: End to end on the bloated fixture, and close out the follow-ups

**Files:**
- Modify:
  - `tests/fixtures/bloated-app/`: add `.gitignore` (`node_modules/`) and `src/format.ts`; change `src/math.ts`, `src/index.ts` and `tests/math.test.ts`
  - `tests/e2e.test.ts`
  - `docs/superpowers/plans/2026-10-16-mrs-norris-plan-1-followups.md`
- Test: `tests/e2e.test.ts`

**Interfaces:**
- Consumes: the whole run.

- [ ] **Step 1: Extend the fixture.**
  - `src/math.ts` gains a verbose `isEven`: `if (n % 2 === 0) {` / `return true;` / `} else {` / `return false;` / `}`. `tests/math.test.ts` covers both branches with `test.each([[2, true], [3, false]])`.
  - New `src/format.ts`: `export function label(n: number) {` / `const text = String(n);` / `const result = \`#${text}\`;` / `return result;` / `}`. It has no tests. `src/index.ts` imports and logs it, so knip treats it as used.
  - In `copyFixture`, symlink `node_modules/vitest` and `node_modules/@vitest/coverage-v8` to this repo's copies. `coverageTool` then returns `null`, so the test needs no network.
- [ ] **Step 2: Write the failing expectations.** The scripted agent:
  - answers the targets judge for `src/format.ts` with `label` (lines 1–5, testFile `tests/format.test.ts`) and for `src/math.ts` with `isEven`
  - approves every review
  - writes `tests/format.test.ts` for an `Add tests` prompt
  - rewrites `label` to `return \`#${n}\`;` and `isEven` to `return n % 2 === 0;`

  Expected:
  - The commit list gains, after the existing four:
    - ``mrs-norris(test-writing): Add tests for `label` in src/format.ts``
    - ``mrs-norris(simplify): Simplify `label` in src/format.ts``
    - ``mrs-norris(simplify): Simplify `isEven` in src/math.ts``
  - The report contains `| Coverage (line / branch) |`.
  - `summary.before.coverage!.line` is below the after line coverage (narrow `summary.end` with `'after' in summary.end`).
  - The branch's own vitest run is green.
- [ ] **Step 3: Run it.** `npx vitest run tests/e2e.test.ts`. Expected: FAIL until the fixture and expectations agree, then PASS. Don't change `src/` here. A failure in `src/` points back to the task that owns that code.
- [ ] **Step 4: Update the follow-ups doc.**
  - Remove the "Before or during Plan 2" items this plan closed, and keep the false "checkout moved" item.
  - Add new open items:
    - cross-file simplification
    - affected-test selection, since every proof now runs every coverage suite
    - real pnpm and yarn runs of `pmCommand`, which are still unverified
- [ ] **Step 5: Verify.** `npm test && npm run typecheck && npm run lint` are all clean.
- [ ] **Step 6: Commit.** `test: cover test writing and simplification end to end`

**Manual checks before the first real use.** These need an API key or other package managers, so they aren't part of `npm test`:
- `MRS_NORRIS_LIVE=1 npx vitest run tests/agent/claude.live.test.ts`
- A real run on a small pnpm repo and a small yarn Berry repo. Confirm that the coverage tool installs, `git status` stays clean, and the tool is gone afterwards.
