import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { COMMENT_TOOLS } from '../../src/tools/comments.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import * as fx from '../fixtures/comments.js'

const API = 'https://api.clickup.com/api'

useMsw()

/**
 * Same shape as tests/tools/tasks.test.ts's own `tool()` helper - see its
 * comment there for why this is `any` without weakening production types.
 */
const tool = (n: string): any => COMMENT_TOOLS.find((t) => t.name === n)!

describe('clickup_get_comments', () => {
  it('renders author, timestamp with offset and text', async () => {
    mswServer.use(...fx.commentsHandlers())
    const out = await tool('clickup_get_comments').handler({ task_id: fx.TASK_ID }, testContext())
    const md = tool('clickup_get_comments').render(out, testContext())
    expect(md).toContain('Bob Baker')
    expect(md).toContain('Looks good to me.')
    expect(md).toMatch(/\+02:00/)
  })

  it('says so explicitly when a task has no comments', async () => {
    mswServer.use(...fx.commentsHandlers({ empty: true }))
    const out = await tool('clickup_get_comments').handler({ task_id: fx.TASK_ID }, testContext())
    const md = tool('clickup_get_comments').render(out, testContext())
    expect(md).toBe('Task 86abc has no comments.')
  })

  it('copies the comment id verbatim rather than constructing it', async () => {
    mswServer.use(...fx.commentsHandlers())
    const out = await tool('clickup_get_comments').handler({ task_id: fx.TASK_ID }, testContext())
    expect(out.items[0].id).toBe('c1')
  })

  it('reports total/count/offset for the default page', async () => {
    mswServer.use(...fx.commentsHandlers())
    const out = await tool('clickup_get_comments').handler({ task_id: fx.TASK_ID }, testContext())
    expect(out.total).toBe(1)
    expect(out.count).toBe(1)
    expect(out.offset).toBe(0)
    expect(out.has_more).toBe(false)
  })

  it('applies limit and offset locally', async () => {
    mswServer.use(
      http.get(`${API}/v2/task/${fx.TASK_ID}/comment`, () =>
        HttpResponse.json({
          comments: [
            { id: 'c1', comment_text: 'first', user: { id: 1, username: 'A' }, date: '1568036964079' },
            { id: 'c2', comment_text: 'second', user: { id: 1, username: 'A' }, date: '1568036964079' },
            { id: 'c3', comment_text: 'third', user: { id: 1, username: 'A' }, date: '1568036964079' },
          ],
        }),
      ),
    )
    const out = await tool('clickup_get_comments').handler({ task_id: fx.TASK_ID, limit: 1, offset: 1 }, testContext())
    expect(out.items).toEqual([{ id: 'c2', author: 'A', text: 'second', date: expect.any(String) }])
    expect(out.total).toBe(3)
    expect(out.has_more).toBe(true)
    expect(out.next_offset).toBe(2)
  })
})

describe('clickup_create_comment', () => {
  it('returns the comment id from the API response', async () => {
    mswServer.use(...fx.createCommentHandlers())
    const out = await tool('clickup_create_comment').handler({ task_id: fx.TASK_ID, text: 'Ship it' }, testContext())
    expect(out.id).toBe('90010')
  })

  it('sends comment_text, the resolved assignee id and notify_all', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${API}/v2/task/${fx.TASK_ID}/comment`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: fx.COMMENT_ID, hist_id: 'h1', date: 1568036964079 })
      }),
    )
    await tool('clickup_create_comment').handler(
      { task_id: fx.TASK_ID, text: 'Ship it', assignee: '2', notify_all: true },
      testContext(),
    )
    expect(body).toEqual({ comment_text: 'Ship it', assignee: 2, notify_all: true })
  })

  it('omits assignee from the body when not provided', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${API}/v2/task/${fx.TASK_ID}/comment`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: fx.COMMENT_ID, hist_id: 'h1', date: 1568036964079 })
      }),
    )
    await tool('clickup_create_comment').handler({ task_id: fx.TASK_ID, text: 'Ship it' }, testContext())
    expect(body).toEqual({ comment_text: 'Ship it', notify_all: false })
  })

  it('rejects a non-numeric assignee id loudly instead of silently sending null, before any write', async () => {
    // Deliberately no POST handler registered: if the guard were skipped,
    // msw's onUnhandledRequest:'error' strategy would fail this test with
    // an unhandled-request error instead of the assertion below.
    await expect(
      tool('clickup_create_comment').handler({ task_id: fx.TASK_ID, text: 'x', assignee: 'bob' }, testContext()),
    ).rejects.toThrow(/"bob".*not a valid ClickUp user id/)
  })

  it('formats the returned date with the configured timezone offset', async () => {
    mswServer.use(...fx.createCommentHandlers())
    const out = await tool('clickup_create_comment').handler({ task_id: fx.TASK_ID, text: 'Ship it' }, testContext())
    expect(out.date).toMatch(/\+02:00/)
  })

  it('renders the comment id and task it was added to', async () => {
    mswServer.use(...fx.createCommentHandlers())
    const out = await tool('clickup_create_comment').handler({ task_id: fx.TASK_ID, text: 'Ship it' }, testContext())
    const md = tool('clickup_create_comment').render(out, testContext())
    expect(md).toBe(`Comment 90010 added to task ${fx.TASK_ID} at ${out.date}.`)
  })
})

describe('clickup_update_comment', () => {
  it('confirms the update by comment id, since ClickUp has no comment to read back', async () => {
    mswServer.use(...fx.updateCommentHandlers())
    const out = await tool('clickup_update_comment').handler(
      { comment_id: fx.COMMENT_ID, text: 'Edited' },
      testContext(),
    )
    expect(out).toEqual({ comment_id: fx.COMMENT_ID, updated: true })
  })

  it('sends resolved only when provided', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.updateCommentHandlers((b) => {
        body = b
      }),
    )
    await tool('clickup_update_comment').handler(
      { comment_id: fx.COMMENT_ID, text: 'Edited', resolved: true },
      testContext(),
    )
    expect(body).toEqual({ comment_text: 'Edited', resolved: true })
  })

  it('omits resolved from the body when not provided', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(
      ...fx.updateCommentHandlers((b) => {
        body = b
      }),
    )
    await tool('clickup_update_comment').handler({ comment_id: fx.COMMENT_ID, text: 'Edited' }, testContext())
    expect(body).toEqual({ comment_text: 'Edited' })
  })

  it('renders the confirmation by comment id', async () => {
    mswServer.use(...fx.updateCommentHandlers())
    const out = await tool('clickup_update_comment').handler({ comment_id: fx.COMMENT_ID, text: 'Edited' }, testContext())
    const md = tool('clickup_update_comment').render(out, testContext())
    expect(md).toBe(`Comment ${fx.COMMENT_ID} updated.`)
  })
})

describe('clickup_update_comment description', () => {
  // The example list used to end with "mark comment 90010 as resolved",
  // yet `text` is required and there is no endpoint to read a comment back.
  // An agent following that example had to invent the text and would
  // clobber the original.
  it('does not offer an example that requires inventing the comment text', () => {
    const description: string = tool('clickup_update_comment').description
    expect(description).not.toMatch(/mark comment \d+ as resolved/)
    expect(description).toMatch(/REPLACES the comment in full/)
  })
})
