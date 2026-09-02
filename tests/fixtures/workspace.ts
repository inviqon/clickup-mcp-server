import { http, HttpResponse } from 'msw'

/**
 * Literal ClickUp response payloads for the navigation tools, field-shaped
 * against ClickUp's own OpenAPI specification and reference pages
 * (developer.clickup.com/docs/open-api-spec.md, and the .md reference pages
 * for GET spaces, GET folders, GET folderless lists, GET list, GET
 * accessible custom fields, GET authorized teams, GET authorized user and
 * GET filtered team tasks).
 *
 * Deliberately includes a nullable field ClickUp really returns
 * (`task_count: null` on a folderless list; `due_date: null` on a task) and
 * a real empty array (`type_config.options: []` on a dropdown that has no
 * options configured yet), so the omission rules in the renderers and
 * output builders are exercised against realistic data rather than
 * hand-picked "happy path" shapes.
 */

const API = 'https://api.clickup.com/api'

export const TEAM_ID = '9007'
export const SPACE_ID = '1'
export const FOLDER_ID = '10'
export const LIST_IN_FOLDER_ID = '100'
export const FOLDERLESS_LIST_ID = '101'

// -- Workspace tree fixtures ------------------------------------------------

const SPACE_1 = {
  id: SPACE_ID,
  name: 'Engineering',
  private: false,
  color: null,
  avatar: null,
  admin_can_manage: true,
  archived: false,
  statuses: [
    { status: 'to do', type: 'open', orderindex: 0, color: '#d3d3d3' },
    { status: 'complete', type: 'closed', orderindex: 1, color: '#6bc950' },
  ],
  multiple_assignees: true,
}

const FOLDER_10 = {
  id: FOLDER_ID,
  name: 'Sprints',
  orderindex: 0,
  override_statuses: false,
  hidden: false,
  space: { id: SPACE_ID, name: 'Engineering', access: true },
  task_count: '2',
  // Real shape: the folders endpoint carries its own (unused here) lists and
  // statuses arrays, empty in a fresh folder - a genuine empty array this
  // schema deliberately does not read.
  statuses: [],
  lists: [],
}

const LIST_100_SPRINT = {
  id: LIST_IN_FOLDER_ID,
  name: 'Sprint 1',
  orderindex: 0,
  content: '',
  status: null,
  priority: null,
  assignee: null,
  task_count: 5,
  due_date: null,
  start_date: null,
  folder: { id: FOLDER_ID, name: 'Sprints', hidden: false, access: true },
  space: { id: SPACE_ID, name: 'Engineering', access: true },
  archived: false,
  override_statuses: false,
  permission_level: 'create',
}

const LIST_101_BACKLOG = {
  id: FOLDERLESS_LIST_ID,
  name: 'Backlog',
  orderindex: 1,
  content: '',
  status: null,
  priority: null,
  assignee: null,
  // Realistic nullable field: a list with no tasks yet reports task_count as
  // null, not 0 - the omission rules must not turn this into an invented 0.
  task_count: null,
  due_date: null,
  start_date: null,
  folder: null,
  space: { id: SPACE_ID, name: 'Engineering', access: true },
  archived: false,
  override_statuses: false,
  permission_level: 'create',
}

export function treeHandlers(spy?: () => void) {
  return [
    // Matches any team id (":teamId" wildcard) so the same fixture set can
    // back a test that loads the tree for more than one team, e.g. to prove
    // the tree cache is keyed per team rather than shared across tenants.
    http.get(`${API}/v2/team/:teamId/space`, () => {
      spy?.()
      return HttpResponse.json({ spaces: [SPACE_1] })
    }),
    http.get(`${API}/v2/space/${SPACE_ID}/folder`, () => HttpResponse.json({ folders: [FOLDER_10] })),
    http.get(`${API}/v2/space/${SPACE_ID}/list`, () => HttpResponse.json({ lists: [LIST_101_BACKLOG] })),
    http.get(`${API}/v2/folder/${FOLDER_ID}/list`, () => HttpResponse.json({ lists: [LIST_100_SPRINT] })),
  ]
}

// -- List detail / custom fields fixtures -----------------------------------

const LIST_100_DETAIL = {
  id: LIST_IN_FOLDER_ID,
  name: 'Sprint 1',
  orderindex: 0,
  content: '',
  status: null,
  priority: null,
  assignee: null,
  task_count: 5,
  due_date: null,
  due_date_time: null,
  start_date: null,
  start_date_time: null,
  folder: { id: FOLDER_ID, name: 'Sprints', hidden: false, access: true },
  space: { id: SPACE_ID, name: 'Engineering', access: true },
  inbound_address: 'add.task.100.abc@tasks.clickup.com',
  archived: false,
  override_statuses: true,
  statuses: [
    { status: 'open', orderindex: 0, color: '#d3d3d3', type: 'open' },
    // Real shape: a list on ClickUp's custom-status ClickApp carries an id
    // per status; the default open/closed statuses on most lists do not.
    { status: 'in progress', orderindex: 1, color: '#a875ff', type: 'custom', id: 'p900123_4a2Bc9Zk' },
    { status: 'closed', orderindex: 2, color: '#6bc950', type: 'closed' },
  ],
  permission_level: 'create',
}

