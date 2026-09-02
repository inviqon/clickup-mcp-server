# Contributing

## Setup

```bash
npm install
```

Requires Node.js 24 or newer (`engines.node` in `package.json`).

## Workflow

```bash
npm run typecheck   # tsc --noEmit over src/, scripts/ and tests/
npx vitest run       # the test suite
npx vitest run --coverage   # with the coverage report
npm run build         # tsc, emits dist/
npm run docs:tools    # build, then regenerate docs/TOOLS.md from ALL_TOOLS
```

All four should be clean before opening a change. In particular:

- `npm run typecheck` covers `src/`, `scripts/` and `tests/` together
  (`tsconfig.check.json`) - a type error in a test file fails it just as a
  type error in `src/` would.
- Coverage thresholds are enforced on `src/**/*.ts` only (see
  `vitest.config.ts`): statements 80, branches 75, functions 80, lines 80.
- `console.log` is forbidden under `src/` (`tests/stdout-guard.test.ts`
  scans for it) because anything written to stdout corrupts the stdio MCP
  protocol stream; use `console.error` there instead. `scripts/` is not
  under that guard - `scripts/generate-tool-docs.ts`'s entrypoint writes a
  confirmation line to stdout deliberately.

## Test-driven development

This project was built test-first and the pattern is meant to continue:
write the failing test before the implementation, run it to see it fail for
the reason you expect, then make it pass. Every reliability rule in
[`docs/RELIABILITY.md`](docs/RELIABILITY.md) is expected to have at least one
test enforcing it - if you add a new rule of that kind, add the test in the
same change and reference it there.

## Adding a tool

1. Add the schema, handler and `render` function to the relevant file in
   `src/tools/` (one file per category), following the `ToolDefinition`
   shape in `src/core/registry.ts`. Give the tool a `clickup_<verb>_<noun>`
   name and a description that states its purpose, its boundaries, and when
   to use a different tool instead - `tests/docs.test.ts` requires every
   description to be over 80 characters and to mention "Example" or "Use ".
2. Export it from that category's `_TOOLS` array and confirm it is included
   via `ALL_TOOLS` in `src/tools/index.ts`.
3. Add handler tests under `tests/tools/` against MSW-mocked ClickUp
   responses (see the existing files in that directory and the fixtures in
   `tests/fixtures/` for the pattern), and a `render` test as a pure
   function of a fixture output object.
4. Run `npm run docs:tools` to regenerate `docs/TOOLS.md`. Do not hand-edit
   that file - `tests/docs.test.ts` asserts it exactly matches
   `renderToolDocs(ALL_TOOLS)`, and a manual edit will simply be overwritten
   (or fail the drift test) the next time someone regenerates it.
5. If the tool is `admin` mode, or otherwise destructive, follow the
   pattern in `src/tools/structure.ts`'s delete tools: require a
   `confirm_name` argument checked against a freshly-fetched name before the
   delete call, not merely a bare id.

## Style

- ESM throughout (`"type": "module"`), TypeScript strict mode, no `any` in
  application code - use `unknown` and narrow it.
- A missing value is omitted from output, never rendered as a placeholder
  (`N/A`, `null`, a guessed default) - see reliability rule 2. Use
  `omitEmpty`/`bulletList` (`src/format/common.ts`) rather than
  reintroducing that decision per renderer.
- Plain ASCII in all prose and commit messages: no em dashes, en dashes or
  smart quotes.

## Pull requests

Describe what changed and why, list the tests that cover it, and confirm the
four commands above are clean. If you touched a tool's schema, mode or
description, confirm `npm run docs:tools` was run and `docs/TOOLS.md` is
part of the diff.
