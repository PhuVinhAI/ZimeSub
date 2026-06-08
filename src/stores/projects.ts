import { projectSetSelectedTrack } from '@api/mkv_probe'
import {
  projectAddEpisodes,
  projectCreate,
  projectListRecents,
  projectOpen,
  projectRemoveRecent,
  type AddEpisodesOutcome,
  type ProjectJson,
  type RecentProjectStatus
} from '@api/projects'
import { pushDangerToast, pushWarnToast } from '@lib/toast/toastStore'
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
export async function createNewProject(
  folder: string,
  name: string
): Promise<ProjectJson> {
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

/**
 * Filter `paths` to those ending in `.mkv` (case-insensitive). Used by
 * both drag-drop and the multi-file picker so the AC's per-file
 * extension validation lives in exactly one place.
 *
 * Returned `accepted` preserves the input order; `rejected` is the list
 * of basenames (NOT full paths) that failed the check, so the toast
 * text can name the offending file without leaking absolute paths the
 * user may not want flashed across the screen.
 */
export interface ExtensionPartition {
  accepted: string[]
  rejected: string[]
}

export function partitionMkvPaths(paths: string[]): ExtensionPartition {
  const accepted: string[] = []
  const rejected: string[] = []
  for (const p of paths) {
    const lower = p.toLowerCase()
    if (lower.endsWith('.mkv')) {
      accepted.push(p)
    } else {
      rejected.push(basenameOf(p))
    }
  }
  return { accepted, rejected }
}

/**
 * Append Episodes to the currently open project from a flat list of
 * source-MKV paths (typically produced by drag-drop or the "Thêm
 * Episode…" multi-file picker).
 *
 * Surfaces three classes of feedback:
 *  - **Red toast** per non-`.mkv` entry: AC string "Chỉ chấp nhận file
 *    .mkv". Valid siblings in the same drop are NOT aborted — see AC.
 *  - **Yellow toast** per duplicate `source_mkv_path`: AC string
 *    "Episode này đã có trong project". Backend reports duplicates in
 *    the `AddEpisodesOutcome.duplicates` list.
 *  - **Red toast** with the raw error message on backend failure (e.g.
 *    folder write rejected, manifest unwritable).
 *
 * Returns the outcome for any caller that wants to log it; UI consumers
 * can ignore the return because all user-visible feedback flows through
 * toasts and the in-memory `active` state.
 */
export async function addEpisodes(paths: string[]): Promise<AddEpisodesOutcome | null> {
  const folder = state.activeFolder
  if (!folder) return null

  const { accepted, rejected } = partitionMkvPaths(paths)
  for (const name of rejected) {
    pushDangerToast(`Chỉ chấp nhận file .mkv (đã bỏ qua "${name}")`)
  }
  if (accepted.length === 0) return null

  try {
    const outcome = await projectAddEpisodes(folder, accepted)
    setState({ active: outcome.project })
    for (const dup of outcome.duplicates) {
      pushWarnToast(`Episode này đã có trong project: ${basenameOf(dup)}`)
    }
    return outcome
  } catch (err) {
    pushDangerToast(`Không thêm được Episode: ${messageOf(err)}`)
    return null
  }
}

/**
 * Persist the user's track pick for `episodeId` from the track-picker
 * modal (slice 0006). Updates `state.active` from the backend's
 * post-write `ProjectJson` so the Episode row re-renders with the
 * language tag in the same tick the modal closes.
 *
 * Throws on backend failure so the caller (modal) can keep the modal
 * open and re-render the previous phase — failure also flips a danger
 * toast so the user has ambient feedback even after they dismiss.
 */
export async function setEpisodeSelectedTrack(
  episodeId: string,
  trackId: number,
  language: string | null
): Promise<void> {
  const folder = state.activeFolder
  if (!folder) return
  try {
    const project = await projectSetSelectedTrack(folder, episodeId, trackId, language)
    setState({ active: project })
  } catch (err) {
    pushDangerToast(`Không lưu được track: ${messageOf(err)}`)
    throw err instanceof Error ? err : new Error(messageOf(err))
  }
}

/**
 * Last path segment of `p`, with both Windows backslash and forward
 * slash treated as separators. Mirrors the helper used by `Sidebar.tsx`
 * — kept local to avoid leaking a path util into a shared module before
 * it's needed in more than two places.
 */
function basenameOf(p: string): string {
  const normalised = p.replace(/[\\/]+$/, '')
  const idx = Math.max(normalised.lastIndexOf('\\'), normalised.lastIndexOf('/'))
  return idx >= 0 ? normalised.slice(idx + 1) : normalised
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
