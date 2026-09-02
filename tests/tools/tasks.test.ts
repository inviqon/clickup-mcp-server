import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { TASK_TOOLS } from '../../src/tools/tasks.js'
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
    expect(withComments.comments).toEqual([{ id: 'c1', author: 'Bob Baker', text: 'Looks good to me.' }])
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
    expect(md).toContain('Client (cf-1): Selectry')
    expect(md).toContain('Bob Baker: Tagged and shipped.')
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
    )
    const out = await tool('clickup_create_task').handler(
      { list_id: '100', name: 'Ship it', due_date: 'tomorrow 17:00' },
      testContext(),
    )
    expect(typeof body.due_date).toBe('number')
    expect(tool('clickup_create_task').render(out, testContext())).toContain('+02:00')
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
        { list_id: '100', name: 'x', custom_fields: { Kunde: 'Selectry' } },
        testContext(),
      ),
    ).rejects.toThrow(/no custom field "Kunde".*Client/)
  })

  it('sends custom fields as resolved ids in a second call', async () => {
    const seen: string[] = []
    mswServer.use(...fx.listMetaHandlers(), ...fx.createWithFieldHandlers(seen))
    await tool('clickup_create_task').handler(
      { list_id: '100', name: 'x', custom_fields: { Client: 'Selectry' } },
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
    )
    await tool('clickup_create_task').handler(
      { list_id: '100', name: 'Write migration', parent: '86abc' },
      testContext(),
    )
    expect(body.parent).toBe('86abc')
  })

  it('returns the re-fetched task with the custom field actually populated, not the pre-write snapshot (Finding 2)', async () => {
    mswServer.use(...fx.listMetaHandlers(), ...fx.createWithFieldHandlers([]))
    const out = await tool('clickup_create_task').handler(
      { list_id: '100', name: 'x', custom_fields: { Client: 'Selectry' } },
      testContext(),
    )
    expect(out.id).toBe('86new')
    expect(out.custom_fields).toEqual([{ id: 'cf-1', name: 'Client', value: 'Selectry' }])
    expect(out.custom_field_errors).toBeUndefined()
  })

  it('BREAK CHECK: keeps the task id and names the failed field when a custom field write fails after creation (Finding 2)', async () => {
    mswServer.use(...fx.listMetaHandlers(), ...fx.createWithFailingFieldHandlers())
    const out = await tool('clickup_create_task').handler(
      { list_id: '100', name: 'x', custom_fields: { Client: 'Selectry' } },
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
        { list_id: '100', name: 'x', custom_fields: { Client: 'Selectry' } },
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
    expect(body.description).toContain('Existing description')
    expect(body.description).toContain('New note')
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
    expect(body.description).toBe('Existing description\n\nNew note')
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
    expect(body.description).toBe('Replaced')
  })

  it('returns the task as the API reports it, not the input echo', async () => {
    mswServer.use(
      ...fx.taskHandlers(),
      ...fx.updateHandler(() => {}, { name: 'Server wins' }),
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
      { task_id: '86abc', custom_fields: { Client: 'Selectry' } },
      testContext(),
    )
    expect(out.custom_fields).toEqual([{ id: 'cf-1', name: 'Client', value: 'Selectry' }])
    expect(out.custom_field_errors).toBeUndefined()
  })

  it('BREAK CHECK: keeps the task id and names the failed field when a custom field write fails after updating (Finding 2)', async () => {
    mswServer.use(...fx.listMetaHandlers(), ...fx.updateWithFieldHandlers({ failing: true }))
    const out = await tool('clickup_update_task').handler(
      { task_id: '86abc', custom_fields: { Client: 'Selectry' } },
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
        { task_id: '86abc', custom_fields: { Client: 'Selectry' } },
        testContext(),
      ),
    ).rejects.toThrow(/succeeded, but reading task 86abc back afterward failed.*already happened/)
  })
})

describe('clickup_update_tasks_bulk', () => {
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
    mswServer.use(...fx.deleteHandlers())
    const out = await tool('clickup_delete_task').handler({ task_id: '86abc' }, testContext())
    expect(out).toEqual({ task_id: '86abc', deleted: true })
    const md = tool('clickup_delete_task').render(out, testContext())
    expect(md).toContain('86abc')
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
