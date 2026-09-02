import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALL_TOOLS } from '../src/tools/index.js'
import { renderToolDocs } from '../scripts/generate-tool-docs.js'

describe('tool documentation', () => {
  it('docs/TOOLS.md matches the registry', () => {
    expect(readFileSync('docs/TOOLS.md', 'utf8')).toBe(renderToolDocs(ALL_TOOLS))
  })

  it('every tool has a description naming when not to use it', () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length).toBeGreaterThan(80)
      expect(t.description).toMatch(/Example|Use /)
    }
  })

  it('every tool name is prefixed and snake_case', () => {
    for (const t of ALL_TOOLS) expect(t.name).toMatch(/^clickup_[a-z0-9_]+$/)
  })

  it('README documents every environment variable the config reads', () => {
    const readme = readFileSync('README.md', 'utf8')
    for (const v of ['CLICKUP_API_KEY', 'CLICKUP_TEAM_ID', 'CLICKUP_MCP_MODE',
      'CLICKUP_ENABLED_CATEGORIES', 'CLICKUP_DISABLED_TOOLS', 'CLICKUP_TIMEZONE',
      'CLICKUP_CACHE_TTL_SECONDS', 'CLICKUP_RATE_LIMIT', 'CLICKUP_MAX_RESPONSE_CHARS',
      'CLICKUP_HTTP_PORT', 'CLICKUP_HTTP_HOST', 'CLICKUP_ALLOWED_ORIGINS', 'LOG_LEVEL']) {
      expect(readme).toContain(v)
    }
  })

  it('exactly 39 tools are registered', () => {
    expect(ALL_TOOLS).toHaveLength(39)
  })
})
