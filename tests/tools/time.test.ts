import { describe, expect, it } from 'vitest'
import { TIME_TOOLS } from '../../src/tools/time.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import * as fx from '../fixtures/time.js'

useMsw()

/**
 * Same shape as tests/tools/tasks.test.ts's own `tool()` helper.
 */
const tool = (n: string): any => TIME_TOOLS.find((t) => t.name === n)!

describe('clickup_start_timer', () => {
  it('refuses to start while a timer is already running, naming the running task', async () => {
    mswServer.use(...fx.runningTimerHandlers({ taskId: '86abc', taskName: 'Fix login redirect' }))
    await expect(tool('clickup_start_timer').handler({ task_id: '86def' }, testContext())).rejects.toThrow(
      /A timer is already running on Fix login redirect \(86abc\).*clickup_stop_timer/,
    )
  })

  it('never calls the start endpoint when a timer is already running', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.runningTimerHandlers({ taskId: '86abc', taskName: 'Fix login redirect' }), ...fx.startTimerHandlers(seen))
    await expect(tool('clickup_start_timer').handler({ task_id: '86def' }, testContext())).rejects.toThrow()
    expect(seen.called).toBe(false)
  })

  it('starts when nothing is running and echoes the resolved start time with its timezone offset', async () => {
    mswServer.use(...fx.noRunningTimerHandlers(), ...fx.startTimerHandlers({ called: false }))
    const out = await tool('clickup_start_timer').handler({ task_id: '86abc' }, testContext())
    const md = tool('clickup_start_timer').render(out, testContext())
    expect(md).toMatch(/Started .*\+02:00/)
  })

  it('sends task_id, description, billable and tags in the start request', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.noRunningTimerHandlers(), ...fx.startTimerHandlers(seen))
    await tool('clickup_start_timer').handler(
      { task_id: '86abc', description: 'Investigating', billable: true, tags: ['urgent'] },
      testContext(),
    )
    expect(seen.body).toEqual({
      tid: '86abc',
      description: 'Investigating',
      billable: true,
      tags: [{ name: 'urgent' }],
    })
  })
})

describe('clickup_get_current_timer', () => {
  it('states plainly that no timer is running instead of returning empty', async () => {
    mswServer.use(...fx.noRunningTimerHandlers())
    const out = await tool('clickup_get_current_timer').handler({}, testContext())
    expect(tool('clickup_get_current_timer').render(out, testContext())).toBe('No timer is currently running.')
  })

  it('reports elapsed time in h m form, never raw milliseconds', async () => {
    mswServer.use(...fx.runningTimerHandlers({ elapsedMs: 83 * 60_000 }))
    const out = await tool('clickup_get_current_timer').handler({}, testContext())
    const md = tool('clickup_get_current_timer').render(out, testContext())
    expect(md).toContain('1h 23m')
    expect(md).not.toContain('4980000')
  })

  it('echoes the running task name and id, and the start time with its timezone offset', async () => {
    mswServer.use(...fx.runningTimerHandlers({ taskId: '86abc', taskName: 'Fix login redirect' }))
    const out = await tool('clickup_get_current_timer').handler({}, testContext())
    expect(out.task_id).toBe('86abc')
    expect(out.task_name).toBe('Fix login redirect')
    expect(out.start).toMatch(/\+02:00/)
  })

  it('renders the running task as "name (id)", the same label form every other time-entry view uses', async () => {
    mswServer.use(...fx.runningTimerHandlers({ taskId: '86abc', taskName: 'Fix login redirect' }))
    const out = await tool('clickup_get_current_timer').handler({}, testContext())
    const md = tool('clickup_get_current_timer').render(out, testContext())
    expect(md).toContain('Timer running on Fix login redirect (86abc) -')
  })
})

