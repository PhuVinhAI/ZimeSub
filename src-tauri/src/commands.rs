//! Thin Tauri command surface for slice 0002.
//!
//! All real logic lives in `tooling` and `settings_store`; commands only:
//!  1. lock shared state,
//!  2. delegate,
//!  3. persist `settings.json`,
//!  4. translate `Result<_, Error>` into the `Result<_, String>` shape Tauri
//!     serialises across the IPC boundary.
//!
//! The frontend (`src/api/tooling.ts`) mirrors the names and shapes here.

use std::sync::Mutex;

use tauri::State;
use tracing::error;

use crate::settings_store::{self, Settings};
use crate::tooling::{self, ToolReport};

/// State managed by Tauri — single source of truth for the in-memory copy
/// of `settings.json`. All command handlers go through this mutex.
pub struct AppState {
    settings: Mutex<Settings>,
}

impl AppState {
    pub fn new() -> Self {
        let settings = settings_store::load().unwrap_or_else(|err| {
            error!(error = %err, "failed to load settings.json; starting with defaults");
            Settings::default()
        });
        Self {
            settings: Mutex::new(settings),
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
/// button. Persists the fresh results.
#[tauri::command]
pub fn tool_rescan(state: State<'_, AppState>) -> Result<Vec<ToolReport>, String> {
    run_probe(state, ProbeMode::Fresh)
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
