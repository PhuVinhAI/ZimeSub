import {
  projectCreate,
  projectListRecents,
  projectOpen,
  projectRemoveRecent,
  type ProjectJson,
  type RecentProjectStatus
} from '@api/projects'
import { createStore } from 'solid-js/store'

/**
 * Project-store phases:
 *
 * - `idle`:    no project open and no operation in flight.
 * - `loading`: an open/create round-trip to the backend is in progress.
 * - `loaded`:  `active` and `activeFolder` are populated and reflect the
 *              latest `zimesub.json` content.
 * - `error`:   the previous open/create failed; `error` holds the message.
 */
export type ProjectsPhase = 'idle' | 'loading' | 'loaded' | 'error'

interface ProjectsStoreShape {
  phase: ProjectsPhase
  active: ProjectJson | null
  activeFolder: string | null
  recents: RecentProjectStatus[]
  error: string | null
  bootstrapped: boolean
}

const [state, setState] = createStore<ProjectsStoreShape>({
  phase: 'idle',
  active: null,
  activeFolder: null,
  recents: [],
  error: null,
  bootstrapped: false
})

export const projectsStore = state

/**
 * Refresh `recents` from the backend. Backend returns most-recent-first,
 * enriched with `folder_exists` / `has_zimesub_json` / `name`.
 */
export async function refreshRecents(): Promise<void> {
  try {
    const recents = await projectListRecents()
    setState({ recents })
  } catch (err) {
    setState({ error: messageOf(err) })
  }
}

/**
 * Post-Onboarding bootstrap: load the recent list and, if non-empty,
 * auto-open the most recent valid project. A recent row whose folder
 * was deleted or whose `zimesub.json` was removed is skipped — the user
 * is shown the empty state instead, and the row stays in the Sidebar
 * with a "Không tìm thấy" badge so they can remove it manually.
 *
 * Idempotent: a second call no-ops once `bootstrapped` flips to true.
 */
export async function bootstrapActiveProject(): Promise<void> {
  if (state.bootstrapped) return
  setState({ bootstrapped: true })
  await refreshRecents()
  const candidate = state.recents.find(r => r.folder_exists && r.has_zimesub_json)
  if (candidate) {
    await openProjectByPath(candidate.path)
  }
}

/**
 * Open the project at `folder`, set it as active, and refresh the
 * recents list (the backend bumps it to the head). On failure the
 * recent entry is left in place so the user can retry or remove it via
 * the "Gỡ" affordance.
 */
export async function openProjectByPath(folder: string): Promise<void> {
  setState({ phase: 'loading', error: null })
  try {
    const project = await projectOpen(folder)
    setState({
      phase: 'loaded',
      active: project,
      activeFolder: folder,
      error: null
    })
    await refreshRecents()
  } catch (err) {
    setState({
      phase: 'error',
      error: messageOf(err)
    })
    // Refresh anyway so any liveness flag (folder vanished, manifest
    // deleted) is reflected on the Sidebar row immediately.
    await refreshRecents()
  }
}

/**
 * Create a new project (`zimesub.json` + bump to recents head) and make
 * it the active project. Rejects with the raw error message so the
 * Create Project modal can render it inline; the store also persists
 * it via `phase = 'error'` for any other observers.
 */
export async function createNewProject(folder: string, name: string): Promise<ProjectJson> {
  setState({ phase: 'loading', error: null })
  try {
    const project = await projectCreate(folder, name)
    setState({
      phase: 'loaded',
      active: project,
      activeFolder: folder,
      error: null
    })
    await refreshRecents()
    return project
  } catch (err) {
    const message = messageOf(err)
    setState({ phase: 'error', error: message })
    throw new Error(message, { cause: err })
  }
}

/**
 * Drop `folder` from the `recent_projects` MRU list. If the removed
 * row is the active project, also clear `active` so the Main view
 * falls back to the empty state.
 */
export async function removeRecent(folder: string): Promise<void> {
  try {
    await projectRemoveRecent(folder)
    await refreshRecents()
    if (state.activeFolder && pathsEqual(state.activeFolder, folder)) {
      setState({
        active: null,
        activeFolder: null,
        phase: 'idle'
      })
    }
  } catch (err) {
    setState({ error: messageOf(err) })
  }
}

/**
 * Close the active project — useful if the user wants to return to the
 * empty state. The recents list is untouched.
 */
export function closeActiveProject(): void {
  setState({
    active: null,
    activeFolder: null,
    phase: 'idle',
    error: null
  })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Case-insensitive ASCII path compare — Windows file systems are
 * case-insensitive, so the backend treats `C:\foo` and `c:\FOO` as the
 * same recent entry. We mirror that here so the active-row highlight
 * matches even after a backend round-trip normalises casing.
 */
function pathsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
