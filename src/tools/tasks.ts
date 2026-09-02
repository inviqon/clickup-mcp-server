import { z } from 'zod'
import type { AnyToolDefinition, ToolDefinition } from '../core/registry.js'
import type { ClickUpContext } from '../core/context.js'
import { parseDuration, resolveDate } from '../core/dates.js'
import { ClickUpUsageError, toAgentMessage } from '../core/errors.js'
import { loadListMeta } from '../clickup/endpoints/workspace.js'
import {
  addDependency,
  assertValidStatus,
  createTaskRaw,
  deleteTaskRaw,
  getTaskComments,
  getTaskDetail,
  getTaskTimeInStatusRaw,
  getTasksTimeInStatusBulkRaw,
  linkTasksRaw,
  listTasksRaw,
  moveTaskHomeList,
  resolveCustomFields,
  setCustomFieldValue,
  taskDescription,
  toTaskOut,
  toTaskSummary,
  toTaskTimeInStatusOut,
  toTaskTimeInStatusResultOut,
  updateTaskRaw,
  type MoveTaskBody,
} from '../clickup/endpoints/tasks.js'
import { TaskSummarySchema, type TaskDetail } from '../clickup/schemas.js'
import { nameWithId, omitUnset, paginate } from '../format/common.js'
import { boundPage } from '../clickup/pagination.js'
import { renderBulkUpdateResult, renderTask, renderTaskTimeInStatus, renderTasksTimeInStatusBulk } from '../format/task.js'
import { toCommentOut } from '../format/comment.js'
import { assertConfirmName } from './confirm.js'

const PRIORITY_TO_INT: Record<'urgent' | 'high' | 'normal' | 'low', number> = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4,
}

const customFieldsInputSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

/**
 * ClickUp assignees are integer user ids; this server's own input schema
 * carries them as strings (consistent with every other id in this server's
 * tools). `Number("abc")` does not throw - it silently produces `NaN`,
 * which then serialises to JSON `null` and would send a request that
 * silently assigns nobody instead of the id the agent meant. Guarded here
 * so a bad id is a loud, actionable error instead of a wrong assignee no
 * one notices.
 */
export function toAssigneeId(id: string): number {
  const n = Number(id)
  if (Number.isNaN(n)) {
    throw new ClickUpUsageError(
      `Assignee id "${id}" is not a valid ClickUp user id (expected a number, as a string). ` +
        'Use clickup_resolve_member to find the correct id rather than guessing one.',
    )
  }
  return n
}

/**
 * Re-reads a task after a write whose own response does not carry the
 * task's full state (the v3 move endpoint, and both `clickup_link_tasks`
 * relation kinds). If this re-read fails, the write itself already
 * succeeded - ClickUp has already applied it - so this must never surface
 * as an ordinary handler failure indistinguishable from "the write did not
 * happen." The task id is included so the agent can look the task up
 * directly instead of retrying the write blindly.
 */
export async function refetchAfterWrite(ctx: ClickUpContext, taskId: string, whatSucceeded: string): Promise<TaskDetail> {
  try {
    return await getTaskDetail(ctx, taskId)
  } catch (err) {
    throw new ClickUpUsageError(
      `${whatSucceeded} succeeded, but reading task ${taskId} back afterward failed: ` +
        `${toAgentMessage(err, { resource: 'task', id: taskId })} The write already happened in ClickUp - check ` +
        `the task's current state (e.g. with clickup_get_task) before retrying, rather than assuming it failed.`,
    )
  }
}

/**
 * Shared by every tool that returns a whole task. `TaskSummarySchema`
 * covers the compact list-item shape; this covers the full single-task
 * shape every write tool and `clickup_get_task` return, so a task looks the
 * same regardless of which tool produced it.
 */
const taskDetailOutputShape = {
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: z.string(),
  priority: z.string().optional(),
  tags: z.array(z.string()).optional(),
  assignees: z.array(z.object({ id: z.string(), username: z.string() })).optional(),
  due_date: z.string().optional(),
  start_date: z.string().optional(),
  time_estimate: z.string().optional(),
  parent: z.string().optional(),
  custom_fields: z.array(z.object({ id: z.string(), name: z.string(), value: z.unknown() })).optional(),
  list_id: z.string(),
  list_name: z.string(),
  url: z.string(),
  subtasks: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })).optional(),
  comments: z.array(z.object({ id: z.string(), author: z.string(), date: z.string(), text: z.string() })).optional(),
  custom_field_errors: z.array(z.object({ field: z.string(), error: z.string() })).optional(),
}

// ---------------------------------------------------------------------------
// clickup_get_task
// ---------------------------------------------------------------------------

const getTaskInputShape = {
  task_id: z.string().describe('ClickUp task id, e.g. "86abc"'),
  include_comments: z.boolean().default(false).describe('Also fetch and include the task\'s comments'),
}

