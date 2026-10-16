# mrs-norris — Plan 1: Foundation and first cleanups (TS/JS)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `npx mrs-norris` for TypeScript/JavaScript repos that runs a safe baseline, removes dead code and unused dependencies, trims redundant comments, commits each verified change on its own branch, and writes a before/after report.

**Architecture:** A TypeScript CLI (commander). Language-specific work sits behind a Node adapter (detection, test reporting, knip, comment and token analysis). A generic verification loop applies each change, checks that it only touched allowed files, runs any extra proof plus type-check, lint and tests, then commits with a `Mrs-Norris-Change-Id` trailer or rolls back. Claude is reached through a small `Agent` interface, so tests use a scripted fake.

**Tech Stack:** Node.js ≥22, TypeScript (strict, ESM), commander, zod, yaml, execa, fast-glob, picomatch, typescript (compiler API, used at runtime), knip, @anthropic-ai/claude-agent-sdk, @inquirer/prompts. Tests: vitest. Dev runner: tsx.

**Spec:** `docs/superpowers/specs/2026-10-16-mrs-norris-design.md`

## Scope of this plan and the roadmap

The spec covers several large subsystems, so it is split into five plans. Each one produces working, shippable software. This is Plan 1.

| Plan | Delivers |
|---|---|
| **1 (this)** | CLI, config and `init`, git safety, baseline and flaky detection, metrics, Agent wrapper, verification loop, **dead-code and dependency pass**, **comment pass**, report, monorepo detection, `[paths]`/`--since`/`--only`/`--model`. TS/JS only. |
| 2 | Temporary tool provisioning with manifest/lockfile restore (§5.6), coverage measurement, **test-writing pass** (§4.3), **simplification pass** (§4.4) with the coverage rule (§5.2), style overrides, coverage in the report, graceful degradation (§5.7). |
| 3 | Stryker mutation scoping, **test pruning and merging** with the strict rule (§5.3), affected-test selection for speed. |
| 4 | Python adapter: uv/poetry detection, pytest JSON results, vulture and deptry, coverage.py, mutmut, Python comment rules (docstrings never removed), Python token equality. |
| 5 | Memory (`rejected.yaml`, `mrs-norris reject`, automatic rejection detection), `--interactive`, resumability (§5.8), npm release (name check, MIT, README polish). |

Until Plans 2 to 5 land, the enabled categories `test-writing`, `simplify` and `test-pruning` are accepted in the config but skipped at run time.

## Global Constraints

- Node.js `>=22` (`engines` in package.json). ESM only (`"type": "module"`). TypeScript `strict: true`.
- npm package name `mrs-norris`, bin name `mrs-norris`, license MIT.
- Auth comes only from `ANTHROPIC_API_KEY`.
- Config lives at `.mrs-norris/config.yaml`. `.mrs-norris/.gitignore` contains `reports/` and `state.json`.
- Reports are written to `.mrs-norris/reports/<YYYYMMDD-HHmmss>.md`.
- Work happens on branch `mrs-norris/<YYYY-MM-DD-HHmm>` created from the current HEAD. The user's branch is never committed to. At the end of the run, and on error or Ctrl-C, the user is returned to their original branch with a clean tree.
- Each change is one commit, with this message format:
  `mrs-norris(<category>): <title>` + blank line + `<reason>` + blank line + `Mrs-Norris-Change-Id: <id>`
- Change ids are `mn-` + the first 10 hex characters of `sha256("<category>|<file>|<symbol or ''>")`.
- Standalone doc files are never edited: `**/*.md`, `**/*.mdx`, `**/*.rst`, `docs/**`.
- Tests must pass at baseline, or the run stops before creating a branch.
- The default model is `claude-opus-5-5`, overridable with `--model` or `model:` in the config.
- Categories, in run order: `dead-code`, `comments`, `test-writing`, `simplify`, `test-pruning`.
- Dead code is removed only with **triple agreement**: knip flags it, Claude judges it unused with `confidence: "high"`, and a repo-wide fixed-string, whole-word search finds no reference outside its own file. Anything else becomes a report finding.

## Review Focus

1. **The test command doesn't produce a JSON report** (for example, `npm test` runs lint first or wraps the runner). Expected: the run doesn't crash. It falls back to exit-code-only results and tells the user how to fix their config. Tested in Task 6 and Task 7.
2. **Dirty tree, or a branch-name collision when two runs happen in the same minute.** Expected: a clear refusal for the dirty tree, and a `-2` suffix for the branch. Tested in Task 2 and Task 15.
3. **Claude edits files outside the change** (another file, or a new file). Expected: the change is rolled back and logged as rolled back. Tested in Task 10.
4. **Crash or Ctrl-C mid-run.** Expected: the uncommitted change is rolled back and the user is back on their original branch with a clean tree. Tested in Task 15.
5. **Claude or network errors mid-change, or a missing API key.** Expected: a missing key fails fast before any baseline work. A failing call rolls back only that change, and the run continues. Tested in Task 10 and Task 15.

---

## Shared types

Task 1 creates `src/types.ts` with these definitions. Later tasks import them and do not redefine them.

```ts
export const CATEGORIES = ['dead-code', 'comments', 'test-writing', 'simplify', 'test-pruning'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Runner = 'jest' | 'vitest' | 'mocha';
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export interface PackageCommands { test: string; typecheck?: string; lint?: string }
export interface PackageConfig {
  name: string; dir: string;            // repo-relative, '.' for root
  language: 'typescript' | 'javascript';
  runner: Runner | null; packageManager: PackageManager;
  commands: PackageCommands;
}
export interface PublicSurface { isLibrary: boolean; files: string[] } // repo-relative

export interface TestResult { id: string; file: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number }
export interface TestRun { ok: boolean; results: TestResult[]; durationMs: number; reportMissing: boolean; output: string }

export interface DeadCodeCandidate { kind: 'file' | 'export' | 'dependency'; pkgDir: string; file: string; symbol?: string; line?: number }

export interface PlannedChange { id: string; category: Category; title: string; reason: string; allowedPaths: string[] }
export type ProofResult = { ok: true } | { ok: false; reason: string };
export interface ChangeRecord { id: string; category: Category; title: string; reason: string; files: string[];
  status: 'committed' | 'rolled-back' | 'skipped'; detail?: string; commit?: string }
export interface Finding { kind: 'possibly-unused' | 'public-export' | 'unverified'; category: Category; file: string; symbol?: string; note: string }
export interface RunLog { changes: ChangeRecord[]; findings: Finding[]; flaky: string[]; installed: string[] }

export interface Metrics { sourceLines: number; testLines: number; commentLines: number; testCount: number;
  testDurationMs: number; contextTokens: number; dependencies: number; coverage: null | { line: number; branch: number } }
export interface Usage { inputTokens: number; outputTokens: number; costUsd: number }
```

