//! Project file (`zimesub.json`) read/write + folder inspection.
//!
//! Slice 0004 shipped:
//!  * The on-disk [`ProjectJson`] schema (version 1) per
//!    PRD § "Schemas / zimesub.json".
//!  * [`inspect_folder`] — three-way verdict the Create Project modal uses
//!    to decide which CTA to show ("Tạo" vs "Mở project hiện có" vs error).
//!  * [`create_project`] / [`open_project`] — single-shot helpers wrapped by
//!    the Tauri commands in `commands.rs`.
//!
//! Slice 0005 adds:
//!  * [`sanitize_folder_name`] — Windows-reserved character substitution per
//!    PRD § "Episode import" / CONTEXT.md § "EpisodeFolder". Pure, fixture-
//!    testable; the same rule is applied by both drag-drop and the multi-
//!    file picker so the basename → folder_name mapping is one definition.
//!  * [`add_episodes`] — batch append of Episode records driven by drag-drop
//!    or the "Thêm Episode…" button. Creates the on-disk EpisodeFolder per
//!    accepted entry, deduplicates against existing `source_mkv_path` entries
//!    (case-insensitive — Windows-only target), and reports duplicates back
//!    to the caller so the UI can surface a yellow toast.
//!
//! Slice 0006 adds:
//!  * [`EpisodeRecord::selected_subtitle_language`] — denormalised display
//!    cache for the picked track's language tag, so the Episode row can
//!    render `ENG`/`JPN`/`UND` without re-running mkvmerge on every load.
//!    The track id is still the source of truth for extraction.
//!  * [`resolve_episode_targets`] — translate `(project_folder, episode_id)`
//!    into the absolute `source_mkv_path` + `EpisodeFolder` pair the
//!    track-picker command feeds into `process_runner::run_to_completion`.
//!  * [`set_selected_track`] — atomic write of the user's pick back to
//!    `zimesub.json`. Returns the post-write `ProjectJson` so the
//!    frontend can swap `active` without a second `project_open`
//!    round-trip.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::Local;
use chrono::SecondsFormat;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// File name of the project manifest. The whole pipeline keys off the
/// presence of this file inside a folder — `inspect_folder` looks for it,
/// `create_project` writes it, `open_project` reads it.
pub const PROJECT_FILE_NAME: &str = "zimesub.json";

/// PRD default for the project-level render config when the user creates a
/// brand-new project. `encoder = "auto"` defers to the EncoderProbe
/// priority list (QSV > NVENC > AMF > libx264) at render time.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RenderConfig {
    pub encoder: String,
    pub quality: u32,
    pub audio_codec: String,
    pub audio_bitrate_kbps: u32,
}

impl RenderConfig {
    fn project_default() -> Self {
        Self {
            encoder: "auto".to_string(),
            quality: 65,
            audio_codec: "aac".to_string(),
            audio_bitrate_kbps: 192,
        }
    }
}

/// PRD default for audio extraction — mp3 via libmp3lame, VBR quality 2
/// (a near-CD-quality preset matched to ffmpeg's `-q:a 2` syntax).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExtractAudioConfig {
    pub codec: String,
    pub quality_or_bitrate: String,
}

impl ExtractAudioConfig {
    fn project_default() -> Self {
        Self {
            codec: "libmp3lame".to_string(),
            quality_or_bitrate: "q:a 2".to_string(),
        }
    }

    /// File extension produced for `codec`. Used by both the ffmpeg
    /// argv (`-c:a libmp3lame … <basename>.mp3`) and the artefact
    /// inspector (slice 0009 surfaces a small "audio" badge when the
    /// matching file exists). Unknown codecs default to `mp3` so a
    /// future ffmpeg-only codec drop still has a sensible filename.
    pub fn output_extension(&self) -> &'static str {
        match self.codec.as_str() {
            "aac" => "aac",
            "flac" => "flac",
            // libmp3lame / unknown
            _ => "mp3",
        }
    }

    /// Resolve `quality_or_bitrate` into the ffmpeg argv tokens that
    /// follow `-c:a <codec>`. Returns a Vec because aac uses `-b:a
    /// 192k` (two argv entries) while mp3 uses `-q:a 2` (also two);
    /// flac takes no quality flag at all (returns empty Vec).
    ///
    /// Format conventions in the stored string:
    ///  * mp3 → `"q:a N"` where 0 ≤ N ≤ 9 (ffmpeg VBR quality).
    ///  * aac → `"b:a NNNk"` where NNN is the kbps bitrate.
    ///  * flac → ignored (no quality knob for the lossless codec).
    ///
    /// Malformed values fall back to the default for the codec to
    /// keep the runner from ever producing argv that ffmpeg rejects.
    pub fn quality_args(&self) -> Vec<String> {
        match self.codec.as_str() {
            "libmp3lame" => {
                let q = parse_mp3_quality(&self.quality_or_bitrate).unwrap_or(2);
                vec!["-q:a".to_string(), q.to_string()]
            }
            "aac" => {
                let kbps = parse_aac_bitrate(&self.quality_or_bitrate).unwrap_or(192);
                vec!["-b:a".to_string(), format!("{kbps}k")]
            }
            "flac" => Vec::new(),
            _ => {
                // Unknown codec — fall back to default mp3 args so the
                // runner never produces something ffmpeg can't parse.
                vec!["-q:a".to_string(), "2".to_string()]
            }
        }
    }
}

/// Extract the integer N from `"q:a N"` (with whitespace tolerance).
/// Returns `None` for anything that doesn't look like the mp3-quality
/// shape; the caller falls back to the default `2`.
fn parse_mp3_quality(value: &str) -> Option<u8> {
    let trimmed = value.trim();
    let rest = trimmed.strip_prefix("q:a")?.trim_start();
    let n: u8 = rest.parse().ok()?;
    if n > 9 { None } else { Some(n) }
}

