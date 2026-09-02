import { z } from 'zod'
import type { AnyToolDefinition, ToolDefinition } from '../core/registry.js'
import { addTaskTag, listSpaceTags, removeTaskTag } from '../clickup/endpoints/tags.js'
import { findSpaceForList, loadWorkspaceTree } from '../clickup/endpoints/workspace.js'
import { getTaskDetail } from '../clickup/endpoints/tasks.js'
import { refetchAfterWrite } from './tasks.js'
import { ClickUpUsageError } from '../core/errors.js'

// ---------------------------------------------------------------------------
// clickup_list_space_tags
// ---------------------------------------------------------------------------

const listSpaceTagsInputShape = {
  space_id: z.string().describe('ClickUp space id, e.g. "1"'),
}

const listSpaceTagsOutputShape = {
  space_id: z.string(),
  tags: z.array(z.string()),
}

export const listSpaceTagsTool: ToolDefinition<typeof listSpaceTagsInputShape, typeof listSpaceTagsOutputShape> = {
  name: 'clickup_list_space_tags',
  title: 'List ClickUp Space Tags',
  category: 'tags',
  mode: 'read',
  description: [
    'List every tag defined in a ClickUp space. Tags are space-scoped: a name that exists in one',
    'space may not exist in another, and clickup_set_task_tags rejects any tag not already on this',
    'list rather than creating one on the fly. Call this first to see what is available.',
    'Examples: "what tags exist in the Engineering space", "is there a \'blocked\' tag I can use".',
  ].join(' '),
  inputSchema: listSpaceTagsInputShape,
  outputSchema: listSpaceTagsOutputShape,
  handler: async (args, ctx) => {
    const tags = await listSpaceTags(ctx, args.space_id)
    return { space_id: args.space_id, tags: tags.map((t) => t.name) }
  },
  render: (out) => {
    if (out.tags.length === 0) {
      return `Space ${out.space_id} has no tags.`
    }
    return [`# Tags in space ${out.space_id}`, '', ...out.tags.map((t) => `- ${t}`)].join('\n')
  },
}

// ---------------------------------------------------------------------------
// clickup_set_task_tags
// ---------------------------------------------------------------------------

const setTaskTagsInputShape = {
  task_id: z.string(),
  tags: z.array(z.string()).describe('The full set of tags the task should carry afterward, replacing its current set'),
}

const setTaskTagsOutputShape = {
  task_id: z.string(),
  tags: z.array(z.string()),
}

export const setTaskTagsTool: ToolDefinition<typeof setTaskTagsInputShape, typeof setTaskTagsOutputShape> = {
  name: 'clickup_set_task_tags',
  title: 'Set ClickUp Task Tags',
  category: 'tags',
  mode: 'write',
  description: [
    'Set a task\'s tags to exactly the given set, replacing whatever it currently carries - not an',
    'add or a remove, a set. This reads the task\'s current tags and the space\'s available tags',
    'first, then issues only the add/remove calls needed to close the gap (no calls at all if the',
    'set already matches). Every requested tag must already exist in the task\'s space',
    '(clickup_list_space_tags shows what is available); an unknown tag is rejected before anything',
    'is written, naming the tags the space actually has.',
    'Examples: "tag task 86abc as blocked and urgent, remove anything else", "clear all tags from',
    'this task".',
  ].join(' '),
  inputSchema: setTaskTagsInputShape,
  outputSchema: setTaskTagsOutputShape,
  handler: async (args, ctx) => {
    const current = await getTaskDetail(ctx, args.task_id)
    const listId = current.list.id

    const tree = await loadWorkspaceTree(ctx)
    const space = findSpaceForList(tree, listId)
    if (space === undefined) {
      throw new ClickUpUsageError(
        `Could not resolve the space for task ${args.task_id} (list ${listId}) from the workspace tree. ` +
          'Call clickup_get_workspace_tree to check the list still exists in a known space.',
      )
    }

    const spaceTags = await listSpaceTags(ctx, space.id)
    const availableNames = spaceTags.map((t) => t.name)
    for (const tag of args.tags) {
      if (!availableNames.includes(tag)) {
        throw new ClickUpUsageError(`Space ${space.id} has no tag "${tag}". Available: ${availableNames.join(', ')}`)
      }
    }

    const currentNames = current.tags.map((t) => t.name)
    const toRemove = currentNames.filter((t) => !args.tags.includes(t))
    const toAdd = args.tags.filter((t) => !currentNames.includes(t))

    if (toRemove.length === 0 && toAdd.length === 0) {
      return { task_id: args.task_id, tags: currentNames }
    }

    for (const tag of toRemove) {
      await removeTaskTag(ctx, args.task_id, tag)
    }
    for (const tag of toAdd) {
      await addTaskTag(ctx, args.task_id, tag)
    }

    const refetched = await refetchAfterWrite(ctx, args.task_id, `Setting tags on task ${args.task_id}`)
    return { task_id: args.task_id, tags: refetched.tags.map((t) => t.name) }
  },
  render: (out) => {
    if (out.tags.length === 0) {
      return `Task ${out.task_id} now has no tags.`
    }
    return `Task ${out.task_id} now has tags: ${out.tags.join(', ')}`
  },
}

export const TAG_TOOLS: AnyToolDefinition[] = [listSpaceTagsTool, setTaskTagsTool] as unknown as AnyToolDefinition[]