---

### Task 1: Project scaffold and CLI entry point

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE` (MIT, copyright "mrs-norris contributors"), `src/types.ts` (above), `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Produces: `src/cli.ts` exports `buildProgram(): Command`. Running the file executes `buildProgram().parseAsync(process.argv)`.

- [ ] **Step 1: Initialize git and the package.** Run `git init`, create `package.json` (name `mrs-norris`, version `0.1.0`, `type: module`, `bin: { "mrs-norris": "dist/cli.js" }`, `engines.node: ">=22"`, scripts `build: tsc`, `test: vitest run`, `typecheck: tsc --noEmit`), and install the dependencies listed in the Tech Stack. Use `tsconfig` settings `module/moduleResolution: NodeNext`, `target: ES2023`, `outDir: dist`, `rootDir: src`, `strict: true`. `.gitignore` contains `node_modules/`, `dist/`.

- [ ] **Step 2: Write the failing test** in `tests/cli.test.ts`

```ts
test('prints the package version', async () => {
  const { stdout } = await execa('npx', ['tsx', 'src/cli.ts', '--version']);
  expect(stdout.trim()).toBe('0.1.0');
});
```

- [ ] **Step 3: Run it.** `npx vitest run tests/cli.test.ts`. Expected: FAIL (src/cli.ts missing).
- [ ] **Step 4: Implement `buildProgram()`** with name `mrs-norris` and the version read from package.json.
- [ ] **Step 5: Run it.** Same command. Expected: PASS. `npm run typecheck` is clean.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "chore: scaffold mrs-norris CLI"`

---

### Task 2: Process runner and git helper

**Files:**
- Create: `src/exec.ts`, `src/git.ts`, `tests/helpers/tempRepo.ts`
- Test: `tests/git.test.ts`

**Interfaces:**
- Produces:
  - `runCommand(command: string, opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }>`. Runs through the shell. The default timeout is 30 minutes. It never throws on a non-zero exit.
  - `class Git` with `constructor(root: string)` and these methods:
    - `isClean(ignorePrefixes = ['.mrs-norris/']): Promise<boolean>`
    - `currentBranch(): Promise<string | null>` (null on detached HEAD)
    - `head(): Promise<string>`
    - `createBranch(name: string): Promise<string>`. Creates and checks out the branch. If `name` exists, it uses `name-2`, `name-3` and so on, and returns the name it used.
    - `checkout(ref: string): Promise<void>`
    - `changedFiles(): Promise<string[]>`. Modified, deleted and untracked files, repo-relative.
    - `commitAll(message: string): Promise<string>`. Returns the sha.
    - `rollback(): Promise<void>`. Runs `reset --hard HEAD` and `clean -fd`. Ignored files survive.
    - `trackedFiles(): Promise<string[]>`
    - `grepWord(term: string): Promise<{ file: string; line: number }[]>`. A fixed-string, whole-word search over tracked files (`git grep -n -F -w`). Returns an empty list when there are no matches.
    - `diffNames(since: string): Promise<string[]>`. Files changed in `since...HEAD`.
  - `makeTempRepo(files: Record<string, string>): Promise<string>` (test helper). Creates a temp directory, writes the files, runs `git init` with user.name/email set, and makes an initial commit.

- [ ] **Step 1: Write the failing tests** in `tests/git.test.ts`
  - `isClean` is true on a fresh repo, false after a tracked file is edited, and true when the only untracked file is `.mrs-norris/config.yaml`.
  - `createBranch('mrs-norris/x')` returns `'mrs-norris/x'`. After checking out main, a second call returns `'mrs-norris/x-2'`.
  - `changedFiles` lists one modified, one deleted and one untracked file.
  - `rollback` restores the modified file, removes the untracked file, and keeps a file matched by `.gitignore`.
  - After `commitAll('a\n\nMrs-Norris-Change-Id: mn-1')`, `git log -1 --format=%B` contains `Mrs-Norris-Change-Id: mn-1`.
  - `grepWord('get')` does not match a file containing only `getter`. `grepWord('$state')` matches a file containing `const $state = 1`.
  - `currentBranch()` returns null after `git checkout --detach`.
- [ ] **Step 2: Run them.** `npx vitest run tests/git.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `runCommand` and `Git`** using execa (`shell: true` for `runCommand`; argument arrays for the git calls).
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: add process runner and git helper`

---

### Task 3: Config file

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `CATEGORIES` and `PackageConfig` from `src/types.ts`.
- Produces:
  - `DEFAULT_MODEL = 'claude-opus-5-5'`
  - `DEFAULT_IGNORE`: `['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/vendor/**', '**/__generated__/**', '**/migrations/**', '**/fixtures/**', '**/*.min.js', '**/*.d.ts']`
  - `PROTECTED_DOCS`: `['**/*.md', '**/*.mdx', '**/*.rst', 'docs/**']`
  - `ConfigSchema` (zod) and `type Config = { version: 1; model: string; categories: Category[]; ignore: string[]; allowPublicApiChanges: boolean; style: string[]; packages: PackageConfig[] }`
  - `defaultConfig(packages: PackageConfig[]): Config`. Uses all categories, `DEFAULT_IGNORE`, `false`, and `[]`.
  - `loadConfig(root: string): Promise<Config | null>`
  - `saveConfig(root: string, config: Config): Promise<void>`. Writes `.mrs-norris/config.yaml` and `.mrs-norris/.gitignore` (`reports/\nstate.json\n`).

- [ ] **Step 1: Write the failing tests**
  - Round trip: `saveConfig` then `loadConfig` deep-equals the input.
  - `loadConfig` returns null when no file exists.
  - Invalid file (`categories: [cleanup]`): the error message contains `.mrs-norris/config.yaml` and `categories`.
  - `.mrs-norris/.gitignore` content equals `'reports/\nstate.json\n'`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** using `yaml` and zod. Format validation errors as `<path>: <issue>` lines, prefixed with the config file path.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: add config file schema`

