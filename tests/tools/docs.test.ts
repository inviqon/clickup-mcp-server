import { describe, expect, it } from 'vitest'
import { DOC_TOOLS } from '../../src/tools/docs.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import * as fx from '../fixtures/docs.js'

useMsw()

const tool = (n: string): any => DOC_TOOLS.find((t) => t.name === n)!

describe('clickup_search_docs', () => {
  it('matches on doc name and returns ids verbatim', async () => {
    mswServer.use(...fx.searchDocsHandlers())
    const out = await tool('clickup_search_docs').handler({ query: 'architecture', limit: 10, offset: 0 }, testContext())
    expect(out.items).toEqual([{ id: 'd-1', name: 'Backend Architecture' }])
  })

  it('matches case-insensitively', async () => {
    mswServer.use(...fx.searchDocsHandlers())
    const out = await tool('clickup_search_docs').handler({ query: 'ONBOARDING', limit: 10, offset: 0 }, testContext())
    expect(out.items.map((d: { id: string }) => d.id)).toEqual(['d-2'])
  })

  it('reports no match with the query that produced it', async () => {
    mswServer.use(...fx.searchDocsHandlers())
    const out = await tool('clickup_search_docs').handler({ query: 'zzz', limit: 10, offset: 0 }, testContext())
    const md = tool('clickup_search_docs').render(out, testContext())
    expect(md).toContain('No docs found matching "zzz"')
  })

  it('paginates matches, reporting has_more', async () => {
    mswServer.use(...fx.searchDocsHandlers())
    const out = await tool('clickup_search_docs').handler({ query: 'e', limit: 1, offset: 0 }, testContext())
    expect(out.count).toBe(1)
    expect(out.total).toBe(2)
    expect(out.has_more).toBe(true)
    expect(out.next_offset).toBe(1)
  })

  it('renders matches with name and id', async () => {
    mswServer.use(...fx.searchDocsHandlers())
    const out = await tool('clickup_search_docs').handler({ query: 'guide', limit: 10, offset: 0 }, testContext())
    const md = tool('clickup_search_docs').render(out, testContext())
    expect(md).toContain('Onboarding Guide (d-2)')
  })
})

describe('clickup_read_doc', () => {
  it('lists pages when no page_id is given rather than dumping the whole doc', async () => {
    mswServer.use(...fx.docPagesHandlers())
    const out = await tool('clickup_read_doc').handler({ doc_id: 'd-1' }, testContext())
    expect(out.mode).toBe('pages')
    expect(out.pages).toEqual([
      { id: 'p-1', name: 'Architecture' },
      { id: 'p-big', name: 'Appendix' },
    ])
    const md = tool('clickup_read_doc').render(out, testContext())
    expect(md).toContain('Pages in')
    expect(md).toContain('Architecture (p-1)')
  })

  it('never renders page content while listing pages', async () => {
    mswServer.use(...fx.docPagesHandlers())
    const out = await tool('clickup_read_doc').handler({ doc_id: 'd-1' }, testContext())
    const md = tool('clickup_read_doc').render(out, testContext())
    expect(md).not.toContain('The system is layered')
  })

  it('states plainly when a doc has no pages, naming the doc', async () => {
    mswServer.use(...fx.emptyDocPagesHandlers('d-2'))
    const out = await tool('clickup_read_doc').handler({ doc_id: 'd-2' }, testContext())
    const md = tool('clickup_read_doc').render(out, testContext())
    expect(md).toBe('Doc d-2 has no pages.')
  })

  it('returns page content when a page_id is given', async () => {
    mswServer.use(...fx.docPageHandlers())
    const out = await tool('clickup_read_doc').handler({ doc_id: 'd-1', page_id: 'p-1' }, testContext())
    expect(out.mode).toBe('content')
    expect(out.page_id).toBe('p-1')
    const md = tool('clickup_read_doc').render(out, testContext())
    expect(md).toContain('The system is layered')
  })

  it('announces truncation of an oversized page and names the remedy', async () => {
    mswServer.use(...fx.docPageHandlers())
    const out = await tool('clickup_read_doc').handler({ doc_id: 'd-1', page_id: 'p-big' }, testContext())
    const md = tool('clickup_read_doc').render(out, testContext({ maxResponseChars: 500 }))
    expect(md).toContain('Response truncated')
    expect(md.length).toBeLessThan(600)
  })

  it('does not truncate a page that fits within the response budget', async () => {
    mswServer.use(...fx.docPageHandlers())
    const out = await tool('clickup_read_doc').handler({ doc_id: 'd-1', page_id: 'p-1' }, testContext())
    const md = tool('clickup_read_doc').render(out, testContext())
    expect(md).not.toContain('Response truncated')
  })
})
