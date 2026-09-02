import { z } from 'zod'
import type { AnyToolDefinition, ToolDefinition } from '../core/registry.js'
import { formatDurationHm, resolveDate } from '../core/dates.js'
import { toAgentMessage } from '../core/errors.js'
import { getAuthorizedUser } from '../clickup/endpoints/workspace.js'
import { getRunningEntry, listTimeEntriesRaw, toTimeEntryOut } from '../clickup/endpoints/time.js'
import { listTasksRaw, toTaskSummary } from '../clickup/endpoints/tasks.js'
import { TaskSummarySchema } from '../clickup/schemas.js'
import type { TimeEntry } from '../clickup/schemas.js'
import { renderMyDay, type RunningTimerOut, type TrackedEntryOut } from '../format/myday.js'

// ---------------------------------------------------------------------------
// clickup_get_my_day
// ---------------------------------------------------------------------------

const myDayInputShape = {
  date: z.string().optional().describe('Defaults to today in the configured timezone. Accepts "today", "tomorrow", an ISO date, etc.'),
}

const runningTimerOutputShape = z.object({
  task_id: z.string().optional(),
  task_name: z.string().optional(),
  started_at: z.string(),
  elapsed: z.string(),
})

const trackedEntryOutputShape = z.object({
  id: z.string(),
  task_name: z.string().optional(),
  duration: z.string(),
  description: z.string().optional(),
})

const myDayOutputShape = {
  date: z.string(),
  /**
   * Nullable AND optional: `null` means "confirmed nothing is running"
   * (reliability rule 2 - a genuine, known value); absent means this
   * server does not know, because fetching it failed - `running_timer_error`
   * carries why. The two must never collapse into each other: rendering a
   * failed lookup as "nothing running" would be exactly the kind of
   * invented default reliability rule 2 exists to forbid.
   */
  running_timer: runningTimerOutputShape.nullable().optional(),
  running_timer_error: z.string().optional(),
  /**
   * Present and populated (even with zero entries) whenever the underlying
   * fetch succeeded; absent only when it failed, in which case
   * `tracked_today_error` carries why. `render` treats "present but empty"
   * and "absent due to failure" differently - the former is omitted from
   * the rendered view as a genuine empty result, the latter renders as a
   * named failure line.
   */
  tracked_today: z.object({ total: z.string(), entries: z.array(trackedEntryOutputShape) }).optional(),
  tracked_today_error: z.string().optional(),
  due_today: z.array(TaskSummarySchema).optional(),
  due_today_error: z.string().optional(),
  overdue: z.array(TaskSummarySchema).optional(),
  overdue_error: z.string().optional(),
}

function toRunningTimerOut(entry: TimeEntry, timezone: string): RunningTimerOut {
  const eo = toTimeEntryOut(entry, timezone)
  const out: RunningTimerOut = { started_at: eo.start, elapsed: eo.duration }
  if (eo.task_id !== undefined) {
    out.task_id = eo.task_id
  }
  if (eo.task_name !== undefined) {
    out.task_name = eo.task_name
  }
  return out
}

function toTrackedEntryOut(entry: TimeEntry, timezone: string): TrackedEntryOut {
  const eo = toTimeEntryOut(entry, timezone)
  const out: TrackedEntryOut = { id: eo.id, duration: eo.duration }
  if (eo.task_name !== undefined) {
    out.task_name = eo.task_name
  }
  if (eo.description !== undefined) {
    out.description = eo.description
  }
  return out
}

