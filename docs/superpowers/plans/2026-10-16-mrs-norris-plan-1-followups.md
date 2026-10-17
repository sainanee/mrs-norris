# mrs-norris Plan 1: decisions and follow-ups

Plan 1 was built and reviewed task by task, then reviewed again as a whole branch. This file records the decisions that changed the spec or plan, and the open items for Plans 2–5. Read it before planning the next plan.

## Decisions that amend the spec or plan

- **Plan 1 leaves out fields nothing fills yet:** `Metrics.coverage`, `RunLog.installed`, the report's Coverage row and its "Tools installed" section. Plan 2 adds them when it measures coverage and installs tools.
- **The dead-code pass never deletes test files.** Pruning tests is Plan 3's job, under the mutation proof.
- **Comment protection is broad on purpose.** These comments are never removed:
  - any comment containing `@`, `#`, `///`, a tool or bundler pragma, license or copyright, or TODO/FIXME
  - any `/** */` block in a library's public files

  The check compares counts of protected comments before and after (a multiset), not substrings. A comment the model only rewords counts as removed.
- **The comment proof compares the full parse-tree shape and the shebang,** not just a token stream.
- **`.mrs-norris/` is never committed by mrs-norris.** Untracked files under the root `.mrs-norris/` are exempt from the scope and clean checks. A tracked config with local edits blocks a run with "commit or stash". This replaces spec §6's "committed to the repo": teams commit the config themselves.
- **Dependency removals aren't test-verified.** `node_modules` still has the package during checks, so these removals rest on triple agreement alone. The report labels them "evidence-only".
- **Commits run with no user hooks at all** (`git -c core.hooksPath=/dev/null`).
- **Runs must start from the repository root.** Git refuses to act when `--show-toplevel` isn't the root.
- **Safety while running:**
  - The run stops without touching the checkout if the branch changes during the run.
  - The agent and child processes are stopped before cleanup.
  - Signal handlers stay registered until cleanup ends.
- **Agent confinement:**
  - Claude gets a custom system prompt, with no settings, memory or MCP loaded.
  - `canUseTool` and a PreToolUse hook confine reads and writes to the repo, checking the real path, `~` paths and padded paths.
  - Gitignored files such as `.env` can't be read.
  - Directory-wide Grep and Glob can't be filtered per file.
- **Tests:**
  - Temp repos live under `.tmp/`, which globalSetup empties before and after each run.
  - `GIT_CEILING_DIRECTORIES` stops a temp repo from walking up into this repo.
  - The test timeout is 30s.
- **TypeScript is pinned to 5.9.** TS 7's native port has no JS compiler API.

## Open items

### Before or during Plan 2
- When a successful run makes zero commits, the report still names the deleted branch. A narrow post-checkout failure can also report a false "checkout moved" message.
- The missing-test check matches packages by directory prefix, so a hand-written config with a root `.` package plus workspaces rolls back every change. That fails safe; fix it with per-package baseline id sets.
- The test-report parser gives no failed id for a failed suite whose assertions all passed, for example when `afterAll` throws. **This must be fixed before the simplify pass.**
- The comment proof accepts whitespace and line-ending rewrites. Require that the output is the input with only comment ranges removed. That also closes the gap where moving a protected comment passes.
- An error after commits leaves no report. A knip failure aborts the whole run instead of degrading per package.
- The dependency text search ignores every `package.json`. It should search manifests with the dependency sections removed, so `scripts` and config keys count as references.
- `removeDependency` deletes the name from every dependency section, including `peerDependencies`.
- Appending reporter arguments breaks test scripts like `vitest run && tsc`. Retry once without them before declaring the baseline red.
- The pnpm and yarn lockfile commands have never run. Yarn Berry may write `.yarn/install-state.gz`, and Yarn 1 has no `--mode`. Both fail safe through rollback.

### Smaller items
- Test output when JSON reporters are on carries little failure detail. Bad report JSON throws a bare SyntaxError.
- No `--workspace` test runs knip on a monorepo. Several knip error details are lost.
- Config errors: malformed YAML has no file path, and an empty file reports `: Invalid input`.
- Test files aren't typechecked, because tsconfig covers `src` only.
- Report formatting: the Branch and Review lines merge into one paragraph, and the duration delta rounds asymmetrically at ±500 ms.
- A cleanup error replaces the original error on the catch path. The final-run banner shows for a flaky failure.
- `report.ts` uses a `.mrs-norris` literal instead of `CONFIG_DIR`.

### Not yet verified
- The live agent test (`MRS_NORRIS_LIVE=1 npx vitest run tests/agent/claude.live.test.ts`) has never run. It needs an API key. Run it before the first real use: it is the only proof that the real CLI routes tool calls through the confinement hook.
