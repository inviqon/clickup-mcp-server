import { z } from 'zod'
import type { AnyToolDefinition, ToolDefinition } from '../core/registry.js'
import type { ClickUpContext } from '../core/context.js'
import { formatDate, formatDurationHm, parseDuration, resolveDate } from '../core/dates.js'
import { ClickUpUsageError, toAgentMessage } from '../core/errors.js'
import {
  createTimeEntryRaw,
  deleteTimeEntryRaw,
  getRunningEntry,
  listTimeEntriesRaw,
  startTimerRaw,
  stopTimerRaw,
  toTimeEntryOut,
  updateTimeEntryRaw,
  type TimeEntryOut,
} from '../clickup/endpoints/time.js'
import { getTeamMembers } from '../clickup/endpoints/workspace.js'
import type { TimeEntry } from '../clickup/schemas.js'
import { nameWithId, omitEmpty, omitUnset, paginate } from '../format/common.js'
import { formatTimeEntryLine, renderTimeEntryLines, renderTimeReport, timeEntryTaskLabel } from '../format/time.js'
import { toAssigneeId } from './tasks.js'

/**
 * Shared by every tool that returns one whole time entry (start, stop,
 * create, update) so an entry looks the same regardless of which tool
 * produced it - the same role `taskDetailOutputShape` plays in tools/tasks.ts.
 */
const timeEntryOutputShape = {
  id: z.string(),
  task_id: z.string().optional(),
  task_name: z.string().optional(),
  description: z.string().optional(),
  billable: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  start: z.string(),
  end: z.string().optional(),
  duration: z.string(),
  user: z.object({ id: z.string(), username: z.string() }).optional(),
  list_id: z.string().optional(),
  list_name: z.string().optional(),
  space_id: z.string().optional(),
  space_name: z.string().optional(),
}

/**
 * ClickUp's own reference page for `GET /team/{teamId}/time_entries` states
 * plainly that only one of `space_id`, `folder_id`, `list_id` or `task_id`
 * may be given per request. Enforced here, before the request is sent,
 * rather than left for ClickUp to reject: per reliability rule 4, an
 * over-specified scope is an ambiguity ("which of these did you mean") this
 * server must surface, not silently resolve by picking one and dropping the
 * rest. Shared by `clickup_list_time_entries` and `clickup_time_report`,
 * the two tools that both hit this endpoint.
 */
function assertAtMostOneLocationFilter(args: {
  space_id?: string | undefined
  folder_id?: string | undefined
  list_id?: string | undefined
  task_id?: string | undefined
}): void {
  const given = [
    ['space_id', args.space_id] as const,
    ['folder_id', args.folder_id] as const,
    ['list_id', args.list_id] as const,
    ['task_id', args.task_id] as const,
  ].filter(([, value]) => value !== undefined)
  if (given.length > 1) {
    throw new ClickUpUsageError(
      `ClickUp accepts only one of space_id, folder_id, list_id, task_id per request, but got ` +
        `${given.map(([name, value]) => `${name}="${value}"`).join(' and ')}. Drop all but the one you mean.`,
    )
  }
}

/**
 * The date-range default `clickup_list_time_entries` and `clickup_time_report`
 * both use: the last 7 days when neither `start_date` nor `end_date` is
 * given. Factored out so the two tools cannot silently drift on what
 * "defaults the same way" means - B2's own requirement - and so `range`'s
 * wording ("the last 7 days (X to Y)" vs "X to Y") is generated in exactly
 * one place.
 */
function resolveEntriesRange(
  args: { start_date?: string | undefined; end_date?: string | undefined },
  ctx: ClickUpContext,
): { startMs: number; endMs: number; range: string } {
  const now = Date.now()
  const usedDefaultRange = args.start_date === undefined && args.end_date === undefined

  const startMs =
    args.start_date !== undefined
      ? resolveDate(args.start_date, { timezone: ctx.timezone }).epochMs
      : resolveDate('7 days ago', { timezone: ctx.timezone, now: new Date(now) }).epochMs
  const endMs = args.end_date !== undefined ? resolveDate(args.end_date, { timezone: ctx.timezone }).epochMs : now
  const startIso = formatDate(startMs, ctx.timezone)
  const endIso = formatDate(endMs, ctx.timezone)
  const range = usedDefaultRange ? `the last 7 days (${startIso} to ${endIso})` : `${startIso} to ${endIso}`
  return { startMs, endMs, range }
}

