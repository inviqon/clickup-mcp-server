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
  /**
   * User ids to filter by. ClickUp's own reference page for this endpoint
   * documents `assignee` as a SINGLE query parameter carrying a comma
   * separated list ("assignee=1234,9876"), not one repeated `assignee`
   * param per id - unlike this server's `space_ids[]`/`list_ids[]` style
   * elsewhere (`getWorkspaceTasks`, src/clickup/endpoints/workspace.ts).
   * Joined into that one string here, not left to `ClickUpClient`'s own
   * array handling, which would produce the wrong wire format for this
   * endpoint specifically. Ignored when `allMembers` is set - the two are
   * mutually exclusive at the tool layer (src/tools/time.ts), and this
   * function trusts that has already been enforced.
   */
  assigneeIds?: number[] | undefined
  /**
   * Sends `assignee=any`, ClickUp's own documented sentinel for "every
   * member", instead of the caller's own entries alone - the default this
   * endpoint applies when `assignee` is omitted entirely. This is passed
   * as its own flag, never as a value inside `assigneeIds`: `assigneeIds`
   * goes through `toAssigneeId` (src/tools/tasks.ts), whose numeric guard
   * exists to catch a mistyped id before it silently serialises to `null`
   * on a task-assignment write - a guard that has no reason to reject a
   * word ClickUp itself defines as meaningful on a read-only query.
   */
  allMembers?: boolean | undefined
  isBillable?: boolean | undefined
  spaceId?: string | undefined
  folderId?: string | undefined
  listId?: string | undefined
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
 *
 * `include_location_names` is always sent as `true`: `clickup_list_time_entries`
 * needs it to surface an entry's list/space (B1), and `clickup_time_report`
 * needs it to group by list or space (B2) - both consumers of this one
 * function want it every time, so it is not threaded through as a filter
 * option that every caller would just set to `true` anyway.
 */
export async function listTimeEntriesRaw(ctx: ClickUpContext, filter: ListTimeEntriesFilter): Promise<TimeEntry[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/team/${ctx.teamId}/time_entries`,
    schema: GetTimeEntriesResponseSchema,
    query: {
      start_date: filter.startMs,
      end_date: filter.endMs,
      assignee:
        filter.allMembers === true
          ? 'any'
          : filter.assigneeIds !== undefined && filter.assigneeIds.length > 0
            ? filter.assigneeIds.join(',')
            : undefined,
      is_billable: filter.isBillable,
      space_id: filter.spaceId,
      folder_id: filter.folderId,
      list_id: filter.listId,
      task_id: filter.taskId,
      include_location_names: true,
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
  /**
   * The entry's owner. Was previously discarded entirely (B1) - a caller
   * had no way to tell whose entry it was looking at, which is exactly the
   * gap `clickup_time_report` (B2) needs closed to group by member. `id`
   * and `username` only, matching `TaskAssigneeSchema`'s shape - the
   * entry's `user` object also carries `email`/`color`/`initials`/
   * `profilePicture`, none of which any tool in this server reads.
   */
  user?: { id: string; username: string } | undefined
  list_id?: string | undefined
  list_name?: string | undefined
  space_id?: string | undefined
  space_name?: string | undefined
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
  if (entry.user !== undefined) {
    out.user = { id: entry.user.id, username: entry.user.username }
  }
  if (entry.task_location !== undefined) {
    if (entry.task_location.list_id !== undefined) {
      out.list_id = entry.task_location.list_id
    }
    if (entry.task_location.list_name !== undefined) {
      out.list_name = entry.task_location.list_name
    }
    if (entry.task_location.space_id !== undefined) {
      out.space_id = entry.task_location.space_id
    }
    if (entry.task_location.space_name !== undefined) {
      out.space_name = entry.task_location.space_name
    }
  }
  return out
}
