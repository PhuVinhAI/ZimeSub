//! Read/write `%APPDATA%\ZimeSub\settings.json`.
//!
//! The on-disk schema is forward-compatible: any unknown fields are dropped
//! on load and `#[serde(default)]` is applied to every known field so future
//! slices can extend the file without breaking existing installs.
//!
//! Slice 0004 adds `recent_projects` — the move-to-front MRU list that
//! drives the Sidebar recents and the post-Onboarding auto-open behaviour.
//! Slice 0008 adds `queue_concurrency_extract` — the user-configurable
//! tier budget for the tiered `JobQueue` (max 1 Render + max N Extract).
//! `available_encoders` and the `ui` block land in their respective
//! later slices.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Maximum number of entries kept in `recent_projects`. Anything older than
/// the 20th most-recent open is dropped from the MRU list.
pub const RECENT_PROJECTS_CAP: usize = 20;

/// Default tier budget for the `JobQueue`'s extract jobs (slice 0008).
/// Mirrors `job_queue::DEFAULT_EXTRACT_CONCURRENCY` so the constants
/// stay in sync without a circular module dep.
pub const DEFAULT_QUEUE_CONCURRENCY_EXTRACT: u8 = 2;

/// One entry in `recent_projects`. Stored as an object (not just a path
/// string) so the Sidebar can render "vừa mở" / "X giờ trước" without
/// stat-ing each folder on every render. The PRD's settings example showed
/// just paths; this is a forward-compat extension within the same field.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecentProject {
    pub path: String,
    /// ISO 8601 timestamp with timezone offset. Updated on open/create.
    pub last_opened: String,
}

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
    #[serde(default)]
    pub recent_projects: Vec<RecentProject>,
    /// Tier budget for the JobQueue's extract jobs (`ExtractSubtitle`
    /// plus `ExtractAudio`). Defaults to 2; user-configurable in
    /// Settings (range 1–8, clamped on write). The render tier is
    /// always 1 per ADR-0003 and is not exposed.
    #[serde(default = "default_queue_concurrency_extract")]
    pub queue_concurrency_extract: u8,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            tool_paths: BTreeMap::new(),
            tool_versions: BTreeMap::new(),
            recent_projects: Vec::new(),
            queue_concurrency_extract: DEFAULT_QUEUE_CONCURRENCY_EXTRACT,
        }
    }
}

impl Settings {
    /// Move-to-front insert: stamps `last_opened`, deduplicates by path, and
    /// caps the list at [`RECENT_PROJECTS_CAP`]. Path comparison is
    /// case-insensitive on Windows because Windows file systems are
    /// themselves case-insensitive — without this `C:\foo` and `c:\foo`
    /// would produce duplicate rows in the Sidebar.
    pub fn touch_recent_project(&mut self, path: &str, last_opened: String) {
        self.recent_projects
            .retain(|p| !paths_equal_ignoring_case(&p.path, path));
        self.recent_projects.insert(
            0,
            RecentProject {
                path: path.to_string(),
                last_opened,
            },
        );
        self.recent_projects.truncate(RECENT_PROJECTS_CAP);
    }

    /// Remove any recent entry whose path matches `path` (case-insensitive on
    /// Windows). No-op when the path is not in the list.
    pub fn remove_recent_project(&mut self, path: &str) {
        self.recent_projects
            .retain(|p| !paths_equal_ignoring_case(&p.path, path));
    }
}

