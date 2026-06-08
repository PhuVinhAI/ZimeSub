//! App-data directory resolution.
//!
//! All ZimeSub persistent state lives under `%APPDATA%\ZimeSub\` per the PRD.
//! Tests and tooling code should resolve paths through this module so the
//! `%APPDATA%` substitution stays centralised.

use std::path::PathBuf;

/// Absolute path to `%APPDATA%\ZimeSub\`.
///
/// `None` only if the host has no Roaming AppData directory (extremely
/// unusual on Windows; can happen in stripped CI images).
pub fn app_data_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("ZimeSub"))
}

/// Absolute path to `%APPDATA%\ZimeSub\settings.json`.
pub fn settings_path() -> Option<PathBuf> {
    app_data_dir().map(|p| p.join("settings.json"))
}

/// Absolute path to `%APPDATA%\ZimeSub\logs\zimesub.log`.
pub fn log_path() -> Option<PathBuf> {
    app_data_dir().map(|p| p.join("logs").join("zimesub.log"))
}
