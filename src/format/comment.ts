import type { TaskComment } from '../clickup/schemas.js'
import { formatDate } from '../core/dates.js'

export type CommentOut = {
  id: string
  author: string
  date: string
  text: string
}

/**
 * Projects a raw `TaskComment` (the single comment schema shared by
 * `clickup_get_comments` and `clickup_get_task`'s `include_comments` option
 * - see `TaskCommentSchema`'s doc comment in schemas.ts) into the compact
 * shape both tools return. `date` is always formatted through `formatDate`
 * (offset-carrying ISO 8601, the same helper every other date field in this
 * server uses), never left as ClickUp's raw epoch-millisecond value - a
 * comment's timestamp is data an agent reasons about ("what did they say
 * and when"), not a display-only nicety.
 */
export function toCommentOut(comment: TaskComment, timezone: string): CommentOut {
  return {
    id: comment.id,
    author: comment.user.username,
    date: formatCommentDate(comment.date, timezone),
    text: comment.comment_text,
  }
}

/**
 * The one place a ClickUp comment timestamp becomes a string. ClickUp
 * reports it as an epoch-millisecond string on the list-comments shape and
 * as a genuine integer on the create-comment response, so both are accepted
 * here rather than assumed to agree. `clickup_create_comment` cannot go
 * through `toCommentOut` (its response carries only an id and a date, no
 * author or text), so it goes through this instead - a comment date is
 * never formatted outside this module.
 */
export function formatCommentDate(date: string | number, timezone: string): string {
  return formatDate(Number(date), timezone)
}

/**
 * Renders one comment as a single markdown bullet. Exported so that
 * `clickup_get_task`'s comment section (src/format/task.ts) uses the exact
 * same formatting as `clickup_get_comments` (`renderComments` below) rather
 * than a second, separately-maintained rendering of the same fields - the
 * two used to diverge on whether a timestamp appeared at all.
 */
export function formatCommentLine(comment: CommentOut): string {
  return `- **${comment.author}** (${comment.date}): ${comment.text}`
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
  return [`# Comments on task ${taskId}`, '', ...comments.map(formatCommentLine)].join('\n')
}