/// Extract the integer kbps from `"b:a NNNk"` (with whitespace
/// tolerance). Returns `None` for anything malformed; the caller
/// falls back to the default `192`.
fn parse_aac_bitrate(value: &str) -> Option<u32> {
    let trimmed = value.trim();
    let rest = trimmed.strip_prefix("b:a")?.trim_start();
    let numeric = rest.trim_end_matches('k').trim_end_matches('K').trim();
    numeric.parse().ok()
}

/// Per-Episode record persisted inside `zimesub.json`. Slice 0004 never
/// adds entries to this list (it stays `[]` on create); slice 0005 wires
/// drag-drop and starts populating it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EpisodeRecord {
    pub id: String,
    pub source_mkv_path: String,
    pub folder_name: String,
    #[serde(default)]
    pub selected_subtitle_track_id: Option<u32>,
    /// Denormalised display cache for the picked track's language tag
    /// (3-letter ISO 639-2, e.g. `eng`, `jpn`, `und`). The track id in
    /// `selected_subtitle_track_id` remains the source of truth for the
    /// extract pipeline; this field exists so the Episode row can
    /// render `ENG`/`JPN`/`UND` without re-running `mkvmerge -i` on
    /// every project open. `#[serde(default)]` so manifests written by
    /// pre-slice-0006 builds load without the field.
    #[serde(default)]
    pub selected_subtitle_language: Option<String>,
    #[serde(default)]
    pub render_config_override: Option<RenderConfig>,
}

/// On-disk shape of `zimesub.json`. Field order matches the PRD example
/// (`serde_json` preserves struct declaration order on serialise) so
/// hand-inspecting the file matches the documented schema.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectJson {
    #[serde(default = "default_version")]
    pub version: u32,
    pub name: String,
    pub created_at: String,
    pub default_render_config: RenderConfig,
    pub default_extract_audio: ExtractAudioConfig,
    #[serde(default)]
    pub episodes: Vec<EpisodeRecord>,
}

fn default_version() -> u32 {
    1
}

/// Three-way verdict the Create Project modal asks for after the user
/// picks a folder.
///
/// The frontend decides the CTA from this struct:
///  * `has_zimesub_json = true`  → "Mở project hiện có" (offers to open it)
///  * non-empty `&& !has_zimesub_json` → blocking error "Thư mục đã có file khác"
///  * empty / non-existent → "Tạo" path
#[derive(Clone, Debug, Serialize)]
pub struct FolderInspection {
    pub exists: bool,
    pub is_empty: bool,
    pub has_zimesub_json: bool,
    /// Populated when `has_zimesub_json` is true and the file parses
    /// cleanly. Lets the modal preview the name the open path will adopt.
    pub existing_project_name: Option<String>,
}

/// Sidebar projection of one recent project entry. Includes liveness
/// information (`folder_exists`, `has_zimesub_json`) so the UI can show the
/// "Không tìm thấy" badge + "Gỡ khỏi danh sách" affordance per the
/// acceptance criteria, and `name` is read from `zimesub.json` when present
/// so the list isn't all raw paths.
#[derive(Clone, Debug, Serialize)]
pub struct RecentProjectStatus {
    pub path: String,
    pub last_opened: String,
    pub folder_exists: bool,
    pub has_zimesub_json: bool,
    pub name: Option<String>,
}

/// Errors surfaced to the commands layer. Specific variants exist so the
/// caller can map them to typed UI states instead of stringly-typed error
/// codes.
#[derive(Debug)]
pub enum ProjectError {
    Io(io::Error),
    Parse(serde_json::Error),
    NameEmpty,
    FolderHasOtherFiles,
    NotAProject,
    /// Per-episode lookup failed inside an otherwise-valid project.
    /// Distinct from `NotAProject` so the track-picker command can
    /// surface a different Vietnamese message ("Không tìm thấy
    /// Episode") to the modal — the AC's retry button only makes sense
    /// when the project itself loads cleanly.
    EpisodeNotFound,
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::Io(e) => write!(f, "{e}"),
            ProjectError::Parse(e) => write!(f, "Không đọc được zimesub.json: {e}"),
            ProjectError::NameEmpty => f.write_str("Tên project không được để trống"),
            ProjectError::FolderHasOtherFiles => f.write_str("Thư mục đã có file khác"),
            ProjectError::NotAProject => f.write_str("Thư mục chưa có zimesub.json"),
            ProjectError::EpisodeNotFound => f.write_str("Không tìm thấy Episode trong project"),
        }
    }
}

impl std::error::Error for ProjectError {}

impl From<io::Error> for ProjectError {
    fn from(value: io::Error) -> Self {
        ProjectError::Io(value)
    }
}

impl From<serde_json::Error> for ProjectError {
    fn from(value: serde_json::Error) -> Self {
        ProjectError::Parse(value)
    }
}

/// Look at `folder` and tell the caller what creation/open flow applies.
/// Never mutates the folder. A folder that does not exist on disk is
/// treated as "empty + safe to create in" — the create path will
/// `create_dir_all` later.
pub fn inspect_folder(folder: &Path) -> Result<FolderInspection, ProjectError> {
    if !folder.exists() {
        return Ok(FolderInspection {
            exists: false,
            is_empty: true,
            has_zimesub_json: false,
            existing_project_name: None,
        });
    }

    let manifest = folder.join(PROJECT_FILE_NAME);
    let has_zimesub_json = manifest.is_file();

    let existing_project_name = if has_zimesub_json {
        match read_project_json(&manifest) {
            Ok(p) => Some(p.name),
            Err(err) => {
                tracing::warn!(path = %manifest.display(), error = %err, "found zimesub.json but failed to parse");
                None
            }
        }
    } else {
        None
    };

    let is_empty = fs::read_dir(folder)?.next().is_none();

    Ok(FolderInspection {
        exists: true,
        is_empty,
        has_zimesub_json,
        existing_project_name,
    })
}