---

### Task 4: Node project detection and public surface

**Files:**
- Create: `src/adapters/node/detect.ts`, `src/adapters/node/publicSurface.ts`
- Test: `tests/adapters/node/detect.test.ts`, `tests/adapters/node/publicSurface.test.ts`

**Interfaces:**
- Produces:
  - `detectNodePackages(root: string): Promise<Omit<PackageConfig, 'commands'>[]>`
  - `guessNodeCommands(root: string, pkg: Omit<PackageConfig, 'commands'>): Promise<PackageCommands>`. Sets `test: ''` when no test script exists.
  - `nodePublicSurface(root: string, pkgDir: string): Promise<PublicSurface>`

**Rules:**
- Package manager: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, otherwise npm.
- Workspaces: the root `package.json` `workspaces` field (an array, or `{ packages }`) or the `packages` list in `pnpm-workspace.yaml`. Globs expand to directories that contain a `package.json`. With no workspaces, the result is the root package alone (`dir: '.'`).
- Language is `typescript` if the package or root has a `tsconfig.json`, or `typescript` is in its deps.
- Runner: the first of `vitest`, `jest`, `mocha` found in the package's or root's dependencies/devDependencies. Otherwise `null`.
- Commands: `test` is `<pm> run test` if `scripts.test` exists. `typecheck` is `<pm> run typecheck` if that script exists; otherwise, for TypeScript, `npx tsc --noEmit`. `lint` is `<pm> run lint` if that script exists.
- A package is a library when `private !== true` and it has `exports`, `main` or `module`.
- Entry files: collect every string in `exports` (including nested conditions), `main`, `module` and `types`. For a path under `dist/`, `build/` or `lib/`, swap that prefix for `src/` and try the extensions `.ts .tsx .js .mjs`. Keep only files that exist.
- Surface files: the entry files plus everything reachable through `export … from '<relative>'` and `export * from '<relative>'`, followed recursively using regex parsing. Not set for non-libraries (`files: []`).

- [ ] **Step 1: Write the failing tests** (temp directories)
  - Single TS app with vitest and `scripts.test`: one package, `dir: '.'`, runner `vitest`, commands `{ test: 'npm run test', typecheck: 'npx tsc --noEmit' }`.
  - pnpm monorepo (`pnpm-workspace.yaml` with `packages/*`, packages `a` with jest and `b` with mocha): two packages with `dir`s `packages/a` and `packages/b`, the matching runners, and test command `pnpm run test`.
  - Package without a test script: `test === ''`.
  - Library (`exports: { ".": { import: "./dist/index.js" } }`, `src/index.ts` containing `export * from './util'`): `isLibrary: true`, `files: ['src/index.ts', 'src/util.ts']`.
  - `private: true` with `main`: `isLibrary: false`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** using fast-glob and yaml.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: detect node packages and public surface`

---

### Task 5: `mrs-norris init`

**Files:**
- Create: `src/commands/init.ts`, `src/io.ts`
- Modify: `src/cli.ts` (add the `init [--yes]` command)
- Test: `tests/commands/init.test.ts`

**Interfaces:**
- Consumes: Task 3 (`defaultConfig`, `saveConfig`) and Task 4 (detection).
- Produces:
  - `interface IO { print(msg: string): void; confirm(msg: string): Promise<boolean>; input(msg: string, defaultValue: string): Promise<string> }`
  - `consoleIO(): IO` (built on @inquirer/prompts)
  - `initProject(root: string, io: IO, opts: { yes: boolean }): Promise<Config>`

**Flow:**
1. Detect packages and guess their commands.
2. Print a table of package dir, runner, test, typecheck and lint.
3. With `yes`, or when `confirm('Use these commands?')` returns true, save. Otherwise call `input` once per command, using the guess as the default.
4. With `yes`, an empty test command throws: `No test command found for <dir>. Run \`mrs-norris init\` interactively or edit .mrs-norris/config.yaml.`
5. A package with `runner: null` prints a warning: `<dir>: test runner not recognised (supported: jest, vitest, mocha). mrs-norris will rely on the test command's exit code only.`

