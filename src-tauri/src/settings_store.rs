//! Read/write `%APPDATA%\ZimeSub\settings.json`.
//!
//! The on-disk schema is forward-compatible: any unknown fields are dropped
//! on load and `#[serde(default)]` is applied to every known field so future
//! slices can extend the file without breaking existing installs.
//!
//! Slice 0002 only persists `tool_paths` + `tool_versions` from the PRD
//! schema; `available_encoders`, `recent_projects`, `queue_concurrency_*`,
//! and the `ui` block land in their respective slices.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// In-memory mirror of `settings.json`. Always serialised with `version: 1`
/// regardless of whether the loaded file claimed an older version — the only
/// other version slice will be a future migration step.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub tool_paths: BTreeMap<String, String>,
    #[serde(default)]
    pub tool_versions: BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            tool_paths: BTreeMap::new(),
            tool_versions: BTreeMap::new(),
        }
    }
}

fn default_version() -> u32 {
    1
}

/// Errors surfaced to callers. We intentionally keep IO failures and parse
/// failures distinct so the caller (commands layer) can log a structured
/// reason without parsing string messages.
#[derive(Debug)]
pub enum StoreError {
    NoAppDataDir,
    Io(io::Error),
    Parse(serde_json::Error),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NoAppDataDir => f.write_str("Roaming AppData directory not available"),
            StoreError::Io(e) => write!(f, "{e}"),
            StoreError::Parse(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(value: io::Error) -> Self {
        StoreError::Io(value)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(value: serde_json::Error) -> Self {
        StoreError::Parse(value)
    }
}

/// Load settings from disk. Missing file → `Settings::default()` (which is
/// the expected first-launch behaviour). Corrupt JSON is propagated so the
/// commands layer can log it and surface a UI error rather than silently
/// stomping the user's file.
pub fn load() -> Result<Settings, StoreError> {
    let path = crate::paths::settings_path().ok_or(StoreError::NoAppDataDir)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(StoreError::Io(e)),
    }
}

/// Atomically persist settings. Writes to a sibling `*.tmp` file and renames
/// over the destination so a mid-write crash never leaves a half-flushed
/// `settings.json`.
pub fn save(settings: &Settings) -> Result<(), StoreError> {
    let path = crate::paths::settings_path().ok_or(StoreError::NoAppDataDir)?;
    ensure_parent_dir(&path)?;
    let tmp = tmp_path_beside(&path);
    let serialised = serde_json::to_string_pretty(settings)?;
    fs::write(&tmp, serialised)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

fn ensure_parent_dir(path: &std::path::Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn tmp_path_beside(path: &std::path::Path) -> PathBuf {
    let mut p = path.to_path_buf();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "settings.json".to_string());
    p.set_file_name(format!("{name}.tmp"));
    p
}
