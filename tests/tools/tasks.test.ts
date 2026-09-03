import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TASK_TOOLS } from '../../src/tools/tasks.js'
import { toAgentMessage } from '../../src/core/errors.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import * as fx from '../fixtures/tasks.js'

const API = 'https://api.clickup.com/api'

useMsw()
/**
 * Returned as `any`, matching tests/tools/navigation.test.ts's own `tool()`
 * helper: `AnyToolDefinition` type-erases each tool's handler/render to
 * `z.ZodRawShape`'s generic inference, which resolves to `unknown` for any
 * property access - fine for `expect(out.field)` (vitest's matchers accept
 * `unknown`) but not for indexing or chaining off it, both of which this
 * file's own added tests do. `any` here does not weaken production types:
 * every real caller goes through `ToolDefinition<TIn, TOut>`'s full
 * inference, never this erased test-only view.
 */
const tool = (n: string): any => TASK_TOOLS.find((t) => t.name === n)!

describe('clickup_get_task', () => {
  it('returns subtasks compactly without a second call', async () => {
    mswServer.use(...fx.taskHandlers())
    const out = await tool('clickup_get_task').handler({ task_id: '86abc' }, testContext())
    expect(out.subtasks).toEqual([{ id: '86def', name: 'Write migration', status: 'open' }])
  })

  it('omits an unset due date instead of printing a placeholder', async () => {
    mswServer.use(...fx.taskHandlers({ dueDate: null }))
    const out = await tool('clickup_get_task').handler({ task_id: '86abc' }, testContext())
    const md = tool('clickup_get_task').render(out, testContext())
    expect(md).not.toMatch(/Due/)
    expect(md).not.toContain('null')
  })

  it('renders dates with the configured timezone offset', async () => {
    mswServer.use(...fx.taskHandlers({ dueDate: 1757000000000 }))
    const md = tool('clickup_get_task').render(
      await tool('clickup_get_task').handler({ task_id: '86abc' }, testContext()),
      testContext(),
    )
    expect(md).toMatch(/Due.*\+02:00/)
  })

  it('fetches and includes comments only when include_comments is set', async () => {
    mswServer.use(...fx.taskHandlers())
    const withoutComments = await tool('clickup_get_task').handler({ task_id: '86abc' }, testContext())
    expect(withoutComments).not.toHaveProperty('comments')
    const withComments = await tool('clickup_get_task').handler(
      { task_id: '86abc', include_comments: true },
      testContext(),
    )
    expect(withComments.comments).toEqual([
      { id: 'c1', author: 'Bob Baker', date: expect.any(String), text: 'Looks good to me.' },
    ])
  })

  it('renders an included comment\'s timestamp with its timezone offset, same as clickup_get_comments', async () => {
    mswServer.use(...fx.taskHandlers())
    const out = await tool('clickup_get_task').handler({ task_id: '86abc', include_comments: true }, testContext())
    const md = tool('clickup_get_task').render(out, testContext())
    // fx.taskHandlers's comment date (1568036964079, 2019-09-09) falls in
    // Berlin's summer (CEST, +02:00) offset - the same instant
    // tests/tools/comments.test.ts's own offset assertion uses, so a
    // regression here (the raw epoch leaking through, or the offset being
    // dropped) is caught the same way it is for clickup_get_comments.
    expect(md).toMatch(/\+02:00/)
    expect(md).not.toContain('1568036964079')
  })

  it('copies the task id verbatim rather than constructing it', async () => {
    mswServer.use(...fx.taskHandlers())
    const out = await tool('clickup_get_task').handler({ task_id: '86abc' }, testContext())
    expect(out.id).toBe('86abc')
  })

  it('renders tags, priority, assignees, custom fields and comments when the task carries them', async () => {
    mswServer.use(...fx.richTaskHandlers())
    const out = await tool('clickup_get_task').handler({ task_id: '86rich', include_comments: true }, testContext())
    const md = tool('clickup_get_task').render(out, testContext())
    expect(md).toContain('**Tags**: release')
    expect(md).toContain('**Priority**: high')
    expect(md).toContain('Bob Baker (2)')
    expect(md).toContain('Client (cf-1): Northwind')
    expect(md).toContain('**Bob Baker**')
    expect(md).toContain('Tagged and shipped.')
    expect(md).toMatch(/\+02:00/)
  })

  // The input side accepts "1h30m" and every other duration in this server
  // goes through formatDurationHm; a task's estimate came back as raw
  // milliseconds under a "Time estimate (ms)" label nothing else used.
  it('renders a time estimate as a duration, not raw milliseconds', async () => {
    mswServer.use(...fx.richTaskHandlers())
    const out = await tool('clickup_get_task').handler({ task_id: '86rich' }, testContext())
    expect(out.time_estimate).toBe('1h 30m')
    const md = tool('clickup_get_task').render(out, testContext())
    expect(md).toContain('**Time estimate**: 1h 30m')
    expect(md).not.toContain('5400000')
    expect(md).not.toContain('(ms)')
  })
})