- [ ] **Step 1: Write the failing tests** (fake IO that records `print` calls and returns scripted answers)
  - `yes: true` on a vitest app writes a config whose `packages[0].commands.test` is `'npm run test'`.
  - Declining and then answering `'npx vitest run'` for test saves that value.
  - `yes: true` with no test script rejects with the message above.
  - A package with no runner causes a printed warning containing `not recognised`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement `initProject`, `consoleIO`, and the CLI wiring.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: add mrs-norris init`

---

### Task 6: Running tests with structured results

**Files:**
- Create: `src/adapters/node/testReport.ts`, `src/runTests.ts`, `tests/fixtures/reports/{vitest,jest,mocha}.json`
- Test: `tests/adapters/node/testReport.test.ts`, `tests/runTests.test.ts`

**Interfaces:**
- Produces:
  - `reporterArgs(runner: Runner, outFile: string): string[]`:
    - vitest → `['--reporter=json', '--outputFile=<outFile>']`
    - jest → `['--json', '--outputFile=<outFile>']`
    - mocha → `['--reporter', 'json', '--reporter-option', 'output=<outFile>']`
  - `appendArgs(command: string, args: string[]): string`. Commands starting with `npm run`, `npm test`, `pnpm run` or `pnpm test` get ` -- ` before the args. All others get a single space.
  - `parseTestReport(runner: Runner, raw: string, root: string): TestResult[]`. vitest and jest share the jest-shaped `testResults[].assertionResults[]` format (`fullName`, `status`, `duration`), with the file in `testResults[].name`. For mocha, `tests[]` gives `fullTitle`, `file` and `duration`; entries also in `failures[]` are `failed`, and those in `pending[]` are `skipped`. `id` is `<repo-relative file> > <full name>`.
  - `runTests(root: string, pkg: PackageConfig): Promise<TestRun>`. Runs in `<root>/<pkg.dir>` and writes the report to a temp file. `ok` is true when the exit code is 0. `reportMissing` is true when the runner is set but the report file wasn't created. `output` holds the last 200 lines of stdout and stderr combined.

- [ ] **Step 1: Capture a real vitest report** by running the repo's own vitest with `--reporter=json --outputFile` on a tiny two-test temp project, and save it to `tests/fixtures/reports/vitest.json`. Write `jest.json` and `mocha.json` by hand, following each runner's documented JSON reporter format, with one passed, one failed and one skipped test each.
- [ ] **Step 2: Write the failing tests**
  - `parseTestReport` for each fixture returns three results with statuses `passed`, `failed` and `skipped`, and ids in the form `tests/a.test.ts > suite works`.
  - `appendArgs('npm run test', ['--json'])` returns `'npm run test -- --json'`. `appendArgs('npx vitest run', ['--json'])` returns `'npx vitest run --json'`.
  - `runTests` on a temp vitest project (test command `<repo>/node_modules/.bin/vitest run`) returns `ok: true` and two passed results.
  - **(Review Focus 1)** `runTests` with runner `vitest` and test command `echo ok` returns `ok: true`, `reportMissing: true` and `results: []`.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them.** Expected: PASS.
- [ ] **Step 6: Commit.** `feat: run tests with structured results`

---

### Task 7: Baseline and flaky-test detection

**Files:**
- Create: `src/baseline.ts`
- Test: `tests/baseline.test.ts`

**Interfaces:**
- Consumes: `runTests` (Task 6) and `runCommand` (Task 2).
- Produces:
  - `interface Baseline { pkgDir: string; ok: boolean; failing: string[]; flaky: string[]; testCount: number; durationMs: number; problems: string[]; warnings: string[] }`
  - `runBaseline(root: string, pkg: PackageConfig, deps?: { runTests?: typeof runTests; runCommand?: typeof runCommand; runs?: number }): Promise<Baseline>`. The default `runs` is 2.

**Rules:**
- A test is `failing` if it failed in every run, and `flaky` if its status differed between runs.
- `testCount` is the number of distinct ids that aren't skipped. `durationMs` comes from the first run.
- When results are empty (no runner, or no report), only exit codes are used:
  - Mixed exit codes add the problem `Test suite passes only sometimes: <test command>`.
  - All runs failing adds `Tests fail at baseline: <test command>`.
- `reportMissing` adds the problem: `Couldn't read per-test results from \`<test>\`. Make sure it runs <runner> directly (or edit .mrs-norris/config.yaml). Continuing with exit codes only.` This goes in `warnings`, not `problems`, so it doesn't by itself make `ok` false.
- Typecheck and lint commands that exit non-zero add `Type-check fails at baseline: <cmd>` or `Lint fails at baseline: <cmd>`.
- `ok` is false if anything is failing or `problems` is non-empty.

- [ ] **Step 1: Write the failing tests** (stubbed `runTests` and `runCommand`)
  - Two identical passing runs give `ok: true`, `testCount: 2` and `flaky: []`.
  - Test `t1` fails in run 1 only, giving `flaky: ['t1']` and `ok: true`.
  - Test `t1` fails in both runs, giving `failing: ['t1']` and `ok: false`.
  - A failing typecheck gives `ok: false`, with a problem containing `Type-check fails at baseline`.
  - **(Review Focus 1)** `reportMissing` with exit codes 0 gives `ok: true`, with a warning containing `Continuing with exit codes only`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: baseline run with flaky detection`

---

### Task 8: Metrics

**Files:**
- Create: `src/metrics/classify.ts`, `src/metrics/lines.ts`, `src/metrics/collect.ts`
- Test: `tests/metrics/lines.test.ts`, `tests/metrics/collect.test.ts`

**Interfaces:**
- Consumes: `Git.trackedFiles`, `Baseline`, and `DEFAULT_IGNORE`/`PROTECTED_DOCS`.
- Produces:
  - `isSourceFile(path)`: the extensions `.ts .tsx .js .jsx .mjs .cjs .mts .cts`.
  - `isTestFile(path)`: matches `/(^|\/)(__tests__|tests?)\//` or `/\.(test|spec)\.[cm]?[jt]sx?$/`.
  - `isDocFile(path)`: matches `PROTECTED_DOCS`.
  - `matchesAny(path, globs)`: picomatch with `dot: true`.
  - `countLines(source: string, fileName: string): { code: number; comment: number; blank: number }`. Uses `ts.createScanner` comment ranges. A line holding only a comment counts as comment. A line with code and a trailing comment counts as code.
  - `collectMetrics(root: string, git: Git, config: Config, testInfo: { testCount: number; durationMs: number }): Promise<Metrics>`.
    - Excludes files matching `config.ignore` and lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`).
    - `contextTokens` is the sum of `Math.ceil(chars / 4)` over source, test and doc files.
    - `dependencies` counts the keys in `dependencies` and `devDependencies` across all package.json files of configured packages, plus the root.
    - `coverage` is `null` in this plan.

- [ ] **Step 1: Write the failing tests**
  - `countLines` on this snippet returns `{ code: 2, comment: 4, blank: 1 }`:
    ```ts
    // a
    /* b
       c */
    const x = 1; // trailing

    // d
    export { x };
    ```
  - `collectMetrics` on a temp repo (`src/a.ts` with 3 code lines and 1 comment line, `tests/a.test.ts` with 2 code lines, `README.md` with 40 characters, a package.json with 1 dep and 2 devDeps, and `dist/x.js` that must be ignored) returns `sourceLines 3`, `testLines 2`, `commentLines 1` and `dependencies 3`, plus `contextTokens` equal to the hand-computed value.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: collect repo metrics`