export const getTaskTool: ToolDefinition<typeof getTaskInputShape, typeof taskDetailOutputShape> = {
  name: 'clickup_get_task',
  title: 'Get ClickUp Task',
  category: 'tasks',
  mode: 'read',
  description: [
    'Get one ClickUp task by id in full, including its subtasks (fetched in the same call, so you',
    'never need a second lookup just to see them) and, when include_comments is set, its comments.',
    'Use clickup_search_tasks or clickup_list_tasks first if you do not already have the task id.',
    'Examples: "show me task 86abc", "what subtasks does the login bug have, and what did people',
    'say about it".',
  ].join(' '),
  inputSchema: getTaskInputShape,
  outputSchema: taskDetailOutputShape,
  handler: async (args, ctx) => {
    const includeComments = args.include_comments ?? false
    const detail = await getTaskDetail(ctx, args.task_id)
    const out = toTaskOut(detail, ctx)
    if (includeComments) {
      const comments = await getTaskComments(ctx, args.task_id)
      if (comments.length > 0) {
        out.comments = comments.map((c) => toCommentOut(c, ctx.timezone))
      }
    }
    return out
  },
  render: (out) => renderTask(out),
}

// ---------------------------------------------------------------------------
// clickup_list_tasks
// ---------------------------------------------------------------------------

