import {
  episodeInspectArtifacts,
  extractAudioStart,
  extractSubtitleStart,
  type EpisodeArtifactsView
} from '@api/extract'
import {
  jobCancel,
  jobRemovePending,
  jobSnapshot,
  onJobProgress,
  onJobsChanged,
  type JobKind,
  type JobProgressEvent,
  type JobsSnapshot,
  type JobView
} from '@api/jobs'
import {
  ENCODER_LABELS,
  renderStart,
  type EncoderKey,
  type RenderStartOutcome
} from '@api/render'
import { pushDangerToast, pushWarnToast } from '@lib/toast/toastStore'
import { DEFAULT_EXTRACT_CONCURRENCY } from '@stores/settings'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { createMemo } from 'solid-js'
import { createStore, produce } from 'solid-js/store'

/**
 * Slice 0008 JobsStore.
 *
 * Promotes the slice-0007 per-Episode signal into a global,
 * project-aware queue mirror that drives:
 *  - The bottom status bar's live `JOBS ●●○○○ / X/Y / top-job` row.
 *  - The expandable Jobs panel (pending/running/done/failed lists).
 *  - The per-Episode badge/progress derivation in `ProjectView`.
 *
 * State sources:
 *  - {@link jobsStore.jobs}: full `JobView[]` mirrored from the
 *    backend, replaced wholesale on every `jobs-changed` event.
 *  - {@link jobsStore.artifacts}: disk-artefact snapshot keyed by
 *    Episode.id. Refreshed on project open + after each job-done.
 *  - {@link jobsStore.dontAskOverwrite}: session-only memory of the
 *    overwrite-confirm checkbox.
 *  - {@link jobsStore.activeFolder}: the current project the
 *    artefact cache + don't-ask memory are scoped to.
 *
 * The store subscribes to `jobs-changed` (full snapshot replace) +
 * `job-progress` (per-line ratio/hint patch) and stays in sync with
 * the backend with no polling.
 */

/**
 * Phase machine for the per-Episode extract job — derived view used
 * by `ProjectView`'s `EpisodeRow` and the Extract error modal.
 *
 * Replaces slice 0007's standalone phase signal: now computed from
 * the global jobs list, scoped to the *latest* job for the
 * Episode + the current project folder. The mapping is:
 *
 *  - `pending`   → `queued`
 *  - `running`   → `running`
 *  - `done`      → `success`
 *  - `failed`    → `failed`
 *  - `cancelled` → `cancelled`
 */
export type ExtractJobPhase = 'queued' | 'running' | 'success' | 'failed' | 'cancelled'

/** Derived per-Episode extract-job summary. */
export interface EpisodeJobState {
  jobId: string | null
  phase: ExtractJobPhase | null
  ratio: number
  hint: string
  stderr: string
  error: string | null
  exitCode: number | null
}

const EMPTY_JOB_STATE: EpisodeJobState = {
  jobId: null,
  phase: null,
  ratio: 0,
  hint: '',
  stderr: '',
  error: null,
  exitCode: null
}

export interface EpisodeArtifactState {
  hasExtractedSub: boolean
  hasExtractedAudio: boolean
  hasTranslationDraft: boolean
  hasTranslatedSub: boolean
  hasRender: boolean
  /** True when the rendered MP4 exists but is older than the
   *  TranslatedSub — drives the yellow "Render lỗi thời" badge. */
  isRenderStale: boolean
  /** True when this Episode's source MKV no longer resolves on disk —
   *  drives the red "MKV gốc không tìm thấy" badge + disables
   *  Extract / Render buttons. Slice 0012. */
  isSourceMissing: boolean
  audioExtension: string
  outputBasename: string
}

interface JobsStoreShape {
  /**
   * Full global queue mirror — replaced wholesale on every
   * `jobs-changed` event. Ordered newest-first to match the panel
   * layout; the status-bar selectors pick off this list directly.
   */
  jobs: JobView[]
  /**
   * Backend's current `queue_concurrency_extract` — echoed alongside
   * the jobs list on every snapshot so the status bar's "●●○○○"
   * indicator stays in sync without a second IPC roundtrip.
   */
  extractConcurrency: number
  /** Disk artefacts cache keyed by Episode.id. */
  artifacts: Record<string, EpisodeArtifactState>
  /** Session-only "Không hỏi lại cho Episode này" set for the
   *  subtitle overwrite-confirm modal. */
  dontAskOverwrite: Record<string, boolean>
  /** Session-only don't-ask memory scoped to the audio overwrite-confirm modal. */
  dontAskAudioOverwrite: Record<string, boolean>
  /** Project folder this snapshot belongs to (for cancel-on-project-switch). */
  activeFolder: string | null
}

