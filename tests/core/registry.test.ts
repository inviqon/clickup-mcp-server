import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RESPONSE_FORMAT_SHAPE, annotationsFor, selectTools, type AnyToolDefinition } from '../../src/core/registry.js'

const tool = (name: string, mode: 'read' | 'write' | 'admin', category: string) => ({
  name, title: name, description: name, category, mode,
  inputSchema: {}, outputSchema: {},
  handler: async () => ({}), render: () => '',
}) as unknown as AnyToolDefinition

const all = [
  tool('clickup_get_task', 'read', 'tasks'),
  tool('clickup_update_task', 'write', 'tasks'),
  tool('clickup_delete_task', 'admin', 'tasks'),
  tool('clickup_start_timer', 'write', 'time'),
]

describe('selectTools', () => {
  it('read mode exposes only read tools', () => {
    const names = selectTools(all, { mode: 'read', enabledCategories: null, disabledTools: [] })
      .map((t) => t.name)
    expect(names).toEqual(['clickup_get_task'])
  })

  it('write mode exposes read and write but never admin', () => {
    const names = selectTools(all, { mode: 'write', enabledCategories: null, disabledTools: [] })
      .map((t) => t.name)
    expect(names).not.toContain('clickup_delete_task')
    expect(names).toContain('clickup_update_task')
  })

  it('admin mode exposes everything', () => {
    expect(selectTools(all, { mode: 'admin', enabledCategories: null, disabledTools: [] }))
      .toHaveLength(4)
  })

  it('filters by enabled categories', () => {
    const names = selectTools(all, { mode: 'admin', enabledCategories: ['time'], disabledTools: [] })
      .map((t) => t.name)
    expect(names).toEqual(['clickup_start_timer'])
  })

  it('applies the tool blocklist last', () => {
    const names = selectTools(all, {
      mode: 'admin', enabledCategories: null, disabledTools: ['clickup_delete_task'],
    }).map((t) => t.name)
    expect(names).not.toContain('clickup_delete_task')
  })

  // The brief pins an execution ORDER (mode, then category, then blocklist),
  // but as pure AND-combined predicates over a flat list, these three
  // filters commute: no selection of inputs can make the result differ
  // between "category then blocklist" and "blocklist then category". This
  // case still exercises category and blocklist together (a tool the
  // category filter admits and the blocklist then removes, alongside a
  // second tool from the same category that survives both), so a swap of
  // either filter's logic - not just their order - would be caught.
  it('combines the category filter and the blocklist correctly', () => {
    const names = selectTools(all, {
      mode: 'admin',
      enabledCategories: ['tasks'],
      disabledTools: ['clickup_delete_task'],
    }).map((t) => t.name)
    expect(names).toEqual(['clickup_get_task', 'clickup_update_task'])
  })
})

describe('annotationsFor', () => {
  it('marks read tools read only and idempotent', () => {
    expect(annotationsFor('read')).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    })
  })

  it('marks admin tools destructive', () => {
    expect(annotationsFor('admin').destructiveHint).toBe(true)
  })

  it('never marks a write tool read only', () => {
    expect(annotationsFor('write').readOnlyHint).toBe(false)
  })
})

describe('RESPONSE_FORMAT_SHAPE', () => {
  const schema = z.object(RESPONSE_FORMAT_SHAPE)

  it('accepts markdown and json', () => {
    expect(schema.parse({ response_format: 'markdown' })).toEqual({ response_format: 'markdown' })
    expect(schema.parse({ response_format: 'json' })).toEqual({ response_format: 'json' })
  })

  it('defaults to markdown when omitted', () => {
    expect(schema.parse({})).toEqual({ response_format: 'markdown' })
  })

  it('rejects any other value', () => {
    expect(() => schema.parse({ response_format: 'yaml' })).toThrow()
  })
})
