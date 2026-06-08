import { invoke } from '@tauri-apps/api/core'

/**
 * TypeScript mirrors of the Rust `project_store` schemas. Field names and
 * shapes match the `#[derive(Serialize)]` outputs 1:1 — change both sides
 * together. See `src-tauri/src/project_store.rs`.
 */

export interface RenderConfig {
  encoder: string
  quality: number
  audio_codec: string
  audio_bitrate_kbps: number
}

export interface ExtractAudioConfig {
  codec: string
  quality_or_bitrate: string
}

export interface EpisodeRecord {
  id: string
  source_mkv_path: string
  folder_name: string
  selected_subtitle_track_id: number | null
  /**
   * Denormalised display cache for the picked track's language tag
   * (3-letter ISO 639-2, e.g. `eng`, `jpn`, `und`). The track id in
   * `selected_subtitle_track_id` remains the source of truth for the
   * extract pipeline; this field exists so the Episode row can render
   * `ENG`/`JPN`/`UND` without re-running `mkvmerge -i` on every load.
   * Backend sets this atomically alongside the track id whenever the
   * user confirms a pick in the track-picker modal (slice 0006).
   */
  selected_subtitle_language: string | null
  render_config_override: RenderConfig | null
}

export interface ProjectJson {
  version: number
  name: string
  created_at: string
  default_render_config: RenderConfig
  default_extract_audio: ExtractAudioConfig
  episodes: EpisodeRecord[]
}

/**
 * Three-way verdict the Create Project modal asks for after the user
 * picks a folder. The frontend chooses between "Tạo" / "Mở project hiện
 * có" / blocking error from the flags here.
 */
export interface FolderInspection {
  exists: boolean
  is_empty: boolean
  has_zimesub_json: boolean
  existing_project_name: string | null
}

/**
 * Sidebar-shaped recent project entry, enriched with on-disk liveness
 * (`folder_exists`, `has_zimesub_json`) so the row can show the "Không
 * tìm thấy" danger badge + "Gỡ khỏi danh sách" affordance.
 */
export interface RecentProjectStatus {
  path: string
  last_opened: string
  folder_exists: boolean
  has_zimesub_json: boolean
  name: string | null
}

/**
 * Result of [`projectAddEpisodes`]. Mirrors `project_store::AddEpisodesOutcome`.
 *
 * `project` is the post-write state — frontend swaps `projectsStore.active`
 * with this to avoid a second `project_open` round-trip.
 *
 * `duplicates` carries the source paths that were already present in the
 * project (case-insensitive match against `episodes[].source_mkv_path`)
 * and were therefore skipped — slice 0005 surfaces one yellow toast per
 * entry per the AC ("Episode này đã có trong project").
 */
export interface AddEpisodesOutcome {
  project: ProjectJson
  added_count: number
  duplicates: string[]
}

/**
 * Ask the backend whether `folder` is safe to create a new project in,
 * already hosts a `zimesub.json` (offer to open it instead), or is
 * non-empty and contains unrelated files (blocking error).
 */
export async function projectInspectFolder(folder: string): Promise<FolderInspection> {
  return invoke<FolderInspection>('project_inspect_folder', { folder })
}

/**
 * Create a fresh project at `folder` with `name`. Backend writes
 * `zimesub.json`, bumps the folder to the head of `recent_projects` in
 * app settings, and returns the parsed project so we can render the Main
 * view immediately.
 */
export async function projectCreate(folder: string, name: string): Promise<ProjectJson> {
  return invoke<ProjectJson>('project_create', { folder, name })
}

/**
 * Open the project stored at `folder` (reads `zimesub.json`, bumps the
 * folder in `recent_projects`). Rejects when the folder has no manifest
 * or the file is corrupt — frontend surfaces those as the "Không tìm
 * thấy" badge + remove-from-list affordance.
 */
export async function projectOpen(folder: string): Promise<ProjectJson> {
  return invoke<ProjectJson>('project_open', { folder })
}

/**
 * Enumerate `recent_projects` from app settings, enriched with liveness
 * flags. Returned in most-recent-first order.
 */
export async function projectListRecents(): Promise<RecentProjectStatus[]> {
  return invoke<RecentProjectStatus[]>('project_list_recents')
}

/**
 * Drop one folder path from the `recent_projects` MRU list. Backend
 * persists the resulting settings atomically.
 */
export async function projectRemoveRecent(folder: string): Promise<void> {
  return invoke<void>('project_remove_recent', { folder })
}

/**
 * Append one Episode per entry in `sourcePaths` to the project at
 * `folder`. Backend creates each EpisodeFolder on disk and rewrites
 * `zimesub.json` atomically when at least one Episode is appended.
 *
 * Pre-condition: the caller MUST filter inputs down to `.mkv` paths —
 * the AC keeps the extension check on the UI side so the toast can name
 * the offending file. The backend does not re-validate.
 */
export async function projectAddEpisodes(
  folder: string,
  sourcePaths: string[]
): Promise<AddEpisodesOutcome> {
  return invoke<AddEpisodesOutcome>('project_add_episodes', {
    folder,
    sourcePaths
  })
}

/**
 * Read the project's `default_extract_audio` block. Drives the
 * Settings panel sub-form on open so the codec dropdown + quality
 * field boot with the persisted choice.
 */
export async function projectGetExtractAudioConfig(
  folder: string
): Promise<ExtractAudioConfig> {
  return invoke<ExtractAudioConfig>('project_get_extract_audio_config', {
    folder
  })
}

/**
 * Persist a new `default_extract_audio` block. Backend coerces
 * unknown codecs to `libmp3lame` and rewrites `zimesub.json`
 * atomically. Returns the post-write project so the projects store
 * can swap `active` without a second `project_open` round-trip.
 */
export async function projectSetExtractAudioConfig(
  folder: string,
  config: ExtractAudioConfig
): Promise<ProjectJson> {
  return invoke<ProjectJson>('project_set_extract_audio_config', {
    folder,
    config
  })
}
