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

  it('sends a single assignee id as one comma separated parameter', async () => {
    const seen: URLSearchParams[] = []
    mswServer.use(...fx.listTimeEntriesHandlers({ seen }))
    await tool('clickup_list_time_entries').handler({ assignees: ['42'] }, testContext())
    expect(seen[0]!.get('assignee')).toBe('42')
  })

  it('joins multiple assignee ids into one comma separated parameter', async () => {
    const seen: URLSearchParams[] = []
    mswServer.use(...fx.listTimeEntriesHandlers({ seen }))
    await tool('clickup_list_time_entries').handler({ assignees: ['42', '7'] }, testContext())
    // Asserted on the outgoing request: msw's URLSearchParams.get returns
    // the single value under the "assignee" key. If this server instead
    // sent one "assignee" param per id (ClickUp's array-query convention
    // used elsewhere in this codebase, e.g. space_ids[]), `seen[0]!.getAll`
    // would report two entries and `.get` would return only the first -
    // "42", not "42,7". The exact string here is what proves one comma
    // separated parameter reached the API, not the array-per-key style.
    expect(seen[0]!.get('assignee')).toBe('42,7')
    expect(seen[0]!.getAll('assignee')).toEqual(['42,7'])
  })

  it('rejects a non-numeric assignee id rather than silently sending NaN', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    await expect(
      tool('clickup_list_time_entries').handler({ assignees: ['not-a-number'] }, testContext()),
    ).rejects.toThrow(/not a valid ClickUp user id/)
  })

  it('sends all_members as assignee=any, not as a value passed through the numeric guard', async () => {
    const seen: URLSearchParams[] = []
    mswServer.use(...fx.listTimeEntriesHandlers({ seen }))
    await tool('clickup_list_time_entries').handler({ all_members: true }, testContext())
    expect(seen[0]!.get('assignee')).toBe('any')
  })

  it('rejects all_members together with assignees, naming both', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    await expect(
      tool('clickup_list_time_entries').handler({ all_members: true, assignees: ['42'] }, testContext()),
    ).rejects.toThrow(/all_members.*assignees/s)
  })

  it('states the caller-only default scope when neither all_members nor assignees is given', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({}, testContext())
    expect(out.scope).toMatch(/own entries/i)
  })

  it('states the all_members scope', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({ all_members: true }, testContext())
    expect(out.scope).toMatch(/every member/i)
  })

  it('states the requested assignee ids in scope', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({ assignees: ['42', '7'] }, testContext())
    expect(out.scope).toContain('42')
    expect(out.scope).toContain('7')
  })

  it('renders the scope alongside the range so "just me" vs "the whole team" is visible in the result', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({ all_members: true }, testContext())
    const md = tool('clickup_list_time_entries').render(out, testContext())
    expect(md).toContain('Scope:')
    expect(md).toMatch(/every member/i)
  })

  it('sends is_billable and the space/folder/list scoping filters', async () => {
    const seen: URLSearchParams[] = []
    mswServer.use(...fx.listTimeEntriesHandlers({ seen }))
    await tool('clickup_list_time_entries').handler({ is_billable: true, space_id: '1' }, testContext())
    expect(seen[0]!.get('is_billable')).toBe('true')
    expect(seen[0]!.get('space_id')).toBe('1')
  })

  it('always asks ClickUp to include list/folder/space names on each entry', async () => {
    const seen: URLSearchParams[] = []
    mswServer.use(...fx.listTimeEntriesHandlers({ seen }))
    await tool('clickup_list_time_entries').handler({}, testContext())
    expect(seen[0]!.get('include_location_names')).toBe('true')
  })

  it('rejects more than one of space_id/folder_id/list_id/task_id at once, matching ClickUp\'s own constraint', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    await expect(
      tool('clickup_list_time_entries').handler({ space_id: '1', list_id: '101' }, testContext()),
    ).rejects.toThrow(/only one of space_id, folder_id, list_id, task_id/)
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

  it("surfaces each entry's user so a caller can tell whose entry it is", async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({}, testContext())
    expect(out.items[0]!.user).toEqual({ id: '1', username: 'Alice Anderson' })
    const md = tool('clickup_list_time_entries').render(out, testContext())
    expect(md).toContain('Alice Anderson')
  })

  it("surfaces an entry's list and space when ClickUp reports a task_location", async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({}, testContext())
    expect(out.items[0]).toMatchObject({
      list_id: '101',
      list_name: 'Sprint 1',
      space_id: '1',
      space_name: 'Engineering',
    })
  })

  it('omits list/space fields on an entry with no task_location, rather than inventing one', async () => {
    mswServer.use(...fx.listTimeEntriesHandlers())
    const out = await tool('clickup_list_time_entries').handler({}, testContext())
    expect(out.items[1]).not.toHaveProperty('list_id')
    expect(out.items[1]).not.toHaveProperty('space_id')
  })
})

