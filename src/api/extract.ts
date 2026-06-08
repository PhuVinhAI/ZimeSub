import { invoke } from '@tauri-apps/api/core'

/**
 * Per-Episode extract command bindings (slices 0007 + 0008 + 0009).
 *
 * Slice 0007 introduced the minimal `extract_subtitle_start` /
 * `extract_subtitle_cancel` IPC commands plus the
 * `episode_inspect_artifacts` disk-snapshot helper. Slice 0008
 * promoted the queue plumbing into the generic `JobQueue` shape —
 * `extract_subtitle_start` now wraps `JobQueue::enqueue` and the
 * generic `job_cancel` is the preferred path forward (see
 * `@api/jobs.ts`). Slice 0009 adds the audio extract variant on the
 * same shape (`extract_audio_start` / `extract_audio_cancel`) plus
 * the per-project audio config get/set used by the Settings panel
 * sub-form.
 *
 * Field names match the Rust `#[derive(Serialize)]` outputs 1:1.
 * See `src-tauri/src/commands.rs`.
 */

/**
 * Snapshot of which derived artefacts exist inside one Episode's
 * folder. Mirrors `commands::EpisodeArtifactsView`.
 *
 * Slice 0007 lit up `has_extracted_sub`; slice 0009 lights up
 * `has_extracted_audio` (decorative — does not gate EpisodeState).
 * The translation / render flags ship `false` until their owning
 * slices land.
 */
export interface EpisodeArtifactsView {
  has_extracted_sub: boolean
  has_extracted_audio: boolean
  has_translation_draft: boolean
  has_translated_sub: boolean
  has_render: boolean
  /**
   * `true` when a Render artefact exists AND its mtime is older than
   * the TranslatedSub's mtime — i.e. the user re-translated (or
   * StylePatch'd) after the last render. Drives the yellow "Render
   * lỗi thời" badge on the Episode row (slice 0010 AC).
   */
  is_render_stale: boolean
  /**
   * `true` when this Episode's `source_mkv_path` no longer resolves
   * on disk. Slice 0012. Drives the red "MKV gốc không tìm thấy"
   * badge + disables Extract / Render buttons on the row.
   * Translate-stage actions stay enabled because their inputs live
   * inside the EpisodeFolder.
   */
  is_source_missing: boolean
  output_basename: string
  /**
   * Codec extension the project is currently configured for
   * (`mp3` / `aac` / `flac`). The audio artefact check above is
   * scoped to this extension only; an existing `.mp3` does NOT flip
   * the flag if the project's default codec is `aac`.
   */
  audio_extension: string
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

/**
 * Enqueue a fresh `ExtractAudio` job on the background queue.
 * Slice 0009. Independent of the subtitle stage — the codec and
 * quality used are read from the project's `default_extract_audio`
 * block (managed via the Settings panel sub-form).
 *
 * Rejects with "Chưa phát hiện đường dẫn ffmpeg" when the cached
 * ffmpeg path is empty.
 */
export async function extractAudioStart(
  jobId: string,
  folder: string,
  episodeId: string
): Promise<void> {
  return invoke<void>('extract_audio_start', { jobId, folder, episodeId })
}

/**
 * Per-Episode audio cancel — backwards-compat path. New code should
 * prefer the generic `jobCancel` from `@api/jobs.ts`. Idempotent on
 * unknown / terminal job ids.
 */
export async function extractAudioCancel(jobId: string): Promise<void> {
  return invoke<void>('extract_audio_cancel', { jobId })
}
