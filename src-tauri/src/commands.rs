//! Thin Tauri command surface.
//!
//! All real logic lives in `tooling`, `settings_store`, and `install`;
//! commands only:
//!  1. lock shared state,
//!  2. delegate,
//!  3. persist `settings.json` when relevant,
//!  4. translate `Result<_, Error>` into the `Result<_, String>` shape Tauri
//!     serialises across the IPC boundary.
//!
//! The frontend mirrors the names and shapes here in `src/api/`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, State};
use tracing::error;

use crate::episode_state::{self, EpisodeArtifacts};
use crate::install::{self, InstallRegistry};
use crate::job_queue::{ExtractAudioSpec, ExtractSubtitleSpec, JobQueue, JobSpec, JobsSnapshot};
use crate::mkv_probe::{self, SubtitleTrack};
use crate::process_runner::{self, RunSpec};
use crate::project_store::{
    self, AddEpisodesOutcome, ExtractAudioConfig, FolderInspection, ProjectJson, RecentProjectStatus,
};
use crate::settings_store::{self, Settings};
use crate::tooling::{self, RequiredTool, ToolReport};

/// State managed by Tauri — owns the in-memory copy of `settings.json`,
/// the registry of in-flight winget installs, and a lazy handle to the
/// background [`JobQueue`]. All command handlers route through this
/// struct.
pub struct AppState {
    settings: Mutex<Settings>,
    installs: Arc<InstallRegistry>,
    /// Lazy: instantiated on the first job command (extract-subtitle
    /// start/cancel) because [`JobQueue::new`] needs an `AppHandle`,
    /// which only Tauri command handlers see. `OnceLock` keeps the
    /// init thread-safe and avoids spawning the worker task on apps
    /// that never reach the pipeline (e.g. an Onboarding-only session).
    jobs: OnceLock<Arc<JobQueue>>,
}

impl AppState {
    pub fn new() -> Self {
        let settings = settings_store::load().unwrap_or_else(|err| {
            error!(error = %err, "failed to load settings.json; starting with defaults");
            Settings::default()
        });
        Self {
            settings: Mutex::new(settings),
            installs: Arc::new(InstallRegistry::new()),
            jobs: OnceLock::new(),
        }
    }

    /// Lazily spawn the [`JobQueue`] worker task on first use, then
    /// hand back the shared `Arc` handle for subsequent commands.
    /// The persisted `queue_concurrency_extract` setting seeds the
    /// tier budget; subsequent changes via `settings_set_queue_concurrency`
    /// propagate at runtime through `set_extract_concurrency`.
    fn jobs(&self, app: &AppHandle) -> Arc<JobQueue> {
        self.jobs
            .get_or_init(|| {
                let initial = match self.settings.lock() {
                    Ok(s) => s.queue_concurrency_extract,
                    Err(_) => settings_store::DEFAULT_QUEUE_CONCURRENCY_EXTRACT,
                };
                JobQueue::new(app.clone(), initial)
            })
            .clone()
    }
}

/// Detect tools, preferring cached entries from `settings.json` when their
/// absolute paths still exist on disk. Persists any cache updates.
#[tauri::command]
pub fn tool_probe(state: State<'_, AppState>) -> Result<Vec<ToolReport>, String> {
    run_probe(state, ProbeMode::Cached)
}

/// Full re-detect ignoring cache — wired to the Onboarding "Quét lại"
/// button and the Settings re-check action. Persists the fresh results.
#[tauri::command]
pub fn tool_rescan(state: State<'_, AppState>) -> Result<Vec<ToolReport>, String> {
    run_probe(state, ProbeMode::Fresh)
}

/// Probe whether `winget` itself is on PATH. Drives the Onboarding fallback
/// (Win 10 pre-1809 / locked-down enterprise machines get the manual
/// download buttons instead of the install button).
#[tauri::command]
pub fn winget_available() -> bool {
    install::winget_available()
}

