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

/**
 * Shared schema for a ClickUp endpoint that returns an empty (or
 * effectively empty, from this server's point of view) success body - most
 * delete and detach endpoints. Declared once here rather than redefined
 * per-`endpoints/*.ts` file, which used to happen identically in five
 * places.
 */
export const EmptyResponseSchema = z.object({}).passthrough()

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

/**
 * `content` is a list's description - nullable/absent on ClickUp's own
 * response exactly like `ListWriteResponseSchema.content` above, for the
 * same reason: a list created without one reports it as `null` or `""`,
 * never a placeholder string.
 */
export const ListDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    content: z.string().nullable().optional(),
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

/**
 * Declared here, ahead of `TaskSchema` below, rather than down with the
 * rest of the "Task-domain schemas" block further down this file: `TaskSchema`
 * now reuses both for its own (optional) `priority`/`assignees` fields, and
 * a `const` must be declared before the object literal that references it.
 * Reusing them rather than redeclaring the same shape inline is the same
 * consolidation this file's own history already applies elsewhere (see the
 * removed duplicate `CommentSchema` note on `CreateCommentResponseSchema`
 * below) - one definition of what a priority or an assignee looks like,
 * not two that can silently drift.
 */
export const TaskPrioritySchema = z
  .object({
    priority: z.string(),
  })
  .passthrough()

export const TaskAssigneeSchema = z
  .object({
    id: zId,
    username: z.string(),
  })
  .passthrough()

/**
 * `priority` and `assignees` are both declared optional/defaulted, exactly
 * as `TaskDetailSchema` declares them below: a task genuinely can have
 * neither, and ClickUp reports that as `priority: null` and `assignees: []`
 * respectively, never by omitting the keys. Added so `toTaskSummary`
 * (src/clickup/endpoints/tasks.ts) can carry both onto the compact summary
 * shape every list/search tool shares, matching what the vendor's own
 * equivalent already returns.
 */
export const TaskSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    text_content: z.string().nullable().optional(),
    status: TaskStatusSchema,
    priority: TaskPrioritySchema.nullable().optional(),
    assignees: z.array(TaskAssigneeSchema).default([]),
    url: z.string(),
    due_date: z.string().nullable().optional(),
    list: TaskListRefSchema,
  })
  .passthrough()

export type Task = z.infer<typeof TaskSchema>

/**
 * `last_page` is only ever present on the list-scoped "get tasks" response
 * (`GET /v2/list/{list_id}/task`); the team-scoped "get filtered team
 * tasks" response never reports it. Declared optional here, shared by both
 * callers, so `walkTaskPages` (src/clickup/pagination.ts) can read it when
 * present and fall back to its short-page heuristic when it is not.
 */
export const GetTasksResponseSchema = z
  .object({
    tasks: z.array(TaskSchema),
    last_page: z.boolean().optional(),
  })
  .passthrough()

/**
 * Task-domain schemas for the eight task tools (Task 11). Kept separate from
 * the lighter `TaskSchema` above, which only backs workspace-wide search and
 * listing and so still omits most of what these schemas add (tags, custom
 * field values, subtasks) - `priority` and `assignees` are the two fields
 * `TaskSchema` now also carries, via `TaskPrioritySchema`/`TaskAssigneeSchema`
 * above, so a task summary is not left one `clickup_get_task` call away from
 * answering who owns it and how urgent it is. These schemas back the
 * single-task read/write endpoints, which report considerably more of the
 * task, all sourced from ClickUp's GET/POST/PUT task reference pages linked
 * from developer.clickup.com/docs/open-api-spec.md.
 */

