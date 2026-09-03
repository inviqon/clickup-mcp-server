import { http, HttpResponse } from 'msw'

/**
 * Literal ClickUp response payloads for the seven time tracking tools,
 * field-shaped against ClickUp's own OpenAPI specification and reference
 * pages (developer.clickup.com/docs/open-api-spec.md, and the .md reference
 * pages for Start/Stop/Create/Update/Delete a Time Entry, Get Running Time
 * Entry, and Get Time Entries Within a Date Range).
 *
 * Two things ClickUp's own docs are explicit about, both modelled here
 * rather than invented: time entries carry a string `duration` in
 * milliseconds and string `start`/`end` epochs (a nested `task` object,
 * present only when the entry is tied to one), and a *running* entry
 * reports `duration` as a NEGATIVE integer - "a time entry that has a
 * negative duration means that timer is currently running for that user."
 *
 * All fixed timestamps below (e.g. 1757000000000) fall in Berlin's summer
 * (CEST, +02:00) offset, the same constant `tests/fixtures/tasks.ts` uses
 * for its own timezone-offset assertions - deliberately real clock time is
 * never used here, so a test's expected offset does not depend on which
 * calendar day it happens to run on.
 */

const API = 'https://api.clickup.com/api'

export const TEAM_ID = '9007'
export const TASK_ID = '86abc'

const USER = { id: 1, username: 'Alice Anderson', email: 'alice@example.com', color: '#7b68ee', initials: 'AA', profilePicture: null }

function taskRef(opts: { taskId?: string; taskName?: string } = {}) {
  return {
    id: opts.taskId ?? TASK_ID,
    name: opts.taskName ?? 'Fix login redirect',
    status: { status: 'in progress', color: '#a875ff', type: 'custom', orderindex: 1 },
    custom_type: null,
  }
}

// -- Running timer fixtures ---------------------------------------------

/**
 * GET /v2/team/9007/time_entries/current, reporting a timer running for
 * `elapsedMs` (default 1h23m = 4,980,000ms) against `taskId`/`taskName`.
 * `duration` is negative, per ClickUp's own documented convention.
 */
export function runningTimerHandlers(
  opts: { id?: string; taskId?: string; taskName?: string; elapsedMs?: number; startMs?: number } = {},
) {
  const elapsedMs = opts.elapsedMs ?? 83 * 60_000
  const startMs = opts.startMs ?? 1757000000000 - elapsedMs
  return [
    http.get(`${API}/v2/team/${TEAM_ID}/time_entries/current`, () =>
      HttpResponse.json({
        data: {
          id: opts.id ?? 'timer_1',
          task: taskRef(opts),
          wid: TEAM_ID,
          user: USER,
          billable: false,
          start: String(startMs),
          duration: -elapsedMs,
          description: '',
          tags: [],
          at: String(startMs),
        },
      }),
    ),
  ]
}

export function noRunningTimerHandlers() {
  return [http.get(`${API}/v2/team/${TEAM_ID}/time_entries/current`, () => HttpResponse.json({ data: null }))]
}

// -- Start / stop fixtures ------------------------------------------------

export type SeenRequest = { called: boolean; body?: Record<string, unknown> }

/**
 * POST /v2/team/9007/time_entries/start. Records whether it was called (and
 * with what body) into `seen`, so a test can prove the endpoint was never
 * reached at all (the start guard's whole point) rather than merely that
 * the tool call rejected.
 */
export function startTimerHandlers(seen: SeenRequest) {
  return [
    http.post(`${API}/v2/team/${TEAM_ID}/time_entries/start`, async ({ request }) => {
      seen.called = true
      const body = (await request.json()) as Record<string, unknown>
      seen.body = body
      return HttpResponse.json({
        data: {
          id: 'timer_new',
          task: body.tid !== undefined ? taskRef({ taskId: body.tid as string, taskName: 'Fix login bug' }) : null,
          wid: TEAM_ID,
          user: USER,
          billable: (body.billable as boolean) ?? false,
          start: '1757000000000',
          duration: 0,
          description: (body.description as string) ?? '',
          tags: Array.isArray(body.tags) ? body.tags : [],
          at: '1757000000000',
        },
      })
    }),
  ]
}

