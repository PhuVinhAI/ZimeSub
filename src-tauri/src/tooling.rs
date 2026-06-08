//! RequiredTool detection.
//!
//! Per ADR-0002 and PRD § "Onboarding & tool gating":
//!
//! 1. Probe each tool by `PATH` (via the `which` crate) first, then fall back
//!    to known Windows install paths. Cache the absolute path in
//!    `settings.json`.
//! 2. Run `<tool> --version` to extract the installed version. Compare to a
//!    minimum-version floor:
//!     * `ffmpeg` ≥ 4.0
//!     * `mkvmerge` / `mkvextract` (MKVToolNix) ≥ 60.0
//! 3. Cache is invalidated whenever a cached absolute path no longer exists
//!    on disk (the user uninstalled or reinstalled to a different folder).
//!
//! Install is explicitly out of scope here — that lands in slice 0003.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::settings_store::Settings;

/// Suppress the transient console flash on Windows when running
/// `<tool> --version`. CREATE_NO_WINDOW (`0x08000000`) — see
/// <https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags>.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The three external tools ZimeSub gates the app on.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequiredTool {
    Mkvmerge,
    Mkvextract,
    Ffmpeg,
}

impl RequiredTool {
    pub const ALL: [RequiredTool; 3] = [Self::Mkvmerge, Self::Mkvextract, Self::Ffmpeg];

    pub fn key(self) -> &'static str {
        match self {
            Self::Mkvmerge => "mkvmerge",
            Self::Mkvextract => "mkvextract",
            Self::Ffmpeg => "ffmpeg",
        }
    }

    fn executable_name(self) -> &'static str {
        match self {
            Self::Mkvmerge => "mkvmerge",
            Self::Mkvextract => "mkvextract",
            Self::Ffmpeg => "ffmpeg",
        }
    }

    /// Minimum acceptable version as `(major, minor)`. ADR-0002 fixes these.
    fn floor(self) -> (u32, u32) {
        match self {
            Self::Mkvmerge | Self::Mkvextract => (60, 0),
            Self::Ffmpeg => (4, 0),
        }
    }

    fn floor_string(self) -> String {
        let (maj, min) = self.floor();
        format!("{maj}.{min}")
    }

    /// `ffmpeg` uses a single-flag form, the MKVToolNix tools use the
    /// GNU-style `--version` form.
    fn version_flag(self) -> &'static str {
        match self {
            Self::Mkvmerge | Self::Mkvextract => "--version",
            Self::Ffmpeg => "-version",
        }
    }

    /// Common Windows install locations checked when the tool is not on
    /// `PATH`. winget per-user installs (e.g. `Gyan.FFmpeg`) land under
    /// `%LOCALAPPDATA%\Microsoft\WinGet\Packages\…` with a hashed folder
    /// name that we cannot enumerate without a recursive walk — those are
    /// expected to be on `PATH` already, so the fallbacks here cover the
    /// machine-wide installers people most commonly use.
    fn default_paths(self) -> Vec<PathBuf> {
        match self {
            Self::Mkvmerge => vec![
                PathBuf::from(r"C:\Program Files\MKVToolNix\mkvmerge.exe"),
                PathBuf::from(r"C:\Program Files (x86)\MKVToolNix\mkvmerge.exe"),
            ],
            Self::Mkvextract => vec![
                PathBuf::from(r"C:\Program Files\MKVToolNix\mkvextract.exe"),
                PathBuf::from(r"C:\Program Files (x86)\MKVToolNix\mkvextract.exe"),
            ],
            Self::Ffmpeg => vec![
                PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"),
                PathBuf::from(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"),
                PathBuf::from(r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe"),
            ],
        }
    }
}

/// Status emitted to the frontend for each RequiredTool.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum ToolStatus {
    Missing,
    Outdated,
    Ready,
}

/// Per-tool detection result. Serialised as JSON for the Tauri command
/// surface — keep field names stable; the frontend store/component types
/// mirror them 1:1.
#[derive(Clone, Debug, Serialize)]
pub struct ToolReport {
    pub name: RequiredTool,
    pub status: ToolStatus,
    pub resolved_path: Option<String>,
    pub detected_version: Option<String>,
    pub minimum_version: String,
}