/// Kick off a winget install for the given `RequiredTool`. Returns as soon
/// as the child process is spawned; progress and completion are reported
/// via the `tool-install-log` and `tool-install-done` events.
///
/// `install_id` is supplied by the frontend so it can correlate log/done
/// events with the originating click — useful when the user fires multiple
/// installs in sequence.
#[tauri::command]
pub async fn tool_install_start(
    app: AppHandle,
    state: State<'_, AppState>,
    install_id: String,
    tool: RequiredTool,
) -> Result<(), String> {
    let registry = state.installs.clone();
    install::start_install(app, registry, install_id, tool)
        .await
        .map_err(|e| e.to_string())
}

/// Cancel a running install — kills the winget child process and surfaces
/// the resulting `done` event with `cancelled: true`.
#[tauri::command]
pub fn tool_install_cancel(
    state: State<'_, AppState>,
    install_id: String,
) -> Result<(), String> {
    install::cancel_install(state.installs.as_ref(), &install_id)
}

enum ProbeMode {
    Cached,
    Fresh,
}

fn run_probe(state: State<'_, AppState>, mode: ProbeMode) -> Result<Vec<ToolReport>, String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|e| format!("settings mutex poisoned: {e}"))?;

    let reports = match mode {
        ProbeMode::Cached => tooling::probe_with_cache(&mut settings),
        ProbeMode::Fresh => tooling::probe_fresh(&mut settings),
    };

    if let Err(err) = settings_store::save(&settings) {
        error!(error = %err, "failed to persist settings.json after probe");
    }

    Ok(reports)
}

/// Inspect `folder` so the Create Project modal can route between
/// "Tạo" / "Mở project hiện có" / blocking error. Never mutates the
/// folder.
#[tauri::command]
pub fn project_inspect_folder(folder: String) -> Result<FolderInspection, String> {
    project_store::inspect_folder(Path::new(&folder)).map_err(|e| e.to_string())
}

/// Create a fresh `zimesub.json` inside `folder` and bump the project to
/// the head of `recent_projects` in app settings. Returns the new
/// project so the frontend can render the Main view without a second
/// open round-trip.
#[tauri::command]
pub fn project_create(
    state: State<'_, AppState>,
    folder: String,
    name: String,
) -> Result<ProjectJson, String> {
    let project = project_store::create_project(Path::new(&folder), &name)
        .map_err(|e| e.to_string())?;
    touch_recent_and_save(&state, &folder)?;
    Ok(project)
}

/// Read `zimesub.json` from `folder` and bump it to the head of
/// `recent_projects`. Returns the parsed project.
///
/// Slice 0008: after the manifest is read, walks every Episode's
/// folder for 0-byte `.mp4` / `.ass` artefacts and deletes them
/// (crash-recovery — a Render or ExtractSubtitle that died before
/// flushing leaves an empty file behind that would otherwise be
/// misread as a real artefact on next open). Deletions are logged at
/// `info` and never block the open even on partial failure.
#[tauri::command]
pub fn project_open(state: State<'_, AppState>, folder: String) -> Result<ProjectJson, String> {
    let project_folder = Path::new(&folder);
    let project = project_store::open_project(project_folder).map_err(|e| e.to_string())?;
    for episode in &project.episodes {
        let episode_folder = project_folder.join(&episode.folder_name);
        let _ = episode_state::clean_stale_artifacts(&episode_folder);
    }
    touch_recent_and_save(&state, &folder)?;
    Ok(project)
}

/// Enumerate `recent_projects` from app settings, enriched with liveness
/// flags (`folder_exists`, `has_zimesub_json`) and the project name when
/// readable. Most-recent-first ordering is preserved from the underlying
/// settings list.
#[tauri::command]
pub fn project_list_recents(
    state: State<'_, AppState>,
) -> Result<Vec<RecentProjectStatus>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|e| format!("settings mutex poisoned: {e}"))?;

    let recents: Vec<RecentProjectStatus> = settings
        .recent_projects
        .iter()
        .map(|entry| {
            let path = Path::new(&entry.path);
            let folder_exists = project_store::folder_exists(path);
            let has_zimesub_json = folder_exists && project_store::folder_has_manifest(path);
            let name = if has_zimesub_json {
                project_store::peek_project_name(path)
            } else {
                None
            };
            RecentProjectStatus {
                path: entry.path.clone(),
                last_opened: entry.last_opened.clone(),
                folder_exists,
                has_zimesub_json,
                name,
            }
        })
        .collect();

    Ok(recents)
}