function tagsBody(tags: string[] | undefined): { tags: Array<{ name: string }>; tag_action: 'replace' } | undefined {
  if (tags === undefined) {
    return undefined
  }
  return { tags: tags.map((name) => ({ name })), tag_action: 'replace' }
}

// ---------------------------------------------------------------------------
// clickup_start_timer
// ---------------------------------------------------------------------------

const startTimerInputShape = {
  task_id: z.string().optional().describe('Task to track time against; omit to start an untracked entry'),
  description: z.string().optional(),
  billable: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
}

export const startTimerTool: ToolDefinition<typeof startTimerInputShape, typeof timeEntryOutputShape> = {
  name: 'clickup_start_timer',
  title: 'Start ClickUp Timer',
  category: 'time',
  mode: 'write',
  description: [
    'Start a ClickUp timer. Checks for a running timer FIRST and refuses to start a new one if it',
    'finds one: ClickUp silently stops whatever is already running the moment a new timer starts,',
    'and the time already tracked on it is not recoverable through the API afterward. Call',
    'clickup_stop_timer first if that is genuinely what you want. Every response states the resolved',
    'start time in the configured timezone, so a timezone mismatch is visible rather than silent.',
    'Examples: "start tracking time on task 86abc", "start an untracked timer for this call".',
  ].join(' '),
  inputSchema: startTimerInputShape,
  outputSchema: timeEntryOutputShape,
  handler: async (args, ctx) => {
    const running = await getRunningEntry(ctx)
    if (running !== null) {
      const label =
        running.task !== null && running.task !== undefined
          ? nameWithId(running.task.name, running.task.id)
          : `entry ${running.id}`
      throw new ClickUpUsageError(
        `A timer is already running on ${label}. Starting a new one would silently stop it in ClickUp and lose ` +
          'whatever time it has already tracked - that cannot be recovered afterward. Call clickup_stop_timer ' +
          'first if you want to stop it and start this one instead.',
      )
    }

    const started = await startTimerRaw(
      ctx,
      omitUnset({
        tid: args.task_id,
        description: args.description,
        billable: args.billable,
        tags: args.tags !== undefined ? args.tags.map((name) => ({ name })) : undefined,
      }),
    )
    return toTimeEntryOut(started, ctx.timezone)
  },
  render: (out) => [`Started ${timeEntryTaskLabel(out)} at ${out.start}.`, '', ...renderTimeEntryLines(out)].join('\n'),
}

// ---------------------------------------------------------------------------
// clickup_stop_timer
// ---------------------------------------------------------------------------

const stopTimerInputShape = {
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
}

export const stopTimerTool: ToolDefinition<typeof stopTimerInputShape, typeof timeEntryOutputShape> = {
  name: 'clickup_stop_timer',
  title: 'Stop ClickUp Timer',
  category: 'time',
  mode: 'write',
  description: [
    'Stop the currently running ClickUp timer. Optionally set its description and/or tags in the',
    'same call - ClickUp\'s own stop endpoint takes no such fields, so this applies them with a',
    'follow-up write once the stop is confirmed; if that follow-up write fails, the stop has already',
    'happened regardless (it cannot be rolled back), and the error says so rather than looking like',
    'the stop itself failed. Returns the resolved duration tracked, in "1h 30m" form.',
    'Examples: "stop the timer", "stop tracking and note that this was spent on code review".',
  ].join(' '),
  inputSchema: stopTimerInputShape,
  outputSchema: timeEntryOutputShape,
  handler: async (args, ctx) => {
    const stopped = await stopTimerRaw(ctx)
    const stoppedOut = toTimeEntryOut(stopped, ctx.timezone)

    // Gated on `!== undefined`, not truthiness/length: `tags: []` is an
    // explicit instruction to clear every tag, and is a different request
    // from not mentioning tags at all. Collapsing the two (as an earlier
    // version of this handler did, via `tags.length > 0`) silently dropped
    // that instruction - the caller believed the tags were cleared and
    // nothing said otherwise. `clickup_update_time_entry` below already
    // gets this right via `tagsBody`; this mirrors it.
    if (args.description === undefined && args.tags === undefined) {
      return stoppedOut
    }

    try {
      const updated = await updateTimeEntryRaw(
        ctx,
        stopped.id,
        omitUnset({
          description: args.description,
          ...tagsBody(args.tags),
        }),
      )
      return toTimeEntryOut(updated, ctx.timezone)
    } catch (err) {
      throw new ClickUpUsageError(
        `The timer stopped successfully (entry ${stopped.id}, ${stoppedOut.duration} tracked), but setting its ` +
          `description/tags afterward failed: ${toAgentMessage(err, { resource: 'time entry', id: stopped.id })} ` +
          'The stop already happened in ClickUp and cannot be undone - check the entry with ' +
          'clickup_list_time_entries before retrying.',
      )
    }
  },
  render: (out) => [`Stopped ${timeEntryTaskLabel(out)} - ${out.duration} tracked.`, '', ...renderTimeEntryLines(out)].join('\n'),
}

