import { nameWithId } from './common.js'

/**
 * The shape every renderer in this file works from - a doc, or a doc page
 * listed without its content, both reduced to "id + name" since that is all
 * `clickup_search_docs` and the page-listing branch of `clickup_read_doc`
 * ever render (src/tools/docs.ts).
 */
export type NamedRef = { id: string; name: string }

/**
 * The note appended to a `clickup_search_docs` result - empty or not - when
 * `listDocsRaw` (src/clickup/endpoints/docs.ts) came back with exactly
 * `DOCS_LIST_LIMIT` docs, ClickUp's own page-size cap. That count is
 * genuinely ambiguous on its own: it means either "the workspace has
 * exactly 100 docs" or "there are more we never saw", and this project has
 * already fixed the same defect class twice (`clickup_list_tasks`'s and
 * `clickup_get_my_day`'s own `bounded` notes) - a cap being silently
 * indistinguishable from a true result is not acceptable here either,
 * least of all on the empty-match path, where it looks exactly like "this
 * doc does not exist".
 */
function docsBoundedNote(): string {
  return (
    'Only the workspace\'s first 100 docs were searched - ClickUp\'s Docs API has no server-side name filter to ' +
    'page further with, so a match beyond that would not be found here. If you know the doc\'s id, ' +
    'clickup_read_doc works regardless of this limit.'
  )
}

/**
 * Renders a `clickup_search_docs` result. An empty match states the query
 * that produced it explicitly (reliability rule 5) rather than rendering a
 * bare, ambiguous "no results" - and, when the cap was hit, says so on
 * BOTH the empty and non-empty paths, since a capped empty result and a
 * genuine empty result must not read alike.
 */
export function renderDocSearch(query: string, items: NamedRef[], bounded = false): string {
  if (items.length === 0) {
    const notice = `No docs found matching "${query}".`
    return bounded ? `${notice} ${docsBoundedNote()}` : notice
  }
  const lines = [`# Docs matching "${query}"`, '', ...items.map((d) => `- ${nameWithId(d.name, d.id)}`)]
  if (bounded) {
    lines.push('', docsBoundedNote())
  }
  return lines.join('\n')
}

/**
 * Renders the page-listing branch of `clickup_read_doc` (no `page_id`
 * given) - names shown are the page names, listed against the doc id so an
 * agent can pass one straight back as `page_id`.
 */
export function renderDocPageList(docId: string, pages: NamedRef[]): string {
  if (pages.length === 0) {
    return `Doc ${docId} has no pages.`
  }
  return [`# Pages in doc ${docId}`, '', ...pages.map((p) => `- ${nameWithId(p.name, p.id)}`)].join('\n')
}

/**
 * Renders one page's content, the `page_id`-given branch of
 * `clickup_read_doc`. `content` genuinely can be an empty page, which is
 * stated rather than rendered as a blank block.
 */
export function renderDocPageContent(docId: string, page: { id: string; name: string; content?: string | undefined }): string {
  const lines = [`# ${nameWithId(page.name, page.id)}`, `Doc: ${docId}`, '']
  lines.push(page.content !== undefined && page.content.length > 0 ? page.content : '(This page has no content.)')
  return lines.join('\n')
}
