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

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};
use tracing::error;

use crate::install::{self, InstallRegistry};
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
