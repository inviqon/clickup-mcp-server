# Reliability rules

These are the nine rules from section 7 of the design spec
(`docs/superpowers/specs/2026-09-02-clickup-mcp-server-design.md`). They are
requirements, not guidance: each one is meant to be enforced by at least one
test, not merely followed by convention. This document is that checklist,
kept honest - a rule is marked covered only where a real, currently-passing
test enforces it, named below by file and test title. A rule with no such
test is marked as such rather than left to look covered when it is not; that
distinction is the whole value of this document.

Run `npx vitest run <file>` to execute any test named below on its own.

## 1. API responses are parsed with zod

An unexpected shape from ClickUp raises a clear error instead of silently
rendering `undefined` somewhere downstream.

**Covered.**

- `tests/clickup/client.test.ts` - *"raises ClickUpSchemaError rather than
  returning an unvalidated payload"*
- `tests/core/errors.test.ts` - *"reports a schema mismatch as a server side
  problem, not an empty result"*

## 2. A missing value is omitted from the output

Never `N/A`, never a default, never a guess - a placeholder in output reads
to an agent as a fact.

**Covered.**

- `tests/format/common.test.ts` - *"drops undefined, null and empty string
  but keeps false and zero"* (`omitEmpty`) and *"skips entries with no value
  instead of printing a placeholder"* (`bulletList`)
- `tests/tools/tasks.test.ts` - *"omits an unset due date instead of printing
  a placeholder"* and *"omits due_date for a task that reports it as null"*
- `tests/tools/navigation.test.ts` - *"omits task_count for a folderless list
  that reports it as null, rather than inventing 0"*, *"omits due_date for a
  task that reports it as null, rather than printing null"* and *"omits the
  options key for a dropdown field with an empty options array, rather than
  printing an empty list"*

## 3. Ids are copied verbatim from API responses and never constructed

**Covered.**

- `tests/format/common.test.ts` - *"renders the id verbatim next to the
  name"* (`nameWithId`)
- `tests/tools/navigation.test.ts` - *"copies ids verbatim from the API
  response rather than constructing them"*
- `tests/tools/tasks.test.ts` - *"copies the task id verbatim rather than
  constructing it"*

## 4. Ambiguity is surfaced, not resolved

`clickup_resolve_member("Tiemo")` returns every candidate rather than
silently picking the first match.

**Covered.**

- `tests/tools/navigation.test.ts`, `describe('clickup_resolve_member')` -
  *"returns every candidate rather than picking the first"* and *"renders
  every match with its email when the query is ambiguous, rather than
  silently narrowing to one"*

## 5. Empty results say so explicitly, naming the filter that produced them

**Covered.**

- `tests/tools/navigation.test.ts` - *"reports an empty result with the
  query that produced it"* (`clickup_search_tasks`)
- `tests/tools/tasks.test.ts` - *"reports an empty result naming the scope
  that produced it"* (`clickup_list_tasks`)

## 6. Errors never degrade into empty results

401, 403, 404 and 429 each produce a distinct message with a concrete next
step, rather than looking like "nothing found."

**Covered.**

- `tests/core/errors.test.ts` - *"maps 401 to a credential hint"*, *"maps
  403 to a workspace mismatch hint"*, *"maps 404 on a list to a discovery
  next step naming the id"*, *"names the reset time on a persistent 429"*

## 7. Resolved dates are echoed back in ISO form with offset

So a timezone mistake is visible rather than silent.

**Covered.**

- `tests/core/dates.test.ts` - *"renders with the timezone offset so
  mistakes are visible"* (`formatDate`) and *"resolves in-January to
  +01:00, proving the offset is not hardcoded"*
- `tests/tools/tasks.test.ts` - *"formats a present due_date with the
  configured timezone offset rather than raw epoch ms"*

## 8. Truncation is always announced along with the way to get the rest

**Covered.**

- `tests/format/common.test.ts` - *"announces truncation and names the way
  to get the rest"* (`truncateResponse`)
- `tests/server.test.ts` - *"truncates content over the configured character
  budget with a visible notice"*

## 9. All input schemas are strict

A mistyped parameter fails loudly instead of being silently ignored.

**Covered.**

- `tests/server.test.ts` - *"rejects an unknown argument instead of ignoring
  it"*

---

All nine rules currently have at least one enforcing test. If a future change
adds a tenth rule, or removes the test behind one of these nine, update this
file in the same change - an unenforced rule listed here as covered would be
exactly the kind of quiet drift reliability rule 1 exists to catch elsewhere
in this server.
