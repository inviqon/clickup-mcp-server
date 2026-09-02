export type ClickUpApiErrorOptions = {
  status: number
  endpoint: string
  ecode?: string | undefined
  resetAt?: Date | undefined
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

/**
 * An error this server raises deliberately, whose message is already
 * written for the agent: a status name that does not exist in the list, a
 * custom field name that does not exist, a `confirm_name` mismatch, a
 * running timer that would be silently stopped, a write that succeeded
 * followed by a read that did not.
 *
 * It exists so `toAgentMessage` can pass these through verbatim. Every one
 * of them used to be a plain `Error` and so came out as
 * "Unexpected error: ...", which is precisely backwards - these are the
 * EXPECTED errors, the ones the error module exists to make actionable. An
 * agent reading "Unexpected error" retries blindly instead of correcting
 * the argument the message just named for it.
 */
export class ClickUpUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClickUpUsageError'
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
      return `ClickUp API error (${err.status}) calling ${err.endpoint}: ${err.message}. Retry, or check the ClickUp API status page if this persists.`
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
  // Passed through verbatim: the message was written for this audience and
  // wrapping it in "Unexpected error" would tell the agent the opposite of
  // what is true.
  if (err instanceof ClickUpUsageError) {
    return err.message
  }
  const message = err instanceof Error ? err.message : String(err)
  return `Unexpected error: ${message}`
}