---

### Task 9: Agent interface, Claude implementation and scripted fake

Load the `claude-api` skill before starting this task, and check option names against the installed `@anthropic-ai/claude-agent-sdk` docs or types. Don't rely on memory for them.

**Files:**
- Create: `src/agent/types.ts`, `src/agent/claude.ts`, `src/agent/json.ts`, `tests/helpers/scriptedAgent.ts`
- Test: `tests/agent/json.test.ts`, `tests/agent/claude.live.test.ts`

**Interfaces:**
- Produces:
  - ```ts
    interface Agent {
      judge<T>(prompt: string, schema: z.ZodType<T>): Promise<T>;   // read-only: Read, Grep, Glob
      edit(prompt: string, opts: { allowedPaths: string[] }): Promise<void>; // Read, Edit, Write, Grep, Glob
      usage(): Usage;
    }
    ```
  - `createClaudeAgent(opts: { model: string; root: string }): Agent`. Uses `query()` from the SDK with `cwd: root`, the tool allow-lists above, and edit permissions auto-accepted for `edit`. The `edit` prompt always ends with `Only modify these files: <allowedPaths>. Do not create, delete or modify any other file.` Usage is accumulated from each result message (input tokens, output tokens, total cost in USD).
  - `judge` asks for a single JSON object matching `z.toJSONSchema(schema)`. On a parse or validation failure, it retries once with the error appended, then throws.
  - `parseJsonReply<T>(text: string, schema: z.ZodType<T>): T`. Accepts a fenced ```json block or a bare object. Throws with the zod issues.
  - `assertApiKey(env = process.env): void`. Throws `ANTHROPIC_API_KEY is not set. Get a key at https://console.anthropic.com and export it before running mrs-norris.`
  - `ScriptedAgent` (test helper) `implements Agent`. Its constructor takes `{ judge?: (prompt: string) => unknown; edit?: (prompt: string, opts: { allowedPaths: string[] }) => Promise<void> }` and records `prompts: string[]`. It throws `'ScriptedAgent: no <judge|edit> handler'` when a handler is missing. `usage()` returns `{ inputTokens: 10, outputTokens: 5, costUsd: 0.01 }` per call made.

- [ ] **Step 1: Write the failing tests**
  - `parseJsonReply` parses both fenced and bare input against `z.object({ unused: z.boolean() })`. Input `'{"unused":"yes"}'` throws, and the message mentions `unused`.
  - `assertApiKey({})` throws the message above. `assertApiKey({ ANTHROPIC_API_KEY: 'x' })` doesn't throw.
  - `claude.live.test.ts` is skipped unless `MRS_NORRIS_LIVE=1`. On a temp repo it checks that `judge` returns a schema-valid object and that `edit` changes only the allowed file.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS (the live test is skipped).
- [ ] **Step 5: Commit.** `feat: agent interface and Claude implementation`

---

### Task 10: Verification loop

**Files:**
- Create: `src/changeId.ts`, `src/runlog.ts`, `src/verify.ts`
- Test: `tests/verify.test.ts`

**Interfaces:**
- Consumes: `Git` (Task 2), `runTests` (Task 6), `runCommand` (Task 2), and the shared types.
- Produces:
  - `changeId(category: Category, file: string, symbol?: string): string`, per the Global Constraints.
  - `newRunLog(): RunLog`
  - `interface VerifyContext { root: string; git: Git; packages: PackageConfig[]; flaky: Set<string>; log: RunLog; runTests?: typeof runTests; runCommand?: typeof runCommand }`
  - `applyAndVerify(ctx: VerifyContext, change: PlannedChange, apply: () => Promise<void>, proof?: () => Promise<ProofResult>): Promise<ChangeRecord>`

**Algorithm:**
1. Run `apply()`. If it throws, roll back and return `rolled-back` with detail `error: <message>`.
2. Get the changed files. If there are none, return `skipped` with detail `no change produced`.
3. If any changed file isn't in `allowedPaths` and isn't under an allowed directory, roll back and return `rolled-back` with detail `touched files outside the change: <list>`.
4. If a proof was given and it isn't ok, roll back and return `rolled-back` with the proof's reason.
5. For every package, run typecheck, then lint, then tests. A typecheck or lint command with a non-zero exit, or test failures not in `flaky`, rolls back with detail `<typecheck|lint|tests> failed in <dir>: <first failing ids or last 20 output lines>`. With an empty `results`, a non-zero test exit counts as a failure.
6. Commit with the message format from the Global Constraints, and return `committed` with the sha.

Every record is also pushed to `ctx.log.changes`.