/// Append one Episode per entry in `source_paths` to the project at
/// `folder`. Each accepted entry produces a new EpisodeFolder on disk and
/// a new record in `episodes`; duplicates (same `source_mkv_path`,
/// case-insensitive) are returned in the outcome's `duplicates` list so
/// the frontend can show a yellow toast per skipped entry.
///
/// Frontend filters out non-`.mkv` paths before invoking — the AC keeps
/// the validation in the UI so the toast text can carry the offending
/// filename, and so a future "Add Episode…" multi-file picker that
/// already constrains by extension can call this command without
/// re-checking.
#[tauri::command]
pub fn project_add_episodes(
    folder: String,
    source_paths: Vec<String>,
) -> Result<AddEpisodesOutcome, String> {
    project_store::add_episodes(Path::new(&folder), &source_paths).map_err(|e| e.to_string())
}

/// Drop one entry from `recent_projects`. Wired to the "Gỡ khỏi danh
/// sách" button on missing rows in the Sidebar.
#[tauri::command]
pub fn project_remove_recent(state: State<'_, AppState>, folder: String) -> Result<(), String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|e| format!("settings mutex poisoned: {e}"))?;
    settings.remove_recent_project(&folder);
    if let Err(err) = settings_store::save(&settings) {
        error!(error = %err, "failed to persist settings.json after removing recent");
        return Err(err.to_string());
    }
    Ok(())
}

