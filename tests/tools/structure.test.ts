import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { STRUCTURE_TOOLS } from '../../src/tools/structure.js'
import { loadListMeta, loadWorkspaceTree } from '../../src/clickup/endpoints/workspace.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import * as treeFx from '../fixtures/workspace.js'

const API = 'https://api.clickup.com/api'

useMsw()

/**
 * Same shape as tests/tools/tasks.test.ts's own `tool()` helper.
 */
const tool = (n: string): any => STRUCTURE_TOOLS.find((t) => t.name === n)!

describe('delete guards', () => {
  it('refuses to delete a space when confirm_name does not match the actual name', async () => {
    let deleteCalled = false
    mswServer.use(
      http.get(`${API}/v2/space/1`, () => HttpResponse.json({ id: '1', name: 'Client Work', private: false })),
      http.delete(`${API}/v2/space/1`, () => {
        deleteCalled = true
        return HttpResponse.json({})
      }),
    )
    await expect(
      tool('clickup_delete_space').handler({ space_id: '1', confirm_name: 'Wrong' }, testContext()),
    ).rejects.toThrow(/confirm_name "Wrong" does not match space name "Client Work"/)
    expect(deleteCalled).toBe(false)
  })

  it('deletes a space when confirm_name matches exactly', async () => {
    let deleteCalled = false
    mswServer.use(
      http.get(`${API}/v2/space/1`, () => HttpResponse.json({ id: '1', name: 'Client Work', private: false })),
      http.delete(`${API}/v2/space/1`, () => {
        deleteCalled = true
        return HttpResponse.json({})
      }),
    )
    const out = await tool('clickup_delete_space').handler({ space_id: '1', confirm_name: 'Client Work' }, testContext())
    expect(out).toEqual({ space_id: '1', deleted: true })
    expect(deleteCalled).toBe(true)
  })

  it('refuses to delete a folder on name mismatch, never reaching DELETE', async () => {
    let deleteCalled = false
    mswServer.use(
      http.get(`${API}/v2/folder/10`, () => HttpResponse.json({ id: '10', name: 'Sprints' })),
      http.delete(`${API}/v2/folder/10`, () => {
        deleteCalled = true
        return HttpResponse.json({})
      }),
    )
    await expect(
      tool('clickup_delete_folder').handler({ folder_id: '10', confirm_name: 'Wrong' }, testContext()),
    ).rejects.toThrow(/confirm_name "Wrong" does not match folder name "Sprints"/)
    expect(deleteCalled).toBe(false)
  })

  it('deletes a folder when confirm_name matches exactly', async () => {
    let deleteCalled = false
    mswServer.use(
      http.get(`${API}/v2/folder/10`, () => HttpResponse.json({ id: '10', name: 'Sprints' })),
      http.delete(`${API}/v2/folder/10`, () => {
        deleteCalled = true
        return HttpResponse.json({})
      }),
    )
    const out = await tool('clickup_delete_folder').handler({ folder_id: '10', confirm_name: 'Sprints' }, testContext())
    expect(out).toEqual({ folder_id: '10', deleted: true })
    expect(deleteCalled).toBe(true)
  })

  it('refuses to delete a list on name mismatch, never reaching DELETE', async () => {
    let deleteCalled = false
    mswServer.use(
      ...treeFx.listHandlers(),
      http.delete(`${API}/v2/list/${treeFx.LIST_IN_FOLDER_ID}`, () => {
        deleteCalled = true
        return HttpResponse.json({})
      }),
    )
    await expect(
      tool('clickup_delete_list').handler({ list_id: treeFx.LIST_IN_FOLDER_ID, confirm_name: 'Wrong' }, testContext()),
    ).rejects.toThrow(/confirm_name "Wrong" does not match list name "Sprint 1"/)
    expect(deleteCalled).toBe(false)
  })

  it('deletes a list when confirm_name matches exactly', async () => {
    let deleteCalled = false
    mswServer.use(
      ...treeFx.listHandlers(),
      http.delete(`${API}/v2/list/${treeFx.LIST_IN_FOLDER_ID}`, () => {
        deleteCalled = true
        return HttpResponse.json({})
      }),
    )
    const out = await tool('clickup_delete_list').handler(
      { list_id: treeFx.LIST_IN_FOLDER_ID, confirm_name: 'Sprint 1' },
      testContext(),
    )
    expect(out).toEqual({ list_id: treeFx.LIST_IN_FOLDER_ID, deleted: true })
    expect(deleteCalled).toBe(true)
  })
})

