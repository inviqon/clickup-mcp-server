import { http, HttpResponse } from 'msw'

/**
 * Literal ClickUp response payloads for the comment tools, field-shaped
 * against ClickUp's own OpenAPI specification and reference pages
 * (developer.clickup.com/docs/open-api-spec.md, and the .md reference pages
 * for GET task comments, POST task comment and PUT comment).
 */

const API = 'https://api.clickup.com/api'

export const TASK_ID = '86abc'
export const COMMENT_ID = '90010'

/**
 * GET /v2/task/86abc/comment. `1568036964079` (2019-09-09T16:29:24Z) falls
 * in Berlin's summer (CEST, +02:00) offset - the point exercised by the
 * "renders ... with offset" test, not the specific date.
 */
export function commentsHandlers(opts: { empty?: boolean } = {}) {
  const comments = opts.empty
    ? []
    : [
        {
          id: 'c1',
          comment: [{ text: 'Looks good to me.' }],
          comment_text: 'Looks good to me.',
          user: { id: 2, username: 'Bob Baker', email: 'bob@example.com', initials: 'BB', color: '#FC575E', profilePicture: null },
          resolved: false,
          date: '1568036964079',
          reactions: [],
          reply_count: '0',
        },
      ]
  return [http.get(`${API}/v2/task/${TASK_ID}/comment`, () => HttpResponse.json({ comments }))]
}

/**
 * POST /v2/task/86abc/comment - ClickUp's own minimal acknowledgement
 * response (id, hist_id, date), never a full comment object.
 */
export function createCommentHandlers() {
  return [
    http.post(`${API}/v2/task/${TASK_ID}/comment`, () =>
      HttpResponse.json({ id: COMMENT_ID, hist_id: 'hist-1', date: 1568036964079 }),
    ),
  ]
}

/**
 * PUT /v2/comment/90010. `onBody` receives exactly what this server sent,
 * mirroring `tests/fixtures/tasks.ts`'s `updateHandler` - so a test can
 * assert `resolved` is only present in the request when the caller passed
 * it.
 */
export function updateCommentHandlers(onBody?: (body: Record<string, unknown>) => void) {
  return [
    http.put(`${API}/v2/comment/${COMMENT_ID}`, async ({ request }) => {
      onBody?.((await request.json()) as Record<string, unknown>)
      return HttpResponse.json({})
    }),
  ]
}
