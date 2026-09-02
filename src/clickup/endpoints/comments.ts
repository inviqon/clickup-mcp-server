import { z } from 'zod'
import type { ClickUpContext } from '../../core/context.js'
import { CreateCommentResponseSchema, GetCommentsResponseSchema, type Comment } from '../schemas.js'

const EmptyResponseSchema = z.object({}).passthrough()

export async function getComments(ctx: ClickUpContext, taskId: string): Promise<Comment[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/task/${taskId}/comment`,
    schema: GetCommentsResponseSchema,
  })
  return res.comments
}

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
 * `PUT /v2/comment/{comment_id}` returns an empty body on success - see
 * `CreateCommentResponseSchema`'s doc comment in schemas.ts for the same
 * shape on the create side. There is no "get one comment by id" endpoint in
 * ClickUp's API, so unlike a task write there is nothing to re-fetch here;
 * `clickup_update_comment` reports success by id alone rather than
 * inventing a confirmation read that does not exist.
 */
export async function updateComment(ctx: ClickUpContext, commentId: string, body: Record<string, unknown>): Promise<void> {
  await ctx.client.request({
    method: 'PUT',
    path: `/comment/${commentId}`,
    schema: EmptyResponseSchema,
    body,
  })
}
