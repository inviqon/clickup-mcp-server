import { nameWithId } from './common.js'
import { timeEntryTaskLabel } from './time.js'

export type RunningTimerOut = {
  task_id?: string | undefined
  task_name?: string | undefined
  started_at: string
  elapsed: string
}

/**
 * Deliberately carries `task_name` but no `task_id` - `id` here is the time
 * entry's own id, not the task's. `toTrackedEntryOut` (src/tools/myday.ts)
 * has the task id available from the underlying `TimeEntryOut` and drops
 * it, so a tracked-today line reads as a bare task name rather than the
 * "Name (id)" form the running timer and other time-entry views use.
 */
export type TrackedEntryOut = {
  id: string
  task_name?: string | undefined
  duration: string
  description?: string | undefined
}

export type TrackedTodayOut = {
  total: string
  entries: TrackedEntryOut[]
}

export type MyDayTaskOut = {
  id: string
  name: string
  status: string
  list_id: string
  list_name: string
  url: string
  due_date?: string | undefined
}

export type MyDayOut = {
  date: string
  running_timer?: RunningTimerOut | null | undefined
  running_timer_error?: string | undefined
  tracked_today?: TrackedTodayOut | undefined
  tracked_today_error?: string | undefined
  due_today?: MyDayTaskOut[] | undefined
  due_today_error?: string | undefined
  /** See the matching field's doc comment in src/tools/myday.ts. */
  due_today_bounded?: boolean | undefined
  overdue?: MyDayTaskOut[] | undefined
  overdue_error?: string | undefined
  overdue_bounded?: boolean | undefined
}

function renderTaskLine(t: MyDayTaskOut): string {
  return `- ${nameWithId(t.name, t.id)} [${t.status}]${t.due_date !== undefined ? ` - due ${t.due_date}` : ''}`
}

/**
 * Same "bounded" wording `clickup_list_tasks` uses (src/tools/tasks.ts) for
 * the identical condition - the 5-page/500-task upstream walker cap being
 * hit before ClickUp confirmed the end - so the two tools describe it the
 * same way rather than inventing a second phrasing for one fact.
 */
function boundedNote(label: string): string {
  return (
    `Result bounded to the first 5 upstream pages (500 tasks) before ${label} could confirm the end; ` +
    'narrow with more specific filters or call clickup_list_tasks directly to see the rest.'
  )
}

/**
 * Renders the daily aggregate as four sections. The running timer section
 * is the one exception to "a section with no data is omitted": it always
 * states its status - running, not running, or could-not-be-loaded - never
 * silently disappears the way an empty due/overdue/tracked section does.
 * Every other section either lists what it found, is omitted entirely when
 * it genuinely found nothing, or - when its own upstream call failed -
 * renders as a named failure line instead of vanishing, so a partial
 * failure of this aggregate is never mistaken for "nothing to report."
 */
export function renderMyDay(out: MyDayOut): string {
  const lines: string[] = [`# My day - ${out.date}`, '', '## Running timer']

  if (out.running_timer_error !== undefined) {
    lines.push(`Running timer could not be loaded: ${out.running_timer_error}`)
  } else if (out.running_timer === null || out.running_timer === undefined) {
    lines.push('No timer is currently running.')
  } else {
    const rt = out.running_timer
    lines.push(`Running on ${timeEntryTaskLabel(rt)} - ${rt.elapsed} elapsed, started ${rt.started_at}.`)
  }

  if (out.tracked_today_error !== undefined) {
    lines.push('', '## Time tracked today', `Time tracked today could not be loaded: ${out.tracked_today_error}`)
  } else if (out.tracked_today !== undefined && out.tracked_today.entries.length > 0) {
    lines.push(
      '',
      '## Time tracked today',
      `Total: ${out.tracked_today.total}`,
      '',
      ...out.tracked_today.entries.map(
        (e) =>
          // No `task_id` on `TrackedEntryOut` to build a `nameWithId` label
          // from (see its doc comment above), so this reads the bare name
          // rather than `timeEntryTaskLabel`'s "Name (id)" form - but it
          // uses the SAME "no task" wording that form falls back to, not a
          // second phrasing for the same fact.
          `- ${e.task_name !== undefined ? e.task_name : 'no task'} - ${e.duration}` +
          `${e.description !== undefined && e.description.length > 0 ? `: ${e.description}` : ''}`,
      ),
    )
  }

  // `out.X_bounded` can only be true alongside a non-empty list: the
  // walker cap (`walkTaskPages`, src/clickup/pagination.ts) is only hit
  // after accumulating several full 100-task pages, so there is no
  // "bounded but empty" case to render here, unlike `clickup_list_tasks`
  // (src/tools/tasks.ts), which can page *past* a truncated result and
  // genuinely see zero items on a later page.
  if (out.due_today_error !== undefined) {
    lines.push('', '## Due today', `Due today tasks could not be loaded: ${out.due_today_error}`)
  } else if (out.due_today !== undefined && out.due_today.length > 0) {
    lines.push('', '## Due today', ...out.due_today.map(renderTaskLine))
    if (out.due_today_bounded === true) {
      lines.push(boundedNote('this filter'))
    }
  }

  if (out.overdue_error !== undefined) {
    lines.push('', '## Overdue', `Overdue tasks could not be loaded: ${out.overdue_error}`)
  } else if (out.overdue !== undefined && out.overdue.length > 0) {
    lines.push('', '## Overdue', ...out.overdue.map(renderTaskLine))
    if (out.overdue_bounded === true) {
      lines.push(boundedNote('this filter'))
    }
  }

  return lines.join('\n')
}
