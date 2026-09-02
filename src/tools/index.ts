import type { AnyToolDefinition } from '../core/registry.js'
import { NAVIGATION_TOOLS } from './navigation.js'
import { TASK_TOOLS } from './tasks.js'
import { COMMENT_TOOLS } from './comments.js'
import { TAG_TOOLS } from './tags.js'

/**
 * The full tool set the server can offer. Tasks 10-16 each append their own
 * tool definitions here. `buildServer` narrows this list down per request
 * via `selectTools` (mode, category, blocklist), so this array is
 * deliberately unfiltered.
 */
export const ALL_TOOLS: AnyToolDefinition[] = [
  ...NAVIGATION_TOOLS,
  ...TASK_TOOLS,
  ...COMMENT_TOOLS,
  ...TAG_TOOLS,
]