- [ ] **Step 1: Write the failing tests.** Use a temp repo whose test command is `node check.js`, where `check.js` exits 1 when `src/a.ts` contains `BROKEN`. Packages use `runner: null`.
  - A valid edit to `src/a.ts` is committed. The commit body equals `mrs-norris(comments): T\n\nR\n\nMrs-Norris-Change-Id: mn-…` and `git.isClean()` is true.
  - An edit that writes `BROKEN` is rolled back, the detail starts with `tests failed in .`, and the file content is restored.
  - **(Review Focus 5)** `apply` throwing `Error('network down')` is rolled back with detail `error: network down`.
  - **(Review Focus 3)** An edit that also creates `src/other.ts` is rolled back, the detail contains `src/other.ts`, and `src/other.ts` no longer exists.
  - An `apply` that changes nothing returns `skipped`.
  - A proof returning `{ ok: false, reason: 'code tokens changed' }` is rolled back with that reason.
  - With a stubbed `runTests` that fails only `t1`, and `flaky = {'t1'}`, the change is committed.
  - `changeId('dead-code', 'src/a.ts', 'foo')` is stable across calls and matches `/^mn-[0-9a-f]{10}$/`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: verification loop with rollback`

---

### Task 11: knip dead-code candidates

**Files:**
- Create: `src/adapters/node/knip.ts`, `tests/fixtures/bloated-app/**` (see Task 16 for its contents; create it now), `tests/fixtures/knip/output.json`
- Test: `tests/adapters/node/knip.test.ts`

**Interfaces:**
- Produces:
  - `parseKnipJson(raw: string, pkgDir: string): DeadCodeCandidate[]`. Maps unused files to `kind: 'file'`. Maps unused `dependencies` and `devDependencies` to `kind: 'dependency'` (file = that package's `package.json`, symbol = the dependency name). Maps unused `exports` and `types` to `kind: 'export'`, with symbol and line.
  - `findNodeDeadCode(root: string, pkg: PackageConfig, opts: { monorepo: boolean }): Promise<DeadCodeCandidate[]>`. Runs knip's bin, resolved from mrs-norris's own dependencies (`createRequire(import.meta.url).resolve('knip/package.json')`), as `node <bin> --reporter json --no-exit-code`, with `--workspace <dir>` added when `monorepo` is true and `cwd: root`.

- [ ] **Step 1: Generate the knip fixture.** Copy `tests/fixtures/bloated-app` to a temp directory, run knip as above, and save its stdout to `tests/fixtures/knip/output.json`. This pins the parser to the installed knip version.
- [ ] **Step 2: Write the failing tests**
  - `parseKnipJson(fixture, '.')` contains `{ kind: 'export', file: 'src/math.ts', symbol: 'unusedHelper' }`, `{ kind: 'dependency', file: 'package.json', symbol: 'left-pad' }` and `{ kind: 'file', file: 'src/orphan.ts' }`.
  - `findNodeDeadCode` on a temp copy of the fixture returns the same three candidates.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them.** Expected: PASS.
- [ ] **Step 6: Commit.** `feat: find dead code with knip`

---

### Task 12: Dead-code and dependency pass

**Files:**
- Create: `src/passes/context.ts`, `src/passes/deadCode.ts`, `src/adapters/node/dependencies.ts`
- Test: `tests/passes/deadCode.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 9, 10 and 11.
- Produces:
  - ```ts
    interface Scope { includes(file: string): boolean }
    interface PassContext {
      root: string; config: Config; git: Git; agent: Agent; log: RunLog; scope: Scope;
      surfaces: Map<string, PublicSurface>;                    // by pkg dir
      verify: (change: PlannedChange, apply: () => Promise<void>, proof?: () => Promise<ProofResult>) => Promise<ChangeRecord>;
      findDeadCode: (pkg: PackageConfig) => Promise<DeadCodeCandidate[]>;
    }
    ```
  - `referencesOutside(git: Git, c: DeadCodeCandidate): Promise<string[]>`. The search term depends on the candidate:
    - export: the symbol
    - file: the file's basename without extension
    - dependency: the package name

    Returns files with hits, excluding the candidate's own file, lockfiles, and (for dependencies) every `package.json`.
  - `removeDependency(pkgJsonPath: string, name: string): Promise<void>`. Deletes the key from `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`, keeping 2-space formatting and the trailing newline.
  - `lockfileUpdateCommand(pm: PackageManager): string`:
    - npm: `npm install --package-lock-only --ignore-scripts`
    - pnpm: `pnpm install --lockfile-only --ignore-scripts`
    - yarn: `yarn install --mode update-lockfile`
  - `VerdictSchema = z.object({ unused: z.boolean(), confidence: z.enum(['high', 'medium', 'low']), reason: z.string() })`
  - `runDeadCodePass(ctx: PassContext): Promise<void>`

**Per candidate, in this order** (skip candidates that are out of scope or match `config.ignore` or `PROTECTED_DOCS`):
1. If the package is a library, the candidate's file is in its surface, and `allowPublicApiChanges` is false: add a finding `public-export` with note `Unused public export left alone (set allowPublicApiChanges to allow)`. Stop.
2. If `referencesOutside` returns any files: add `possibly-unused` with note `Referenced in: <files>`. Stop.
3. Call `agent.judge`. The prompt includes the candidate, the file contents, and the instruction to look for dynamic usage (string imports, config, framework conventions, entry points). Unless the result is `unused && confidence === 'high'`: add `possibly-unused` with note `Claude: <reason>`. Stop.
4. Verify the change:
   - Title: `Remove unused export \`<symbol>\` from <file>`, `Delete unused file <file>`, or `Remove unused dependency \`<name>\``
   - Reason: the verdict's reason
   - Id: `changeId('dead-code', file, symbol)`
   - `allowedPaths`:
     - export: `[file]`
     - file: `[file]`
     - dependency: `[package.json, lockfile if present]`
   - Apply:
     - export: `agent.edit`, telling it to remove the declaration, or only the `export` keyword if the symbol is still used inside the file
     - file: `fs.rm`
     - dependency: `removeDependency`, then the lockfile update command if a lockfile exists

- [ ] **Step 1: Write the failing tests.** Use a temp repo, a `ScriptedAgent`, a stub `findDeadCode`, and a `verify` stub that runs `apply` and records the change.
  - An export with no outside references and a `high` verdict calls verify with title `Remove unused export \`unusedHelper\` from src/math.ts` and `allowedPaths: ['src/math.ts']`.
  - An export referenced as `m['unusedHelper']` in `src/load.ts` produces finding `possibly-unused` with a note containing `src/load.ts`, and makes no judge call (`agent.prompts.length === 0`).
  - A `medium` verdict produces a finding and no verify call.
  - A candidate in a library surface file produces finding `public-export` and no judge call.
  - A dependency candidate `left-pad` (no lockfile) removes the key from package.json and runs no lockfile command.
  - **(Edge case)** Symbol `get` with `get(` used in another file produces a finding. Symbol `$state` used elsewhere as `$state` produces a finding.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: dead code and dependency pass`

---

### Task 13: Comment-trimming pass

**Files:**
- Create: `src/adapters/node/tokens.ts`, `src/adapters/node/comments.ts`, `src/passes/comments.ts`
- Test: `tests/adapters/node/tokens.test.ts`, `tests/adapters/node/comments.test.ts`, `tests/passes/comments.test.ts`

**Interfaces:**
- Consumes: `PassContext` (Task 12).
- Produces:
  - `codeTokensEqual(before: string, after: string, fileName: string): boolean`. Compares the `(kind, text)` sequences from `ts.createScanner(Latest, /*skipTrivia*/ true, languageVariant)`, using JSX for `.tsx` and `.jsx`.
  - `listComments(source: string, fileName: string): string[]`
  - `protectedComments(source: string, fileName: string, opts: { publicSurface: boolean }): string[]`. Returns:
    - the first comment, if it matches `/license|copyright|spdx/i`
    - any comment matching `/eslint-|@ts-(ignore|expect-error|nocheck)|prettier-ignore|(istanbul|c8|v8) ignore|biome-ignore|#__PURE__|@vite-ignore|webpackChunkName/`
    - any comment matching `/\b(TODO|FIXME)\b/` together with `/#\d+|[A-Z][A-Z0-9]+-\d+|https?:\/\//`
    - when `publicSurface` is true, every `/** … */` comment immediately followed (ignoring whitespace) by `export`
  - `runCommentPass(ctx: PassContext): Promise<void>`. Covers tracked TS/JS source and test files that are in scope, not ignored, and have at least one comment. Per file:
    - Calls `agent.edit` with the trimming rules from spec §4.2, plus any `config.style` lines, and `allowedPaths: [file]`.
    - The proof passes when `codeTokensEqual(before, after)` holds and every protected comment from `before` is still a substring of `after`. Otherwise the reason is `code changed, not just comments` or `removed a protected comment: <first 60 chars>`.
    - Title: `Trim redundant comments in <file>`
    - Reason: `Removed comments that restate the code.`
    - Id: `changeId('comments', file)`

