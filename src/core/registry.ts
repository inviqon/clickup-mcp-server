import { z } from 'zod'
import type { Category } from './config.js'
import type { ClickUpContext } from './context.js'

export type ToolMode = 'read' | 'write' | 'admin'

/**
 * The contract every tool in Tasks 10-16 is written against. A handler
 * returns a typed object (`TOut`), never a string: Task 9's server is what
 * turns that object into markdown or JSON, and it also emits it verbatim
 * as `structuredContent` so a client gets machine-readable truth alongside
 * the compact rendered view. `render` is the only place a tool produces
 * prose, and it is a pure function of the already-validated output plus
 * the request context - it cannot invent fields that were not returned by
 * `handler`.
 *
 * `inputSchema` and `outputSchema` are `ZodRawShape`s (plain objects of
 * zod types), not `ZodObject`s, because that is what the MCP SDK's
 * `registerTool` accepts directly for `inputSchema`/`outputSchema`.
 * `handler` and `render` still see the fully inferred, wrapped object type
 * via `z.infer<z.ZodObject<TIn>>` / `z.infer<z.ZodObject<TOut>>`.
 */
export type ToolDefinition<TIn extends z.ZodRawShape, TOut extends z.ZodRawShape> = {
  name: string
  title: string
  description: string
  category: Category
  mode: ToolMode
  inputSchema: TIn
  outputSchema: TOut
  handler: (args: z.infer<z.ZodObject<TIn>>, ctx: ClickUpContext) => Promise<z.infer<z.ZodObject<TOut>>>
  render: (out: z.infer<z.ZodObject<TOut>>, ctx: ClickUpContext) => string
}

/**
 * Type-erased view of `ToolDefinition` used at the registry boundary
 * (registration, filtering, docs generation) where a heterogeneous list of
 * tools with different `TIn`/`TOut` shapes must live in one array. Each
 * tool's own definition still gets full inference through its `handler`
 * and `render`; only code that treats tools uniformly, without knowing any
 * individual tool's shapes, works through this alias.
 */
export type AnyToolDefinition = ToolDefinition<z.ZodRawShape, z.ZodRawShape>

const MODE_RANK: Record<ToolMode, number> = {
  read: 0,
  write: 1,
  admin: 2,
}

/**
 * Derives MCP tool annotations from a tool's mode so the two can never
 * drift apart. In particular, `admin` is always `destructiveHint: true` -
 * that is the signal that tells a client a tool can do something
 * irreversible, such as deleting a space.
 */
export function annotationsFor(mode: ToolMode): {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
} {
  switch (mode) {
    case 'read':
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    case 'write':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    case 'admin':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }
}

/**
 * Narrows the full tool set down to what one server instance should
 * advertise. Applied in this order:
 *
 * 1. Mode ranking - a tool is visible when its own rank (`read` 0,
 *    `write` 1, `admin` 2) is at most the configured mode's rank, so
 *    `write` mode exposes `read` and `write` tools but never `admin`.
 * 2. Category filter - when `enabledCategories` is non-null, only tools
 *    in one of those categories survive.
 * 3. Blocklist - `disabledTools` is applied last, so it can remove a tool
 *    the first two filters admitted.
 */
export function selectTools(
  all: AnyToolDefinition[],
  opts: { mode: ToolMode; enabledCategories: Category[] | null; disabledTools: string[] },
): AnyToolDefinition[] {
  const configuredRank = MODE_RANK[opts.mode]
  const byMode = all.filter((tool) => MODE_RANK[tool.mode] <= configuredRank)

  const enabledCategories = opts.enabledCategories
  const byCategory =
    enabledCategories === null
      ? byMode
      : byMode.filter((tool) => enabledCategories.includes(tool.category))

  const blocked = new Set(opts.disabledTools)
  return byCategory.filter((tool) => !blocked.has(tool.name))
}

/**
 * The `response_format` input field shared by every `read` mode tool.
 * Deliberately NOT spread into any individual tool's `inputSchema`: Task
 * 9's `buildServer` appends this shape to the advertised schema of `read`
 * tools and strips `response_format` from the arguments before the strict
 * parse of the tool's own shape, so no tool definition has to remember it
 * and no tool's own parsing can trip over it.
 */
export const RESPONSE_FORMAT_SHAPE = {
  response_format: z.enum(['markdown', 'json']).default('markdown'),
}