const listTasksInputShape = {
  list_id: z.string().optional().describe('Restrict to one list id. Provide this or space_id, not neither.'),
  space_id: z.string().optional().describe('Restrict to one space id. Provide this or list_id, not neither.'),
  assignees: z.array(z.string()).optional().describe('Only tasks assigned to one of these user ids'),
  statuses: z.array(z.string()).optional().describe('Only tasks in one of these status names'),
  tags: z.array(z.string()).optional().describe('Only tasks carrying one of these tags'),
  due_before: z.string().optional().describe('Only tasks due before this date, e.g. "tomorrow" or an ISO date'),
  due_after: z.string().optional().describe('Only tasks due after this date'),
  include_closed: z.boolean().default(false).describe('Include tasks in a closed status'),
  include_subtasks: z.boolean().default(false).describe('Include subtasks in the results'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum tasks to return, default 25, max 100'),
  offset: z.number().int().min(0).default(0).describe('Number of matching tasks to skip'),
}

const listTasksOutputShape = {
  scope: z.string(),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  items: z.array(TaskSummarySchema),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
  /**
   * Present only when the walk over upstream pages hit its hard cap before
   * ClickUp confirmed the end (see `walkTaskPages`, src/clickup/pagination.ts).
   * `total`/`count` above only describe what was actually fetched, not the
   * true count matching the filter, whenever this is true.
   */
  bounded: z.boolean().optional(),
}

type ScopeInput = {
  listId: string | undefined
  spaceId: string | undefined
  statuses: string[] | undefined
  assignees: string[] | undefined
  tags: string[] | undefined
  dueBefore: string | undefined
  dueAfter: string | undefined
}

/**
 * Builds the human-readable "what did we ask for" string carried in both
 * the output and, when there are no results, the render - so an empty
 * result always names the filter that produced it (reliability rule 5)
 * rather than reading as an unexplained empty list.
 */
function describeScope(input: ScopeInput): string {
  const parts: string[] = []
  if (input.listId !== undefined) {
    parts.push(`list ${input.listId}`)
  } else if (input.spaceId !== undefined) {
    parts.push(`space ${input.spaceId}`)
  }
  if (input.statuses !== undefined && input.statuses.length > 0) {
    parts.push(`status in [${input.statuses.join(', ')}]`)
  }
  if (input.assignees !== undefined && input.assignees.length > 0) {
    parts.push(`assignees [${input.assignees.join(', ')}]`)
  }
  if (input.tags !== undefined && input.tags.length > 0) {
    parts.push(`tags [${input.tags.join(', ')}]`)
  }
  if (input.dueBefore !== undefined) {
    parts.push(`due before ${input.dueBefore}`)
  }
  if (input.dueAfter !== undefined) {
    parts.push(`due after ${input.dueAfter}`)
  }
  return parts.join(', ')
}

export const listTasksTool: ToolDefinition<typeof listTasksInputShape, typeof listTasksOutputShape> = {
  name: 'clickup_list_tasks',
  title: 'List ClickUp Tasks',
  category: 'tasks',
  mode: 'read',
  description: [
    'List tasks in one list or space, filtered by status, assignee, tag or due date - for when you',
    'already know where to look and want it narrowed down, as opposed to clickup_search_tasks, which',
    'finds tasks across the whole workspace by matching text. Requires list_id or space_id: it never',
    'silently falls back to the whole workspace. Filters are applied by ClickUp itself, not fetched',
    'and filtered locally.',
    'Examples: "what is still open in Sprint 1", "show tasks assigned to me due before Friday in the',
    'Engineering space".',
  ].join(' '),
  inputSchema: listTasksInputShape,
  outputSchema: listTasksOutputShape,
  handler: async (args, ctx) => {
    const listId = args.list_id
    const spaceId = args.space_id
    if (listId === undefined && spaceId === undefined) {
      throw new ClickUpUsageError(
        'clickup_list_tasks needs list_id or space_id to know where to look. Use clickup_get_workspace_tree ' +
          'to find one, or clickup_search_tasks to search the whole workspace by text instead.',
      )
    }
    if (listId !== undefined && spaceId !== undefined) {
      throw new ClickUpUsageError(
        `clickup_list_tasks needs exactly one of list_id or space_id, not both. Got list_id "${listId}" and ` +
          `space_id "${spaceId}". Drop whichever one you did not mean.`,
      )
    }

    const includeClosed = args.include_closed ?? false
    const includeSubtasks = args.include_subtasks ?? false
    const limit = args.limit ?? 25
    const offset = args.offset ?? 0

    const dueBeforeMs =
      args.due_before !== undefined ? resolveDate(args.due_before, { timezone: ctx.timezone }).epochMs : undefined
    const dueAfterMs =
      args.due_after !== undefined ? resolveDate(args.due_after, { timezone: ctx.timezone }).epochMs : undefined

    const { tasks, hasMoreUpstream, truncated } = await listTasksRaw(ctx, {
      listId,
      spaceId,
      assignees: args.assignees,
      statuses: args.statuses,
      tags: args.tags,
      dueBeforeMs,
      dueAfterMs,
      includeClosed,
      includeSubtasks,
      minItems: offset + limit,
    })

    const page = boundPage(paginate(tasks.map((t) => toTaskSummary(t, ctx.timezone)), { offset, limit }), {
      hasMoreUpstream,
    })
    const scope = describeScope({
      listId,
      spaceId,
      statuses: args.statuses,
      assignees: args.assignees,
      tags: args.tags,
      dueBefore: args.due_before,
      dueAfter: args.due_after,
    })
    return { scope, ...page, ...(truncated ? { bounded: true } : {}) }
  },
  render: (out) => {
    if (out.items.length === 0) {
      return out.bounded
        ? `No tasks found in ${out.scope}, but the result is bounded to the first 5 upstream pages (500 tasks) - ` +
            'the safety cap was hit before this could be confirmed as a true empty result. Narrow with more ' +
            'specific filters (status, assignee, tags, due dates) to search a smaller pool and get a definitive answer.'
        : `No tasks found in ${out.scope}`
    }
    return [
      `# Tasks in ${out.scope}`,
      '',
      `Showing ${out.count} of ${out.total}${out.has_more ? ' (more available, pass a higher offset)' : ''}`,
      ...(out.bounded
        ? [
            'Result bounded to the first 5 upstream pages (500 tasks) before this filter could confirm the end; ' +
              'narrow with more specific filters (status, assignee, tags, due dates) to see the rest.',
          ]
        : []),
      '',
      ...out.items.map(
        (t) =>
          `- ${nameWithId(t.name, t.id)} [${t.status}]${t.priority ? ` (${t.priority})` : ''}${
            t.due_date ? ` - due ${t.due_date}` : ''
          }${t.assignees && t.assignees.length > 0 ? ` - ${t.assignees.map((a) => a.username).join(', ')}` : ''}`,
      ),
    ].join('\n')
  },
}

// ---------------------------------------------------------------------------
// clickup_create_task
// ---------------------------------------------------------------------------

const createTaskInputShape = {
  list_id: z.string().describe('ClickUp list id to create the task in'),
  name: z.string().min(1).describe('Task name'),
  description: z.string().optional(),
  status: z.string().optional().describe('Must be one of the list\'s own status names - call clickup_get_list first'),
  assignees: z.array(z.string()).optional().describe('User ids to assign; resolve names with clickup_resolve_member'),
  tags: z.array(z.string()).optional(),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
  due_date: z.string().optional().describe('Natural language or ISO date, e.g. "tomorrow 17:00"'),
  start_date: z.string().optional(),
  time_estimate: z.string().optional().describe('Duration like "1h30m" or "45m"'),
  parent: z.string().optional().describe('Parent task id, to create this as a subtask'),
  custom_fields: customFieldsInputSchema
    .optional()
    .describe('Custom field values keyed by the field\'s name, not its id - call clickup_get_list to see names'),
}

export const createTaskTool: ToolDefinition<typeof createTaskInputShape, typeof taskDetailOutputShape> = {
  name: 'clickup_create_task',
  title: 'Create ClickUp Task',
  category: 'tasks',
  mode: 'write',
  description: [
    'Create a task in a ClickUp list. status and custom_fields are validated against the list\'s own',
    'definitions before anything is written, so a typo in either is rejected with the list\'s actual',
    'options rather than a raw API error. Set parent to create a subtask instead of a top-level task.',
    'Returns the task exactly as ClickUp reports it after creation, including the resolved due_date.',
    'Examples: "create a task \'Fix login bug\' in Sprint 1 due tomorrow at 5pm", "add a subtask',
    '\'Write migration\' under task 86abc".',
  ].join(' '),
  inputSchema: createTaskInputShape,
  outputSchema: taskDetailOutputShape,
  handler: async (args, ctx) => {
    if (args.status !== undefined) {
      const meta = await loadListMeta(ctx, args.list_id)
      assertValidStatus(meta, args.status)
    }

    const customFieldNames = args.custom_fields !== undefined ? Object.keys(args.custom_fields) : []
    const resolvedFields =
      args.custom_fields !== undefined ? await resolveCustomFields(ctx, args.list_id, args.custom_fields) : []

    const body = omitUnset({
      name: args.name,
      // `markdown_content`, not `description`: ClickUp's own contract says
      // markdown_content wins when both are sent, and it is the only write
      // field that preserves headings, bold, code spans and checkboxes.
      // Create and update use the same field so a task's description
      // survives the read/append/write round trip either tool starts.
      markdown_content: args.description,
      status: args.status,
      assignees: args.assignees !== undefined ? args.assignees.map(toAssigneeId) : undefined,
      tags: args.tags,
      priority: args.priority !== undefined ? PRIORITY_TO_INT[args.priority] : undefined,
      due_date: args.due_date !== undefined ? resolveDate(args.due_date, { timezone: ctx.timezone }).epochMs : undefined,
      start_date:
        args.start_date !== undefined ? resolveDate(args.start_date, { timezone: ctx.timezone }).epochMs : undefined,
      time_estimate: args.time_estimate !== undefined ? parseDuration(args.time_estimate) : undefined,
      parent: args.parent,
    })

    const created = await createTaskRaw(ctx, args.list_id, body)

    if (resolvedFields.length === 0) {
      return toTaskOut(created, ctx)
    }

    // The task already exists at this point. A custom-field write failing
    // here (rate limit, network blip - name validation already happened in
    // resolveCustomFields) must never make the caller lose the task id: a
    // thrown error here would look identical to "nothing was created" and
    // invite a retry that creates a duplicate. Every field write is
    // attempted independently and reported back, in the spirit of bulk
    // update's succeeded/failed split.
    const fieldResults = await Promise.allSettled(
      resolvedFields.map((f) => setCustomFieldValue(ctx, created.id, f.id, f.value)),
    )
    const customFieldErrors: Array<{ field: string; error: string }> = []
    fieldResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        customFieldErrors.push({
          field: customFieldNames[index] as string,
          error: toAgentMessage(result.reason, { resource: 'custom field', id: customFieldNames[index] as string }),
        })
      }
    })

    // Re-read the task so the returned custom_fields reflect what was
    // actually written, not the pre-field-write snapshot from `created`.
    // Routed through refetchAfterWrite, not a bare getTaskDetail: the task
    // (and possibly some or all of its custom fields) already exist in
    // ClickUp by this point, so a transient failure on THIS read must not
    // present as an undecorated error that loses the task id - the same
    // failure mode Finding 2 already fixed for the field writes themselves
    // would otherwise reopen one step later.
    const whatSucceeded =
      customFieldErrors.length > 0
        ? `Creating the task (${customFieldErrors.length} of ${resolvedFields.length} custom field write(s) failed, named below)`
        : `Creating the task and writing its ${resolvedFields.length} custom field(s)`
    const refetched = await refetchAfterWrite(ctx, created.id, whatSucceeded)
    const out = toTaskOut(refetched, ctx)
    if (customFieldErrors.length > 0) {
      out.custom_field_errors = customFieldErrors
    }
    return out
  },
  render: (out) => renderTask(out),
}

