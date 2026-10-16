# mrs-norris — Design

Date: 2026-10-16
Status: Approved 2026-10-16

Items marked **(my call)** were decided by Claude to fill a gap; everything else was decided by the project owner.

## 1. Intent

AI coding agents write too much: too much code, too many tests, too many comments. That bloat has two real costs:

1. **Future agents pay for it.** Every extra line is context the next agent has to read, which costs tokens and dilutes its attention.
2. **CI pays for it.** Hundreds of overlapping tests make every pipeline run slower and more expensive.

**mrs-norris** is an open-source CLI that takes a hastily-written, AI-bloated repository and turns it into a lean, well-engineered one — less code, fewer and better tests — **without changing what the code does**.

The audience is anyone: it's open source, run by developers who have never met us, on repos we've never seen. That makes **trust** the central design problem. A tool that deletes code is only useful if people believe it won't break theirs. Every safety rule below exists for that reason.

## 2. Goals, non-goals, anti-goals

**Goals (v1)**

- Shrink a repo's code, tests, and comments while provably preserving behavior.
- Produce a reviewable result: a branch of small, individually-droppable commits plus a before/after report.
- Work on TypeScript/JavaScript and Python repos, including basic monorepos.
- Be a one-command experience: `npx mrs-norris`.

**Non-goals (v1)** — planned or possible later, deliberately out of scope now