describe('clickup_stop_timer', () => {
  it('stops the timer and returns the tracked duration in h m form', async () => {
    mswServer.use(...fx.stopTimerHandlers({ durationMs: 45 * 60_000 }))
    const out = await tool('clickup_stop_timer').handler({}, testContext())
    expect(out.duration).toBe('45m')
    const md = tool('clickup_stop_timer').render(out, testContext())
    expect(md).toContain('45m tracked')
  })

  it('applies description and tags with a follow-up write once the stop is confirmed', async () => {
    mswServer.use(...fx.stopTimerHandlers())
    const out = await tool('clickup_stop_timer').handler({ description: 'Code review', tags: ['reviewed'] }, testContext())
    expect(out.description).toBe('Code review')
    expect(out.tags).toEqual(['reviewed'])
    const md = tool('clickup_stop_timer').render(out, testContext())
    expect(md).toContain('**Description**: Code review')
    expect(md).toContain('**Tags**: reviewed')
  })

  it('reports the stop as having already happened when the follow-up description/tags write fails', async () => {
    mswServer.use(...fx.stopTimerHandlers({ updateFails: true }))
    await expect(
      tool('clickup_stop_timer').handler({ description: 'Code review' }, testContext()),
    ).rejects.toThrow(/timer stopped successfully.*already happened in ClickUp/s)
  })

  it('does not attempt a follow-up write when no description or tags were given', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.stopTimerHandlers({ seen }))
    const out = await tool('clickup_stop_timer').handler({}, testContext())
    expect(out.description).toBeUndefined()
    expect(seen.called).toBe(false)
  })

  it('clears the description when an explicit empty string is given', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.stopTimerHandlers({ seen }))
    await tool('clickup_stop_timer').handler({ description: '' }, testContext())
    expect(seen.called).toBe(true)
    expect(seen.body).toEqual({ description: '' })
  })

  it('clears every tag when an explicit empty array is given, rather than silently dropping the instruction', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.stopTimerHandlers({ seen }))
    await tool('clickup_stop_timer').handler({ tags: [] }, testContext())
    // An empty array is a different request from "tags not mentioned" - it
    // must still reach the follow-up write, with ClickUp's own "replace"
    // semantics, not be treated as equivalent to omitting tags entirely.
    expect(seen.called).toBe(true)
    expect(seen.body).toEqual({ tags: [], tag_action: 'replace' })
  })
})

describe('clickup_create_time_entry', () => {
  it('accepts a human duration and sends milliseconds', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.createTimeEntryHandlers(seen))
    await tool('clickup_create_time_entry').handler({ start: '2026-09-02T09:00:00+02:00', duration: '1h30m' }, testContext())
    expect(seen.body?.duration).toBe(5_400_000)
  })

  it('echoes the resolved start and duration so a timezone or unit error is visible', async () => {
    mswServer.use(...fx.createTimeEntryHandlers())
    const out = await tool('clickup_create_time_entry').handler(
      { start: '2026-09-02T09:00:00+02:00', duration: '1h30m' },
      testContext(),
    )
    const md = tool('clickup_create_time_entry').render(out, testContext())
    expect(md).toContain('2026-09-02T09:00:00+02:00')
    expect(md).toContain('1h 30m')
  })

  it('rejects an unparseable duration rather than logging zero', async () => {
    await expect(
      tool('clickup_create_time_entry').handler({ start: '2026-09-02T09:00:00+02:00', duration: 'a while' }, testContext()),
    ).rejects.toThrow(/Could not parse duration/)
  })

  it('creates an untracked entry (no task_id) without a task in the response', async () => {
    mswServer.use(...fx.createTimeEntryHandlers())
    const out = await tool('clickup_create_time_entry').handler(
      { start: '2026-09-02T09:00:00+02:00', duration: '30m' },
      testContext(),
    )
    expect(out).not.toHaveProperty('task_id')
  })
})