/// Outcome of [`episode_list_subtitle_tracks`].
///
/// `ok` is `true` when `mkvmerge` exited 0 *and* the stdout parsed
/// cleanly — the modal renders the table from `tracks` + `preselected_index`.
/// `ok = false` carries the captured `stderr` so the modal can render
/// it verbatim in a Geist Mono pane next to a "Thử lại" button (AC).
///
/// `preselected_index` is the heuristic-suggested row to highlight on
/// open (PRD rules 1 → 2 → 3 in slice 0006 AC); `None` means no
/// selectable row exists and the modal must surface the "Không có
/// subtitle track text-based trong file này" empty-state copy instead.
#[derive(Debug, Serialize)]
pub struct ListSubtitleTracksOutcome {
    pub ok: bool,
    pub tracks: Vec<SubtitleTrack>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preselected_index: Option<u32>,
    pub stderr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// Run `mkvmerge -i -F json <source_mkv_path>` for `episode_id` inside
/// the project at `folder`, parse the captured stdout into typed
/// [`SubtitleTrack`]s, and apply the slice 0006 pre-selection heuristic.
///
/// Spawn convention:
///  * `cwd` = EpisodeFolder, per PRD § "Process spawn rules". The
///    mkvmerge probe itself doesn't care about cwd, but routing all
///    subprocess calls through the same convention means the
///    eventual streaming extract job in slice 0007 picks up the same
///    log lines without changing how it's invoked.
///  * `executable` = `settings.tool_paths["mkvmerge"]`. If the cache
///    is empty (e.g. user wiped settings.json after Onboarding) the
///    command rejects with "Chưa phát hiện đường dẫn mkvmerge".
///
/// Failure modes:
///  * Spawn failure (binary missing, file lock, etc.) → `Err(String)`
///    surfaced verbatim by the frontend as a danger toast.
///  * Non-zero exit code → `Ok(ListSubtitleTracksOutcome { ok: false,
///    stderr, … })` so the modal renders the stderr pane + "Thử lại"
///    button per AC.
///  * Parser failure on otherwise-zero exit → same as non-zero exit
///    above, with the parser error prefixed onto `stderr` so the user
///    sees both the OS-level output and the parse hint.
#[tauri::command]
pub fn episode_list_subtitle_tracks(
    state: State<'_, AppState>,
    folder: String,
    episode_id: String,
) -> Result<ListSubtitleTracksOutcome, String> {
    let project_folder = Path::new(&folder);
    let targets = project_store::resolve_episode_targets(project_folder, &episode_id)
        .map_err(|e| e.to_string())?;

    let mkvmerge_path = {
        let settings = state
            .settings
            .lock()
            .map_err(|e| format!("settings mutex poisoned: {e}"))?;
        settings
            .tool_paths
            .get("mkvmerge")
            .cloned()
            .ok_or_else(|| "Chưa phát hiện đường dẫn mkvmerge".to_string())?
    };

    let run_outcome = process_runner::run_to_completion(RunSpec {
        executable: PathBuf::from(&mkvmerge_path),
        args: vec![
            "-i".into(),
            "-F".into(),
            "json".into(),
            targets.source_mkv_path.to_string_lossy().into_owned(),
        ],
        cwd: &targets.episode_folder,
    })
    .map_err(|e| e.to_string())?;

    if !run_outcome.success() {
        return Ok(ListSubtitleTracksOutcome {
            ok: false,
            tracks: Vec::new(),
            preselected_index: None,
            stderr: run_outcome.stderr,
            exit_code: run_outcome.exit_code,
        });
    }

    match mkv_probe::parse_mkvmerge_json(&run_outcome.stdout) {
        Ok(tracks) => {
            let preselected_index = mkv_probe::preselect_index(&tracks).map(|i| i as u32);
            Ok(ListSubtitleTracksOutcome {
                ok: true,
                tracks,
                preselected_index,
                stderr: run_outcome.stderr,
                exit_code: run_outcome.exit_code,
            })
        }
        Err(err) => Ok(ListSubtitleTracksOutcome {
            ok: false,
            tracks: Vec::new(),
            preselected_index: None,
            stderr: format!("{err}\n{}", run_outcome.stderr),
            exit_code: run_outcome.exit_code,
        }),
    }
}

/// Persist `track_id` (and the denormalised `language` display cache)
/// as the user's pick for `episode_id` in the project at `folder`.
/// Returns the post-write [`ProjectJson`] so the frontend can update
/// `active` without a second `project_open` round-trip.
///
/// `language` carries the 3-letter ISO 639-2 code (`eng`, `jpn`,
/// `und`) for the Episode row's language tag. The track id remains
/// the source of truth for the extract pipeline.
#[tauri::command]
pub fn project_set_selected_track(
    folder: String,
    episode_id: String,
    track_id: u32,
    language: Option<String>,
) -> Result<ProjectJson, String> {
    project_store::set_selected_track(Path::new(&folder), &episode_id, track_id, language)
        .map_err(|e| e.to_string())
}

/// Disk-artefact snapshot for one Episode — the disk half of the
/// PRD's `derive_state` pseudocode. Slice 0007 only flips
/// `has_extracted_sub`; slice 0009 lights up `has_extracted_audio`
/// (the audio is decorative — the EpisodeState progression does not
/// depend on it). The remaining two fields stay placeholders for the
/// translate / render stages.
///
/// `output_basename` echoes back the EpisodeFolder name so the
/// frontend can render the resolved artefact path (`<basename>.eng.ass`)
/// in tooltips and the "open in Explorer" affordance later without a
/// second round-trip through `resolve_episode_targets`.
///
/// `audio_extension` is the codec extension the project is configured
/// for (`mp3` / `aac` / `flac`); the frontend uses it both to render
/// the "audio" indicator's tooltip (`Đã có <basename>.<ext>`) and to
/// resolve the artefact path on click-to-open later.
#[derive(Debug, Serialize)]
pub struct EpisodeArtifactsView {
    pub has_extracted_sub: bool,
    pub has_extracted_audio: bool,
    pub has_translation_draft: bool,
    pub has_translated_sub: bool,
    pub has_render: bool,
    pub output_basename: String,
    pub audio_extension: String,
}

impl EpisodeArtifactsView {
    fn from_inspection(
        inspected: EpisodeArtifacts,
        output_basename: String,
        audio_extension: String,
    ) -> Self {
        Self {
            has_extracted_sub: inspected.has_extracted_sub,
            has_extracted_audio: inspected.has_extracted_audio,
            has_translation_draft: inspected.has_translation_draft,
            has_translated_sub: inspected.has_translated_sub,
            has_render: inspected.has_render,
            output_basename,
            audio_extension,
        }
    }
}

/// Inspect the on-disk artefacts inside `episode_id`'s EpisodeFolder
/// and return a typed snapshot the frontend overlays with its live
/// JobsStore phase to pick the row badge.
///
/// Called by the frontend on three occasions:
///  * Project open / project switch — once per Episode, so the row
///    boots with the correct "Trống" vs "Đã extract" badge instead
///    of always defaulting to "Trống".
///  * After a `job-done` event for the Episode — refresh the single
///    row so the badge flips to "Đã extract" the moment mkvextract
///    finishes (per the AC's "EpisodeState is recomputed from disk"
///    requirement).
///  * On the overwrite-confirm path — to decide whether to surface
///    the modal at all.
#[tauri::command]
pub fn episode_inspect_artifacts(
    folder: String,
    episode_id: String,
) -> Result<EpisodeArtifactsView, String> {
    let project_folder = Path::new(&folder);
    let project = project_store::open_project(project_folder).map_err(|e| e.to_string())?;
    let episode = project
        .episodes
        .iter()
        .find(|e| e.id == episode_id)
        .ok_or_else(|| "Không tìm thấy Episode trong project".to_string())?;
    let episode_folder = project_folder.join(&episode.folder_name);
    let basename = episode.folder_name.clone();
    let audio_extension = project.default_extract_audio.output_extension().to_string();
    let inspected = episode_state::inspect_artifacts(
        &episode_folder,
        &basename,
        Some(&audio_extension),
    );
    Ok(EpisodeArtifactsView::from_inspection(
        inspected,
        basename,
        audio_extension,
    ))
}

/// Enqueue a fresh `ExtractSubtitle` job for `episode_id` on the
/// background queue. Returns as soon as the spec is on the queue —
/// the worker emits `jobs-changed` (full snapshot) and `job-progress`
/// (per-line) events the frontend subscribes to.
///
/// Pre-conditions enforced here (failure is surfaced as a danger
/// toast on the frontend rather than a queued job that nobody
/// finishes):
///  * The project at `folder` loads and contains `episode_id`.
///  * `selected_subtitle_track_id` is set on that Episode — without
///    it, slice 0006's track picker hasn't run yet and the AC
///    explicitly disables the "Trích xuất sub" button.
///  * The cached `mkvextract` path in `settings.tool_paths` resolves.
///    The Onboarding gate guarantees this in normal flow; surfacing
///    a Vietnamese error string keeps the post-cache-wipe edge case
///    debuggable.
///
/// `job_id` is generated frontend-side (uuid) so progress + change
/// events can be correlated with the originating click — same
/// pattern the winget install flow uses.
#[tauri::command]
pub async fn extract_subtitle_start(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    folder: String,
    episode_id: String,
) -> Result<(), String> {
    let project_folder = Path::new(&folder);
    let project = project_store::open_project(project_folder).map_err(|e| e.to_string())?;
    let episode = project
        .episodes
        .iter()
        .find(|e| e.id == episode_id)
        .ok_or_else(|| "Không tìm thấy Episode trong project".to_string())?;
    let track_id = episode
        .selected_subtitle_track_id
        .ok_or_else(|| "Chưa chọn subtitle track cho Episode này".to_string())?;

    let mkvextract_path = {
        let settings = state
            .settings
            .lock()
            .map_err(|e| format!("settings mutex poisoned: {e}"))?;
        settings
            .tool_paths
            .get("mkvextract")
            .cloned()
            .ok_or_else(|| "Chưa phát hiện đường dẫn mkvextract".to_string())?
    };

    let episode_folder = project_folder.join(&episode.folder_name);
    let spec = ExtractSubtitleSpec {
        job_id,
        episode_id,
        episode_name: episode.folder_name.clone(),
        project_folder: project_folder.to_path_buf(),
        mkvextract_path: PathBuf::from(mkvextract_path),
        source_mkv_path: PathBuf::from(&episode.source_mkv_path),
        episode_folder,
        mkv_track_id: track_id,
        output_basename: episode.folder_name.clone(),
    };

    let jobs = state.jobs(&app);
    jobs.enqueue(JobSpec::ExtractSubtitle(spec)).await;
    Ok(())
}

/// Cancel a queued or running extract-subtitle job by id. Idempotent:
/// cancelling an already-cancelled or already-finished job is a no-op
/// and returns `Ok(())`. The job's cleanup pass takes care of removing
/// any partial output the cancel interrupted. Kept as a separate
/// command (alongside the generic [`job_cancel`]) so existing UI
/// surfaces that don't yet read the Jobs panel can keep their
/// per-Episode "Hủy" affordance without churn.
#[tauri::command]
pub async fn extract_subtitle_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let jobs = state.jobs(&app);
    let _ = jobs.cancel(&job_id).await;
    Ok(())
}

