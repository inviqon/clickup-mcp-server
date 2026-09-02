import { z } from 'zod'

/**
 * Zod schemas mirroring the ClickUp API responses this server reads, sourced
 * from ClickUp's own OpenAPI specification (developer.clickup.com/docs/open-api-spec.md)
 * and its per-endpoint reference pages. Every schema uses `.passthrough()` so
 * a field ClickUp adds later does not break parsing (reliability rule 1), but
 * every field the rest of the server reads is declared explicitly here -
 * reading an undeclared field is not possible by construction, because
 * nothing downstream sees fields this file did not name.
 *
 * This file holds navigation-domain schemas only (team, space, folder, list,
 * custom field, member, task-for-search). Later tasks add sibling schema
 * groups for tasks, comments, tags and time tracking rather than growing
 * this file indefinitely.
 */

/**
 * Some ClickUp endpoints return numeric ids (`/v2/team`, `/v2/user`), others
 * string ids (`/v2/space`, `/v2/list`, `/v2/task`, ...). Normalised to a
 * string here so every id in this server's output has one consistent type.
 * This does not construct or alter the id's value, only its representation -
 * the underlying identifier is copied verbatim either way.
 */
const zId = z.union([z.string(), z.number()]).transform((value) => String(value))

export const MemberUserSchema = z
  .object({
    id: zId,
    username: z.string(),
    email: z.string().optional(),
  })
  .passthrough()

export type MemberUser = z.infer<typeof MemberUserSchema>

export const TeamMemberSchema = z
  .object({
    user: MemberUserSchema,
  })
  .passthrough()

export const TeamSchema = z
  .object({
    id: zId,
    name: z.string(),
    members: z.array(TeamMemberSchema).default([]),
  })
  .passthrough()

export const GetTeamsResponseSchema = z
  .object({
    teams: z.array(TeamSchema),
  })
  .passthrough()

export const AuthorizedUserSchema = z
  .object({
    user: MemberUserSchema,
  })
  .passthrough()

export const SpaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough()

export const GetSpacesResponseSchema = z
  .object({
    spaces: z.array(SpaceSchema),
  })
  .passthrough()

export type Space = z.infer<typeof SpaceSchema>

export const FolderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough()

export const GetFoldersResponseSchema = z
  .object({
    folders: z.array(FolderSchema),
  })
  .passthrough()

export type Folder = z.infer<typeof FolderSchema>

/**
 * `task_count` is documented as a number on some list endpoints and a
 * numeric string on others, and is nullable on both. Accepted as any of the
 * three and normalised downstream rather than assumed to be one shape.
 */
export const ListSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    task_count: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough()

export const GetListsResponseSchema = z
  .object({
    lists: z.array(ListSummarySchema),
  })
  .passthrough()

export type ListSummary = z.infer<typeof ListSummarySchema>

/**
 * `id` is only present on a list's statuses when the list uses ClickUp's
 * custom-status ClickApp; a list on the default open/closed statuses has
 * none. Declared optional rather than assumed present, per reliability rule
 * 2 - a missing id is omitted from output, never invented.
 */
export const ListStatusSchema = z
  .object({
    id: z.string().optional(),
    status: z.string(),
    type: z.string(),
  })
  .passthrough()

export const ListDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    statuses: z.array(ListStatusSchema).default([]),
  })
  .passthrough()

export const CustomFieldOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough()

