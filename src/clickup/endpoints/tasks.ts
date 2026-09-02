import type { ClickUpContext } from '../../core/context.js'
import { formatDate, formatDurationHm } from '../../core/dates.js'
import { ClickUpSchemaError, ClickUpUsageError } from '../../core/errors.js'
import { loadListMeta, type ListMeta } from './workspace.js'
import { walkTaskPages } from '../pagination.js'
import type { CommentOut } from '../../format/comment.js'
import {
  BulkTimeInStatusRawResponseSchema,
  EmptyResponseSchema,
  GetTaskCommentsResponseSchema,
  GetTasksResponseSchema,
  TaskDetailSchema,
  TaskTimeInStatusResponseSchema,
  type Task,
  type TaskComment,
  type TaskDetail,
  type TaskSummary,
  type TaskTimeInStatusResponse,
} from '../schemas.js'

// -- Raw endpoint calls ------------------------------------------------

/**
 * Fetches one task with its subtasks nested in the same response.
 * `include_subtasks=true` is always sent: ClickUp only nests subtasks when
 * asked, and a caller that wants them (`clickup_get_task`) must not pay for
 * a second round trip to get what one query parameter already provides.
 * Callers that do not need subtasks simply ignore the (possibly absent)
 * field - the extra parameter costs nothing when there are none.
 *
 * `include_markdown_description=true` is always sent for the same reason
 * and a sharper one: without it ClickUp returns only `description`, the
 * task's text flattened to plain lines - headings lose their level, code
 * spans lose their backticks, checkboxes become ordinary lines. Every read
 * path in this server feeds `clickup_update_task`'s default append mode,
 * which reads a description back and PUTs it as the task's whole new
 * description; reading the flattened form there would silently destroy the
 * formatting of every task it touches. See `taskDescription` below.
 */
