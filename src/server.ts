import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ClickUpContext } from './core/context.js'
import type { ServerConfig } from './core/config.js'
import { toAgentMessage } from './core/errors.js'
import {
  annotationsFor,
  RESPONSE_FORMAT_SHAPE,
  selectTools,
  type AnyToolDefinition,
} from './core/registry.js'
import { truncateResponse, truncationNotice } from './format/common.js'

/**
 * The list of items a response carries, when it carries one: either a bare
 * array or a `paginate()`-shaped `{ items }` object. `undefined` for
 * anything else - a single task, a doc page - where there is no item
 * granularity to truncate at and no dropped-item count to report.
 */
function itemsOf(out: unknown): unknown[] | undefined {
  if (Array.isArray(out)) return out
  if (out !== null && typeof out === 'object' && Array.isArray((out as { items?: unknown }).items)) {
    return (out as { items: unknown[] }).items
  }
  return undefined
}

/**
 * The same response with only the first `kept` items, and the pagination
 * fields corrected to match. Correcting them is the point: a rendered
 * header reading "Showing 25 of 100" above 12 listed items would be a
 * placeholder-grade lie, the exact class of defect reliability rule 2
 * forbids.
 */
function withItems(out: unknown, all: unknown[], kept: unknown[]): unknown {
  if (Array.isArray(out)) return kept
  const base = out as unknown as Record<string, unknown>
  const next: Record<string, unknown> = { ...base, items: kept }
  if (typeof base.count === 'number') {
    next.count = kept.length
  }
  if (kept.length < all.length) {
    if (typeof base.has_more === 'boolean') {
      next.has_more = true
    }
    if (typeof base.offset === 'number') {
      next.next_offset = base.offset + kept.length
    }
  }
  return next
}

function pagedRetryHint(out: unknown, kept: number): string {
  const offset = out !== null && typeof out === 'object' && typeof (out as { offset?: unknown }).offset === 'number'
    ? (out as { offset: number }).offset
    : 0
  return `Request the rest with offset=${offset + kept}, or pass a smaller limit so each response fits the budget.`
}

const GENERIC_RETRY_HINT = 'Narrow the request (add filters, request a smaller page, or fewer fields) and retry.'

/**
 * Renders `out` and, when the render exceeds the budget, drops WHOLE items
 * from the end until it fits - so the notice can name exactly how many were
 * dropped and the offset that would fetch them, per spec section 6.
 *
 * Dropping items rather than characters is what makes the count honest. A
 * blind character cut knows only the total item count, which is why the
 * notice used to name the total and read to an agent as "N items are here".
 * A response with no item list (a single task, a doc page) still falls back
 * to a character cut, with a notice that claims no count at all.
 */