/// Write a fresh `zimesub.json` into `folder`. Returns the parsed
/// [`ProjectJson`] so the caller can hand it straight to the frontend
/// without a second IO round-trip.
///
/// Refuses to overwrite an existing `zimesub.json` — the caller is expected
/// to detect that case via [`inspect_folder`] and route through
/// [`open_project`] instead. Also refuses when the folder is non-empty and
/// does not already host a project, matching the modal AC.
pub fn create_project(folder: &Path, name: &str) -> Result<ProjectJson, ProjectError> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(ProjectError::NameEmpty);
    }

    let inspection = inspect_folder(folder)?;
    if inspection.exists && !inspection.is_empty && !inspection.has_zimesub_json {
        return Err(ProjectError::FolderHasOtherFiles);
    }
    if inspection.has_zimesub_json {
        // Defensive: the AC says the modal must route to open in this case,
        // but if the backend is invoked directly we still refuse to stomp
        // the existing file.
        return Err(ProjectError::FolderHasOtherFiles);
    }

    if !inspection.exists {
        fs::create_dir_all(folder)?;
    }

    let project = ProjectJson {
        version: 1,
        name: trimmed_name.to_string(),
        created_at: now_local_iso8601(),
        default_render_config: RenderConfig::project_default(),
        default_extract_audio: ExtractAudioConfig::project_default(),
        episodes: Vec::new(),
    };

    write_project_json_atomic(folder, &project)?;
    Ok(project)
}

/// Read and parse `zimesub.json` inside `folder`. Missing file is mapped to
/// [`ProjectError::NotAProject`] so the UI can route to the "Không tìm
/// thấy" empty state instead of a generic file-not-found error.
pub fn open_project(folder: &Path) -> Result<ProjectJson, ProjectError> {
    let manifest = folder.join(PROJECT_FILE_NAME);
    if !manifest.is_file() {
        return Err(ProjectError::NotAProject);
    }
    read_project_json(&manifest)
}

/// Best-effort lookup of one recent entry's project name. Used by
/// `commands::project_list_recents` to enrich the Sidebar list without
/// triggering a full open. Returns `None` if the folder is gone or the
/// file is corrupt — callers surface those via the `folder_exists` /
/// `has_zimesub_json` flags so the UI shows the "Không tìm thấy" badge.
pub fn peek_project_name(folder: &Path) -> Option<String> {
    let manifest = folder.join(PROJECT_FILE_NAME);
    if !manifest.is_file() {
        return None;
    }
    read_project_json(&manifest).ok().map(|p| p.name)
}

/// `true` when the folder exists and is reachable.
pub fn folder_exists(folder: &Path) -> bool {
    folder.is_dir()
}

/// `true` when a `zimesub.json` sits directly inside `folder`.
pub fn folder_has_manifest(folder: &Path) -> bool {
    folder.join(PROJECT_FILE_NAME).is_file()
}

/// Return value of [`add_episodes`].
///
/// `project` is the post-write [`ProjectJson`] so the frontend can swap its
/// `active` reference without a second `open_project` round-trip.
/// `added_count` lets the UI render a "đã thêm N Episode" status without
/// counting the diff. `duplicates` is the list of input paths that were
/// already present in `episodes` and therefore skipped — the UI surfaces
/// one yellow toast per entry per the slice 0005 acceptance criteria.
#[derive(Clone, Debug, Serialize)]
pub struct AddEpisodesOutcome {
    pub project: ProjectJson,
    pub added_count: u32,
    pub duplicates: Vec<String>,
}

