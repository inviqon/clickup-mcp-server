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
import { truncateResponse } from './format/common.js'

/**
 * A generic, tool-shape-agnostic estimate of how many "items" a response
 * carries, used only to phrase the wrapper-level truncation notice. Most
 * tool output is either a bare array or a `paginate()`-shaped `{ items }`
 * object; anything else counts as one item so the notice still reads
 * sensibly rather than claiming a precise count it cannot know.
 */
function estimateItemCount(out: unknown): number {
  if (Array.isArray(out)) return out.length
  if (out !== null && typeof out === 'object' && Array.isArray((out as { items?: unknown }).items)) {
    return (out as { items: unknown[] }).items.length
  }
  return 1
}

const GENERIC_RETRY_HINT = 'Narrow the request (add filters, request a smaller page, or fewer fields) and retry.'

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
      const rendered = format === 'json' ? JSON.stringify(out, null, 2) : tool.render(out, ctx)
      const text = truncateResponse(rendered, {
        maxChars: config.maxResponseChars,
        itemCount: estimateItemCount(out),
        retryHint: GENERIC_RETRY_HINT,
      })
      return {
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