// ---------------------------------------------------------------------------
// clickup_update_task
// ---------------------------------------------------------------------------

const updateTaskInputShape = {
  task_id: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  assignees: z.array(z.string()).optional().describe('User ids to ADD as assignees (existing assignees are kept)'),
  tags: z.array(z.string()).optional(),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
  due_date: z.string().optional(),
  start_date: z.string().optional(),
  time_estimate: z.string().optional(),
  parent: z.string().optional(),
  custom_fields: customFieldsInputSchema.optional(),
  description_mode: z
    .enum(['append', 'overwrite'])
    .default('append')
    .describe('append (default) keeps the existing description; overwrite replaces it'),
}

/**
 * Appends to the description the server actually read - the markdown form
 * (`taskDescription`), not ClickUp's flattened `description`. Both halves of
 * the round trip have to be markdown: read markdown, write it back through
 * `markdown_content`. Reading the flattened form and PUTting it as the
 * task's whole new description is what silently strips headings, bold,
 * code spans and checkboxes from a task that had them.
 */
function appendDescription(current: string | undefined, addition: string): string {
  return current !== undefined && current.length > 0 ? `${current}\n\n${addition}` : addition
}

export const updateTaskTool: ToolDefinition<typeof updateTaskInputShape, typeof taskDetailOutputShape> = {
  name: 'clickup_update_task',
  title: 'Update ClickUp Task',
  category: 'tasks',
  mode: 'write',
  description: [
    'Update fields on an existing ClickUp task. Only the fields you pass are changed - everything',
    'else is left as-is. description defaults to APPEND: your text is added after the existing',
    'description with a blank line between them, never replacing it, unless you pass',
    'description_mode: "overwrite" explicitly. status and custom_fields are validated against the',
    'task\'s own list before anything is written. Returns the task as ClickUp reports it afterward.',
    'Examples: "add a note to task 86abc\'s description", "move task 86abc to in progress and set',
    'priority to urgent".',
  ].join(' '),
  inputSchema: updateTaskInputShape,
  outputSchema: taskDetailOutputShape,
  handler: async (args, ctx) => {
    const current = await getTaskDetail(ctx, args.task_id)
    const listId = current.list.id

    if (args.status !== undefined) {
      const meta = await loadListMeta(ctx, listId)
      assertValidStatus(meta, args.status)
    }

    const customFieldNames = args.custom_fields !== undefined ? Object.keys(args.custom_fields) : []
    const resolvedFields =
      args.custom_fields !== undefined ? await resolveCustomFields(ctx, listId, args.custom_fields) : []

    const descriptionMode = args.description_mode ?? 'append'
    const description =
      args.description !== undefined
        ? descriptionMode === 'overwrite'
          ? args.description
          : appendDescription(taskDescription(current), args.description)
        : undefined

    const body = omitUnset({
      name: args.name,
      // See clickup_create_task above for why this is `markdown_content`.
      markdown_content: description,
      status: args.status,
      assignees: args.assignees !== undefined ? { add: args.assignees.map(toAssigneeId) } : undefined,
      tags: args.tags,
      priority: args.priority !== undefined ? PRIORITY_TO_INT[args.priority] : undefined,
      due_date: args.due_date !== undefined ? resolveDate(args.due_date, { timezone: ctx.timezone }).epochMs : undefined,
      start_date:
        args.start_date !== undefined ? resolveDate(args.start_date, { timezone: ctx.timezone }).epochMs : undefined,
      time_estimate: args.time_estimate !== undefined ? parseDuration(args.time_estimate) : undefined,
      parent: args.parent,
    })

    const updated = await updateTaskRaw(ctx, args.task_id, body)

    if (resolvedFields.length === 0) {
      return toTaskOut(updated, ctx)
    }

    // Same reasoning as clickup_create_task: the update already happened,
    // so a custom-field write failure here must not make the task's id
    // and other real changes disappear behind a thrown error.
    const fieldResults = await Promise.allSettled(
      resolvedFields.map((f) => setCustomFieldValue(ctx, args.task_id, f.id, f.value)),
    )
    const customFieldErrors: Array<{ field: string; error: string }> = []
    fieldResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        customFieldErrors.push({
          field: customFieldNames[index] as string,
          error: toAgentMessage(result.reason, { resource: 'custom field', id: customFieldNames[index] as string }),
        })
      }
    })

    // See clickup_create_task above for why this goes through
    // refetchAfterWrite rather than a bare getTaskDetail.
    const whatSucceeded =
      customFieldErrors.length > 0
        ? `Updating the task (${customFieldErrors.length} of ${resolvedFields.length} custom field write(s) failed, named below)`
        : `Updating the task and writing its ${resolvedFields.length} custom field(s)`
    const refetched = await refetchAfterWrite(ctx, args.task_id, whatSucceeded)
    const out = toTaskOut(refetched, ctx)
    if (customFieldErrors.length > 0) {
      out.custom_field_errors = customFieldErrors
    }
    return out
  },
  render: (out) => renderTask(out),
}

