# Increment: parity gaps, member listing, time reporting

- Date: 2026-09-02
- Status: approved
- Base: 36 tools, 382 tests, `ebaeae4`
- Type: increment on a reviewed codebase

## Why

Comparing this server against the vendor's hosted ClickUp MCP against the
live workspace surfaced two regressions and one structural problem, and the
ClickUp API turns out to support team time reporting we do not expose.

The comparison cost zero vendor requests: four of its responses were already
in context and were measured against the same operations here.

## What the comparison showed

Correctness matched on every overlapping field: same tasks, ids, statuses,
list assignment and tree shape. Payloads were 26 to 41 percent smaller,
from omitting null and empty fields and from not sending a task description
twice, as the vendor does (`markdown_description` plus `text_content`).

Two differences were regressions rather than savings:

1. `clickup_list_tasks` returns neither `priority` nor `assignees`. The
   vendor returns both. Answering "which of these is urgent, and who owns
   it" currently costs one `clickup_get_task` per row.
2. There is no way to list workspace members. `clickup_resolve_member`
   requires a non-empty query, so "who is in this workspace" can only be
   answered by guessing a substring that matches everyone.

One structural problem: Claude Code reads `structuredContent`, not the
rendered markdown. Every response in the comparison came back as JSON
despite `response_format` defaulting to markdown. So
`CLICKUP_MAX_RESPONSE_CHARS` currently bounds a channel the client does not
read, and the budget protects nothing where the tokens are actually spent.

## What the ClickUp API supports that we do not expose

Verified against the API reference, not assumed:

- `GET /team/{id}/time_entries` accepts `assignee` as a comma separated list
  of user ids, plus `is_billable`, `space_id`, `folder_id`, `list_id`,
  `include_location_names` and `include_task_tags`.
- Each returned entry carries a `user` object (id, username, email) that
  this server currently discards.
- `GET /task/{id}/time_in_status` and
  `GET /task/bulk_time_in_status/task_ids` give per-status durations. Both
  require the "Total time in Status" ClickApp to be enabled in the workspace.

And what it does not support, which bounds what we can promise:

- There is no public endpoint for the capacity behind ClickUp's Workload
  view. It is an open feature request. So this server can report hours
  logged, but a utilization percentage needs a capacity configured here.
- Whether a personal token may read another member's time entries is
  untested: the workspace has no time entries at all in the last 90 days,
  so an empty result is indistinguishable from a denied one. Resolve this
  against real data before promising team-wide reporting.

## Decisions

**Keep the markdown renderers.** Removing them is a large diff across seven
format files for no runtime gain in this client, and it takes away what does
reach a client that reads `content`. The renderers stay.

**Bound `structuredContent` at item granularity.** The final review ruled
"document, do not truncate" because truncating a payload would violate the
tool's own `outputSchema`. That reasoning holds for byte truncation and not
for item truncation: dropping whole items and flagging it keeps the payload
schema-valid. The existing truncation already works at item granularity, so
this extends a mechanism rather than inventing one. That ruling is revised.

**Report hours, not utilization, until a capacity exists.** Percentages
computed against a capacity nobody configured would be invented data.

## Scope

### Package A: parity and budget
- `priority` and `assignees` added to `TaskSummarySchema`, so
  `clickup_list_tasks`, `clickup_search_tasks` and `clickup_get_my_day`
  all gain them at once.
- New `clickup_list_members` (read): every workspace member, no query
  required.
- `structuredContent` bounded at item granularity by
  `CLICKUP_MAX_RESPONSE_CHARS`, with the same visible notice the rendered
  text already carries.

### Package B: time reporting
- `clickup_list_time_entries` gains `assignees` (multiple), `is_billable`,
  `space_id`, `folder_id`, `list_id`, and stops discarding the entry's user.
- New `clickup_time_report` (read): one call, a date range, totals grouped
  by member and optionally by list or space, with the billable share.
  Reports hours and shares. A percentage appears only if a weekly capacity
  is configured, and is absent otherwise rather than assumed.

### Package C: cycle time
- `clickup_get_task_time_in_status` and a bulk variant. Both must state
  plainly when the required ClickApp is disabled rather than returning an
  empty result, since an empty result would read as "no time in any status".

## Out of scope

The workspace seats endpoint. It describes the plan's licence count, not
anyone's workload.