const FIELD_CLIENT = {
  id: 'cf-client',
  name: 'Client',
  type: 'drop_down',
  type_config: {
    options: [
      { id: 'opt-acme', name: 'Acme Inc', color: '#3366ff', orderindex: 0 },
      { id: 'opt-northwind', name: 'Northwind', color: '#ff3333', orderindex: 1 },
    ],
  },
  date_created: '1566400407303',
  hide_from_guests: false,
}

const FIELD_NOTES = {
  id: 'cf-notes',
  name: 'Notes',
  type: 'text',
  type_config: {},
  date_created: '1566400407303',
  hide_from_guests: false,
}

const FIELD_CATEGORY_EMPTY = {
  id: 'cf-category',
  name: 'Category',
  type: 'drop_down',
  // Realistic empty array: a dropdown field created but never configured
  // with options yet.
  type_config: { options: [] },
  date_created: '1566400407303',
  hide_from_guests: false,
}

/**
 * `overrides` lets a test replace one field of `LIST_100_DETAIL` without a
 * parallel fixture object - used to exercise a real, non-empty `content`
 * (a list's description), which the base fixture deliberately leaves `""`
 * to match `LIST_101_BACKLOG` and keep every other test's expectations
 * unchanged.
 */
export function listHandlers(
  overrides: Partial<Omit<typeof LIST_100_DETAIL, 'content'>> & { content?: string | null } = {},
) {
  return [
    http.get(`${API}/v2/list/${LIST_IN_FOLDER_ID}`, () => HttpResponse.json({ ...LIST_100_DETAIL, ...overrides })),
    http.get(`${API}/v2/list/${LIST_IN_FOLDER_ID}/field`, () =>
      HttpResponse.json({ fields: [FIELD_CLIENT, FIELD_NOTES, FIELD_CATEGORY_EMPTY] }),
    ),
  ]
}

// -- Member fixtures ---------------------------------------------------------

const MEMBER_ALICE = {
  user: {
    id: 1,
    username: 'Alice Anderson',
    email: 'alice@example.com',
    color: '#7b68ee',
    profilePicture: null,
    initials: 'AA',
  },
}

const MEMBER_BOB = {
  user: {
    id: 2,
    username: 'Bob Baker',
    email: 'bob@example.com',
    color: '#ff7f50',
    profilePicture: null,
    initials: 'BB',
  },
}

const MEMBER_CAROL = {
  user: {
    id: 3,
    username: 'Carol Diaz',
    email: 'carol@example.com',
    color: null,
    profilePicture: null,
    initials: 'CD',
  },
}

const AUTH_USER = {
  id: 1,
  username: 'Alice Anderson',
  email: 'alice@example.com',
  color: '#7b68ee',
  profilePicture: null,
  initials: 'AA',
  week_start_day: 0,
  global_font_support: false,
  timezone: 'Europe/Berlin',
}

export function memberHandlers() {
  return [
    http.get(`${API}/v2/team`, () =>
      HttpResponse.json({
        teams: [
          {
            id: TEAM_ID,
            name: 'Inviqon',
            color: '#000000',
            avatar: null,
            members: [MEMBER_ALICE, MEMBER_BOB, MEMBER_CAROL],
          },
        ],
      }),
    ),
    http.get(`${API}/v2/user`, () => HttpResponse.json({ user: AUTH_USER })),
  ]
}

// -- Task search fixtures -----------------------------------------------------

const TASK_LOGIN_BUG = {
  id: '9hx',
  custom_id: null,
  name: 'Fix login bug',
  text_content: 'Users are unable to log in when SSO is enabled.',
  description: 'Users are unable to log in when SSO is enabled.',
  status: { id: 'p9007_a1', status: 'in progress', color: '#d3d3d3', orderindex: 1, type: 'custom' },
  date_created: '1567780450202',
  // Realistic nullable field named explicitly by the brief: a task with no
  // due date reports due_date as null, not an empty string or 0.
  due_date: '1508369194377',
  url: 'https://app.clickup.com/t/9hx',
  list: { id: LIST_IN_FOLDER_ID, name: 'Sprint 1', access: true },
}

const TASK_LOGIN_PAGE = {
  id: '9hy',
  custom_id: null,
  name: 'Login page redesign',
  text_content: '',
  description: '',
  status: { id: 'p9007_a2', status: 'to do', color: '#f8ae00', orderindex: 0, type: 'open' },
  date_created: '1567780450202',
  due_date: null,
  url: 'https://app.clickup.com/t/9hy',
  list: { id: FOLDERLESS_LIST_ID, name: 'Backlog', access: true },
}

const TASK_ONBOARDING_DOCS = {
  id: '9hz',
  custom_id: null,
  name: 'Update onboarding docs',
  text_content: '',
  description: '',
  status: { id: 'p9007_a2', status: 'to do', color: '#f8ae00', orderindex: 0, type: 'open' },
  date_created: '1567780450202',
  due_date: null,
  url: 'https://app.clickup.com/t/9hz',
  list: { id: FOLDERLESS_LIST_ID, name: 'Backlog', access: true },
}