const [state, setState] = createStore<JobsStoreShape>({
  jobs: [],
  extractConcurrency: DEFAULT_EXTRACT_CONCURRENCY,
  artifacts: {},
  dontAskOverwrite: {},
  dontAskAudioOverwrite: {},
  activeFolder: null
})

export const jobsStore = state

/* -------------------------------------------------------------------------- */
/* Derived selectors                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Status of the queue rolled up for the bottom status bar. Counts
 * are computed from the live jobs list so they update in lockstep
 * with the backend snapshot.
 */
export const queueSummary = createMemo(() => {
  const pending = state.jobs.filter(j => j.status === 'pending').length
  const running = state.jobs.filter(j => j.status === 'running').length
  const total = state.jobs.length
  return { pending, running, total }
})

/**
 * The job the status bar's progress slot focuses on. Picks the
 * newest Running job; falls back to newest Pending; `null` when the
 * queue is empty / terminal.
 */
export const topRunningJob = createMemo<JobView | null>(() => {
  const running = state.jobs.find(j => j.status === 'running')
  if (running) return running
  const pending = state.jobs.find(j => j.status === 'pending')
  return pending ?? null
})

/**
 * Derived per-Episode extract state for a given JobKind. Walks the
 * global list for the Episode's most recent job of that kind (the
 * snapshot is newest-first so the first match is the right one) and
 * projects it onto the {@link EpisodeJobState} the row template
 * already knows how to render.
 *
 * Slice 0009 generalises the slice 0007 helper from
 * subtitle-only to any [`JobKind`] — the EpisodeRow now consults the
 * derived state for `extract_subtitle` and `extract_audio`
 * independently so the two buttons can each show their own progress
 * bar / error badge.
 */
export function jobStateFor(
  episodeId: string,
  kind: JobKind = 'extract_subtitle'
): EpisodeJobState {
  const job = state.jobs.find(j => j.episode_id === episodeId && j.kind === kind)
  if (!job) return EMPTY_JOB_STATE
  return {
    jobId: job.id,
    phase: statusToPhase(job.status),
    ratio: job.ratio,
    hint: job.hint,
    stderr: job.stderr,
    error: job.error,
    exitCode: job.exit_code
  }
}

function statusToPhase(status: JobView['status']): ExtractJobPhase {
  switch (status) {
    case 'pending':
      return 'queued'
    case 'running':
      return 'running'
    case 'done':
      return 'success'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
  }
}

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

/**
 * Same as {@link shouldConfirmOverwrite} but for the audio artefact.
 * Surfaces the audio-overwrite-confirm modal when the configured
 * codec's file already exists on disk and the user hasn't toggled
 * "Không hỏi lại" for this Episode this session.
 */
export function shouldConfirmAudioOverwrite(episodeId: string): boolean {
  const artifacts = state.artifacts[episodeId]
  if (!artifacts) return false
  if (!artifacts.hasExtractedAudio) return false
  return !state.dontAskAudioOverwrite[episodeId]
}

/* -------------------------------------------------------------------------- */
/* Mutating actions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Enqueue a fresh extract job for `episodeId`. Generates the
 * `job_id`, dispatches the backend command; the backend then emits
 * `jobs-changed` so the row picks up the new Pending entry on the
 * next event.
 *
 * Idempotent for back-to-back clicks on the same Episode while a
 * job is already in flight — the second click is a no-op so the
 * user can't accidentally double-enqueue.
 */
export async function startExtractSubtitle(episodeId: string): Promise<void> {
  const folder = state.activeFolder
  if (!folder) return
  const existing = state.jobs.find(
    j =>
      j.episode_id === episodeId &&
      j.kind === 'extract_subtitle' &&
      (j.status === 'pending' || j.status === 'running')
  )
  if (existing) return
  const jobId = newJobId()
  try {
    await extractSubtitleStart(jobId, folder, episodeId)
  } catch (err) {
    const message = messageOf(err)
    pushDangerToast(`Không khởi chạy được extract: ${message}`)
  }
}

