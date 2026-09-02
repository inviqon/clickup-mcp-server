import { z } from 'zod'
import type { ClickUpContext } from '../../core/context.js'
import { GetSpaceTagsResponseSchema, type SpaceTag } from '../schemas.js'

const EmptyResponseSchema = z.object({}).passthrough()

export async function listSpaceTags(ctx: ClickUpContext, spaceId: string): Promise<SpaceTag[]> {
  const res = await ctx.client.request({
    method: 'GET',
    path: `/space/${spaceId}/tag`,
    schema: GetSpaceTagsResponseSchema,
  })
  return res.tags
}

/**
 * `POST /v2/task/{task_id}/tag/{tag_name}` - the tag name travels in the
 * path, not the body, so it is percent-encoded here rather than assuming it
 * is always URL-safe (a tag can contain spaces).
 */
export async function addTaskTag(ctx: ClickUpContext, taskId: string, tagName: string): Promise<void> {
  await ctx.client.request({
    method: 'POST',
    path: `/task/${taskId}/tag/${encodeURIComponent(tagName)}`,
    schema: EmptyResponseSchema,
  })
}

export async function removeTaskTag(ctx: ClickUpContext, taskId: string, tagName: string): Promise<void> {
  await ctx.client.request({
    method: 'DELETE',
    path: `/task/${taskId}/tag/${encodeURIComponent(tagName)}`,
    schema: EmptyResponseSchema,
  })
}
