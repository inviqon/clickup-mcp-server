import { ClickUpUsageError } from '../core/errors.js'

/**
 * The second gate every delete tool applies on top of admin mode: deleting
 * a task, space, folder or list through the API is unrecoverable, so the
 * caller must have already read the entity - and named it correctly -
 * before this server destroys it. Fetching happens, and this check runs,
 * strictly before the delete call itself; every delete tool awaits this
 * before calling its `delete*Raw` endpoint function.
 *
 * Lives in its own module rather than in `tools/structure.ts` (its original
 * home) because `tools/tasks.ts` needs it too, and `tools/structure.ts`
 * already imports from `tools/tasks.ts` - importing back the other way
 * would make the two modules circular.
 *
 * `clickup_delete_time_entry` is deliberately not a caller: a ClickUp time
 * entry has no name to confirm against. There is nothing to type back, so
 * requiring a confirmation string there would be theatre, not a guard.
 */
export function assertConfirmName(kind: string, actualName: string, confirmName: string): void {
  if (actualName !== confirmName) {
    throw new ClickUpUsageError(`confirm_name "${confirmName}" does not match ${kind} name "${actualName}"`)
  }
}