/**
 * Cancel the in-flight extract job for `episodeId` (queued or
 * running). The backend handles process-tree kill + per-kind
 * cleanup; the local store reflects the change on the next
 * `jobs-changed` event.
 */
export async function cancelExtractSubtitle(episodeId: string): Promise<void> {
  const job = state.jobs.find(
    j =>
      j.episode_id === episodeId &&
      j.kind === 'extract_subtitle' &&
      (j.status === 'pending' || j.status === 'running')
  )
  if (!job) return
  try {
    await jobCancel(job.id)
  } catch (err) {
    pushDangerToast(`Không hủy được job: ${messageOf(err)}`)
  }
}

/**
 * Enqueue a fresh audio extract job for `episodeId`. Slice 0009.
 *
 * Independent of the subtitle stage — the only failure surface here
 * is a missing ffmpeg path or a project / episode lookup failure
 * (both flow through to a danger toast). Idempotent for back-to-
 * back clicks on the same Episode while an audio job is already in
 * flight.
 */
export async function startExtractAudio(episodeId: string): Promise<void> {
  const folder = state.activeFolder
  if (!folder) return
  const existing = state.jobs.find(
    j =>
      j.episode_id === episodeId &&
      j.kind === 'extract_audio' &&
      (j.status === 'pending' || j.status === 'running')
  )
  if (existing) return
  const jobId = newJobId()
  try {
    await extractAudioStart(jobId, folder, episodeId)
  } catch (err) {
    const message = messageOf(err)
    pushDangerToast(`Không khởi chạy được audio: ${message}`)
  }
}

/**
 * Cancel the in-flight audio extract job for `episodeId`. Backend
 * kills the ffmpeg child and the cleanup pass removes the partial
 * `<basename>.<ext>` from the EpisodeFolder.
 */
export async function cancelExtractAudio(episodeId: string): Promise<void> {
  const job = state.jobs.find(
    j =>
      j.episode_id === episodeId &&
      j.kind === 'extract_audio' &&
      (j.status === 'pending' || j.status === 'running')
  )
  if (!job) return
  try {
    await jobCancel(job.id)
  } catch (err) {
    pushDangerToast(`Không hủy được job: ${messageOf(err)}`)
  }
}

/** Session-only memory of which `(configured → fallback)` pairs have
 *  already triggered the warn toast. Per AC: "show a one-time toast"
 *  — once per pair per session, not once per Episode. */
const encoderFallbackToastShown = new Set<string>()

/**
 * Enqueue a fresh `Render` job for `episodeId`. Slice 0011.
 *
 * Idempotent for back-to-back clicks while a render job is already
 * in flight; per ADR-0003 the queue itself only allows 1 Render
 * Running at a time so a second click on a different Episode just
 * queues — only same-Episode duplicates are filtered here.
 *
 * Surfaces the AC's encoder-fallback warn toast when the backend
 * reports `fallback_from != null`. The toast fires exactly once per
 * (configured, chosen) pair per session.
 */
export async function startRender(episodeId: string): Promise<void> {
  const folder = state.activeFolder
  if (!folder) return
  const existing = state.jobs.find(
    j =>
      j.episode_id === episodeId &&
      j.kind === 'render' &&
      (j.status === 'pending' || j.status === 'running')
  )
  if (existing) return
  const jobId = newJobId()
  try {
    const outcome: RenderStartOutcome = await renderStart(jobId, folder, episodeId)
    if (outcome.fallback_from) {
      maybeWarnEncoderFallback(outcome.fallback_from, outcome.chosen_encoder)
    }
  } catch (err) {
    pushDangerToast(`Không khởi chạy được render: ${messageOf(err)}`)
  }
}

/**
 * Cancel the in-flight render job for `episodeId`. The backend
 * kills the ffmpeg child and the cleanup pass removes the partial
 * `<basename>.VietSub.mp4` from the EpisodeFolder.
 */