export const getMyDayTool: ToolDefinition<typeof myDayInputShape, typeof myDayOutputShape> = {
  name: 'clickup_get_my_day',
  title: 'Get My ClickUp Day',
  category: 'daily',
  mode: 'read',
  description: [
    'One-call daily briefing: the currently running timer, time already tracked today, tasks due',
    'today, and overdue tasks - all assigned to the authenticated user (except the running timer,',
    'which is whoever this token belongs to by definition). Composes four existing reads rather than',
    'adding new API surface; if any one of them fails, the other three still render, and the failed',
    'one names itself explicitly rather than silently vanishing or failing the whole call. Call this',
    'first at the start of a session to get oriented before doing anything else.',
    'Examples: "what does my day look like", "catch me up - what\'s running, what\'s due, what\'s',
    'overdue".',
  ].join(' '),
  inputSchema: myDayInputShape,
  outputSchema: myDayOutputShape,
  handler: async (args, ctx) => {
    const dayStart = resolveDate(args.date ?? 'today', { timezone: ctx.timezone }).epochMs
    const dayEnd = resolveDate('tomorrow', { timezone: ctx.timezone, now: new Date(dayStart) }).epochMs
    const dateOut = resolveDate(args.date ?? 'today', { timezone: ctx.timezone }).iso.slice(0, 10)

    // Resolving "the authenticated user" is a prerequisite for scoping the
    // due-today and overdue task queries to them (ClickUp's task filter has
    // no "me" placeholder - it needs a real numeric id). Cached per team so
    // a session that calls this tool repeatedly pays for it at most once
    // per cache TTL, not once per call.
    const mePromise = ctx.cache.getOrLoad(`me:${ctx.teamId}`, () => getAuthorizedUser(ctx))

    const runningPromise = getRunningEntry(ctx)
    const trackedPromise = listTimeEntriesRaw(ctx, { startMs: dayStart, endMs: dayEnd })
    const dueTodayPromise = mePromise.then((me) =>
      listTasksRaw(ctx, {
        assignees: [me.id],
        dueAfterMs: dayStart - 1,
        dueBeforeMs: dayEnd,
        includeClosed: false,
        includeSubtasks: false,
        minItems: Number.MAX_SAFE_INTEGER,
      }),
    )
    const overduePromise = mePromise.then((me) =>
      listTasksRaw(ctx, {
        assignees: [me.id],
        dueBeforeMs: dayStart,
        includeClosed: false,
        includeSubtasks: false,
        minItems: Number.MAX_SAFE_INTEGER,
      }),
    )

    const [runningResult, trackedResult, dueTodayResult, overdueResult] = await Promise.allSettled([
      runningPromise,
      trackedPromise,
      dueTodayPromise,
      overduePromise,
    ])

    const out: z.infer<z.ZodObject<typeof myDayOutputShape>> = { date: dateOut }

    if (runningResult.status === 'fulfilled') {
      out.running_timer = runningResult.value === null ? null : toRunningTimerOut(runningResult.value, ctx.timezone)
    } else {
      out.running_timer_error = toAgentMessage(runningResult.reason, { resource: 'time entry', id: 'current' })
    }

    if (trackedResult.status === 'fulfilled') {
      const entries = trackedResult.value
      const totalMs = entries.reduce((sum, e) => sum + Math.abs(Number(e.duration)), 0)
      out.tracked_today = {
        total: formatDurationHm(totalMs),
        entries: entries.map((e) => toTrackedEntryOut(e, ctx.timezone)),
      }
    } else {
      out.tracked_today_error = toAgentMessage(trackedResult.reason, { resource: 'time entries', id: 'today' })
    }

    if (dueTodayResult.status === 'fulfilled') {
      out.due_today = dueTodayResult.value.tasks.map((t) => toTaskSummary(t, ctx.timezone))
    } else {
      out.due_today_error = toAgentMessage(dueTodayResult.reason, { resource: 'task', id: 'due today' })
    }

    if (overdueResult.status === 'fulfilled') {
      out.overdue = overdueResult.value.tasks.map((t) => toTaskSummary(t, ctx.timezone))
    } else {
      out.overdue_error = toAgentMessage(overdueResult.reason, { resource: 'task', id: 'overdue' })
    }

    return out
  },
  render: (out) => renderMyDay(out),
}

export const MYDAY_TOOLS: AnyToolDefinition[] = [getMyDayTool] as unknown as AnyToolDefinition[]