/// Replace Windows-reserved characters in `basename` with `_`.
///
/// Reserved set per PRD / CONTEXT.md: `: < > | " \ / ? *`. Trailing dots and
/// trailing whitespace are also stripped because Windows refuses folders
/// that end with either (a long-standing NTFS quirk that turns into a
/// cryptic `CreateDirectory` failure otherwise). Empty / all-replaced input
/// falls back to `"episode"` so we never pass an empty string to
/// `create_dir_all`.
///
/// Pure function — no I/O, no allocation beyond the result `String`.
pub fn sanitize_folder_name(basename: &str) -> String {
    let mut out = String::with_capacity(basename.len());
    for ch in basename.chars() {
        match ch {
            ':' | '<' | '>' | '|' | '"' | '\\' | '/' | '?' | '*' => out.push('_'),
            // ASCII control chars are also illegal on Windows. Replacing them
            // is cheap insurance against pathological filenames.
            c if (c as u32) < 0x20 => out.push('_'),
            c => out.push(c),
        }
    }
    let trimmed = out.trim_end_matches([' ', '.']);
    if trimmed.is_empty() {
        "episode".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Strip the `.mkv` (case-insensitive) extension off the basename of
/// `path`. Used to derive a sanitized [`EpisodeRecord::folder_name`] from
/// the absolute SourceMkv path.
fn basename_without_mkv_ext(path: &Path) -> String {
    let raw = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(stripped) = raw.strip_suffix(".mkv").or_else(|| raw.strip_suffix(".MKV")) {
        return stripped.to_string();
    }
    // Fall back to the case-insensitive form for mixed-case extensions.
    let lower = raw.to_lowercase();
    if let Some(idx) = lower.rfind(".mkv")
        && idx + ".mkv".len() == raw.len()
    {
        return raw[..idx].to_string();
    }
    raw
}

/// Append one `Episode` per entry in `source_paths` to the project at
/// `folder`, creating the matching EpisodeFolder for each on disk.
///
/// Duplicate detection: an input path that already appears in
/// `episodes[*].source_mkv_path` (case-insensitive comparison — Windows
/// is the only target platform per the v1 PRD) is reported in
/// `duplicates` and **not** appended again. The corresponding subfolder
/// is also not re-created (it already exists from the original add).
///
/// File-system writes:
///  * `<folder>/<sanitised_basename>/` — created via `create_dir_all`,
///    so an existing subfolder is treated as a no-op rather than an error.
///  * `<folder>/zimesub.json` — rewritten atomically (tmp + rename) only
///    when at least one Episode was appended. If every input was a
///    duplicate the manifest is left untouched.
///
/// Errors:
///  * `ProjectError::NotAProject` — `folder/zimesub.json` does not exist
///    or is unreadable. The frontend should never reach this state with a
///    project_open round-trip beforehand, so we return the same kind the
///    Sidebar already maps to "Không tìm thấy".
///  * `ProjectError::Io` — folder creation or manifest write failed mid-
///    batch. Episodes appended to the in-memory `ProjectJson` before the
///    failure are NOT persisted; the caller should re-open the project
///    to recover the on-disk truth.
pub fn add_episodes(
    folder: &Path,
    source_paths: &[String],
) -> Result<AddEpisodesOutcome, ProjectError> {
    let mut project = open_project(folder)?;

    let mut existing_lower: std::collections::HashSet<String> = project
        .episodes
        .iter()
        .map(|e| e.source_mkv_path.to_lowercase())
        .collect();

    let mut added_count: u32 = 0;
    let mut duplicates: Vec<String> = Vec::new();

    for source_path in source_paths {
        let trimmed = source_path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if existing_lower.contains(&lower) {
            duplicates.push(trimmed.to_string());
            continue;
        }

        let path = Path::new(trimmed);
        let basename = basename_without_mkv_ext(path);
        let folder_name = sanitize_folder_name(&basename);
        let episode_folder = folder.join(&folder_name);
        // `create_dir_all` is idempotent — if two episodes happen to share a
        // sanitised basename (unusual but legal: same name in different
        // source directories), the second add reuses the existing folder.
        // Pipeline artefacts inside collide on `<basename>` and that's
        // surfaced as a v1 user responsibility per the PRD.
        fs::create_dir_all(&episode_folder)?;

        project.episodes.push(EpisodeRecord {
            id: Uuid::new_v4().to_string(),
            source_mkv_path: trimmed.to_string(),
            folder_name,
            selected_subtitle_track_id: None,
            selected_subtitle_language: None,
            render_config_override: None,
        });
        existing_lower.insert(lower);
        added_count += 1;
    }

    if added_count > 0 {
        write_project_json_atomic(folder, &project)?;
    }

    Ok(AddEpisodesOutcome {
        project,
        added_count,
        duplicates,
    })
}

/// Concrete on-disk targets for one episode, derived from the
/// `(project_folder, episode_id)` pair the track-picker command
/// receives across the IPC boundary.
///
/// `source_mkv_path` is the absolute reference the user dropped into
/// the project (path-only per ADR-0001 — never copied or moved).
/// `episode_folder` is `<project_folder>/<folder_name>`, used as the
/// `cwd` for the mkvmerge subprocess per PRD § "Process spawn rules".
#[derive(Clone, Debug)]
pub struct EpisodeTargets {
    pub source_mkv_path: PathBuf,
    pub episode_folder: PathBuf,
}

/// Look up `episode_id` inside the project at `project_folder` and
/// return the absolute `SourceMkv` + `EpisodeFolder` pair the
/// track-picker command feeds into `process_runner::run_to_completion`.
///
/// Read-only — the manifest is not mutated. `ProjectError::NotAProject`
/// when the folder is no longer a project (e.g. user deleted
/// zimesub.json behind ZimeSub's back); `ProjectError::EpisodeNotFound`
/// when the project loads but the requested id is gone (e.g. the user
/// removed the Episode from a second window).
pub fn resolve_episode_targets(
    project_folder: &Path,
    episode_id: &str,
) -> Result<EpisodeTargets, ProjectError> {
    let project = open_project(project_folder)?;
    let episode = project
        .episodes
        .iter()
        .find(|e| e.id == episode_id)
        .ok_or(ProjectError::EpisodeNotFound)?;
    Ok(EpisodeTargets {
        source_mkv_path: PathBuf::from(&episode.source_mkv_path),
        episode_folder: project_folder.join(&episode.folder_name),
    })
}

/// Update `selected_subtitle_track_id` (and the denormalised
/// `selected_subtitle_language` display cache) for `episode_id` inside
/// the project at `folder`. The manifest is rewritten atomically
/// (`tmp + rename`) regardless of whether the values actually changed —
/// the AC's "Modal closes; the Episode row reflects the selection"
/// requirement is satisfied by returning the post-write `ProjectJson`
/// so the frontend swaps `active` without a second `project_open`
/// round-trip.
///
/// `language` is the 3-letter ISO 639-2 code (e.g. `eng`, `jpn`) or
/// `"und"`. Passing `None` clears the cache — kept as a possibility
/// for a future "Bỏ chọn track" affordance even though slice 0006
/// only sets it.
///
/// Errors:
///  * `ProjectError::NotAProject` — `folder/zimesub.json` missing.
///  * `ProjectError::EpisodeNotFound` — id not in `episodes`.
///  * `ProjectError::Io` — read/write/rename failed.
///  * `ProjectError::Parse` — manifest is corrupt JSON.
pub fn set_selected_track(
    folder: &Path,
    episode_id: &str,
    track_id: u32,
    language: Option<String>,
) -> Result<ProjectJson, ProjectError> {
    let mut project = open_project(folder)?;
    {
        let episode = project
            .episodes
            .iter_mut()
            .find(|e| e.id == episode_id)
            .ok_or(ProjectError::EpisodeNotFound)?;
        episode.selected_subtitle_track_id = Some(track_id);
        episode.selected_subtitle_language = language;
    }
    write_project_json_atomic(folder, &project)?;
    Ok(project)
}

/// Persist a new `default_extract_audio` block into `folder/zimesub.json`
/// and return the post-write [`ProjectJson`]. Slice 0009 wires this to
/// the Project Settings "Trích xuất audio" sub-form.
///
/// `config.codec` is normalised lightly: anything outside the
/// {`libmp3lame`, `aac`, `flac`} set is coerced to `libmp3lame` so a
/// future codec drop can't poison the manifest. `quality_or_bitrate`
/// is preserved verbatim — the per-codec parser tolerates malformed
/// inputs by falling back to the codec's default, and surfacing the
/// raw string lets the UI echo it back unmodified.
pub fn set_default_extract_audio(
    folder: &Path,
    config: ExtractAudioConfig,
) -> Result<ProjectJson, ProjectError> {
    let mut project = open_project(folder)?;
    let normalised_codec = match config.codec.as_str() {
        "libmp3lame" | "aac" | "flac" => config.codec.clone(),
        _ => "libmp3lame".to_string(),
    };
    project.default_extract_audio = ExtractAudioConfig {
        codec: normalised_codec,
        quality_or_bitrate: config.quality_or_bitrate,
    };
    write_project_json_atomic(folder, &project)?;
    Ok(project)
}

fn read_project_json(path: &Path) -> Result<ProjectJson, ProjectError> {
    let text = fs::read_to_string(path)?;
    let project: ProjectJson = serde_json::from_str(&text)?;
    Ok(project)
}

fn write_project_json_atomic(folder: &Path, project: &ProjectJson) -> Result<(), ProjectError> {
    let target = folder.join(PROJECT_FILE_NAME);
    let tmp = tmp_path_beside(&target);
    let serialised = serde_json::to_string_pretty(project)?;
    fs::write(&tmp, serialised)?;
    fs::rename(&tmp, &target)?;
    Ok(())
}

fn tmp_path_beside(path: &Path) -> PathBuf {
    let mut p = path.to_path_buf();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| PROJECT_FILE_NAME.to_string());
    p.set_file_name(format!("{name}.tmp"));
    p
}

/// RFC 3339 timestamp in the system's local timezone, with explicit `±HH:MM`
/// offset (not the `Z` UTC suffix). Matches the PRD example.
pub fn now_local_iso8601() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_dir_for_test(name: &str) -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let path = env::temp_dir().join(format!("zimesub-test-{name}-{pid}-{nanos}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn inspect_empty_folder_reports_safe_to_create() {
        let dir = temp_dir_for_test("inspect-empty");
        let inspection = inspect_folder(&dir).expect("inspect");
        assert!(inspection.exists);
        assert!(inspection.is_empty);
        assert!(!inspection.has_zimesub_json);
        assert!(inspection.existing_project_name.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspect_missing_folder_reports_safe_to_create() {
        let dir = env::temp_dir().join(format!("zimesub-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let inspection = inspect_folder(&dir).expect("inspect");
        assert!(!inspection.exists);
        assert!(inspection.is_empty);
        assert!(!inspection.has_zimesub_json);
    }

    #[test]
    fn inspect_non_empty_folder_without_manifest_blocks_create() {
        let dir = temp_dir_for_test("inspect-nonempty");
        fs::write(dir.join("readme.txt"), b"unrelated").expect("write");
        let inspection = inspect_folder(&dir).expect("inspect");
        assert!(inspection.exists);
        assert!(!inspection.is_empty);
        assert!(!inspection.has_zimesub_json);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspect_folder_with_manifest_reads_project_name() {
        let dir = temp_dir_for_test("inspect-existing");
        let project = create_project(&dir, "Oi Tonbo S2").expect("create");
        let inspection = inspect_folder(&dir).expect("inspect");
        assert!(inspection.has_zimesub_json);
        assert_eq!(inspection.existing_project_name.as_deref(), Some(project.name.as_str()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_project_writes_prd_defaults() {
        let dir = temp_dir_for_test("create-defaults");
        let project = create_project(&dir, "  Sample  ").expect("create");
        assert_eq!(project.version, 1);
        assert_eq!(project.name, "Sample");
        assert!(project.episodes.is_empty());
        assert_eq!(project.default_render_config.encoder, "auto");
        assert_eq!(project.default_render_config.quality, 65);
        assert_eq!(project.default_render_config.audio_codec, "aac");
        assert_eq!(project.default_render_config.audio_bitrate_kbps, 192);
        assert_eq!(project.default_extract_audio.codec, "libmp3lame");
        assert_eq!(project.default_extract_audio.quality_or_bitrate, "q:a 2");

        let on_disk = fs::read_to_string(dir.join(PROJECT_FILE_NAME)).expect("read back");
        let parsed: ProjectJson = serde_json::from_str(&on_disk).expect("parse");
        assert_eq!(parsed.name, "Sample");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_project_rejects_empty_name() {
        let dir = temp_dir_for_test("create-empty-name");
        let err = create_project(&dir, "   ").unwrap_err();
        assert!(matches!(err, ProjectError::NameEmpty));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_project_rejects_existing_manifest() {
        let dir = temp_dir_for_test("create-existing");
        create_project(&dir, "First").expect("first create");
        let err = create_project(&dir, "Second").unwrap_err();
        assert!(matches!(err, ProjectError::FolderHasOtherFiles));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_project_rejects_non_empty_folder_without_manifest() {
        let dir = temp_dir_for_test("create-blocked");
        fs::write(dir.join("notes.txt"), b"hi").expect("write");
        let err = create_project(&dir, "X").unwrap_err();
        assert!(matches!(err, ProjectError::FolderHasOtherFiles));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_project_round_trips() {
        let dir = temp_dir_for_test("open-roundtrip");
        let created = create_project(&dir, "Round").expect("create");
        let opened = open_project(&dir).expect("open");
        assert_eq!(created.name, opened.name);
        assert_eq!(created.created_at, opened.created_at);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_project_errors_when_manifest_missing() {
        let dir = temp_dir_for_test("open-missing");
        let err = open_project(&dir).unwrap_err();
        assert!(matches!(err, ProjectError::NotAProject));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn created_at_is_iso8601_with_offset() {
        let stamp = now_local_iso8601();
        // RFC 3339 form yyyy-mm-ddThh:mm:ss±HH:MM (or Z). Local format is
        // never "Z" in this test environment, but accept either.
        assert!(stamp.len() >= 25);
        assert!(stamp.contains('T'));
        assert!(stamp.contains('+') || stamp.contains('-') || stamp.ends_with('Z'));
    }

    #[test]
    fn sanitize_replaces_each_reserved_char() {
        // Every Windows-reserved character listed in PRD § "Episode import"
        // becomes `_`; everything else passes through unchanged.
        let input = r#"name: <weird> | "name" / good \ ? *"#;
        let got = sanitize_folder_name(input);
        assert_eq!(got, "name_ _weird_ _ _name_ _ good _ _ _");
    }

    #[test]
    fn sanitize_keeps_brackets_and_unicode() {
        // Anime release groups habitually use square brackets and unicode
        // (e.g. `[Erai-raws]`, dashes); none of those are reserved on
        // Windows and must round-trip unchanged.
        let input = "[Erai-raws] Oi Tonbo - 01 [1080p][HEVC][1E1E044E]";
        assert_eq!(sanitize_folder_name(input), input);
    }

    #[test]
    fn sanitize_strips_trailing_dots_and_spaces() {
        // Windows refuses to create folders ending in `.` or ` ` (NTFS
        // quirk) — the helper trims them so the EpisodeFolder write
        // doesn't fall over with a cryptic OS error.
        assert_eq!(sanitize_folder_name("Show 01.   "), "Show 01");
        assert_eq!(sanitize_folder_name("Show 01..."), "Show 01");
    }

    #[test]
    fn sanitize_falls_back_when_input_is_empty_or_all_reserved() {
        assert_eq!(sanitize_folder_name(""), "episode");
        assert_eq!(sanitize_folder_name("...   "), "episode");
        assert_eq!(sanitize_folder_name("////"), "____");
    }

    #[test]
    fn add_episodes_writes_records_and_creates_folders() {
        let dir = temp_dir_for_test("add-episodes-happy");
        create_project(&dir, "AddTest").expect("create");

        let mkv_a = dir
            .parent()
            .unwrap()
            .join(format!("zimesub-source-a-{}.mkv", std::process::id()));
        let mkv_b = dir
            .parent()
            .unwrap()
            .join(format!("zimesub-source-b-{}.mkv", std::process::id()));
        let inputs = vec![
            mkv_a.to_string_lossy().into_owned(),
            mkv_b.to_string_lossy().into_owned(),
        ];

        let outcome = add_episodes(&dir, &inputs).expect("add");
        assert_eq!(outcome.added_count, 2);
        assert!(outcome.duplicates.is_empty());
        assert_eq!(outcome.project.episodes.len(), 2);

        let on_disk = read_project_json(&dir.join(PROJECT_FILE_NAME)).expect("re-read");
        assert_eq!(on_disk.episodes.len(), 2);
        for ep in &on_disk.episodes {
            assert!(!ep.id.is_empty(), "episode id must be uuid v4");
            assert!(ep.selected_subtitle_track_id.is_none());
            assert!(ep.selected_subtitle_language.is_none());
            assert!(ep.render_config_override.is_none());
            assert!(dir.join(&ep.folder_name).is_dir(), "EpisodeFolder must exist");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_episodes_skips_duplicate_source_paths_case_insensitive() {
        let dir = temp_dir_for_test("add-episodes-dup");
        create_project(&dir, "DupTest").expect("create");

        let original = "C:\\Users\\me\\Anime\\Show - 01.mkv".to_string();
        let outcome = add_episodes(&dir, std::slice::from_ref(&original)).expect("add first");
        assert_eq!(outcome.added_count, 1);

        // Second add with the same path (different casing) is treated as a
        // duplicate, reported back to the caller, and not appended.
        let differently_cased = "c:\\Users\\me\\Anime\\Show - 01.MKV".to_string();
        let outcome = add_episodes(&dir, std::slice::from_ref(&differently_cased)).expect("add dup");
        assert_eq!(outcome.added_count, 0);
        assert_eq!(outcome.duplicates.len(), 1);
        assert_eq!(outcome.project.episodes.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_episodes_does_not_rewrite_manifest_when_all_inputs_are_duplicates() {
        let dir = temp_dir_for_test("add-episodes-noop");
        create_project(&dir, "NoopTest").expect("create");

        let path = "C:\\Anime\\Test - 01.mkv".to_string();
        add_episodes(&dir, std::slice::from_ref(&path)).expect("first add");

        let manifest_path = dir.join(PROJECT_FILE_NAME);
        let mtime_before = fs::metadata(&manifest_path).expect("meta").modified().expect("mt");

        // Sleep a beat so a hypothetical rewrite would tick mtime on file
        // systems with second-resolution timestamps.
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let outcome = add_episodes(&dir, std::slice::from_ref(&path)).expect("second add");
        assert_eq!(outcome.added_count, 0);
        assert_eq!(outcome.duplicates.len(), 1);

        let mtime_after = fs::metadata(&manifest_path).expect("meta").modified().expect("mt");
        assert_eq!(
            mtime_before, mtime_after,
            "manifest must not be rewritten when no episodes were added"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_episodes_partial_batch_keeps_valid_siblings() {
        let dir = temp_dir_for_test("add-episodes-partial");
        create_project(&dir, "PartialTest").expect("create");

        let first = "C:\\Anime\\Already.mkv".to_string();
        add_episodes(&dir, std::slice::from_ref(&first)).expect("preload");

        let inputs = vec![
            "C:\\Anime\\Already.mkv".to_string(),
            "C:\\Anime\\NewOne.mkv".to_string(),
            "C:\\Anime\\NewTwo.mkv".to_string(),
        ];
        let outcome = add_episodes(&dir, &inputs).expect("add mixed");
        assert_eq!(outcome.added_count, 2);
        assert_eq!(outcome.duplicates.len(), 1);
        assert_eq!(outcome.project.episodes.len(), 3);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_episodes_errors_when_project_is_missing() {
        let dir = temp_dir_for_test("add-episodes-missing");
        // No create_project call — manifest absent.
        let path = "C:\\Anime\\X.mkv".to_string();
        let err = add_episodes(&dir, std::slice::from_ref(&path)).unwrap_err();
        assert!(matches!(err, ProjectError::NotAProject));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_episodes_strips_mkv_extension_for_folder_name() {
        let dir = temp_dir_for_test("add-episodes-folder-name");
        create_project(&dir, "FolderNameTest").expect("create");

        let inputs = vec!["C:\\Anime\\Show - 01.mkv".to_string()];
        let outcome = add_episodes(&dir, &inputs).expect("add");
        assert_eq!(outcome.added_count, 1);
        assert_eq!(outcome.project.episodes[0].folder_name, "Show - 01");
        assert!(dir.join("Show - 01").is_dir());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_episodes_sanitises_reserved_chars_in_folder_name() {
        let dir = temp_dir_for_test("add-episodes-reserved");
        create_project(&dir, "ReservedTest").expect("create");

        // Path component that uses backslash-escape but contains some
        // reserved characters in the basename itself (not the path separator).
        let inputs = vec![r#"C:\Anime\name: with <reserved> | "stuff".mkv"#.to_string()];
        let outcome = add_episodes(&dir, &inputs).expect("add");
        assert_eq!(outcome.added_count, 1);
        let ep = &outcome.project.episodes[0];
        assert!(!ep.folder_name.contains([':', '<', '>', '|', '"']));
        assert!(dir.join(&ep.folder_name).is_dir());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_selected_track_persists_id_and_language() {
        let dir = temp_dir_for_test("set-selected-track-happy");
        create_project(&dir, "TrackTest").expect("create");
        let inputs = vec!["C:\\Anime\\Show - 01.mkv".to_string()];
        let outcome = add_episodes(&dir, &inputs).expect("add");
        let ep_id = outcome.project.episodes[0].id.clone();

        let updated = set_selected_track(&dir, &ep_id, 2, Some("eng".into())).expect("set");
        assert_eq!(updated.episodes[0].selected_subtitle_track_id, Some(2));
        assert_eq!(updated.episodes[0].selected_subtitle_language.as_deref(), Some("eng"));

        // Round-trip — the manifest on disk must reflect the new fields.
        let on_disk = open_project(&dir).expect("re-open");
        assert_eq!(on_disk.episodes[0].selected_subtitle_track_id, Some(2));
        assert_eq!(on_disk.episodes[0].selected_subtitle_language.as_deref(), Some("eng"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_selected_track_overwrites_previous_pick() {
        let dir = temp_dir_for_test("set-selected-track-overwrite");
        create_project(&dir, "OverwriteTest").expect("create");
        let inputs = vec!["C:\\Anime\\Show - 02.mkv".to_string()];
        let outcome = add_episodes(&dir, &inputs).expect("add");
        let ep_id = outcome.project.episodes[0].id.clone();

        set_selected_track(&dir, &ep_id, 2, Some("eng".into())).expect("first set");
        let updated = set_selected_track(&dir, &ep_id, 3, Some("jpn".into())).expect("second set");
        assert_eq!(updated.episodes[0].selected_subtitle_track_id, Some(3));
        assert_eq!(updated.episodes[0].selected_subtitle_language.as_deref(), Some("jpn"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_selected_track_errors_when_episode_missing() {
        let dir = temp_dir_for_test("set-selected-track-missing-ep");
        create_project(&dir, "MissingEpTest").expect("create");
        let err = set_selected_track(&dir, "no-such-episode-id", 2, None).unwrap_err();
        assert!(matches!(err, ProjectError::EpisodeNotFound));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_selected_track_errors_when_project_missing() {
        let dir = temp_dir_for_test("set-selected-track-no-project");
        let err = set_selected_track(&dir, "any-id", 2, None).unwrap_err();
        assert!(matches!(err, ProjectError::NotAProject));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_episode_targets_returns_source_and_folder_paths() {
        let dir = temp_dir_for_test("resolve-targets-happy");
        create_project(&dir, "ResolveTest").expect("create");
        let inputs = vec!["C:\\Anime\\Show - 03.mkv".to_string()];
        let outcome = add_episodes(&dir, &inputs).expect("add");
        let ep_id = outcome.project.episodes[0].id.clone();

        let targets = resolve_episode_targets(&dir, &ep_id).expect("resolve");
        assert_eq!(
            targets.source_mkv_path.to_string_lossy(),
            "C:\\Anime\\Show - 03.mkv"
        );
        assert_eq!(targets.episode_folder, dir.join("Show - 03"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_episode_targets_errors_for_missing_episode() {
        let dir = temp_dir_for_test("resolve-targets-missing");
        create_project(&dir, "ResolveMissing").expect("create");
        let err = resolve_episode_targets(&dir, "no-such-id").unwrap_err();
        assert!(matches!(err, ProjectError::EpisodeNotFound));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_manifest_without_selected_subtitle_language_loads_cleanly() {
        // Manifest written by a pre-slice-0006 build omits the new field.
        // `#[serde(default)]` must accept the missing key without error.
        let dir = temp_dir_for_test("legacy-manifest");
        fs::create_dir_all(&dir).expect("mkdir");
        let manifest = dir.join(PROJECT_FILE_NAME);
        let body = r#"{
          "version": 1,
          "name": "Legacy",
          "created_at": "2026-06-01T00:00:00+07:00",
          "default_render_config": {
            "encoder": "auto",
            "quality": 65,
            "audio_codec": "aac",
            "audio_bitrate_kbps": 192
          },
          "default_extract_audio": {
            "codec": "libmp3lame",
            "quality_or_bitrate": "q:a 2"
          },
          "episodes": [
            {
              "id": "ep-1",
              "source_mkv_path": "C:\\old\\X.mkv",
              "folder_name": "X",
              "selected_subtitle_track_id": 2,
              "render_config_override": null
            }
          ]
        }"#;
        fs::write(&manifest, body).expect("write legacy");
        let project = open_project(&dir).expect("load legacy");
        assert_eq!(project.episodes.len(), 1);
        assert_eq!(project.episodes[0].selected_subtitle_track_id, Some(2));
        assert!(project.episodes[0].selected_subtitle_language.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_audio_config_default_resolves_mp3_args() {
        let cfg = ExtractAudioConfig::project_default();
        assert_eq!(cfg.output_extension(), "mp3");
        assert_eq!(cfg.quality_args(), vec!["-q:a", "2"]);
    }

    #[test]
    fn extract_audio_config_aac_uses_bitrate_args() {
        let cfg = ExtractAudioConfig {
            codec: "aac".into(),
            quality_or_bitrate: "b:a 256k".into(),
        };
        assert_eq!(cfg.output_extension(), "aac");
        assert_eq!(cfg.quality_args(), vec!["-b:a", "256k"]);
    }

    #[test]
    fn extract_audio_config_flac_has_no_quality_args() {
        let cfg = ExtractAudioConfig {
            codec: "flac".into(),
            quality_or_bitrate: "".into(),
        };
        assert_eq!(cfg.output_extension(), "flac");
        assert!(cfg.quality_args().is_empty());
    }

    #[test]
    fn extract_audio_config_falls_back_on_malformed_quality() {
        let cfg = ExtractAudioConfig {
            codec: "libmp3lame".into(),
            quality_or_bitrate: "totally wrong".into(),
        };
        // Malformed strings → default `-q:a 2`.
        assert_eq!(cfg.quality_args(), vec!["-q:a", "2"]);

        let cfg = ExtractAudioConfig {
            codec: "aac".into(),
            quality_or_bitrate: "nonsense".into(),
        };
        assert_eq!(cfg.quality_args(), vec!["-b:a", "192k"]);
    }

    #[test]
    fn extract_audio_config_clamps_mp3_quality_in_range() {
        let cfg = ExtractAudioConfig {
            codec: "libmp3lame".into(),
            quality_or_bitrate: "q:a 11".into(),
        };
        // Out-of-range quality falls back to default.
        assert_eq!(cfg.quality_args(), vec!["-q:a", "2"]);
    }

    #[test]
    fn set_default_extract_audio_persists_and_round_trips() {
        let dir = temp_dir_for_test("set-extract-audio");
        create_project(&dir, "AudioCfg").expect("create");

        let cfg = ExtractAudioConfig {
            codec: "aac".into(),
            quality_or_bitrate: "b:a 320k".into(),
        };
        let updated = set_default_extract_audio(&dir, cfg).expect("set");
        assert_eq!(updated.default_extract_audio.codec, "aac");
        assert_eq!(updated.default_extract_audio.quality_or_bitrate, "b:a 320k");

        let on_disk = open_project(&dir).expect("re-open");
        assert_eq!(on_disk.default_extract_audio.codec, "aac");
        assert_eq!(on_disk.default_extract_audio.quality_or_bitrate, "b:a 320k");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_default_extract_audio_normalises_unknown_codec() {
        let dir = temp_dir_for_test("set-extract-audio-bogus");
        create_project(&dir, "AudioCfgBogus").expect("create");
        let cfg = ExtractAudioConfig {
            codec: "opus".into(),
            quality_or_bitrate: "b:a 128k".into(),
        };
        let updated = set_default_extract_audio(&dir, cfg).expect("set");
        // Anything outside {libmp3lame, aac, flac} is coerced to mp3
        // so a future-but-unsupported codec can never block extraction.
        assert_eq!(updated.default_extract_audio.codec, "libmp3lame");
        assert_eq!(updated.default_extract_audio.quality_or_bitrate, "b:a 128k");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_default_extract_audio_errors_when_project_missing() {
        let dir = temp_dir_for_test("set-extract-audio-no-proj");
        let err = set_default_extract_audio(
            &dir,
            ExtractAudioConfig::project_default(),
        )
        .unwrap_err();
        assert!(matches!(err, ProjectError::NotAProject));
        let _ = fs::remove_dir_all(&dir);
    }
}
