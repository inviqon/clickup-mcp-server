import { z } from 'zod'
import type { AnyToolDefinition, ToolDefinition } from '../core/registry.js'
import { createComment, updateComment } from '../clickup/endpoints/comments.js'
import { getTaskComments } from '../clickup/endpoints/tasks.js'
import { toAssigneeId } from './tasks.js'
import { formatDate } from '../core/dates.js'
import { omitUnset, paginate } from '../format/common.js'
import { renderComments, toCommentOut } from '../format/comment.js'

// ---------------------------------------------------------------------------
// clickup_get_comments
// ---------------------------------------------------------------------------

const getCommentsInputShape = {
  task_id: z.string().describe('ClickUp task id, e.g. "86abc"'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum comments to return, default 25, max 100'),
  offset: z.number().int().min(0).default(0).describe('Number of comments to skip'),
}

const commentOutputShape = z.object({
  id: z.string(),
  author: z.string(),
  date: z.string(),
  text: z.string(),
})

const getCommentsOutputShape = {
  task_id: z.string(),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  items: z.array(commentOutputShape),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
}

export const getCommentsTool: ToolDefinition<typeof getCommentsInputShape, typeof getCommentsOutputShape> = {
  name: 'clickup_get_comments',
  title: 'Get ClickUp Task Comments',
  category: 'comments',
  mode: 'read',
  description: [
    'List the comments on a ClickUp task, newest first, with the author, an offset-carrying',
    'timestamp and the text of each. A task with no comments is reported explicitly by id rather',
    'than as an unexplained empty list.',
    'Examples: "what did people say on task 86abc", "show me the last 5 comments on the login bug".',
  ].join(' '),
  inputSchema: getCommentsInputShape,
  outputSchema: getCommentsOutputShape,
  handler: async (args, ctx) => {
    const limit = args.limit ?? 25
    const offset = args.offset ?? 0
    const comments = await getTaskComments(ctx, args.task_id)
    const items = comments.map((c) => toCommentOut(c, ctx.timezone))
    const page = paginate(items, { offset, limit })
    return { task_id: args.task_id, ...page }
  },
  render: (out) => renderComments(out.task_id, out.items),
}

// ---------------------------------------------------------------------------
// clickup_create_comment
// ---------------------------------------------------------------------------

const createCommentInputShape = {
  task_id: z.string(),
  text: z.string().min(1),
  assignee: z.string().optional().describe('User id to assign the comment to, resolved with clickup_resolve_member'),
  notify_all: z.boolean().default(false).describe('Notify every task watcher, not just the assignee'),
}

const createCommentOutputShape = {
  id: z.string(),
  task_id: z.string(),
  date: z.string(),
}

export const createCommentTool: ToolDefinition<typeof createCommentInputShape, typeof createCommentOutputShape> = {
  name: 'clickup_create_comment',
  title: 'Create ClickUp Task Comment',
  category: 'comments',
  mode: 'write',
  description: [
    'Add a comment to a ClickUp task. ClickUp\'s own create-comment response only confirms the new',
    'comment\'s id and timestamp, not its text or author - both already known from the call that made',
    'it - so that is exactly what this returns. Set assignee to direct the comment at one person;',
    'resolve their id with clickup_resolve_member first.',
    'Examples: "comment \'blocked on design review\' on task 86abc", "leave a note for Bob on the',
    'login bug and notify everyone watching it".',
  ].join(' '),
  inputSchema: createCommentInputShape,
  outputSchema: createCommentOutputShape,
  handler: async (args, ctx) => {
    const body = omitUnset({
      comment_text: args.text,
      assignee: args.assignee !== undefined ? toAssigneeId(args.assignee) : undefined,
      notify_all: args.notify_all ?? false,
    })
    const created = await createComment(ctx, args.task_id, body)
    return { id: created.id, task_id: args.task_id, date: formatDate(Number(created.date), ctx.timezone) }
  },
  render: (out) => `Comment ${out.id} added to task ${out.task_id} at ${out.date}.`,
}

// ---------------------------------------------------------------------------
// clickup_update_comment
// ---------------------------------------------------------------------------

const updateCommentInputShape = {
  comment_id: z.string(),
  text: z.string().min(1),
  resolved: z.boolean().optional(),
}

const updateCommentOutputShape = {
  comment_id: z.string(),
  updated: z.boolean(),
}

export const updateCommentTool: ToolDefinition<typeof updateCommentInputShape, typeof updateCommentOutputShape> = {
  name: 'clickup_update_comment',
  title: 'Update ClickUp Comment',
  category: 'comments',
  mode: 'write',
  description: [
    'Change a comment\'s text and, optionally, its resolved state. ClickUp has no endpoint to read',
    'back a single comment by id, so this confirms the write by id rather than echoing a re-fetched',
    'comment that cannot be fetched.',
    'Examples: "fix a typo in comment 90010", "mark comment 90010 as resolved".',
  ].join(' '),
  inputSchema: updateCommentInputShape,
  outputSchema: updateCommentOutputShape,
  handler: async (args, ctx) => {
    const body = omitUnset({
      comment_text: args.text,
      resolved: args.resolved,
    })
    await updateComment(ctx, args.comment_id, body)
    return { comment_id: args.comment_id, updated: true }
  },
  render: (out) => `Comment ${out.comment_id} updated.`,
}

export const COMMENT_TOOLS: AnyToolDefinition[] = [
  getCommentsTool,
  createCommentTool,
  updateCommentTool,
] as unknown as AnyToolDefinition[]
