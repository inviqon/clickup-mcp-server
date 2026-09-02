import { z } from 'zod'
import type { AnyToolDefinition, ToolDefinition } from '../core/registry.js'
import {
  getAuthorizedUser,
  getTeamMembers,
  getWorkspaceTasks,
  loadListMeta,
  loadWorkspaceTree,
} from '../clickup/endpoints/workspace.js'
import type { MemberUser, Task } from '../clickup/schemas.js'
import { nameWithId, paginate } from '../format/common.js'
import { boundPage } from '../clickup/pagination.js'
import { renderWorkspaceTree } from '../format/tree.js'

// ---------------------------------------------------------------------------
// clickup_get_workspace_tree
// ---------------------------------------------------------------------------

const listSummaryOutputShape = {
  id: z.string(),
  name: z.string(),
  task_count: z.number().optional(),
}

const folderOutputShape = {
  id: z.string(),
  name: z.string(),
  lists: z.array(z.object(listSummaryOutputShape)),
}

const spaceOutputShape = {
  id: z.string(),
  name: z.string(),
  folders: z.array(z.object(folderOutputShape)),
  lists: z.array(z.object(listSummaryOutputShape)),
}

const treeInputShape = {}

const treeOutputShape = {
  team_id: z.string(),
  spaces: z.array(z.object(spaceOutputShape)),
}

export const getWorkspaceTreeTool: ToolDefinition<typeof treeInputShape, typeof treeOutputShape> = {
  name: 'clickup_get_workspace_tree',
  title: 'Get ClickUp Workspace Tree',
  category: 'navigation',
  mode: 'read',
  description: [
    'List every space, folder and list in the ClickUp workspace as one tree, so you know what',
    'ids exist before calling a tool that needs one. The result is cached: call it once per',
    'session rather than before every lookup. Use clickup_get_list for the statuses and custom',
    'field definitions of one specific list once you have its id, and clickup_search_tasks to',
    'find a task by what it is about rather than by browsing where it might live.',
    'Examples: "what lists exist in this workspace", "where should I file a new task about the',
    'onboarding flow".',
  ].join(' '),
  inputSchema: treeInputShape,
  outputSchema: treeOutputShape,
  handler: async (_args, ctx) => loadWorkspaceTree(ctx),
  render: (out) => renderWorkspaceTree(out),
}

// ---------------------------------------------------------------------------
// clickup_get_list
// ---------------------------------------------------------------------------

const listInputShape = {
  list_id: z.string().describe('ClickUp list id, e.g. "901234"'),
}

const statusOutputShape = z.object({
  id: z.string().optional(),
  status: z.string(),
  type: z.string(),
})

const customFieldOptionOutputShape = z.object({
  id: z.string(),
  name: z.string(),
})

const customFieldOutputShape = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  options: z.array(customFieldOptionOutputShape).optional(),
})

const listOutputShape = {
  id: z.string(),
  name: z.string(),
  statuses: z.array(statusOutputShape),
  custom_fields: z.array(customFieldOutputShape),
}

export const getListTool: ToolDefinition<typeof listInputShape, typeof listOutputShape> = {
  name: 'clickup_get_list',
  title: 'Get ClickUp List',
  category: 'navigation',
  mode: 'read',
  description: [
    'Get a ClickUp list with the statuses and custom field definitions available in it.',
    'Call this before creating or updating a task in a list you have not written to yet:',
    'status names and custom field ids are list specific, and a wrong one is rejected by the API.',
    'Use clickup_get_workspace_tree first if you do not know the list id.',
    'Examples: "what statuses does Sprint 1 use", "which custom fields can I set on this list".',
  ].join(' '),
  inputSchema: listInputShape,
  outputSchema: listOutputShape,
  handler: async ({ list_id }, ctx) => loadListMeta(ctx, list_id),
  render: (out) =>
    [
      `# ${nameWithId(out.name, out.id)}`,
      '',
      `**Statuses**: ${out.statuses.map((s) => s.status).join(', ')}`,
      '',
      ...(out.custom_fields.length
        ? [
            '**Custom fields**',
            ...out.custom_fields.map(
              (f) =>
                `- ${nameWithId(f.name, f.id)} (${f.type})${
                  f.options?.length ? `: ${f.options.map((o) => o.name).join(', ')}` : ''
                }`,
            ),
          ]
        : []),
    ].join('\n'),
}

// ---------------------------------------------------------------------------
// clickup_resolve_member
// ---------------------------------------------------------------------------

const resolveMemberInputShape = {
  query: z.string().min(1).describe('Name, username fragment or email fragment to match, or "me"'),
}

const memberMatchOutputShape = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().optional(),
})

const resolveMemberOutputShape = {
  query: z.string(),
  ambiguous: z.boolean(),
  matches: z.array(memberMatchOutputShape),
}

function toMemberMatch(member: MemberUser): z.infer<typeof memberMatchOutputShape> {
  return {
    id: member.id,
    username: member.username,
    ...(member.email !== undefined ? { email: member.email } : {}),
  }
}

function matchesQuery(member: MemberUser, query: string): boolean {
  const needle = query.toLowerCase()
  return member.username.toLowerCase().includes(needle) || (member.email ?? '').toLowerCase().includes(needle)
}