describe('clickup_list_tasks', () => {
  it('requires list_id or space_id rather than silently defaulting to the whole workspace', async () => {
    await expect(tool('clickup_list_tasks').handler({}, testContext())).rejects.toThrow(/list_id or space_id/)
  })

  it('lists tasks scoped to a list, copying ids verbatim', async () => {
    mswServer.use(...fx.listTasksHandlers())
    const out = await tool('clickup_list_tasks').handler({ list_id: '100' }, testContext())
    const items = out.items as Array<{ id: string; due_date?: string }>
    expect(items.map((t) => t.id)).toEqual(['9aa', '9ab'])
  })

  it('omits due_date for a task that reports it as null', async () => {
    mswServer.use(...fx.listTasksHandlers())
    const out = await tool('clickup_list_tasks').handler({ list_id: '100' }, testContext())
    const items = out.items as Array<{ id: string; due_date?: string }>
    const noDue = items.find((t) => t.id === '9ab')
    expect(noDue).not.toHaveProperty('due_date')
  })

  it('carries priority and assignees on each task summary, and omits priority when a task has none', async () => {
    mswServer.use(...fx.listTasksWithPriorityHandlers())
    const out = await tool('clickup_list_tasks').handler({ list_id: '100' }, testContext())
    const items = out.items as Array<{
      id: string
      priority?: string
      assignees?: Array<{ id: string; username: string }>
    }>
    const withPriority = items.find((t) => t.id === '869etjckr')
    expect(withPriority?.priority).toBe('high')
    expect(withPriority?.assignees).toEqual([{ id: '152549938', username: 'Tiemo Timtschenko' }])

    const withoutPriority = items.find((t) => t.id === '869etjby7')
    expect(withoutPriority).not.toHaveProperty('priority')
    expect(withoutPriority?.assignees).toEqual([{ id: '152549938', username: 'Tiemo Timtschenko' }])

    const md = tool('clickup_list_tasks').render(out, testContext())
    expect(md).toContain('(high)')
    expect(md).toContain('Tiemo Timtschenko')
    // The no-priority task's own line must carry no priority parenthetical
    // at all - not "()" or "(null)" - only the status bracket before it.
    const noPriorityLine = md.split('\n').find((line: string) => line.includes('Write release notes'))
    expect(noPriorityLine).toBe('- Write release notes (869etjby7) [open] - Tiemo Timtschenko')
  })

  it('reports an empty result naming the scope that produced it', async () => {
    mswServer.use(...fx.listTasksHandlers({ empty: true }))
    const out = await tool('clickup_list_tasks').handler({ list_id: '100' }, testContext())
    const md = tool('clickup_list_tasks').render(out, testContext())
    expect(md).toContain('No tasks found in list 100')
  })

  it('rejects list_id and space_id together rather than silently picking one (Finding 4)', async () => {
    await expect(
      tool('clickup_list_tasks').handler({ list_id: '100', space_id: '1' }, testContext()),
    ).rejects.toThrow(/exactly one of list_id or space_id.*list_id "100".*space_id "1"/)
  })

  it('formats a present due_date with the configured timezone offset rather than raw epoch ms (Finding 1)', async () => {
    mswServer.use(...fx.listTasksHandlers())
    const out = await tool('clickup_list_tasks').handler({ list_id: '100' }, testContext())
    const items = out.items as Array<{ id: string; due_date?: string }>
    const withDue = items.find((t) => t.id === '9aa')
    // TASK_100_A's due_date (1700000000000ms = 2023-11-14) falls in Berlin's
    // winter (CET, +01:00) offset - the point is that an offset is present
    // and the raw millisecond string is gone, not which specific offset.
    expect(withDue?.due_date).toMatch(/\+01:00/)
    expect(withDue?.due_date).not.toBe('1700000000000')
    const md = tool('clickup_list_tasks').render(out, testContext())
    expect(md).toMatch(/due .*\+01:00/)
    expect(md).not.toContain('1700000000000')
  })

  it('walks a second upstream page to gather enough items for the requested offset+limit (Finding 3)', async () => {
    mswServer.use(...fx.twoPageListTasksHandlers())
    const out = await tool('clickup_list_tasks').handler({ list_id: '100', offset: 120, limit: 10 }, testContext())
    const items = out.items as Array<{ id: string }>
    // Items 120..129 (0-indexed) fall inside page 1 (ids p1-0..p1-49), which
    // only exists because the walker fetched a second upstream page - a
    // single-page fetch (the pre-fix behaviour) could never produce these.
    expect(items).toHaveLength(10)
    expect(items[0]!.id).toBe('p1-20')
    expect(out.total).toBe(150)
    // There genuinely is more data beyond this page (150 > offset+limit),
    // which paginate() already computes correctly on its own once given
    // the full walked set - what this test guards is `bounded` staying
    // unset, since the walk reached a confirmed end (last_page) rather
    // than hitting the safety cap.
    expect(out.has_more).toBe(true)
    expect(out.next_offset).toBe(130)
    expect(out.bounded).toBeUndefined()
  })

  it('discloses a bounded result honestly when the 5-page cap is hit before the end is confirmed (Finding 3)', async () => {
    mswServer.use(...fx.unboundedListTasksHandlers())
    // offset+limit (550) exceeds what 5 pages of 100 can ever supply (500),
    // so the walker must hit the cap without ever satisfying "enough".
    const out = await tool('clickup_list_tasks').handler({ list_id: '100', offset: 450, limit: 100 }, testContext())
    expect(out.bounded).toBe(true)
    expect(out.has_more).toBe(true)
    const md = tool('clickup_list_tasks').render(out, testContext())
    expect(md).toContain('bounded')
    expect(md).toContain('narrow')
  })

  it('discloses bounded even when the requested page itself comes back empty, rather than reading as a confirmed "no tasks" (Finding 3)', async () => {
    mswServer.use(...fx.unboundedListTasksHandlers())
    // Only 500 raw tasks are ever reachable within the cap; an offset past
    // that returns zero items for THIS page even though the true dataset
    // may be much larger - the empty-result message must not claim a
    // confirmed, definitive "no tasks" in that case.
    const out = await tool('clickup_list_tasks').handler({ list_id: '100', offset: 1000, limit: 10 }, testContext())
    expect(out.items).toEqual([])
    expect(out.bounded).toBe(true)
    expect(out.has_more).toBe(true)
    const md = tool('clickup_list_tasks').render(out, testContext())
    expect(md).toContain('bounded')
    expect(md).not.toBe('No tasks found in list 100')
  })
})