export const TaskTagSchema = z
  .object({
    name: z.string(),
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

/**
 * The single comment shape shared by every comment-reading path in this
 * server: `clickup_get_comments` (Task 12) and `clickup_get_task`'s
 * `include_comments` option (Task 11) both fetch `GET /task/{id}/comment`
 * and both parse its `comments[]` entries through this one schema - there
 * is deliberately no second, comments.ts-local copy of it, so the two
 * tools cannot drift on what a comment carries (see the fix note on
 * `CreateCommentResponseSchema` below for the incident this schema used to
 * cause by existing twice).
 *
 * `date` is declared as a string-or-number union: ClickUp's own docs show
 * it as a string (an epoch-millisecond string, matching every other date
 * field this server reads) on this list-comments shape, while the
 * create-comment endpoint's own response (`CreateCommentResponseSchema`
 * below) reports it as a genuine integer - accepted as either rather than
 * assumed to agree.
 */
export const TaskCommentSchema = z
  .object({
    id: z.string(),
    comment_text: z.string(),
    user: CommentAuthorSchema,
    date: z.union([z.string(), z.number()]),
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
 *
 * `markdown_description` is the task's description with its formatting
 * intact (headings, bold, code spans, checkboxes). ClickUp only returns it
 * when `include_markdown_description=true` is passed - see `getTaskDetail`
 * (src/clickup/endpoints/tasks.ts), which always passes it - so it is
 * optional here: a write endpoint's own response (POST/PUT task) carries no
 * query parameters and so never includes it. `description` is the same text
 * flattened to plain lines and is only used as a fallback, never in
 * preference: appending to the flattened form and writing it back is how a
 * formatted description gets destroyed.
 */
export const TaskDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    markdown_description: z.string().nullable().optional(),
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
 * list of tasks rather than one task in full (`clickup_list_tasks`,
 * `clickup_search_tasks` and `clickup_get_my_day`'s `due_today`/`overdue`).
 * Exported as a zod schema, not just a TypeScript type, so a consuming tool
 * can build its own `outputSchema` as `z.array(TaskSummarySchema)` without
 * redeclaring the shape - the same role `TaskDetailSchema` plays for a
 * single task.
 *
 * `priority` and `assignees` mirror `TaskOut`'s own fields of the same name
 * (src/clickup/endpoints/tasks.ts): both optional, both omitted rather than
 * rendered as null/empty when ClickUp reports no priority or no assignee,
 * per reliability rule 2. Added so "which of these is urgent, and who owns
 * it" does not cost one `clickup_get_task` per row - the vendor's own
 * equivalent already returns both on its list view.
 */
export const TaskSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  priority: z.string().optional(),
  assignees: z.array(z.object({ id: z.string(), username: z.string() })).optional(),
  list_id: z.string(),
  list_name: z.string(),
  url: z.string(),
  due_date: z.string().optional(),
})

export type TaskSummary = z.infer<typeof TaskSummarySchema>

/**
 * One `current_status`/`status_history` entry from
 * `GET /task/{task_id}/time_in_status` or its bulk variant. `status` and
 * `total_time.by_minute` are both REQUIRED here (not `.nullable()` or
 * `.optional()`), unlike most schemas in this file, which lean permissive.
 * That is deliberate, though the reason has narrowed since this schema was
 * first written: a live workspace whose plan does not include "Total time
 * in Status" does not reach this schema at all - ClickUp rejects the
 * request outright with an HTTP error (observed live: 403, "Time In Status
 * is not available on your plan"), caught and surfaced at the client/error
 * layer before any body is ever parsed against this schema (see
 * `clickup/client.ts` and `core/errors.ts`). What this strict schema
 * guards is the remaining case: a 2xx response that, for some other
 * reason, does not carry a real status/by_minute pair. A response that
 * fails this schema must still not silently default to `0` -
 * `getTaskTimeInStatusRaw`/`getTasksTimeInStatusBulkRaw`
 * (src/clickup/endpoints/tasks.ts) turn exactly that failure into an
 * explicit "cannot report time in status" error naming the gap, rather
 * than ever rendering a confident "0m".
 *
 * `total_time.since`, by contrast, IS `.nullable()` (in addition to
 * `.optional()`) - the same pattern `ListDetailSchema.task_count` and
 * `TaskDetailSchema.time_estimate` already use elsewhere in this file for a
 * ClickUp field that can genuinely arrive as an explicit `null`. Declaring
 * it required-non-null would have made a real ClickUp response (current
 * status/history genuinely present, `since` merely not yet known) fail the
 * same strict parse that `status`/`by_minute` deliberately do fail on a
 * shapeless response - turning a CORRECT answer into the shapeless-response
 * error this schema exists to guard against, exactly the failure mode the
 * increment review flagged. `toTimeInStatusPeriodOut`
 * (src/clickup/endpoints/tasks.ts) treats `null` the same as absent: no
 * `since` line, never a fabricated epoch-zero date from `Number(null)`.
 */
export const TimeInStatusPeriodSchema = z
  .object({
    status: z.string(),
    color: z.string().optional(),
    total_time: z
      .object({
        by_minute: z.number(),
        since: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough()

/**
 * A `status_history` entry additionally carries `type`/`orderindex`, which
 * `current_status` never does - otherwise identical to
 * `TimeInStatusPeriodSchema` above.
 */
export const TimeInStatusHistoryEntrySchema = z
  .object({
    status: z.string(),
    color: z.string().optional(),
    type: z.string().optional(),
    orderindex: z.number().optional(),
    total_time: z
      .object({
        by_minute: z.number(),
        since: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough()

export const TaskTimeInStatusResponseSchema = z
  .object({
    current_status: TimeInStatusPeriodSchema,
    status_history: z.array(TimeInStatusHistoryEntrySchema).default([]),
  })
  .passthrough()

export type TaskTimeInStatusResponse = z.infer<typeof TaskTimeInStatusResponseSchema>

/**
 * `GET /task/bulk_time_in_status/task_ids`'s own response shape: an object
 * keyed by task id, not an array - each value the same shape
 * `TaskTimeInStatusResponseSchema` describes for one task. Deliberately
 * loose (`z.unknown()` per value) at the client-request boundary: unlike
 * every other schema in this file, a single malformed entry here must not
 * fail the whole batch the way `z.record(TaskTimeInStatusResponseSchema)`
 * would - `getTasksTimeInStatusBulkRaw` re-validates each entry individually
 * against `TaskTimeInStatusResponseSchema` afterward, so one shapeless task
 * among many produces one explicit per-task note, not a batch-wide failure.
 */
export const BulkTimeInStatusRawResponseSchema = z.record(z.string(), z.unknown())
export type BulkTimeInStatusRawResponse = z.infer<typeof BulkTimeInStatusRawResponseSchema>

/**
 * `POST /v2/task/{task_id}/comment`'s own response - a minimal
 * acknowledgement (id, hist_id, date), not a full comment object, unlike
 * `TaskCommentSchema` above which backs both places this server actually
 * reads a comment's full content back. `date` is documented as an integer
 * here, unlike the string form `TaskCommentSchema.date` declares for the
 * list endpoint - accepted as either rather than assumed to match, the
 * same normalisation `TaskCommentSchema.date` applies.
 *
 * This server previously also had a second, near-identical schema here
 * (`CommentSchema`/`GetCommentsResponseSchema`, added alongside a second
 * `getComments` endpoint function) that duplicated `TaskCommentSchema`
 * above rather than reusing it. The two silently diverged on whether
 * `date` was declared at all, which meant `clickup_get_comments` rendered
 * an offset-carrying timestamp while `clickup_get_task(include_comments:
 * true)` - reading the exact same `GET /task/{id}/comment` response -
 * silently dropped it. Removed; `TaskCommentSchema` is now the only
 * comment-list schema in this server.
 */
export const CreateCommentResponseSchema = z
  .object({
    id: z.string(),
    hist_id: z.string(),
    date: z.union([z.string(), z.number()]),
  })
  .passthrough()

/**
 * Tag-domain schemas (Task 12), sourced from ClickUp's "Get Space Tags",
 * "Add Tag To Task" and "Remove Tag From Task" reference pages.
 * `tag_fg`/`tag_bg` are declared optional even though ClickUp's own spec
 * marks them required: a workspace-created tag has always carried both in
 * practice, but nothing in this server depends on that holding forever, and
 * treating them as optional costs nothing since only `name` is ever read.
 */
export const SpaceTagSchema = z
  .object({
    name: z.string(),
    tag_fg: z.string().optional(),
    tag_bg: z.string().optional(),
  })
  .passthrough()

export type SpaceTag = z.infer<typeof SpaceTagSchema>

export const GetSpaceTagsResponseSchema = z
  .object({
    tags: z.array(SpaceTagSchema),
  })
  .passthrough()

/**
 * Structure-domain schemas (Task 13): space, folder and list, as returned
 * by ClickUp's create/update/get endpoints for each
 * (developer.clickup.com's "Create Space"/"Update Space"/"Get Space",
 * "Create Folder"/"Update Folder"/"Get Folder", "Create Folderless List"/
 * "Create List"/"Update List" reference pages). Deliberately narrower than
 * the full response ClickUp sends (which also carries `statuses`,
 * `features`, `multiple_assignees`, ...): only the fields this server's
 * structure tools actually read or return are declared, per the same
 * reasoning `TaskSummarySchema` is narrower than `TaskDetailSchema`.
 */
export const SpaceDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    private: z.boolean().optional(),
  })
  .passthrough()

export type SpaceDetail = z.infer<typeof SpaceDetailSchema>

export const FolderDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough()

export type FolderDetail = z.infer<typeof FolderDetailSchema>

/**
 * `content` and `due_date` are both nullable/absent on ClickUp's own list
 * response (a list created without either reports them as `null` or an
 * empty string) - declared optional and nullable per reliability rule 2,
 * never defaulted.
 */
export const ListWriteResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    content: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
  })
  .passthrough()

export type ListWriteResponse = z.infer<typeof ListWriteResponseSchema>

/**
 * Time-domain schemas (Task 14), sourced from ClickUp's "Start a Time
 * Entry", "Stop a Time Entry", "Get Running Time Entry", "Get Time Entries
 * Within a Date Range", "Create a Time Entry", "Update a Time Entry" and
 * "Delete a Time Entry" reference pages (developer.clickup.com/reference/
 * start|stop|create|update|deleteatimeentry.md, gettimeentrieswithinadaterange.md,
 * getrunningtimeentry.md).
 *
 * `start`/`end`/`duration`/`at` are all declared as string-or-number unions:
 * ClickUp's own docs disagree with each other on whether these are strings
 * or integers across this endpoint family (list entries document `duration`
 * as a string; start/stop/create document it as an integer), and a running
 * entry's `duration` is additionally documented as *negative* - "a time
 * entry that has a negative duration means that timer is currently running
 * for that user." Accepted as either shape rather than assumed to agree,
 * the same normalisation `TaskCommentSchema.date` and `zId` apply elsewhere
 * in this file.
 */
export const TimeEntryUserSchema = z
  .object({
    id: zId,
    username: z.string(),
  })
  .passthrough()

/**
 * A time entry's nested task, present only when the entry is associated
 * with one - `tid` is optional on every write endpoint, and ClickUp's own
 * examples show `task: null` for an untracked (task-less) entry.
 */
export const TimeEntryTaskRefSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: TaskStatusSchema.optional(),
  })
  .passthrough()

export const TimeEntryTagSchema = z
  .object({
    name: z.string(),
  })
  .passthrough()

/**
 * Present only when the request that fetched this entry passed
 * `include_location_names=true` (see `listTimeEntriesRaw`,
 * src/clickup/endpoints/time.ts, which always does). ClickUp's own example
 * for this shape reports the three ids as numbers and the three names as
 * strings, each independently optional - a `task_location` can carry a
 * `list_id`/`list_name` with no `folder_id`/`folder_name` at all, for an
 * entry logged against a folderless list.
 */
export const TimeEntryLocationSchema = z
  .object({
    list_id: zId.optional(),
    folder_id: zId.optional(),
    space_id: zId.optional(),
    list_name: z.string().optional(),
    folder_name: z.string().optional(),
    space_name: z.string().optional(),
  })
  .passthrough()

export const TimeEntrySchema = z
  .object({
    id: z.string(),
    task: TimeEntryTaskRefSchema.nullable().optional(),
    user: TimeEntryUserSchema.optional(),
    billable: z.boolean().optional(),
    start: z.union([z.string(), z.number()]),
    end: z.union([z.string(), z.number()]).nullable().optional(),
    duration: z.union([z.string(), z.number()]),
    description: z.string().optional(),
    tags: z.array(TimeEntryTagSchema).default([]),
    task_location: TimeEntryLocationSchema.optional(),
  })
  .passthrough()

export type TimeEntry = z.infer<typeof TimeEntrySchema>

/**
 * `GET .../time_entries/current`'s own response: `data` is `null` when
 * nothing is running, a `TimeEntry` otherwise. Kept separate from
 * `TimeEntryResponseSchema` below because "absent" and "present but this
 * shape" are different questions here - the write endpoints never return a
 * null entry, only this one can.
 */
export const RunningTimeEntryResponseSchema = z
  .object({
    data: TimeEntrySchema.nullable(),
  })
  .passthrough()

/**
 * The shared response shape for start/stop/create/update: ClickUp's own
 * reference pages disagree on whether these wrap the entry in a `data`
 * property (start, stop and delete are documented and consistently
 * wrapped; create's own example shows the entry unwrapped, and update's
 * page documents no shape at all). Accepted as either - the wrapped form is
 * unwrapped by the transform, the bare form passes through as-is - rather
 * than assumed to match only the documented common case.
 */
export const TimeEntryResponseSchema = z.union([
  z
    .object({ data: TimeEntrySchema })
    .passthrough()
    .transform((v) => v.data),
  TimeEntrySchema,
])

export const GetTimeEntriesResponseSchema = z
  .object({
    data: z.array(TimeEntrySchema),
  })
  .passthrough()

/**
 * Docs-domain schemas (Task 16), sourced from ClickUp's v3 OpenAPI
 * specification (developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml) -
 * every other schema in this file backs a v2 endpoint; the v3 Docs API has
 * its own DTOs (`PublicDocsDocCoreDto`, `PublicDocsPageV3Dto`) that do not
 * share shape with anything above. Narrowed to the fields this server
 * actually reads, the same reasoning `SpaceDetailSchema` etc. above apply.
 *
 * ClickUp's v3 "Search Docs" endpoint (`GET /v3/workspaces/{teamId}/docs`)
 * has no free-text query parameter server-side - only `id`, `creator`,
 * `deleted`, `archived`, `parent_id`, `parent_type`, `limit` and `cursor`.
 * `clickup_search_docs` (src/tools/docs.ts) matches on `name` client-side
 * over one page of results; this schema only declares `id` and `name`
 * because that is all that call reads.
 */
export const DocSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough()

export type Doc = z.infer<typeof DocSchema>

export const SearchDocsResponseSchema = z
  .object({
    docs: z.array(DocSchema),
    next_cursor: z.string().optional(),
  })
  .passthrough()

/**
 * `PublicDocsPageV3Dto`, shared by both `GET .../docs/{docId}/pages` (an
 * array of these, content included) and `GET .../docs/{docId}/pages/{pageId}`
 * (one of these). ClickUp's spec marks `content` required and never null on
 * both, but it is declared optional here anyway per reliability rule 2 -
 * this server treats a field's presence as something to observe from the
 * actual response, not assume from what a spec claims.
 */
export const DocPageSchema = z
  .object({
    id: z.string(),
    doc_id: z.string(),
    name: z.string(),
    content: z.string().optional(),
  })
  .passthrough()

export type DocPage = z.infer<typeof DocPageSchema>

export const GetDocPagesResponseSchema = z.array(DocPageSchema)
