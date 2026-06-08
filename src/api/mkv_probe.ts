import type { ProjectJson } from '@api/projects'
import { invoke } from '@tauri-apps/api/core'

/**
 * TypeScript mirrors of the Rust `mkv_probe` + slice 0006 command shapes.
 * Field names match the `#[derive(Serialize)]` outputs 1:1 — change both
 * sides together. See `src-tauri/src/mkv_probe.rs` and the
 * `episode_list_subtitle_tracks` / `project_set_selected_track`
 * commands in `src-tauri/src/commands.rs`.
 */

/**
 * Categorisation of a subtitle track relative to the v1 pipeline's
 * capabilities. The track-picker derives row interactivity and the
 * disabled-reason badge from this discriminator:
 *  - `text`:   ASS / SRT — selectable, the only kind the pipeline can
 *              extract straight to `.ass` in slice 0007.
 *  - `bitmap`: PGS / VobSub / DVBSUB — disabled with the
 *              "Bitmap — không hỗ trợ" badge per AC.
 *  - `other`:  WebVTT / Kate / HDMV TextST / unrecognised — disabled
 *              with the generic "Không hỗ trợ" badge.
 */
export type SubtitleKind = 'text' | 'bitmap' | 'other'

/**
 * One subtitle track parsed out of `mkvmerge -i -F json`. Mirrors
 * `mkv_probe::SubtitleTrack`. `language_ietf` + `title` are optional
 * because mkvmerge omits them for tracks that lack the metadata; the
 * frontend renders `—` in the respective table cell when missing.
 */
export interface SubtitleTrack {
  mkv_track_id: number
  codec_id: string
  codec: string
  kind: SubtitleKind
  extractable: boolean
  language: string
  language_ietf?: string
  title?: string
  is_default: boolean
  is_forced: boolean
}

/**
 * Result of [`listSubtitleTracks`]. Mirrors Rust
 * `commands::ListSubtitleTracksOutcome`.
 *
 * `ok = true` → render the table from `tracks`, using
 * `preselected_index` as the initial highlight (or `null` to surface
 * the "Không có subtitle track text-based trong file này" empty state).
 * `ok = false` → render the stderr-plus-Retry pane; the caller may
 * still inspect `tracks` (it is always `[]` in this branch).
 */
export interface ListSubtitleTracksOutcome {
  ok: boolean
  tracks: SubtitleTrack[]
  preselected_index?: number
  stderr: string
  exit_code?: number
}

/**
 * Run `mkvmerge -i -F json <source_mkv_path>` for the given Episode
 * (cwd = EpisodeFolder per PRD § "Process spawn rules") and parse the
 * result into typed subtitle tracks plus the heuristic-suggested
 * initial selection index.
 *
 * Backend resolves the mkvmerge executable path via the cached
 * `settings.tool_paths` (populated by `toolProbe`). If the cache is
 * empty (e.g. user wiped settings.json after Onboarding), the call
 * rejects with the Vietnamese "Chưa phát hiện đường dẫn mkvmerge"
 * message — the modal surfaces it in the same error pane as a
 * non-zero exit code.
 */
export async function listSubtitleTracks(
  folder: string,
  episodeId: string
): Promise<ListSubtitleTracksOutcome> {
  return invoke<ListSubtitleTracksOutcome>('episode_list_subtitle_tracks', {
    folder,
    episodeId
  })
}

/**
 * Persist `trackId` (and the denormalised `language` display cache
 * for the Episode row) as the user's pick for `episodeId`. Returns
 * the post-write project so the frontend can swap `active` without a
 * second `project_open` round-trip.
 *
 * `language` carries the 3-letter ISO 639-2 code (`eng`, `jpn`, `und`).
 * `null` clears the cache — kept as a possibility for a future "Bỏ
 * chọn track" affordance even though slice 0006 only sets it.
 */
export async function projectSetSelectedTrack(
  folder: string,
  episodeId: string,
  trackId: number,
  language: string | null
): Promise<ProjectJson> {
  return invoke<ProjectJson>('project_set_selected_track', {
    folder,
    episodeId,
    trackId,
    language
  })
}