export async function cancelRender(episodeId: string): Promise<void> {
  const job = state.jobs.find(
    j =>
      j.episode_id === episodeId &&
      j.kind === 'render' &&
      (j.status === 'pending' || j.status === 'running')
  )
  if (!job) return
  try {
    await jobCancel(job.id)
  } catch (err) {
    pushDangerToast(`Không hủy được job: ${messageOf(err)}`)
  }
}

function maybeWarnEncoderFallback(from: EncoderKey, to: EncoderKey): void {
  const key = `${from}->${to}`
  if (encoderFallbackToastShown.has(key)) return
  encoderFallbackToastShown.add(key)
  const fromLabel = ENCODER_LABELS[from] ?? from
  const toLabel = ENCODER_LABELS[to] ?? to
  pushWarnToast(`Encoder ${fromLabel} không khả dụng trên máy này, dùng ${toLabel}`)
}

/**
 * Cancel by raw job id — used by the Jobs panel where the row
 * already knows its `JobView`. Same semantics as the per-Episode
 * variant; kept as a separate entry point so callers don't have to
 * read the store again.
 */
export async function cancelJobById(jobId: string): Promise<void> {
  try {
    await jobCancel(jobId)
  } catch (err) {
    pushDangerToast(`Không hủy được job: ${messageOf(err)}`)
  }
}

/**
 * Remove a Pending job from the queue — no process kill, no on-disk
 * cleanup. Used by the Jobs panel's "Xóa" affordance on Pending
 * rows. Running / terminal rows ignore the call on the backend
 * side, but the panel hides the button on them anyway.
 */
export async function removePendingJobById(jobId: string): Promise<void> {
  try {
    await jobRemovePending(jobId)
  } catch (err) {
    pushDangerToast(`Không xóa được job: ${messageOf(err)}`)
  }
}

/**
 * Retry a previously-failed job. The backend cannot resurrect the
 * terminal record so we enqueue a fresh job of the same kind for
 * the same Episode; the old Failed row stays in the panel for the
 * session per AC.
 */
export async function retryJob(job: JobView): Promise<void> {
  const folder = state.activeFolder
  if (!folder || folder.toLowerCase() !== job.project_folder.toLowerCase()) {
    // The job belongs to a different project — open it first so the
    // user lands on the relevant context before the new job runs.
    // We don't await the open here; the caller (Jobs panel)
    // coordinates the navigation.
    return
  }
  if (job.kind === 'extract_subtitle') {
    await startExtractSubtitle(job.episode_id)
  } else if (job.kind === 'extract_audio') {
    await startExtractAudio(job.episode_id)
  } else if (job.kind === 'render') {
    await startRender(job.episode_id)
  }
}

/**
 * Drop one Episode's transient job memory (success / cancelled rows
 * older than the latest snapshot tick). Used by the Extract error
 * modal after the user dismisses; the matching Failed row in the
 * global panel is left alone per AC ("Done/Failed jobs persist for
 * the lifetime of the app session").
 *
 * Implemented as a no-op for slice 0008: the per-Episode badge
 * derivation now consults the global list, and the Failed entry is
 * the only thing keeping the red badge visible — leaving it in
 * place is exactly the intended behaviour. The function is kept for
 * source-compat with slice-0007 callers (the `episodeId` parameter
 * is intentionally unused).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function clearJobState(episodeId: string): void {
  // No-op — see docstring.
}

export function rememberDontAskOverwrite(episodeId: string): void {
  setState('dontAskOverwrite', episodeId, true)
}

export function rememberDontAskAudioOverwrite(episodeId: string): void {
  setState('dontAskAudioOverwrite', episodeId, true)
}

/* -------------------------------------------------------------------------- */
/* Disk-artefact cache                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Bind the store to a fresh active project. Drops every per-
 * Episode signal from the previous project (artifacts, don't-ask
 * memory) so a project switch starts the badges fresh, then
 * refreshes the artefact cache for every Episode in the new
 * project. The global `jobs` list is left alone — done/failed rows
 * from other projects stay visible in the panel per AC.
 */
export async function setActiveProject(
  folder: string,
  episodeIds: string[]
): Promise<void> {
  setState({
    activeFolder: folder,
    artifacts: {},
    dontAskOverwrite: {},
    dontAskAudioOverwrite: {}
  })
  await Promise.all(
    episodeIds.map(async id => {
      try {
        const view = await episodeInspectArtifacts(folder, id)
        applyArtifactSnapshot(id, view)
      } catch {
        // Best-effort.
      }
    })
  )
}

