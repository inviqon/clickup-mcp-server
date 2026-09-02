import { z } from 'zod'
import type { AnyToolDefinition, ToolDefinition } from '../core/registry.js'
import { formatDate, resolveDate } from '../core/dates.js'
import { getList } from '../clickup/endpoints/workspace.js'
import {
  createFolderRaw,
  createListInFolderRaw,
  createListInSpaceRaw,
  createSpaceRaw,
  deleteFolderRaw,
  deleteListRaw,
  deleteSpaceRaw,
  getFolderDetail,
  getSpaceDetail,
  updateFolderRaw,
  updateListRaw,
  updateSpaceRaw,
} from '../clickup/endpoints/structure.js'
import type { FolderDetail, ListWriteResponse, SpaceDetail } from '../clickup/schemas.js'
import { omitUnset, nameWithId } from '../format/common.js'
import { toAssigneeId } from './tasks.js'

/**
 * The second gate every delete tool applies on top of admin mode (Task 13):
 * deleting a space, folder or list through the API is unrecoverable, so the
 * caller must have already read the entity - and named it correctly - before
 * this server destroys it. Fetching happens, and this check runs, strictly
 * before the delete call itself; every delete tool below awaits this before
 * calling its `delete*Raw` endpoint function.
 */
function assertConfirmName(kind: string, actualName: string, confirmName: string): void {
  if (actualName !== confirmName) {
    throw new Error(`confirm_name "${confirmName}" does not match ${kind} name "${actualName}"`)
  }
}

const spaceOutputShape = {
  id: z.string(),
  name: z.string(),
  private: z.boolean().optional(),
}

function toSpaceOut(space: SpaceDetail): z.infer<z.ZodObject<typeof spaceOutputShape>> {
  const out: z.infer<z.ZodObject<typeof spaceOutputShape>> = { id: space.id, name: space.name }
  if (space.private !== undefined) {
    out.private = space.private
  }
  return out
}

function renderSpace(out: z.infer<z.ZodObject<typeof spaceOutputShape>>): string {
  const lines = [`# ${nameWithId(out.name, out.id)}`]
  if (out.private !== undefined) {
    lines.push('', `- **Private**: ${out.private ? 'yes' : 'no'}`)
  }
  return lines.join('\n')
}

const folderOutputShape = {
  id: z.string(),
  name: z.string(),
}

function toFolderOut(folder: FolderDetail): z.infer<z.ZodObject<typeof folderOutputShape>> {
  return { id: folder.id, name: folder.name }
}

function renderFolder(out: z.infer<z.ZodObject<typeof folderOutputShape>>): string {
  return `# ${nameWithId(out.name, out.id)}`
}

const listOutputShape = {
  id: z.string(),
  name: z.string(),
  content: z.string().optional(),
  due_date: z.string().optional(),
}

/**
 * `l.due_date` is ClickUp's own epoch-millisecond string (or `null`);
 * formatted through `formatDate` the same way every other date field in
 * this server is, never left as a raw millisecond string.
 */
function toListOut(list: ListWriteResponse, timezone: string): z.infer<z.ZodObject<typeof listOutputShape>> {
  const out: z.infer<z.ZodObject<typeof listOutputShape>> = { id: list.id, name: list.name }
  if (list.content !== null && list.content !== undefined && list.content !== '') {
    out.content = list.content
  }
  if (list.due_date !== null && list.due_date !== undefined) {
    out.due_date = formatDate(Number(list.due_date), timezone)
  }
  return out
}