/// Detect all three tools, preferring cached results from `settings` when
/// the cached path still exists on disk. Updates `settings.tool_paths` and
/// `settings.tool_versions` in place so the caller can persist atomically.
pub fn probe_with_cache(settings: &mut Settings) -> Vec<ToolReport> {
    probe_each(settings, true)
}

/// Force a full re-detection, ignoring any cached path. Used by the
/// Onboarding "Quét lại" button.
pub fn probe_fresh(settings: &mut Settings) -> Vec<ToolReport> {
    probe_each(settings, false)
}

fn probe_each(settings: &mut Settings, use_cache: bool) -> Vec<ToolReport> {
    let mut reports = Vec::with_capacity(RequiredTool::ALL.len());
    for tool in RequiredTool::ALL {
        // Explicit reborrow as `&Settings` keeps the closure-free probe call
        // separate from the upcoming `&mut` write below.
        let report = if use_cache {
            probe_one(tool, Some(&*settings))
        } else {
            probe_one(tool, None)
        };
        apply_to_settings(&report, settings);
        reports.push(report);
    }
    reports
}

fn apply_to_settings(report: &ToolReport, settings: &mut Settings) {
    let key = report.name.key().to_string();
    match &report.resolved_path {
        Some(p) => {
            settings.tool_paths.insert(key.clone(), p.clone());
        }
        None => {
            settings.tool_paths.remove(&key);
        }
    }
    match &report.detected_version {
        Some(v) => {
            settings.tool_versions.insert(key, v.clone());
        }
        None => {
            settings.tool_versions.remove(&key);
        }
    }
}

fn probe_one(tool: RequiredTool, settings: Option<&Settings>) -> ToolReport {
    let key = tool.key();
    let floor_string = tool.floor_string();

    if let Some(cache) = settings
        && let Some(cached_path) = cache.tool_paths.get(key)
        && let Some(cached_version) = cache.tool_versions.get(key)
    {
        if Path::new(cached_path).exists() {
            let status = classify(cached_version, tool.floor());
            debug!(tool = key, %cached_path, %cached_version, "tool resolved from cache");
            return ToolReport {
                name: tool,
                status,
                resolved_path: Some(cached_path.clone()),
                detected_version: Some(cached_version.clone()),
                minimum_version: floor_string,
            };
        }
        warn!(tool = key, %cached_path, "cached tool path no longer exists; re-probing");
    }

    let resolved = resolve_path(tool);
    let (path, version) = match resolved {
        Some(p) => {
            let version = read_version(&p, tool);
            (Some(p), version)
        }
        None => (None, None),
    };

    let status = match (&path, &version) {
        (None, _) => ToolStatus::Missing,
        (Some(_), None) => ToolStatus::Outdated,
        (Some(_), Some(v)) => classify(v, tool.floor()),
    };

    match (&path, &version, status) {
        (Some(p), Some(v), s) => {
            info!(tool = key, status = ?s, path = %p.display(), version = %v, "tool probed");
        }
        (Some(p), None, _) => {
            warn!(tool = key, path = %p.display(), "tool found but version unreadable");
        }
        (None, _, _) => {
            info!(tool = key, "tool missing from PATH and default install locations");
        }
    }

    ToolReport {
        name: tool,
        status,
        resolved_path: path.map(|p| p.to_string_lossy().into_owned()),
        detected_version: version,
        minimum_version: floor_string,
    }
}

fn resolve_path(tool: RequiredTool) -> Option<PathBuf> {
    if let Ok(p) = which::which(tool.executable_name())
        && p.exists()
    {
        return Some(p);
    }
    tool.default_paths().into_iter().find(|p| p.exists())
}

fn read_version(path: &Path, tool: RequiredTool) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.arg(tool.version_flag());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // We deliberately do not stream — `--version` exits within tens of ms,
    // so a blocking `output()` keeps the probe simple. If a tool hangs the
    // user's app start gets stuck for the OS subprocess timeout, which we
    // accept as a v1 trade-off (an unresponsive `ffmpeg.exe` is itself a
    // bug worth surfacing).
    let _ = Duration::from_secs(5); // documented intent only — no enforcement in std::process

    let output = cmd.output().ok()?;
    if !output.status.success() && output.stdout.is_empty() && output.stderr.is_empty() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_version_line(&stdout, tool)
        .or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            parse_version_line(&stderr, tool)
        })
}

