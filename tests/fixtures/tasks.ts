import { http, HttpResponse } from 'msw'

/**
 * Literal ClickUp response payloads for the eight task tools, field-shaped
 * against ClickUp's own OpenAPI specification and reference pages
 * (developer.clickup.com/docs/open-api-spec.md, and the .md reference pages
 * for GET task, GET task comments, POST/PUT task, POST set custom field
 * value, DELETE task, POST task link, POST task dependency, and the v3
 * "move a task to a new list" endpoint under
 * /workspaces/{workspace_id}/tasks/{task_id}/home_list/{list_id}).
 *
 * Deliberately includes a nullable field ClickUp really returns
 * (`due_date: null` on a task with none set; `priority: null` on a task with
 * no priority) so the omission rules in the renderers and output builders
 * are exercised against realistic data rather than hand-picked "happy path"
 * shapes.
 */

const API = 'https://api.clickup.com/api'

export const TEAM_ID = '9007'
export const TASK_ID = '86abc'
export const LIST_ID = '100'

/**
 * A description carrying every formatting feature ClickUp's plain
 * `description` field destroys: a heading, a bold span, a code span and a
 * checkbox. `MARKDOWN_DESCRIPTION_FLATTENED` is what ClickUp returns in
 * `description` for the same task - the same words, none of the structure.
 */
export const MARKDOWN_DESCRIPTION = [
  '# Repro steps',
  '',
  'The **SSO** path fails when `redirect_uri` is unset.',
  '',
  '- [ ] Confirm against staging',
].join('\n')

export const MARKDOWN_DESCRIPTION_FLATTENED = [
  'Repro steps',
  '',
  'The SSO path fails when redirect_uri is unset.',
  '',
  'Confirm against staging',
].join('\n')

export function taskDetailBody(opts: { dueDate?: number | null } = {}) {
  return baseTask(opts)
}

function baseTask(opts: { dueDate?: number | null } = {}) {
  const dueDate = opts.dueDate === undefined ? '1508369194377' : opts.dueDate === null ? null : String(opts.dueDate)
  return {
    id: TASK_ID,
    custom_id: null,
    custom_item_id: 0,
    name: 'Fix login bug',
    text_content: 'Users are unable to log in when SSO is enabled.',
    // Real shape: `description` is ClickUp's flattened rendering (headings
    // lose their level, bold loses its markers, code spans lose their
    // backticks, a checkbox becomes an ordinary line) and
    // `markdown_description` is the same text with its formatting intact -
    // returned only because `getTaskDetail` passes
    // `include_markdown_description=true`. Both are present here so a
    // regression that reads the lossy one is visible in a test, not only
    // against live data.
    description: MARKDOWN_DESCRIPTION_FLATTENED,
    markdown_description: MARKDOWN_DESCRIPTION,
    status: { id: 'p9007_a1', status: 'open', color: '#d3d3d3', orderindex: 0, type: 'open' },
    date_created: '1567780450202',
    date_updated: '1567780450202',
    date_closed: null,
    date_done: null,
    archived: false,
    creator: { id: 183, username: 'Alex Johnson', color: '#827718', email: 'alex@example.com', profilePicture: null },
    assignees: [],
    watchers: [],
    checklists: [],
    tags: [],
    parent: null,
    priority: null,
    due_date: dueDate,
    start_date: null,
    points: null,
    time_estimate: null,
    time_spent: 0,
    custom_fields: [],
    dependencies: [],
    linked_tasks: [],
    team_id: TEAM_ID,
    url: `https://app.clickup.com/t/${TASK_ID}`,
    permission_level: 'create',
    list: { id: LIST_ID, name: 'Sprint 1', access: true },
    folder: { id: '10', name: 'Sprints', hidden: false, access: true },
    space: { id: '1' },
    // Real shape: ClickUp nests subtasks compactly (no `list`/`url`) and
    // only when `include_subtasks=true` was requested.
    subtasks: [
      {
        id: '86def',
        custom_item_id: 0,
        name: 'Write migration',
        status: { status: 'open', orderindex: 0, color: '#f8ae00', type: 'open' },
        date_created: '1567780450202',
        date_updated: '1567780450202',
        date_closed: null,
        date_done: null,
        assignees: [],
        watchers: [],
        tags: [],
        custom_fields: [],
      },
    ],
  }
}

/**
 * GET /v2/task/86abc (+ its comments). `opts.dueDate` overrides the default
 * due date: `undefined` keeps the default set date, `null` reports the
 * task as having none set at all, and a number is echoed back as ClickUp's
 * own numeric-string representation.
 */
