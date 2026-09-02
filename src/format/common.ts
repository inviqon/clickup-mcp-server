/**
 * Response envelope, truncation and markdown primitives shared by every
 * renderer in the server.
 *
 * `omitEmpty` and `bulletList` exist so that omitting a missing value is the
 * path of least resistance: no renderer downstream has to remember the rule
 * that a missing value is left out of output, never rendered as N/A, null,
 * or a guessed default. `truncateResponse` exists so that truncation is
 * always visible: an agent can never mistake a truncated list for a
 * complete one.
 */

export type Page<T> = {
  total: number
  count: number
  offset: number
  items: T[]
  has_more: boolean
  next_offset?: number
}

export type PaginateOptions = {
  offset: number
  limit: number
  total?: number | undefined
}

/**
 * Slices `items` into one page starting at `offset` for up to `limit`
 * entries. `total` defaults to `items.length`, but an explicit `total` wins:
 * that covers the case where the caller only holds one upstream page and
 * knows the true total from elsewhere (e.g. the API's own pagination
 * metadata). `next_offset` is present only when there is more to fetch, and
 * is genuinely absent (not set to `undefined`) otherwise, so JSON output
 * does not carry a stray `"next_offset": null`-like key.
 */
export function paginate<T>(items: T[], opts: PaginateOptions): Page<T> {
  const { offset, limit } = opts
  const pageItems = items.slice(offset, offset + limit)
  const total = opts.total ?? items.length
  const count = pageItems.length
  const hasMore = total > offset + count

  const page: Page<T> = {
    total,
    count,
    offset,
    items: pageItems,
    has_more: hasMore,
  }
  if (hasMore) {
    page.next_offset = offset + count
  }
  return page
}

export type TruncateOptions = {
  maxChars: number
  /**
   * How many items were left out. Omitted when the response is not a list
   * of items, or when the cut fell inside one - in which case the notice
   * says the response was truncated without claiming a count it cannot
   * know. It must never be the TOTAL item count: the notice used to read
   * "showing a partial result of N item(s)" with N as the total, which an
   * agent reads as "N items are here".
   */
  droppedItems?: number | undefined
  /**
   * What the caller should do to retrieve the rest, naming the parameter -
   * `offset`, `limit` - rather than a vague suggestion, per spec section 6.
   */
  retryHint: string
}

/**
 * The notice appended to any truncated response. Exported so a caller that
 * fits whole items into the budget (src/server.ts) can size the body around
 * the exact notice it will append, rather than guessing at its length.
 */
export function truncationNotice(opts: { droppedItems?: number | undefined; retryHint: string }): string {
  const dropped =
    opts.droppedItems !== undefined && opts.droppedItems > 0
      ? `${opts.droppedItems} item(s) not shown. `
      : ''
  return `\n\n[Response truncated to the character budget. ${dropped}${opts.retryHint}]`
}

/**
 * Returns `text` unchanged when it fits within `maxChars`. Otherwise cuts it
 * down and appends a notice that names what happened and how to get the
 * rest, so a truncated response can never be mistaken for a complete one.
 */
export function truncateResponse(text: string, opts: TruncateOptions): string {
  if (text.length <= opts.maxChars) {
    return text
  }
  const notice = truncationNotice(opts)
  const budgetForBody = Math.max(0, opts.maxChars - notice.length)
  return text.slice(0, budgetForBody) + notice
}

/**
 * Renders "Name (id)" with the id verbatim, the standard way entities are
 * named in tool output so an agent has both a human label and the exact id
 * to pass back in a follow-up call.
 */
export function nameWithId(name: string, id: string): string {
  return `${name} (${id})`
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/**
 * Drops keys whose value is `undefined`, `null` or an empty string, and
 * keeps everything else -- including `false` and `0`. That distinction is
 * the whole point: a falsy-but-real value is data, and dropping it would be
 * the same class of bug as inventing a placeholder for a missing one.
 */
export function omitEmpty<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {}
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key]
    if (!isEmpty(value)) {
      result[key] = value
    }
  }
  return result
}

/**
 * The write-body counterpart to `omitEmpty`: drops `undefined` and `null`,
 * but KEEPS an explicit empty string.
 *
 * The distinction is the whole reason this exists separately. In rendering,
 * `''` and "absent" mean the same thing and dropping both is correct. In a
 * request body they are opposite instructions: not passing `description` is
 * "leave it alone", passing `description: ""` is "clear it". Building write
 * bodies through `omitEmpty` collapsed the two, so
 * `clickup_update_task({description: "", description_mode: "overwrite"})`,
 * `clickup_update_list({content: ""})`, `clickup_update_time_entry({description: ""})`
 * and `clickup_stop_timer({description: ""})` each dropped the field, left
 * the old value in place, and reported success - the caller believed the
 * value was cleared and nothing said otherwise. This is the same defect the
 * team already fixed for tags (see the comment in `clickup_stop_timer`,
 * src/tools/time.ts), applied to the shared helper rather than one call
 * site.
 */
export function omitUnset<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {}
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key]
    if (value !== undefined && value !== null) {
      result[key] = value
    }
  }
  return result
}

/**
 * Renders `[label, value]` pairs as markdown bullets, skipping any entry
 * whose value is `undefined` rather than printing a placeholder for it.
 */
export function bulletList(entries: Array<[string, string | undefined]>): string[] {
  const lines: string[] = []
  for (const [label, value] of entries) {
    if (value !== undefined) {
      lines.push(`- **${label}**: ${value}`)
    }
  }
  return lines
}