/// Extract the version string from the first line of a tool's `--version`
/// output. We accept the loose `MAJOR.MINOR(.PATCH)?` shape — pre-releases,
/// build suffixes, and trailing words are all stripped after parsing.
///
/// Sample inputs the regex-free walker below handles:
///
/// * `mkvmerge v84.0 ('Sunshine') 64-bit` → `84.0`
/// * `mkvextract v60.0.0 ('Are You Watching Me') 64-bit` → `60.0.0`
/// * `ffmpeg version 6.1.1-essentials_build-www.gyan.dev …` → `6.1.1`
/// * `ffmpeg version n6.1 Copyright …` → `6.1`
fn parse_version_line(text: &str, tool: RequiredTool) -> Option<String> {
    let first_line = text.lines().next()?;
    let needle = match tool {
        RequiredTool::Mkvmerge | RequiredTool::Mkvextract => " v",
        RequiredTool::Ffmpeg => "version ",
    };
    let idx = first_line.find(needle)?;
    let after = &first_line[idx + needle.len()..];
    let after = after.trim_start_matches(['n', 'N']); // ffmpeg's `n6.1` flavour
    take_dotted_number(after)
}

fn take_dotted_number(s: &str) -> Option<String> {
    let mut end = 0usize;
    let mut seen_digit = false;
    let mut last_was_dot = false;
    for (i, ch) in s.char_indices() {
        match ch {
            '0'..='9' => {
                end = i + ch.len_utf8();
                seen_digit = true;
                last_was_dot = false;
            }
            '.' if seen_digit && !last_was_dot => {
                end = i + ch.len_utf8();
                last_was_dot = true;
            }
            _ => break,
        }
    }
    if !seen_digit {
        return None;
    }
    let trimmed = s[..end].trim_end_matches('.');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn classify(version: &str, floor: (u32, u32)) -> ToolStatus {
    match parse_major_minor(version) {
        Some(actual) if actual >= floor => ToolStatus::Ready,
        Some(_) => ToolStatus::Outdated,
        None => ToolStatus::Outdated,
    }
}

fn parse_major_minor(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u32>().ok().unwrap_or(0);
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mkvmerge_version_line() {
        let line = "mkvmerge v84.0 ('Sunshine') 64-bit\n…";
        assert_eq!(parse_version_line(line, RequiredTool::Mkvmerge).as_deref(), Some("84.0"));
    }

    #[test]
    fn parses_mkvextract_version_line_with_patch() {
        let line = "mkvextract v60.0.0 ('Are You Watching Me') 64-bit";
        assert_eq!(
            parse_version_line(line, RequiredTool::Mkvextract).as_deref(),
            Some("60.0.0")
        );
    }

    #[test]
    fn parses_ffmpeg_version_line_with_build_suffix() {
        let line = "ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2023";
        assert_eq!(parse_version_line(line, RequiredTool::Ffmpeg).as_deref(), Some("6.1.1"));
    }

    #[test]
    fn parses_ffmpeg_version_line_with_n_prefix() {
        let line = "ffmpeg version n6.1 Copyright (c) 2000-2023";
        assert_eq!(parse_version_line(line, RequiredTool::Ffmpeg).as_deref(), Some("6.1"));
    }

    #[test]
    fn ready_when_at_or_above_floor() {
        assert_eq!(classify("84.0", (60, 0)), ToolStatus::Ready);
        assert_eq!(classify("60.0", (60, 0)), ToolStatus::Ready);
        assert_eq!(classify("6.1.1", (4, 0)), ToolStatus::Ready);
    }

    #[test]
    fn outdated_when_below_floor() {
        assert_eq!(classify("59.0", (60, 0)), ToolStatus::Outdated);
        assert_eq!(classify("3.4", (4, 0)), ToolStatus::Outdated);
    }

    #[test]
    fn outdated_when_version_unparseable() {
        assert_eq!(classify("garbage", (4, 0)), ToolStatus::Outdated);
    }
}