/// Enqueue a fresh `ExtractAudio` job for `episode_id`. Slice 0009.
///
/// Audio extraction is independent of the subtitle stage — the
/// button is enabled regardless of `selected_subtitle_track_id` and
/// the resulting artefact is decorative (does not gate EpisodeState
/// progression). The only pre-conditions are that the project at
/// `folder` loads, `episode_id` exists, and the cached `ffmpeg` path
/// resolves.
///
/// The codec / quality used are read from the project's
/// `default_extract_audio` block (managed via the Settings panel
/// sub-form). The runner resolves the per-codec output extension and
/// ffmpeg quality argv via [`ExtractAudioConfig::output_extension`]
/// and [`ExtractAudioConfig::quality_args`].
#[tauri::command]
pub async fn extract_audio_start(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    folder: String,
    episode_id: String,
) -> Result<(), String> {
    let project_folder = Path::new(&folder);
    let project = project_store::open_project(project_folder).map_err(|e| e.to_string())?;
    let episode = project
        .episodes
        .iter()
        .find(|e| e.id == episode_id)
        .ok_or_else(|| "Không tìm thấy Episode trong project".to_string())?;

    let (ffmpeg_path, mkvmerge_path) = {
        let settings = state
            .settings
            .lock()
            .map_err(|e| format!("settings mutex poisoned: {e}"))?;
        let ffmpeg = settings
            .tool_paths
            .get("ffmpeg")
            .cloned()
            .ok_or_else(|| "Chưa phát hiện đường dẫn ffmpeg".to_string())?;
        let mkvmerge = settings.tool_paths.get("mkvmerge").cloned();
        (ffmpeg, mkvmerge)
    };

    let audio_cfg = project.default_extract_audio.clone();
    let output_extension = audio_cfg.output_extension().to_string();
    let quality_args = audio_cfg.quality_args();

    let episode_folder = project_folder.join(&episode.folder_name);
    let spec = ExtractAudioSpec {
        job_id,
        episode_id,
        episode_name: episode.folder_name.clone(),
        project_folder: project_folder.to_path_buf(),
        ffmpeg_path: PathBuf::from(ffmpeg_path),
        mkvmerge_path: mkvmerge_path.map(PathBuf::from),
        source_mkv_path: PathBuf::from(&episode.source_mkv_path),
        episode_folder,
        output_basename: episode.folder_name.clone(),
        codec: audio_cfg.codec,
        output_extension,
        quality_args,
    };

    let jobs = state.jobs(&app);
    jobs.enqueue(JobSpec::ExtractAudio(spec)).await;
    Ok(())
}