export function getTaskDetail(ctx: ClickUpContext, taskId: string): Promise<TaskDetail> {
  return ctx.client.request({
    method: 'GET',
    path: `/task/${taskId}`,
    schema: TaskDetailSchema,
    query: { include_subtasks: true, include_markdown_description: true },
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
  /**
   * How many raw tasks to gather before stopping the upstream walk, i.e.
   * `offset + limit` of the caller's requested page - every filter here is
   * applied server-side, so a raw task is always a result task, unlike
   * `getWorkspaceTasks`, which cannot know a target count in advance
   * because it filters locally after fetching.
   */
  minItems: number
}

export type ListTasksResult = {
  tasks: Task[]
  hasMoreUpstream: boolean
  truncated: boolean
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
 *
 * Walks upstream pages via `walkTaskPages` rather than fetching a single
 * page: one 100-task page is not "all matching tasks," and treating it as
 * such makes `total`/`has_more`/`next_offset` actively wrong for any list
 * or space with more than 100 tasks in scope.
 */
export async function listTasksRaw(ctx: ClickUpContext, filter: ListTasksFilter): Promise<ListTasksResult> {
  const query = {
    'assignees[]': filter.assignees,
    'statuses[]': filter.statuses,
    'tags[]': filter.tags,
    due_date_lt: filter.dueBeforeMs,
    due_date_gt: filter.dueAfterMs,
    include_closed: filter.includeClosed,
    subtasks: filter.includeSubtasks,
  }

  const walked = filter.listId
    ? await walkTaskPages(async (page) => {
        const res = await ctx.client.request({
          method: 'GET',
          path: `/list/${filter.listId}/task`,
          schema: GetTasksResponseSchema,
          query: { ...query, page },
        })
        return { tasks: res.tasks, lastPage: res.last_page }
      }, filter.minItems)
    : await walkTaskPages(async (page) => {
        const res = await ctx.client.request({
          method: 'GET',
          path: `/team/${ctx.teamId}/task`,
          schema: GetTasksResponseSchema,
          query: { ...query, 'space_ids[]': filter.spaceId, page },
        })
        return { tasks: res.tasks }
      }, filter.minItems)

  return { tasks: walked.items, hasMoreUpstream: walked.hasMoreUpstream, truncated: walked.truncated }
}

// -- Normalised projections ---------------------------------------------

export type SubtaskOut = { id: string; name: string; status: string }
export type CustomFieldValueOut = { id: string; name: string; value: unknown }
export type AssigneeOut = { id: string; username: string }

/**
 * Every optional field is typed `T | undefined` rather than bare `?: T`:
 * under `exactOptionalPropertyTypes`, the zod-inferred output type this
 * server's tool wrapper actually passes to `render` (`z.string().optional()`
 * infers as `string | undefined`, not "may be absent, but string when
 * present") is only assignable to a type that says the same thing.
 */
export type CustomFieldErrorOut = { field: string; error: string }

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
  custom_fields?: CustomFieldValueOut[] | undefined
  list_id: string
  list_name: string
  url: string
  subtasks?: SubtaskOut[] | undefined
  comments?: CommentOut[] | undefined
  /**
   * Present only when the task itself was created/updated successfully but
   * one or more of its custom field writes (a separate API call per field)
   * failed afterward. The task id and every other field above still
   * reflect the real, successful write - only the named fields did not
   * take. Never thrown away in favour of a bare error: the caller already
   * has a real task in ClickUp by the time this can happen.
   */
  custom_field_errors?: CustomFieldErrorOut[] | undefined
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
/**
 * The task's description as this server reads, exposes and appends to it:
 * the markdown form when ClickUp reported one, falling back to the
 * flattened `description` only when it did not (a POST/PUT task response
 * carries no `markdown_description`, since query parameters do not apply to
 * a write). Returns `undefined` when the task genuinely has no description,
 * so callers omit the field rather than writing an empty one.
 *
 * The order matters and is not cosmetic: `description` is lossy. Preferring
 * it - or falling back to it while a markdown form exists - is what turns
 * `clickup_update_task`'s append into a silent reformat of the whole
 * description.
 */
export function taskDescription(task: TaskDetail): string | undefined {
  const markdown = task.markdown_description
  if (markdown !== null && markdown !== undefined && markdown !== '') {
    return markdown
  }
  const plain = task.description
  if (plain !== null && plain !== undefined && plain !== '') {
    return plain
  }
  return undefined
}

export function toTaskOut(task: TaskDetail, ctx: ClickUpContext): TaskOut {
  const out: TaskOut = {
    id: task.id,
    name: task.name,
    status: task.status.status,
    list_id: task.list.id,
    list_name: task.list.name,
    url: task.url,
  }
  const description = taskDescription(task)
  if (description !== undefined) {
    out.description = description
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
    // Formatted, not stringified: the input side accepts "1h30m" and every
    // other duration in this server (time entries, my-day totals) goes
    // through `formatDurationHm`. Emitting raw milliseconds here made a
    // task's estimate the one duration an agent had to convert itself, and
    // the one rendered under a "(ms)" label nothing else used.
    out.time_estimate = formatDurationHm(Number(task.time_estimate))
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

/**
 * Formats `due_date` through `formatMsField`, the same helper `toTaskOut`
 * uses - a raw ClickUp epoch-millisecond string must never reach the agent
 * unformatted just because it came through the list/summary path instead
 * of the single-task path. Both must show the same value the same way for
 * the same task.
 *
 * `priority` and `assignees` are omitted exactly the way `toTaskOut` omits
 * them (`task.priority`'s null/undefined check; `task.assignees.length > 0`)
 * - a task with neither must render with neither line, not an empty or
 * null one. Reusing that same omission rule here, rather than inventing a
 * second one for the summary shape, is the whole reason to keep this
 * function reading `toTaskOut` right above it.
 */
export function toTaskSummary(task: Task, timezone: string): TaskSummary {
  const due = formatMsField(task.due_date, timezone)
  return {
    id: task.id,
    name: task.name,
    status: task.status.status,
    ...(task.priority !== null && task.priority !== undefined ? { priority: task.priority.priority } : {}),
    ...(task.assignees.length > 0
      ? { assignees: task.assignees.map((a) => ({ id: a.id, username: a.username })) }
      : {}),
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
    throw new ClickUpUsageError(`List ${meta.id} has no status "${status}". Available: ${available}`)
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
      throw new ClickUpUsageError(`List ${listId} has no custom field "${name}". Available: ${available}`)
    }
    return { id: field.id, value }
  })
}

// -- Time in status ---------------------------------------------------------

/**
 * The message every "cannot tell whether the ClickApp is enabled" case uses
 * (C1 and C2 both). Deliberately does NOT claim the ClickApp is definitely
 * disabled: ClickUp's own reference page for both endpoints states only
 * that the "Total time in Status" ClickApp "must first be enabled by the
 * Workspace owner or an admin" - it documents no error response, ECODE, or
 * distinct HTTP status for the disabled case, and none could be found or
 * verified elsewhere (see the increment report). A shapeless or missing
 * response is the most likely symptom of that, but this server cannot
 * confirm it is the only possible cause, so the message says exactly that -
 * an honest "cannot tell", never a confident diagnosis, and never a silent
 * "0m".
 */
function timeInStatusUnavailableMessage(taskId: string, reason: 'shapeless' | 'missing'): string {
  const what =
    reason === 'shapeless'
      ? "ClickUp's response for it did not carry the current_status/status_history shape (with a numeric " +
        'total_time.by_minute) this server requires'
      : "ClickUp's response did not mention it at all"
  return (
    `Time in status is not available for task ${taskId}: ${what}. This usually means the "Total time in Status" ` +
    'ClickApp is not enabled for this workspace - it must be turned on by a Workspace owner or admin - but ' +
    'ClickUp does not document what it returns when that ClickApp is disabled, so this could also be some other ' +
    'unexpected condition (for "not mentioned at all": the id may also not exist, or not be visible to this ' +
    'token). Either way, time in status cannot be reported for this task here - treat it as unknown, never as 0m.'
  )
}

/**
 * `GET /task/{task_id}/time_in_status`. Requires the "Total time in Status"
 * ClickApp to be enabled for the workspace; `TaskTimeInStatusResponseSchema`
 * requires `current_status`/`status_history` to carry a real numeric
 * `total_time.by_minute`, so a response that does not (the shapeless case
 * this server cannot otherwise distinguish from a disabled ClickApp) fails
 * schema validation inside `ctx.client.request` as a `ClickUpSchemaError` -
 * caught here specifically and re-thrown as a `ClickUpUsageError` so the
 * message reaches the agent unwrapped (see `core/errors.ts`) rather than as
 * a generic schema-validation complaint.
 */
export async function getTaskTimeInStatusRaw(ctx: ClickUpContext, taskId: string): Promise<TaskTimeInStatusResponse> {
  try {
    return await ctx.client.request({
      method: 'GET',
      path: `/task/${taskId}/time_in_status`,
      schema: TaskTimeInStatusResponseSchema,
    })
  } catch (err) {
    if (err instanceof ClickUpSchemaError) {
      throw new ClickUpUsageError(timeInStatusUnavailableMessage(taskId, 'shapeless'))
    }
    throw err
  }
}

/**
 * ClickUp's own reference page for `GET /task/bulk_time_in_status/task_ids`
 * documents "You can include up to 100 task ids per request." Chosen as
 * this server's own chunk size, rather than something smaller/arbitrary, so
 * a caller asking for exactly ClickUp's own limit never gets split into two
 * requests it did not need.
 */
const MAX_BULK_TIME_IN_STATUS_IDS = 100

/**
 * Splits `taskIds` into chunks of at most `maxPerChunk`, never leaving a
 * trailing chunk of exactly one id. ClickUp's bulk endpoint is documented
 * against "two or more tasks" - a naive split (101 ids -> [100, 1]) would
 * send a final request of one id, which is exactly the case
 * `clickup_get_task_time_in_status` exists to cover and the bulk endpoint
 * may not accept. Rebalanced instead: the last two chunks split evenly
 * (101 -> [99, 2], not [100, 1]).
 */
function chunkTaskIds(taskIds: string[], maxPerChunk: number): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < taskIds.length; i += maxPerChunk) {
    chunks.push(taskIds.slice(i, i + maxPerChunk))
  }
  const last = chunks.at(-1)
  if (chunks.length > 1 && last !== undefined && last.length === 1) {
    const secondLast = chunks[chunks.length - 2] as string[]
    const moved = secondLast.pop()
    if (moved !== undefined) {
      last.unshift(moved)
    }
  }
  return chunks
}

/**
 * One task's outcome from the bulk endpoint: a real, schema-valid result
 * (`ok`), a per-task shapeless entry (`shapeless` - present in ClickUp's
 * response but not matching `TaskTimeInStatusResponseSchema`), or an id
 * ClickUp's response did not mention at all (`missing`). Kept as a tagged
 * union, and per-task rather than failing the whole call the way the
 * single-task endpoint above does, because one bad id among many must not
 * hide real data for the rest of the batch - the same reasoning
 * `clickup_update_tasks_bulk` (src/tools/tasks.ts) already applies to
 * writes, applied here to a read.
 */
export type TaskTimeInStatusOutcome =
  | { taskId: string; kind: 'ok'; data: TaskTimeInStatusResponse }
  | { taskId: string; kind: 'shapeless' }
  | { taskId: string; kind: 'missing' }

/**
 * `GET /task/bulk_time_in_status/task_ids`, chunked at
 * `MAX_BULK_TIME_IN_STATUS_IDS` and walked sequentially so every chunk goes
 * through `ctx.client.request` - and so the shared rate limiter - exactly
 * like every other multi-request call in this server (`walkTaskPages`,
 * `clickup_update_tasks_bulk`'s per-task writes). The raw response is
 * parsed loosely (`BulkTimeInStatusRawResponseSchema`, one `z.unknown()`
 * per task) specifically so this function can re-validate each requested
 * id's own entry individually against the strict
 * `TaskTimeInStatusResponseSchema` - unlike the single-task function above,
 * a batch response with one shapeless task must not turn the whole batch
 * into a thrown error and hide real data for the other ids.
 */
export async function getTasksTimeInStatusBulkRaw(
  ctx: ClickUpContext,
  taskIds: string[],
): Promise<Map<string, TaskTimeInStatusOutcome>> {
  const outcomes = new Map<string, TaskTimeInStatusOutcome>()
  for (const chunk of chunkTaskIds(taskIds, MAX_BULK_TIME_IN_STATUS_IDS)) {
    const raw = await ctx.client.request({
      method: 'GET',
      path: '/task/bulk_time_in_status/task_ids',
      schema: BulkTimeInStatusRawResponseSchema,
      query: { task_ids: chunk },
    })
    for (const taskId of chunk) {
      const entry = raw[taskId]
      if (entry === undefined) {
        outcomes.set(taskId, { taskId, kind: 'missing' })
        continue
      }
      const parsed = TaskTimeInStatusResponseSchema.safeParse(entry)
      outcomes.set(taskId, parsed.success ? { taskId, kind: 'ok', data: parsed.data } : { taskId, kind: 'shapeless' })
    }
  }
  return outcomes
}

// -- Normalised projections (time in status) ---------------------------------

export type TimeInStatusPeriodOut = {
  status: string
  duration: string
  since?: string | undefined
}

/**
 * Formats one `current_status`/`status_history` entry: `by_minute` (a count
 * of MINUTES per ClickUp's own documentation) is multiplied up to
 * milliseconds before it ever reaches `formatDurationHm` - every other
 * duration formatter in this server takes milliseconds, and this is exactly
 * the kind of unit mismatch the increment brief calls out as where a fifth
 * defect of this shape would appear. `since` is formatted through
 * `formatDate`, the same offset-carrying timestamp form every other date in
 * this server uses, and omitted (never a placeholder) when ClickUp did not
 * report one - `null` is treated identically to `undefined` here (both mean
 * "ClickUp did not give a since"), never passed to `Number()`, which would
 * silently produce a fabricated epoch-zero date rather than an omitted
 * field (increment review finding).
 */
export function toTimeInStatusPeriodOut(
  period: { status: string; total_time: { by_minute: number; since?: string | number | null | undefined } },
  timezone: string,
): TimeInStatusPeriodOut {
  const out: TimeInStatusPeriodOut = {
    status: period.status,
    duration: formatDurationHm(period.total_time.by_minute * 60_000),
  }
  if (period.total_time.since !== undefined && period.total_time.since !== null) {
    out.since = formatDate(Number(period.total_time.since), timezone)
  }
  return out
}

export type TaskTimeInStatusOut = {
  task_id: string
  current_status: TimeInStatusPeriodOut
  status_history: TimeInStatusPeriodOut[]
}

export function toTaskTimeInStatusOut(
  taskId: string,
  res: TaskTimeInStatusResponse,
  timezone: string,
): TaskTimeInStatusOut {
  return {
    task_id: taskId,
    current_status: toTimeInStatusPeriodOut(res.current_status, timezone),
    status_history: res.status_history.map((h) => toTimeInStatusPeriodOut(h, timezone)),
  }
}

/**
 * The bulk tool's per-task result: either `toTaskTimeInStatusOut`'s own
 * shape merged with `task_id` (a genuinely successful outcome), or a
 * `note` naming the task and explaining why time in status could not be
 * reported for it (`shapeless`/`missing`) - never both, and never a result
 * with numeric fields silently defaulted to 0.
 */
export function toTaskTimeInStatusResultOut(
  outcome: TaskTimeInStatusOutcome,
  timezone: string,
): { task_id: string; current_status?: TimeInStatusPeriodOut; status_history?: TimeInStatusPeriodOut[]; note?: string } {
  if (outcome.kind === 'ok') {
    const out = toTaskTimeInStatusOut(outcome.taskId, outcome.data, timezone)
    return { task_id: out.task_id, current_status: out.current_status, status_history: out.status_history }
  }
  return { task_id: outcome.taskId, note: timeInStatusUnavailableMessage(outcome.taskId, outcome.kind) }
}
