import { invoke } from '@tauri-apps/api/core'

/**
 * Per-Episode extract command bindings (slices 0007 + 0008).
 *
 * Slice 0007 introduced the minimal `extract_subtitle_start` /
 * `extract_subtitle_cancel` IPC commands plus the
 * `episode_inspect_artifacts` disk-snapshot helper. Slice 0008
 * promoted the queue plumbing into the generic `JobQueue` shape —
 * `extract_subtitle_start` now wraps `JobQueue::enqueue` and the
 * generic `job_cancel` is the preferred path forward (see
 * `@api/jobs.ts`). `extract_subtitle_start` and the artefact
 * inspector stay here because they are the per-Episode entry points
 * the project view calls directly; the cancel + event handlers are
 * generic and live in `@api/jobs.ts`.
 *
 * Field names match the Rust `#[derive(Serialize)]` outputs 1:1.
 * See `src-tauri/src/commands.rs`.
 */

/**
 * Snapshot of which derived artefacts exist inside one Episode's
 * folder. Mirrors `commands::EpisodeArtifactsView`.
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
 * Inspect the EpisodeFolder for derived artefacts. Called by the
 * frontend on three occasions: project open / switch, after a
 * job-done snapshot for the Episode, and on the overwrite-confirm
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
 * Resolves as soon as the spec is on the queue — progress and
 * completion stream via the generic `jobs-changed` / `job-progress`
 * events the global JobsStore subscribes to.
 *
 * `jobId` is generated frontend-side (uuid) so progress + change
 * events can be correlated with the originating click.
 *
 * Rejects with a Vietnamese error string when the Episode lacks a
 * selected track ("Chưa chọn subtitle track cho Episode này") or
 * the cached mkvextract path is empty ("Chưa phát hiện đường dẫn
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
 * Per-Episode cancel — backwards-compat path. New code should
 * prefer the generic `jobCancel` from `@api/jobs.ts`; this wrapper
 * stays for callers that already wired the slice-0007 surface.
 */
export async function extractSubtitleCancel(jobId: string): Promise<void> {
  return invoke<void>('extract_subtitle_cancel', { jobId })
}