export function taskHandlers(opts: { dueDate?: number | null } = {}) {
  return [
    http.get(`${API}/v2/task/${TASK_ID}`, () => HttpResponse.json(baseTask(opts))),
    http.get(`${API}/v2/task/${TASK_ID}/comment`, () =>
      HttpResponse.json({
        comments: [
          {
            id: 'c1',
            comment_text: 'Looks good to me.',
            user: { id: 2, username: 'Bob Baker', email: 'bob@example.com', initials: 'BB', profilePicture: null },
            date: '1568036964079',
            resolved: false,
            reactions: [],
            reply_count: '0',
          },
        ],
      }),
    ),
  ]
}

/**
 * GET /v2/task/86rich - a task carrying every optional field this server
 * renders (tags, priority, assignees, a populated custom field), used to
 * exercise `renderTask`'s non-empty branches rather than only its omission
 * paths, which `taskHandlers` above is deliberately minimal for.
 */
export function richTaskHandlers() {
  return [
    http.get(`${API}/v2/task/86rich`, () =>
      HttpResponse.json({
        id: '86rich',
        name: 'Ship the release',
        description: 'Cut the release branch and tag it.',
        status: { status: 'in progress', color: '#a875ff', orderindex: 1, type: 'custom' },
        priority: { color: '#f8ae00', id: '2', orderindex: '2', priority: 'high' },
        tags: [{ name: 'release', tag_fg: '#EA80FC', tag_bg: '#EA80FC', creator: 183 }],
        assignees: [{ id: 2, username: 'Bob Baker', color: '#FC575E', initials: 'BB', email: 'bob@example.com' }],
        due_date: null,
        start_date: null,
        parent: null,
        custom_fields: [
          {
            id: 'cf-1',
            name: 'Client',
            type: 'short_text',
            type_config: {},
            date_created: '1621915186877',
            hide_from_guests: false,
            value: 'Selectry',
          },
        ],
        list: { id: LIST_ID, name: 'Sprint 1', access: true },
        url: 'https://app.clickup.com/t/86rich',
      }),
    ),
    http.get(`${API}/v2/task/86rich/comment`, () =>
      HttpResponse.json({
        comments: [
          {
            id: 'c2',
            comment_text: 'Tagged and shipped.',
            user: { id: 2, username: 'Bob Baker', email: 'bob@example.com', initials: 'BB', profilePicture: null },
            date: '1568036964079',
            resolved: false,
            reactions: [],
            reply_count: '0',
          },
        ],
      }),
    ),
  ]
}

// -- List meta (statuses + custom fields) fixtures --------------------------

/**
 * GET /v2/list/{listId} and GET /v2/list/{listId}/field, backing
 * `loadListMeta` for the pre-write validation tests. Default statuses match
 * `baseTask`'s own default status ("open") so a move to the default
 * destination list succeeds without needing status_mappings; a narrower
 * `statuses` override (e.g. a destination list that only has "todo") is
 * what exercises the missing-status pre-check.
 */
export function listMetaHandlers(opts: { listId?: string; statuses?: string[] } = {}) {
  const listId = opts.listId ?? LIST_ID
  const statusNames = opts.statuses ?? ['open', 'in progress', 'closed']
  const statuses = statusNames.map((name, index) => ({
    status: name,
    orderindex: index,
    color: '#d3d3d3',
    type: index === 0 ? 'open' : index === statusNames.length - 1 ? 'closed' : 'custom',
    // Real shape: only a list on ClickUp's custom-status ClickApp carries a
    // status id - modelled here on the one status genuinely mid-workflow.
    ...(index > 0 && index < statusNames.length - 1 ? { id: `p${listId}_status_${index}` } : {}),
  }))

  return [
    http.get(`${API}/v2/list/${listId}`, () =>
      HttpResponse.json({
        id: listId,
        name: `List ${listId}`,
        orderindex: 0,
        content: '',
        status: null,
        priority: null,
        assignee: null,
        task_count: 0,
        due_date: null,
        due_date_time: null,
        start_date: null,
        start_date_time: null,
        folder: { id: '10', name: 'Sprints', hidden: false, access: true },
        space: { id: '1', name: 'Engineering', access: true },
        archived: false,
        override_statuses: true,
        statuses,
        permission_level: 'create',
      }),
    ),
    http.get(`${API}/v2/list/${listId}/field`, () =>
      HttpResponse.json({
        fields: [
          {
            id: 'cf-1',
            name: 'Client',
            type: 'text',
            type_config: {},
            date_created: '1566400407303',
            hide_from_guests: false,
          },
        ],
      }),
    ),
  ]
}

