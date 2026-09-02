import type { AnyToolDefinition } from '../core/registry.js'
import { NAVIGATION_TOOLS } from './navigation.js'
import { TASK_TOOLS } from './tasks.js'
import { COMMENT_TOOLS } from './comments.js'
import { TAG_TOOLS } from './tags.js'
import { STRUCTURE_TOOLS } from './structure.js'
import { TIME_TOOLS } from './time.js'
import { MYDAY_TOOLS } from './myday.js'
import { DOC_TOOLS } from './docs.js'

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
  ...STRUCTURE_TOOLS,
  ...TIME_TOOLS,
  ...MYDAY_TOOLS,
  ...DOC_TOOLS,
]
