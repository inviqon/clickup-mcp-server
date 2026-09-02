import type { Page } from '../format/common.js'
import type { Task } from './schemas.js'

const MAX_UPSTREAM_PAGES = 5
const CLICKUP_PAGE_SIZE = 100

export type TaskPageFetchResult = {
  tasks: Task[]
  /**
   * ClickUp's own "no more pages" flag. Only the list-scoped "get tasks"
   * endpoint (`GET /v2/list/{list_id}/task`) reports this; the team-scoped
   * "get filtered team tasks" endpoint does not, so callers backed by that
   * endpoint simply never pass it - `walkTaskPages` falls back to the
   * short-page heuristic below for those.
   */
  lastPage?: boolean | undefined
}

export type WalkedTasks = {
  items: Task[]
  /**
   * True when there may be more matching tasks upstream than `items`
   * holds - either because the walk stopped early having gathered enough
   * for the caller's requested page, or because the hard page cap was hit
   * before ClickUp confirmed the end. A caller must not report an exact
   * `total` when this is true; it does not know one.
   */
  hasMoreUpstream: boolean
  /**
   * True specifically when the 5-page cap was hit before the end was
   * confirmed. This is the case that must be disclosed to the agent
   * explicitly (not just via `has_more`): far more data can exist than
   * `items` shows, and the normal has_more/next_offset pagination dance
   * will not converge on it within the cap.
   */
  truncated: boolean
}

/**
 * Walks ClickUp's page-based "get tasks" endpoints - both the list-scoped
 * and team-scoped variants take a 0-indexed `page` query parameter and cap
 * at 100 tasks per page - until either `minItems` items have been
 * gathered, the end is confirmed, or a hard cap of 5 upstream pages (500
 * tasks) is hit.
 *
 * This exists because a single upstream page is not a page of the *true*
 * result set: `paginate()` computing `total`/`has_more`/`next_offset` from
 * one 100-task page silently misreports both whenever more than 100 tasks
 * actually match, including `next_offset` pointing at data that was never
 * fetched and so comes back empty on the next call even though it exists.
 * Walking multiple upstream pages here, in the shared endpoint layer, means
 * every caller (`clickup_list_tasks`, `clickup_search_tasks`) gets an
 * envelope that is honest about what it does and does not know, without
 * re-implementing this walk itself.
 *
 * "The end is confirmed" one of two ways, since only one of ClickUp's two
 * task-list endpoints reports `lastPage`: an explicit `lastPage: true`, or
 * a page shorter than ClickUp's own page size - a partial page can only
 * mean nothing is left to fetch, true on either endpoint.
 */
export async function walkTaskPages(
  fetchPage: (page: number) => Promise<TaskPageFetchResult>,
  minItems: number,
): Promise<WalkedTasks> {
  let items: Task[] = []
  let reachedEnd = false
  let pagesFetched = 0

  for (let page = 0; page < MAX_UPSTREAM_PAGES; page++) {
    const result = await fetchPage(page)
    items = items.concat(result.tasks)
    pagesFetched++

    if (result.lastPage === true || result.tasks.length < CLICKUP_PAGE_SIZE) {
      reachedEnd = true
      break
    }
    if (items.length >= minItems) {
      break
    }
  }

  return {
    items,
    hasMoreUpstream: !reachedEnd,
    truncated: !reachedEnd && pagesFetched >= MAX_UPSTREAM_PAGES,
  }
}

/**
 * Forces `has_more`/`next_offset` to reflect upstream uncertainty that
 * `paginate()` cannot know about on its own: it only sees the items it was
 * handed, which may be a deliberately incomplete upstream fetch (see
 * `walkTaskPages`). Never overrides `has_more` from true to false - only
 * ever strengthens an optimistic "no more" into an honest "there may be
 * more, we stopped looking."
 */
export function boundPage<T>(page: Page<T>, walked: { hasMoreUpstream: boolean }): Page<T> {
  if (!walked.hasMoreUpstream || page.has_more) {
    return page
  }
  return { ...page, has_more: true, next_offset: page.offset + page.count }
}
