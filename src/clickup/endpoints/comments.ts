import { z } from 'zod'
import type { ClickUpContext } from '../../core/context.js'
import { CreateCommentResponseSchema } from '../schemas.js'

const EmptyResponseSchema = z.object({}).passthrough()

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
export function createComment(
  ctx: ClickUpContext,
  taskId: string,
  body: Record<string, unknown>,
): Promise<CreateCommentResult> {
  return ctx.client.request({
    method: 'POST',
    path: `/task/${taskId}/comment`,
    schema: CreateCommentResponseSchema,
    body,
  })
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
