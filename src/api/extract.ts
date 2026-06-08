import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * TypeScript mirrors of the slice 0007 backend shapes:
 *  * `commands::EpisodeArtifactsView`
 *  * `job_queue::{StartedPayload, ProgressPayload, DonePayload}`
 *
 * Field names match the Rust `#[derive(Serialize)]` outputs 1:1 — change
 * both sides together. See `src-tauri/src/commands.rs` and
 * `src-tauri/src/job_queue.rs`.
 */

/**
 * Snapshot of which derived artefacts exist inside one Episode's
 * folder. The disk half of the PRD's `derive_state` pseudocode;
 * overlaid with the live JobsStore phase to pick the row badge
 * ("Trống" / "Đang trích xuất" / "Đã extract" / "Lỗi extract").
 *
 * Slice 0007 only flips `has_extracted_sub`; the other three are
 * always `false` until their owning slices (audio extract,
 * translate, render) land.
 */
export interface EpisodeArtifactsView {
  has_extracted_sub: boolean
  has_translation_draft: boolean
  has_translated_sub: boolean
  has_render: boolean
  output_basename: string
}

/**
 * Fired once per job, right before mkvextract spawns. Frontend flips
 * the row from `queued` → `running` so the progress bar appears even
 * before the first percentage crosses the wire.
 */
export interface JobStartedEvent {
  job_id: string
  episode_id: string
}

/**
 * Fired once per parsed progress line from `mkvextract` stderr.
 * `ratio` is a `[0, 1]` fraction the row renders as a determinate
 * progress bar; `hint` is the short human-readable label
 * (`"35%"` today; `"00:04:17 / 00:23:40"` for ffmpeg `time=` lines
 * once the render slices arrive).
 */
export interface JobProgressEvent {
  job_id: string
  episode_id: string
  ratio: number
  hint: string
}

/**
 * Fired once per job at completion (success, failure, or
 * cancellation). `stderr` carries the full captured stderr text so
 * the failure-modal can render it verbatim in a `TerminalLog` without
 * a second IPC round-trip.
 */
export interface JobDoneEvent {
  job_id: string
  episode_id: string
  success: boolean
  cancelled: boolean
  exit_code: number | null
  error: string | null
  stderr: string
}

/**
 * Inspect the EpisodeFolder for derived artefacts. Called by the
 * frontend on three occasions: project open / switch, after a
 * `job-done` event for the Episode, and on the overwrite-confirm
 * path before showing the modal.
 *
 * Rejects with the backend's Vietnamese error message ("Không tìm
 * thấy Episode trong project", "Thư mục chưa có zimesub.json") on
 * the rare race where the Episode was removed in a second window.
 */
export async function episodeInspectArtifacts(
  folder: string,
  episodeId: string
): Promise<EpisodeArtifactsView> {
  return invoke<EpisodeArtifactsView>('episode_inspect_artifacts', {
    folder,
    episodeId
  })
}

/**
 * Enqueue a fresh `ExtractSubtitle` job on the background queue.
 * Resolves as soon as the spec is on the channel — progress and
 * completion stream via the `job-progress` / `job-done` events the
 * frontend's JobsStore subscribes to.
 *
 * `jobId` is generated frontend-side (uuid) so log + progress + done
 * events can be correlated with the originating click, mirroring the
 * winget install flow's `installId` convention.
 *
 * Rejects with a Vietnamese error string when the Episode lacks a
 * selected track ("Chưa chọn subtitle track cho Episode này") or the
 * cached mkvextract path is empty ("Chưa phát hiện đường dẫn
 * mkvextract") — both flow through to a danger toast on the row.
 */
export async function extractSubtitleStart(
  jobId: string,
  folder: string,
  episodeId: string
): Promise<void> {
  return invoke<void>('extract_subtitle_start', { jobId, folder, episodeId })
}

/**
 * Cancel a queued or running extract-subtitle job by id. Idempotent
 * — cancelling an already-cancelled or already-finished job is a
 * no-op. The job's cleanup pass takes care of removing any partial
 * output the cancel interrupted.
 */
export async function extractSubtitleCancel(jobId: string): Promise<void> {
  return invoke<void>('extract_subtitle_cancel', { jobId })
}

/**
 * Subscribe to `job-started` events. Filter by `job_id` / `episode_id`
 * on the handler side — the backend emits a single event stream for
 * all jobs (slice 0007 runs serially so there is at most one in
 * flight, but the payload carries both ids so the multi-extract
 * concurrency in slice 0008 drops in without re-wiring).
 *
 * Returns the unlisten function — call it on owner cleanup to avoid
 * leaking subscriptions across hot reloads.
 */
export async function onJobStarted(
  handler: (event: JobStartedEvent) => void
): Promise<UnlistenFn> {
  return listen<JobStartedEvent>('job-started', event => handler(event.payload))
}

/**
 * Subscribe to per-line `job-progress` events. Same filter-by-id
 * pattern as {@link onJobStarted}.
 */
export async function onJobProgress(
  handler: (event: JobProgressEvent) => void
): Promise<UnlistenFn> {
  return listen<JobProgressEvent>('job-progress', event => handler(event.payload))
}

/**
 * Subscribe to `job-done` events. Fires once per job (success,
 * failure, or cancellation). Same filter-by-id pattern as
 * {@link onJobStarted}.
 */
export async function onJobDone(
  handler: (event: JobDoneEvent) => void
): Promise<UnlistenFn> {
  return listen<JobDoneEvent>('job-done', event => handler(event.payload))
}
