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
  user?: { id: string; username: string } | undefined
  list_name?: string | undefined
  space_name?: string | undefined
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
    ['User', out.user !== undefined ? nameWithId(out.user.username, out.user.id) : undefined],
    ['List', out.list_name],
    ['Space', out.space_name],
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
  const who = out.user !== undefined ? `${out.user.username} - ` : ''
  return `- ${who}${timeEntryTaskLabel(out)} - ${out.duration} (started ${out.start})${description}`
}

/**
 * One row of `clickup_time_report`'s table - a member, list or space,
 * depending on the report's `group_by`. `note` present means every numeric
 * field is genuinely absent (the ambiguous "requested member, no visible
 * entries" row); `note` absent means the numeric fields are real data.
 */
export type TimeReportGroupLike = {
  key: string
  label: string
  entry_count?: number | undefined
  total_duration?: string | undefined
  billable_duration?: string | undefined
  billable_share?: string | undefined
  utilization?: string | undefined
  note?: string | undefined
}

export type TimeReportLike = {
  range: string
  group_by: 'member' | 'list' | 'space'
  groups: TimeReportGroupLike[]
  overall: {
    entry_count?: number | undefined
    total_duration?: string | undefined
    billable_duration?: string | undefined
    billable_share?: string | undefined
    note?: string | undefined
  }
}

const GROUP_LABEL_HEADING: Record<TimeReportLike['group_by'], string> = {
  member: 'Member',
  list: 'List',
  space: 'Space',
}

/**
 * Renders `clickup_time_report` as one compact markdown table - the whole
 * point of the tool is aggregation, so this deliberately never falls back
 * to `formatTimeEntryLine`'s one-bullet-per-entry form the way
 * `clickup_list_time_entries` does. A completely empty report (no groups at
 * all - nothing was requested, or nothing was visible) renders as
 * `overall.note` alone, with no empty table beneath it: an empty table
 * still LOOKS like a result, which is exactly what reliability rule 5 (an
 * empty result must be explicit) says not to leave to the reader to notice.
 */
export function renderTimeReport(out: TimeReportLike): string {
  const heading = `# Time report for ${out.range}`

  if (out.groups.length === 0) {
    return [heading, '', out.overall.note ?? 'No time entries found.'].join('\n')
  }

  const groupLabel = GROUP_LABEL_HEADING[out.group_by]
  const hasUtilization = out.groups.some((g) => g.utilization !== undefined)
  const hasNote = out.groups.some((g) => g.note !== undefined)

  const headerCells = [groupLabel, 'Entries', 'Total', 'Billable', 'Billable %']
  if (hasUtilization) {
    headerCells.push('Utilization')
  }
  if (hasNote) {
    headerCells.push('Note')
  }

  const rows = out.groups.map((g) => {
    const cells = [
      nameWithId(g.label, g.key),
      g.entry_count !== undefined ? String(g.entry_count) : '-',
      g.total_duration ?? '-',
      g.billable_duration ?? '-',
      g.billable_share ?? '-',
    ]
    if (hasUtilization) {
      cells.push(g.utilization ?? '-')
    }
    if (hasNote) {
      cells.push(g.note ?? '')
    }
    return cells
  })

  const table = [
    `| ${headerCells.join(' | ')} |`,
    `|${headerCells.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ]

  const overallLine =
    out.overall.total_duration !== undefined
      ? `Overall: ${out.overall.total_duration} across ${out.overall.entry_count} entr${out.overall.entry_count === 1 ? 'y' : 'ies'}` +
        (out.overall.billable_share !== undefined ? ` (${out.overall.billable_share} billable)` : '') +
        (out.overall.note !== undefined ? ` - ${out.overall.note}` : '')
      : (out.overall.note ?? '')

  return [heading, '', overallLine, '', ...table].join('\n')
}