describe('clickup_create_task', () => {
  it('resolves a natural language due date and echoes the resolution', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.listMetaHandlers(),
      http.post(`${API}/v2/list/100/task`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(fx.createdTask({ due_date: body.due_date as number }))
      }),
      http.get(`${API}/v2/task/86new`, () => HttpResponse.json(fx.createdTask({ due_date: body.due_date as number }))),
    )
    const out = await tool('clickup_create_task').handler(
      { list_id: '100', name: 'Ship it', due_date: 'tomorrow 17:00' },
      testContext(),
    )
    expect(typeof body.due_date).toBe('number')
    expect(tool('clickup_create_task').render(out, testContext())).toContain('+02:00')
  })

  // Bug 2: without `due_date_time`/`start_date_time`, ClickUp silently
  // truncates the timestamp to the start of its own day even when the
  // caller asked for a specific time (observed live: "tomorrow 17:00" came
  // back as "04:00"). The flag must be sent, and only when a time was
  // actually given - "tomorrow" alone must stay date-only.
  it('sets due_date_time and start_date_time only when a time of day was given', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${API}/v2/list/100/task`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(fx.createdTask())
      }),
      http.get(`${API}/v2/task/86new`, () => HttpResponse.json(fx.createdTask())),
    )
    await tool('clickup_create_task').handler(
      { list_id: '100', name: 'Ship it', due_date: 'tomorrow 17:00', start_date: 'tomorrow' },
      testContext(),
    )
    expect(body.due_date_time).toBe(true)
    expect(body.start_date_time).toBe(false)
  })

  it('rejects an unknown status naming the ones the list actually has', async () => {
    mswServer.use(...fx.listMetaHandlers())
    await expect(
      tool('clickup_create_task').handler({ list_id: '100', name: 'x', status: 'shipped' }, testContext()),
    ).rejects.toThrow(/List 100 has no status "shipped". Available: open, in progress, closed/)
  })

  it('rejects an unknown custom field name naming the available fields', async () => {
    mswServer.use(...fx.listMetaHandlers())
    await expect(
      tool('clickup_create_task').handler(
        { list_id: '100', name: 'x', custom_fields: { Kunde: 'Northwind' } },
        testContext(),
      ),
    ).rejects.toThrow(/no custom field "Kunde".*Client/)
  })

  it('sends custom fields as resolved ids in a second call', async () => {
    const seen: string[] = []
    mswServer.use(...fx.listMetaHandlers(), ...fx.createWithFieldHandlers(seen))
    await tool('clickup_create_task').handler(
      { list_id: '100', name: 'x', custom_fields: { Client: 'Northwind' } },
      testContext(),
    )
    expect(seen).toContain('/v2/task/86new/field/cf-1')
  })

  it('creates a subtask by passing parent through to the API', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${API}/v2/list/100/task`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(fx.createdTask())
      }),
      http.get(`${API}/v2/task/86new`, () => HttpResponse.json(fx.createdTask())),
    )
    await tool('clickup_create_task').handler(
      { list_id: '100', name: 'Write migration', parent: '86abc' },
      testContext(),
    )
    expect(body.parent).toBe('86abc')
  })

  // Bug 1's residual failure: `createTaskRaw`'s own POST response carries no
  // `markdown_description` (ClickUp only includes it when
  // `include_markdown_description=true` is passed, and that is a GET-only
  // query parameter). Returning that response directly meant the agent saw
  // the description flattened - headings, bold, code spans and checkboxes
  // all gone - on every create that had no custom fields, even though
  // `markdown_content` (asserted on the outgoing body below) preserved them
  // in ClickUp itself. Asserted on both the outgoing body AND the returned
  // value, per the increment brief.
  it('a created task\'s description survives a markdown round trip intact', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${API}/v2/list/100/task`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(fx.createdTask())
      }),
      http.get(`${API}/v2/task/86new`, () =>
        HttpResponse.json({
          ...fx.createdTask(),
          description: fx.MARKDOWN_DESCRIPTION_FLATTENED,
          markdown_description: fx.MARKDOWN_DESCRIPTION,
        }),
      ),
    )
    const out = await tool('clickup_create_task').handler(
      { list_id: '100', name: 'Testticket', description: fx.MARKDOWN_DESCRIPTION },
      testContext(),
    )
    expect(body.markdown_content).toBe(fx.MARKDOWN_DESCRIPTION)
    expect(body.description).toBeUndefined()
    expect(out.description).toContain('# Repro steps')
    expect(out.description).toContain('**SSO**')
    expect(out.description).toContain('`redirect_uri`')
    expect(out.description).toContain('- [ ] Confirm against staging')
    expect(out.description).not.toBe(fx.MARKDOWN_DESCRIPTION_FLATTENED)
  })

  it('returns the re-fetched task with the custom field actually populated, not the pre-write snapshot (Finding 2)', async () => {
    mswServer.use(...fx.listMetaHandlers(), ...fx.createWithFieldHandlers([]))
    const out = await tool('clickup_create_task').handler(
      { list_id: '100', name: 'x', custom_fields: { Client: 'Northwind' } },
      testContext(),
    )
    expect(out.id).toBe('86new')
    expect(out.custom_fields).toEqual([{ id: 'cf-1', name: 'Client', value: 'Northwind' }])
    expect(out.custom_field_errors).toBeUndefined()
  })

  it('BREAK CHECK: keeps the task id and names the failed field when a custom field write fails after creation (Finding 2)', async () => {
    mswServer.use(...fx.listMetaHandlers(), ...fx.createWithFailingFieldHandlers())
    const out = await tool('clickup_create_task').handler(
      { list_id: '100', name: 'x', custom_fields: { Client: 'Northwind' } },
      testContext(),
    )
    // The unacceptable outcome this guards against: losing the id and
    // throwing instead, which would look like nothing was created at all
    // even though a real task now exists in ClickUp.
    expect(out.id).toBe('86new')
    expect(out.custom_field_errors).toHaveLength(1)
    expect(out.custom_field_errors[0]).toMatchObject({ field: 'Client' })
    expect(out.custom_field_errors[0].error.length).toBeGreaterThan(0)
    const md = tool('clickup_create_task').render(out, testContext())
    expect(md).toContain('86new')
    expect(md).toContain('Client')
  })

  it('rejects a non-numeric assignee id loudly instead of silently sending null, before any write (Minor 2)', async () => {
    // Deliberately no POST /v2/list/100/task handler registered: if the
    // guard were skipped, the (NaN -> null) request would actually be
    // attempted and msw's onUnhandledRequest:'error' strategy would fail
    // this test with an unhandled-request error instead of the assertion
    // below, proving the guard fires before any network call.
    await expect(
      tool('clickup_create_task').handler({ list_id: '100', name: 'x', assignees: ['not-a-number'] }, testContext()),
    ).rejects.toThrow(/"not-a-number".*not a valid ClickUp user id.*clickup_resolve_member/)
  })

  it('distinguishes "create succeeded, confirmation read failed" from an ordinary failure (Finding A)', async () => {
    mswServer.use(...fx.listMetaHandlers(), ...fx.createSucceedsThenRefetchFailsHandlers())
    await expect(
      tool('clickup_create_task').handler(
        { list_id: '100', name: 'x', custom_fields: { Client: 'Northwind' } },
        testContext(),
      ),
    ).rejects.toThrow(/succeeded, but reading task 86new back afterward failed.*already happened/)
  })
})

describe('clickup_update_task', () => {
  it('appends to the description by default rather than overwriting', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.updateHandler((b) => {
        body = b
      }),
    )
    await tool('clickup_update_task').handler({ task_id: '86abc', description: 'New note' }, testContext())
    expect(body.markdown_content).toContain('# Repro steps')
    expect(body.markdown_content).toContain('New note')
  })

  it('BREAK CHECK: appending produces the existing text before the new text, not just a substring match', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.updateHandler((b) => {
        body = b
      }),
    )
    await tool('clickup_update_task').handler({ task_id: '86abc', description: 'New note' }, testContext())
    expect(body.markdown_content).toBe(`${fx.MARKDOWN_DESCRIPTION}\n\nNew note`)
  })

  it('appends to the markdown description, keeping headings, bold, code spans and checkboxes', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.updateHandler((b) => {
        body = b
      }),
    )
    await tool('clickup_update_task').handler({ task_id: '86abc', description: 'New note' }, testContext())
    const written = String(body.markdown_content)
    expect(written).toContain('# Repro steps')
    expect(written).toContain('**SSO**')
    expect(written).toContain('`redirect_uri`')
    expect(written).toContain('- [ ] Confirm against staging')
    expect(written.endsWith('\n\nNew note')).toBe(true)
    // The lossy field must not be what was read, nor what was written.
    expect(written).not.toContain('Repro steps\n\nThe SSO path')
    expect(body.description).toBeUndefined()
  })

  // Same append round trip, but asserted on the RETURNED value too, not
  // just the outgoing body - the increment brief calls this out as the
  // worst version of the bug: an agent reading the tool's own response,
  // not the wire, is who "silently reformats everything that was already
  // there" would actually mislead.
  it('the returned task carries the appended markdown intact, not the flattened form', async () => {
    let sentBody: Record<string, unknown> = {}
    mswServer.use(
      http.get(`${API}/v2/task/86abc`, () => {
        // Before the write, ClickUp still has the original description;
        // after, it reports back exactly what was PUT - modelling a real
        // (consistent) ClickUp, not a fixture frozen at the pre-write state.
        const current =
          sentBody.markdown_content !== undefined
            ? { ...fx.taskDetailBody(), description: fx.MARKDOWN_DESCRIPTION_FLATTENED, markdown_description: String(sentBody.markdown_content) }
            : fx.taskDetailBody()
        return HttpResponse.json(current)
      }),
      http.put(`${API}/v2/task/86abc`, async ({ request }) => {
        sentBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(fx.taskDetailBody())
      }),
    )
    const out = await tool('clickup_update_task').handler({ task_id: '86abc', description: 'New note' }, testContext())
    expect(out.description).toContain('# Repro steps')
    expect(out.description).toContain('**SSO**')
    expect(out.description).toContain('`redirect_uri`')
    expect(out.description).toContain('- [ ] Confirm against staging')
    expect(out.description).toContain('New note')
    expect(out.description).not.toBe(fx.MARKDOWN_DESCRIPTION_FLATTENED)
  })

  it('asks ClickUp for the markdown description rather than the flattened one', async () => {
    const seen: string[] = []
    mswServer.use(
      http.get(`${API}/v2/task/86abc`, ({ request }) => {
        seen.push(new URL(request.url).search)
        return HttpResponse.json(fx.taskDetailBody())
      }),
      ...fx.updateHandler(() => {}),
    )
    await tool('clickup_get_task').handler({ task_id: '86abc' }, testContext())
    expect(seen[0]).toContain('include_markdown_description=true')
  })

  it('falls back to the flattened description when ClickUp reports no markdown form', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.get(`${API}/v2/task/86abc`, () =>
        HttpResponse.json({ ...fx.taskDetailBody(), markdown_description: null, description: 'Plain only' }),
      ),
      ...fx.updateHandler((b) => {
        body = b
      }),
    )
    await tool('clickup_update_task').handler({ task_id: '86abc', description: 'New note' }, testContext())
    expect(body.markdown_content).toBe('Plain only\n\nNew note')
  })

  it('overwrites only when explicitly asked', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.updateHandler((b) => {
        body = b
      }),
    )
    await tool('clickup_update_task').handler(
      { task_id: '86abc', description: 'Replaced', description_mode: 'overwrite' },
      testContext(),
    )
    expect(body.markdown_content).toBe('Replaced')
  })

  // Write bodies used to be built through `omitEmpty`, which drops '' as
  // "empty". An explicit empty string is not absence: it is the only way a
  // caller can clear a description, and dropping it left the old text in
  // place while the tool reported success.
  it('sends an explicitly empty description rather than dropping it', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.updateHandler((b) => {
        body = b
      }),
    )
    await tool('clickup_update_task').handler(
      { task_id: '86abc', description: '', description_mode: 'overwrite' },
      testContext(),
    )
    expect(Object.keys(body)).toContain('markdown_content')
    expect(body.markdown_content).toBe('')
  })

  it('returns the task as the API reports it, not the input echo', async () => {
    // The returned view comes from a post-write re-read (see
    // clickup_create_task's "always re-read" note above), not from the
    // PUT's own response - so it is the subsequent GET, not the PUT, that
    // must report the server's own value here.
    mswServer.use(
      http.get(`${API}/v2/task/86abc`, () => HttpResponse.json({ ...fx.taskDetailBody(), name: 'Server wins' })),
      ...fx.updateHandler(() => {}),
    )
    const out = await tool('clickup_update_task').handler({ task_id: '86abc', name: 'Client says' }, testContext())
    expect(out.name).toBe('Server wins')
  })

  it('rejects an unknown status naming the ones the task\'s own list has', async () => {
    mswServer.use(...fx.taskHandlers(), ...fx.listMetaHandlers())
    await expect(
      tool('clickup_update_task').handler({ task_id: '86abc', status: 'shipped' }, testContext()),
    ).rejects.toThrow(/List 100 has no status "shipped". Available: open, in progress, closed/)
  })

  // Bug 2, at the update path: same truncation bug as clickup_create_task.
  it('sets due_date_time and start_date_time only when a time of day was given', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.updateHandler((b) => {
        body = b
      }),
    )
    await tool('clickup_update_task').handler(
      { task_id: '86abc', due_date: 'tomorrow 17:00', start_date: 'tomorrow' },
      testContext(),
    )
    expect(body.due_date_time).toBe(true)
    expect(body.start_date_time).toBe(false)
  })

  it('parses time_estimate durations like "1h30m"', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.updateHandler((b) => {
        body = b
      }),
    )
    await tool('clickup_update_task').handler({ task_id: '86abc', time_estimate: '1h30m' }, testContext())
    expect(body.time_estimate).toBe(5_400_000)
  })

  it('returns the re-fetched task with the custom field actually populated, not the pre-write snapshot (Finding 2)', async () => {
    mswServer.use(...fx.listMetaHandlers(), ...fx.updateWithFieldHandlers())
    const out = await tool('clickup_update_task').handler(
      { task_id: '86abc', custom_fields: { Client: 'Northwind' } },
      testContext(),
    )
    expect(out.custom_fields).toEqual([{ id: 'cf-1', name: 'Client', value: 'Northwind' }])
    expect(out.custom_field_errors).toBeUndefined()
  })

  it('BREAK CHECK: keeps the task id and names the failed field when a custom field write fails after updating (Finding 2)', async () => {
    mswServer.use(...fx.listMetaHandlers(), ...fx.updateWithFieldHandlers({ failing: true }))
    const out = await tool('clickup_update_task').handler(
      { task_id: '86abc', custom_fields: { Client: 'Northwind' } },
      testContext(),
    )
    expect(out.id).toBe('86abc')
    expect(out.custom_field_errors).toHaveLength(1)
    expect(out.custom_field_errors[0]).toMatchObject({ field: 'Client' })
  })

  it('distinguishes "update succeeded, confirmation read failed" from an ordinary failure (Finding A)', async () => {
    mswServer.use(...fx.listMetaHandlers(), ...fx.updateSucceedsThenRefetchFailsHandlers())
    await expect(
      tool('clickup_update_task').handler(
        { task_id: '86abc', custom_fields: { Client: 'Northwind' } },
        testContext(),
      ),
    ).rejects.toThrow(/succeeded, but reading task 86abc back afterward failed.*already happened/)
  })
})

describe('clickup_update_tasks_bulk', () => {
  // Bug 2, at the bulk path: same truncation bug as clickup_create_task.
  it('sets due_date_time only when a time of day was given', async () => {
    const bodies: Record<string, unknown>[] = []
    mswServer.use(
      http.put(`${API}/v2/task/:taskId`, async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>
        bodies.push(body)
        return HttpResponse.json({ ...fx.taskDetailBody(), id: params.taskId as string })
      }),
    )
    await tool('clickup_update_tasks_bulk').handler(
      { task_ids: ['86abc'], due_date: 'tomorrow 17:00' },
      testContext(),
    )
    expect(bodies[0]?.due_date_time).toBe(true)
  })

  it('reports per task success and failure rather than failing the whole call', async () => {
    mswServer.use(...fx.bulkHandlers({ failing: ['86bad'] }))
    const out = await tool('clickup_update_tasks_bulk').handler(
      { task_ids: ['86abc', '86bad'], status: 'closed' },
      testContext(),
    )
    expect(out.succeeded).toEqual(['86abc'])
    expect(out.failed[0]).toMatchObject({ task_id: '86bad' })
  })

  it('BREAK CHECK: both outcomes appear in the SAME call, proving partial success rather than all-or-nothing', async () => {
    mswServer.use(...fx.bulkHandlers({ failing: ['86bad'] }))
    const out = await tool('clickup_update_tasks_bulk').handler(
      { task_ids: ['86abc', '86bad'], status: 'closed' },
      testContext(),
    )
    const succeeded = out.succeeded as string[]
    const failed = out.failed as Array<{ task_id: string; error: string }>
    expect(succeeded.length).toBeGreaterThan(0)
    expect(failed.length).toBeGreaterThan(0)
  })

  it('names the failure reason, not just the id', async () => {
    mswServer.use(...fx.bulkHandlers({ failing: ['86bad'] }))
    const out = await tool('clickup_update_tasks_bulk').handler({ task_ids: ['86bad'], status: 'closed' }, testContext())
    const failed = out.failed as Array<{ task_id: string; error: string }>
    expect(failed[0]!.error.length).toBeGreaterThan(0)
  })

  it('renders both the succeeded and failed sections', async () => {
    mswServer.use(...fx.bulkHandlers({ failing: ['86bad'] }))
    const out = await tool('clickup_update_tasks_bulk').handler(
      { task_ids: ['86abc', '86bad'], status: 'closed' },
      testContext(),
    )
    const md = tool('clickup_update_tasks_bulk').render(out, testContext())
    expect(md).toContain('1 succeeded, 1 failed')
    expect(md).toContain('**Succeeded**')
    expect(md).toContain('- 86abc')
    expect(md).toContain('**Failed**')
    expect(md).toContain('86bad:')
  })

  it('names the failing task in its 404 message rather than a generic "Resource unknown" (Minor 1)', async () => {
    mswServer.use(...fx.bulkHandlers({ failing: ['86bad'] }))
    const out = await tool('clickup_update_tasks_bulk').handler({ task_ids: ['86bad'], status: 'closed' }, testContext())
    const failed = out.failed as Array<{ task_id: string; error: string }>
    expect(failed[0]!.error).toContain('Task 86bad')
    expect(failed[0]!.error).not.toContain('Resource unknown')
  })

  it('rejects a non-numeric assignee id loudly instead of silently sending null, before any write (Minor 2)', async () => {
    // No PUT handler registered: a skipped guard would attempt the write
    // and fail on an unhandled request instead of this assertion.
    await expect(
      tool('clickup_update_tasks_bulk').handler(
        { task_ids: ['86abc'], assignees: ['not-a-number'] },
        testContext(),
      ),
    ).rejects.toThrow(/"not-a-number".*not a valid ClickUp user id.*clickup_resolve_member/)
  })
})

describe('clickup_move_task', () => {
  it('detects a missing status in the destination and names it', async () => {
    mswServer.use(...fx.taskHandlers(), ...fx.listMetaHandlers({ listId: '200', statuses: ['todo'] }))
    await expect(
      tool('clickup_move_task').handler({ task_id: '86abc', list_id: '200' }, testContext()),
    ).rejects.toThrow(/status "open" does not exist in list 200.*status_mappings/)
  })

  it('uses the v3 home_list endpoint', async () => {
    let path = ''
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.listMetaHandlers({ listId: '200' }),
      http.put(`${API}/v3/workspaces/9007/tasks/86abc/home_list/200`, ({ request }) => {
        path = new URL(request.url).pathname
        return HttpResponse.json({})
      }),
    )
    await tool('clickup_move_task').handler({ task_id: '86abc', list_id: '200' }, testContext())
    expect(path).toBe('/api/v3/workspaces/9007/tasks/86abc/home_list/200')
  })

  it('BREAK CHECK: the pre-check fires from cached list meta, without ever calling the move endpoint', async () => {
    let moveCalled = false
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.listMetaHandlers({ listId: '200', statuses: ['todo'] }),
      http.put(`${API}/v3/workspaces/9007/tasks/86abc/home_list/200`, () => {
        moveCalled = true
        return HttpResponse.json({})
      }),
    )
    await expect(
      tool('clickup_move_task').handler({ task_id: '86abc', list_id: '200' }, testContext()),
    ).rejects.toThrow()
    expect(moveCalled).toBe(false)
  })

  it('moves successfully when status_mappings resolves the missing status via status ids', async () => {
    let sentBody: Record<string, unknown> = {}
    mswServer.use(
      ...fx.taskHandlers(),
      http.get(`${API}/v2/list/100`, () =>
        HttpResponse.json({
          id: '100',
          name: 'Sprint 1',
          statuses: [{ status: 'open', type: 'open', orderindex: 0, id: 'src-open' }],
        }),
      ),
      http.get(`${API}/v2/list/100/field`, () => HttpResponse.json({ fields: [] })),
      http.get(`${API}/v2/list/777`, () =>
        HttpResponse.json({
          id: '777',
          name: 'Backlog',
          statuses: [{ status: 'todo', type: 'open', orderindex: 0, id: 'dst-todo' }],
        }),
      ),
      http.get(`${API}/v2/list/777/field`, () => HttpResponse.json({ fields: [] })),
      http.put(`${API}/v3/workspaces/9007/tasks/86abc/home_list/777`, async ({ request }) => {
        sentBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({})
      }),
    )
    const out = await tool('clickup_move_task').handler(
      { task_id: '86abc', list_id: '777', status_mappings: [{ from: 'open', to: 'todo' }] },
      testContext(),
    )
    expect(sentBody.status_mappings).toEqual([{ source_status_id: 'src-open', destination_status_id: 'dst-todo' }])
    expect(out.id).toBe('86abc')
  })

  it('distinguishes "move succeeded, confirmation read failed" from an ordinary failure (Finding 5)', async () => {
    mswServer.use(
      ...fx.moveSucceedsThenRefetchFailsHandlers(),
      ...fx.listMetaHandlers({ listId: '200' }),
      http.put(`${API}/v3/workspaces/9007/tasks/86abc/home_list/200`, () => HttpResponse.json({})),
    )
    await expect(
      tool('clickup_move_task').handler({ task_id: '86abc', list_id: '200' }, testContext()),
    ).rejects.toThrow(/succeeded, but reading task 86abc back afterward failed.*already happened/)
  })
})

describe('clickup_delete_task', () => {
  it('deletes the task and confirms with its id, not a guessed name', async () => {
    mswServer.use(...fx.taskHandlers(), ...fx.deleteHandlers())
    const out = await tool('clickup_delete_task').handler(
      { task_id: '86abc', confirm_name: 'Fix login bug' },
      testContext(),
    )
    expect(out).toEqual({ task_id: '86abc', deleted: true })
    const md = tool('clickup_delete_task').render(out, testContext())
    expect(md).toContain('86abc')
  })

  // The README promised every admin delete tool required a confirm_name.
  // This one took only a task_id, so a stale or guessed id destroyed
  // whatever it now pointed at. The DELETE must not be reachable at all on
  // a mismatch, which is what `deleteCalled` proves.
  it('refuses to delete when confirm_name does not match the task name', async () => {
    let deleteCalled = false
    mswServer.use(
      ...fx.taskHandlers(),
      http.delete(`${API}/v2/task/86abc`, () => {
        deleteCalled = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await expect(
      tool('clickup_delete_task').handler({ task_id: '86abc', confirm_name: 'Wrong name' }, testContext()),
    ).rejects.toThrow(/confirm_name "Wrong name" does not match task name "Fix login bug"/)
    expect(deleteCalled).toBe(false)
  })
})

describe('clickup_link_tasks', () => {
  it('links two tasks with a plain, undirected link by default', async () => {
    const seen: fx.LinkCall = {}
    mswServer.use(...fx.taskHandlers(), ...fx.linkHandlers(seen))
    await tool('clickup_link_tasks').handler({ task_id: '86abc', other_task_id: '86other' }, testContext())
    expect(seen.path).toBe('/api/v2/task/86abc/link/86other')
  })

  it('creates a "blocks" dependency as dependency_of on task_id', async () => {
    const seen: fx.LinkCall = {}
    mswServer.use(...fx.taskHandlers(), ...fx.linkHandlers(seen))
    await tool('clickup_link_tasks').handler(
      { task_id: '86abc', other_task_id: '86other', relation: 'blocks' },
      testContext(),
    )
    expect(seen.body).toEqual({ dependency_of: '86other' })
  })

  it('creates a "blocked_by" dependency as depends_on on task_id', async () => {
    const seen: fx.LinkCall = {}
    mswServer.use(...fx.taskHandlers(), ...fx.linkHandlers(seen))
    await tool('clickup_link_tasks').handler(
      { task_id: '86abc', other_task_id: '86other', relation: 'blocked_by' },
      testContext(),
    )
    expect(seen.body).toEqual({ depends_on: '86other' })
  })

  it('returns task_id\'s state as ClickUp reports it after the link, not an echo of the input', async () => {
    const seen: fx.LinkCall = {}
    mswServer.use(...fx.taskHandlers(), ...fx.linkHandlers(seen))
    const out = await tool('clickup_link_tasks').handler(
      { task_id: '86abc', other_task_id: '86other' },
      testContext(),
    )
    expect(out.name).toBe('Fix login bug')
    expect(out.other_task_id).toBe('86other')
  })

  it('distinguishes "link succeeded, confirmation read failed" from an ordinary failure (Finding 5)', async () => {
    const seen: fx.LinkCall = {}
    mswServer.use(...fx.linkHandlers(seen), ...fx.linkRefetchFailsHandlers())
    await expect(
      tool('clickup_link_tasks').handler({ task_id: '86abc', other_task_id: '86other' }, testContext()),
    ).rejects.toThrow(/succeeded, but reading task 86abc back afterward failed.*already happened/)
    // The link call itself must still have gone through - this is not a
    // case where the write also failed.
    expect(seen.path).toBe('/api/v2/task/86abc/link/86other')
  })
})

describe('clickup_get_task_time_in_status', () => {
  it('converts by_minute (a count of MINUTES) to milliseconds before formatting - 90 minutes renders as "1h 30m", not "90m" or "0m"', async () => {
    mswServer.use(...fx.taskTimeInStatusHandlers())
    const out = await tool('clickup_get_task_time_in_status').handler({ task_id: '86abc' }, testContext())
    expect(out.current_status.duration).toBe('1h 30m')
    expect(out.status_history[0].duration).toBe('45m')
  })

  it('reports the current status name and its since timestamp with a timezone offset', async () => {
    mswServer.use(...fx.taskTimeInStatusHandlers())
    const out = await tool('clickup_get_task_time_in_status').handler({ task_id: '86abc' }, testContext())
    expect(out.current_status.status).toBe('in progress')
    expect(out.current_status.since).toMatch(/\+02:00/)
  })

  it('carries the prior status name, type and duration through status_history', async () => {
    mswServer.use(...fx.taskTimeInStatusHandlers())
    const out = await tool('clickup_get_task_time_in_status').handler({ task_id: '86abc' }, testContext())
    expect(out.status_history).toHaveLength(1)
    expect(out.status_history[0].status).toBe('open')
    expect(out.status_history[0].since).toMatch(/\+02:00/)
  })

  it('states plainly that a task has no prior status history, rather than an empty section', async () => {
    mswServer.use(...fx.taskTimeInStatusNoHistoryHandlers())
    const out = await tool('clickup_get_task_time_in_status').handler({ task_id: '86abc' }, testContext())
    expect(out.status_history).toEqual([])
    const md = tool('clickup_get_task_time_in_status').render(out, testContext())
    expect(md).toContain('86abc')
    expect(md).toMatch(/no prior status history/i)
  })

  it('accepts an explicit "since": null as a valid, well-shaped response - not the shapeless/disabled-ClickApp case (increment review)', async () => {
    mswServer.use(...fx.taskTimeInStatusNullSinceHandlers())
    const out = await tool('clickup_get_task_time_in_status').handler({ task_id: '86abc' }, testContext())
    expect(out.current_status.status).toBe('open')
    expect(out.current_status.duration).toBe('1h 30m')
    expect(out.current_status.since).toBeUndefined()
    const md = tool('clickup_get_task_time_in_status').render(out, testContext())
    expect(md).not.toMatch(/Total time in Status/)
    expect(md).not.toContain('(since')
  })

  it('throws naming the Total Time in Status ClickApp when the response is shapeless, instead of reporting 0m', async () => {
    mswServer.use(...fx.taskTimeInStatusDisabledClickAppHandlers())
    await expect(
      tool('clickup_get_task_time_in_status').handler({ task_id: '86abc' }, testContext()),
    ).rejects.toThrow(/Total time in Status/)
  })

  it('the shapeless-response error reaches the agent unwrapped (ClickUpUsageError), not as "Unexpected error"', async () => {
    mswServer.use(...fx.taskTimeInStatusDisabledClickAppHandlers())
    await tool('clickup_get_task_time_in_status')
      .handler({ task_id: '86abc' }, testContext())
      .then(
        () => expect.fail('expected handler to throw'),
        (err: unknown) => {
          const message = toAgentMessage(err)
          expect(message).not.toMatch(/^Unexpected error/)
          expect(message).toMatch(/Total time in Status/)
        },
      )
  })
})

describe('clickup_get_tasks_time_in_status_bulk', () => {
  it('rejects fewer than two task ids at the schema level - the single-task tool covers one', () => {
    const shape = z.object(tool('clickup_get_tasks_time_in_status_bulk').inputSchema)
    expect(() => shape.parse({ task_ids: ['86abc'] })).toThrow()
    expect(shape.parse({ task_ids: ['86abc', '86def'] }).task_ids).toEqual(['86abc', '86def'])
  })

  it('chunks a request above 100 ids rather than sending an unbounded query, rebalancing away from a trailing chunk of one', async () => {
    const seen: string[][] = []
    mswServer.use(...fx.bulkTimeInStatusHandlers({ seen }))
    await tool('clickup_get_tasks_time_in_status_bulk').handler({ task_ids: fx.BULK_TIME_IN_STATUS_IDS }, testContext())
    // 101 ids: a naive 100/1 split would leave a lone id in a request the
    // bulk endpoint's own "two or more tasks" contract would not accept -
    // every chunk sent to ClickUp must itself contain at least two ids.
    expect(seen).toHaveLength(2)
    expect(seen.every((chunk) => chunk.length >= 2)).toBe(true)
    expect(seen.flat().sort()).toEqual([...fx.BULK_TIME_IN_STATUS_IDS].sort())
  })

  it('converts by_minute to milliseconds for every task in the batch, proven by the formatted duration value', async () => {
    mswServer.use(...fx.bulkTimeInStatusHandlers())
    const out = await tool('clickup_get_tasks_time_in_status_bulk').handler(
      { task_ids: ['86abc', '86def'] },
      testContext(),
    )
    for (const result of out.results) {
      expect(result.current_status.duration).toBe('30m')
    }
  })

  it('reports a task the response omits entirely as an explicit note, not as 0m', async () => {
    mswServer.use(...fx.bulkTimeInStatusHandlers({ omit: ['86def'] }))
    const out = await tool('clickup_get_tasks_time_in_status_bulk').handler(
      { task_ids: ['86abc', '86def'] },
      testContext(),
    )
    const missing = out.results.find((r: { task_id: string }) => r.task_id === '86def')
    expect(missing.current_status).toBeUndefined()
    expect(missing.note).toMatch(/86def/)
  })

  it('reports a task with a shapeless per-task entry as an explicit note naming the ClickApp, not as 0m', async () => {
    mswServer.use(...fx.bulkTimeInStatusHandlers({ shapeless: ['86def'] }))
    const out = await tool('clickup_get_tasks_time_in_status_bulk').handler(
      { task_ids: ['86abc', '86def'] },
      testContext(),
    )
    const shapeless = out.results.find((r: { task_id: string }) => r.task_id === '86def')
    expect(shapeless.current_status).toBeUndefined()
    expect(shapeless.note).toMatch(/Total time in Status/)
    const good = out.results.find((r: { task_id: string }) => r.task_id === '86abc')
    expect(good.current_status.duration).toBe('30m')
  })

  it('renders a compact table naming every task, not one bullet per status entry, and names a task with no prior status history explicitly', async () => {
    mswServer.use(...fx.bulkTimeInStatusHandlers({ omit: ['86def'] }))
    const out = await tool('clickup_get_tasks_time_in_status_bulk').handler(
      { task_ids: ['86abc', '86def'] },
      testContext(),
    )
    const md = tool('clickup_get_tasks_time_in_status_bulk').render(out, testContext())
    expect(md).toContain('86abc')
    expect(md).toContain('86def')
    expect(md).toContain('|')
    // Every ordinary fixture entry from bulkTimeInStatusHandlers carries a
    // genuinely empty status_history (task 86abc here included) - this
    // asserts the "no prior status history" History-column text the render
    // path already produces for that case, rather than leaving it exercised
    // but never checked (increment review).
    expect(md).toMatch(/no prior status history/i)
  })
})