- [ ] **Step 1: Write the failing tests**
  - `codeTokensEqual` is true when only comments and whitespace differ. It's false for a renamed identifier, false for a changed string literal, and true for a `.tsx` file whose only difference is a removed `// x` line above the component.
  - `protectedComments` returns the license header, `// eslint-disable-next-line no-console`, and `// TODO(#123) fix`. It doesn't return `// TODO tidy`. With `publicSurface: true`, it returns the JSDoc above `export function f`.
  - Pass: a scripted edit that removes `// add two numbers` is passed to verify, and the captured proof returns `{ ok: true }`. A scripted edit that also renames a variable gives `{ ok: false, reason: 'code changed, not just comments' }`. A scripted edit that removes `// eslint-disable-next-line` gives `ok: false`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: comment trimming pass with token-equality proof`

---

### Task 14: Report

**Files:**
- Create: `src/report.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Produces:
  - `interface RunSummary { branch: string; baseRef: string; before: Metrics; after: Metrics; log: RunLog; usage: Usage; finalCheckOk: boolean }`
  - `formatCount(n: number): string`. Uses thousands separators, e.g. `4,200`.
  - `formatDelta(before: number, after: number): string`. Returns `−4,200` (U+2212) for decreases, `+12` for increases, and `±0` for no change.
  - `formatDuration(ms: number): string`. Returns `42s` under a minute, otherwise `11m 5s`.
  - `renderReport(s: RunSummary): string`
  - `writeReport(root: string, markdown: string, now: Date): Promise<string>`. Returns the path `.mrs-norris/reports/<YYYYMMDD-HHmmss>.md`.

**Report layout:**
- Title `# mrs-norris report`.
- Lines `Branch: \`<branch>\` (from \`<baseRef>\`)` and `Review with: \`git log <baseRef>..<branch>\``.
- If `finalCheckOk` is false, a first line: `> ⚠️ The final full test run on the branch failed. Review carefully before merging.`
- A metrics table with columns `| Metric | Before | After | Change |` and these rows, in order:
  - `Source lines`
  - `Test lines`
  - `Comment lines`
  - `Tests`
  - `Test-suite time (local, proxy for CI)`
  - `Coverage` (shows `n/a` when null)
  - `Agent context tokens (≈)`
  - `Direct dependencies`
- These sections, in order. Each one shows `None.` when empty:
  - `## Changes`: grouped by category, one line per change, `- <title>: <reason> (\`<id>\`)`
  - `## Rolled back`
  - `## Not changed: possibly unused or unverified`
  - `## Public exports left alone`
  - `## Flaky tests excluded`
  - `## Tools installed`
  - `## Cost`: `<in> input / <out> output tokens · $<cost to 2 dp>`

- [ ] **Step 1: Write the failing tests**
  - `formatDelta(4300, 100)` is `'−4,200'`, `formatDelta(1, 13)` is `'+12'`, `formatDelta(5, 5)` is `'±0'`, and `formatDuration(665000)` is `'11m 5s'`.
  - The rendered report for a summary with one committed change and one finding contains `| Source lines | 4,300 | 100 | −4,200 |`, `- Remove unused dependency \`left-pad\`:` and `## Rolled back\n\nNone.`, and its `Coverage` row contains `n/a`.
  - `finalCheckOk: false` puts the warning before the table.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: markdown report`

---

### Task 15: Run orchestration and CLI

**Files:**
- Create: `src/commands/run.ts`, `src/scope.ts`
- Modify: `src/cli.ts` (default command plus `run [paths...] --since <ref> --only <list> --model <id> --yes`)
- Test: `tests/commands/run.test.ts`, `tests/scope.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `makeScope(git: Git, paths: string[], since?: string): Promise<Scope>`. A file is in scope when it is under one of `paths` (all files if `paths` is empty) and, if `since` is given, is in `git.diffNames(since)`.
  - `parseOnly(value: string): Category[]`. Throws `Unknown category "<x>". Valid: dead-code, comments, test-writing, simplify, test-pruning`.
  - `interface RunOptions { paths: string[]; since?: string; only?: Category[]; model?: string; yes?: boolean }`
  - `interface RunDeps { io: IO; agent?: Agent; now?: () => Date; findDeadCode?: PassContext['findDeadCode'] }`
  - `runMrsNorris(root: string, opts: RunOptions, deps: RunDeps): Promise<{ reportPath: string; branch: string; summary: RunSummary }>`

