import { z } from 'zod'
import type { AnyToolDefinition, ToolDefinition } from '../core/registry.js'
import { DOCS_LIST_LIMIT, getDocPageRaw, listDocPagesRaw, listDocsRaw } from '../clickup/endpoints/docs.js'
import { omitEmpty, paginate, truncateResponse } from '../format/common.js'
import { renderDocPageContent, renderDocPageList, renderDocSearch } from '../format/doc.js'

const namedRefOutputShape = {
  id: z.string(),
  name: z.string(),
}

// ---------------------------------------------------------------------------
// clickup_search_docs
// ---------------------------------------------------------------------------

const searchDocsInputShape = {
  query: z.string().min(2),
  limit: z.number().int().min(1).max(50).default(10),
  offset: z.number().int().min(0).default(0),
}

const searchDocsOutputShape = {
  query: z.string(),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  items: z.array(z.object(namedRefOutputShape)),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
  /**
   * Present (and true) only when `listDocsRaw` came back with exactly
   * `DOCS_LIST_LIMIT` docs - ClickUp's Docs API has no free-text filter to
   * page further with (see the schema-level comment on
   * `SearchDocsResponseSchema`, src/clickup/schemas.ts), so a workspace
   * with more docs than that can have a match this search never sees. Read
   * by `renderDocSearch` (src/format/doc.ts) to say so explicitly, on both
   * the empty and non-empty render paths.
   */
  bounded: z.boolean().optional(),
}

export const searchDocsTool: ToolDefinition<typeof searchDocsInputShape, typeof searchDocsOutputShape> = {
  name: 'clickup_search_docs',
  title: 'Search ClickUp Docs',
  category: 'docs',
  mode: 'read',
  description: [
    'Search the workspace\'s Docs by name. ClickUp has no server-side free-text search for Docs, so',
    'this matches query against each doc\'s name (case-insensitive substring) over the workspace\'s',
    'first 100 docs - a workspace with more than that can have a match this does not see. Returns',
    'doc ids and names only, not content; call clickup_read_doc with a doc_id to see its pages.',
    'Examples: "find the doc about onboarding", "is there a Docs page called Architecture".',
  ].join(' '),
  inputSchema: searchDocsInputShape,
  outputSchema: searchDocsOutputShape,
  handler: async (args, ctx) => {
    const docs = await listDocsRaw(ctx)
    const needle = args.query.toLowerCase()
    const matched = docs.filter((d) => d.name.toLowerCase().includes(needle)).map((d) => ({ id: d.id, name: d.name }))
    const page = paginate(matched, { offset: args.offset, limit: args.limit })
    const bounded = docs.length === DOCS_LIST_LIMIT
    return { query: args.query, ...page, ...(bounded ? { bounded: true } : {}) }
  },
  render: (out) => renderDocSearch(out.query, out.items, out.bounded ?? false),
}

// ---------------------------------------------------------------------------
// clickup_read_doc
// ---------------------------------------------------------------------------

const readDocInputShape = {
  doc_id: z.string(),
  page_id: z.string().optional().describe('Omit to list the doc\'s pages instead of dumping its full content'),
}

const readDocOutputShape = {
  doc_id: z.string(),
  mode: z.enum(['pages', 'content']),
  pages: z.array(z.object(namedRefOutputShape)).optional(),
  page_id: z.string().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
}

const TRUNCATION_RETRY_HINT = 'Read this page directly in ClickUp, or raise CLICKUP_MAX_RESPONSE_CHARS.'

export const readDocTool: ToolDefinition<typeof readDocInputShape, typeof readDocOutputShape> = {
  name: 'clickup_read_doc',
  title: 'Read ClickUp Doc',
  category: 'docs',
  mode: 'read',
  description: [
    'Read a ClickUp Doc. Without page_id, lists the doc\'s pages (name and id) rather than dumping',
    'the whole doc - a Doc can be very large, and you usually want one page, not all of them. Pass',
    'page_id (from that listing, or from clickup_search_docs) to get that one page\'s content. An',
    'oversized page is truncated with a visible notice rather than silently cut off.',
    'Examples: "what pages does the Architecture doc have", "read the Overview page of doc d-1".',
  ].join(' '),
  inputSchema: readDocInputShape,
  outputSchema: readDocOutputShape,
  handler: async (args, ctx) => {
    if (args.page_id === undefined) {
      const pages = await listDocPagesRaw(ctx, args.doc_id)
      return {
        doc_id: args.doc_id,
        mode: 'pages' as const,
        pages: pages.map((p) => ({ id: p.id, name: p.name })),
      }
    }

    const page = await getDocPageRaw(ctx, args.doc_id, args.page_id)
    return {
      doc_id: args.doc_id,
      mode: 'content' as const,
      page_id: page.id,
      name: page.name,
      ...omitEmpty({ content: page.content }),
    }
  },
  render: (out, ctx) => {
    if (out.mode === 'pages') {
      return renderDocPageList(out.doc_id, out.pages ?? [])
    }
    const rendered = renderDocPageContent(out.doc_id, {
      id: out.page_id ?? '',
      name: out.name ?? '',
      content: out.content,
    })
    return truncateResponse(rendered, {
      maxChars: ctx.maxResponseChars,
      itemCount: 1,
      retryHint: TRUNCATION_RETRY_HINT,
    })
  },
}

export const DOC_TOOLS: AnyToolDefinition[] = [searchDocsTool, readDocTool] as unknown as AnyToolDefinition[]