export function fitToBudget(out: unknown, renderOne: (value: unknown) => string, maxChars: number): string {
  const full = renderOne(out)
  if (full.length <= maxChars) {
    return full
  }

  const items = itemsOf(out)
  if (items === undefined || items.length === 0) {
    return truncateResponse(full, { maxChars, retryHint: GENERIC_RETRY_HINT })
  }

  // Largest prefix of items whose render plus its own notice fits.
  let lo = 0
  let hi = items.length - 1
  let best: string | undefined
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const kept = items.slice(0, mid)
    const body = renderOne(withItems(out, items, kept))
    const notice = truncationNotice({
      droppedItems: items.length - mid,
      retryHint: pagedRetryHint(out, mid),
    })
    if (body.length + notice.length <= maxChars) {
      best = body + notice
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  // Even zero items did not fit (a budget smaller than the envelope
  // itself). Fall back to the character cut rather than returning nothing.
  return best ?? truncateResponse(full, { maxChars, retryHint: pagedRetryHint(out, 0) })
}

/**
 * Wraps one `AnyToolDefinition` into the callback shape `McpServer.registerTool`
 * expects. Kept as its own function, rather than inlined in the registration
 * loop, purely for readability - the loop body would otherwise bury five
 * distinct steps (strip response_format, strict-parse, build context, run
 * the handler, render) inside the `for` statement.
 *
 * The `tool` parameter is deliberately `AnyToolDefinition`: the type-erased
 * view is exactly what lets one function serve every tool in a
 * heterogeneous list without a cast at each call site. The cast lives here,
 * once, where it is easy to audit, rather than scattered at every
 * `registerTool` call.
 */
function makeWrapper(tool: AnyToolDefinition, config: ServerConfig, contextFactory: () => ClickUpContext) {
  return async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
    const { response_format, ...rest } = rawArgs
    const format = response_format === 'json' ? 'json' : 'markdown'

    const parsed = z.strictObject(tool.inputSchema).safeParse(rest)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return {
        isError: true,
        content: [{ type: 'text', text: `Invalid arguments: ${issues}` }],
      }
    }

    try {
      const ctx = contextFactory()
      const out = await tool.handler(parsed.data, ctx)
      // `value` is `unknown` because `fitToBudget` hands back a shallow
      // copy of the same shape with a shorter `items`; the cast is the same
      // type erasure `AnyToolDefinition` already applies to `render`.
      const renderOne = (value: unknown): string =>
        format === 'json'
          ? JSON.stringify(value, null, 2)
          : tool.render(value as Parameters<typeof tool.render>[0], ctx)
      const text = fitToBudget(out, renderOne, config.maxResponseChars)
      return {
        // Deliberately the FULL result, never the truncated view: cutting
        // structured content would produce a payload that violates the
        // tool's own outputSchema, which is worse than a large one. The
        // character budget bounds the rendered text; a client reading
        // structuredContent gets everything. Documented in the README and
        // spec section 6.
        structuredContent: out,
        content: [{ type: 'text', text }],
      }
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: toAgentMessage(err) }],
      }
    }
  }
}

/**
 * Assembles an `McpServer` from a tool list, a config and a context
 * factory. `selectTools` decides which of `opts.tools` this instance
 * advertises at all (mode, category, blocklist); everything that survives
 * is registered with `annotationsFor(tool.mode)` so annotations can never
 * drift from mode.
 *
 * Per the Task 8 ruling, `RESPONSE_FORMAT_SHAPE` is appended to the
 * ADVERTISED input schema of `read` mode tools only - individual tool
 * definitions never declare it themselves - while the wrapper strips
 * `response_format` out of every call's arguments before the strict parse,
 * regardless of mode, so a client can pass it to any tool without it ever
 * reaching that tool's own strict schema.
 */
export function buildServer(opts: {
  tools: AnyToolDefinition[]
  config: ServerConfig
  contextFactory: () => ClickUpContext
}): McpServer {
  const { tools, config, contextFactory } = opts
  const server = new McpServer({ name: '@inviqon/clickup-mcp-server', version: '0.1.0' })

  const selected = selectTools(tools, {
    mode: config.mode,
    enabledCategories: config.enabledCategories,
    disabledTools: config.disabledTools,
  })

  for (const tool of selected) {
    const advertisedShape =
      tool.mode === 'read' ? { ...tool.inputSchema, ...RESPONSE_FORMAT_SHAPE } : tool.inputSchema

    // Registered as a loose (passthrough) object rather than the bare raw
    // shape: the SDK's own pre-validation otherwise silently strips any key
    // not in the advertised shape (its default z.object() is strip-mode),
    // which would erase an unrecognised argument before the wrapper ever
    // saw it and defeat the strict re-parse below. Passthrough keeps it
    // visible so `z.strictObject` can reject it instead of a silent no-op.
    // Side effect: the advertised JSON Schema this produces also gains
    // `additionalProperties: {}` (loose objects permit arbitrary extra
    // properties), which is the schema-level expression of the same
    // passthrough choice - a client introspecting the tool's input schema
    // sees that unrecognised keys are accepted at the wire level, even
    // though the wrapper's own strict re-parse still rejects them.
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.looseObject(advertisedShape),
        outputSchema: tool.outputSchema,
        annotations: annotationsFor(tool.mode),
      },
      makeWrapper(tool, config, contextFactory),
    )
  }

  return server
}
