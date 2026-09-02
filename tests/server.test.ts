import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildServer } from '../src/server.js'
import type { AnyToolDefinition } from '../src/core/registry.js'
import { loadConfig } from '../src/core/config.js'
import { ClickUpUsageError } from '../src/core/errors.js'

const echo = {
  name: 'clickup_echo', title: 'Echo', description: 'Echo a value.',
  category: 'tasks', mode: 'read',
  inputSchema: { value: z.string() },
  outputSchema: { value: z.string() },
  handler: async ({ value }: { value: string }) => ({ value }),
  render: (o: { value: string }) => `Echo: ${o.value}`,
} as unknown as AnyToolDefinition

const failing = {
  ...echo, name: 'clickup_fail',
  handler: async () => { throw new Error('upstream exploded') },
} as unknown as AnyToolDefinition

const misused = {
  ...echo, name: 'clickup_misused',
  handler: async () => {
    throw new ClickUpUsageError('List 100 has no status "dnoe". Available: open, closed')
  },
} as unknown as AnyToolDefinition

async function connect(tools: AnyToolDefinition[]) {
  const config = loadConfig({ CLICKUP_API_KEY: 'pk_1', CLICKUP_TEAM_ID: '9007' })
  const server = buildServer({ tools, config, contextFactory: () => ({}) as never })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([client.connect(clientT), server.connect(serverT)])
  return client
}

describe('buildServer', () => {
  it('lists registered tools with annotations derived from mode', async () => {
    const client = await connect([echo])
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['clickup_echo'])
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true)
  })

  it('returns both markdown content and structuredContent', async () => {
    const client = await connect([echo])
    const res = await client.callTool({ name: 'clickup_echo', arguments: { value: 'hi' } })
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe('Echo: hi')
    expect(res.structuredContent).toEqual({ value: 'hi' })
  })

  it('returns raw json when response_format is json', async () => {
    const client = await connect([echo])
    const res = await client.callTool({
      name: 'clickup_echo', arguments: { value: 'hi', response_format: 'json' },
    })
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toEqual({ value: 'hi' })
  })

  it('rejects an unknown argument instead of ignoring it', async () => {
    const client = await connect([echo])
    const res = await client.callTool({
      name: 'clickup_echo', arguments: { value: 'hi', typoo: 1 },
    })
    expect(res.isError).toBe(true)
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain('typoo')
  })

  it('reports a handler failure as isError with no stack trace', async () => {
    const client = await connect([failing])
    const res = await client.callTool({ name: 'clickup_fail', arguments: { value: 'x' } })
    expect(res.isError).toBe(true)
    const text = (res.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('Unexpected error')
    expect(text).not.toContain('at ')
  })

  // The deliberate errors the tools raise (a bad status name, an unknown
  // custom field, a confirm_name mismatch) are the actionable ones. Calling
  // them "unexpected" tells the agent to retry when the fix is to correct
  // the argument the message already names.
  it('delivers a deliberate usage error to the client unwrapped', async () => {
    const client = await connect([misused])
    const res = await client.callTool({ name: 'clickup_misused', arguments: { value: 'x' } })
    expect(res.isError).toBe(true)
    const text = (res.content as Array<{ text: string }>)[0]!.text
    expect(text).toBe('List 100 has no status "dnoe". Available: open, closed')
    expect(text).not.toContain('Unexpected error')
  })
})

// Additional coverage beyond the brief's floor: the brief's five tests never
// exercise a response that actually exceeds `maxResponseChars`, nor prove
// that `response_format` is appended only to `read` mode tools' advertised
// schema. Both are named explicitly in Task 9's self-review checklist, so
// they are covered here rather than left implicit.
describe('buildServer - truncation and mode-scoped response_format', () => {
  const big = {
    ...echo,
    name: 'clickup_big',
    handler: async () => ({ value: 'x'.repeat(500) }),
  } as unknown as AnyToolDefinition

  const writeTool = {
    ...echo,
    name: 'clickup_write_echo',
    mode: 'write',
  } as unknown as AnyToolDefinition

  async function connectWithEnv(tools: AnyToolDefinition[], envOverrides: Record<string, string>) {
    const config = loadConfig({
      CLICKUP_API_KEY: 'pk_1',
      CLICKUP_TEAM_ID: '9007',
      CLICKUP_MCP_MODE: 'write',
      ...envOverrides,
    })
    const server = buildServer({ tools, config, contextFactory: () => ({}) as never })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await Promise.all([client.connect(clientT), server.connect(serverT)])
    return client
  }

  it('truncates content over the configured character budget with a visible notice', async () => {
    const client = await connectWithEnv([big], { CLICKUP_MAX_RESPONSE_CHARS: '100' })
    const res = await client.callTool({ name: 'clickup_big', arguments: { value: 'x' } })
    const text = (res.content as Array<{ text: string }>)[0]!.text
    // The untruncated body would be "Echo: " followed by 500 x's (506 chars).
    expect(text.length).toBeLessThan(506)
    expect(text).toContain('Response truncated')
  })

  it('does not advertise response_format on a write mode tool, and a read tool still does', async () => {
    const client = await connectWithEnv([writeTool, echo], {})
    const { tools } = await client.listTools()
    const writeSchema = tools.find((t) => t.name === 'clickup_write_echo')?.inputSchema as {
      properties?: Record<string, unknown>
    }
    const readSchema = tools.find((t) => t.name === 'clickup_echo')?.inputSchema as {
      properties?: Record<string, unknown>
    }
    expect(writeSchema.properties?.response_format).toBeUndefined()
    expect(readSchema.properties?.response_format).toBeDefined()
  })
})