describe('clickup_update_time_entry', () => {
  it('sends only the fields provided', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.updateTimeEntryHandlers('te-1', seen))
    await tool('clickup_update_time_entry').handler({ entry_id: 'te-1', billable: true }, testContext())
    expect(seen.body).toEqual({ billable: true })
  })

  it('resolves a human duration to milliseconds before sending it', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.updateTimeEntryHandlers('te-1', seen))
    await tool('clickup_update_time_entry').handler({ entry_id: 'te-1', duration: '45m' }, testContext())
    expect(seen.body?.duration).toBe(2_700_000)
  })

  // Same class of defect the tags fix above addressed: an explicit ''
  // is a request to clear the description, not an absent field, and
  // `omitEmpty` used to drop it while the tool reported success.
  it('sends an explicitly empty description rather than dropping it', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.updateTimeEntryHandlers('te-1', seen))
    await tool('clickup_update_time_entry').handler({ entry_id: 'te-1', description: '' }, testContext())
    expect(seen.body).toEqual({ description: '' })
  })

  it('replaces tags rather than adding to them', async () => {
    const seen: fx.SeenRequest = { called: false }
    mswServer.use(...fx.updateTimeEntryHandlers('te-1', seen))
    await tool('clickup_update_time_entry').handler({ entry_id: 'te-1', tags: ['done'] }, testContext())
    expect(seen.body?.tag_action).toBe('replace')
    expect(seen.body?.tags).toEqual([{ name: 'done' }])
  })

  it('rejects an unparseable duration rather than silently applying zero', async () => {
    mswServer.use(...fx.updateTimeEntryHandlers())
    await expect(
      tool('clickup_update_time_entry').handler({ entry_id: 'te-1', duration: 'a while' }, testContext()),
    ).rejects.toThrow(/Could not parse duration/)
  })
})

describe('clickup_delete_time_entry', () => {
  it('deletes the entry and confirms', async () => {
    mswServer.use(...fx.deleteTimeEntryHandlers('te-1'))
    const out = await tool('clickup_delete_time_entry').handler({ entry_id: 'te-1' }, testContext())
    expect(out).toEqual({ entry_id: 'te-1', deleted: true })
    expect(tool('clickup_delete_time_entry').render(out, testContext())).toBe('Time entry te-1 deleted.')
  })
})

describe('clickup_list_time_entries', () => {
  it('defaults to the last 7 days and says so in the output', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({}, testContext())
    expect(out.range).toContain('last 7 days')
  })

  it('sends the default range as a start_date/end_date roughly 7 days apart', async () => {
    const seen: URLSearchParams[] = []
    mswServer.use(...fx.listTimeEntriesHandlers({ seen }))
    await tool('clickup_list_time_entries').handler({}, testContext())
    const params = seen[0]!
    const startMs = Number(params.get('start_date'))
    const endMs = Number(params.get('end_date'))
    // "7 days ago" resolves via calendar-day arithmetic that preserves
    // wall-clock time to the second (see resolveDate's isCalendarUnit
    // branch), so the gap can be up to ~1s short of exactly 7 days - the
    // point of this assertion is "roughly a week," not millisecond parity.
    expect(Math.abs(endMs - startMs - 7 * 86_400_000)).toBeLessThan(1000)
  })

  it('totals the listed duration', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({}, testContext())
    expect(out.total_duration).toBe('6h 45m')
    const md = tool('clickup_list_time_entries').render(out, testContext())
    expect(md).toContain('Total: 6h 45m')
  })

  it('reports an empty result naming the range that produced it', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers({ empty: true }))
    const out = await tool('clickup_list_time_entries').handler({}, testContext())
    const md = tool('clickup_list_time_entries').render(out, testContext())
    expect(md).toContain('No time entries found for')
  })

  it('converts a string assignee id to a number before sending it', async () => {
    const seen: URLSearchParams[] = []
    mswServer.use(...fx.listTimeEntriesHandlers({ seen }))
    await tool('clickup_list_time_entries').handler({ assignee: '42' }, testContext())
    expect(seen[0]!.get('assignee')).toBe('42')
  })

  it('rejects a non-numeric assignee id rather than silently sending NaN', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    await expect(
      tool('clickup_list_time_entries').handler({ assignee: 'not-a-number' }, testContext()),
    ).rejects.toThrow(/not a valid ClickUp user id/)
  })

  it('paginates results, reporting has_more', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({ limit: 1, offset: 0 }, testContext())
    expect(out.count).toBe(1)
    expect(out.total).toBe(2)
    expect(out.has_more).toBe(true)
    expect(out.next_offset).toBe(1)
  })

  it('renders each entry with its resolved task label and duration', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({}, testContext())
    const md = tool('clickup_list_time_entries').render(out, testContext())
    expect(md).toContain('Fix login redirect (86abc)')
    expect(md).toContain('3h 15m')
  })
})
