import type { TaskOut, TimeInStatusPeriodOut } from '../clickup/endpoints/tasks.js'
import { formatCommentLine } from './comment.js'
import { bulletList, nameWithId } from './common.js'

/**
 * Renders one task in full. Shared by every tool that returns a whole task
 * (`clickup_get_task`, `clickup_create_task`, `clickup_update_task`,
 * `clickup_move_task`, `clickup_link_tasks`) so a task reads identically no
 * matter which tool produced it. `bulletList` already skips any field
 * `toTaskOut` left out, so a missing due date, priority or parent simply
 * does not appear here - never as "N/A" or "null" (reliability rule 2).
 */
export function renderTask(out: TaskOut): string {
  const lines = [
    `# ${nameWithId(out.name, out.id)}`,
    '',
    ...bulletList([
      ['Status', out.status],
      ['Priority', out.priority],
      ['Due', out.due_date],
      ['Start', out.start_date],
      ['Time estimate', out.time_estimate],
      ['Parent', out.parent],
      ['List', nameWithId(out.list_name, out.list_id)],
    ]),
  ]

  if (out.tags && out.tags.length > 0) {
    lines.push(`- **Tags**: ${out.tags.join(', ')}`)
  }
  if (out.assignees && out.assignees.length > 0) {
    lines.push(`- **Assignees**: ${out.assignees.map((a) => nameWithId(a.username, a.id)).join(', ')}`)
  }

  if (out.custom_fields && out.custom_fields.length > 0) {
    lines.push('', '**Custom fields**')
    for (const field of out.custom_fields) {
      lines.push(`- ${nameWithId(field.name, field.id)}: ${String(field.value)}`)
    }
  }

  if (out.description) {
    lines.push('', '**Description**', out.description)
  }

  if (out.subtasks && out.subtasks.length > 0) {
    lines.push('', '**Subtasks**')
    for (const subtask of out.subtasks) {
      lines.push(`- ${nameWithId(subtask.name, subtask.id)} [${subtask.status}]`)
    }
  }

  if (out.comments && out.comments.length > 0) {
    lines.push('', '**Comments**', ...out.comments.map(formatCommentLine))
  }

  if (out.custom_field_errors && out.custom_field_errors.length > 0) {
    lines.push(
      '',
      '**Warning: the task was saved, but some custom fields could not be set**',
      ...out.custom_field_errors.map((e) => `- ${e.field}: ${e.error}`),
    )
  }

  lines.push('', out.url)
  return lines.join('\n')
}

export type BulkUpdateResult = {
  succeeded: string[]
  failed: Array<{ task_id: string; error: string }>
}

/**
 * Reports partial success explicitly: every failed id is named alongside
 * its error, so a bulk call that fails on one of fifty tasks never reads as
 * an undifferentiated failure the agent has to re-diagnose from scratch.
 */
export function renderBulkUpdateResult(out: BulkUpdateResult): string {
  const lines = [`# Bulk update: ${out.succeeded.length} succeeded, ${out.failed.length} failed`]
  if (out.succeeded.length > 0) {
    lines.push('', '**Succeeded**', ...out.succeeded.map((id) => `- ${id}`))
  }
  if (out.failed.length > 0) {
    lines.push('', '**Failed**', ...out.failed.map((f) => `- ${f.task_id}: ${f.error}`))
  }
  return lines.join('\n')
}

export type TaskTimeInStatusLike = {
  task_id: string
  current_status: TimeInStatusPeriodOut
  status_history: TimeInStatusPeriodOut[]
}

/**
 * Renders `clickup_get_task_time_in_status`. A task with a genuinely empty
 * `status_history` (it has never changed status) gets an explicit sentence
 * naming the task and its current status rather than a history table with
 * no rows beneath it - an empty table still LOOKS like a result, exactly
 * the ambiguity reliability rule 5 says must not be left for the reader to
 * notice (the same reasoning `renderTimeReport`, src/format/time.ts,
 * applies to a completely empty report).
 */
export function renderTaskTimeInStatus(out: TaskTimeInStatusLike): string {
  const sinceSuffix = out.current_status.since !== undefined ? ` (since ${out.current_status.since})` : ''
  const lines = [
    `# Time in status for task ${out.task_id}`,
    '',
    `Current: **${out.current_status.status}** - ${out.current_status.duration}${sinceSuffix}`,
  ]

  if (out.status_history.length === 0) {
    lines.push(
      '',
      `Task ${out.task_id} has no prior status history - it has been in "${out.current_status.status}" the whole time.`,
    )
    return lines.join('\n')
  }

  lines.push('', '| Status | Duration | Since |', '|---|---|---|')
  for (const period of out.status_history) {
    lines.push(`| ${period.status} | ${period.duration} | ${period.since ?? '-'} |`)
  }
  return lines.join('\n')
}

export type TaskTimeInStatusResultLike = {
  task_id: string
  current_status?: TimeInStatusPeriodOut | undefined
  status_history?: TimeInStatusPeriodOut[] | undefined
  note?: string | undefined
}

/**
 * Renders `clickup_get_tasks_time_in_status_bulk` as one compact table, one
 * row per requested task - the same "aggregate, don't list one bullet per
 * entry" choice `renderTimeReport` (src/format/time.ts) makes for
 * `clickup_time_report`. A task whose time in status could not be
 * determined (see `toTaskTimeInStatusResultOut`,
 * src/clickup/endpoints/tasks.ts) shows dashes in every numeric column and
 * its `note` in full - never a blank row that reads as "0m".
 */
export function renderTasksTimeInStatusBulk(out: { results: TaskTimeInStatusResultLike[] }): string {
  const headerCells = ['Task', 'Current status', 'Duration', 'Since', 'History', 'Note']
  const rows = out.results.map((r) => {
    if (r.current_status === undefined) {
      return [r.task_id, '-', '-', '-', '-', r.note ?? '']
    }
    const historyLabel =
      r.status_history !== undefined && r.status_history.length > 0
        ? `${r.status_history.length} prior status change(s)`
        : 'no prior status history'
    return [r.task_id, r.current_status.status, r.current_status.duration, r.current_status.since ?? '-', historyLabel, '']
  })

  const table = [
    `| ${headerCells.join(' | ')} |`,
    `|${headerCells.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ]

  return [`# Time in status for ${out.results.length} task(s)`, '', ...table].join('\n')
}
