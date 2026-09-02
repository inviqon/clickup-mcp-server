#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { z } from 'zod'
import { CATEGORIES, type Category } from '../src/core/config.js'
import { annotationsFor, type AnyToolDefinition } from '../src/core/registry.js'
import { ALL_TOOLS } from '../src/tools/index.js'

/**
 * Generates `docs/TOOLS.md` straight from `ALL_TOOLS` (types, descriptions,
 * modes, annotations) rather than from a hand-maintained copy, so the
 * generated file can never describe a tool differently than the code
 * actually behaves. `tests/docs.test.ts` asserts `docs/TOOLS.md` equals
 * `renderToolDocs(ALL_TOOLS)` byte for byte - regenerate with
 * `npm run docs:tools` after any change to a tool's shape or description,
 * never hand-edit the generated file.
 */

const CATEGORY_LABELS: Record<Category, string> = {
  navigation: 'Navigation',
  tasks: 'Tasks',
  comments: 'Comments',
  structure: 'Structure',
  tags: 'Tags',
  time: 'Time Tracking',
  docs: 'Docs',
  daily: 'Daily',
}

const MODE_LABELS: Record<AnyToolDefinition['mode'], string> = {
  read: 'read (R)',
  write: 'write (W)',
  admin: 'admin (A)',
}