// ---------------------------------------------------------------------------
// clickup_update_tasks_bulk
// ---------------------------------------------------------------------------

const bulkUpdateInputShape = {
  task_ids: z.array(z.string()).min(1).max(50),
  status: z.string().optional(),
  assignees: z.array(z.string()).optional().describe('User ids to ADD as assignees on every task'),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
  due_date: z.string().optional(),
}

const bulkUpdateOutputShape = {
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ task_id: z.string(), error: z.string() })),
}

export const updateTasksBulkTool: ToolDefinition<typeof bulkUpdateInputShape, typeof bulkUpdateOutputShape> = {
  name: 'clickup_update_tasks_bulk',
  title: 'Bulk Update ClickUp Tasks',
  category: 'tasks',
  mode: 'write',
  description: [
    'Apply the same status, assignee addition, priority or due date to up to 50 tasks in one call.',
    'Each task is updated independently and throttled through the shared ClickUp rate limiter: one',
    'bad id does not fail the whole batch. The result names exactly which ids succeeded and which',
    'failed, with why, rather than an all-or-nothing outcome. status is NOT pre-validated per task',
    'since the tasks may belong to different lists - a bad status name fails for just that task.',
    'Examples: "close these 5 tasks", "set priority urgent on all of these and assign them to me".',
  ].join(' '),
  inputSchema: bulkUpdateInputShape,
  outputSchema: bulkUpdateOutputShape,
  handler: async (args, ctx) => {
    const body = omitUnset({
      status: args.status,
      assignees: args.assignees !== undefined ? { add: args.assignees.map(toAssigneeId) } : undefined,
      priority: args.priority !== undefined ? PRIORITY_TO_INT[args.priority] : undefined,
      due_date: args.due_date !== undefined ? resolveDate(args.due_date, { timezone: ctx.timezone }).epochMs : undefined,
    })

    const results = await Promise.allSettled(args.task_ids.map((taskId) => updateTaskRaw(ctx, taskId, body)))

    const succeeded: string[] = []
    const failed: Array<{ task_id: string; error: string }> = []
    results.forEach((result, index) => {
      const taskId = args.task_ids[index] as string
      if (result.status === 'fulfilled') {
        succeeded.push(taskId)
      } else {
        failed.push({ task_id: taskId, error: toAgentMessage(result.reason, { resource: 'task', id: taskId }) })
      }
    })

    return { succeeded, failed }
  },
  render: (out) => renderBulkUpdateResult(out),
}

