import type { TaskOut } from '../clickup/endpoints/tasks.js'
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
      ['Time estimate (ms)', out.time_estimate],
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
    lines.push('', '**Comments**')
    for (const comment of out.comments) {
      lines.push(`- ${comment.author}: ${comment.text}`)
    }
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
