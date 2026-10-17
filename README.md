# mrs-norris

mrs-norris shrinks TypeScript and JavaScript repos that have grown bloated, often from AI-written code. It removes dead code, unused dependencies and comments that restate the code, and it proves each change preserves behavior before committing it.

Every change lands on a separate branch as its own commit, so you review and merge what you want.

## Usage

Requires Node.js 22 or later, a git repository with passing tests, and an Anthropic API key.

```sh
export ANTHROPIC_API_KEY=...
cd your-repo            # run from the repository root
npx mrs-norris init     # detect test, typecheck and lint commands; writes .mrs-norris/config.yaml
npx mrs-norris          # same as `npx mrs-norris run`
```

Don't edit files or switch branches in this checkout until mrs-norris finishes. If the checkout moves to another branch mid-run, mrs-norris stops without committing to it or resetting it.

`run [paths...]` limits the run to the given paths. Options:

| Option | Effect |
| --- | --- |
| `--since <ref>` | Only touch files changed since this git ref |
| `--only <list>` | Comma-separated categories to run, e.g. `dead-code,comments` |
| `--model <id>` | Claude model to use instead of the configured one |
| `-y, --yes` | Accept the detected commands if no config exists yet |

`run` creates the config itself if there is none. It writes a report to `.mrs-norris/reports/` with before and after metrics, every change, and findings it left for you to decide. `.mrs-norris/config.yaml` also sets the model, the categories, ignore globs, extra style rules for Claude, and `allowPublicApiChanges`.

## Safety

- **Separate branch.** Work happens on `mrs-norris/<date>`, created from your HEAD. Your branch is never committed to, and you are returned to it with a clean tree at the end, on error, and on Ctrl-C.
- **One commit per change.** Each commit carries a `Mrs-Norris-Change-Id` trailer, so you can revert or cherry-pick changes individually.
- **Green baseline required.** If your tests don't pass before the run, mrs-norris stops before creating a branch.
- **Every change is verified.** After each change the tests, typecheck and lint run. A change that makes a test fail, makes a test disappear, or touches files outside its scope is rolled back. Untracked files in the root `.mrs-norris/` directory, where mrs-norris keeps its config and reports, are exempt from the scope check.
- **Dead code needs triple agreement.** knip flags it, Claude judges it unused with high confidence, and a repo-wide whole-word search finds no reference outside its own file. Anything less becomes a finding in the report. Public exports of a library are left alone unless `allowPublicApiChanges` is set. Dependency removals rest on triple agreement alone: the installed copy is still in `node_modules` during the checks, so tests can't catch a dependency that is actually used. The report marks them evidence-only.
- **Comment trimming is proven.** The code tokens before and after must be identical. Protected comments must survive: directives and pragmas, license headers, TODOs, anything with `@` or `#`, and JSDoc blocks in a library's public files.
- **Claude is confined to the repo.** It can read only inside the repository and write only the files a change allows. It can't read gitignored files such as `.env`. That check covers reads and searches aimed at a single file; a search over a whole directory isn't filtered per file.
- Markdown and other doc files (`*.md`, `*.mdx`, `*.rst`, `docs/`) are never edited.

## Status

Early release (Plan 1 of the roadmap). It covers dead code (unused files, exports and dependencies) and comments. Test writing, simplification and test pruning are planned.

## License

MIT
