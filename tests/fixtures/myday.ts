import { http, HttpResponse } from 'msw'

/**
 * Literal ClickUp response payloads backing `clickup_get_my_day`, composed
 * from the same endpoint shapes `tests/fixtures/time.ts` and
 * `tests/fixtures/tasks.ts` already source from ClickUp's OpenAPI
 * specification - this file adds no new endpoint shapes of its own, only
 * wires four of them together the way the tool itself does.
 *
 * The two task queries (`GET /v2/team/9007/task` for "due today" and for
 * "overdue") share one URL, differing only in query parameters: the
 * due-today query always carries `due_date_gt` (the start-of-today lower
 * bound) alongside `due_date_lt`, while the overdue query carries only
 * `due_date_lt`. The handler below tells them apart the same way ClickUp's
 * own API would have to - by which parameters are present - rather than by
 * call order, so it stays correct regardless of which of the two
 * `Promise.allSettled` branches happens to resolve first.
 */

const API = 'https://api.clickup.com/api'

export const TEAM_ID = '9007'

const AUTH_USER = { id: 501, username: 'Alice Anderson', email: 'alice@example.com', color: '#7b68ee', initials: 'AA', profilePicture: null }

const RUNNING_USER = { id: 501, username: 'Alice Anderson', email: 'alice@example.com', color: '#7b68ee', initials: 'AA', profilePicture: null }

function dueTodayTask(id: string, name: string) {
  return {
    id,
    name,
    status: { status: 'open', color: '#d3d3d3', orderindex: 0, type: 'open' },
    due_date: '1757030000000',
    url: `https://app.clickup.com/t/${id}`,
    list: { id: '100', name: 'Sprint 1', access: true },
  }
}

function overdueTask(id: string, name: string) {
  return {
    id,
    name,
    status: { status: 'open', color: '#d3d3d3', orderindex: 0, type: 'open' },
    due_date: '1756000000000',
    url: `https://app.clickup.com/t/${id}`,
    list: { id: '100', name: 'Sprint 1', access: true },
  }
}

export type MyDayHandlerOpts = {
  /** `null` for "confirmed nothing running"; an object to name a running task; omit for the default running task. */
  running?: null | { taskId: string; taskName: string }
  overdue?: Array<{ id: string; name: string }>
  overdueFails?: boolean
  dueTodayFails?: boolean
  trackedFails?: boolean
  runningFails?: boolean
  /** Every intercepted request's method + pathname is pushed here, in call order. */
  requestLog?: string[]
}

export function myDayHandlers(opts: MyDayHandlerOpts = {}) {
  const log = (method: string, request: Request) => {
    opts.requestLog?.push(`${method} ${new URL(request.url).pathname.replace(/^\/api/, '')}`)
  }

  return [
    http.get(`${API}/v2/user`, ({ request }) => {
      log('GET', request)
      return HttpResponse.json({ user: AUTH_USER })
    }),

    http.get(`${API}/v2/team/${TEAM_ID}/time_entries/current`, ({ request }) => {
      log('GET', request)
      if (opts.runningFails) {
        return HttpResponse.json({ err: 'Server error', ECODE: 'SRV_001' }, { status: 500 })
      }
      if (opts.running === null) {
        return HttpResponse.json({ data: null })
      }
      const taskId = opts.running?.taskId ?? '86abc'
      const taskName = opts.running?.taskName ?? 'Fix login redirect'
      return HttpResponse.json({
        data: {
          id: 'timer_1',
          task: { id: taskId, name: taskName, status: { status: 'in progress', color: '#a875ff', type: 'custom', orderindex: 1 } },
          wid: TEAM_ID,
          user: RUNNING_USER,
          billable: false,
          start: '1756999000000',
          duration: -83 * 60_000,
          description: '',
          tags: [],
          at: '1756999000000',
        },
      })
    }),

    http.get(`${API}/v2/team/${TEAM_ID}/time_entries`, ({ request }) => {
      log('GET', request)
      if (opts.trackedFails) {
        return HttpResponse.json({ err: 'Server error', ECODE: 'SRV_001' }, { status: 500 })
      }
      return HttpResponse.json({
        data: [
          {
            id: 'te-1',
            task: { id: '86abc', name: 'Fix login redirect', status: { status: 'open', color: '#d3d3d3', type: 'open', orderindex: 0 } },
            wid: TEAM_ID,
            user: RUNNING_USER,
            billable: true,
            start: '1757000000000',
            end: '1757011700000',
            duration: String(3 * 3_600_000 + 15 * 60_000),
            description: 'Debugging the SSO redirect',
            tags: [],
            source: 'clickup',
            at: '1757000000000',
          },
        ],
      })
    }),

    http.get(`${API}/v2/team/${TEAM_ID}/task`, ({ request }) => {
      log('GET', request)
      const params = new URL(request.url).searchParams
      const isDueToday = params.has('due_date_gt')

      if (isDueToday) {
        if (opts.dueTodayFails) {
          return HttpResponse.json({ err: 'Server error', ECODE: 'SRV_001' }, { status: 500 })
        }
        return HttpResponse.json({
          tasks: [dueTodayTask('86due1', 'Ship the release'), dueTodayTask('86due2', 'Write release notes')],
        })
      }

      if (opts.overdueFails) {
        return HttpResponse.json({ err: 'Server error', ECODE: 'SRV_001' }, { status: 500 })
      }
      const overdueTasks = opts.overdue ?? [{ id: '86over1', name: 'Fix the flaky test' }]
      return HttpResponse.json({ tasks: overdueTasks.map((t) => overdueTask(t.id, t.name)) })
    }),
  ]
}