// ---------------------------------------------------------------------------
// clickup_move_task
// ---------------------------------------------------------------------------

const moveTaskInputShape = {
  task_id: z.string(),
  list_id: z.string().describe('Destination list id'),
  status_mappings: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .optional()
    .describe('How to remap the task\'s current status if the destination list does not have it'),
  move_custom_fields: z.boolean().default(true).describe('Carry the task\'s custom field values to the new list'),
}

export const moveTaskTool: ToolDefinition<typeof moveTaskInputShape, typeof taskDetailOutputShape> = {
  name: 'clickup_move_task',
  title: 'Move ClickUp Task',
  category: 'tasks',
  mode: 'write',
  description: [
    'Move a task to a different list (its "home list"), using ClickUp\'s v3 move endpoint. Before',
    'moving, this checks whether the task\'s current status exists in the destination list; if it',
    'does not, the move is rejected with the missing status named, unless status_mappings supplies',
    'a {from, to} entry for it. This surfaces the problem up front rather than letting ClickUp',
    'reject the move with a less specific error.',
    'Examples: "move task 86abc to the Backlog list", "move this task to Sprint 2, mapping \'triage\'',
    'to \'to do\'".',
  ].join(' '),
  inputSchema: moveTaskInputShape,
  outputSchema: taskDetailOutputShape,
  handler: async (args, ctx) => {
    const moveCustomFields = args.move_custom_fields ?? true
    const current = await getTaskDetail(ctx, args.task_id)
    const sourceListId = current.list.id
    const currentStatusName = current.status.status

    const destMeta = await loadListMeta(ctx, args.list_id)
    const destStatusNames = destMeta.statuses.map((s) => s.status)

    let statusMappings: MoveTaskBody['status_mappings']

    if (!destStatusNames.includes(currentStatusName)) {
      const mapping = (args.status_mappings ?? []).find((m) => m.from === currentStatusName)
      if (!mapping) {
        throw new ClickUpUsageError(
          `Task ${args.task_id}'s status "${currentStatusName}" does not exist in list ${args.list_id}. ` +
            `Available: ${destStatusNames.join(', ')}. Provide status_mappings to map it, ` +
            `e.g. [{ from: "${currentStatusName}", to: "<a status from the list above>" }].`,
        )
      }
      if (!destStatusNames.includes(mapping.to)) {
        throw new ClickUpUsageError(
          `status_mappings maps "${mapping.from}" to "${mapping.to}", but list ${args.list_id} has no status ` +
            `"${mapping.to}". Available: ${destStatusNames.join(', ')}.`,
        )
      }

      const sourceMeta = sourceListId === args.list_id ? destMeta : await loadListMeta(ctx, sourceListId)
      const sourceStatusId = sourceMeta.statuses.find((s) => s.status === mapping.from)?.id
      const destStatusId = destMeta.statuses.find((s) => s.status === mapping.to)?.id
      if (sourceStatusId === undefined || destStatusId === undefined) {
        throw new ClickUpUsageError(
          `Cannot map status "${mapping.from}" to "${mapping.to}": one of these lists reports no status id for ` +
            `it (it is on the default open/closed status set, not custom statuses), so ClickUp's move endpoint ` +
            `cannot be told how to remap it.`,
        )
      }
      statusMappings = [{ source_status_id: sourceStatusId, destination_status_id: destStatusId }]
    }

    await moveTaskHomeList(ctx, args.task_id, args.list_id, {
      move_custom_fields: moveCustomFields,
      ...(statusMappings !== undefined ? { status_mappings: statusMappings } : {}),
    })

    const moved = await refetchAfterWrite(ctx, args.task_id, `Moving the task to list ${args.list_id}`)
    return toTaskOut(moved, ctx)
  },
  render: (out) => renderTask(out),
}

