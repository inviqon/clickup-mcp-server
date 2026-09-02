import type { ClickUpContext } from '../../core/context.js'
import {
  DocPageSchema,
  GetDocPagesResponseSchema,
  SearchDocsResponseSchema,
  type Doc,
  type DocPage,
} from '../schemas.js'

/**
 * ClickUp's own v3 docs listing page size cap. `listDocsRaw` fetches a
 * single page at this size and stops - see the schema-level comment on
 * `SearchDocsResponseSchema` for why: there is no server-side free-text
 * search to page through, so `clickup_search_docs` (src/tools/docs.ts)
 * filters this one page client-side rather than walking a cursor.
 */
const DOCS_LIST_LIMIT = 100

/**
 * `GET /v3/workspaces/{teamId}/docs` - the workspace's docs, one page of up
 * to 100. A workspace with more docs than that can have a name match this
 * call never sees; that is a known limitation of this read-only v1 tool,
 * not an oversight (see `SearchDocsResponseSchema`'s comment).
 */
export async function listDocsRaw(ctx: ClickUpContext): Promise<Doc[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/workspaces/${ctx.teamId}/docs`,
    version: 'v3',
    query: { limit: DOCS_LIST_LIMIT },
    schema: SearchDocsResponseSchema,
  })
  return res.docs
}

/**
 * `GET /v3/workspaces/{teamId}/docs/{docId}/pages` - every page in a doc,
 * content included. `clickup_read_doc` (src/tools/docs.ts) reads only
 * `id`/`name` off each entry when listing rather than `page_id`, so a large
 * doc's full content never has to be rendered just to see what pages exist.
 */
export async function listDocPagesRaw(ctx: ClickUpContext, docId: string): Promise<DocPage[]> {
  return ctx.client.request({
    method: 'GET',
    path: `/workspaces/${ctx.teamId}/docs/${docId}/pages`,
    version: 'v3',
    schema: GetDocPagesResponseSchema,
  })
}

/**
 * `GET /v3/workspaces/{teamId}/docs/{docId}/pages/{pageId}` - one page,
 * with its content.
 */
export async function getDocPageRaw(ctx: ClickUpContext, docId: string, pageId: string): Promise<DocPage> {
  return ctx.client.request({
    method: 'GET',
    path: `/workspaces/${ctx.teamId}/docs/${docId}/pages/${pageId}`,
    version: 'v3',
    schema: DocPageSchema,
  })
}