/**
 * POST /v2/team/9007/time_entries/stop, reporting the entry as stopped
 * after `durationMs` (default 45m). PUT /v2/team/9007/time_entries/:id
 * backs the follow-up description/tags write `clickup_stop_timer` issues
 * when either was requested; `opts.updateFails` makes that follow-up write
 * fail with a ClickUp-shaped error, exercising the "stop already happened,
 * only the follow-up failed" path. `opts.updateResponseShapeless` makes
 * that PUT succeed (2xx) but return a body this server cannot parse as a
 * `TimeEntry` - the shape observed live (Bug 3): the write still applies
 * (the description/tags below still land on `current`, and the follow-up
 * GET below still reports them), only the PUT's own response is
 * unparseable, exercising "the write succeeded even though its own
 * response could not be trusted."
 *
 * GET /v2/team/9007/time_entries/:id (ClickUp's "Get Singular Time Entry")
 * backs the post-write re-read `clickup_stop_timer` now does instead of
 * trusting the PUT's own response - it always reports `current`, which the
 * PUT handler below updates, so the re-read genuinely reflects the write
 * rather than a value frozen at stop time.
 */
export function stopTimerHandlers(
  opts: { durationMs?: number; updateFails?: boolean; updateResponseShapeless?: boolean; seen?: SeenRequest } = {},
) {
  const durationMs = opts.durationMs ?? 45 * 60_000
  const stopped = {
    id: 'timer_1',
    task: taskRef(),
    wid: TEAM_ID,
    user: USER,
    billable: false,
    start: String(1757000000000 - durationMs),
    end: 1757000000000,
    duration: durationMs,
    description: '',
    tags: [],
    source: 'clickup',
    at: 1757000000000,
  }
  let current: Record<string, unknown> = stopped
  return [
    http.post(`${API}/v2/team/${TEAM_ID}/time_entries/stop`, () => HttpResponse.json({ data: stopped })),
    http.put(`${API}/v2/team/${TEAM_ID}/time_entries/${stopped.id}`, async ({ request }) => {
      if (opts.seen !== undefined) {
        opts.seen.called = true
      }
      if (opts.updateFails) {
        return HttpResponse.json({ err: 'Server error', ECODE: 'SRV_001' }, { status: 500 })
      }
      const body = (await request.json()) as Record<string, unknown>
      if (opts.seen !== undefined) {
        opts.seen.body = body
      }
      current = {
        ...current,
        description: (body.description as string) ?? current.description,
        tags: Array.isArray(body.tags) ? body.tags : current.tags,
      }
      if (opts.updateResponseShapeless) {
        // A real, observed-live 2xx body this server's schema cannot parse
        // as a TimeEntry - not an object with a `data` envelope, and not a
        // bare TimeEntry either.
        return HttpResponse.json(true)
      }
      return HttpResponse.json({ data: current })
    }),
    http.get(`${API}/v2/team/${TEAM_ID}/time_entries/${stopped.id}`, () => HttpResponse.json({ data: current })),
  ]
}

// -- List time entries fixtures -------------------------------------------

/**
 * GET /v2/team/9007/time_entries, reporting two entries totalling 6h45m
 * (3h15m + 3h30m) unless `opts.empty`. Records every request's query
 * params into `seen` so a test can assert what this server actually asked
 * ClickUp for (date range, assignee, task_id, is_billable, space/folder/list
 * scoping) without re-deriving the URL itself.
 *
 * The first entry carries a `task_location` (list, folder and space id/name)
 * as ClickUp reports it when `include_location_names=true` is passed - which
 * `listTimeEntriesRaw` always does - so B1's list/space surfacing has a real
 * shape to parse. The second entry deliberately carries none, since a
 * `task_location` is only ever present when the entry is tied to a task at
 * all.
 */