// ---------------------------------------------------------------------------
// clickup_delete_task
// ---------------------------------------------------------------------------

const deleteTaskInputShape = {
  task_id: z.string(),
  confirm_name: z.string().describe('Must exactly match the task\'s current name - read it first if unsure'),
}

const deleteTaskOutputShape = {
  task_id: z.string(),
  deleted: z.boolean(),
}

export const deleteTaskTool: ToolDefinition<typeof deleteTaskInputShape, typeof deleteTaskOutputShape> = {
  name: 'clickup_delete_task',
  title: 'Delete ClickUp Task',
  category: 'tasks',
  mode: 'admin',
  description: [
    'Permanently delete a ClickUp task. This cannot be undone through this server - ClickUp has no',
    'undo for a deleted task, only its own trash UI, which this tool does not use. Requires',
    'confirm_name to exactly match the task\'s current name, read fresh at call time, so a stale or',
    'guessed id cannot destroy the wrong task. Only available in admin mode.',
    'Examples: "delete task 86abc, it is called \'Fix login bug\'", "remove the duplicate task I just',
    'created".',
  ].join(' '),
  inputSchema: deleteTaskInputShape,
  outputSchema: deleteTaskOutputShape,
  handler: async (args, ctx) => {
    // Read first, confirm, then delete - the same order every structure
    // delete tool uses. The DELETE call is never reached on a mismatch.
    const current = await getTaskDetail(ctx, args.task_id)
    assertConfirmName('task', current.name, args.confirm_name)
    await deleteTaskRaw(ctx, args.task_id)
    return { task_id: args.task_id, deleted: true }
  },
  render: (out) => `Task ${out.task_id} deleted.`,
}

// ---------------------------------------------------------------------------
// clickup_link_tasks
// ---------------------------------------------------------------------------

const linkTasksInputShape = {
  task_id: z.string(),
  other_task_id: z.string(),
  relation: z
    .enum(['link', 'blocks', 'blocked_by'])
    .default('link')
    .describe('"link" is a plain undirected link; "blocks"/"blocked_by" create a dependency'),
}

const linkTasksOutputShape = {
  ...taskDetailOutputShape,
  relation: z.enum(['link', 'blocks', 'blocked_by']),
  other_task_id: z.string(),
}

export const linkTasksTool: ToolDefinition<typeof linkTasksInputShape, typeof linkTasksOutputShape> = {
  name: 'clickup_link_tasks',
  title: 'Link ClickUp Tasks',
  category: 'tasks',
  mode: 'write',
  description: [
    'Relate two ClickUp tasks: a plain link (relation "link", the default), or a dependency where',
    'task_id blocks other_task_id ("blocks") or is blocked by it ("blocked_by"). Returns task_id\'s',
    'own state as ClickUp reports it after the link is created.',
    'Examples: "link task 86abc to 86def", "task 86abc cannot start until 86def is done".',
  ].join(' '),
  inputSchema: linkTasksInputShape,
  outputSchema: linkTasksOutputShape,
  handler: async (args, ctx) => {
    const relation = args.relation ?? 'link'
    if (relation === 'link') {
      await linkTasksRaw(ctx, args.task_id, args.other_task_id)
    } else if (relation === 'blocks') {
      await addDependency(ctx, args.task_id, { dependency_of: args.other_task_id })
    } else {
      await addDependency(ctx, args.task_id, { depends_on: args.other_task_id })
    }

    const whatSucceeded =
      relation === 'link'
        ? `Linking task ${args.task_id} to ${args.other_task_id}`
        : relation === 'blocks'
          ? `Making task ${args.task_id} block ${args.other_task_id}`
          : `Making task ${args.task_id} blocked by ${args.other_task_id}`
    const refetched = await refetchAfterWrite(ctx, args.task_id, whatSucceeded)
    return { relation, other_task_id: args.other_task_id, ...toTaskOut(refetched, ctx) }
  },
  render: (out) => {
    const verb = out.relation === 'link' ? 'linked to' : out.relation === 'blocks' ? 'blocks' : 'is blocked by'
    return [`Task ${out.id} ${verb} ${out.other_task_id}.`, '', renderTask(out)].join('\n')
  },
}

// ---------------------------------------------------------------------------
// clickup_get_task_time_in_status
// ---------------------------------------------------------------------------

const timeInStatusPeriodOutputShape = {
  status: z.string(),
  duration: z.string(),
  since: z.string().optional(),
}

const getTaskTimeInStatusInputShape = {
  task_id: z.string(),
}

const taskTimeInStatusOutputShape = {
  task_id: z.string(),
  current_status: z.object(timeInStatusPeriodOutputShape),
  status_history: z.array(z.object(timeInStatusPeriodOutputShape)),
}

export const getTaskTimeInStatusTool: ToolDefinition<
  typeof getTaskTimeInStatusInputShape,
  typeof taskTimeInStatusOutputShape
