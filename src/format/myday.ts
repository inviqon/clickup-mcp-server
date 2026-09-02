import { nameWithId } from './common.js'

export type RunningTimerOut = {
  task_id?: string | undefined
  task_name?: string | undefined
  started_at: string
  elapsed: string
}

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
  overdue?: MyDayTaskOut[] | undefined
  overdue_error?: string | undefined
}

function renderTaskLine(t: MyDayTaskOut): string {
  return `- ${nameWithId(t.name, t.id)} [${t.status}]${t.due_date !== undefined ? ` - due ${t.due_date}` : ''}`
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
    const label = rt.task_name !== undefined ? nameWithId(rt.task_name, rt.task_id ?? '') : 'no task'
    lines.push(`Running on ${label} - ${rt.elapsed} elapsed, started ${rt.started_at}.`)
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
          `- ${e.task_name !== undefined ? e.task_name : 'Untracked'} - ${e.duration}` +
          `${e.description !== undefined && e.description.length > 0 ? `: ${e.description}` : ''}`,
      ),
    )
  }

  if (out.due_today_error !== undefined) {
    lines.push('', '## Due today', `Due today tasks could not be loaded: ${out.due_today_error}`)
  } else if (out.due_today !== undefined && out.due_today.length > 0) {
    lines.push('', '## Due today', ...out.due_today.map(renderTaskLine))
  }

  if (out.overdue_error !== undefined) {
    lines.push('', '## Overdue', `Overdue tasks could not be loaded: ${out.overdue_error}`)
  } else if (out.overdue !== undefined && out.overdue.length > 0) {
    lines.push('', '## Overdue', ...out.overdue.map(renderTaskLine))
  }

  return lines.join('\n')
}