export function listTimeEntriesHandlers(opts: { empty?: boolean; seen?: URLSearchParams[] } = {}) {
  const entries = opts.empty
    ? []
    : [
        {
          id: 'te-1',
          task: taskRef({ taskId: '86abc', taskName: 'Fix login redirect' }),
          wid: TEAM_ID,
          user: USER,
          billable: true,
          start: '1757000000000',
          end: '1757011700000',
          duration: String(3 * 3_600_000 + 15 * 60_000),
          description: 'Debugging the SSO redirect',
          tags: [{ name: 'bug' }],
          source: 'clickup',
          at: '1757000000000',
          task_location: {
            list_id: 101,
            folder_id: 10,
            space_id: 1,
            list_name: 'Sprint 1',
            folder_name: 'Sprints',
            space_name: 'Engineering',
          },
        },
        {
          id: 'te-2',
          task: taskRef({ taskId: '86def', taskName: 'Write migration' }),
          wid: TEAM_ID,
          user: USER,
          billable: false,
          start: '1757020000000',
          end: '1757032600000',
          duration: String(3 * 3_600_000 + 30 * 60_000),
          description: '',
          tags: [],
          source: 'clickup',
          at: '1757020000000',
        },
      ]
  return [
    http.get(`${API}/v2/team/${TEAM_ID}/time_entries`, ({ request }) => {
      opts.seen?.push(new URL(request.url).searchParams)
      return HttpResponse.json({ data: entries })
    }),
  ]
}

// -- Create time entry fixtures --------------------------------------------

/**
 * POST /v2/team/9007/time_entries. Echoes the request body's `start` and
 * `duration` back verbatim in the response (as ClickUp's own create
 * endpoint does), so a test can prove the resolved values this server
 * computed are exactly what was sent, not a coincidentally-matching fixed
 * fixture value.
 */
export function createTimeEntryHandlers(seen: SeenRequest = { called: false }) {
  return [
    http.post(`${API}/v2/team/${TEAM_ID}/time_entries`, async ({ request }) => {
      seen.called = true
      const body = (await request.json()) as Record<string, unknown>
      seen.body = body
      return HttpResponse.json({
        id: 'te-new',
        task: body.tid !== undefined ? taskRef({ taskId: body.tid as string, taskName: 'Fix login bug' }) : null,
        wid: TEAM_ID,
        user: USER,
        billable: (body.billable as boolean) ?? false,
        start: String(body.start),
        duration: body.duration,
        description: (body.description as string) ?? '',
        tags: Array.isArray(body.tags) ? body.tags : [],
        at: String(body.start),
      })
    }),
  ]
}

// -- Update time entry fixtures --------------------------------------------

/**
 * PUT /v2/team/9007/time_entries/:id plus GET .../time_entries/:id (ClickUp's
 * "Get Singular Time Entry") backing `clickup_update_time_entry`'s post-write
 * re-read (Bug 3 - see `stopTimerHandlers` above for why the tool no longer
 * trusts the PUT's own response). `current` starts at a base entry and is
 * updated by whatever the PUT actually receives, so the GET the tool issues
 * afterward genuinely reflects the write.
 */
export function updateTimeEntryHandlers(entryId = 'te-1', seen: SeenRequest = { called: false }) {
  let current: Record<string, unknown> = {
    id: entryId,
    task: taskRef(),
    wid: TEAM_ID,
    user: USER,
    billable: false,
    start: '1757000000000',
    duration: 3_600_000,
    description: '',
    tags: [],
    at: '1757000000000',
  }
  return [
    http.put(`${API}/v2/team/${TEAM_ID}/time_entries/${entryId}`, async ({ request }) => {
      seen.called = true
      const body = (await request.json()) as Record<string, unknown>
      seen.body = body
      current = {
        ...current,
        billable: body.billable ?? current.billable,
        start: body.start !== undefined ? String(body.start) : current.start,
        duration: body.duration ?? current.duration,
        description: (body.description as string) ?? current.description,
        tags: Array.isArray(body.tags) ? body.tags : current.tags,
      }
      return HttpResponse.json({ data: current })
    }),
    http.get(`${API}/v2/team/${TEAM_ID}/time_entries/${entryId}`, () => HttpResponse.json({ data: current })),
  ]
}

// -- Delete time entry fixtures ---------------------------------------------

export function deleteTimeEntryHandlers(entryId = 'te-1') {
  return [http.delete(`${API}/v2/team/${TEAM_ID}/time_entries/${entryId}`, () => new HttpResponse(null, { status: 204 }))]
}

// -- clickup_time_report fixtures --------------------------------------------

