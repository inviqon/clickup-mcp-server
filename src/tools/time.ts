import { z } from 'zod'
import type { AnyToolDefinition, ToolDefinition } from '../core/registry.js'
import { formatDate, formatDurationHm, parseDuration, resolveDate } from '../core/dates.js'
import { toAgentMessage } from '../core/errors.js'
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
import { nameWithId, omitEmpty, paginate } from '../format/common.js'
import { formatTimeEntryLine, renderTimeEntryLines, timeEntryTaskLabel } from '../format/time.js'
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
      throw new Error(
        `A timer is already running on ${label}. Starting a new one would silently stop it in ClickUp and lose ` +
          'whatever time it has already tracked - that cannot be recovered afterward. Call clickup_stop_timer ' +
          'first if you want to stop it and start this one instead.',
      )
    }

    const started = await startTimerRaw(
      ctx,
      omitEmpty({
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
        omitEmpty({
          description: args.description,
          ...tagsBody(args.tags),
        }),
      )
      return toTimeEntryOut(updated, ctx.timezone)
    } catch (err) {
      throw new Error(
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
    const label = out.task_name !== undefined ? nameWithId(out.task_name, out.task_id ?? '') : 'no task'
    return `Timer running on ${label} - ${out.elapsed} elapsed, started ${out.start}.`
  },
}

// ---------------------------------------------------------------------------
// clickup_list_time_entries
// ---------------------------------------------------------------------------

const listTimeEntriesInputShape = {
  start_date: z.string().optional().describe('Defaults to 7 days ago when omitted'),
  end_date: z.string().optional().describe('Defaults to now when omitted'),
  assignee: z.string().optional().describe('User id; defaults to every entry visible to this token'),
  task_id: z.string().optional().describe('Restrict to entries logged against one task'),
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
    'paginated), rendered in "1h 30m" form.',
    'Examples: "how much time did I log this week", "show time entries on task 86abc since Monday".',
  ].join(' '),
  inputSchema: listTimeEntriesInputShape,
  outputSchema: listTimeEntriesOutputShape,
  handler: async (args, ctx) => {
    const limit = args.limit ?? 25
    const offset = args.offset ?? 0
    const now = Date.now()
    const usedDefaultRange = args.start_date === undefined && args.end_date === undefined

    const startMs =
      args.start_date !== undefined
        ? resolveDate(args.start_date, { timezone: ctx.timezone }).epochMs
        : resolveDate('7 days ago', { timezone: ctx.timezone, now: new Date(now) }).epochMs
    const endMs = args.end_date !== undefined ? resolveDate(args.end_date, { timezone: ctx.timezone }).epochMs : now
    const assigneeId = args.assignee !== undefined ? toAssigneeId(args.assignee) : undefined

    const entries = await listTimeEntriesRaw(ctx, { startMs, endMs, assignee: assigneeId, taskId: args.task_id })
    const outs = entries.map((e) => toTimeEntryOut(e, ctx.timezone))
    const page = paginate(outs, { offset, limit })

    // Totals exactly the entries shown on this page, not the whole
    // underlying range - `entries` and `outs` share index order, so the
    // same slice indices line up with `page.items`.
    const totalMs = entries
      .slice(offset, offset + limit)
      .reduce((sum, e) => sum + Math.abs(Number(e.duration)), 0)

    const startIso = formatDate(startMs, ctx.timezone)
    const endIso = formatDate(endMs, ctx.timezone)
    const range = usedDefaultRange ? `the last 7 days (${startIso} to ${endIso})` : `${startIso} to ${endIso}`

    return { range, ...page, total_duration: formatDurationHm(totalMs) }
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
      omitEmpty({
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
    // `omitEmpty`, rather than guessing a plausible `end` and risking a
    // fabricated value reaching ClickUp. If updating `start` alone (without
    // `duration`) 400s in practice, that is the sign this assumption is
    // wrong and `end` needs to be resolved from a prior read instead.
    const body = omitEmpty({
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

export const TIME_TOOLS: AnyToolDefinition[] = [
  startTimerTool,
  stopTimerTool,
  getCurrentTimerTool,
  listTimeEntriesTool,
  createTimeEntryTool,
  updateTimeEntryTool,
  deleteTimeEntryTool,
] as unknown as AnyToolDefinition[]