> = {
  name: 'clickup_get_task_time_in_status',
  title: 'Get ClickUp Task Time In Status',
  category: 'tasks',
  mode: 'read',
  description: [
    'How long a task has spent in its current status, and in every status before it - each duration in',
    '"1h 30m" form (never raw minutes or milliseconds). Requires the "Total time in Status" ClickApp to',
    'be enabled for this workspace by a Workspace owner or admin. When ClickUp\'s response does not carry',
    'the shape this needs, the call fails explicitly naming that ClickApp rather than ever reporting a',
    'confident "0m" or an empty history - this project could not verify what ClickUp actually returns',
    'when that ClickApp is disabled, so the failure is worded as "cannot tell", not a firm diagnosis. A',
    'task with no prior status changes states that plainly instead of an empty section.',
    'Examples: "how long has task 86abc been in review", "show the full status history and durations',
    'for task 86abc".',
  ].join(' '),
  inputSchema: getTaskTimeInStatusInputShape,
  outputSchema: taskTimeInStatusOutputShape,
  handler: async (args, ctx) => {
    const res = await getTaskTimeInStatusRaw(ctx, args.task_id)
    return toTaskTimeInStatusOut(args.task_id, res, ctx.timezone)
  },
  render: (out) => renderTaskTimeInStatus(out),
}

// ---------------------------------------------------------------------------
// clickup_get_tasks_time_in_status_bulk
// ---------------------------------------------------------------------------

/**
 * `min(2)` mirrors ClickUp's own "two or more tasks" contract for this
 * endpoint - one task belongs to `clickup_get_task_time_in_status` instead.
 * `max(500)` is this server's own overall-request cap, not ClickUp's (whose
 * only documented limit is per-upstream-request: "up to 100 task ids", the
 * `MAX_BULK_TIME_IN_STATUS_IDS` chunk size `getTasksTimeInStatusBulkRaw`
 * chunks at). 500 mirrors `walkTaskPages`'s own hard cap
 * (src/clickup/pagination.ts) - a sane upper bound on how much one call
 * should fan out into upstream requests (5 chunks of 100), not a limit
 * ClickUp itself imposes.
 */
const getTasksTimeInStatusBulkInputShape = {
  task_ids: z
    .array(z.string())
    .min(2)
    .max(500)
    .describe('Two or more task ids - use clickup_get_task_time_in_status for a single task'),
}

const taskTimeInStatusResultOutputShape = {
  task_id: z.string(),
  current_status: z.object(timeInStatusPeriodOutputShape).optional(),
  status_history: z.array(z.object(timeInStatusPeriodOutputShape)).optional(),
  note: z.string().optional(),
}

const tasksTimeInStatusBulkOutputShape = {
  results: z.array(z.object(taskTimeInStatusResultOutputShape)),
}

export const getTasksTimeInStatusBulkTool: ToolDefinition<
  typeof getTasksTimeInStatusBulkInputShape,
  typeof tasksTimeInStatusBulkOutputShape
> = {
  name: 'clickup_get_tasks_time_in_status_bulk',
  title: 'Get ClickUp Tasks Time In Status (Bulk)',
  category: 'tasks',
  mode: 'read',
  description: [
    'Time in status for two or more tasks in one call - one result per requested task_id, same order.',
    'Requests are chunked at 100 ids per upstream call (ClickUp\'s own documented limit for this',
    'endpoint), each one going through the shared rate limiter, so a large batch never sends one',
    'unbounded request. Requires the "Total time in Status" ClickApp to be enabled for this workspace.',
    'A task this server cannot report on - ClickUp\'s response omitted it, or did not carry the expected',
    'shape for it - gets an explicit note naming that ClickApp rather than a confident "0m"; this project',
    'could not verify what ClickUp actually returns when that ClickApp is disabled, so the note says',
    '"cannot tell", not a firm diagnosis. One bad id never hides real data for the rest of the batch.',
    'Examples: "how long has each of these 20 tasks been in its current status",',
    '"compare cycle time across task 86abc, 86def and 86ghi".',
  ].join(' '),
  inputSchema: getTasksTimeInStatusBulkInputShape,
  outputSchema: tasksTimeInStatusBulkOutputShape,
  handler: async (args, ctx) => {
    const outcomes = await getTasksTimeInStatusBulkRaw(ctx, args.task_ids)
    const results = args.task_ids.map((taskId) => {
      const outcome = outcomes.get(taskId) ?? ({ taskId, kind: 'missing' } as const)
      return toTaskTimeInStatusResultOut(outcome, ctx.timezone)
    })
    return { results }
  },
  render: (out) => renderTasksTimeInStatusBulk(out),
}

export const TASK_TOOLS: AnyToolDefinition[] = [
  getTaskTool,
  listTasksTool,
  createTaskTool,
  updateTaskTool,
  updateTasksBulkTool,
  moveTaskTool,
  deleteTaskTool,
  linkTasksTool,
  getTaskTimeInStatusTool,
  getTasksTimeInStatusBulkTool,
] as unknown as AnyToolDefinition[]
