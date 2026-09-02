import { http, HttpResponse } from 'msw'

/**
 * Literal ClickUp v3 response payloads for the two Docs tools, field-shaped
 * against ClickUp's v3 OpenAPI specification
 * (developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml) -
 * `PublicDocsDocCoreDto` for the docs list, `PublicDocsPageV3Dto` for pages.
 * The v3 shapes differ from every other fixture file in this directory
 * (which back v2 endpoints): `workspace_id` and `creator` are numbers, `id`
 * is a string, and there is no free-text search parameter on the docs list
 * endpoint - see the comment on `SearchDocsResponseSchema`
 * (src/clickup/schemas.ts) for how `clickup_search_docs` works around that.
 */

const API = 'https://api.clickup.com/api'

export const TEAM_ID = '9007'
export const DOC_ID = 'd-1'

const CREATED_AT = 1700000000000

function docCore(id: string, name: string) {
  return {
    id,
    date_created: CREATED_AT,
    date_updated: CREATED_AT,
    name,
    type: 1,
    parent: { id: '0', type: 4 },
    public: false,
    workspace_id: Number(TEAM_ID),
    creator: 1,
    deleted: false,
    archived: false,
  }
}

function docPage(opts: { id: string; docId?: string; name: string; content: string }) {
  return {
    id: opts.id,
    doc_id: opts.docId ?? DOC_ID,
    name: opts.name,
    content: opts.content,
    content_format: 'text/md',
    workspace_id: Number(TEAM_ID),
    date_created: CREATED_AT,
    date_updated: CREATED_AT,
  }
}

/**
 * `GET /v3/workspaces/9007/docs` - two docs, "Backend Architecture" (d-1)
 * and "Onboarding Guide" (d-2), so a name-substring search on "architecture"
 * matches exactly one.
 */
export function searchDocsHandlers() {
  return [
    http.get(`${API}/v3/workspaces/${TEAM_ID}/docs`, () =>
      HttpResponse.json({
        docs: [docCore(DOC_ID, 'Backend Architecture'), docCore('d-2', 'Onboarding Guide')],
      }),
    ),
  ]
}

/**
 * `GET /v3/workspaces/9007/docs` returning exactly `DOCS_LIST_LIMIT` (100)
 * docs, none named "architecture" - exercises the cap-hit path
 * (`bounded: true`) distinctly from `searchDocsHandlers`' two-doc fixture,
 * which never hits the cap. Named "Sprint Notes N" throughout so a search
 * for "architecture" against this fixture is a genuine (if ambiguous) empty
 * match, not a fixture bug.
 */
export function fullPageDocsHandlers() {
  return [
    http.get(`${API}/v3/workspaces/${TEAM_ID}/docs`, () =>
      HttpResponse.json({
        docs: Array.from({ length: 100 }, (_, i) => docCore(`d-${i}`, `Sprint Notes ${i}`)),
      }),
    ),
  ]
}

const PAGE_CONTENT = 'The system is layered into api, core and clickup modules.'

/**
 * `GET /v3/workspaces/9007/docs/d-1/pages` - two pages: "Architecture"
 * (p-1, normal-sized content) and "Appendix" (p-big, a 20,000-character
 * page used to exercise the truncation path).
 */
export function docPagesHandlers(opts: { docId?: string } = {}) {
  const docId = opts.docId ?? DOC_ID
  return [
    http.get(`${API}/v3/workspaces/${TEAM_ID}/docs/${docId}/pages`, () =>
      HttpResponse.json([
        docPage({ id: 'p-1', docId, name: 'Architecture', content: PAGE_CONTENT }),
        docPage({ id: 'p-big', docId, name: 'Appendix', content: 'x'.repeat(20_000) }),
      ]),
    ),
  ]
}

export function emptyDocPagesHandlers(docId = 'd-2') {
  return [http.get(`${API}/v3/workspaces/${TEAM_ID}/docs/${docId}/pages`, () => HttpResponse.json([]))]
}

/**
 * `GET /v3/workspaces/9007/docs/d-1/pages/{pageId}` for both `p-1` and
 * `p-big`, matching the entries `docPagesHandlers` lists.
 */
export function docPageHandlers(opts: { docId?: string } = {}) {
  const docId = opts.docId ?? DOC_ID
  return [
    http.get(`${API}/v3/workspaces/${TEAM_ID}/docs/${docId}/pages/p-1`, () =>
      HttpResponse.json(docPage({ id: 'p-1', docId, name: 'Architecture', content: PAGE_CONTENT })),
    ),
    http.get(`${API}/v3/workspaces/${TEAM_ID}/docs/${docId}/pages/p-big`, () =>
      HttpResponse.json(docPage({ id: 'p-big', docId, name: 'Appendix', content: 'x'.repeat(20_000) })),
    ),
  ]
}
