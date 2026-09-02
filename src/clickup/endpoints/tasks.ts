import { z } from 'zod'
import type { ClickUpContext } from '../../core/context.js'
import { formatDate } from '../../core/dates.js'
import { loadListMeta, type ListMeta } from './workspace.js'
import {
  GetTaskCommentsResponseSchema,
  GetTasksResponseSchema,
  TaskDetailSchema,
  type Task,
  type TaskComment,
  type TaskDetail,
  type TaskSummary,
} from '../schemas.js'

// -- Raw endpoint calls ------------------------------------------------

/**
 * Fetches one task with its subtasks nested in the same response.
 * `include_subtasks=true` is always sent: ClickUp only nests subtasks when
 * asked, and a caller that wants them (`clickup_get_task`) must not pay for
 * a second round trip to get what one query parameter already provides.
 * Callers that do not need subtasks simply ignore the (possibly absent)
 * field - the extra parameter costs nothing when there are none.
 */
export function getTaskDetail(ctx: ClickUpContext, taskId: string): Promise<TaskDetail> {
  return ctx.client.request({
    method: 'GET',
    path: `/task/${taskId}`,
    schema: TaskDetailSchema,
    query: { include_subtasks: true },
  })
}

export async function getTaskComments(ctx: ClickUpContext, taskId: string): Promise<TaskComment[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/task/${taskId}/comment`,
    schema: GetTaskCommentsResponseSchema,
  })
  return res.comments
}

export function createTaskRaw(ctx: ClickUpContext, listId: string, body: Record<string, unknown>): Promise<TaskDetail> {
  return ctx.client.request({
    method: 'POST',
    path: `/list/${listId}/task`,
    schema: TaskDetailSchema,
    body,
  })
}

export function updateTaskRaw(ctx: ClickUpContext, taskId: string, body: Record<string, unknown>): Promise<TaskDetail> {
  return ctx.client.request({
    method: 'PUT',
    path: `/task/${taskId}`,
    schema: TaskDetailSchema,
    body,
  })
}

const EmptyResponseSchema = z.object({}).passthrough()

/**
 * `POST /v2/task/{task_id}/field/{field_id}` - sets one custom field's
 * value. Called once per resolved custom field after a create or update,
 * since ClickUp has no endpoint to set several custom fields on a task in
 * one request.
 */
export async function setCustomFieldValue(
  ctx: ClickUpContext,
  taskId: string,
  fieldId: string,
  value: unknown,
): Promise<void> {
  await ctx.client.request({
    method: 'POST',
    path: `/task/${taskId}/field/${fieldId}`,
    schema: EmptyResponseSchema,
    body: { value },
  })
}

export async function deleteTaskRaw(ctx: ClickUpContext, taskId: string): Promise<void> {
  await ctx.client.request({
    method: 'DELETE',
    path: `/task/${taskId}`,
    schema: EmptyResponseSchema,
  })
}

/**
 * `POST /v2/task/{task_id}/link/{other_task_id}` - a plain, undirected task
 * link (ClickUp's "linked tasks", distinct from a dependency). No request
 * body.
 */
export async function linkTasksRaw(ctx: ClickUpContext, taskId: string, otherTaskId: string): Promise<void> {
  await ctx.client.request({
    method: 'POST',
    path: `/task/${taskId}/link/${otherTaskId}`,
    schema: EmptyResponseSchema,
  })
}

/**
 * `POST /v2/task/{task_id}/dependency` - a directed dependency. Exactly one
 * of `depends_on` (a task that must finish before `taskId` can proceed) or
 * `dependency_of` (a task that is blocked by `taskId`) is sent per ClickUp's
 * documented contract.
 */
export async function addDependency(
  ctx: ClickUpContext,
  taskId: string,
  body: { depends_on: string } | { dependency_of: string },
): Promise<void> {
  await ctx.client.request({
    method: 'POST',
    path: `/task/${taskId}/dependency`,
    schema: EmptyResponseSchema,
    body,
  })
}

export type MoveTaskBody = {
  move_custom_fields: boolean
  status_mappings?: Array<{ source_status_id: string; destination_status_id: string }>
}

/**
 * `PUT /v3/workspaces/{workspace_id}/tasks/{task_id}/home_list/{list_id}` -
 * the v3 "move a task to a new list" endpoint. Its response only confirms
 * the move (`{ data: { task_id, new_list_id } }`); this server discards it
 * and re-fetches the task afterward instead, both because that is a richer
 * view to return to the agent and because it avoids over-constraining a
 * response shape this server does not otherwise need to read.
 */
export async function moveTaskHomeList(
  ctx: ClickUpContext,
  taskId: string,
  listId: string,
  body: MoveTaskBody,
): Promise<void> {
  await ctx.client.request({
    method: 'PUT',
    version: 'v3',
    path: `/workspaces/${ctx.teamId}/tasks/${taskId}/home_list/${listId}`,
    schema: EmptyResponseSchema,
    body,
  })
}

export type ListTasksFilter = {
  listId?: string | undefined
  spaceId?: string | undefined
  assignees?: string[] | undefined
  statuses?: string[] | undefined
  tags?: string[] | undefined
  dueBeforeMs?: number | undefined
  dueAfterMs?: number | undefined
  includeClosed: boolean
  includeSubtasks: boolean
}

/**
 * Lists tasks scoped to a list or a space, with every filter applied
 * server-side via ClickUp's own query parameters - unlike
 * `clickup_search_tasks`, which has no text-search parameter to delegate to
 * and so must filter client-side. `filter.listId` and `filter.spaceId` pick
 * between ClickUp's two "get tasks" endpoints; the caller (`clickup_list_tasks`)
 * is responsible for requiring exactly one, since asking ClickUp for tasks
 * with neither would silently mean "the whole workspace", a scope this tool
 * does not offer.
 */
export async function listTasksRaw(ctx: ClickUpContext, filter: ListTasksFilter): Promise<Task[]> {
  const query = {
    'assignees[]': filter.assignees,
    'statuses[]': filter.statuses,
    'tags[]': filter.tags,
    due_date_lt: filter.dueBeforeMs,
    due_date_gt: filter.dueAfterMs,
    include_closed: filter.includeClosed,
    subtasks: filter.includeSubtasks,
  }

  const res = filter.listId
    ? await ctx.client.request({
        method: 'GET',
        path: `/list/${filter.listId}/task`,
        schema: GetTasksResponseSchema,
        query,
      })
    : await ctx.client.request({
        method: 'GET',
        path: `/team/${ctx.teamId}/task`,
        schema: GetTasksResponseSchema,
        query: { ...query, 'space_ids[]': filter.spaceId },
      })
  return res.tasks
}

// -- Normalised projections ---------------------------------------------

export type SubtaskOut = { id: string; name: string; status: string }
export type CommentOut = { id: string; author: string; text: string }
export type CustomFieldOut = { id: string; name: string; value: unknown }
export type AssigneeOut = { id: string; username: string }

/**
 * Every optional field is typed `T | undefined` rather than bare `?: T`:
 * under `exactOptionalPropertyTypes`, the zod-inferred output type this
 * server's tool wrapper actually passes to `render` (`z.string().optional()`
 * infers as `string | undefined`, not "may be absent, but string when
 * present") is only assignable to a type that says the same thing.
 */
export type TaskOut = {
  id: string
  name: string
  description?: string | undefined
  status: string
  priority?: string | undefined
  tags?: string[] | undefined
  assignees?: AssigneeOut[] | undefined
  due_date?: string | undefined
  start_date?: string | undefined
  time_estimate?: string | undefined
  parent?: string | undefined
  custom_fields?: CustomFieldOut[] | undefined
  list_id: string
  list_name: string
  url: string
  subtasks?: SubtaskOut[] | undefined
  comments?: CommentOut[] | undefined
}

/**
 * Formats a ClickUp epoch-millisecond string as an offset-carrying ISO
 * timestamp, so a mismatch between the server's configured timezone and
 * what the agent expected is visible in the value itself rather than
 * silent. Returns `undefined` for `null`/`undefined` input rather than
 * inventing a date - reliability rule 2.
 */
function formatMsField(value: string | null | undefined, timezone: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }
  return formatDate(Number(value), timezone)
}

/**
 * Projects the raw `TaskDetail` ClickUp returns into the compact shape this
 * server's task tools return. Every optional field is included only when
 * ClickUp actually reported a value for it (reliability rule 2): an absent
 * due date, an unset parent, or an empty tag list are all omitted rather
 * than rendered as a placeholder.
 */
export function toTaskOut(task: TaskDetail, ctx: ClickUpContext): TaskOut {
  const out: TaskOut = {
    id: task.id,
    name: task.name,
    status: task.status.status,
    list_id: task.list.id,
    list_name: task.list.name,
    url: task.url,
  }
  if (task.description !== null && task.description !== undefined && task.description !== '') {
    out.description = task.description
  }
  if (task.priority !== null && task.priority !== undefined) {
    out.priority = task.priority.priority
  }
  if (task.tags.length > 0) {
    out.tags = task.tags.map((t) => t.name)
  }
  if (task.assignees.length > 0) {
    out.assignees = task.assignees.map((a) => ({ id: a.id, username: a.username }))
  }
  const dueDate = formatMsField(task.due_date, ctx.timezone)
  if (dueDate !== undefined) {
    out.due_date = dueDate
  }
  const startDate = formatMsField(task.start_date, ctx.timezone)
  if (startDate !== undefined) {
    out.start_date = startDate
  }
  if (task.time_estimate !== null && task.time_estimate !== undefined) {
    out.time_estimate = String(task.time_estimate)
  }
  if (task.parent !== null && task.parent !== undefined) {
    out.parent = task.parent
  }
  if (task.custom_fields.length > 0) {
    out.custom_fields = task.custom_fields
      .filter((f) => f.value !== null && f.value !== undefined)
      .map((f) => ({ id: f.id, name: f.name, value: f.value }))
  }
  if (task.subtasks !== undefined) {
    out.subtasks = task.subtasks.map((s) => ({ id: s.id, name: s.name, status: s.status.status }))
  }
  return out
}

export function toTaskSummary(task: Task): TaskSummary {
  const due = task.due_date != null ? task.due_date : undefined
  return {
    id: task.id,
    name: task.name,
    status: task.status.status,
    list_id: task.list.id,
    list_name: task.list.name,
    url: task.url,
    ...(due !== undefined ? { due_date: due } : {}),
  }
}

// -- Pre-write validation --------------------------------------------------

/**
 * Throws a message that names exactly what the list offers, so a rejected
 * write becomes something an agent can act on rather than a raw ClickUp
 * 400 it will retry blindly with the same bad status name.
 */
export function assertValidStatus(meta: ListMeta, status: string): void {
  if (!meta.statuses.some((s) => s.status === status)) {
    const available = meta.statuses.map((s) => s.status).join(', ')
    throw new Error(`List ${meta.id} has no status "${status}". Available: ${available}`)
  }
}

/**
 * Resolves a `{ fieldName: value }` map (what an agent naturally writes) to
 * `{ id, value }` pairs (what ClickUp's per-field endpoint requires),
 * validating every name against the list's actual custom fields first. An
 * unknown field name throws naming the fields the list actually has, the
 * same reliability rule `assertValidStatus` applies to status names -
 * turning a would-be rejected write into an actionable error before any
 * API call is made.
 */
export async function resolveCustomFields(
  ctx: ClickUpContext,
  listId: string,
  input: Record<string, string | number | boolean>,
): Promise<Array<{ id: string; value: unknown }>> {
  const meta = await loadListMeta(ctx, listId)
  return Object.entries(input).map(([name, value]) => {
    const field = meta.custom_fields.find((f) => f.name === name)
    if (!field) {
      const available = meta.custom_fields.map((f) => f.name).join(', ')
      throw new Error(`List ${listId} has no custom field "${name}". Available: ${available}`)
    }
    return { id: field.id, value }
  })
}
