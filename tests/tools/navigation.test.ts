import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NAVIGATION_TOOLS } from '../../src/tools/navigation.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import type { ClickUpContext } from '../../src/core/context.js'
import * as fx from '../fixtures/workspace.js'

const API = 'https://api.clickup.com/api'

useMsw()

/**
 * Looks up one navigation tool by name and returns a version of it whose
 * `handler` first parses `args` through the tool's own `inputSchema` -
 * exactly what `buildServer`'s wrapper (src/server.ts) does before calling a
 * real handler, so defaults such as `limit: 25` or `offset: 0` are applied
 * here too rather than reaching the handler as `undefined`. Calling
 * `def.handler` directly, unparsed, would silently diverge from production
 * behaviour for any input a test does not fully spell out.
 *
 * NAVIGATION_TOOLS is deliberately type-erased to AnyToolDefinition[] (each
 * tool keeps its own precise handler/render types; the array holding a
 * heterogeneous set of them cannot), so the lookup's return type is `any`
 * rather than any one tool's concrete shape - the same permissiveness the
 * inline callback annotations further down in this file assume.
 */
function tool(name: string): any {
  const def = NAVIGATION_TOOLS.find((t) => t.name === name)!
  return {
    handler: (args: Record<string, unknown>, ctx: ClickUpContext) =>
      def.handler(z.object(def.inputSchema).parse(args), ctx),
    render: def.render,
  }
}

describe('clickup_get_workspace_tree', () => {
  it('assembles spaces, folders and lists into one tree', async () => {
    mswServer.use(...fx.treeHandlers())
    const out = await tool('clickup_get_workspace_tree').handler({}, testContext())
    expect(out.spaces[0].folders[0].lists[0]).toMatchObject({ id: '100', name: 'Sprint 1' })
  })

  it('is served from cache on the second call', async () => {
    const spy = vi.fn()
    mswServer.use(...fx.treeHandlers(spy))
    const ctx = testContext()
    await tool('clickup_get_workspace_tree').handler({}, ctx)
    await tool('clickup_get_workspace_tree').handler({}, ctx)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('renders folderless lists without inventing a folder', async () => {
    mswServer.use(...fx.treeHandlers())
    const out = await tool('clickup_get_workspace_tree').handler({}, testContext())
    const md = tool('clickup_get_workspace_tree').render(out, testContext())
    expect(md).toContain('Backlog (101)')
    expect(md).not.toContain('undefined')
  })

  it('omits task_count for a folderless list that reports it as null, rather than inventing 0', async () => {
    mswServer.use(...fx.treeHandlers())
    const out = await tool('clickup_get_workspace_tree').handler({}, testContext())
    const backlog = out.spaces[0].lists.find((l: { id: string }) => l.id === '101')
    expect(backlog).toBeDefined()
    expect(backlog).not.toHaveProperty('task_count')
    const md = tool('clickup_get_workspace_tree').render(out, testContext())
    expect(md).not.toContain('null task(s)')
  })

  it('is keyed per team id, not shared across teams (BREAK: would fail if the cache key ignored teamId)', async () => {
    // Two different team ids must not collide on the same cache entry, or a
    // second tenant's workspace tree would leak into the first tenant's read.
    const spy = vi.fn()
    mswServer.use(...fx.treeHandlers(spy))
    const cache = testContext().cache
    await tool('clickup_get_workspace_tree').handler({}, testContext({ cache, teamId: '9007' }))
    await tool('clickup_get_workspace_tree').handler({}, testContext({ cache, teamId: '9008' }))
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('renders a space with no folders under "Lists (no folder)" only, without an empty Folders heading', async () => {
    mswServer.use(
      http.get(`${API}/v2/space/${fx.SPACE_ID}/folder`, () => HttpResponse.json({ folders: [] })),
      ...fx.treeHandlers(),
    )
    const out = await tool('clickup_get_workspace_tree').handler({}, testContext())
    expect(out.spaces[0].folders).toEqual([])
    const md = tool('clickup_get_workspace_tree').render(out, testContext())
    expect(md).not.toContain('**Folders**')
    expect(md).toContain('**Lists (no folder)**')
  })

  it('normalises a numeric-string task_count (as some ClickUp endpoints report it) to a number', async () => {
    mswServer.use(
      http.get(`${API}/v2/space/${fx.SPACE_ID}/list`, () =>
        HttpResponse.json({ lists: [{ id: fx.FOLDERLESS_LIST_ID, name: 'Backlog', task_count: '7' }] }),
      ),
      ...fx.treeHandlers(),
    )
    const out = await tool('clickup_get_workspace_tree').handler({}, testContext())
    expect(out.spaces[0].lists[0]).toMatchObject({ task_count: 7 })
  })
})

describe('clickup_get_list', () => {
  it('returns statuses and custom field definitions together', async () => {
    mswServer.use(...fx.listHandlers())
    const out = await tool('clickup_get_list').handler({ list_id: '100' }, testContext())
    expect(out.statuses.map((s: { status: string }) => s.status)).toContain('in progress')
    expect(out.custom_fields[0]).toMatchObject({ name: 'Client', type: 'drop_down' })
  })

  it('exposes dropdown option names so a writer does not have to guess', async () => {
    mswServer.use(...fx.listHandlers())
    const out = await tool('clickup_get_list').handler({ list_id: '100' }, testContext())
    expect(out.custom_fields[0].options.map((o: { name: string }) => o.name)).toContain('Selectry')
  })

  it('captures a status id only when ClickUp actually reports one', async () => {
    mswServer.use(...fx.listHandlers())
    const out = await tool('clickup_get_list').handler({ list_id: '100' }, testContext())
    const open = out.statuses.find((s: { status: string }) => s.status === 'open')
    const inProgress = out.statuses.find((s: { status: string }) => s.status === 'in progress')
    expect(open).not.toHaveProperty('id')
    expect(inProgress?.id).toBe('p900123_4a2Bc9Zk')
  })

  it('omits the options key for a dropdown field with an empty options array, rather than printing an empty list', async () => {
    mswServer.use(...fx.listHandlers())
    const out = await tool('clickup_get_list').handler({ list_id: '100' }, testContext())
    const category = out.custom_fields.find((f: { name: string }) => f.name === 'Category')
    expect(category).not.toHaveProperty('options')
    const md = tool('clickup_get_list').render(out, testContext())
    expect(md).toContain('Category (cf-category) (drop_down)')
    expect(md).not.toMatch(/Category \(cf-category\) \(drop_down\):/)
  })
})

describe('clickup_resolve_member', () => {
  it('returns every candidate rather than picking the first', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler({ query: 'a' }, testContext())
    expect(out.matches.length).toBeGreaterThan(1)
    expect(out.ambiguous).toBe(true)
  })

  it('resolves "me" to the authenticated user', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler({ query: 'me' }, testContext())
    expect(out.matches).toHaveLength(1)
    expect(out.ambiguous).toBe(false)
  })

  it('says so explicitly when nothing matches', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler({ query: 'zzz' }, testContext())
    const md = tool('clickup_resolve_member').render(out, testContext())
    expect(md).toContain('No workspace member matches "zzz"')
  })

  it('matches case-insensitively on email as well as username', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler({ query: 'BOB@EXAMPLE' }, testContext())
    expect(out.matches).toHaveLength(1)
    expect(out.matches[0]).toMatchObject({ id: '2', username: 'Bob Baker' })
  })

  it('renders every match with its email when the query is ambiguous, rather than silently narrowing to one', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler({ query: 'a' }, testContext())
    const md = tool('clickup_resolve_member').render(out, testContext())
    expect(md).toContain('Multiple members match "a"')
    expect(md).toContain('Alice Anderson (1) <alice@example.com>')
    expect(md).toContain('Bob Baker (2) <bob@example.com>')
    expect(md).toContain('Carol Diaz (3) <carol@example.com>')
  })

  it('renders a single unambiguous match without the "multiple members" wording', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler({ query: 'me' }, testContext())
    const md = tool('clickup_resolve_member').render(out, testContext())
    expect(md).not.toContain('Multiple members match')
    expect(md).toContain('Alice Anderson (1) <alice@example.com>')
  })

  it('finds no members for a team id that matches none of the caller\'s workspaces, rather than throwing', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler(
      { query: 'alice' },
      testContext({ teamId: 'no-such-team' }),
    )
    expect(out.matches).toEqual([])
    expect(out.ambiguous).toBe(false)
  })
})

