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
