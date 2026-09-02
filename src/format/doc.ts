import { nameWithId } from './common.js'

/**
 * The shape every renderer in this file works from - a doc, or a doc page
 * listed without its content, both reduced to "id + name" since that is all
 * `clickup_search_docs` and the page-listing branch of `clickup_read_doc`
 * ever render (src/tools/docs.ts).
 */
export type NamedRef = { id: string; name: string }

/**
 * Renders a `clickup_search_docs` result. An empty match states the query
 * that produced it explicitly (reliability rule 5) rather than rendering a
 * bare, ambiguous "no results".
 */
export function renderDocSearch(query: string, items: NamedRef[]): string {
  if (items.length === 0) {
    return `No docs found matching "${query}".`
  }
  return [`# Docs matching "${query}"`, '', ...items.map((d) => `- ${nameWithId(d.name, d.id)}`)].join('\n')
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