export const resolveMemberTool: ToolDefinition<typeof resolveMemberInputShape, typeof resolveMemberOutputShape> = {
  name: 'clickup_resolve_member',
  title: 'Resolve ClickUp Member',
  category: 'navigation',
  mode: 'read',
  description: [
    'Resolve a name, username fragment or email fragment to the ClickUp workspace member(s) it',
    'matches, or resolve "me" to the authenticated user. Call this before assigning a task to',
    'someone: an assignee is set by user id, and guessing the wrong id silently assigns the',
    'wrong person. Returns every candidate rather than picking one when the query is ambiguous -',
    'check the ambiguous flag and ask which one was meant rather than using the first match.',
    'Examples: "who is tiemo in this workspace", "assign this task to me".',
  ].join(' '),
  inputSchema: resolveMemberInputShape,
  outputSchema: resolveMemberOutputShape,
  handler: async ({ query }, ctx) => {
    if (query.trim().toLowerCase() === 'me') {
      const me = await getAuthorizedUser(ctx)
      return { query, ambiguous: false, matches: [toMemberMatch(me)] }
    }

    const members = await getTeamMembers(ctx)
    const matches = members.filter((m) => matchesQuery(m, query))
    return { query, ambiguous: matches.length > 1, matches: matches.map(toMemberMatch) }
  },
  render: (out) => {
    if (out.matches.length === 0) {
      return `No workspace member matches "${out.query}"`
    }
    return [
      out.ambiguous
        ? `Multiple members match "${out.query}" - ask which one was meant:`
        : `# Member matching "${out.query}"`,
      '',
      ...out.matches.map((m) => `- ${nameWithId(m.username, m.id)}${m.email ? ` <${m.email}>` : ''}`),
    ].join('\n')
  },
}

// ---------------------------------------------------------------------------
// clickup_search_tasks
// ---------------------------------------------------------------------------

const searchTasksInputShape = {
  query: z.string().min(2).describe('Text to match against a task\'s name and description'),
  space_id: z.string().optional().describe('Restrict the search to one space id'),
  list_id: z.string().optional().describe('Restrict the search to one list id'),
  include_closed: z.boolean().default(false).describe('Include tasks in a closed status'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum tasks to return, default 25, max 100'),
  offset: z.number().int().min(0).default(0).describe('Number of matching tasks to skip'),
}

const taskSummaryOutputShape = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  list_id: z.string(),
  list_name: z.string(),
  url: z.string(),
  due_date: z.string().optional(),
})

const searchTasksOutputShape = {
  query: z.string(),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  items: z.array(taskSummaryOutputShape),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
  /**
   * Present only when the walk over upstream pages hit its hard cap before
   * ClickUp confirmed the end (see `walkTaskPages`, src/clickup/pagination.ts).
   * `total`/`count` above only describe what was actually fetched and
   * matched, not the true count in the workspace, whenever this is true.
   */
  bounded: z.boolean().optional(),
}

type TaskSummary = z.infer<typeof taskSummaryOutputShape>

function toTaskSummary(task: Task): TaskSummary {
  const due = task.due_date != null ? new Date(Number(task.due_date)).toISOString() : undefined
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

function taskMatches(task: Task, query: string): boolean {
  const needle = query.toLowerCase()
  const haystack = `${task.name} ${task.description ?? task.text_content ?? ''}`.toLowerCase()
  return haystack.includes(needle)
}

export const searchTasksTool: ToolDefinition<typeof searchTasksInputShape, typeof searchTasksOutputShape> = {
  name: 'clickup_search_tasks',
  title: 'Search ClickUp Tasks',
  category: 'navigation',
  mode: 'read',
  description: [
    'Find ClickUp tasks across the whole workspace by matching text against each task\'s name and',
    'description, for when you know roughly what a task is about but not where it lives.',
    'Optionally narrow to one space or list. The ClickUp API has no text search parameter, so this',
    'fetches candidate tasks and matches locally. Use clickup_list_tasks instead once you already',
    'know the list and want tasks filtered by status, assignee or due date rather than by text.',
    'Examples: "where is the task about the login redirect", "find tasks mentioning onboarding".',
  ].join(' '),
  inputSchema: searchTasksInputShape,
  outputSchema: searchTasksOutputShape,
  handler: async ({ query, space_id, list_id, include_closed, limit, offset }, ctx) => {
    const { tasks, hasMoreUpstream, truncated } = await getWorkspaceTasks(ctx, {
      spaceId: space_id,
      listId: list_id,
      includeClosed: include_closed,
    })
    const matched = tasks.filter((t) => taskMatches(t, query))
    const page = boundPage(paginate(matched.map(toTaskSummary), { offset, limit }), { hasMoreUpstream })
    return { query, ...page, ...(truncated ? { bounded: true } : {}) }
  },
  render: (out) => {
    if (out.items.length === 0) {
      return out.bounded
        ? `No tasks matching "${out.query}" found, but the result is bounded to the first 5 upstream pages ` +
            '(500 candidate tasks) - the safety cap was hit before this could be confirmed as a true empty ' +
            'result. Narrow with space_id or list_id to search a smaller scope and get a definitive answer.'
        : `No tasks found matching "${out.query}"`
    }
    return [
      `# Tasks matching "${out.query}"`,
      '',
      `Showing ${out.count} of ${out.total}${out.has_more ? ' (more available, pass a higher offset)' : ''}`,
      ...(out.bounded
        ? [
            'Result bounded to the first 5 upstream pages (500 candidate tasks) before local text matching; ' +
              'narrow with space_id or list_id to search a smaller scope and see the rest.',
          ]
        : []),
      '',
      ...out.items.map(
        (t) =>
          `- ${nameWithId(t.name, t.id)} [${t.status}] - ${nameWithId(t.list_name, t.list_id)}${
            t.due_date ? ` - due ${t.due_date}` : ''
          }`,
      ),
    ].join('\n')
  },
}

export const NAVIGATION_TOOLS: AnyToolDefinition[] = [
  getWorkspaceTreeTool,
  getListTool,
  resolveMemberTool,
  searchTasksTool,
] as unknown as AnyToolDefinition[]
