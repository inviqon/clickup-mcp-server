# ClickUp MCP evaluation set

The evaluation set is ten question/answer pairs used to check whether an agent
connected to this server, given only its tools, can navigate a real ClickUp
workspace to a correct answer. This is not a substitute for the unit and
integration tests under `tests/` - it is a small, human-legible check on
end-to-end tool usability against live data.

## What is committed, and what is not

Only `clickup-daily.template.xml` is in the repository. It carries the
structure and ten placeholder questions, and no workspace data at all.

The filled set, `clickup-daily.xml`, is deliberately **not** committed and is
listed in `.gitignore`. A real set names real spaces, folders, lists and
workspace members, and this repository ships an MIT `LICENSE` and a
`CONTRIBUTING.md` - it is being prepared for publication. Client structure and
colleagues' names are not publishable, and a workspace id in a public README
is an invitation to probe it.

## Generating your own set

1. Copy the template:

   ```bash
   cp evals/clickup-daily.template.xml evals/clickup-daily.xml
   ```

2. Replace every `ALL_CAPS` placeholder with a real value read from your own
   workspace, and fill each `<answer>` by actually running the lookup - not
   from memory. An answer that has silently drifted out of date is worse than
   no eval suite at all: it fails a competent agent, or worse, passes a
   broken one.

3. Record the date you pinned the answers on, and re-verify them after any
   workspace reorganisation. Renaming or moving a folder, adding or removing
   a space, changing a list's statuses, or changing workspace membership all
   invalidate the affected pairs.

## Format

Each pair is:

```xml
<qa_pair>
  <question>...</question>
  <answer>...</answer>
</qa_pair>
```

`tests/evals.test.ts` enforces the structural rules against the committed
template: exactly ten pairs, a non-empty answer for every question, and no
time-relative wording (`today`, `yesterday`, `now`, `currently`, `running`,
`open task(s)`, `as of`, `this/last/next week`) that would make an answer stop
being reproducible.

Two further rules the test cannot check, both from spec section 12:

- **Every pair needs at least two tool calls** - one lookup to find where
  something lives (`clickup_get_workspace_tree`), then a second to inspect it
  (`clickup_get_list`, or a second `clickup_resolve_member` call). A question
  answerable from a single tool response is not a navigation test, it is a
  read test, and `tests/` already covers those.
- **Every pair must be independent.** Ten questions that all resolve to the
  same two facts about the same list measure one fact ten times. The
  template's ten slots are deliberately spread across different spaces,
  folders, lists and members; keep that spread when you fill them.

## Scope

This set exercises workspace navigation and structure only:
`clickup_get_workspace_tree`, `clickup_get_list`, and
`clickup_resolve_member`. It does not cover task filtering, time entry
aggregation, comments, tags, or document lookup - most of the server's 36
tools are untouched by it.

That is a real limitation, not a design win. Extending the set to cover those
tools needs a **stable, seeded fixture workspace built for the purpose**: real
task, time-entry, comment and doc data in a working workspace does not hold
still long enough to pin an answer to it, and task state (open counts, running
timers) is exactly the kind of fact this set's own stability rule excludes.
Until such a fixture workspace exists, those tools are covered by the unit and
integration tests under `tests/` alone.

## Running the set

This repository does not ship an automated eval runner - the XML is meant to
be fed to an MCP-capable agent (for example through the MCP inspector, or a
harness such as the one described in Anthropic's MCP evaluation guide)
pointed at a running instance of this server. To run it by hand:

1. Start the server in read mode against the workspace you filled the set
   against:

   ```bash
   CLICKUP_API_KEY=pk_... \
   CLICKUP_TEAM_ID=<your workspace id> \
   CLICKUP_MCP_MODE=read \
   npm run inspect
   ```

   (`CLICKUP_MCP_MODE=read` is not required for correctness - every question
   should be read-only - but it keeps the run from being able to write
   anything by accident.)

2. For each `qa_pair` in your `clickup-daily.xml`, give the agent only the
   `question` text and its tools, and compare its final answer to `answer` by
   exact string match (case-insensitive, whitespace-normalized is fine;
   anything else is a fail).

3. A pass rate below 10/10 on an unchanged workspace is a regression in tool
   design, response shape, or descriptions - not a reason to loosen an
   answer.

## Environment

Running the set for real needs:

- `CLICKUP_API_KEY` - a personal API token with read access to the workspace
  you filled the set against.
- `CLICKUP_TEAM_ID` - that workspace's id. Read it from
  `clickup_get_workspace_tree`, or from the ClickUp URL; it is not recorded
  here on purpose.