/**
 * Re-inspect the disk for one Episode and update the cache. Called
 * after each `jobs-changed` snapshot that flipped a job to a
 * terminal status, so the row's badge keeps up with completed
 * extracts.
 */
export async function refreshArtifactsForEpisode(episodeId: string): Promise<void> {
  const folder = state.activeFolder
  if (!folder) return
  try {
    const view = await episodeInspectArtifacts(folder, episodeId)
    applyArtifactSnapshot(episodeId, view)
  } catch {
    // Silent skip.
  }
}

function applyArtifactSnapshot(episodeId: string, view: EpisodeArtifactsView): void {
  setState('artifacts', episodeId, {
    hasExtractedSub: view.has_extracted_sub,
    hasExtractedAudio: view.has_extracted_audio,
    hasTranslationDraft: view.has_translation_draft,
    hasTranslatedSub: view.has_translated_sub,
    hasRender: view.has_render,
    isRenderStale: view.is_render_stale,
    isSourceMissing: view.is_source_missing,
    audioExtension: view.audio_extension,
    outputBasename: view.output_basename
  })
}

/* -------------------------------------------------------------------------- */
/* Event subscriptions                                                        */
/* -------------------------------------------------------------------------- */

let jobSubscriptionsHandle: {
  unlistenChanged: UnlistenFn
  unlistenProgress: UnlistenFn
} | null = null
let jobSubscriptionsPromise: Promise<void> | null = null

/**
 * Idempotent bootstrap — installs the two backend event
 * subscriptions the global jobs mirror needs:
 *  - `jobs-changed`: replace the full list.
 *  - `job-progress`: patch the per-line ratio/hint of one row.
 *
 * Also pulls the initial snapshot so the UI mounts with the live
 * state (otherwise a status-bar that mounts mid-job would briefly
 * show "không có job" until the next event).
 */
export async function ensureJobSubscriptions(): Promise<void> {
  if (jobSubscriptionsHandle) return
  if (jobSubscriptionsPromise) return jobSubscriptionsPromise

  jobSubscriptionsPromise = (async () => {
    const unlistenChanged = await onJobsChanged(handleSnapshot)
    const unlistenProgress = await onJobProgress(handleProgress)
    jobSubscriptionsHandle = { unlistenChanged, unlistenProgress }
    try {
      const snapshot = await jobSnapshot()
      handleSnapshot(snapshot)
    } catch {
      // The lazy `AppState::jobs` init resolves a backend handle on
      // first call; the rare error here means the IPC isn't ready.
      // Snapshot will arrive via the next `jobs-changed` event.
    }
  })()

  return jobSubscriptionsPromise
}

function handleSnapshot(snapshot: JobsSnapshot): void {
  // Capture the set of episode_ids that flipped to terminal in this
  // tick so we can re-inspect the disk for each — the AC requires
  // the row badge to update the moment the job completes.
  const previousById = new Map(state.jobs.map(j => [j.id, j]))
  const terminalEpisodeIds = new Set<string>()
  for (const job of snapshot.jobs) {
    const prev = previousById.get(job.id)
    const wasNonTerminal = !prev || prev.status === 'pending' || prev.status === 'running'
    const isTerminal =
      job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'
    if (wasNonTerminal && isTerminal) {
      terminalEpisodeIds.add(job.episode_id)
    }
  }

  setState({
    jobs: snapshot.jobs,
    extractConcurrency: snapshot.extract_concurrency
  })

  for (const episodeId of terminalEpisodeIds) {
    void refreshArtifactsForEpisode(episodeId)
  }
}

function handleProgress(event: JobProgressEvent): void {
  // The full-snapshot stream emits on every structural change so
  // job entries always exist by the time progress events arrive;
  // we mutate in-place via `produce` to avoid recreating the array
  // for every parsed stderr line.
  setState(
    'jobs',
    produce(jobs => {
      const job = jobs.find(j => j.id === event.job_id)
      if (!job) return
      job.ratio = event.ratio
      job.hint = event.hint
    })
  )
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