/// Cancel a queued or running extract-audio job by id. Mirrors the
/// subtitle variant — idempotent on unknown / terminal ids, partial
/// output cleanup happens inside the runner.
#[tauri::command]
pub async fn extract_audio_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let jobs = state.jobs(&app);
    let _ = jobs.cancel(&job_id).await;
    Ok(())
}

/// Read the project's `default_extract_audio` config. Drives the
/// Settings panel sub-form on open so the dropdown + quality field
/// boot with the persisted choice.
#[tauri::command]
pub fn project_get_extract_audio_config(folder: String) -> Result<ExtractAudioConfig, String> {
    let project = project_store::open_project(Path::new(&folder)).map_err(|e| e.to_string())?;
    Ok(project.default_extract_audio)
}

/// Persist a new `default_extract_audio` block. Used by the Settings
/// panel sub-form's commit path. Returns the post-write
/// [`ProjectJson`] so the frontend can swap `active` without a
/// second `project_open` round-trip.
#[tauri::command]
pub fn project_set_extract_audio_config(
    folder: String,
    config: ExtractAudioConfig,
) -> Result<ProjectJson, String> {
    project_store::set_default_extract_audio(Path::new(&folder), config)
        .map_err(|e| e.to_string())
}

/// Snapshot of the entire `JobQueue` — drives the Jobs panel on
/// mount. Subsequent updates flow through the `jobs-changed` event
/// so the panel doesn't have to re-poll.
#[tauri::command]
pub async fn job_snapshot(app: AppHandle, state: State<'_, AppState>) -> Result<JobsSnapshot, String> {
    let jobs = state.jobs(&app);
    Ok(jobs.snapshot().await)
}

