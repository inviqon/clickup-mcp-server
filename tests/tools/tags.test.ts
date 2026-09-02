import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { TAG_TOOLS } from '../../src/tools/tags.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import * as treeFx from '../fixtures/workspace.js'

const API = 'https://api.clickup.com/api'

useMsw()

/**
 * Same shape as tests/tools/tasks.test.ts's own `tool()` helper.
 */
const tool = (n: string): any => TAG_TOOLS.find((t) => t.name === n)!

/**
 * A minimal `TaskDetailSchema`-shaped task, sitting in list 100 (folder 10,
 * space 1 - the same ids `tests/fixtures/workspace.ts`'s `treeHandlers`
 * assembles), carrying whatever tags the test needs.
 */
function taskDetail(opts: { tags?: string[] } = {}) {
  return {
    id: '86abc',
    name: 'Fix login bug',
    status: { status: 'open' },
    list: { id: treeFx.LIST_IN_FOLDER_ID, name: 'Sprint 1' },
    url: 'https://app.clickup.com/t/86abc',
    tags: (opts.tags ?? []).map((name) => ({ name })),
  }
}

function spaceTagsHandler(names: string[]) {
  return http.get(`${API}/v2/space/${treeFx.SPACE_ID}/tag`, () =>
    HttpResponse.json({ tags: names.map((name) => ({ name, tag_fg: '#000', tag_bg: '#fff' })) }),
  )
}

type Call = { method: string; path: string }

/**
 * Tracks every add/remove tag call into `calls` as `{ method, path }`,
 * stripping msw's own `/api` prefix so a test can assert against the same
 * `/v2/...` paths this server's own client builds URLs from.
 */
function trackedTagHandlers(calls: Call[]) {
  return [
    http.post(`${API}/v2/task/86abc/tag/:tagName`, ({ request }) => {
      calls.push({ method: 'POST', path: new URL(request.url).pathname.replace(/^\/api/, '') })
      return HttpResponse.json({})
    }),
    http.delete(`${API}/v2/task/86abc/tag/:tagName`, ({ request }) => {
      calls.push({ method: 'DELETE', path: new URL(request.url).pathname.replace(/^\/api/, '') })
      return HttpResponse.json({})
    }),
  ]
}

describe('clickup_list_space_tags', () => {
  it('lists the tag names in a space', async () => {
    mswServer.use(spaceTagsHandler(['a', 'b', 'c']))
    const out = await tool('clickup_list_space_tags').handler({ space_id: '1' }, testContext())
    expect(out.tags).toEqual(['a', 'b', 'c'])
  })

  it('reports an empty space explicitly, naming the space', async () => {
    mswServer.use(spaceTagsHandler([]))
    const out = await tool('clickup_list_space_tags').handler({ space_id: '1' }, testContext())
    const md = tool('clickup_list_space_tags').render(out, testContext())
    expect(md).toBe('Space 1 has no tags.')
  })

  it('renders a non-empty tag list as a header plus bullets', async () => {
    mswServer.use(spaceTagsHandler(['a', 'b']))
    const out = await tool('clickup_list_space_tags').handler({ space_id: '1' }, testContext())
    const md = tool('clickup_list_space_tags').render(out, testContext())
    expect(md).toBe('# Tags in space 1\n\n- a\n- b')
  })
})

