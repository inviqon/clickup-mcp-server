import { bulletList, nameWithId } from './common.js'

/**
 * The shape every renderer in this file works from - matches
 * `TimeEntryOut` (src/clickup/endpoints/time.ts) field for field, but
 * declared independently so this module never has to import a
 * clickup/endpoints type just to describe what it renders. `format/task.ts`
 * does NOT keep this same separation - it imports `TaskOut` directly from
 * `clickup/endpoints/tasks.ts` - so this is this file's own choice, not a
 * project-wide convention every `format/` module follows.
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
 * The subset of a time-entry-shaped object `timeEntryTaskLabel` actually
 * reads. Narrower than `TimeEntryLike` on purpose: `clickup_get_my_day`'s
 * running-timer view (`RunningTimerOut`, src/format/myday.ts) and
 * `clickup_get_current_time_entry`'s render output (src/tools/time.ts) both
 * carry `task_id`/`task_name` without the rest of `TimeEntryLike`'s fields,
 * and both used to hand-roll this exact label logic locally rather than
 * import it, which is how "no task" and "Untracked" ended up as two
 * separately-worded answers to the same question. One helper, called from
 * all three sites, is what keeps a fourth wording from appearing later.
 */
export type TimeEntryTaskLabelSource = {
  task_id?: string | undefined
  task_name?: string | undefined
}

/**
 * The task label shared by every time-entry renderer: the task's name and
 * id when the entry is tied to one, or an explicit "no task" label when it
 * is not - never a blank or omitted mention, since "which task was this
 * time logged against" is exactly the kind of ambiguity reliability rule 4
 * says must be surfaced, not silently dropped.
 */
export function timeEntryTaskLabel(out: TimeEntryTaskLabelSource): string {
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
