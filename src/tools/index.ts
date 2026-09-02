import type { AnyToolDefinition } from '../core/registry.js'

/**
 * The full tool set the server can offer. Empty for now: Tasks 10-16 each
 * append their own tool definitions here. `buildServer` narrows this list
 * down per request via `selectTools` (mode, category, blocklist), so this
 * array is deliberately unfiltered.
 */
export const ALL_TOOLS: AnyToolDefinition[] = []