/**
 * Real workspace members (from the increment brief), used so
 * `clickup_time_report`'s tests exercise real ids rather than the
 * placeholder `USER` above. `GET /v2/team` backs both `getTeamMembers`
 * (used to resolve a display name for a requested-but-invisible member) and
 * `clickup_list_members`.
 */
export const TIEMO = { id: 152549938, username: 'Tiemo Timtschenko', email: 'tiemo@inviqon.com', color: '#7b68ee', initials: 'TT', profilePicture: null }
export const ARIAN = { id: 105642832, username: 'Arian Jusufi', email: 'arian@inviqon.com', color: '#ff7f50', initials: 'AJ', profilePicture: null }

export function reportTeamMembersHandlers() {
  return [
    http.get(`${API}/v2/team`, () =>
      HttpResponse.json({
        teams: [{ id: TEAM_ID, name: 'Inviqon', color: '#000000', avatar: null, members: [{ user: TIEMO }, { user: ARIAN }] }],
      }),
    ),
  ]
}

function reportEntry(opts: {
  id: string
  user: typeof TIEMO
  billable: boolean
  durationMs: number
  startMs: number
  listId: string
  listName: string
  spaceId: string
  spaceName: string
}) {
  return {
    id: opts.id,
    task: taskRef({ taskId: `task-${opts.id}`, taskName: `Task ${opts.id}` }),
    wid: TEAM_ID,
    user: opts.user,
    billable: opts.billable,
    start: String(opts.startMs),
    end: String(opts.startMs + opts.durationMs),
    duration: String(opts.durationMs),
    description: '',
    tags: [],
    source: 'clickup',
    at: String(opts.startMs),
    task_location: { list_id: opts.listId, folder_id: '10', space_id: opts.spaceId, list_name: opts.listName, folder_name: 'Sprints', space_name: opts.spaceName },
  }
}

/**
 * GET /v2/team/9007/time_entries backing `clickup_time_report`'s tests.
 * Tiemo has two entries in "Sprint 1"/Engineering totalling 3h (2h
 * billable, 1h not). Arian has one 1h30m billable entry in
 * "Backlog"/Design. Honours the `assignee` query param the way ClickUp
 * itself does - filtering the fixed entry set down to whichever user ids
 * were asked for - so a request for a user id with no entries in this set
 * (e.g. a third, uninvolved id) genuinely comes back empty rather than the
 * mock silently ignoring the filter, which is what the ambiguity test
 * needs to be a real test rather than a tautology. `assignee=any` (the
 * sentinel `all_members` sends) is honoured the same way ClickUp's own API
 * treats it - every entry, not filtered down to anyone in particular -
 * rather than being matched literally against a user id and coming back
 * empty.
 */
export function reportTimeEntriesHandlers(opts: { seen?: URLSearchParams[]; empty?: boolean } = {}) {
  const all = opts.empty ? [] : [
    reportEntry({
      id: 're-1',
      user: TIEMO,
      billable: true,
      durationMs: 2 * 3_600_000,
      startMs: 1757000000000,
      listId: '101',
      listName: 'Sprint 1',
      spaceId: '1',
      spaceName: 'Engineering',
    }),
    reportEntry({
      id: 're-2',
      user: TIEMO,
      billable: false,
      durationMs: 1 * 3_600_000,
      startMs: 1757010000000,
      listId: '101',
      listName: 'Sprint 1',
      spaceId: '1',
      spaceName: 'Engineering',
    }),
    reportEntry({
      id: 're-3',
      user: ARIAN,
      billable: true,
      durationMs: 90 * 60_000,
      startMs: 1757020000000,
      listId: '102',
      listName: 'Backlog',
      spaceId: '2',
      spaceName: 'Design',
    }),
  ]
  return [
    http.get(`${API}/v2/team/${TEAM_ID}/time_entries`, ({ request }) => {
      const params = new URL(request.url).searchParams
      opts.seen?.push(params)
      const assignee = params.get('assignee')
      const entries =
        assignee === null || assignee === 'any'
          ? all
          : all.filter((e) => assignee.split(',').includes(String(e.user.id)))
      return HttpResponse.json({ data: entries })
    }),
  ]
}
