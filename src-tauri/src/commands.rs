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

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};
use tracing::error;

use crate::install::{self, InstallRegistry};
use crate::project_store::{
    self, AddEpisodesOutcome, FolderInspection, ProjectJson, RecentProjectStatus,
};
use crate::settings_store::{self, Settings};
use crate::tooling::{self, RequiredTool, ToolReport};

/// State managed by Tauri — owns the in-memory copy of `settings.json` and
/// the registry of in-flight winget installs. All command handlers route
/// through this struct.
pub struct AppState {
    settings: Mutex<Settings>,
    installs: Arc<InstallRegistry>,
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
        }
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
#[tauri::command]
pub fn project_open(state: State<'_, AppState>, folder: String) -> Result<ProjectJson, String> {
    let project = project_store::open_project(Path::new(&folder)).map_err(|e| e.to_string())?;
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