describe('clickup_time_report', () => {
  it('states the range it used, defaulting the same way clickup_list_time_entries does', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({}, testContext())
    expect(out.range).toContain('last 7 days')
  })

  it('totals across every visible entry when no assignees are given', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({}, testContext())
    expect(out.overall).toEqual({
      entry_count: 3,
      total_duration: '4h 30m',
      billable_duration: '3h 30m',
      billable_share: '78%',
    })
  })

  it('groups by member by default, one row per member with real data', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({}, testContext())
    expect(out.group_by).toBe('member')
    expect(out.groups).toEqual([
      {
        key: '152549938',
        label: 'Tiemo Timtschenko',
        entry_count: 2,
        total_duration: '3h',
        billable_duration: '2h',
        billable_share: '67%',
      },
      {
        key: '105642832',
        label: 'Arian Jusufi',
        entry_count: 1,
        total_duration: '1h 30m',
        billable_duration: '1h 30m',
        billable_share: '100%',
      },
    ])
  })

  it('groups by list when group_by is "list"', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({ group_by: 'list' }, testContext())
    expect(out.groups).toEqual([
      { key: '101', label: 'Sprint 1', entry_count: 2, total_duration: '3h', billable_duration: '2h', billable_share: '67%' },
      { key: '102', label: 'Backlog', entry_count: 1, total_duration: '1h 30m', billable_duration: '1h 30m', billable_share: '100%' },
    ])
  })

  it('groups by space when group_by is "space"', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({ group_by: 'space' }, testContext())
    expect(out.groups).toEqual([
      { key: '1', label: 'Engineering', entry_count: 2, total_duration: '3h', billable_duration: '2h', billable_share: '67%' },
      { key: '2', label: 'Design', entry_count: 1, total_duration: '1h 30m', billable_duration: '1h 30m', billable_share: '100%' },
    ])
  })

  it('does not include a member who was not explicitly requested', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({ assignees: ['152549938'] }, testContext())
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0]!.key).toBe('152549938')
  })

  it('surfaces a requested member with no visible entries as an explicit ambiguity, not a bare 0h', async () => {
    mswServer.use(...fx.reportTeamMembersHandlers(), ...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler(
      { assignees: ['152549938', '999999999'] },
      testContext(),
    )
    const tiemo = out.groups.find((g: any) => g.key === '152549938')
    const ghost = out.groups.find((g: any) => g.key === '999999999')
    expect(tiemo).toMatchObject({ total_duration: '3h' })
    expect(tiemo.note).toBeUndefined()
    expect(ghost).not.toHaveProperty('total_duration')
    expect(ghost).not.toHaveProperty('entry_count')
    expect(ghost.note).toMatch(/no.*entries.*visible|not.*visible/i)
    expect(ghost.note).toMatch(/nothing.*tracked|permission/i)
  })

  it('resolves a single requested member with real data by their own entries, not a team lookup', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({ assignees: ['105642832'] }, testContext())
    expect(out.groups).toEqual([
      {
        key: '105642832',
        label: 'Arian Jusufi',
        entry_count: 1,
        total_duration: '1h 30m',
        billable_duration: '1h 30m',
        billable_share: '100%',
      },
    ])
  })

  it('reports a fully empty result explicitly, naming the range, when nothing was requested', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers({ empty: true }))
    const out = await tool('clickup_time_report').handler({}, testContext())
    expect(out.overall).not.toHaveProperty('entry_count')
    expect(out.overall.note).toMatch(/No time entries found for/)
    const md = tool('clickup_time_report').render(out, testContext())
    expect(md).toMatch(/No time entries found for/)
    expect(md).not.toContain('0h')
  })

  it('explains a fully empty result as an ambiguity when a member was explicitly requested', async () => {
    mswServer.use(...fx.reportTeamMembersHandlers(), ...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({ assignees: ['999999999'] }, testContext())
    expect(out.overall).not.toHaveProperty('entry_count')
    expect(out.overall.note).toMatch(/permission|cannot read/i)
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0]!.note).toBeDefined()
  })

  it('computes a utilization percentage only when weekly_capacity_hours is given', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    // An explicit, exactly-7-day range (rather than the default "7 days
    // ago", whose gap to "now" is only approximately a week - see the
    // "roughly a week" tolerance in clickup_list_time_entries's own default-
    // range test above) so the pro-rated capacity is exactly 30h, not a
    // value that depends on the millisecond this test happens to run at.
    const range = { start_date: '2026-08-24T00:00:00+02:00', end_date: '2026-08-31T00:00:00+02:00' }
    const withCapacity = await tool('clickup_time_report').handler(
      { ...range, assignees: ['152549938'], weekly_capacity_hours: 30 },
      testContext(),
    )
    // Tiemo logged 3h against a 30h capacity: round(3/30*100) = 10%.
    expect(withCapacity.groups[0]!.utilization).toBe('10%')

    const withoutCapacity = await tool('clickup_time_report').handler(
      { ...range, assignees: ['152549938'] },
      testContext(),
    )
    expect(withoutCapacity.groups[0]).not.toHaveProperty('utilization')
  })

  it('rejects weekly_capacity_hours when group_by is not "member"', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    await expect(
      tool('clickup_time_report').handler({ group_by: 'list', weekly_capacity_hours: 40 }, testContext()),
    ).rejects.toThrow(/weekly_capacity_hours/)
  })

  it('rejects more than one of space_id/folder_id/list_id at once', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    await expect(
      tool('clickup_time_report').handler({ space_id: '1', list_id: '101' }, testContext()),
    ).rejects.toThrow(/only one of space_id, folder_id, list_id, task_id/)
  })

  it('sends assignees as one comma separated parameter to the underlying time entries request', async () => {
    const seen: URLSearchParams[] = []
    mswServer.use(...fx.reportTimeEntriesHandlers({ seen }))
    await tool('clickup_time_report').handler({ assignees: ['152549938', '105642832'] }, testContext())
    expect(seen[0]!.get('assignee')).toBe('152549938,105642832')
  })

  it('rejects a non-numeric assignee id rather than silently sending NaN', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    await expect(
      tool('clickup_time_report').handler({ assignees: ['not-a-number'] }, testContext()),
    ).rejects.toThrow(/not a valid ClickUp user id/)
  })

  it('sends all_members as assignee=any', async () => {
    const seen: URLSearchParams[] = []
    mswServer.use(...fx.reportTimeEntriesHandlers({ seen }))
    await tool('clickup_time_report').handler({ all_members: true }, testContext())
    expect(seen[0]!.get('assignee')).toBe('any')
  })

  it('rejects all_members together with assignees, naming both', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    await expect(
      tool('clickup_time_report').handler({ all_members: true, assignees: ['152549938'] }, testContext()),
    ).rejects.toThrow(/all_members.*assignees/s)
  })

  it('totals across every member when all_members is given', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({ all_members: true }, testContext())
    expect(out.overall).toMatchObject({ entry_count: 3, total_duration: '4h 30m' })
  })

  it('states the caller-only default scope when neither all_members nor assignees is given', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({}, testContext())
    expect(out.scope).toMatch(/own entries/i)
  })

  it('states the all_members scope', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({ all_members: true }, testContext())
    expect(out.scope).toMatch(/every member/i)
  })

  it('states the requested assignee ids in scope', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({ assignees: ['152549938'] }, testContext())
    expect(out.scope).toContain('152549938')
  })

  it('renders the scope alongside the range', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({ all_members: true }, testContext())
    const md = tool('clickup_time_report').render(out, testContext())
    expect(md).toContain('Scope:')
  })

  it('explains a fully empty result under all_members as a possible visibility ambiguity, not a bare "nothing found"', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers({ empty: true }))
    const out = await tool('clickup_time_report').handler({ all_members: true }, testContext())
    expect(out.overall.note).toMatch(/permission|not established/i)
  })

  it('renders a compact table, not one line per entry', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({}, testContext())
    const md = tool('clickup_time_report').render(out, testContext())
    expect(md).toContain('| Member | Entries | Total | Billable | Billable % |')
    expect(md).not.toContain('started') // formatTimeEntryLine's per-entry wording never appears here
  })

  it('never renders a raw millisecond duration anywhere in the report', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const out = await tool('clickup_time_report').handler({}, testContext())
    const md = tool('clickup_time_report').render(out, testContext())
    expect(md).not.toMatch(/7200000|5400000|10800000/)
    expect(JSON.stringify(out)).not.toMatch(/7200000|5400000|10800000/)
  })

  it('adds a Utilization column only when weekly_capacity_hours produced one', async () => {
    mswServer.use(...fx.reportTimeEntriesHandlers())
    const range = { start_date: '2026-08-24T00:00:00+02:00', end_date: '2026-08-31T00:00:00+02:00' }
    const withCapacity = await tool('clickup_time_report').handler(
      { ...range, assignees: ['152549938'], weekly_capacity_hours: 30 },
      testContext(),
    )
    const mdWith = tool('clickup_time_report').render(withCapacity, testContext())
    expect(mdWith).toContain('Utilization')
    expect(mdWith).toContain('10%')

    const withoutCapacity = await tool('clickup_time_report').handler({}, testContext())
    const mdWithout = tool('clickup_time_report').render(withoutCapacity, testContext())
    expect(mdWithout).not.toContain('Utilization')
  })

  it('adds a Note column with the ambiguity text only when a group carries one', async () => {
    mswServer.use(...fx.reportTeamMembersHandlers(), ...fx.reportTimeEntriesHandlers())
    const withGhost = await tool('clickup_time_report').handler(
      { assignees: ['152549938', '999999999'] },
      testContext(),
    )
    const mdWith = tool('clickup_time_report').render(withGhost, testContext())
    expect(mdWith).toContain('Note')
    expect(mdWith).toMatch(/nothing.*tracked|permission/i)

    const withoutGhost = await tool('clickup_time_report').handler({}, testContext())
    const mdWithout = tool('clickup_time_report').render(withoutGhost, testContext())
    expect(mdWithout).not.toContain('| Note |')
  })
})
