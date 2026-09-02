import { z } from 'zod'

export const CATEGORIES = [
  'navigation',
  'tasks',
  'comments',
  'structure',
  'tags',
  'time',
  'docs',
  'daily',
] as const

export type Category = (typeof CATEGORIES)[number]

export type ServerConfig = {
  apiKey: string
  teamId: string
  mode: 'read' | 'write' | 'admin'
  enabledCategories: Category[] | null
  disabledTools: string[]
  timezone: string
  cacheTtlSeconds: number
  rateLimit: number
  maxResponseChars: number
  httpPort: number
  httpHost: string
  allowedOrigins: string[]
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

function requiredString(name: string) {
  return z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
}

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function optionalList() {
  return z
    .string()
    .optional()
    .transform((value) => (value === undefined ? [] : splitCommaList(value)))
}

function numberFromString(name: string, defaultValue: number) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return defaultValue
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a number, got ${JSON.stringify(value)}`,
        })
        return z.NEVER
      }
      return parsed
    })
}

const rawConfigSchema = z.strictObject({
  CLICKUP_API_KEY: requiredString('CLICKUP_API_KEY'),
  CLICKUP_TEAM_ID: requiredString('CLICKUP_TEAM_ID'),
  CLICKUP_MCP_MODE: z
    .enum(['read', 'write', 'admin'], {
      error: () => 'CLICKUP_MCP_MODE must be one of: read, write, admin',
    })
    .optional()
    .default('write'),
  CLICKUP_ENABLED_CATEGORIES: z.string().optional(),
  CLICKUP_DISABLED_TOOLS: optionalList(),
  CLICKUP_TIMEZONE: z.string().optional().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  CLICKUP_CACHE_TTL_SECONDS: numberFromString('CLICKUP_CACHE_TTL_SECONDS', 300),
  CLICKUP_RATE_LIMIT: numberFromString('CLICKUP_RATE_LIMIT', 100),
  CLICKUP_MAX_RESPONSE_CHARS: numberFromString('CLICKUP_MAX_RESPONSE_CHARS', 40000),
  CLICKUP_HTTP_PORT: numberFromString('CLICKUP_HTTP_PORT', 3000),
  CLICKUP_HTTP_HOST: z.string().optional().default('127.0.0.1'),
  CLICKUP_ALLOWED_ORIGINS: optionalList(),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'], {
      error: () => 'LOG_LEVEL must be one of: debug, info, warn, error',
    })
    .optional()
    .default('info'),
})

function parseEnabledCategories(raw: string | undefined): Category[] | null {
  if (raw === undefined) return null
  const entries = splitCommaList(raw)
  for (const entry of entries) {
    if (!CATEGORIES.includes(entry as Category)) {
      throw new Error(
        `CLICKUP_ENABLED_CATEGORIES contains an unknown category "${entry}". Valid values: ${CATEGORIES.join(', ')}`,
      )
    }
  }
  return entries as Category[]
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const picked = {
    CLICKUP_API_KEY: env.CLICKUP_API_KEY,
    CLICKUP_TEAM_ID: env.CLICKUP_TEAM_ID,
    CLICKUP_MCP_MODE: env.CLICKUP_MCP_MODE,
    CLICKUP_ENABLED_CATEGORIES: env.CLICKUP_ENABLED_CATEGORIES,
    CLICKUP_DISABLED_TOOLS: env.CLICKUP_DISABLED_TOOLS,
    CLICKUP_TIMEZONE: env.CLICKUP_TIMEZONE,
    CLICKUP_CACHE_TTL_SECONDS: env.CLICKUP_CACHE_TTL_SECONDS,
    CLICKUP_RATE_LIMIT: env.CLICKUP_RATE_LIMIT,
    CLICKUP_MAX_RESPONSE_CHARS: env.CLICKUP_MAX_RESPONSE_CHARS,
    CLICKUP_HTTP_PORT: env.CLICKUP_HTTP_PORT,
    CLICKUP_HTTP_HOST: env.CLICKUP_HTTP_HOST,
    CLICKUP_ALLOWED_ORIGINS: env.CLICKUP_ALLOWED_ORIGINS,
    LOG_LEVEL: env.LOG_LEVEL,
  }

  const result = rawConfigSchema.safeParse(picked)
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? 'Invalid configuration'
    throw new Error(message)
  }

  const raw = result.data
  const enabledCategories = parseEnabledCategories(picked.CLICKUP_ENABLED_CATEGORIES)

  return {
    apiKey: raw.CLICKUP_API_KEY,
    teamId: raw.CLICKUP_TEAM_ID,
    mode: raw.CLICKUP_MCP_MODE,
    enabledCategories,
    disabledTools: raw.CLICKUP_DISABLED_TOOLS,
    timezone: raw.CLICKUP_TIMEZONE,
    cacheTtlSeconds: raw.CLICKUP_CACHE_TTL_SECONDS,
    rateLimit: raw.CLICKUP_RATE_LIMIT,
    maxResponseChars: raw.CLICKUP_MAX_RESPONSE_CHARS,
    httpPort: raw.CLICKUP_HTTP_PORT,
    httpHost: raw.CLICKUP_HTTP_HOST,
    allowedOrigins: raw.CLICKUP_ALLOWED_ORIGINS,
    logLevel: raw.LOG_LEVEL,
  }
}