export const CustomFieldSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    type_config: z
      .object({
        options: z.array(CustomFieldOptionSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const GetCustomFieldsResponseSchema = z
  .object({
    fields: z.array(CustomFieldSchema),
  })
  .passthrough()

export const TaskStatusSchema = z
  .object({
    status: z.string(),
  })
  .passthrough()

export const TaskListRefSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough()

export const TaskSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    text_content: z.string().nullable().optional(),
    status: TaskStatusSchema,
    url: z.string(),
    due_date: z.string().nullable().optional(),
    list: TaskListRefSchema,
  })
  .passthrough()

export type Task = z.infer<typeof TaskSchema>

export const GetTasksResponseSchema = z
  .object({
    tasks: z.array(TaskSchema),
  })
  .passthrough()

/**
 * Task-domain schemas for the eight task tools (Task 11). Kept separate from
 * the lighter `TaskSchema` above, which is deliberately minimal because it
 * only backs workspace-wide search and listing. These schemas back the
 * single-task read/write endpoints, which report considerably more of the
 * task (priority, tags, assignees, custom field values, subtasks), all
 * sourced from ClickUp's GET/POST/PUT task reference pages linked from
 * developer.clickup.com/docs/open-api-spec.md.
 */

export const TaskPrioritySchema = z
  .object({
    priority: z.string(),
  })
  .passthrough()

export const TaskTagSchema = z
  .object({
    name: z.string(),
  })
  .passthrough()

export const TaskAssigneeSchema = z
  .object({
    id: zId,
    username: z.string(),
  })
  .passthrough()

/**
 * `value` is deliberately `z.unknown()`: a custom field's value shape
 * depends entirely on the field's `type` (a string for text fields, a
 * number for number fields, an array of option ids for a multi-select,
 * ...), and this server never interprets that value itself - it is read
 * back and rendered verbatim, never computed on.
 */
export const TaskCustomFieldValueSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    value: z.unknown().optional(),
  })
  .passthrough()

/**
 * A subtask as ClickUp nests it inside a parent task's `subtasks` array
 * (present only when the parent was fetched with `include_subtasks=true`).
 * Deliberately narrow - just enough to render a subtask compactly - rather
 * than reusing `TaskDetailSchema`, which would demand fields (`list`, `url`)
 * ClickUp does not actually nest on a subtask entry.
 */
export const SubtaskSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: TaskStatusSchema,
  })
  .passthrough()

export const CommentAuthorSchema = z
  .object({
    id: zId,
    username: z.string(),
  })
  .passthrough()

export const TaskCommentSchema = z
  .object({
    id: z.string(),
    comment_text: z.string(),
    user: CommentAuthorSchema,
  })
  .passthrough()

export type TaskComment = z.infer<typeof TaskCommentSchema>

export const GetTaskCommentsResponseSchema = z
  .object({
    comments: z.array(TaskCommentSchema),
  })
  .passthrough()

/**
 * The full single-task shape returned by GET/POST/PUT task endpoints.
 * `due_date`, `start_date` and `time_estimate` are all nullable per
 * reliability rule 2 - a task genuinely can have none of these set, and
 * that must come through as "absent" in this server's output, never as a
 * guessed value.
 */
export const TaskDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    status: TaskStatusSchema,
    priority: TaskPrioritySchema.nullable().optional(),
    tags: z.array(TaskTagSchema).default([]),
    assignees: z.array(TaskAssigneeSchema).default([]),
    due_date: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    time_estimate: z.union([z.string(), z.number()]).nullable().optional(),
    parent: z.string().nullable().optional(),
    custom_fields: z.array(TaskCustomFieldValueSchema).default([]),
    list: TaskListRefSchema,
    url: z.string(),
    subtasks: z.array(SubtaskSchema).optional(),
  })
  .passthrough()

export type TaskDetail = z.infer<typeof TaskDetailSchema>

/**
 * The normalised task summary shape shared by every tool that returns a
 * list of tasks rather than one task in full (`clickup_list_tasks`, and the
 * `succeeded`/bulk-adjacent views in later tasks). Exported as a zod schema,
 * not just a TypeScript type, so a consuming tool can build its own
 * `outputSchema` as `z.array(TaskSummarySchema)` without redeclaring the
 * shape - the same role `TaskDetailSchema` plays for a single task.
 */
export const TaskSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  list_id: z.string(),
  list_name: z.string(),
  url: z.string(),
  due_date: z.string().optional(),
})

export type TaskSummary = z.infer<typeof TaskSummarySchema>