/// Generic job cancel — same semantics as [`extract_subtitle_cancel`]
/// but agnostic to `JobKind`. Pending jobs are dropped from the
/// queue with no on-disk cleanup (matches the AC's "Removing a
/// Pending Job: just pops from the queue. No process, no cleanup");
/// Running jobs have their process tree killed and the per-`JobKind`
/// cleanup pass deletes their partial output.
#[tauri::command]
pub async fn job_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let jobs = state.jobs(&app);
    let _ = jobs.cancel(&job_id).await;
    Ok(())
}

/// Remove a Pending job from the queue without touching the process
/// or on-disk state. Drives the Jobs panel's "Xóa" affordance.
/// Already-Running / -Done / -Failed / -Cancelled rows are immovable
/// and this command no-ops on them (the UI hides the button anyway).
#[tauri::command]
pub async fn job_remove_pending(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let jobs = state.jobs(&app);
    let _ = jobs.remove_pending(&job_id).await;
    Ok(())
}

/// Read the current `queue_concurrency_extract` setting. Returns the
/// persisted value (forward-compat default supplies `2` for installs
/// from before slice 0008).
#[tauri::command]
pub fn settings_get_queue_concurrency(state: State<'_, AppState>) -> Result<u8, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|e| format!("settings mutex poisoned: {e}"))?;
    Ok(settings.queue_concurrency_extract)
}

/// Update `queue_concurrency_extract` (1–8, clamped) and propagate
/// the new value to the live `JobQueue` so freed extract slots take
/// effect for newly-dispatched jobs without a restart, per AC.
/// Returns the post-clamp value so the UI can echo the actual
/// stored number even if the input was out of range.
#[tauri::command]
pub async fn settings_set_queue_concurrency(
    app: AppHandle,
    state: State<'_, AppState>,
    value: u8,
) -> Result<u8, String> {
    let clamped = value.clamp(1, crate::job_queue::MAX_EXTRACT_CONCURRENCY);
    {
        let mut settings = state
            .settings
            .lock()
            .map_err(|e| format!("settings mutex poisoned: {e}"))?;
        settings.queue_concurrency_extract = clamped;
        if let Err(err) = settings_store::save(&settings) {
            error!(error = %err, "failed to persist settings.json after queue concurrency change");
            return Err(err.to_string());
        }
    }
    let jobs = state.jobs(&app);
    jobs.set_extract_concurrency(clamped).await;
    Ok(clamped)
}

/// Move `folder` to the head of `recent_projects` with a fresh
/// `last_opened` stamp and flush settings to disk. Used by both
/// `project_create` and `project_open` so the recents MRU stays in sync
/// regardless of which entry point the user took.
fn touch_recent_and_save(state: &State<'_, AppState>, folder: &str) -> Result<(), String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|e| format!("settings mutex poisoned: {e}"))?;
    settings.touch_recent_project(folder, project_store::now_local_iso8601());
    if let Err(err) = settings_store::save(&settings) {
        error!(error = %err, "failed to persist settings.json after project touch");
        return Err(err.to_string());
    }
    Ok(())
}