fn paths_equal_ignoring_case(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn default_version() -> u32 {
    1
}

fn default_queue_concurrency_extract() -> u8 {
    DEFAULT_QUEUE_CONCURRENCY_EXTRACT
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_recent_inserts_at_front() {
        let mut s = Settings::default();
        s.touch_recent_project(r"C:\one", "2026-01-01T00:00:00+07:00".into());
        s.touch_recent_project(r"C:\two", "2026-01-02T00:00:00+07:00".into());
        assert_eq!(s.recent_projects.len(), 2);
        assert_eq!(s.recent_projects[0].path, r"C:\two");
        assert_eq!(s.recent_projects[1].path, r"C:\one");
    }

    #[test]
    fn touch_recent_deduplicates_and_moves_to_front() {
        let mut s = Settings::default();
        s.touch_recent_project(r"C:\one", "2026-01-01T00:00:00+07:00".into());
        s.touch_recent_project(r"C:\two", "2026-01-02T00:00:00+07:00".into());
        s.touch_recent_project(r"C:\one", "2026-01-03T00:00:00+07:00".into());
        assert_eq!(s.recent_projects.len(), 2);
        assert_eq!(s.recent_projects[0].path, r"C:\one");
        assert_eq!(s.recent_projects[0].last_opened, "2026-01-03T00:00:00+07:00");
    }

    #[test]
    fn touch_recent_is_case_insensitive_on_windows_paths() {
        let mut s = Settings::default();
        s.touch_recent_project(r"C:\Foo", "2026-01-01T00:00:00+07:00".into());
        s.touch_recent_project(r"c:\foo", "2026-01-02T00:00:00+07:00".into());
        assert_eq!(s.recent_projects.len(), 1);
        assert_eq!(s.recent_projects[0].path, r"c:\foo");
    }

    #[test]
    fn touch_recent_caps_at_twenty() {
        let mut s = Settings::default();
        for i in 0..25 {
            s.touch_recent_project(&format!(r"C:\p{i}"), format!("2026-01-01T00:00:{i:02}+07:00"));
        }
        assert_eq!(s.recent_projects.len(), RECENT_PROJECTS_CAP);
        assert_eq!(s.recent_projects[0].path, r"C:\p24");
        assert_eq!(s.recent_projects[RECENT_PROJECTS_CAP - 1].path, r"C:\p5");
    }

    #[test]
    fn remove_recent_drops_matching_path() {
        let mut s = Settings::default();
        s.touch_recent_project(r"C:\one", "2026-01-01T00:00:00+07:00".into());
        s.touch_recent_project(r"C:\two", "2026-01-02T00:00:00+07:00".into());
        s.remove_recent_project(r"C:\ONE");
        assert_eq!(s.recent_projects.len(), 1);
        assert_eq!(s.recent_projects[0].path, r"C:\two");
    }

    #[test]
    fn settings_round_trip_includes_recent_projects() {
        let mut s = Settings::default();
        s.touch_recent_project(r"C:\one", "2026-01-01T00:00:00+07:00".into());
        let text = serde_json::to_string(&s).expect("serialize");
        let back: Settings = serde_json::from_str(&text).expect("deserialize");
        assert_eq!(back.recent_projects.len(), 1);
        assert_eq!(back.recent_projects[0].path, r"C:\one");
    }

    #[test]
    fn settings_loads_without_recent_projects_field() {
        let text = r#"{"version":1,"tool_paths":{},"tool_versions":{}}"#;
        let s: Settings = serde_json::from_str(text).expect("deserialize legacy");
        assert!(s.recent_projects.is_empty());
    }

    #[test]
    fn settings_default_carries_extract_concurrency_two() {
        let s = Settings::default();
        assert_eq!(s.queue_concurrency_extract, 2);
    }

    #[test]
    fn settings_load_legacy_supplies_default_extract_concurrency() {
        // Pre-slice-0008 settings.json had no `queue_concurrency_extract`
        // field. The forward-compat default keeps existing installs
        // working without a migration step.
        let text = r#"{"version":1,"tool_paths":{},"tool_versions":{},"recent_projects":[]}"#;
        let s: Settings = serde_json::from_str(text).expect("deserialize legacy");
        assert_eq!(s.queue_concurrency_extract, 2);
    }

    #[test]
    fn settings_round_trip_preserves_extract_concurrency() {
        let s = Settings {
            queue_concurrency_extract: 5,
            ..Settings::default()
        };
        let text = serde_json::to_string(&s).expect("serialize");
        let back: Settings = serde_json::from_str(&text).expect("deserialize");
        assert_eq!(back.queue_concurrency_extract, 5);
    }
}
