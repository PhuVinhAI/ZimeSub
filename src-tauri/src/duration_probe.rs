//! Query the total duration of a media file in microseconds.
//!
//! Used by the slice 0009 audio-extract runner to combine ffmpeg's
//! `time=HH:MM:SS.cs` elapsed counter with a known total, yielding the
//! same `[0, 1]` progress ratio the mkvextract pipeline already
//! produces.
//!
//! Two probe sources, tried in order:
//!  1. `mkvmerge -J <source>` — emits a JSON `container.properties.duration`
//!     value in nanoseconds. Already a hard dependency of the app, so
//!     this is the preferred probe.
//!  2. `ffprobe -hide_banner -loglevel error -show_entries format=duration
//!     -of default=noprint_wrappers=1:nokey=1 <source>` — emits the
//!     duration as a decimal seconds value. Used when mkvmerge fails
//!     (corrupt MKV, unusual container) or when the path doesn't end
//!     in `.mkv`.
//!
//! If both fail, the caller falls back to an indeterminate spinner
//! with line count (per AC). The runner handles that branch — this
//! module only reports `Option<u64>` microseconds.

use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Pure parser: walk `mkvmerge -J` stdout looking for
/// `container.properties.duration`. Returns microseconds, or `None`
/// when the field is missing or malformed.
///
/// Kept as a free function next to the spawn helper so unit tests can
/// pin fixture JSON without going through the OS.
pub fn parse_mkvmerge_duration_us(stdout: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(stdout).ok()?;
    let duration_ns = value
        .get("container")
        .and_then(|c| c.get("properties"))
        .and_then(|p| p.get("duration"))
        .and_then(|d| d.as_u64())?;
    Some(duration_ns / 1_000)
}

/// Pure parser: parse `ffprobe -show_entries format=duration -of
/// default=noprint_wrappers=1:nokey=1` stdout. ffprobe prints a single
/// decimal value (`"1420.000000\n"`) which we multiply out into
/// microseconds.
pub fn parse_ffprobe_duration_us(stdout: &str) -> Option<u64> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    let seconds: f64 = trimmed.parse().ok()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    Some((seconds * 1_000_000.0) as u64)
}

/// Probe the source's duration via `mkvmerge -J`.
///
/// Spawn failure / non-zero exit / parse failure all map to `None`;
/// the caller chains into the ffprobe path before falling back to the
/// indeterminate spinner branch.
pub fn probe_duration_via_mkvmerge(mkvmerge_path: &Path, source: &Path) -> Option<u64> {
    let mut cmd = Command::new(mkvmerge_path);
    cmd.arg("-J")
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_mkvmerge_duration_us(&stdout)
}

/// Probe the source's duration via `ffprobe`. Returns `None` when
/// ffprobe is not on disk (e.g. user only has ffmpeg in PATH and not
/// the companion ffprobe binary — rare but possible on shipped
/// portable builds), spawns but exits non-zero, or emits a value we
/// can't parse.
pub fn probe_duration_via_ffprobe(ffprobe_path: &Path, source: &Path) -> Option<u64> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_ffprobe_duration_us(&stdout)
}

/// Resolve a likely `ffprobe.exe` path from the cached `ffmpeg.exe`
/// path. Both binaries ship in the same `bin/` directory on the
/// official Gyan builds Onboarding installs, so we just swap the
/// filename — no PATH lookup, no second probe.
///
/// Returns `None` when the swap would produce an obviously-invalid
/// path (e.g. ffmpeg is at the filesystem root or the file_name slot
/// is empty for some reason).
pub fn ffprobe_path_from_ffmpeg(ffmpeg_path: &Path) -> Option<std::path::PathBuf> {
    let parent = ffmpeg_path.parent()?;
    let file_name = ffmpeg_path.file_name()?.to_string_lossy().to_lowercase();
    let candidate_name = if file_name.ends_with(".exe") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let candidate = parent.join(candidate_name);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mkvmerge_duration_field_in_nanoseconds() {
        // `mkvmerge -J` reports duration in nanoseconds. 23m40s = 1.42e12 ns.
        let json = r#"{
          "container": {
            "properties": { "duration": 1420000000000 }
          },
          "tracks": []
        }"#;
        assert_eq!(parse_mkvmerge_duration_us(json), Some(1_420_000_000));
    }

    #[test]
    fn mkvmerge_duration_returns_none_when_field_missing() {
        let json = r#"{ "container": { "properties": {} }, "tracks": [] }"#;
        assert_eq!(parse_mkvmerge_duration_us(json), None);
    }

    #[test]
    fn mkvmerge_duration_returns_none_on_garbage_input() {
        assert_eq!(parse_mkvmerge_duration_us("not json"), None);
        assert_eq!(parse_mkvmerge_duration_us(""), None);
    }

    #[test]
    fn parses_ffprobe_duration_decimal_seconds() {
        // ffprobe with -of default=noprint_wrappers=1:nokey=1 emits a
        // single decimal value.
        assert_eq!(parse_ffprobe_duration_us("1420.000000\n"), Some(1_420_000_000));
        assert_eq!(parse_ffprobe_duration_us("  0.5  "), Some(500_000));
    }

    #[test]
    fn ffprobe_duration_rejects_invalid_values() {
        assert_eq!(parse_ffprobe_duration_us(""), None);
        assert_eq!(parse_ffprobe_duration_us("N/A\n"), None);
        assert_eq!(parse_ffprobe_duration_us("-5\n"), None);
        assert_eq!(parse_ffprobe_duration_us("inf\n"), None);
    }

    #[test]
    fn ffprobe_path_swaps_filename_only_when_sibling_exists() {
        use std::fs;
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("zimesub-ffprobe-{pid}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        let ffmpeg = dir.join("ffmpeg.exe");
        fs::write(&ffmpeg, b"").unwrap();

        // Sibling missing → None.
        assert!(ffprobe_path_from_ffmpeg(&ffmpeg).is_none());

        // Sibling present → returns the path.
        let ffprobe = dir.join("ffprobe.exe");
        fs::write(&ffprobe, b"").unwrap();
        assert_eq!(ffprobe_path_from_ffmpeg(&ffmpeg), Some(ffprobe));

        let _ = fs::remove_dir_all(&dir);
    }
}