// ---------------------------------------------------------------------------
// clickup_get_current_timer
// ---------------------------------------------------------------------------

const getCurrentTimerInputShape = {}

const getCurrentTimerOutputShape = {
  running: z.boolean(),
  id: z.string().optional(),
  task_id: z.string().optional(),
  task_name: z.string().optional(),
  description: z.string().optional(),
  billable: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  start: z.string().optional(),
  elapsed: z.string().optional(),
}

export const getCurrentTimerTool: ToolDefinition<typeof getCurrentTimerInputShape, typeof getCurrentTimerOutputShape> = {
  name: 'clickup_get_current_timer',
  title: 'Get Current ClickUp Timer',
  category: 'time',
  mode: 'read',
  description: [
    'Check whether a ClickUp timer is currently running, and if so, on which task and for how long',
    'so far ("1h 23m" form, not raw milliseconds). States plainly when nothing is running instead of',
    'returning an empty result - always safe to call before clickup_start_timer to avoid the running-',
    'timer guard rejecting the call.',
    'Examples: "is a timer running right now", "what am I currently tracking time on".',
  ].join(' '),
  inputSchema: getCurrentTimerInputShape,
  outputSchema: getCurrentTimerOutputShape,
  handler: async (_args, ctx) => {
    const running = await getRunningEntry(ctx)
    if (running === null) {
      return { running: false }
    }
    const out = toTimeEntryOut(running, ctx.timezone)
    return {
      running: true,
      ...omitEmpty({
        id: out.id,
        task_id: out.task_id,
        task_name: out.task_name,
        description: out.description,
        billable: out.billable,
        tags: out.tags,
        start: out.start,
        elapsed: out.duration,
      }),
    }
  },
  render: (out) => {
    if (!out.running) {
      return 'No timer is currently running.'
    }
    return `Timer running on ${timeEntryTaskLabel(out)} - ${out.elapsed} elapsed, started ${out.start}.`
  },
}

// ---------------------------------------------------------------------------
// clickup_list_time_entries
// ---------------------------------------------------------------------------

