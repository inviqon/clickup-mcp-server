import type { z } from 'zod'
import { ClickUpApiError, ClickUpSchemaError } from '../core/errors.js'
import type { RateLimiter } from '../core/rate-limiter.js'

export const API_BASE = 'https://api.clickup.com/api'

const DEFAULT_MAX_RETRIES = 3

export type ClickUpClientOptions = {
  token: string
  limiter: RateLimiter
  fetchImpl?: typeof fetch | undefined
  maxRetries?: number | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
}

export type ClickUpQueryValue = string | number | boolean | string[] | undefined
export type ClickUpQuery = Record<string, ClickUpQueryValue>

export type ClickUpRequestSpec<T> = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  version?: 'v2' | 'v3' | undefined
  query?: ClickUpQuery | undefined
  body?: unknown
  schema: z.ZodType<T>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildUrl(version: 'v2' | 'v3', path: string, query: ClickUpQuery | undefined): string {
  const url = new URL(`${API_BASE}/${version}${path}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          url.searchParams.append(key, entry)
        }
        continue
      }
      url.searchParams.append(key, String(value))
    }
  }
  return url.toString()
}

function parseResetHeader(response: Response): Date | undefined {
  const raw = response.headers.get('X-RateLimit-Reset')
  if (raw === null) {
    return undefined
  }
  const seconds = Number(raw)
  if (Number.isNaN(seconds)) {
    return undefined
  }
  return new Date(seconds * 1000)
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return {}
  }
  const text = await response.text()
  if (text.length === 0) {
    return {}
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return {}
  }
}

function extractEcode(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'ECODE' in body) {
    const value = (body as Record<string, unknown>).ECODE
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

export class ClickUpClient {
  private readonly token: string
  private readonly limiter: RateLimiter
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: ClickUpClientOptions) {
    this.token = opts.token
    this.limiter = opts.limiter
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    this.sleep = opts.sleep ?? defaultSleep
  }

  async request<T>(spec: ClickUpRequestSpec<T>): Promise<T> {
    const version = spec.version ?? 'v2'
    const url = buildUrl(version, spec.path, spec.query)
    const endpoint = `${spec.method} ${version}${spec.path}`

    let attempt = 0

    for (;;) {
      await this.limiter.acquire()

      const init: RequestInit = {
        method: spec.method,
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/json',
        },
      }
      if (spec.body !== undefined) {
        init.body = JSON.stringify(spec.body)
      }

      const response = await this.fetchImpl(url, init)

      if (response.status === 429) {
        const resetAt = parseResetHeader(response)
        if (resetAt) {
          this.limiter.notifyReset(resetAt)
        }
        if (attempt < this.maxRetries) {
          attempt++
          continue
        }
        const body = await readBody(response)
        throw new ClickUpApiError('ClickUp rate limit exceeded', {
          status: response.status,
          endpoint,
          ecode: extractEcode(body),
          resetAt,
        })
      }

      if (response.status >= 500) {
        if (attempt < this.maxRetries) {
          attempt++
          await this.sleep(2 ** attempt * 100)
          continue
        }
        const body = await readBody(response)
        throw new ClickUpApiError(`ClickUp server error (${response.status})`, {
          status: response.status,
          endpoint,
          ecode: extractEcode(body),
        })
      }

      if (!response.ok) {
        const body = await readBody(response)
        throw new ClickUpApiError(`ClickUp API request failed (${response.status})`, {
          status: response.status,
          endpoint,
          ecode: extractEcode(body),
        })
      }

      const body = await readBody(response)
      const result = spec.schema.safeParse(body)
      if (!result.success) {
        const issues = result.error.issues.map((issue) => issue.path.join('.') || '(root)')
        throw new ClickUpSchemaError(`ClickUp response failed schema validation for ${endpoint}`, {
          endpoint,
          issues,
        })
      }
      return result.data
    }
  }
}