describe('clickup_create_list', () => {
  it('requires exactly one of folder_id or space_id', async () => {
    await expect(tool('clickup_create_list').handler({ name: 'x' }, testContext())).rejects.toThrow(
      /Provide either folder_id or space_id/,
    )
    await expect(
      tool('clickup_create_list').handler({ name: 'x', folder_id: '10', space_id: '1' }, testContext()),
    ).rejects.toThrow(/not both/)
  })

  it('creates a list inside a folder via POST /v2/folder/{id}/list', async () => {
    let path = ''
    mswServer.use(
      http.post(`${API}/v2/folder/10/list`, ({ request }) => {
        path = new URL(request.url).pathname
        return HttpResponse.json({ id: '200', name: 'Backlog', content: null, due_date: null })
      }),
    )
    const out = await tool('clickup_create_list').handler({ name: 'Backlog', folder_id: '10' }, testContext())
    expect(path).toBe('/api/v2/folder/10/list')
    expect(out).toEqual({ id: '200', name: 'Backlog' })
  })

  it('creates a folderless list in a space via POST /v2/space/{id}/list', async () => {
    let path = ''
    mswServer.use(
      http.post(`${API}/v2/space/1/list`, ({ request }) => {
        path = new URL(request.url).pathname
        return HttpResponse.json({ id: '201', name: 'Ideas', content: null, due_date: null })
      }),
    )
    const out = await tool('clickup_create_list').handler({ name: 'Ideas', space_id: '1' }, testContext())
    expect(path).toBe('/api/v2/space/1/list')
    expect(out).toEqual({ id: '201', name: 'Ideas' })
  })

  it('resolves a natural language due_date to epoch ms before sending, and formats it with an offset back', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${API}/v2/space/1/list`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: '201', name: 'Ideas', due_date: String(body.due_date) })
      }),
    )
    const out = await tool('clickup_create_list').handler(
      { name: 'Ideas', space_id: '1', due_date: 'tomorrow 17:00' },
      testContext(),
    )
    expect(typeof body.due_date).toBe('number')
    expect(out.due_date).toMatch(/\+0[12]:00$/)
  })

  it('rejects a non-numeric assignee id before any write', async () => {
    // Deliberately no POST handler registered: a skipped guard would attempt
    // the write and fail on an unhandled request instead of this assertion.
    await expect(
      tool('clickup_create_list').handler({ name: 'x', space_id: '1', assignee: 'bob' }, testContext()),
    ).rejects.toThrow(/"bob".*not a valid ClickUp user id/)
  })
})

describe('cache invalidation', () => {
  it('invalidates the workspace tree after a structural write', async () => {
    const spy = vi.fn()
    mswServer.use(
      ...treeFx.treeHandlers(spy),
      http.post(`${API}/v2/space/${treeFx.SPACE_ID}/folder`, () =>
        HttpResponse.json({ id: '20', name: 'New Folder' }),
      ),
    )
    const ctx = testContext()
    await loadWorkspaceTree(ctx)
    await tool('clickup_create_folder').handler({ space_id: treeFx.SPACE_ID, name: 'New Folder' }, ctx)
    await loadWorkspaceTree(ctx)
    // Two upstream fetches of GET /v2/team/{teamId}/space prove the second
    // clickup_get_workspace_tree-equivalent read actually hit the API again
    // rather than being served from the (invalidated) tree cache.
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('invalidates the workspace tree after creating a list', async () => {
    const spy = vi.fn()
    mswServer.use(
      ...treeFx.treeHandlers(spy),
      http.post(`${API}/v2/space/${treeFx.SPACE_ID}/list`, () => HttpResponse.json({ id: '201', name: 'Ideas' })),
    )
    const ctx = testContext()
    await loadWorkspaceTree(ctx)
    await tool('clickup_create_list').handler({ name: 'Ideas', space_id: treeFx.SPACE_ID }, ctx)
    await loadWorkspaceTree(ctx)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('invalidates this list\'s own cached metadata after clickup_update_list', async () => {
    const spy = vi.fn()
    mswServer.use(
      http.get(`${API}/v2/list/${treeFx.LIST_IN_FOLDER_ID}`, () => {
        spy()
        return HttpResponse.json({ id: treeFx.LIST_IN_FOLDER_ID, name: 'Sprint 1', statuses: [] })
      }),
      http.get(`${API}/v2/list/${treeFx.LIST_IN_FOLDER_ID}/field`, () => HttpResponse.json({ fields: [] })),
      http.put(`${API}/v2/list/${treeFx.LIST_IN_FOLDER_ID}`, () =>
        HttpResponse.json({ id: treeFx.LIST_IN_FOLDER_ID, name: 'Sprint 2' }),
      ),
    )
    const ctx = testContext()
    await loadListMeta(ctx, treeFx.LIST_IN_FOLDER_ID)
    await tool('clickup_update_list').handler({ list_id: treeFx.LIST_IN_FOLDER_ID, name: 'Sprint 2' }, ctx)
    await loadListMeta(ctx, treeFx.LIST_IN_FOLDER_ID)
    // Two GET /v2/list/100 calls prove the second loadListMeta read hit the
    // API again rather than being served from the (invalidated) cache.
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('invalidates this list\'s own cached metadata after clickup_delete_list', async () => {
    const spy = vi.fn()
    mswServer.use(
      http.get(`${API}/v2/list/${treeFx.LIST_IN_FOLDER_ID}`, () => {
        spy()
        return HttpResponse.json({ id: treeFx.LIST_IN_FOLDER_ID, name: 'Sprint 1', statuses: [] })
      }),
      http.get(`${API}/v2/list/${treeFx.LIST_IN_FOLDER_ID}/field`, () => HttpResponse.json({ fields: [] })),
      http.delete(`${API}/v2/list/${treeFx.LIST_IN_FOLDER_ID}`, () => HttpResponse.json({})),
    )
    const ctx = testContext()
    await loadListMeta(ctx, treeFx.LIST_IN_FOLDER_ID)
    await tool('clickup_delete_list').handler({ list_id: treeFx.LIST_IN_FOLDER_ID, confirm_name: 'Sprint 1' }, ctx)
    await loadListMeta(ctx, treeFx.LIST_IN_FOLDER_ID)
    // Three calls, not two: the initial loadListMeta (cached, call 1),
    // clickup_delete_list's own uncached confirm-name read (call 2 - a
    // delete confirmation deliberately reads fresh rather than trusting the
    // cache), and the final loadListMeta (call 3) proving its cache entry
    // was invalidated rather than still serving the pre-delete value.
    expect(spy).toHaveBeenCalledTimes(3)
  })
})

describe('clickup_create_space', () => {
  it('maps features to ClickUp\'s {enabled} shape and returns the API\'s own view', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${API}/v2/team/${treeFx.TEAM_ID}/space`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: '2', name: 'Marketing', private: true })
      }),
    )
    const out = await tool('clickup_create_space').handler(
      { name: 'Marketing', private: true, features: { time_tracking: true, tags: false } },
      testContext(),
    )
    expect(body).toEqual({
      name: 'Marketing',
      private: true,
      features: { time_tracking: { enabled: true }, tags: { enabled: false } },
    })
    expect(out).toEqual({ id: '2', name: 'Marketing', private: true })
  })

  it('defaults private to false when not provided', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${API}/v2/team/${treeFx.TEAM_ID}/space`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: '2', name: 'Marketing', private: false })
      }),
    )
    await tool('clickup_create_space').handler({ name: 'Marketing' }, testContext())
    expect(body.private).toBe(false)
  })
})

describe('clickup_update_space', () => {
  it('sends only the fields provided, and returns the API\'s post-write view', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.put(`${API}/v2/space/1`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: '1', name: 'Client Work', private: false })
      }),
    )
    const out = await tool('clickup_update_space').handler({ space_id: '1', name: 'Client Work' }, testContext())
    expect(body).toEqual({ name: 'Client Work' })
    expect(out).toEqual({ id: '1', name: 'Client Work', private: false })
  })
})

describe('clickup_create_folder', () => {
  it('creates a folder in a space', async () => {
    mswServer.use(http.post(`${API}/v2/space/1/folder`, () => HttpResponse.json({ id: '20', name: 'New Folder' })))
    const out = await tool('clickup_create_folder').handler({ space_id: '1', name: 'New Folder' }, testContext())
    expect(out).toEqual({ id: '20', name: 'New Folder' })
  })
})

describe('clickup_update_folder', () => {
  it('renames a folder, sending only name', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.put(`${API}/v2/folder/10`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: '10', name: 'Renamed' })
      }),
    )
    const out = await tool('clickup_update_folder').handler({ folder_id: '10', name: 'Renamed' }, testContext())
    expect(body).toEqual({ name: 'Renamed' })
    expect(out).toEqual({ id: '10', name: 'Renamed' })
  })
})

describe('render output', () => {
  it('renders a space, including its private flag when known', () => {
    const md = tool('clickup_create_space').render({ id: '2', name: 'Marketing', private: true }, testContext())
    expect(md).toBe('# Marketing (2)\n\n- **Private**: yes')
  })

  it('renders a space without a private line when the API did not report one', () => {
    const md = tool('clickup_create_space').render({ id: '2', name: 'Marketing' }, testContext())
    expect(md).toBe('# Marketing (2)')
  })

  it('renders a folder', () => {
    const md = tool('clickup_create_folder').render({ id: '10', name: 'Sprints' }, testContext())
    expect(md).toBe('# Sprints (10)')
  })

  it('renders a list with due date and content when present', () => {
    const md = tool('clickup_create_list').render(
      { id: '200', name: 'Backlog', content: 'Triage queue', due_date: '2026-09-05T00:00:00+02:00' },
      testContext(),
    )
    expect(md).toContain('# Backlog (200)')
    expect(md).toContain('**Due**: 2026-09-05T00:00:00+02:00')
    expect(md).toContain('**Content**')
    expect(md).toContain('Triage queue')
  })

  it('renders a list with neither due date nor content as just its header', () => {
    const md = tool('clickup_create_list').render({ id: '200', name: 'Backlog' }, testContext())
    expect(md).toBe('# Backlog (200)')
  })

  it('renders the delete confirmations by id', () => {
    expect(tool('clickup_delete_space').render({ space_id: '1', deleted: true }, testContext())).toBe(
      'Space 1 deleted.',
    )
    expect(tool('clickup_delete_folder').render({ folder_id: '10', deleted: true }, testContext())).toBe(
      'Folder 10 deleted.',
    )
    expect(tool('clickup_delete_list').render({ list_id: '100', deleted: true }, testContext())).toBe(
      'List 100 deleted.',
    )
  })
})
