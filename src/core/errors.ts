export type ClickUpApiErrorOptions = {
  status: number
  endpoint: string
  ecode?: string
  resetAt?: Date
}

export class ClickUpApiError extends Error {
  readonly status: number
  readonly ecode: string | undefined
  readonly endpoint: string
  readonly resetAt: Date | undefined

  constructor(message: string, options: ClickUpApiErrorOptions) {
    super(message)
    this.name = 'ClickUpApiError'
    this.status = options.status
    this.ecode = options.ecode
    this.endpoint = options.endpoint
    this.resetAt = options.resetAt
  }
}

export type ClickUpSchemaErrorOptions = {
  endpoint: string
  issues: string[]
}

export class ClickUpSchemaError extends Error {
  readonly endpoint: string
  readonly issues: string[]

  constructor(message: string, options: ClickUpSchemaErrorOptions) {
    super(message)
    this.name = 'ClickUpSchemaError'
    this.endpoint = options.endpoint
    this.issues = options.issues
  }
}

export type AgentMessageHint = {
  resource?: string
  id?: string
}

function resourceLabel(hint: AgentMessageHint | undefined): string {
  const resource = hint?.resource ?? 'resource'
  const id = hint?.id ?? 'unknown'
  const capitalized = resource.charAt(0).toUpperCase() + resource.slice(1)
  return `${capitalized} ${id}`
}

function apiErrorMessage(err: ClickUpApiError, hint: AgentMessageHint | undefined): string {
  switch (err.status) {
    case 401:
      return 'Invalid ClickUp token. Check CLICKUP_API_KEY.'
    case 403:
      return `Access denied for ${resourceLabel(hint)}. It may belong to a different workspace than CLICKUP_TEAM_ID. Verify CLICKUP_TEAM_ID matches the workspace that owns this resource.`
    case 404:
      return `${resourceLabel(hint)} not found. Use clickup_get_workspace_tree to list valid ${hint?.resource ?? 'resource'} ids.`
    case 429: {
      if (err.resetAt !== undefined) {
        return `ClickUp rate limit hit. Retry after ${err.resetAt.toISOString()}.`
      }
      return 'ClickUp rate limit hit. Wait a moment and retry.'
    }
    default:
      return `ClickUp API error (${err.status}) calling ${err.endpoint}: ${err.message}`
  }
}

function schemaErrorMessage(err: ClickUpSchemaError): string {
  return `ClickUp returned an unexpected response shape for ${err.endpoint}: ${err.issues.join(', ')}`
}

export function toAgentMessage(err: unknown, hint?: AgentMessageHint): string {
  if (err instanceof ClickUpApiError) {
    return apiErrorMessage(err, hint)
  }
  if (err instanceof ClickUpSchemaError) {
    return schemaErrorMessage(err)
  }
  const message = err instanceof Error ? err.message : String(err)
  return `Unexpected error: ${message}`
}
