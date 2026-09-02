import { bulletList, nameWithId } from './common.js'

/**
 * The shape every renderer in this file works from - matches
 * `TimeEntryOut` (src/clickup/endpoints/time.ts) field for field, but
 * declared independently so this module never has to import a
 * clickup/endpoints type just to describe what it renders (the same
 * separation `format/task.ts` keeps from `clickup/endpoints/tasks.ts`).
 */
export type TimeEntryLike = {
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
 * The task label shared by every time-entry renderer: the task's name and
 * id when the entry is tied to one, or an explicit "no task" label when it
 * is not - never a blank or omitted mention, since "which task was this
 * time logged against" is exactly the kind of ambiguity reliability rule 4
 * says must be surfaced, not silently dropped.
 */
export function timeEntryTaskLabel(out: TimeEntryLike): string {
  return out.task_name !== undefined ? nameWithId(out.task_name, out.task_id ?? '') : 'no task'
}

/**
 * Renders one time entry's detail bullets - start, end, duration, billable,
 * description, tags - shared by every tool that returns a single time
 * entry (start, stop, create, update) so an entry reads identically no
 * matter which tool produced it, the same role `renderTask` plays for
 * tasks. `duration` is always the already-formatted "1h 30m" form; this
 * function never re-touches it.
 */
export function renderTimeEntryLines(out: TimeEntryLike): string[] {
  const lines = bulletList([
    ['Task', timeEntryTaskLabel(out)],
    ['Start', out.start],
    ['End', out.end],
    ['Duration', out.duration],
    ['Billable', out.billable !== undefined ? (out.billable ? 'yes' : 'no') : undefined],
  ])
  if (out.description !== undefined && out.description.length > 0) {
    lines.push(`- **Description**: ${out.description}`)
  }
  if (out.tags !== undefined && out.tags.length > 0) {
    lines.push(`- **Tags**: ${out.tags.join(', ')}`)
  }
  return lines
}

/**
 * Renders one time entry as a single markdown bullet, for use inside a
 * list (`clickup_list_time_entries`) or a daily aggregate
 * (`clickup_get_my_day`) rather than the full detail view above.
 */
export function formatTimeEntryLine(out: TimeEntryLike): string {
  const description = out.description !== undefined && out.description.length > 0 ? `: ${out.description}` : ''
  return `- ${timeEntryTaskLabel(out)} - ${out.duration} (started ${out.start})${description}`
}
