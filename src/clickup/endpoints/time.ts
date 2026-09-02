import type { ClickUpContext } from '../../core/context.js'
import { formatDate, formatDurationHm } from '../../core/dates.js'
import {
  EmptyResponseSchema,
  GetTimeEntriesResponseSchema,
  RunningTimeEntryResponseSchema,
  TimeEntryResponseSchema,
  type TimeEntry,
} from '../schemas.js'

// -- Raw endpoint calls ------------------------------------------------

/**
 * `GET /v2/team/{teamId}/time_entries/current` - the running timer, or
 * `null` when nothing is running. Exported so `clickup_get_my_day` (Task 15)
 * reuses this instead of re-implementing the same call.
 */
export async function getRunningEntry(ctx: ClickUpContext): Promise<TimeEntry | null> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/team/${ctx.teamId}/time_entries/current`,
    schema: RunningTimeEntryResponseSchema,
  })
  return res.data
}

export function startTimerRaw(ctx: ClickUpContext, body: Record<string, unknown>): Promise<TimeEntry> {
  return ctx.client.request({
    method: 'POST',
    path: `/team/${ctx.teamId}/time_entries/start`,
    schema: TimeEntryResponseSchema,
    body,
  })
}

/**
 * `POST /v2/team/{teamId}/time_entries/stop` takes no request body -
 * whatever is currently running simply stops. `clickup_stop_timer`'s own
 * description/tags parameters are applied afterward via
 * `updateTimeEntryRaw`, once the stopped entry's id is known.
 */
export function stopTimerRaw(ctx: ClickUpContext): Promise<TimeEntry> {
  return ctx.client.request({
    method: 'POST',
    path: `/team/${ctx.teamId}/time_entries/stop`,
    schema: TimeEntryResponseSchema,
  })
}

export type ListTimeEntriesFilter = {
  startMs?: number | undefined
  endMs?: number | undefined
  assignee?: number | undefined
  taskId?: string | undefined
}

/**
 * Deliberately a single request, no page-walking - unlike `listTasksRaw`
 * (src/clickup/endpoints/tasks.ts), which walks up to 5 upstream pages via
 * `walkTaskPages`. `GET /v2/team/{teamId}/time_entries` has no page
 * parameter at all; its result is bounded by the `start_date`/`end_date`
 * range instead, so there is no upstream page to walk here. The asymmetry
 * with `listTasksRaw` is intentional, not a gap this function forgot to
 * close.
 */
export async function listTimeEntriesRaw(ctx: ClickUpContext, filter: ListTimeEntriesFilter): Promise<TimeEntry[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/team/${ctx.teamId}/time_entries`,
    schema: GetTimeEntriesResponseSchema,
    query: {
      start_date: filter.startMs,
      end_date: filter.endMs,
      assignee: filter.assignee,
      task_id: filter.taskId,
    },
  })
  return res.data
}

export function createTimeEntryRaw(ctx: ClickUpContext, body: Record<string, unknown>): Promise<TimeEntry> {
  return ctx.client.request({
    method: 'POST',
    path: `/team/${ctx.teamId}/time_entries`,
    schema: TimeEntryResponseSchema,
    body,
  })
}

export function updateTimeEntryRaw(
  ctx: ClickUpContext,
  entryId: string,
  body: Record<string, unknown>,
): Promise<TimeEntry> {
  return ctx.client.request({
    method: 'PUT',
    path: `/team/${ctx.teamId}/time_entries/${entryId}`,
    schema: TimeEntryResponseSchema,
    body,
  })
}

export async function deleteTimeEntryRaw(ctx: ClickUpContext, entryId: string): Promise<void> {
  await ctx.client.request({
    method: 'DELETE',
    path: `/team/${ctx.teamId}/time_entries/${entryId}`,
    schema: EmptyResponseSchema,
  })
}

// -- Normalised projection ---------------------------------------------

/**
 * Every optional field is typed `T | undefined` rather than bare `?: T` -
 * the same `exactOptionalPropertyTypes` reasoning `TaskOut` documents in
 * src/clickup/endpoints/tasks.ts.
 */
export type TimeEntryOut = {
  id: string
  task_id?: string | undefined
  task_name?: string | undefined
  description?: string | undefined
  billable?: boolean | undefined
  tags?: string[] | undefined
  start: string
  end?: string | undefined
  duration: string
}

/**
 * Projects a raw `TimeEntry` into the compact shape every time tool
 * returns. `start`/`end` are always formatted through `formatDate` (never
 * ClickUp's raw epoch-millisecond string), and `duration` is always
 * formatted through `formatDurationHm` (never raw milliseconds) - the
 * timezone/duration-visibility rule this task exists to enforce. A running
 * entry's `duration` is negative per ClickUp's own convention; `Math.abs`
 * here is what turns "still running" into "elapsed so far" rather than a
 * duration formatter having to special-case sign on every call site.
 */
export function toTimeEntryOut(entry: TimeEntry, timezone: string): TimeEntryOut {
  const out: TimeEntryOut = {
    id: entry.id,
    start: formatDate(Number(entry.start), timezone),
    duration: formatDurationHm(Math.abs(Number(entry.duration))),
  }
  if (entry.task !== null && entry.task !== undefined) {
    out.task_id = entry.task.id
    out.task_name = entry.task.name
  }
  if (entry.description !== undefined && entry.description !== '') {
    out.description = entry.description
  }
  if (entry.billable !== undefined) {
    out.billable = entry.billable
  }
  if (entry.tags.length > 0) {
    out.tags = entry.tags.map((t) => t.name)
  }
  if (entry.end !== null && entry.end !== undefined) {
    out.end = formatDate(Number(entry.end), timezone)
  }
  return out
}