export function searchHandlers(opts: { empty?: boolean } = {}) {
  return [
    http.get(`${API}/v2/team/${TEAM_ID}/task`, () =>
      HttpResponse.json({ tasks: opts.empty ? [] : [TASK_LOGIN_BUG, TASK_LOGIN_PAGE, TASK_ONBOARDING_DOCS] }),
    ),
  ]
}

/**
 * Real workspace shape (task ids 869etjckr/869etjby7, assignee id
 * 152549938 - "Tiemo Timtschenko"), used to prove `clickup_search_tasks`
 * carries `priority`/`assignees` through its own text-matching path, not
 * only the shared schema/endpoint layer `listTasksWithPriorityHandlers`
 * (tests/fixtures/tasks.ts) already exercises for `clickup_list_tasks`.
 * TASK_RELEASE_HIGH carries both; TASK_RELEASE_NO_PRIORITY carries the
 * same assignee but no priority.
 */
const TASK_RELEASE_HIGH = {
  id: '869etjckr',
  custom_id: null,
  name: 'Ship the release',
  text_content: '',
  description: '',
  status: { status: 'in progress', color: '#a875ff', orderindex: 1, type: 'custom' },
  priority: { color: '#f8ae00', id: '2', orderindex: '2', priority: 'high' },
  assignees: [{ id: 152549938, username: 'Tiemo Timtschenko', color: '#7b68ee', initials: 'TT', profilePicture: null }],
  due_date: null,
  url: 'https://app.clickup.com/t/869etjckr',
  list: { id: FOLDERLESS_LIST_ID, name: 'Backlog', access: true },
}

const TASK_RELEASE_NO_PRIORITY = {
  id: '869etjby7',
  custom_id: null,
  name: 'Write release notes',
  text_content: '',
  description: '',
  status: { status: 'to do', color: '#f8ae00', orderindex: 0, type: 'open' },
  priority: null,
  assignees: [{ id: 152549938, username: 'Tiemo Timtschenko', color: '#7b68ee', initials: 'TT', profilePicture: null }],
  due_date: null,
  url: 'https://app.clickup.com/t/869etjby7',
  list: { id: FOLDERLESS_LIST_ID, name: 'Backlog', access: true },
}

export function searchHandlersWithPriority() {
  return [
    http.get(`${API}/v2/team/${TEAM_ID}/task`, () =>
      HttpResponse.json({ tasks: [TASK_RELEASE_HIGH, TASK_RELEASE_NO_PRIORITY] }),
    ),
  ]
}

function pageFromRequest(request: Request): number {
  return Number(new URL(request.url).searchParams.get('page') ?? '0')
}

function fillerTask(id: string) {
  return {
    id,
    name: `Filler ${id}`,
    text_content: '',
    description: '',
    status: { status: 'open', color: '#d3d3d3', orderindex: 0, type: 'open' },
    date_created: '1567780450202',
    due_date: null,
    url: `https://app.clickup.com/t/${id}`,
    list: { id: FOLDERLESS_LIST_ID, name: 'Backlog', access: true },
  }
}

/**
 * `GET /v2/team/{teamId}/task` (the endpoint behind `getWorkspaceTasks`,
 * consumed by `clickup_search_tasks`) has no `last_page` field on its own
 * response, unlike the list-scoped "get tasks" endpoint - so this models
 * the walker's short-page heuristic specifically: page 0 returns a full,
 * non-matching 100-task page, page 1 returns a short page (<100) that
 * includes the one task actually matching `query: "target"`. A search that
 * only ever fetched page 0 (the pre-fix behaviour) would never see it.
 */
export function pagedSearchHandlers() {
  return [
    http.get(`${API}/v2/team/${TEAM_ID}/task`, ({ request }) => {
      const page = pageFromRequest(request)
      if (page === 0) {
        const tasks = Array.from({ length: 100 }, (_, i) => fillerTask(`f0-${i}`))
        return HttpResponse.json({ tasks })
      }
      const tasks = [
        { ...fillerTask('target-1'), name: 'Reachable only on page two: target' },
        ...Array.from({ length: 4 }, (_, i) => fillerTask(`f1-${i}`)),
      ]
      return HttpResponse.json({ tasks })
    }),
  ]
}

/**
 * An unbounded supply of full, non-matching 100-task pages, so the walk
 * must be stopped by `walkTaskPages`'s 5-page cap rather than a confirmed
 * end - `clickup_search_tasks` must disclose this (`bounded: true`) rather
 * than silently reporting "no matches" as if the whole workspace had been
 * searched.
 */
export function unboundedSearchHandlers() {
  return [
    http.get(`${API}/v2/team/${TEAM_ID}/task`, ({ request }) => {
      const page = pageFromRequest(request)
      const tasks = Array.from({ length: 100 }, (_, i) => fillerTask(`u${page}-${i}`))
      return HttpResponse.json({ tasks })
    }),
  ]
}
