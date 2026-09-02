import { describe, expect, it } from 'vitest'
import { MYDAY_TOOLS } from '../../src/tools/myday.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import * as fx from '../fixtures/myday.js'

useMsw()

/**
 * Same shape as tests/tools/tasks.test.ts's own `tool()` helper.
 */
const tool = (n: string): any => MYDAY_TOOLS.find((t) => t.name === n)!

describe('clickup_get_my_day', () => {
  it('composes running timer, tracked time, due and overdue in one call', async () => {
    mswServer.use(...fx.myDayHandlers())
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    expect(out.running_timer?.task_name).toBe('Fix login redirect')
    expect(out.tracked_today.total).toBe('3h 15m')
    expect(out.due_today).toHaveLength(2)
    expect(out.overdue).toHaveLength(1)
  })

  it('carries priority and assignees on due-today tasks, and omits priority when a task has none', async () => {
    mswServer.use(
      ...fx.myDayHandlers({
        dueToday: [
          {
            id: '869etjckr',
            name: 'Ship the release',
            priority: 'high',
            assignees: [{ id: 152549938, username: 'Tiemo Timtschenko' }],
          },
          {
            id: '869etjby7',
            name: 'Write release notes',
            assignees: [{ id: 152549938, username: 'Tiemo Timtschenko' }],
          },
        ],
      }),
    )
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    const withPriority = out.due_today.find((t: { id: string }) => t.id === '869etjckr')
    expect(withPriority.priority).toBe('high')
    expect(withPriority.assignees).toEqual([{ id: '152549938', username: 'Tiemo Timtschenko' }])

    const withoutPriority = out.due_today.find((t: { id: string }) => t.id === '869etjby7')
    expect(withoutPriority).not.toHaveProperty('priority')
    expect(withoutPriority.assignees).toEqual([{ id: '152549938', username: 'Tiemo Timtschenko' }])

    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('(high)')
    expect(md).toContain('Tiemo Timtschenko')
  })

  it('renders a section per area and omits an empty section entirely', async () => {
    mswServer.use(...fx.myDayHandlers({ overdue: [] }))
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('## Running timer')
    expect(md).not.toContain('## Overdue')
  })

  it('states plainly when nothing is running rather than omitting the section', async () => {
    mswServer.use(...fx.myDayHandlers({ running: null }))
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    expect(out.running_timer).toBeNull()
    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('No timer is currently running.')
  })

  it('labels a tracked-today entry with no task as "no task", the same wording the running timer uses for the same fact', () => {
    // Pins the wording chosen when the tracked-today line and the running-
    // timer line were consolidated onto one "no task" phrase - this line
    // used to say "Untracked" while every other time-entry view said
    // "no task" for the identical case.
    const out = {
      date: '2026-09-02',
      tracked_today: {
        total: '1h 0m',
        entries: [{ id: 'te-untracked', duration: '1h 0m' }],
      },
    }
    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('- no task - 1h 0m')
    expect(md).not.toContain('Untracked')
  })

  it('does not fail the whole call when the overdue query fails, and the other sections still render', async () => {
    mswServer.use(...fx.myDayHandlers({ overdueFails: true }))
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    // Structured output: the failed section is absent with its error named,
    // never a guessed empty array standing in for "we don't actually know."
    expect(out.overdue).toBeUndefined()
    expect(out.overdue_error).toBeDefined()
    expect(out.running_timer?.task_name).toBe('Fix login redirect')
    expect(out.tracked_today.total).toBe('3h 15m')
    expect(out.due_today).toHaveLength(2)

    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('Overdue tasks could not be loaded')
    expect(md).toContain('## Running timer')
    expect(md).toContain('## Time tracked today')
    expect(md).toContain('## Due today')
  })

  it('does not fail the whole call when the running timer lookup fails, and the other sections still render', async () => {
    mswServer.use(...fx.myDayHandlers({ runningFails: true }))
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    expect(out.running_timer).toBeUndefined()
    expect(out.running_timer_error).toBeDefined()
    expect(out.overdue).toHaveLength(1)

    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('## Running timer')
    expect(md).toContain('Running timer could not be loaded')
    // A failed running-timer lookup must never be rendered as "confirmed
    // not running" - that would be reliability rule 2's forbidden guessed
    // default, dressed up as a real answer.
    expect(md).not.toContain('No timer is currently running.')
  })

  it('does not fail the whole call when time tracked today fails to load', async () => {
    mswServer.use(...fx.myDayHandlers({ trackedFails: true }))
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    expect(out.tracked_today).toBeUndefined()
    expect(out.tracked_today_error).toBeDefined()
    expect(out.due_today).toHaveLength(2)
    expect(out.overdue).toHaveLength(1)

    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('Time tracked today could not be loaded')
    expect(md).toContain('## Due today')
    expect(md).toContain('## Overdue')
  })

  it('does not fail the whole call when due-today tasks fail to load', async () => {
    mswServer.use(...fx.myDayHandlers({ dueTodayFails: true }))
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    expect(out.due_today).toBeUndefined()
    expect(out.due_today_error).toBeDefined()
    expect(out.overdue).toHaveLength(1)
    expect(out.tracked_today?.total).toBe('3h 15m')

    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('Due today tasks could not be loaded')
    expect(md).toContain('## Overdue')
  })

  it('fails both due-today and overdue, naming the /v2/user endpoint that actually failed, when the shared identity lookup itself fails', async () => {
    // mePromise feeds both the due-today and overdue queries; neither can
    // even form its request without it, so both reject with its failure.
    // Pinning the actual message here rather than assuming it: the failed
    // promise carries `{ resource: 'task', id: 'due today' | 'overdue' }`
    // hints, but ClickUpApiError's default (non-403/404) branch renders
    // the error's own endpoint and status rather than that hint, so the
    // message correctly names "v2/user" and not a task.
    mswServer.use(...fx.myDayHandlers({ meFails: true }))
    const out = await tool('clickup_get_my_day').handler({}, testContext())

    // Running timer and tracked time do not depend on mePromise and still
    // succeed.
    expect(out.running_timer?.task_name).toBe('Fix login redirect')
    expect(out.tracked_today.total).toBe('3h 15m')

    expect(out.due_today).toBeUndefined()
    expect(out.due_today_error).toMatch(/v2\/user/)
    expect(out.due_today_error).not.toMatch(/task/i)
    expect(out.overdue).toBeUndefined()
    expect(out.overdue_error).toMatch(/v2\/user/)
    expect(out.overdue_error).not.toMatch(/task/i)
  })

  it('issues at most five upstream requests: one shared identity resolution plus one each for the running timer, tracked time, due-today and overdue queries', async () => {
    const requestLog: string[] = []
    mswServer.use(...fx.myDayHandlers({ requestLog }))
    await tool('clickup_get_my_day').handler({}, testContext())
    // The brief's stated budget is four; this server needs a fifth request
    // to resolve "the authenticated user" before it can scope the due-today
    // and overdue task queries to them (ClickUp's task filter takes a real
    // numeric assignee id, not a "me" placeholder) - documented in the
    // task report rather than silently exceeded or hidden by disabling the
    // walker. It is cached per team afterward (see the next test).
    expect(requestLog.length).toBeLessThanOrEqual(5)
  })

  it('resolves the authenticated user at most once per context, even across two calls', async () => {
    const requestLog: string[] = []
    mswServer.use(...fx.myDayHandlers({ requestLog }))
    const ctx = testContext()
    await tool('clickup_get_my_day').handler({}, ctx)
    await tool('clickup_get_my_day').handler({}, ctx)
    const userCalls = requestLog.filter((r) => r.endsWith('/v2/user'))
    expect(userCalls).toHaveLength(1)
  })

  it('renders the resolved elapsed time and start offset for the running timer', async () => {
    mswServer.use(...fx.myDayHandlers())
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('1h 23m')
    expect(md).toMatch(/started .*\+02:00/)
  })

  it('renders the running timer\'s task as "name (id)", the same label form clickup_get_current_timer uses', async () => {
    mswServer.use(...fx.myDayHandlers())
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('Running on Fix login redirect (86abc) -')
  })

  it('renders due and overdue tasks by name and id', async () => {
    mswServer.use(...fx.myDayHandlers())
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('Ship the release (86due1)')
    expect(md).toContain('Fix the flaky test (86over1)')
  })

  it('reports the overdue list as bounded when the upstream walker cap is hit, rather than looking complete', async () => {
    mswServer.use(...fx.myDayHandlers({ overdueUnbounded: true }))
    const out = await tool('clickup_get_my_day').handler({}, testContext())
    // 500 tasks (5 pages x 100), not an exact count the walker never
    // confirmed as the true total - the point of `overdue_bounded` at all.
    expect(out.overdue).toHaveLength(500)
    expect(out.overdue_bounded).toBe(true)

    const md = tool('clickup_get_my_day').render(out, testContext())
    expect(md).toContain('## Overdue')
    expect(md).toContain('bounded to the first 5 upstream pages (500 tasks)')
  })
})
