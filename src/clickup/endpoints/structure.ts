import type { ClickUpContext } from '../../core/context.js'
import {
  EmptyResponseSchema,
  FolderDetailSchema,
  ListWriteResponseSchema,
  SpaceDetailSchema,
  type FolderDetail,
  type ListWriteResponse,
  type SpaceDetail,
} from '../schemas.js'

// -- Space ---------------------------------------------------------------

export function getSpaceDetail(ctx: ClickUpContext, spaceId: string): Promise<SpaceDetail> {
  return ctx.client.request({
    method: 'GET',
    path: `/space/${spaceId}`,
    schema: SpaceDetailSchema,
  })
}

export function createSpaceRaw(ctx: ClickUpContext, body: Record<string, unknown>): Promise<SpaceDetail> {
  return ctx.client.request({
    method: 'POST',
    path: `/team/${ctx.teamId}/space`,
    schema: SpaceDetailSchema,
    body,
  })
}

export function updateSpaceRaw(ctx: ClickUpContext, spaceId: string, body: Record<string, unknown>): Promise<SpaceDetail> {
  return ctx.client.request({
    method: 'PUT',
    path: `/space/${spaceId}`,
    schema: SpaceDetailSchema,
    body,
  })
}

export async function deleteSpaceRaw(ctx: ClickUpContext, spaceId: string): Promise<void> {
  await ctx.client.request({
    method: 'DELETE',
    path: `/space/${spaceId}`,
    schema: EmptyResponseSchema,
  })
}

// -- Folder ----------------------------------------------------------------

export function getFolderDetail(ctx: ClickUpContext, folderId: string): Promise<FolderDetail> {
  return ctx.client.request({
    method: 'GET',
    path: `/folder/${folderId}`,
    schema: FolderDetailSchema,
  })
}

export function createFolderRaw(ctx: ClickUpContext, spaceId: string, body: Record<string, unknown>): Promise<FolderDetail> {
  return ctx.client.request({
    method: 'POST',
    path: `/space/${spaceId}/folder`,
    schema: FolderDetailSchema,
    body,
  })
}

export function updateFolderRaw(ctx: ClickUpContext, folderId: string, body: Record<string, unknown>): Promise<FolderDetail> {
  return ctx.client.request({
    method: 'PUT',
    path: `/folder/${folderId}`,
    schema: FolderDetailSchema,
    body,
  })
}

export async function deleteFolderRaw(ctx: ClickUpContext, folderId: string): Promise<void> {
  await ctx.client.request({
    method: 'DELETE',
    path: `/folder/${folderId}`,
    schema: EmptyResponseSchema,
  })
}

// -- List --------------------------------------------------------------------

/**
 * `POST /v2/folder/{folder_id}/list` - a list created inside a folder.
 * `createListInSpaceRaw` below is its folderless sibling; `clickup_create_list`
 * picks between the two based on which of `folder_id`/`space_id` it was
 * given, since ClickUp has no single "create a list" endpoint that takes
 * either.
 */
export function createListInFolderRaw(
  ctx: ClickUpContext,
  folderId: string,
  body: Record<string, unknown>,
): Promise<ListWriteResponse> {
  return ctx.client.request({
    method: 'POST',
    path: `/folder/${folderId}/list`,
    schema: ListWriteResponseSchema,
    body,
  })
}

export function createListInSpaceRaw(
  ctx: ClickUpContext,
  spaceId: string,
  body: Record<string, unknown>,
): Promise<ListWriteResponse> {
  return ctx.client.request({
    method: 'POST',
    path: `/space/${spaceId}/list`,
    schema: ListWriteResponseSchema,
    body,
  })
}

export function updateListRaw(ctx: ClickUpContext, listId: string, body: Record<string, unknown>): Promise<ListWriteResponse> {
  return ctx.client.request({
    method: 'PUT',
    path: `/list/${listId}`,
    schema: ListWriteResponseSchema,
    body,
  })
}

export async function deleteListRaw(ctx: ClickUpContext, listId: string): Promise<void> {
  await ctx.client.request({
    method: 'DELETE',
    path: `/list/${listId}`,
    schema: EmptyResponseSchema,
  })
}
