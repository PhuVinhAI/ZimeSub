import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * TypeScript mirrors of the slice 0008 `job_queue` shapes. Field
 * names match the Rust `#[derive(Serialize)]` outputs 1:1 — change
 * both sides together. See `src-tauri/src/job_queue.rs`.
 *
 * The slice 0008 queue emits two event streams:
 *  - `jobs-changed`: full {@link JobsSnapshot} on every structural
 *    change (enqueue, start, complete, remove). The Jobs panel +
 *    status bar replace their store wholesale on this event.
 *  - `job-progress`: lightweight `{ job_id, ratio, hint }` payload
 *    per parsed stderr line. High frequency; updates only the
 *    relevant job's progress fields in the store.
 */

/** Tier discriminator on a job. */
export type JobKind = 'extract_subtitle' | 'extract_audio' | 'render'

/** Lifecycle status of a job, per ADR-0003. */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/**
 * Serialized projection of one job — the shape the Jobs panel row
 * renders. Mirrors `job_queue::JobView`.
 */
export interface JobView {
  id: string
  kind: JobKind
  episode_id: string
  /** Sanitised EpisodeFolder name — display label for the row. */
  episode_name: string
  /** Absolute path to the project folder — drives "click to jump". */
  project_folder: string
  status: JobStatus
  /** `[0, 1]` ratio. `1` once Done. */
  ratio: number
  /** Short human-readable hint (`"35%"`, `"00:04:17 / 00:23:40"`). */
  hint: string
  /** Vietnamese error string set on Failed jobs. */
  error: string | null
  /** Full captured stderr text — fed into the failure modal viewer. */
  stderr: string
  exit_code: number | null
  /** Unix milliseconds. Drives "X phút trước" relative timestamp. */
  created_at: number
  started_at: number | null
  completed_at: number | null
  /**
   * `true` when the terminal status is the result of a cancel rather
   * than the runner finishing on its own. Always false for `done` /
   * `failed`; matches the `cancelled` lifecycle status.
   */
  cancelled: boolean
}

/**
 * Full queue snapshot — payload of the `jobs-changed` event +
 * return shape of {@link jobSnapshot}.
 */
export interface JobsSnapshot {
  /** Newest-first ordering matches the Jobs panel ("newest at top"). */
  jobs: JobView[]
  /**
   * Echo of the current `queue_concurrency_extract` so the status
   * bar's "JOBS ●●○○○" indicator can size the dot count off the
   * same source of truth as the queue itself.
   */
  extract_concurrency: number
}

/**
 * Lightweight per-line progress event. Carries only the fields that
 * change frequently; the rest of the job's state is read off the
 * stored {@link JobsSnapshot}.
 */
export interface JobProgressEvent {
  job_id: string
  ratio: number
  hint: string
}

/**
 * Read the current `JobQueue` snapshot. Drives the Jobs panel on
 * mount + the initial status bar render so the UI doesn't depend on
 * receiving a `jobs-changed` event to populate.
 */
export async function jobSnapshot(): Promise<JobsSnapshot> {
  return invoke<JobsSnapshot>('job_snapshot')
}

/**
 * Cancel a job by id. Pending → drops from queue with no cleanup;
 * Running → kills the process tree and the per-`JobKind` cleanup
 * pass deletes the partial output. Idempotent on unknown /
 * already-terminal ids.
 */
export async function jobCancel(jobId: string): Promise<void> {
  return invoke<void>('job_cancel', { jobId })
}

/**
 * Remove a Pending job from the queue. No process kill, no on-disk
 * cleanup — matches the AC's "Removing a Pending Job: just pops from
 * the queue". No-op for Running / terminal rows; the UI hides the
 * "Xóa" button on those anyway.
 */
export async function jobRemovePending(jobId: string): Promise<void> {
  return invoke<void>('job_remove_pending', { jobId })
}

/**
 * Subscribe to `jobs-changed` events. Fires on every structural
 * change to the queue (enqueue, start, complete, remove); payload
 * carries the full snapshot so the store replaces its list
 * wholesale.
 *
 * Returns the unlisten function — call on cleanup so hot reloads
 * don't leak subscriptions.
 */
export async function onJobsChanged(
  handler: (snapshot: JobsSnapshot) => void
): Promise<UnlistenFn> {
  return listen<JobsSnapshot>('jobs-changed', event => handler(event.payload))
}

/**
 * Subscribe to per-line `job-progress` events. High frequency;
 * handlers should update only the affected job's progress fields,
 * leaving the rest of the snapshot intact.
 */
export async function onJobProgress(
  handler: (event: JobProgressEvent) => void
): Promise<UnlistenFn> {
  return listen<JobProgressEvent>('job-progress', event => handler(event.payload))
}