/** Minimal shape of a JSON Schema node this generator actually reads, as produced by `z.toJSONSchema`. */
type JsonSchemaNode = {
  type?: string | string[]
  enum?: unknown[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  description?: string
  default?: unknown
  anyOf?: JsonSchemaNode[]
}

type ObjectJsonSchema = JsonSchemaNode & {
  type: 'object'
  properties: Record<string, JsonSchemaNode>
  required?: string[]
}

/**
 * Renders one JSON Schema node as a short, human type string: `string`,
 * `array of string`, `enum: read | write | admin`, and so on. Recurses into
 * `array` items and named `object` shapes; a `record`-style object (zod's
 * `z.record`, used for free-form custom field values) has no `properties`
 * key, so it falls back to plain `object`.
 */
function formatType(node: JsonSchemaNode): string {
  if (node.enum !== undefined) {
    return `enum: ${node.enum.map((v) => String(v)).join(' | ')}`
  }
  // A nullable field (zod's `.nullable()`) shows up as `anyOf: [<type>, {type: "null"}]`
  // rather than a plain `type`, since JSON Schema has no direct "nullable" keyword.
  if (node.anyOf !== undefined) {
    const variants = node.anyOf.map((v) => formatType(v))
    const nullable = variants.includes('null')
    const nonNull = variants.filter((v) => v !== 'null')
    const base = nonNull.length > 0 ? nonNull.join(' | ') : 'unknown'
    return nullable ? `${base} or null` : base
  }
  if (node.type === 'null') {
    return 'null'
  }
  if (node.type === 'array') {
    return `array of ${node.items !== undefined ? formatType(node.items) : 'unknown'}`
  }
  if (node.type === 'object') {
    if (node.properties !== undefined && Object.keys(node.properties).length > 0) {
      const inner = Object.keys(node.properties).join(', ')
      return `object {${inner}}`
    }
    return 'object'
  }
  if (Array.isArray(node.type)) {
    return node.type.join(' | ')
  }
  return node.type ?? 'unknown'
}

function formatDefault(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value)
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * Renders the parameter table for a tool's `inputSchema`. Uses
 * `io: 'input'` so a field with a `.default(...)` is reported as optional
 * (what a caller may omit), not required (what is always present once zod
 * has applied the default) - the two read very differently to someone
 * deciding what they must pass.
 */
function renderInputParams(shape: z.ZodRawShape): string {
  const keys = Object.keys(shape)
  if (keys.length === 0) {
    return 'No input parameters.'
  }

  const schema = z.toJSONSchema(z.object(shape), { io: 'input' }) as ObjectJsonSchema
  const required = new Set(schema.required ?? [])

  const rows = keys.map((key) => {
    const prop = schema.properties[key] as JsonSchemaNode
    const type = escapeCell(formatType(prop))
    const requiredCell = required.has(key) ? 'yes' : 'no'
    const defaultCell = prop.default !== undefined ? escapeCell(formatDefault(prop.default)) : ''
    const description = prop.description !== undefined ? escapeCell(prop.description) : ''
    return `| \`${key}\` | ${type} | ${requiredCell} | ${defaultCell} | ${description} |`
  })

  return [
    '| Name | Type | Required | Default | Description |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

/**
 * Renders the output schema as `key: type` bullets. Output shapes carry no
 * `.describe()` calls anywhere in this codebase (they are internal
 * contracts, not advertised input), so this deliberately omits a
 * description column rather than printing an empty one on every row.
 */
function renderOutputKeys(shape: z.ZodRawShape): string {
  const keys = Object.keys(shape)
  if (keys.length === 0) {
    return 'No output fields.'
  }

  const schema = z.toJSONSchema(z.object(shape), { io: 'output' }) as ObjectJsonSchema
  const required = new Set(schema.required ?? [])

  return keys
    .map((key) => {
      const prop = schema.properties[key] as JsonSchemaNode
      const optional = required.has(key) ? '' : ' (optional)'
      return `- \`${key}\`: ${formatType(prop)}${optional}`
    })
    .join('\n')
}

function renderAnnotations(mode: AnyToolDefinition['mode']): string {
  const a = annotationsFor(mode)
  return (
    `readOnlyHint=${a.readOnlyHint}, destructiveHint=${a.destructiveHint}, ` +
    `idempotentHint=${a.idempotentHint}, openWorldHint=${a.openWorldHint}`
  )
}

/** GitHub-flavoured-markdown heading anchor: lowercase, spaces to hyphens, drop anything else. */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

function renderToolSection(tool: AnyToolDefinition): string {
  return [
    `### ${tool.name}`,
    '',
    `**Title**: ${tool.title}`,
    '',
    `**Mode**: ${MODE_LABELS[tool.mode]}`,
    '',
    `**Annotations**: ${renderAnnotations(tool.mode)}`,
    '',
    tool.description,
    '',
    '**Input parameters**',
    '',
    renderInputParams(tool.inputSchema),
    '',
    '**Output fields**',
    '',
    renderOutputKeys(tool.outputSchema),
  ].join('\n')
}

function groupByCategory(tools: AnyToolDefinition[]): Map<Category, AnyToolDefinition[]> {
  const grouped = new Map<Category, AnyToolDefinition[]>()
  for (const category of CATEGORIES) {
    const inCategory = tools.filter((t) => t.category === category)
    if (inCategory.length > 0) {
      grouped.set(category, inCategory)
    }
  }
  return grouped
}

/**
 * Renders the full contents of `docs/TOOLS.md` from the live tool registry.
 * Pure function of `tools`: no filesystem access, no clock, so the same
 * input always produces the same output - what makes the drift test in
 * `tests/docs.test.ts` a meaningful gate rather than a flaky one.
 */
export function renderToolDocs(tools: AnyToolDefinition[]): string {
  const grouped = groupByCategory(tools)

  const toc: string[] = []
  for (const [category, categoryTools] of grouped) {
    const label = CATEGORY_LABELS[category]
    toc.push(`- [${label}](#${slugify(label)}) (${categoryTools.length})`)
    for (const tool of categoryTools) {
      toc.push(`  - [${tool.name}](#${slugify(tool.name)})`)
    }
  }

  const sections: string[] = []
  for (const [category, categoryTools] of grouped) {
    sections.push(`## ${CATEGORY_LABELS[category]}`, '')
    for (const tool of categoryTools) {
      sections.push(renderToolSection(tool), '')
    }
  }

  return [
    '# Tool Reference',
    '',
    'Generated by `npm run docs:tools` from `ALL_TOOLS` in `src/tools/index.ts`. Do not edit by',
    'hand - `tests/docs.test.ts` fails if this file drifts from the registry. Regenerate after',
    'changing any tool\'s schema, mode or description.',
    '',
    `${tools.length} tools across ${grouped.size} categories.`,
    '',
    '## Contents',
    '',
    ...toc,
    '',
    ...sections,
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// Only runs when this module is executed directly (`npm run docs:tools`),
// never as a side effect of `tests/docs.test.ts` importing `renderToolDocs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const content = renderToolDocs(ALL_TOOLS)
  writeFileSync('docs/TOOLS.md', content)
  // Allowed here: this runs under scripts/, not src/, and src/ is the only
  // directory tests/stdout-guard.test.ts forbids console.log in.
  console.log(`Wrote docs/TOOLS.md (${ALL_TOOLS.length} tools).`)
}
