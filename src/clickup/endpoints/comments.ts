import type { ClickUpContext } from '../../core/context.js'
import { CreateCommentResponseSchema, EmptyResponseSchema } from '../schemas.js'

/**
 * Reading a task's comments (`GET /task/{id}/comment`) lives in
 * `./tasks.js` as `getTaskComments`, not here - it is shared by
 * `clickup_get_comments` (this file's own tool, src/tools/comments.ts) and
 * `clickup_get_task`'s `include_comments` option, and a second copy of it
 * used to live in this file until it silently diverged from that one on
 * whether `date` was declared at all. One function, imported by both
 * callers, is what keeps that from happening again.
 */

export type CreateCommentResult = { id: string; hist_id: string; date: string | number }

/**
 * `body` is a plain `Record<string, unknown>`, not a typed `CreateCommentBody`
 * - the same choice `createTaskRaw` (src/clickup/endpoints/tasks.ts) makes,
 * and for the same reason: the caller builds this via `omitEmpty`, whose
 * `Partial<T>` result is incompatible with a stricter type under
 * `exactOptionalPropertyTypes`.
 */
export async function createComment(
  ctx: ClickUpContext,
  taskId: string,
  body: Record<string, unknown>,
): Promise<CreateCommentResult> {
  const created = await ctx.client.request({
    method: 'POST',
    path: `/task/${taskId}/comment`,
    schema: CreateCommentResponseSchema,
    body,
  })

  // ClickUp returns `id` and `hist_id` as JSON numbers here, while every
  // other place this server reads a comment id back reports a string (see
  // `CreateCommentResponseSchema`). Normalising at this boundary keeps
  // `CreateCommentResult.id` a plain string, so the tool's output schema
  // and its rendered line stay unchanged whichever shape arrives.
  return { id: String(created.id), hist_id: String(created.hist_id), date: created.date }
}

/**
 * `PUT /v2/comment/{comment_id}` returns an empty body on success - unlike
 * `createComment` above, whose `POST /task/{id}/comment` response carries
 * `{id, hist_id, date}` rather than nothing. There is no "get one comment
 * by id" endpoint in ClickUp's API, so unlike a task write there is
 * nothing to re-fetch here; `clickup_update_comment` reports success by id
 * alone rather than inventing a confirmation read that does not exist.
 */
export async function updateComment(ctx: ClickUpContext, commentId: string, body: Record<string, unknown>): Promise<void> {
  await ctx.client.request({
    method: 'PUT',
    path: `/comment/${commentId}`,
    schema: EmptyResponseSchema,
    body,
  })
}