describe('clickup_search_tasks', () => {
  it('paginates with the documented envelope', async () => {
    mswServer.use(...fx.searchHandlers())
    const out = await tool('clickup_search_tasks').handler({ query: 'login', limit: 1 }, testContext())
    expect(out).toMatchObject({ count: 1, has_more: true, next_offset: 1 })
  })

  it('tells the agent more results exist when the page is not the whole match set', async () => {
    mswServer.use(...fx.searchHandlers())
    const out = await tool('clickup_search_tasks').handler({ query: 'login', limit: 1 }, testContext())
    const md = tool('clickup_search_tasks').render(out, testContext())
    expect(md).toContain('more available')
  })

  it('reports an empty result with the query that produced it', async () => {
    mswServer.use(...fx.searchHandlers({ empty: true }))
    const out = await tool('clickup_search_tasks').handler({ query: 'zzz' }, testContext())
    const md = tool('clickup_search_tasks').render(out, testContext())
    expect(md).toContain('No tasks found matching "zzz"')
  })

  it('matches on description text, not just the task name', async () => {
    mswServer.use(...fx.searchHandlers())
    const out = await tool('clickup_search_tasks').handler({ query: 'sso' }, testContext())
    expect(out.items.map((t: { id: string }) => t.id)).toEqual(['9hx'])
  })

  it('omits due_date for a task that reports it as null, rather than printing null', async () => {
    mswServer.use(...fx.searchHandlers())
    const out = await tool('clickup_search_tasks').handler({ query: 'login' }, testContext())
    const page = tool('clickup_search_tasks').handler({ query: 'login page' }, testContext())
    const noDueDate = (await page).items[0]
    expect(noDueDate).not.toHaveProperty('due_date')
    const md = tool('clickup_search_tasks').render(await page, testContext())
    expect(md).not.toContain('null')
    expect(md).not.toContain('undefined')
    expect(md).not.toContain(' - due ')
    // Sanity: the task that does have a due date renders it, so the absence
    // above is a real omission, not a renderer that never prints due dates.
    const withDueDate = tool('clickup_search_tasks').render(out, testContext())
    expect(withDueDate).toMatch(/due \d{4}-\d{2}-\d{2}/)
  })

  it('copies ids verbatim from the API response rather than constructing them', async () => {
    mswServer.use(...fx.searchHandlers())
    const out = await tool('clickup_search_tasks').handler({ query: 'login' }, testContext())
    expect(out.items.map((t: { id: string }) => t.id).sort()).toEqual(['9hx', '9hy'])
  })
})