- Claude Code plugin and GitHub Action delivery (CLI is the core they'll build on).
- Languages other than TS/JS and Python.
- Model providers other than Claude.
- Adding features, fixing bugs, or "improving" behavior. mrs-norris changes shape, never behavior.
- Performance optimization of the user's runtime code (the "efficient" goal is about codebase size, test count and CI time).
- Editing standalone documentation files (README, `docs/` folder). Owner's decision: these are left alone.

**Anti-goals** — outcomes that would be failures even if the tool technically works

- **A behavior change slips through.** Any merged mrs-norris commit that changes what the program does is the worst possible failure.
- **A test that was catching real bugs gets deleted.** Coverage staying flat is not enough proof (see §5.3).
- **Breaking a library's public API** for downstream users.
- **Imposing a foreign style.** Rewriting a team's code into "our" idea of good style when they didn't ask.
- **A wall of unreviewable change.** One giant diff nobody can review is as bad as no tool.
- **Chasing the number.** Making code shorter but worse (clever one-liners, cramming) to improve the line-count metric.

## 3. User experience

### 3.1 Commands **(my call on exact names and flags)**

```
npx mrs-norris                 # = mrs-norris run; runs init first if no config exists
mrs-norris init                # detect project setup, confirm with user, write config
mrs-norris run [paths...]      # do a cleanup run
    --since <git-ref>           # only consider code changed since <ref>
    --only <categories>         # e.g. --only dead-code,tests
    --interactive               # approve each change before it's committed
    --model <id>                # override the Claude model
mrs-norris reject <change-id>  # record a change as rejected so it's never re-proposed
```

Auth: the user provides `ANTHROPIC_API_KEY`.

Python users need Node.js to run it via `npx`. **(my call)** — v1 ships on npm only; a PyPI wrapper can come later.

### 3.2 First run (`init`)

1. Detect language(s), package manager(s), and monorepo workspaces (npm/pnpm/yarn workspaces; uv/poetry workspaces or multiple `pyproject.toml`).
2. For each package, guess the commands for: **test**, **coverage**, **type-check/build**, and **lint** (the last two if present). Sources: `package.json` scripts, `pyproject.toml`, `tox.ini`, `pytest.ini`, `Makefile`, CI config files.
3. Show the detected commands and ask the user to confirm or edit them, once.
4. Write them to the config file (§6).

### 3.3 A run

1. **Pre-flight.**
   - Working tree must be clean (refuse otherwise).
   - Run the full baseline: tests, coverage, type-check, lint. **Tests must pass at baseline.** If they don't, stop and report which tests fail — mrs-norris can't prove behavior is preserved against a red suite. **(my call)**
   - Run the test suite more than once to detect flaky tests. Flaky tests are excluded from verification and listed in the report. **(my call)**
   - Record the "before" metrics (§7).
2. **Create a branch** off the current HEAD, e.g. `mrs-norris/2026-10-16-1432`. Never touch the user's current branch.
3. **Run the cleanup passes** (§4) in order. Each proposed change goes through the verification loop (§5). Verified changes become one commit each; failed ones are rolled back and logged.
4. **Report** (§7) printed to the terminal and written to a file.

**Unattended (default):** runs start to finish with no prompts. The user reviews the branch afterwards and drops any commits they dislike.

**`--interactive`:** before each verified change is committed, show the diff and the reason; user accepts or rejects. Rejections are recorded in memory (§6.2) immediately.

**Cost:** no budget cap or up-front estimate (owner's decision). The report states the actual tokens used and dollar cost of the run. **(my call)**

## 4. Cleanup passes

All four categories are in v1. Proposed order **(my call; builder may refine)** — dead code first so later passes have less to read; safety tests before simplification; test pruning last, after the code has settled:

1. Dead code & unused dependencies
2. Comment & doc trimming
3. Writing tests for untested code that's about to be simplified
4. Code simplification
5. Test pruning & merging

### 4.1 Dead code & unused dependencies

Remove unused files, functions, classes, exports, variables, and packages.

- Mechanical detection by existing tools (e.g. **knip** for TS/JS; **vulture** and **deptry** for Python), with Claude judging each candidate — tools miss dynamic usage (string imports, reflection, framework conventions like Next.js routes, pytest fixtures, Django apps, entry points declared in config).
- Dependency removals update manifests and lockfiles through the project's own package manager.
- Public API protection applies (§5.4).

**Evidence required for removal (owner's decision).** Dead code usually has no tests, so tests can't prove its removal is safe. A removal happens only when **all three agree** that it's unused:
1. the static dead-code tool flags it;
2. Claude, reviewing the candidate and its surroundings, judges it unused;
3. a repo-wide text search finds no other reference to it (string-based imports, config files, framework conventions, entry points declared in manifests, CLI/plugin registrations);

and build/type-check, lint, and tests still pass afterwards. If any of the three disagrees or is uncertain, the candidate goes into the report as "possibly unused, not removed" instead of being deleted. The §5.2 coverage requirement does **not** apply to removals; this rule replaces it.

### 4.2 Comment & doc trimming

Remove inline comments that restate the code (`// increment counter`) and stale comments that no longer match the code. Standalone doc files (README, `docs/`, other Markdown/RST docs) are **never touched** (owner's decision).

Never removed **(my call)**: license/copyright headers; **all Python docstrings** (they can be runtime behavior — `__doc__`, Click/argparse help, doctests — and no test proves removing them is safe); JSDoc/TSDoc on public API; tool directives (`eslint-disable`, `# type: ignore`, `# noqa`, `@ts-expect-error`, pragmas); comments explaining *why* something non-obvious is done; TODOs that reference an issue.

### 4.3 Writing tests for untested code

When code that's a candidate for simplification isn't covered by tests, mrs-norris **writes proper tests first, like a good engineer would** (owner's decision), then simplifies.

These tests:
- Pin the code's **current** behavior and must pass against the unmodified code before simplification begins.
- Test behavior through public interfaces, not implementation details; minimal mocking; parametrized rather than copy-pasted. In other words, held to the same lean standard mrs-norris applies to everyone else's tests.
- Are **kept** in the repo as their own commits, before the simplification commit that relies on them. **(my call)**
- Follow the repo's existing test framework, file layout, and naming.

On a badly under-tested repo this means a run can end with *more* tests than it started with. That's acceptable — the goal is a better-engineered repo, not a smaller number — and the report shows it honestly. **(my call, owner agreed)**

### 4.4 Code simplification

Merge duplicated logic; remove needless abstractions, wrappers, indirection, and defensive code that can't trigger; shorten verbose code. Results must be clearer, not just shorter (see anti-goal "chasing the number").

Matches the repo's own conventions by default; config can override (§6.1).

### 4.5 Test pruning & merging

Remove tests that are redundant with others; merge near-duplicates into parametrized tests; cut over-mocking that makes tests slow or meaningless. Subject to the strict proof in §5.3.

## 5. Safety model

### 5.1 Verification loop (every change)

For each proposed change:

1. Apply it.
2. Run the relevant checks: affected tests (or full suite if impact can't be determined), type-check/build, lint.
3. Category-specific proof (§5.2–5.3).
4. If everything passes → commit. If anything fails → revert the change completely and log it as "attempted, rolled back" in the report.

A final full-suite run happens at the end of the run against the branch tip. **(my call)**

### 5.2 Proof for code changes

This applies to simplification (§4.4). Removals of dead code and dependencies follow §4.1's evidence rule instead; comment trimming (§4.2) needs only that tests, type-check and lint still pass.

Code may only be simplified if the lines being changed are covered by tests — either existing tests or ones written in §4.3. Tests, type-check, and lint must all pass after the change.

### 5.3 Proof for test removal or merging (the strict rule)

A test may be deleted, or a set of tests replaced by a merged one, only if:

1. **Coverage doesn't drop** — line and branch coverage of the codebase is no lower without the removed test(s).
2. **Mutation check passes** — generate mutants for the code the removed test(s) covered; every mutant the original test(s) killed must still be killed by the remaining suite (or by the merged replacement).

Tools: **Stryker** for TS/JS, **mutmut** (or equivalent) for Python. Mutation testing is slow, so it should be scoped to only the code covered by the tests in question, never the whole repo.

### 5.4 Public API protection

Detect whether a package is a published library (e.g. has `exports`/`main` and isn't `private: true` in `package.json`; has a `[project]` table and build backend in `pyproject.toml`). For libraries, never remove or rename anything reachable from the public entry points unless the user opts in via config. Unused public exports are listed in the report instead.

### 5.5 Every change is reviewable and droppable

- One change = one commit, with a message explaining what changed and why.
- Each commit carries a trailer, `Mrs-Norris-Change-Id: <id>`, so changes can be referenced, rejected, and remembered. **(my call)**
- Commits must be independently revertable where possible; where a commit depends on another (e.g. a simplification depends on the tests written for it), the message says so. **(my call)**

### 5.6 Tooling in the user's environment (owner's decision)

Coverage and mutation tools (and sometimes dead-code tools) must run inside the user's dependency environment. mrs-norris **installs what it needs temporarily** into their virtualenv / `node_modules` for the run, then **restores manifests and lockfiles** exactly. Nothing tool-related ever lands on the mrs-norris branch. The report lists what was installed.

### 5.7 Supported setups and graceful degradation **(my call)**

v1 supports these test runners:
- **TS/JS:** Jest, Vitest, Mocha (the runners Stryker supports well).
- **Python:** pytest, including unittest-style tests run under pytest.

When a package's setup doesn't fit (unsupported runner, coverage or mutation tooling won't work), mrs-norris doesn't refuse the whole run. It skips only the passes that need the missing proof, per package, and says so in the report:
- No mutation data → skip test pruning (§4.5) for that package.
- No coverage data → also skip test writing and simplification (§4.3–4.4).
- Dead-code removal and comment trimming still run, since they don't depend on coverage.

### 5.8 Repo size and resumability **(my call)**

v1 targets small-to-medium repos (roughly up to a few hundred thousand lines and a few thousand tests), and large runs are expected to take hours. Runs are **resumable**: every verified change is already a commit, so after a crash or Ctrl-C, re-running continues on the same mrs-norris branch from where it stopped, using a small local state file (gitignored) to skip work already done.

## 6. Files mrs-norris keeps in the repo **(my call on layout and format)**

A `.mrs-norris/` directory, committed to the repo so settings and memory are shared with the team.

### 6.1 `.mrs-norris/config.yaml`

- Per-package commands for test, coverage, type-check, lint (written by `init`).
- Style overrides: rules that take precedence over the repo's inferred conventions (owner wants this configurable).
- Paths to ignore (generated code, vendored code, migrations, fixtures).
- Public API opt-in (allow touching public exports).
- Categories enabled by default.
- Default model.

### 6.2 `.mrs-norris/rejected.yaml` — memory

Records changes the user rejected so they're never proposed again. Each entry describes the change well enough to recognize it next time even if line numbers have moved (file, symbol, category, short description).

Ways a change becomes "rejected":
- Rejected in `--interactive` mode.
- `mrs-norris reject <change-id>`.
- Automatic detection: on the next run, look at the previous mrs-norris branch; any change whose `Mrs-Norris-Change-Id` never made it into the base branch, while other commits from that branch did, is recorded as rejected. **(my call)**

## 7. Metrics and report

Measured before and after, per package and in total:

| Metric | Notes |
|---|---|
| Lines of code | Source vs. test vs. comments, separately. Excludes generated/vendored/lockfiles. |
| Number of tests | Count of test cases as reported by the runner. |
| Test-suite time | Measured locally as a proxy for CI time; labeled as such. **(my call)** |
| Coverage | Line and branch. |
| Agent context tokens | Tokens needed to read the repo's tracked source + test + doc files (excluding lockfiles, generated, vendored). |
| Dependencies | Count of direct dependencies. |

Report contents:
- Before/after table with deltas (e.g. "−4,200 lines, 340 → 90 tests, test time 11m → 3m, coverage unchanged, context −38%").
- List of commits by category with one-line reasons.
- Changes attempted and rolled back, with why.
- Code it couldn't verify or chose not to touch, and why.
- Unused public exports left alone (§5.4).
- Flaky tests excluded.
- Tokens used and dollar cost of the run.

Printed to the terminal and written as Markdown suitable for pasting into a pull-request description, to `.mrs-norris/reports/<timestamp>.md` (gitignored by default). **(my call)**

## 8. Technical decisions

**Decided by owner:**
- TypeScript/JS and Python supported in v1.
- Claude only, via the **Claude Agent SDK**.
- Distributed as a CLI, `npx mrs-norris`.
- Basic monorepo support.
- Name: **mrs-norris** (after Argus Filch's cat), for both the project and the npm package. The npm name was unclaimed on 2026-10-16.

**My calls:**
- Implemented in TypeScript, Node.js 22+ (required by current Agent SDK/AI SDK tooling), published to npm.
- Existing tools do mechanical detection and measurement; Claude makes judgment calls and writes the changes. Candidates: knip, c8/istanbul (or the test runner's built-in coverage), Stryker for TS/JS; vulture, deptry, coverage.py, mutmut for Python.
- Language support is built as an adapter per ecosystem (TS/JS, Python) behind a common interface — detection, commands, dead-code finder, coverage, mutation — so more languages can be added later.
- Open source under the MIT license.

## 9. Left to the builder

- Internal architecture: how passes, the verification loop, adapters, and the agent are structured.
- Which Claude model(s) to use by default, and whether different tasks use different models (e.g. a strong model for judgment, a faster one for mechanical edits). Use current Claude models; make it overridable.
- Prompt design and how much repo context the agent gets per change.
- How to determine "affected tests" for a change efficiently.
- How to count context tokens (Anthropic token-counting API or a local approximation).
- Exact report formatting and terminal UI.
- How mrs-norris tests itself (fixture repos of deliberately bloated code are strongly suggested).
- How to batch changes for speed while keeping one-commit-per-change.
