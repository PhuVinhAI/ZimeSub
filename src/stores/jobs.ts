import {
  episodeInspectArtifacts,
  extractSubtitleCancel,
  extractSubtitleStart,
  onJobDone,
  onJobProgress,
  onJobStarted,
  type EpisodeArtifactsView,
  type JobDoneEvent,
  type JobProgressEvent,
  type JobStartedEvent
} from '@api/extract'
import { pushDangerToast } from '@lib/toast/toastStore'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { createStore, produce } from 'solid-js/store'

/**
 * Slice 0007 JobsStore.
 *
 * Holds the live snapshot of background-job state per Episode plus
 * the cached disk-artefact snapshot the Episode row badge derives
 * from. Subscribes once per app instance to the three backend
 * events (`job-started` / `job-progress` / `job-done`) and drives
 * state purely from those callbacks — there is no polling.
 *
 * Per-Episode shape:
 *  * `EpisodeJobState`        — extract-subtitle job phase + ratio +
 *                               stderr buffer (for the failure
 *                               modal). One entry per Episode that
 *                               has run an extract this session.
 *  * `EpisodeArtifactState`   — disk artefacts snapshot. Refreshed
 *                               on project open + after each
 *                               `job-done` for the Episode.
 *  * `dontAskOverwriteByEpisode` — session-only memory of the
 *                               "Không hỏi lại cho Episode này"
 *                               checkbox on the overwrite-confirm
 *                               modal (per the slice 0007 AC).
 *
 * The store is autonomous: it doesn't import the projects store
 * (projects store is the source of truth for the active project,
 * the AppShell bridges between them by calling
 * `setActiveProject(folder, episodes)` when `projectsStore.active`
 * changes).
 */

/**
 * Phase machine for one Episode's extract-subtitle job. Mirrors the
 * three backend events plus the `queued` state before backend ack:
 *  - `queued`:    `extractSubtitleStart` invoked, awaiting `job-started`.
 *  - `running`:   `job-started` received; progress bar visible.
 *  - `success`:   `job-done` received with `success: true`. Cleared
 *                 after the row's badge refreshes from disk.
 *  - `failed`:    `job-done` with `success: false && !cancelled`.
 *                 Stays sticky until the user dismisses the error
 *                 modal so the red "Lỗi extract" badge persists.
 *  - `cancelled`: `job-done` with `cancelled: true`. Transient —
 *                 cleared on next user action so the row resets.
 */
export type ExtractJobPhase = 'queued' | 'running' | 'success' | 'failed' | 'cancelled'

/**
 * Per-Episode extract-job snapshot. `null` slots stay until the
 * Episode runs its first extract this session; clearing back to
 * `null` is the same as "row is in its disk-only state".
 */
export interface EpisodeJobState {
  jobId: string | null
  phase: ExtractJobPhase | null
  ratio: number
  hint: string
  /** Sticky stderr buffer kept around for the failure-modal viewer. */
  stderr: string
  /** Backend-supplied Vietnamese error string on the failure path. */
  error: string | null
  exitCode: number | null
}

/** Pristine "no job has run yet" snapshot. */
const EMPTY_JOB_STATE: EpisodeJobState = {
  jobId: null,
  phase: null,
  ratio: 0,
  hint: '',
  stderr: '',
  error: null,
  exitCode: null
}

/**
 * Per-Episode disk artefacts cache. Refreshed via
 * `episode_inspect_artifacts` on project open + after each
 * `job-done` for the Episode (so the row's badge flips to "Đã
 * extract" the moment mkvextract finishes, per the AC's
 * "EpisodeState is recomputed from disk" requirement).
 */
export interface EpisodeArtifactState {
  hasExtractedSub: boolean
  /** Echo of the EpisodeFolder name — matches `<basename>.eng.ass` prefix. */
  outputBasename: string
}

interface JobsStoreShape {
  /** Live extract-job state keyed by Episode.id. */
  jobs: Record<string, EpisodeJobState>
  /** Disk artefacts cache keyed by Episode.id. */
  artifacts: Record<string, EpisodeArtifactState>
  /** Session-only "Không hỏi lại cho Episode này" set. */
  dontAskOverwrite: Record<string, boolean>
  /** Project folder this snapshot belongs to (for cancel-on-project-switch). */
  activeFolder: string | null
}

const [state, setState] = createStore<JobsStoreShape>({
  jobs: {},
  artifacts: {},
  dontAskOverwrite: {},
  activeFolder: null
})

export const jobsStore = state

/* -------------------------------------------------------------------------- */
/* Selectors                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `EpisodeJobState` for `episodeId`, or the pristine "no job has run"
 * snapshot when the Episode hasn't been touched this session. Always
 * returns a non-null record so callers don't have to defensively
 * null-check before reading `phase` / `ratio` / etc.
 */