function renderList(out: z.infer<z.ZodObject<typeof listOutputShape>>): string {
  const lines = [`# ${nameWithId(out.name, out.id)}`]
  if (out.due_date !== undefined) {
    lines.push('', `- **Due**: ${out.due_date}`)
  }
  if (out.content !== undefined) {
    lines.push('', '**Content**', out.content)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// clickup_create_space
// ---------------------------------------------------------------------------

const createSpaceInputShape = {
  name: z.string().min(1),
  private: z.boolean().default(false),
  features: z
    .object({
      time_tracking: z.boolean().optional(),
      tags: z.boolean().optional(),
      due_dates: z.boolean().optional(),
    })
    .optional(),
}

function toFeaturesBody(
  features: { time_tracking?: boolean | undefined; tags?: boolean | undefined; due_dates?: boolean | undefined } | undefined,
) {
  if (features === undefined) {
    return undefined
  }
  return omitUnset({
    time_tracking: features.time_tracking !== undefined ? { enabled: features.time_tracking } : undefined,
    tags: features.tags !== undefined ? { enabled: features.tags } : undefined,
    due_dates: features.due_dates !== undefined ? { enabled: features.due_dates } : undefined,
  })
}

export const createSpaceTool: ToolDefinition<typeof createSpaceInputShape, typeof spaceOutputShape> = {
  name: 'clickup_create_space',
  title: 'Create ClickUp Space',
  category: 'structure',
  mode: 'write',
  description: [
    'Create a new top-level space in the ClickUp workspace. features enables or disables',
    'ClickApps (time tracking, tags, due dates) on the new space at creation time; omit it to',
    'leave ClickUp\'s own defaults in place. Invalidates the cached workspace tree.',
    'Examples: "create a new space called Marketing", "make a private space for the Acme client',
    'with time tracking on".',
  ].join(' '),
  inputSchema: createSpaceInputShape,
  outputSchema: spaceOutputShape,
  handler: async (args, ctx) => {
    const body = omitUnset({
      name: args.name,
      private: args.private ?? false,
      features: toFeaturesBody(args.features),
    })
    const created = await createSpaceRaw(ctx, body)
    ctx.cache.invalidate('tree:')
    return toSpaceOut(created)
  },
  render: renderSpace,
}

// ---------------------------------------------------------------------------
// clickup_update_space
// ---------------------------------------------------------------------------

const updateSpaceInputShape = {
  space_id: z.string(),
  name: z.string().optional(),
  private: z.boolean().optional(),
}

export const updateSpaceTool: ToolDefinition<typeof updateSpaceInputShape, typeof spaceOutputShape> = {
  name: 'clickup_update_space',
  title: 'Update ClickUp Space',
  category: 'structure',
  mode: 'write',
  description: [
    'Rename a ClickUp space or change whether it is private. Only the fields you pass are changed.',
    'Invalidates the cached workspace tree so the next tree read reflects the new name.',
    'Examples: "rename space 1 to Client Work", "make space 1 private".',
  ].join(' '),
  inputSchema: updateSpaceInputShape,
  outputSchema: spaceOutputShape,
  handler: async (args, ctx) => {
    const body = omitUnset({ name: args.name, private: args.private })
    const updated = await updateSpaceRaw(ctx, args.space_id, body)
    ctx.cache.invalidate('tree:')
    return toSpaceOut(updated)
  },
  render: renderSpace,
}

// ---------------------------------------------------------------------------
// clickup_delete_space
// ---------------------------------------------------------------------------

const deleteSpaceInputShape = {
  space_id: z.string(),
  confirm_name: z.string().describe('Must exactly match the space\'s current name - read it first if unsure'),
}

const deleteSpaceOutputShape = {
  space_id: z.string(),
  deleted: z.boolean(),
}

export const deleteSpaceTool: ToolDefinition<typeof deleteSpaceInputShape, typeof deleteSpaceOutputShape> = {
  name: 'clickup_delete_space',
  title: 'Delete ClickUp Space',
  category: 'structure',
  mode: 'admin',
  description: [
    'Permanently delete a ClickUp space and everything in it (every folder, list and task). This',
    'cannot be undone. confirm_name must exactly match the space\'s current name - fetched from',
    'ClickUp and checked before anything is deleted - so a stale or guessed id cannot destroy the',
    'wrong space. Only available in admin mode.',
    'Examples: "delete space 1, I confirm its name is \'Old Client\'", "permanently remove the',
    'Sandbox space".',
  ].join(' '),
  inputSchema: deleteSpaceInputShape,
  outputSchema: deleteSpaceOutputShape,
  handler: async (args, ctx) => {
    const space = await getSpaceDetail(ctx, args.space_id)
    assertConfirmName('space', space.name, args.confirm_name)
    await deleteSpaceRaw(ctx, args.space_id)
    ctx.cache.invalidate('tree:')
    return { space_id: args.space_id, deleted: true }
  },
  render: (out) => `Space ${out.space_id} deleted.`,
}

// ---------------------------------------------------------------------------
// clickup_create_folder
// ---------------------------------------------------------------------------

const createFolderInputShape = {
  space_id: z.string(),
  name: z.string().min(1),
}

export const createFolderTool: ToolDefinition<typeof createFolderInputShape, typeof folderOutputShape> = {
  name: 'clickup_create_folder',
  title: 'Create ClickUp Folder',
  category: 'structure',
  mode: 'write',
  description: [
    'Create a new folder in a ClickUp space, to group related lists together. Invalidates the',
    'cached workspace tree.',
    'Examples: "create a folder called Sprints in space 1", "add a Q3 Planning folder to the',
    'Marketing space".',
  ].join(' '),
  inputSchema: createFolderInputShape,
  outputSchema: folderOutputShape,
  handler: async (args, ctx) => {
    const created = await createFolderRaw(ctx, args.space_id, { name: args.name })
    ctx.cache.invalidate('tree:')
    return toFolderOut(created)
  },
  render: renderFolder,
}

// ---------------------------------------------------------------------------
// clickup_update_folder
// ---------------------------------------------------------------------------

const updateFolderInputShape = {
  folder_id: z.string(),
  name: z.string().min(1),
}

export const updateFolderTool: ToolDefinition<typeof updateFolderInputShape, typeof folderOutputShape> = {
  name: 'clickup_update_folder',
  title: 'Update ClickUp Folder',
  category: 'structure',
  mode: 'write',
  description: [
    'Rename a ClickUp folder. ClickUp\'s own update-folder endpoint only renames - it does not move',
    'a folder between spaces. Invalidates the cached workspace tree.',
    'Examples: "rename folder 10 to Q4 Sprints", "call this folder Archive".',
  ].join(' '),
  inputSchema: updateFolderInputShape,
  outputSchema: folderOutputShape,
  handler: async (args, ctx) => {
    const updated = await updateFolderRaw(ctx, args.folder_id, { name: args.name })
    ctx.cache.invalidate('tree:')
    return toFolderOut(updated)
  },
  render: renderFolder,
}

// ---------------------------------------------------------------------------
// clickup_delete_folder
// ---------------------------------------------------------------------------

const deleteFolderInputShape = {
  folder_id: z.string(),
  confirm_name: z.string().describe('Must exactly match the folder\'s current name - read it first if unsure'),
}

const deleteFolderOutputShape = {
  folder_id: z.string(),
  deleted: z.boolean(),
}

export const deleteFolderTool: ToolDefinition<typeof deleteFolderInputShape, typeof deleteFolderOutputShape> = {
  name: 'clickup_delete_folder',
  title: 'Delete ClickUp Folder',
  category: 'structure',
  mode: 'admin',
  description: [
    'Permanently delete a ClickUp folder and every list and task inside it. This cannot be undone.',
    'confirm_name must exactly match the folder\'s current name - fetched from ClickUp and checked',
    'before anything is deleted. Only available in admin mode.',
    'Examples: "delete folder 10, I confirm its name is \'Old Sprints\'", "remove the empty Archive',
    'folder".',
  ].join(' '),
  inputSchema: deleteFolderInputShape,
  outputSchema: deleteFolderOutputShape,
  handler: async (args, ctx) => {
    const folder = await getFolderDetail(ctx, args.folder_id)
    assertConfirmName('folder', folder.name, args.confirm_name)
    await deleteFolderRaw(ctx, args.folder_id)
    ctx.cache.invalidate('tree:')
    return { folder_id: args.folder_id, deleted: true }
  },
  render: (out) => `Folder ${out.folder_id} deleted.`,
}

// ---------------------------------------------------------------------------
// clickup_create_list
// ---------------------------------------------------------------------------

const createListInputShape = {
  name: z.string().min(1),
  folder_id: z.string().optional().describe('Create the list inside this folder. Provide this or space_id, not both.'),
  space_id: z.string().optional().describe('Create the list directly in this space (no folder). Provide this or folder_id, not both.'),
  content: z.string().optional(),
  due_date: z.string().optional().describe('Natural language or ISO date, e.g. "next friday"'),
  assignee: z.string().optional().describe('User id to set as the list owner; resolve with clickup_resolve_member'),
}

function assertExactlyOneListParent(args: { folder_id?: string | undefined; space_id?: string | undefined }): void {
  if (args.folder_id === undefined && args.space_id === undefined) {
    throw new Error(
      'clickup_create_list needs exactly one of folder_id or space_id to know where to create the list. ' +
        'Provide either folder_id or space_id.',
    )
  }
  if (args.folder_id !== undefined && args.space_id !== undefined) {
    throw new Error(
      `clickup_create_list needs exactly one of folder_id or space_id, not both. Got folder_id "${args.folder_id}" ` +
        `and space_id "${args.space_id}". Drop whichever one you did not mean.`,
    )
  }
}

export const createListTool: ToolDefinition<typeof createListInputShape, typeof listOutputShape> = {
  name: 'clickup_create_list',
  title: 'Create ClickUp List',
  category: 'structure',
  mode: 'write',
  description: [
    'Create a new list, either inside a folder (folder_id) or directly in a space with no folder',
    '(space_id) - requires exactly one of the two, never neither and never both. Invalidates the',
    'cached workspace tree.',
    'Examples: "create a list called Backlog in folder 10", "add a folderless list \'Ideas\' to',
    'space 1 due next friday".',
  ].join(' '),
  inputSchema: createListInputShape,
  outputSchema: listOutputShape,
  handler: async (args, ctx) => {
    assertExactlyOneListParent(args)

    const body = omitUnset({
      name: args.name,
      content: args.content,
      due_date: args.due_date !== undefined ? resolveDate(args.due_date, { timezone: ctx.timezone }).epochMs : undefined,
      assignee: args.assignee !== undefined ? toAssigneeId(args.assignee) : undefined,
    })

    const created =
      args.folder_id !== undefined
        ? await createListInFolderRaw(ctx, args.folder_id, body)
        : await createListInSpaceRaw(ctx, args.space_id as string, body)

    ctx.cache.invalidate('tree:')
    return toListOut(created, ctx.timezone)
  },
  render: renderList,
}

// ---------------------------------------------------------------------------
// clickup_update_list
// ---------------------------------------------------------------------------

const updateListInputShape = {
  list_id: z.string(),
  name: z.string().optional(),
  content: z.string().optional(),
  status: z.string().optional().describe('The list\'s own color status, not a task status'),
}

export const updateListTool: ToolDefinition<typeof updateListInputShape, typeof listOutputShape> = {
  name: 'clickup_update_list',
  title: 'Update ClickUp List',
  category: 'structure',
  mode: 'write',
  description: [
    'Update a ClickUp list\'s name, description (content) or its own color status (not a task',
    'status - that is set per task, not per list). Only the fields you pass are changed.',
    'Invalidates the cached workspace tree and this list\'s own cached metadata.',
    'Examples: "rename list 100 to Sprint 2", "update the description on the Backlog list".',
  ].join(' '),
  inputSchema: updateListInputShape,
  outputSchema: listOutputShape,
  handler: async (args, ctx) => {
    const body = omitUnset({ name: args.name, content: args.content, status: args.status })
    const updated = await updateListRaw(ctx, args.list_id, body)
    ctx.cache.invalidate('tree:')
    ctx.cache.invalidate(`list:${args.list_id}`)
    return toListOut(updated, ctx.timezone)
  },
  render: renderList,
}

// ---------------------------------------------------------------------------
// clickup_delete_list
// ---------------------------------------------------------------------------

const deleteListInputShape = {
  list_id: z.string(),
  confirm_name: z.string().describe('Must exactly match the list\'s current name - read it first if unsure'),
}

const deleteListOutputShape = {
  list_id: z.string(),
  deleted: z.boolean(),
}

export const deleteListTool: ToolDefinition<typeof deleteListInputShape, typeof deleteListOutputShape> = {
  name: 'clickup_delete_list',
  title: 'Delete ClickUp List',
  category: 'structure',
  mode: 'admin',
  description: [
    'Permanently delete a ClickUp list and every task in it. This cannot be undone. confirm_name',
    'must exactly match the list\'s current name - fetched from ClickUp and checked before anything',
    'is deleted. Only available in admin mode.',
    'Examples: "delete list 100, I confirm its name is \'Old Sprint\'", "remove the empty Ideas',
    'list".',
  ].join(' '),
  inputSchema: deleteListInputShape,
  outputSchema: deleteListOutputShape,
  handler: async (args, ctx) => {
    const list = await getList(ctx, args.list_id)
    assertConfirmName('list', list.name, args.confirm_name)
    await deleteListRaw(ctx, args.list_id)
    ctx.cache.invalidate('tree:')
    ctx.cache.invalidate(`list:${args.list_id}`)
    return { list_id: args.list_id, deleted: true }
  },
  render: (out) => `List ${out.list_id} deleted.`,
}

export const STRUCTURE_TOOLS: AnyToolDefinition[] = [
  createSpaceTool,
  updateSpaceTool,
  deleteSpaceTool,
  createFolderTool,
  updateFolderTool,
  deleteFolderTool,
  createListTool,
  updateListTool,
  deleteListTool,
] as unknown as AnyToolDefinition[]