// -- Create task fixtures ----------------------------------------------------

export function createdTask(overrides: { due_date?: number | null; name?: string; status?: string } = {}) {
  return {
    id: '86new',
    custom_id: null,
    custom_item_id: 0,
    name: overrides.name ?? 'Ship it',
    text_content: '',
    description: '',
    status: { status: overrides.status ?? 'open', orderindex: 0, color: '#d3d3d3', type: 'open' },
    date_created: '1567780450202',
    date_updated: '1567780450202',
    date_closed: null,
    date_done: null,
    archived: false,
    creator: { id: 1, username: 'Alice Anderson', color: '#827718', email: 'alice@example.com', profilePicture: null },
    assignees: [],
    watchers: [],
    checklists: [],
    tags: [],
    parent: null,
    priority: null,
    due_date: overrides.due_date === undefined || overrides.due_date === null ? null : String(overrides.due_date),
    start_date: null,
    points: null,
    time_estimate: null,
    time_spent: 0,
    custom_fields: [],
    url: 'https://app.clickup.com/t/86new',
    list: { id: LIST_ID, name: 'Sprint 1', access: true },
    folder: { id: '10', name: 'Sprints', hidden: false, access: true },
    space: { id: '1' },
  }
}

/**
 * POST /v2/list/100/task (returning a fixed created task) plus
 * POST /v2/task/:taskId/field/:fieldId, which records the path it was
 * called with into `seen` rather than asserting on it directly - so the
 * test can prove the custom field write happened as a second call against
 * the newly created task's id, not the list's. Also backs the re-fetch
 * `clickup_create_task` does after writing custom fields (GET /v2/task/86new)
 * with the field populated, so the tool's returned view reflects the write
 * rather than the pre-write creation response.
 */
export function createWithFieldHandlers(seen: string[]) {
  return [
    http.post(`${API}/v2/list/${LIST_ID}/task`, () => HttpResponse.json(createdTask())),
    http.post(`${API}/v2/task/:taskId/field/:fieldId`, ({ request }) => {
      seen.push(new URL(request.url).pathname.replace(/^\/api/, ''))
      return HttpResponse.json({})
    }),
    http.get(`${API}/v2/task/86new`, () =>
      HttpResponse.json({
        ...createdTask(),
        custom_fields: [
          {
            id: 'cf-1',
            name: 'Client',
            type: 'short_text',
            type_config: {},
            date_created: '1621915186877',
            hide_from_guests: false,
            value: 'Selectry',
          },
        ],
      }),
    ),
  ]
}

/**
 * Like `createWithFieldHandlers`, but the custom-field write itself fails
 * (a 500), so the created task exists but the field write does not take -
 * exercising `clickup_create_task`'s partial-success path (the task id
 * must still come back, alongside a `custom_field_errors` entry naming the
 * field).
 */
export function createWithFailingFieldHandlers() {
  return [
    http.post(`${API}/v2/list/${LIST_ID}/task`, () => HttpResponse.json(createdTask())),
    http.post(`${API}/v2/task/86new/field/cf-1`, () =>
      HttpResponse.json({ err: 'Field write failed', ECODE: 'FIELD_001' }, { status: 500 }),
    ),
    http.get(`${API}/v2/task/86new`, () => HttpResponse.json(createdTask())),
  ]
}

// -- Update task fixtures -----------------------------------------------------

/**
 * PUT /v2/task/86abc. `onBody` receives exactly what this server sent, so a
 * test can assert on it directly (e.g. that a description was appended, not
 * replaced). `overrides` control what the *response* reports, independent
 * of what was sent - the mechanism the "returns the API's view" tests rely
 * on: the response can name a different value than the request body.
 */
export function updateHandler(onBody: (body: Record<string, unknown>) => void, overrides: Record<string, unknown> = {}) {
  return [
    http.put(`${API}/v2/task/${TASK_ID}`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      onBody(body)
      return HttpResponse.json({ ...baseTask(), ...overrides })
    }),
  ]
}

/**
 * PUT /v2/task/86abc plus POST /v2/task/86abc/field/cf-1, backing
 * `clickup_update_task`'s custom-field re-fetch path. GET /v2/task/86abc
 * (called both before the write, for the append-description base text,
 * and again afterward, to build the returned view) reports the field as
 * already populated unless `opts.failing`, in which case the field write
 * itself fails and the refetched task still shows no value for it.
 */
