export type ClickUpApiErrorOptions = {
  status: number
  endpoint: string
  ecode?: string | undefined
  /**
   * ClickUp's own human-readable explanation, extracted from the `err`
   * field of the error body (e.g. "Time In Status is not available on your
   * plan"). Kept separate from `message`, which is this server's own
   * synthetic string (e.g. "ClickUp API request failed (403)") that callers
   * and existing tests already rely on.
   */
  clickupMessage?: string | undefined
  resetAt?: Date | undefined
}

export class ClickUpApiError extends Error {
  readonly status: number
  readonly ecode: string | undefined
  readonly clickupMessage: string | undefined
  readonly endpoint: string
  readonly resetAt: Date | undefined

  constructor(message: string, options: ClickUpApiErrorOptions) {
    super(message)
    this.name = 'ClickUpApiError'
    this.status = options.status
    this.ecode = options.ecode
    this.clickupMessage = options.clickupMessage
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

/**
 * ClickUp's own explanation, when it supplied one, formatted to come first
 * in the agent-facing message - it is the fact, and everything after it in
 * `apiErrorMessage` is this server's hypothesis about the cause. Empty
 * string (not a dangling `"ClickUp says: ". `) when ClickUp gave no message,
 * so the no-message case reads identically to a version of this file with
 * no knowledge of `clickupMessage` at all: no stray separator, empty quote,
 * or trailing colon.
 */
function clickupMessagePrefix(err: ClickUpApiError): string {
  return err.clickupMessage !== undefined ? `ClickUp says: "${err.clickupMessage}". ` : ''
}

function apiErrorMessage(err: ClickUpApiError, hint: AgentMessageHint | undefined): string {
  const prefix = clickupMessagePrefix(err)
  switch (err.status) {
    case 401:
      return `${prefix}Invalid ClickUp token. Check CLICKUP_API_KEY.`
    case 403:
      // A live workspace produced a 403 whose ClickUp message ("Time In
      // Status is not available on your plan") had nothing to do with
      // CLICKUP_TEAM_ID - the task was in the configured workspace all
      // along. So this hint is worded as one possibility among others,
      // never a diagnosis: the workspace-mismatch story is still worth
      // checking, but a plan or permission restriction is just as real a
      // cause, especially when ClickUp's own message (above, if present)
      // points at that instead.
      return `${prefix}Access denied for ${resourceLabel(hint)}. This can happen when the resource belongs to a different workspace than CLICKUP_TEAM_ID (worth checking), but it can also be a plan or permission restriction on the ClickUp side that CLICKUP_TEAM_ID would not fix.`
    case 404:
      return `${prefix}${resourceLabel(hint)} not found. Use clickup_get_workspace_tree to list valid ${hint?.resource ?? 'resource'} ids.`
    case 429: {
      if (err.resetAt !== undefined) {
        return `${prefix}ClickUp rate limit hit. Retry after ${err.resetAt.toISOString()}.`
      }
      return `${prefix}ClickUp rate limit hit. Wait a moment and retry.`
    }
    default:
      return `${prefix}ClickUp API error (${err.status}) calling ${err.endpoint}: ${err.message}. Retry, or check the ClickUp API status page if this persists.`
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