describe('clickup_set_task_tags', () => {
  it('issues only the difference between current and desired tags', async () => {
    const calls: Call[] = []
    mswServer.use(
      ...treeFx.treeHandlers(),
      http.get(`${API}/v2/task/86abc`, () => HttpResponse.json(taskDetail({ tags: ['a', 'b'] }))),
      spaceTagsHandler(['a', 'b', 'c']),
      ...trackedTagHandlers(calls),
    )
    await tool('clickup_set_task_tags').handler({ task_id: '86abc', tags: ['b', 'c'] }, testContext())
    expect(calls).toEqual([
      { method: 'DELETE', path: '/v2/task/86abc/tag/a' },
      { method: 'POST', path: '/v2/task/86abc/tag/c' },
    ])
  })

  it('makes no call at all when the tag set already matches', async () => {
    const calls: Call[] = []
    mswServer.use(
      ...treeFx.treeHandlers(),
      http.get(`${API}/v2/task/86abc`, () => HttpResponse.json(taskDetail({ tags: ['a', 'b'] }))),
      spaceTagsHandler(['a', 'b']),
      ...trackedTagHandlers(calls),
    )
    await tool('clickup_set_task_tags').handler({ task_id: '86abc', tags: ['b', 'a'] }, testContext())
    expect(calls).toEqual([])
  })

  it('rejects a tag that does not exist in the space, naming the available ones', async () => {
    mswServer.use(
      ...treeFx.treeHandlers(),
      http.get(`${API}/v2/task/86abc`, () => HttpResponse.json(taskDetail({ tags: [] }))),
      spaceTagsHandler(['a', 'b', 'c']),
    )
    // Deliberately no POST/DELETE tag handler registered: if validation ran
    // after a write instead of before it, an attempted call would fail on
    // msw's onUnhandledRequest:'error' instead of this assertion.
    await expect(
      tool('clickup_set_task_tags').handler({ task_id: '86abc', tags: ['nope'] }, testContext()),
    ).rejects.toThrow(/Space 1 has no tag "nope". Available: a, b, c/)
  })

  it('validates every requested tag before issuing any write, even when only the last one is bad', async () => {
    const calls: Call[] = []
    mswServer.use(
      ...treeFx.treeHandlers(),
      http.get(`${API}/v2/task/86abc`, () => HttpResponse.json(taskDetail({ tags: [] }))),
      spaceTagsHandler(['a', 'b']),
      ...trackedTagHandlers(calls),
    )
    await expect(
      tool('clickup_set_task_tags').handler({ task_id: '86abc', tags: ['a', 'nope'] }, testContext()),
    ).rejects.toThrow(/has no tag "nope"/)
    expect(calls).toEqual([])
  })

  it('returns the refetched tags after a write, not an echo of the requested set (reliability rule 3)', async () => {
    let taskCalls = 0
    mswServer.use(
      ...treeFx.treeHandlers(),
      http.get(`${API}/v2/task/86abc`, () => {
        taskCalls += 1
        // First call: the pre-write state used to compute the diff. Second
        // call: the post-write refetch, which reports the space's own view
        // - including a tag ("extra") this call never requested, proving
        // the output is not just `args.tags` echoed back.
        return HttpResponse.json(taskDetail({ tags: taskCalls === 1 ? ['a'] : ['b', 'c', 'extra'] }))
      }),
      spaceTagsHandler(['a', 'b', 'c']),
      ...trackedTagHandlers([]),
    )
    const out = await tool('clickup_set_task_tags').handler({ task_id: '86abc', tags: ['b', 'c'] }, testContext())
    expect(out.tags).toEqual(['b', 'c', 'extra'])
  })

  it('resolves the task\'s space via the workspace tree rather than a new endpoint', async () => {
    const spy = vi.fn()
    mswServer.use(
      ...treeFx.treeHandlers(spy),
      http.get(`${API}/v2/task/86abc`, () => HttpResponse.json(taskDetail({ tags: [] }))),
      spaceTagsHandler(['a']),
      ...trackedTagHandlers([]),
    )
    await tool('clickup_set_task_tags').handler({ task_id: '86abc', tags: ['a'] }, testContext())
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('throws when the task\'s list cannot be found in any known space', async () => {
    mswServer.use(
      ...treeFx.treeHandlers(),
      http.get(`${API}/v2/task/86abc`, () =>
        HttpResponse.json({
          id: '86abc',
          name: 'Orphan task',
          status: { status: 'open' },
          list: { id: 'unknown-list', name: 'Nowhere' },
          url: 'https://app.clickup.com/t/86abc',
          tags: [],
        }),
      ),
    )
    await expect(
      tool('clickup_set_task_tags').handler({ task_id: '86abc', tags: [] }, testContext()),
    ).rejects.toThrow(/Could not resolve the space for task 86abc \(list unknown-list\)/)
  })

  it('renders the resulting tags when the task ends up with some', async () => {
    let taskCalls = 0
    mswServer.use(
      ...treeFx.treeHandlers(),
      http.get(`${API}/v2/task/86abc`, () => {
        taskCalls += 1
        // First call (pre-write diff): only "a" so far. Second call
        // (post-write refetch): ClickUp confirms "b" was added too.
        return HttpResponse.json(taskDetail({ tags: taskCalls === 1 ? ['a'] : ['a', 'b'] }))
      }),
      spaceTagsHandler(['a', 'b']),
      ...trackedTagHandlers([]),
    )
    const out = await tool('clickup_set_task_tags').handler({ task_id: '86abc', tags: ['a', 'b'] }, testContext())
    expect(tool('clickup_set_task_tags').render(out, testContext())).toBe('Task 86abc now has tags: a, b')
  })

  it('renders "now has no tags" when the write clears every tag', async () => {
    let taskCalls = 0
    mswServer.use(
      ...treeFx.treeHandlers(),
      http.get(`${API}/v2/task/86abc`, () => {
        taskCalls += 1
        // First call (pre-write diff): the task still carries "a". Second
        // call (post-write refetch): ClickUp confirms it now has none.
        return HttpResponse.json(taskDetail({ tags: taskCalls === 1 ? ['a'] : [] }))
      }),
      spaceTagsHandler(['a']),
      ...trackedTagHandlers([]),
    )
    const out = await tool('clickup_set_task_tags').handler({ task_id: '86abc', tags: [] }, testContext())
    expect(tool('clickup_set_task_tags').render(out, testContext())).toBe('Task 86abc now has no tags.')
  })
})