**Order:**
1. Unless `deps.agent` is given, call `assertApiKey()`.
2. Load the config, or run `initProject(root, io, { yes })` if there is none.
3. If the tree is dirty (ignoring `.mrs-norris/`), throw `Working tree has uncommitted changes. Commit or stash them, then run mrs-norris again.`
4. Run the baseline for every package. If any isn't ok, print all problems and throw `Baseline is not green. mrs-norris needs passing tests to prove it preserved behavior.` No branch is created. Print any `warnings` and continue.
5. Collect the before metrics. Record the original branch (or the HEAD sha if detached).
6. Create branch `mrs-norris/<YYYY-MM-DD-HHmm>`. If `.mrs-norris/` has changes, commit them as `mrs-norris: add configuration`.
7. Install handlers that, on any thrown error or SIGINT, run `git.rollback()` and then `git.checkout(original)`. Remove the handlers when the run finishes.
8. Run the passes, in order, that are in `config.categories ∩ (only ?? all)` and implemented: `dead-code` → `runDeadCodePass`, then `comments` → `runCommentPass`.
9. Run the final tests for every package and set `finalCheckOk`.
10. Collect the after metrics, render, write and print the report, then check out the original branch.

- [ ] **Step 1: Write the failing tests.** Use temp repos whose test command is `node check.js` (`runner: null`), a pre-written config, and a `ScriptedAgent`.
  - `parseOnly('dead-code,comments')` returns both. `parseOnly('cleanup')` throws the message above.
  - `makeScope` with paths `['src']` excludes `tests/a.test.ts`. With `since`, it includes only files changed since that ref.
  - **(Review Focus 2)** A dirty tracked file makes the run reject with `Working tree has uncommitted changes`.
  - A baseline failure makes the run reject, and `git branch --list 'mrs-norris/*'` is empty.
  - **(Review Focus 5)** With no `deps.agent` and an env without the key, the run rejects with `ANTHROPIC_API_KEY is not set` before any test command runs. To check the ordering, `check.js` writes a marker file, and the test asserts the marker doesn't exist.
  - Happy path (comment-only edit): the user ends on the original branch, which keeps its original HEAD sha. The mrs-norris branch has the config commit and one `mrs-norris(comments)` commit. The report file exists.
  - `only: ['comments']` doesn't call `findDeadCode`. The stub throws if it is called.
  - **(Review Focus 4)** An agent edit handler that writes to a file and then throws mid-pass: the change is rolled back and the run still completes. Separately, a `findDeadCode` stub that throws a non-change error makes the run reject, leaves the user on the original branch, and leaves `git status --porcelain` empty.
  - **(Review Focus 2)** Two runs with the same `now()` produce branches `mrs-norris/2026-10-16-1432` and `mrs-norris/2026-10-16-1432-2`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement `runMrsNorris`, `makeScope`, `parseOnly` and the CLI wiring.** The CLI builds the real agent with `createClaudeAgent({ model: opts.model ?? config.model, root })` and the real `findDeadCode` with `findNodeDeadCode`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: run orchestration and CLI`

---

### Task 16: End-to-end fixture run and README

**Files:**
- Create or complete: `tests/fixtures/bloated-app/` containing:
  - `package.json`: name `bloated-app`, `private: true`, `dependencies: { "left-pad": "^1.3.0" }`, `scripts.test: "vitest run"`
  - `tsconfig.json`
  - `src/math.ts`: `// add two numbers` above `export function add`, plus `export function unusedHelper`
  - `src/index.ts`: imports `add`
  - `src/orphan.ts`: imported by nothing
  - `src/plugins.ts`: `export const loadedByName = 1`, referenced as the string `'loadedByName'` in `mrs-norris.plugins.json`
  - `tests/math.test.ts`: tests `add`
- Create: `README.md`
- Test: `tests/e2e.test.ts`

**Interfaces:**
- Consumes: `runMrsNorris` and `ScriptedAgent`.

- [ ] **Step 1: Write the failing test.** Copy the fixture to a temp directory, `git init`, and commit. Write `.mrs-norris/config.yaml` with test command `<repo>/node_modules/.bin/vitest run`, typecheck `<repo>/node_modules/.bin/tsc --noEmit`, runner `vitest`. Use a `ScriptedAgent` whose `judge` always returns `{ unused: true, confidence: 'high', reason: 'no references' }`, and whose `edit` does deterministic string edits based on the file named in `allowedPaths` (remove the `unusedHelper` function, remove the `// add two numbers` line). Run `runMrsNorris(tmp, { paths: [], yes: true }, { io, agent, findDeadCode: real })` and assert:
  - `git log <branch> --format=%s` contains:
    - `mrs-norris(dead-code): Remove unused export \`unusedHelper\` from src/math.ts`
    - `mrs-norris(dead-code): Delete unused file src/orphan.ts`
    - `mrs-norris(dead-code): Remove unused dependency \`left-pad\``
    - `mrs-norris(comments): Trim redundant comments in src/math.ts`
  - Every one of those commits has a `Mrs-Norris-Change-Id:` trailer.
  - `summary.log.findings` has a `possibly-unused` entry for `loadedByName`.
  - The report file contains `| Source lines |` and a `−` delta.
  - The original branch HEAD is unchanged.
  - Running vitest on the mrs-norris branch passes.
- [ ] **Step 2: Run it.** `npx vitest run tests/e2e.test.ts`. Expected: FAIL until any integration gaps are fixed. Then: PASS.
- [ ] **Step 3: Write `README.md`.** Cover: what mrs-norris does and why, install and usage (`npx mrs-norris`, the flags), the safety guarantees (branch, one commit per change, triple agreement, token-equality proof for comments, green baseline required), current status (Plan 1: dead code, dependencies and comments; the rest coming), and the MIT license.
- [ ] **Step 4: Run the whole suite.** `npm test && npm run typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit.** `test: end-to-end fixture run; docs: README`
