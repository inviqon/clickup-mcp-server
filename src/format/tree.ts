import type { ListSummaryOut, WorkspaceTree } from '../clickup/endpoints/workspace.js'
import { nameWithId } from './common.js'

function renderListLine(list: ListSummaryOut): string {
  const count = list.task_count !== undefined ? ` - ${list.task_count} task(s)` : ''
  return `  - ${nameWithId(list.name, list.id)}${count}`
}

/**
 * Renders a `WorkspaceTree` as an indented markdown outline. Folderless
 * lists are rendered under their own "Lists (no folder)" heading, directly
 * on the space, rather than nested under a folder heading - inventing a
 * folder for them would misrepresent the workspace structure.
 */
export function renderWorkspaceTree(tree: WorkspaceTree): string {
  const lines: string[] = [`# Workspace Tree (team ${tree.team_id})`]

  for (const space of tree.spaces) {
    lines.push('', `## ${nameWithId(space.name, space.id)}`)

    if (space.folders.length > 0) {
      lines.push('', '**Folders**')
      for (const folder of space.folders) {
        lines.push(`- ${nameWithId(folder.name, folder.id)}`)
        for (const list of folder.lists) {
          lines.push(renderListLine(list))
        }
      }
    }

    if (space.lists.length > 0) {
      lines.push('', '**Lists (no folder)**')
      for (const list of space.lists) {
        lines.push(renderListLine(list))
      }
    }
  }

  return lines.join('\n')
}