export function updateWithFieldHandlers(opts: { failing?: boolean } = {}) {
  return [
    http.put(`${API}/v2/task/${TASK_ID}`, () => HttpResponse.json(baseTask())),
    http.post(`${API}/v2/task/${TASK_ID}/field/cf-1`, () => {
      if (opts.failing) {
        return HttpResponse.json({ err: 'Field write failed', ECODE: 'FIELD_001' }, { status: 500 })
      }
      return HttpResponse.json({})
    }),
    http.get(`${API}/v2/task/${TASK_ID}`, () =>
      HttpResponse.json({
        ...baseTask(),
        custom_fields: opts.failing
          ? []
          : [
              {
                id: 'cf-1',
                name: 'Client',
                type: 'short_text',
                type_config: {},
                date_created: '1621915186877',
                hide_from_guests: false,
                value: 'Selectry',
              },
            ],
      }),
    ),
  ]
}

// -- Bulk update fixtures ------------------------------------------------------

/**
 * PUT /v2/task/{taskId} for any task id, succeeding unless the id is in
 * `opts.failing`, in which case it reports a ClickUp-shaped error. Matches
 * on a path wildcard so the same handler backs every task id in a bulk
 * call.
 */
export function bulkHandlers(opts: { failing?: string[] } = {}) {
  const failing = new Set(opts.failing ?? [])
  return [
    http.put(`${API}/v2/task/:taskId`, ({ params }) => {
      const taskId = params.taskId as string
      if (failing.has(taskId)) {
        return HttpResponse.json({ err: 'Task not found', ECODE: 'ITEM_004' }, { status: 404 })
      }
      return HttpResponse.json({ ...baseTask(), id: taskId })
    }),
  ]
}

// -- List tasks fixtures -------------------------------------------------------

const TASK_100_A = {
  id: '9aa',
  name: 'Wire up auth',
  status: { status: 'open', color: '#d3d3d3', orderindex: 0, type: 'open' },
  due_date: '1700000000000',
  url: 'https://app.clickup.com/t/9aa',
  list: { id: LIST_ID, name: 'Sprint 1', access: true },
}

const TASK_100_B = {
  id: '9ab',
  name: 'Write tests',
  status: { status: 'in progress', color: '#a875ff', orderindex: 1, type: 'custom' },
  // Realistic nullable field: a task with no due date set.
  due_date: null,
  url: 'https://app.clickup.com/t/9ab',
  list: { id: LIST_ID, name: 'Sprint 1', access: true },
}

/**
 * GET /v2/list/100/task and GET /v2/team/9007/task, backing
 * `clickup_list_tasks` for both its list-scoped and space-scoped modes.
 */
export function listTasksHandlers(opts: { empty?: boolean } = {}) {
  const tasks = opts.empty ? [] : [TASK_100_A, TASK_100_B]
  return [
    http.get(`${API}/v2/list/${LIST_ID}/task`, () => HttpResponse.json({ tasks })),
    http.get(`${API}/v2/team/${TEAM_ID}/task`, () => HttpResponse.json({ tasks })),
  ]
}

function pageTaskFixture(id: string) {
  return {
    id,
    name: `Task ${id}`,
    status: { status: 'open', color: '#d3d3d3', orderindex: 0, type: 'open' },
    due_date: null,
    url: `https://app.clickup.com/t/${id}`,
    list: { id: LIST_ID, name: 'Sprint 1', access: true },
  }
}

function pageFromRequest(request: Request): number {
  return Number(new URL(request.url).searchParams.get('page') ?? '0')
}

/**
 * GET /v2/list/100/task backed by two upstream pages: page 0 returns a
 * full 100-task page (`last_page: false`), page 1 returns 50 (`last_page:
 * true`) - 150 tasks in total, none of which fit in one upstream page.
 * Exercises `walkTaskPages` actually walking past page 0 rather than
 * treating it as the whole result.
 */
export function twoPageListTasksHandlers() {
  return [
    http.get(`${API}/v2/list/${LIST_ID}/task`, ({ request }) => {
      const page = pageFromRequest(request)
      const count = page === 0 ? 100 : 50
      const tasks = Array.from({ length: count }, (_, i) => pageTaskFixture(`p${page}-${i}`))
      return HttpResponse.json({ tasks, last_page: page >= 1 })
    }),
  ]
}

/**
 * GET /v2/list/100/task backed by an unbounded supply of full 100-task
 * pages that never report `last_page: true` - modelling a list large
 * enough that `walkTaskPages`'s 5-page safety cap is what stops the walk,
 * not the list actually ending.
 */