const listTimeEntriesInputShape = {
  start_date: z.string().optional().describe('Defaults to 7 days ago when omitted'),
  end_date: z.string().optional().describe('Defaults to now when omitted'),
  assignees: z
    .array(z.string())
    .optional()
    .describe(
      'User ids; defaults to every entry visible to this token. Sent to ClickUp as one comma separated list.',
    ),
  task_id: z.string().optional().describe('Restrict to entries logged against one task'),
  space_id: z
    .string()
    .optional()
    .describe('Restrict to entries under one space. At most one of space_id/folder_id/list_id/task_id may be given.'),
  folder_id: z
    .string()
    .optional()
    .describe('Restrict to entries under one folder. At most one of space_id/folder_id/list_id/task_id may be given.'),
  list_id: z
    .string()
    .optional()
    .describe('Restrict to entries under one list. At most one of space_id/folder_id/list_id/task_id may be given.'),
  is_billable: z.boolean().optional().describe('true for billable entries only, false for non-billable only'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
}

const listTimeEntriesOutputShape = {
  range: z.string(),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  items: z.array(z.object(timeEntryOutputShape)),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
  total_duration: z.string(),
}

export const listTimeEntriesTool: ToolDefinition<typeof listTimeEntriesInputShape, typeof listTimeEntriesOutputShape> = {
  name: 'clickup_list_time_entries',
  title: 'List ClickUp Time Entries',
  category: 'time',
  mode: 'read',
  description: [
    'List time entries in a date range, defaulting to the last 7 days when neither start_date nor',
    'end_date is given - the output always states which range it actually used, so a caller never',
    'has to guess. Totals the duration of the entries shown (not the whole underlying range if it is',
    'paginated), rendered in "1h 30m" form. Each entry carries who logged it, and its list/space when',
    'ClickUp reports one. Scope with at most one of space_id/folder_id/list_id/task_id - ClickUp',
    'accepts only one at a time.',
    'Examples: "how much time did I log this week", "show time entries on task 86abc since Monday".',
  ].join(' '),
  inputSchema: listTimeEntriesInputShape,
  outputSchema: listTimeEntriesOutputShape,
  handler: async (args, ctx) => {
    assertAtMostOneLocationFilter(args)
    const limit = args.limit ?? 25
    const offset = args.offset ?? 0
    const { startMs, endMs, range: resolvedRange } = resolveEntriesRange(args, ctx)
    const assigneeIds = args.assignees !== undefined ? args.assignees.map(toAssigneeId) : undefined

    const entries = await listTimeEntriesRaw(ctx, {
      startMs,
      endMs,
      assigneeIds,
      taskId: args.task_id,
      spaceId: args.space_id,
      folderId: args.folder_id,
      listId: args.list_id,
      isBillable: args.is_billable,
    })
    const outs = entries.map((e) => toTimeEntryOut(e, ctx.timezone))
    const page = paginate(outs, { offset, limit })

    // Totals exactly the entries shown on this page, not the whole
    // underlying range - `entries` and `outs` share index order, so the
    // same slice indices line up with `page.items`.
    const totalMs = entries
      .slice(offset, offset + limit)
      .reduce((sum, e) => sum + Math.abs(Number(e.duration)), 0)

    return { range: resolvedRange, ...page, total_duration: formatDurationHm(totalMs) }
  },
  render: (out) => {
    if (out.items.length === 0) {
      return `No time entries found for ${out.range}.`
    }
    return [
      `# Time entries for ${out.range}`,
      '',
      `Showing ${out.count} of ${out.total}${out.has_more ? ' (more available, pass a higher offset)' : ''}`,
      `Total: ${out.total_duration}`,
      '',
      ...out.items.map((e: TimeEntryOut) => formatTimeEntryLine(e)),
    ].join('\n')
  },
}

// ---------------------------------------------------------------------------
// clickup_create_time_entry
// ---------------------------------------------------------------------------

const createTimeEntryInputShape = {
  task_id: z.string().optional(),
  start: z.string().describe('Natural language or ISO date/time, e.g. "today 09:00" or an ISO timestamp'),
  duration: z.string().describe('Milliseconds, or a human form like "1h30m", "45m", "2h"'),
  description: z.string().optional(),
  billable: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
}

export const createTimeEntryTool: ToolDefinition<typeof createTimeEntryInputShape, typeof timeEntryOutputShape> = {
  name: 'clickup_create_time_entry',
  title: 'Create ClickUp Time Entry',
  category: 'time',
  mode: 'write',
  description: [
    'Log a completed block of time, for work already done rather than tracked live - use',
    'clickup_start_timer/clickup_stop_timer for that instead. start accepts natural language',
    '("today 09:00") or ISO; duration accepts milliseconds or a human form ("1h30m", "45m"). An',
    'unparseable duration is rejected outright rather than silently logging zero. The response',
    'echoes the resolved start time (with timezone offset) and duration ("1h 30m" form), so a',
    'timezone or unit mistake is visible immediately.',
    'Examples: "log 1h30m on task 86abc starting at 9am today", "add a 45 minute entry for',
    'yesterday\'s standup, billable".',
  ].join(' '),
  inputSchema: createTimeEntryInputShape,
  outputSchema: timeEntryOutputShape,
  handler: async (args, ctx) => {
    const startMs = resolveDate(args.start, { timezone: ctx.timezone }).epochMs
    const durationMs = parseDuration(args.duration)

    const created = await createTimeEntryRaw(
      ctx,
      omitUnset({
        tid: args.task_id,
        start: startMs,
        duration: durationMs,
        description: args.description,
        billable: args.billable,
        tags: args.tags !== undefined ? args.tags.map((name) => ({ name })) : undefined,
      }),
    )
    return toTimeEntryOut(created, ctx.timezone)
  },
  render: (out) => [`Logged ${out.duration} on ${timeEntryTaskLabel(out)}.`, '', ...renderTimeEntryLines(out)].join('\n'),
}

// ---------------------------------------------------------------------------
// clickup_update_time_entry
// ---------------------------------------------------------------------------

const updateTimeEntryInputShape = {
  entry_id: z.string(),
  start: z.string().optional(),
  duration: z.string().optional(),
  description: z.string().optional(),
  billable: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
}

export const updateTimeEntryTool: ToolDefinition<typeof updateTimeEntryInputShape, typeof timeEntryOutputShape> = {
  name: 'clickup_update_time_entry',
  title: 'Update ClickUp Time Entry',
  category: 'time',
  mode: 'write',
  description: [
    'Update fields on an existing time entry - only the fields you pass are changed. tags, when',
    'given, REPLACE the entry\'s current tags rather than adding to them. duration accepts',
    'milliseconds or a human form ("1h30m"); an unparseable value is rejected rather than silently',
    'applying zero. Returns the entry as ClickUp reports it afterward, with the resolved start time',
    'and duration echoed in the response.',
    'Examples: "change time entry 123 to billable", "fix time entry 123\'s duration to 45m".',
  ].join(' '),
  inputSchema: updateTimeEntryInputShape,
  outputSchema: timeEntryOutputShape,
  handler: async (args, ctx) => {
    // Open question, unverified against a live ClickUp account: ClickUp's
    // own "Update a Time Entry" reference page documents `start` as
    // requiring `end` to be supplied alongside it, but this server has no
    // way to know an entry's current `end` before writing (there is no
    // "get one time entry by id" endpoint to read it back first), and this
    // tool's own input schema only takes `start`/`duration`, not `end`.
    // Deliberate choice: send exactly the fields the caller gave, via
    // `omitUnset`, rather than guessing a plausible `end` and risking a
    // fabricated value reaching ClickUp. If updating `start` alone (without
    // `duration`) 400s in practice, that is the sign this assumption is
    // wrong and `end` needs to be resolved from a prior read instead.
    const body = omitUnset({
      start: args.start !== undefined ? resolveDate(args.start, { timezone: ctx.timezone }).epochMs : undefined,
      duration: args.duration !== undefined ? parseDuration(args.duration) : undefined,
      description: args.description,
      billable: args.billable,
      ...tagsBody(args.tags),
    })
    const updated = await updateTimeEntryRaw(ctx, args.entry_id, body)
    return toTimeEntryOut(updated, ctx.timezone)
  },
  render: (out) => [`Updated time entry ${out.id}.`, '', ...renderTimeEntryLines(out)].join('\n'),
}

// ---------------------------------------------------------------------------
// clickup_delete_time_entry
// ---------------------------------------------------------------------------

const deleteTimeEntryInputShape = {
  entry_id: z.string(),
}

const deleteTimeEntryOutputShape = {
  entry_id: z.string(),
  deleted: z.boolean(),
}

export const deleteTimeEntryTool: ToolDefinition<typeof deleteTimeEntryInputShape, typeof deleteTimeEntryOutputShape> = {
  name: 'clickup_delete_time_entry',
  title: 'Delete ClickUp Time Entry',
  category: 'time',
  mode: 'admin',
  description: [
    'Permanently delete a time entry. This cannot be undone through this server. Only available in',
    'admin mode.',
    'Examples: "delete time entry 123", "remove the duplicate time entry I just logged".',
  ].join(' '),
  inputSchema: deleteTimeEntryInputShape,
  outputSchema: deleteTimeEntryOutputShape,
  handler: async (args, ctx) => {
    await deleteTimeEntryRaw(ctx, args.entry_id)
    return { entry_id: args.entry_id, deleted: true }
  },
  render: (out) => `Time entry ${out.entry_id} deleted.`,
}

// ---------------------------------------------------------------------------
// clickup_time_report
// ---------------------------------------------------------------------------

const timeReportInputShape = {
  start_date: z.string().optional().describe('Defaults to 7 days ago when omitted'),
  end_date: z.string().optional().describe('Defaults to now when omitted'),
  assignees: z
    .array(z.string())
    .optional()
    .describe(
      'User ids to report on; defaults to every entry visible to this token. A member in this list ' +
        'with no visible entries is reported explicitly rather than as 0h - see the tool description.',
    ),
  space_id: z
    .string()
    .optional()
    .describe('Restrict to entries under one space. At most one of space_id/folder_id/list_id may be given.'),
  folder_id: z
    .string()
    .optional()
    .describe('Restrict to entries under one folder. At most one of space_id/folder_id/list_id may be given.'),
  list_id: z
    .string()
    .optional()
    .describe('Restrict to entries under one list. At most one of space_id/folder_id/list_id may be given.'),
  group_by: z.enum(['member', 'list', 'space']).default('member').describe('How to bucket the totals'),
  weekly_capacity_hours: z
    .number()
    .positive()
    .optional()
    .describe(
      'A member\'s capacity in hours per week. Only valid with group_by "member" - a list or space has no ' +
        'capacity of its own. When given, each member row also reports a utilization percentage, the ' +
        'reported total pro-rated against this capacity across the requested range. Omitted entirely, never ' +
        'assumed, when this is not given.',
    ),
}

/**
 * One report row - a member, list or space, depending on `group_by`.
 *
 * `note` is the ambiguity channel for reliability rule 4: present, with
 * every numeric field genuinely absent (never `0`), on a row for a member
 * that was explicitly requested via `assignees` but has no entries visible
 * to this token in the requested range/scope. Absent on every ordinary row.
 */
const timeReportGroupOutputShape = {
  key: z.string(),
  label: z.string(),
  entry_count: z.number().optional(),
  total_duration: z.string().optional(),
  billable_duration: z.string().optional(),
  billable_share: z.string().optional(),
  utilization: z.string().optional(),
  note: z.string().optional(),
}

/**
 * Declared explicitly (not left to be inferred from `[...realGroups, ...ambiguousGroups]`)
 * so both arrays build the exact same shape: without it, TypeScript infers
 * each array's element type from its own object literals, and merging two
 * differently-shaped literal types via spread produces a union that
 * `exactOptionalPropertyTypes` then rejects as "possibly literally
 * `undefined`" even though neither array ever sets a key to `undefined` -
 * they simply omit keys they do not have.
 */
type TimeReportGroupOut = z.infer<z.ZodObject<typeof timeReportGroupOutputShape>>

const timeReportOverallOutputShape = {
  entry_count: z.number().optional(),
  total_duration: z.string().optional(),
  billable_duration: z.string().optional(),
  billable_share: z.string().optional(),
  note: z.string().optional(),
}

const timeReportOutputShape = {
  range: z.string(),
  group_by: z.enum(['member', 'list', 'space']),
  groups: z.array(z.object(timeReportGroupOutputShape)),
  overall: z.object(timeReportOverallOutputShape),
  weekly_capacity_hours: z.number().optional(),
}

/**
 * A percentage of `part` within `total`, rounded to the nearest whole
 * number and rendered "48%". `total` is required to be positive by every
 * call site (a real group's `totalMs`, or the overall total when
 * `entries.length > 0`) - a group with zero entries never reaches this
 * function, so there is no silent 0/0 case to guard against here.
 */
function formatPercent(part: number, total: number): string {
  return `${Math.round((part / total) * 100)}%`
}

/**
 * `weeklyCapacityHours` pro-rated across the requested range (which may be
 * shorter or longer than a week), then `totalMs` reported as a percentage
 * of it. `rangeMs` of zero or less (a degenerate/reversed range) yields no
 * capacity to divide by - `undefined`, not a divide-by-zero `Infinity%`.
 */
function utilizationPercent(totalMs: number, weeklyCapacityHours: number, rangeMs: number): string | undefined {
  if (rangeMs <= 0) {
    return undefined
  }
  const rangeDays = rangeMs / 86_400_000
  const capacityMs = weeklyCapacityHours * 3_600_000 * (rangeDays / 7)
  if (capacityMs <= 0) {
    return undefined
  }
  return formatPercent(totalMs, capacityMs)
}

type ReportGroupKey = { key: string; label: string }

/**
 * The bucket a given entry belongs to for `group_by`. `undefined` for
 * `group_by: 'member'` on an entry with no `user` (not expected from a real
 * ClickUp response - every entry this endpoint returns carries one - but a
 * schema-valid response is not guaranteed to carry every optional field,
 * and an entry this server cannot attribute to anyone must not silently
 * join whichever bucket happens to run first). "no list"/"no space" is a
 * real, named bucket rather than the same `undefined` treatment: an
 * untracked entry (no task) genuinely has no list or space, which is a
 * fact worth a row of its own, not a missing attribution.
 */
function groupKeyFor(entry: TimeEntry, groupBy: 'member' | 'list' | 'space'): ReportGroupKey | undefined {
  if (groupBy === 'member') {
    if (entry.user === undefined) {
      return undefined
    }
    return { key: entry.user.id, label: entry.user.username }
  }
  if (groupBy === 'list') {
    const listId = entry.task_location?.list_id
    return listId !== undefined
      ? { key: listId, label: entry.task_location?.list_name ?? listId }
      : { key: '(none)', label: 'No list' }
  }
  const spaceId = entry.task_location?.space_id
  return spaceId !== undefined
    ? { key: spaceId, label: entry.task_location?.space_name ?? spaceId }
    : { key: '(none)', label: 'No space' }
}

function describeScope(args: { space_id?: string | undefined; folder_id?: string | undefined; list_id?: string | undefined }): string {
  if (args.list_id !== undefined) {
    return ` in list ${args.list_id}`
  }
  if (args.folder_id !== undefined) {
    return ` in folder ${args.folder_id}`
  }
  if (args.space_id !== undefined) {
    return ` in space ${args.space_id}`
  }
  return ''
}

const NO_VISIBILITY_EXPLANATION =
  'This can mean nothing was tracked for them in this range, or this token cannot read their entries - ' +
  'it is not established whether a personal API token may read another member\'s time entries.'

export const timeReportTool: ToolDefinition<typeof timeReportInputShape, typeof timeReportOutputShape> = {
  name: 'clickup_time_report',
  title: 'ClickUp Time Report',
  category: 'time',
  mode: 'read',
  description: [
    'One call for totals grouped by member (default), list or space over a date range - the report',
    'this server exists to answer "who logged how much time, and how much of it was billable" without',
    'walking clickup_list_time_entries by hand. Defaults to the last 7 days exactly as',
    'clickup_list_time_entries does, and always states the range used. Reports HOURS LOGGED only -',
    'ClickUp has no public endpoint for the capacity behind its Workload view, so no utilization',
    'percentage is computed unless you supply weekly_capacity_hours yourself, pro-rated across the',
    'requested range; without it, the field is simply absent, never zero or invented. A member named',
    'in assignees who comes back with no visible entries is reported as an explicit ambiguity (nothing',
    'tracked, or this token lacks permission to see them), never as a bare "0h" - a member you did not',
    'ask about simply does not appear. Rendered as one compact table, not one line per entry.',
    'Examples: "how much time did the team log this month, by person", "billable hours per list last',
    'week", "did Arian log any time in the last 30 days".',
  ].join(' '),
  inputSchema: timeReportInputShape,
  outputSchema: timeReportOutputShape,
  handler: async (args, ctx) => {
    assertAtMostOneLocationFilter({ space_id: args.space_id, folder_id: args.folder_id, list_id: args.list_id })
    const groupBy = args.group_by ?? 'member'
    if (args.weekly_capacity_hours !== undefined && groupBy !== 'member') {
      throw new ClickUpUsageError(
        `weekly_capacity_hours only applies when group_by is "member" - capacity belongs to a person, not a ` +
          `${groupBy}. Drop weekly_capacity_hours, or set group_by to "member".`,
      )
    }

    const { startMs, endMs, range } = resolveEntriesRange(args, ctx)
    const rangeMs = endMs - startMs
    const requestedAssigneeIds = args.assignees !== undefined ? args.assignees.map(toAssigneeId) : undefined

    const entries = await listTimeEntriesRaw(ctx, {
      startMs,
      endMs,
      assigneeIds: requestedAssigneeIds,
      spaceId: args.space_id,
      folderId: args.folder_id,
      listId: args.list_id,
    })

    const presentUserIds = new Set(entries.map((e) => e.user?.id).filter((id): id is string => id !== undefined))
    const ambiguousRequestedIds =
      requestedAssigneeIds !== undefined
        ? requestedAssigneeIds.map(String).filter((id) => !presentUserIds.has(id))
        : []

    type Bucket = { label: string; totalMs: number; billableMs: number; count: number }
    const buckets = new Map<string, Bucket>()
    for (const entry of entries) {
      const groupKey = groupKeyFor(entry, groupBy)
      if (groupKey === undefined) {
        continue
      }
      const durationMs = Math.abs(Number(entry.duration))
      const bucket = buckets.get(groupKey.key) ?? { label: groupKey.label, totalMs: 0, billableMs: 0, count: 0 }
      bucket.totalMs += durationMs
      if (entry.billable === true) {
        bucket.billableMs += durationMs
      }
      bucket.count += 1
      buckets.set(groupKey.key, bucket)
    }

    const realGroups: TimeReportGroupOut[] = Array.from(buckets.entries())
      .sort(([, a], [, b]) => b.totalMs - a.totalMs)
      .map(([key, b]) => ({
        key,
        label: b.label,
        entry_count: b.count,
        total_duration: formatDurationHm(b.totalMs),
        billable_duration: formatDurationHm(b.billableMs),
        ...(b.totalMs > 0 ? { billable_share: formatPercent(b.billableMs, b.totalMs) } : {}),
        ...(groupBy === 'member' && args.weekly_capacity_hours !== undefined
          ? omitEmpty({ utilization: utilizationPercent(b.totalMs, args.weekly_capacity_hours, rangeMs) })
          : {}),
      }))

    let ambiguousGroups: TimeReportGroupOut[] = []
    if (groupBy === 'member' && ambiguousRequestedIds.length > 0) {
      const members = await getTeamMembers(ctx)
      const nameById = new Map(members.map((m) => [m.id, m.username]))
      ambiguousGroups = ambiguousRequestedIds.map((id) => ({
        key: id,
        label: nameById.get(id) ?? `user ${id}`,
        note: `No time entries were visible for this member in ${range}. ${NO_VISIBILITY_EXPLANATION}`,
      }))
    }

    const groups = [...realGroups, ...ambiguousGroups]

    const overall: z.infer<z.ZodObject<typeof timeReportOverallOutputShape>> =
      entries.length === 0
        ? {
            note:
              ambiguousRequestedIds.length > 0
                ? `No time entries were visible for the requested member(s) in ${range}. ${NO_VISIBILITY_EXPLANATION}`
                : `No time entries found for ${range}${describeScope(args)}.`,
          }
        : (() => {
            const overallTotalMs = entries.reduce((sum, e) => sum + Math.abs(Number(e.duration)), 0)
            const overallBillableMs = entries
              .filter((e) => e.billable === true)
              .reduce((sum, e) => sum + Math.abs(Number(e.duration)), 0)
            return {
              entry_count: entries.length,
              total_duration: formatDurationHm(overallTotalMs),
              billable_duration: formatDurationHm(overallBillableMs),
              ...(overallTotalMs > 0 ? { billable_share: formatPercent(overallBillableMs, overallTotalMs) } : {}),
              ...(ambiguousRequestedIds.length > 0 && groupBy !== 'member'
                ? {
                    note:
                      `No entries were visible for requested member id(s) ${ambiguousRequestedIds.join(', ')} - ` +
                      NO_VISIBILITY_EXPLANATION,
                  }
                : {}),
            }
          })()

    return {
      range,
      group_by: groupBy,
      groups,
      overall,
      ...(args.weekly_capacity_hours !== undefined ? { weekly_capacity_hours: args.weekly_capacity_hours } : {}),
    }
  },
  render: (out) => renderTimeReport(out),
}

export const TIME_TOOLS: AnyToolDefinition[] = [
  startTimerTool,
  stopTimerTool,
  getCurrentTimerTool,
  listTimeEntriesTool,
  createTimeEntryTool,
  updateTimeEntryTool,
  deleteTimeEntryTool,
  timeReportTool,
] as unknown as AnyToolDefinition[]
