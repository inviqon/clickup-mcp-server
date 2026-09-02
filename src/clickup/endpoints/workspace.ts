import type { ClickUpContext } from '../../core/context.js'
import { walkTaskPages } from '../pagination.js'
import {
  AuthorizedUserSchema,
  GetCustomFieldsResponseSchema,
  GetFoldersResponseSchema,
  GetListsResponseSchema,
  GetSpacesResponseSchema,
  GetTasksResponseSchema,
  GetTeamsResponseSchema,
  ListDetailSchema,
  type CustomFieldSchema,
  type Folder,
  type ListSummary,
  type MemberUser,
  type Space,
  type Task,
} from '../schemas.js'
import { z } from 'zod'

type CustomField = z.infer<typeof CustomFieldSchema>

// -- Raw endpoint calls ------------------------------------------------

export async function getSpaces(ctx: ClickUpContext): Promise<Space[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/team/${ctx.teamId}/space`,
    schema: GetSpacesResponseSchema,
  })
  return res.spaces
}

export async function getFolders(ctx: ClickUpContext, spaceId: string): Promise<Folder[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/space/${spaceId}/folder`,
    schema: GetFoldersResponseSchema,
  })
  return res.folders
}

export async function getFolderlessLists(ctx: ClickUpContext, spaceId: string): Promise<ListSummary[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/space/${spaceId}/list`,
    schema: GetListsResponseSchema,
  })
  return res.lists
}

export async function getListsInFolder(ctx: ClickUpContext, folderId: string): Promise<ListSummary[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/folder/${folderId}/list`,
    schema: GetListsResponseSchema,
  })
  return res.lists
}

export function getList(ctx: ClickUpContext, listId: string) {
  return ctx.client.request({
    method: 'GET',
    path: `/list/${listId}`,
    schema: ListDetailSchema,
  })
}

