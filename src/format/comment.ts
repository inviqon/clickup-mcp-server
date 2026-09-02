import type { Comment } from '../clickup/schemas.js'
import { formatDate } from '../core/dates.js'

export type CommentOut = {
  id: string
  author: string
  date: string
  text: string
}

/**
 * Projects a raw `Comment` into the compact shape `clickup_get_comments`
 * returns. `date` is always formatted through `formatDate` (offset-carrying
 * ISO 8601, the same helper every other date field in this server uses),
 * never left as ClickUp's raw epoch-millisecond value - a comment's
 * timestamp is data an agent reasons about ("what did they say and when"),
 * not a display-only nicety.
 */
export function toCommentOut(comment: Comment, timezone: string): CommentOut {
  return {
    id: comment.id,
    author: comment.user.username,
    date: formatDate(Number(comment.date), timezone),
    text: comment.comment_text,
  }
}

/**
 * Renders a task's comments, or says explicitly that there are none
 * (reliability rule 5 - an empty result names what produced it, here the
 * task itself) rather than an unexplained empty section.
 */
export function renderComments(taskId: string, comments: CommentOut[]): string {
  if (comments.length === 0) {
    return `Task ${taskId} has no comments.`
  }
  return [
    `# Comments on task ${taskId}`,
    '',
    ...comments.map((c) => `- **${c.author}** (${c.date}): ${c.text}`),
  ].join('\n')
}
