# mrs-norris

mrs-norris shrinks AI-bloated repos. It has to pass its own inspection: code here meets the standard the tool enforces on everyone else.

- Design: `docs/superpowers/specs/2026-10-16-mrs-norris-design.md`
- Plans: `docs/superpowers/plans/`

## Standards for this repo

**Code**
- No dead code. Don't leave unused exports, parameters, branches, files or dependencies.
- No speculative abstraction. Don't add an interface, option, wrapper or helper until a second real caller exists.
- No defensive code for conditions that can't happen. Validate at boundaries such as config, CLI input and external tool output, then trust the types.
- Prefer the shortest clear version. Shorter but more cryptic isn't better.
- Add a dependency only when it replaces meaningful code you'd otherwise write.

**Comments**
- Comment only *why* something non-obvious is done. Never restate what the code does.
- Use JSDoc only on exports whose behavior isn't obvious from the name and types.

**Tests**
- Every test must be able to catch a bug that no other test catches. Merge near-duplicates with `test.each`.
- Test behavior through public interfaces. Mock only process and network boundaries (the Agent, external commands), never our own modules.
- Each assertion should check something meaningful. `toBeDefined()` on its own isn't a test.
- Keep test output pristine, with no stray logs or warnings.

**Process**
- Use TDD: write a failing test, implement, then see it pass.
- Make one logical change per commit, with a conventional-commit subject.
- Run `npm test && npm run typecheck` before committing.