export function jobStateFor(episodeId: string): EpisodeJobState {
  return state.jobs[episodeId] ?? EMPTY_JOB_STATE
}

/**
 * `EpisodeArtifactState` for `episodeId`, or `null` when the
 * artefact cache hasn't been populated yet (typically a brief
 * window during project bootstrap).
 */
export function artifactStateFor(episodeId: string): EpisodeArtifactState | null {
  return state.artifacts[episodeId] ?? null
}

/**
 * `true` when the Episode already has `<basename>.eng.ass` on disk
 * AND the user hasn't toggled the "Không hỏi lại" checkbox for this
 * Episode this session. The "Trích xuất sub" button surfaces the
 * overwrite-confirm modal on click iff this returns `true`.
 */
export function shouldConfirmOverwrite(episodeId: string): boolean {
  const artifacts = state.artifacts[episodeId]
  if (!artifacts) return false
  if (!artifacts.hasExtractedSub) return false
  return !state.dontAskOverwrite[episodeId]
}

/* -------------------------------------------------------------------------- */
/* Mutating actions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Enqueue a fresh extract job for `episodeId`. Generates the
 * `job_id`, flips the local phase to `queued`, and dispatches the
 * backend command. Progress + completion arrive via the event
 * handlers installed in {@link ensureJobSubscriptions}.
 *
 * Idempotent for back-to-back clicks on the same Episode while a
 * job is already in flight — the second click is a no-op so the
 * user can't accidentally double-enqueue. The button is also
 * disabled in the UI for the same reason; this guard is the
 * defence-in-depth backstop.
 */
export async function startExtractSubtitle(episodeId: string): Promise<void> {
  const folder = state.activeFolder
  if (!folder) return
  const existing = state.jobs[episodeId]
  if (existing && (existing.phase === 'queued' || existing.phase === 'running')) {
    return
  }
  const jobId = newJobId()
  setState('jobs', episodeId, () => ({
    jobId,
    phase: 'queued',
    ratio: 0,
    hint: '',
    stderr: '',
    error: null,
    exitCode: null
  }))
  try {
    await extractSubtitleStart(jobId, folder, episodeId)
  } catch (err) {
    const message = messageOf(err)
    pushDangerToast(`Không khởi chạy được extract: ${message}`)
    setState('jobs', episodeId, prev => ({
      ...(prev ?? EMPTY_JOB_STATE),
      jobId: null,
      phase: 'failed',
      error: message,
      stderr: ''
    }))
  }
}

/**
 * Cancel the in-flight extract job for `episodeId` (queued or
 * running). The backend kills the mkvextract child and the cleanup
 * pass deletes any partial output. The local phase flips to
 * `cancelled` when the `job-done` event with `cancelled: true`
 * arrives.
 */
export async function cancelExtractSubtitle(episodeId: string): Promise<void> {
  const job = state.jobs[episodeId]
  if (!job || !job.jobId) return
  try {
    await extractSubtitleCancel(job.jobId)
  } catch (err) {
    pushDangerToast(`Không hủy được job: ${messageOf(err)}`)
  }
}

/**
 * Drop the per-Episode job state — used after the user dismisses the
 * "Lỗi extract" modal or the "Đang trích xuất" cancellation toast.
 * Returns the Episode row to its disk-only state.
 */
export function clearJobState(episodeId: string): void {
  setState(
    'jobs',
    produce(jobs => {
      delete jobs[episodeId]
    })
  )
}

/**
 * Remember the user toggled "Không hỏi lại cho Episode này" on the
 * overwrite-confirm modal. Session-only — the AC's wording ("for
 * this Episode") doesn't imply cross-session persistence and adding
 * it to the project manifest would be a schema change for a
 * convenience flag. Cleared on project switch.
 */
export function rememberDontAskOverwrite(episodeId: string): void {
  setState('dontAskOverwrite', episodeId, true)
}

/* -------------------------------------------------------------------------- */
/* Disk-artefact cache                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Bind the store to a fresh active project. Drops every per-
 * Episode signal from the previous project (jobs, artifacts, don't-
 * ask memory) so a project switch starts the badges fresh, then
 * refreshes the artefact cache for every Episode in the new project.
 *
 * Called by AppShell from a `createEffect(on(() => projectsStore.active))`
 * watcher so the jobs store re-syncs whenever the user opens or
 * switches projects without the jobs store having to import the
 * projects store directly.
 */