export async function getListFields(ctx: ClickUpContext, listId: string): Promise<CustomField[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/list/${listId}/field`,
    schema: GetCustomFieldsResponseSchema,
  })
  return res.fields
}

/**
 * Members of the workspace identified by `ctx.teamId`. `GET /v2/team`
 * returns every team (workspace) the token can see, so the one matching
 * `ctx.teamId` is picked out here rather than assuming it is the only one
 * in the response.
 */
export async function getTeamMembers(ctx: ClickUpContext): Promise<MemberUser[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: '/team',
    schema: GetTeamsResponseSchema,
  })
  const team = res.teams.find((t) => t.id === ctx.teamId)
  return team ? team.members.map((m) => m.user) : []
}

export async function getAuthorizedUser(ctx: ClickUpContext): Promise<MemberUser> {
  const res = await ctx.client.request({
    method: 'GET',
    path: '/user',
    schema: AuthorizedUserSchema,
  })
  return res.user
}

export type WorkspaceTaskFilter = {
  spaceId?: string | undefined
  listId?: string | undefined
  includeClosed?: boolean | undefined
}

export type WorkspaceTasksResult = {
  tasks: Task[]
  /**
   * True when more tasks may exist upstream than `tasks` holds - see
   * `walkTaskPages` (src/clickup/pagination.ts). `clickup_search_tasks`
   * must not report an exact total, and must force `has_more`, when this
   * is true.
   */
  hasMoreUpstream: boolean
  /** True when the 5-page walk cap was hit before the end was confirmed. */
  truncated: boolean
}

/**
 * `GET /v2/team/{teamId}/task` has no text search parameter: it filters by
 * structure (space, list, status, assignee, ...) and date ranges, never by
 * what the task is about. `clickup_search_tasks` fetches the (optionally
 * space/list-narrowed) task list here and does the text matching itself.
 *
 * A single call to this endpoint returns at most one 100-task upstream
 * page, which is not the same thing as "every task matching the filter" -
 * a workspace with more than 100 tasks in scope silently lost everything
 * past the first page before this used `walkTaskPages`. Since local text
 * filtering happens after this returns, and the match rate against the
 * query is unknowable in advance, this walks up to the shared 5-page cap
 * every time rather than trying to guess how many raw tasks would be
 * "enough" - `clickup_list_tasks`'s `listTasksRaw`, whose filters are all
 * applied server-side, can target a precise `minItems` instead.
 */
export async function getWorkspaceTasks(
  ctx: ClickUpContext,
  filter: WorkspaceTaskFilter = {},
): Promise<WorkspaceTasksResult> {
  const walked = await walkTaskPages(async (page) => {
    const res = await ctx.client.request({
      method: 'GET',
      path: `/team/${ctx.teamId}/task`,
      schema: GetTasksResponseSchema,
      query: {
        'space_ids[]': filter.spaceId,
        'list_ids[]': filter.listId,
        include_closed: filter.includeClosed ?? false,
        page,
      },
    })
    return { tasks: res.tasks }
  }, Number.MAX_SAFE_INTEGER)

  return { tasks: walked.items, hasMoreUpstream: walked.hasMoreUpstream, truncated: walked.truncated }
}

// -- Assembled, cached views ---------------------------------------------

export type ListSummaryOut = {
  id: string
  name: string
  task_count?: number | undefined
}

export type FolderOut = {
  id: string
  name: string
  lists: ListSummaryOut[]
}

export type SpaceOut = {
  id: string
  name: string
  folders: FolderOut[]
  lists: ListSummaryOut[]
}

export type WorkspaceTree = {
  team_id: string
  spaces: SpaceOut[]
}

/**
 * Normalises `task_count`, which ClickUp reports as a number, a numeric
 * string, or `null` depending on the endpoint, into a plain number - present
 * only when the API actually reported one. `null` and an unparsable value
 * both fall through to "absent" rather than surfacing as `0` or `NaN`,
 * because either would be a value this server invented, not one ClickUp
 * sent.
 */
function toListSummaryOut(list: ListSummary): ListSummaryOut {
  const raw = list.task_count
  const taskCount = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : undefined
  return {
    id: list.id,
    name: list.name,
    ...(taskCount !== undefined && !Number.isNaN(taskCount) ? { task_count: taskCount } : {}),
  }
}

/**
 * Fans out over every space and, within each, every folder, fetching
 * folders, folderless lists and each folder's lists concurrently under the
 * shared rate limiter. Folderless lists are carried on `space.lists` as
 * their own field rather than being nested under an invented folder.
 */
async function buildWorkspaceTree(ctx: ClickUpContext): Promise<WorkspaceTree> {
  const spaces = await getSpaces(ctx)

  const spaceNodes = await Promise.all(
    spaces.map(async (space): Promise<SpaceOut> => {
      const [folders, folderlessLists] = await Promise.all([
        getFolders(ctx, space.id),
        getFolderlessLists(ctx, space.id),
      ])

      const folderNodes = await Promise.all(
        folders.map(async (folder): Promise<FolderOut> => {
          const lists = await getListsInFolder(ctx, folder.id)
          return { id: folder.id, name: folder.name, lists: lists.map(toListSummaryOut) }
        }),
      )

      return {
        id: space.id,
        name: space.name,
        folders: folderNodes,
        lists: folderlessLists.map(toListSummaryOut),
      }
    }),
  )

  return { team_id: ctx.teamId, spaces: spaceNodes }
}

/**
 * Cached under `tree:<teamId>` via `TtlCache.getOrLoad`, so a session that
 * calls `clickup_get_workspace_tree` repeatedly pays for the space/folder/list
 * fan-out once per cache TTL rather than once per call.
 */
export function loadWorkspaceTree(ctx: ClickUpContext): Promise<WorkspaceTree> {
  return ctx.cache.getOrLoad(`tree:${ctx.teamId}`, () => buildWorkspaceTree(ctx))
}

/**
 * Finds the space that owns `listId` by walking an already-loaded
 * `WorkspaceTree` - both a space's own folderless `lists` and every
 * folder's `lists` are checked. Used by `clickup_set_task_tags` (Task 12)
 * to resolve a task's space (task -> list -> folder -> space) without a new
 * endpoint: the tree this walks is the same cached view
 * `clickup_get_workspace_tree` returns, so a session that already called
 * that tool pays nothing extra to resolve a space here.
 */
export function findSpaceForList(tree: WorkspaceTree, listId: string): SpaceOut | undefined {
  return tree.spaces.find(
    (space) =>
      space.lists.some((list) => list.id === listId) ||
      space.folders.some((folder) => folder.lists.some((list) => list.id === listId)),
  )
}

export type StatusOut = {
  id?: string
  status: string
  type: string
}

export type CustomFieldDefinitionOut = {
  id: string
  name: string
  type: string
  options?: Array<{ id: string; name: string }>
}

export type ListMeta = {
  id: string
  name: string
  /** The list's description. Omitted, per reliability rule 2, when ClickUp reports it as null or "". */
  content?: string
  statuses: StatusOut[]
  custom_fields: CustomFieldDefinitionOut[]
}

async function buildListMeta(ctx: ClickUpContext, listId: string): Promise<ListMeta> {
  const [list, fields] = await Promise.all([getList(ctx, listId), getListFields(ctx, listId)])

  return {
    id: list.id,
    name: list.name,
    ...(list.content !== null && list.content !== undefined && list.content !== '' ? { content: list.content } : {}),
    statuses: list.statuses.map((s) => ({
      ...(s.id !== undefined ? { id: s.id } : {}),
      status: s.status,
      type: s.type,
    })),
    custom_fields: fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      ...(f.type_config?.options && f.type_config.options.length > 0
        ? { options: f.type_config.options.map((o) => ({ id: o.id, name: o.name })) }
        : {}),
    })),
  }
}

/**
 * Cached under `list:<listId>` via `TtlCache.getOrLoad`. Statuses and custom
 * field definitions are fetched and returned together deliberately: an agent
 * writing to a list needs both before it can pick a valid status name or
 * custom field id, and a second round trip for one after already fetching
 * the other would cost a call this cache is meant to avoid.
 */
export function loadListMeta(ctx: ClickUpContext, listId: string): Promise<ListMeta> {
  return ctx.cache.getOrLoad(`list:${listId}`, () => buildListMeta(ctx, listId))
}
