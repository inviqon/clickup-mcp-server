# ClickUp MCP evaluation set

`clickup-daily.xml` holds ten question/answer pairs used to check whether an
agent connected to this server, given only its tools, can navigate a real
ClickUp workspace to a correct answer. This is not a substitute for the unit
and integration tests under `tests/` - it is a small, human-legible check on
end-to-end tool usability against live data.

## Format

Each pair is:

```xml
<qa_pair>
  <question>...</question>
  <answer>...</answer>
</qa_pair>
```

`tests/evals.test.ts` enforces the structural rules the set must keep:
exactly ten pairs, a non-empty answer for every question, and no
time-relative wording (`today`, `yesterday`, `now`, `currently`, `running`,
`open task(s)`, `as of`, `this/last/next week`) that would make an answer
stop being reproducible.

Every pair also needs at least two tool calls to answer - one lookup to
find where something lives (`clickup_get_workspace_tree`), then a second to
inspect it (`clickup_get_list`, or a second `clickup_resolve_member` call
with a different query) or to disambiguate a member. A question answerable
from a single tool response is not a navigation test, it is a read test -
`tests/` already covers those.

## Scope

This set exercises workspace navigation and structure only:
`clickup_get_workspace_tree`, `clickup_get_list`, and `clickup_resolve_member`.
It does not cover task filtering, time entry aggregation, comments, tags, or
document lookup - most of the server's 36 tools are untouched by it. That is
deliberate, not an oversight: the workspace snapshot this set is pinned to
(see below) records structure, not task, time-entry, comment or doc content,
and task state is inherently unstable (open counts change, running timers
change) - exactly the kind of fact this set's own stability rule excludes.
Those tools are covered by the unit and integration tests under `tests/`
instead. Extending this set to cover them would need a stable, seeded
fixture workspace built for the purpose - real task/time/doc data in a real
workspace does not hold still long enough to pin an answer to it.

## Running the set

This repository does not ship an automated eval runner - the XML is meant to
be fed to an MCP-capable agent (for example through the MCP inspector, or a
harness such as the one described in Anthropic's MCP evaluation guide)
pointed at a running instance of this server. To run it by hand:

1. Start the server in read mode against the real workspace the set was
   written against:

   ```bash
   CLICKUP_API_KEY=pk_... \
   CLICKUP_TEAM_ID=9012428247 \
   CLICKUP_MCP_MODE=read \
   npm run inspect
   ```

   (`CLICKUP_MCP_MODE=read` is not required for correctness - every question
   here is read-only - but it keeps the run from being able to write
   anything by accident.)

2. For each `qa_pair` in `clickup-daily.xml`, give the agent only the
   `question` text and its tools, and compare its final answer to `answer`
   by exact string match (case-insensitive, whitespace-normalized is fine;
   anything else is a fail).

3. A pass rate below 10/10 on an unchanged workspace is a regression in tool
   design, response shape, or descriptions - not a reason to loosen an
   answer.

## Environment

Running the set for real needs:

- `CLICKUP_API_KEY` - a personal API token with read access to the
  workspace below.
- `CLICKUP_TEAM_ID` - `9012428247` (the workspace these questions were
  written against).

## Snapshot pinning

Every answer in `clickup-daily.xml` is pinned to a workspace snapshot taken
on **2026-09-02**. The questions cover structure that is expected to be
stable - space and folder counts, folder-to-list membership, list status
configuration, workspace membership - not task state, so they should keep
holding as people use the workspace day to day. They will **not** hold
across a reorganisation: renaming or moving a folder, adding or removing a
space, changing a list's statuses, or changing workspace membership all
invalidate the affected pairs.

If the workspace is reorganised, re-verify every pair against the live
workspace before trusting a red or green run, and update this note's
snapshot date along with any answer that changed. An eval suite whose
answers have silently drifted out of date is worse than no eval suite at
all - it fails a competent agent, or worse, passes a broken one.