export async function setActiveProject(
  folder: string,
  episodeIds: string[]
): Promise<void> {
  setState({
    activeFolder: folder,
    jobs: {},
    artifacts: {},
    dontAskOverwrite: {}
  })
  await Promise.all(
    episodeIds.map(async id => {
      try {
        const view = await episodeInspectArtifacts(folder, id)
        applyArtifactSnapshot(id, view)
      } catch {
        // Best-effort: a missing Episode row (e.g. removed in
        // another window) is silently skipped — the row's badge
        // falls back to "Trống" until the next refresh.
      }
    })
  )
}

/**
 * Re-inspect the disk for one Episode and update the cache. Called
 * after each `job-done` so the row's badge flips to "Đã extract"
 * the moment mkvextract finishes — without it the row would stay
 * "Đang trích xuất" until the next full project refresh.
 */
export async function refreshArtifactsForEpisode(episodeId: string): Promise<void> {
  const folder = state.activeFolder
  if (!folder) return
  try {
    const view = await episodeInspectArtifacts(folder, episodeId)
    applyArtifactSnapshot(episodeId, view)
  } catch {
    // Silent skip — same rationale as setActiveProject.
  }
}

function applyArtifactSnapshot(episodeId: string, view: EpisodeArtifactsView): void {
  setState('artifacts', episodeId, {
    hasExtractedSub: view.has_extracted_sub,
    outputBasename: view.output_basename
  })
}

/* -------------------------------------------------------------------------- */
/* Event subscriptions                                                        */
/* -------------------------------------------------------------------------- */

let jobSubscriptionsHandle: {
  unlistenStarted: UnlistenFn
  unlistenProgress: UnlistenFn
  unlistenDone: UnlistenFn
} | null = null
let jobSubscriptionsPromise: Promise<void> | null = null

/**
 * Idempotent bootstrap — installs the three backend event
 * subscriptions the JobsStore needs. Safe to call multiple times
 * (Solid double-mounts in dev) thanks to the singleton guards.
 *
 * Returns once the subscriptions are bound; AppShell awaits this
 * before opening the project view so no events fired between
 * project open and listener registration are lost.
 */
export async function ensureJobSubscriptions(): Promise<void> {
  if (jobSubscriptionsHandle) return
  if (jobSubscriptionsPromise) return jobSubscriptionsPromise

  jobSubscriptionsPromise = (async () => {
    const unlistenStarted = await onJobStarted(handleStarted)
    const unlistenProgress = await onJobProgress(handleProgress)
    const unlistenDone = await onJobDone(handleDone)
    jobSubscriptionsHandle = { unlistenStarted, unlistenProgress, unlistenDone }
  })()

  return jobSubscriptionsPromise
}

function handleStarted(event: JobStartedEvent): void {
  const current = state.jobs[event.episode_id]
  if (!current || current.jobId !== event.job_id) return
  setState('jobs', event.episode_id, prev => ({
    ...(prev ?? EMPTY_JOB_STATE),
    phase: 'running',
    ratio: 0,
    hint: ''
  }))
}

function handleProgress(event: JobProgressEvent): void {
  const current = state.jobs[event.episode_id]
  if (!current || current.jobId !== event.job_id) return
  setState('jobs', event.episode_id, prev => ({
    ...(prev ?? EMPTY_JOB_STATE),
    phase: 'running',
    ratio: event.ratio,
    hint: event.hint
  }))
}

function handleDone(event: JobDoneEvent): void {
  const current = state.jobs[event.episode_id]
  if (!current || current.jobId !== event.job_id) return

  const phase: ExtractJobPhase = event.cancelled
    ? 'cancelled'
    : event.success
      ? 'success'
      : 'failed'

  setState('jobs', event.episode_id, prev => ({
    ...(prev ?? EMPTY_JOB_STATE),
    phase,
    ratio: event.success ? 1 : (prev?.ratio ?? 0),
    stderr: event.stderr,
    error: event.error,
    exitCode: event.exit_code
  }))

  // Refresh the disk-artefact cache so the row's badge flips to
  // "Đã extract" the moment mkvextract finishes, per the AC. The
  // refresh is async but the success transition is independent —
  // the row's progress bar disappears as soon as the phase flips,
  // and the badge updates when the cache fills.
  void refreshArtifactsForEpisode(event.episode_id)

  // On success, clear the transient job state after a short tick so
  // the row settles into its disk-only "Đã extract" appearance. The
  // failure path keeps the state sticky so the red badge + modal
  // affordance persist until the user dismisses.
  if (phase === 'success' || phase === 'cancelled') {
    setTimeout(() => {
      const stillCurrent = state.jobs[event.episode_id]
      if (stillCurrent && stillCurrent.jobId === event.job_id) {
        clearJobState(event.episode_id)
      }
    }, 600)
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function newJobId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