export function unboundedListTasksHandlers() {
  return [
    http.get(`${API}/v2/list/${LIST_ID}/task`, ({ request }) => {
      const page = pageFromRequest(request)
      const tasks = Array.from({ length: 100 }, (_, i) => pageTaskFixture(`p${page}-${i}`))
      return HttpResponse.json({ tasks, last_page: false })
    }),
  ]
}

// -- Delete task fixtures -------------------------------------------------------

export function deleteHandlers() {
  return [http.delete(`${API}/v2/task/${TASK_ID}`, () => new HttpResponse(null, { status: 204 }))]
}

// -- Confirmation-read-failure fixtures (write succeeded, re-fetch did not) ---

/**
 * GET /v2/task/86abc succeeds on its first call (the pre-move status
 * check) and fails on every call after that (the post-move confirmation
 * read) - modelling a move that genuinely happened in ClickUp while the
 * read-back that would confirm it to the agent failed (a transient error,
 * not a validation failure).
 */
export function moveSucceedsThenRefetchFailsHandlers() {
  let calls = 0
  return [
    http.get(`${API}/v2/task/${TASK_ID}`, () => {
      calls += 1
      if (calls === 1) {
        return HttpResponse.json(baseTask())
      }
      return HttpResponse.json({ err: 'Server error', ECODE: 'SRV_001' }, { status: 500 })
    }),
  ]
}

/**
 * The link/dependency write succeeds, but the confirmation GET
 * /v2/task/86abc that `clickup_link_tasks` performs afterward fails
 * outright - unlike the move case, linking has no earlier successful GET
 * to this path, so a single always-failing handler is enough.
 */
export function linkRefetchFailsHandlers() {
  return [http.get(`${API}/v2/task/${TASK_ID}`, () => HttpResponse.json({ err: 'Server error' }, { status: 500 }))]
}

/**
 * POST /v2/list/100/task and its custom-field write both succeed, but the
 * confirmation GET /v2/task/86new that `clickup_create_task` performs
 * afterward fails - unlike update, create has no earlier successful GET to
 * this task id, so (like link) a single always-failing handler is enough.
 */
export function createSucceedsThenRefetchFailsHandlers() {
  return [
    http.post(`${API}/v2/list/${LIST_ID}/task`, () => HttpResponse.json(createdTask())),
    http.post(`${API}/v2/task/86new/field/cf-1`, () => HttpResponse.json({})),
    http.get(`${API}/v2/task/86new`, () => HttpResponse.json({ err: 'Server error', ECODE: 'SRV_001' }, { status: 500 })),
  ]
}

/**
 * PUT /v2/task/86abc and its custom-field write both succeed. GET
 * /v2/task/86abc succeeds on its first call (the pre-update fetch of
 * `current`, needed for the append-description base text and the list id)
 * and fails on every call after that (the post-write confirmation read) -
 * same call-counted shape as `moveSucceedsThenRefetchFailsHandlers`, for
 * the same reason: `clickup_update_task` also reads the task before it
 * writes to it.
 */
export function updateSucceedsThenRefetchFailsHandlers() {
  let calls = 0
  return [
    http.get(`${API}/v2/task/${TASK_ID}`, () => {
      calls += 1
      if (calls === 1) {
        return HttpResponse.json(baseTask())
      }
      return HttpResponse.json({ err: 'Server error', ECODE: 'SRV_001' }, { status: 500 })
    }),
    http.put(`${API}/v2/task/${TASK_ID}`, () => HttpResponse.json(baseTask())),
    http.post(`${API}/v2/task/${TASK_ID}/field/cf-1`, () => HttpResponse.json({})),
  ]
}

// -- Link / dependency fixtures --------------------------------------------------

export type LinkCall = { path?: string; body?: unknown }

/**
 * POST /v2/task/86abc/link/86other (plain link) and POST /v2/task/86abc/dependency
 * (blocks/blocked_by). Records the last path and body called into `seen`
 * rather than the test asserting inline, so one fixture set covers all
 * three relation kinds `clickup_link_tasks` supports.
 */
export function linkHandlers(seen: LinkCall) {
  return [
    http.post(`${API}/v2/task/${TASK_ID}/link/86other`, ({ request }) => {
      seen.path = new URL(request.url).pathname
      return HttpResponse.json({ task: { id: TASK_ID, name: 'Fix login bug', linked_tasks: [] } })
    }),
    http.post(`${API}/v2/task/${TASK_ID}/dependency`, async ({ request }) => {
      seen.path = new URL(request.url).pathname
      seen.body = await request.json()
      return HttpResponse.json({})
    }),
  ]
}
