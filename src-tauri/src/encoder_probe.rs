//! H.264 hardware-encoder detection + quality-slider mapping.
//!
//! Per ADR-0004 and PRD § "Render": ZimeSub probes `ffmpeg -hide_banner
//! -encoders` once on app start (and on the Settings "Quét lại" button)
//! and intersects the line set with the priority list
//! `h264_qsv > h264_nvenc > h264_amf > libx264`. The result is cached
//! in `settings.json` as `available_encoders` so subsequent Render Jobs
//! pick an encoder without re-spawning ffmpeg.
//!
//! The quality slider 0..100 lives in `RenderConfig.quality` and maps
//! per engine:
//!  - QSV   → `-global_quality 28..18` (linear, lower = higher quality)
//!  - NVENC → `-cq 28..18` (linear)
//!  - AMF   → `-quality speed|balanced|quality` (step thresholds: 0..32 = speed,
//!            33..66 = balanced, 67..100 = quality)
//!  - libx264 → `-crf 28..18` (linear)
//!
//! Resolution policy:
//!  - `encoder == "auto"` → first available in the priority list.
//!  - specific encoder NOT in `available_encoders` → fall back to the
//!    first available; caller surfaces a one-time toast and keeps the
//!    saved config untouched.
//!
//! Pure module: parser + mapping take strings/numbers and return
//! strings/numbers. No I/O — the runner / commands layer wraps this
//! with `Command::output` and the settings cache.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Known encoders ZimeSub recognises, in priority order
/// (`QSV > NVENC > AMF > libx264`). The render code never picks
/// outside this set — anything ffmpeg reports that doesn't match a
/// variant is dropped by the parser.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Encoder {
    #[serde(rename = "h264_qsv")]
    H264Qsv,
    #[serde(rename = "h264_nvenc")]
    H264Nvenc,
    #[serde(rename = "h264_amf")]
    H264Amf,
    Libx264,
}

impl Encoder {
    /// Canonical ffmpeg encoder name — also the persisted string in
    /// `RenderConfig.encoder` and `available_encoders`.
    pub fn key(self) -> &'static str {
        match self {
            Encoder::H264Qsv => "h264_qsv",
            Encoder::H264Nvenc => "h264_nvenc",
            Encoder::H264Amf => "h264_amf",
            Encoder::Libx264 => "libx264",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "h264_qsv" => Some(Encoder::H264Qsv),
            "h264_nvenc" => Some(Encoder::H264Nvenc),
            "h264_amf" => Some(Encoder::H264Amf),
            "libx264" => Some(Encoder::Libx264),
            _ => None,
        }
    }

    /// Priority chain (QSV > NVENC > AMF > libx264). Used by the
    /// `auto` resolution path and by the parser's output ordering so
    /// callers can just walk the head of the list.
    pub const PRIORITY: [Encoder; 4] = [
        Encoder::H264Qsv,
        Encoder::H264Nvenc,
        Encoder::H264Amf,
        Encoder::Libx264,
    ];

    /// Vietnamese display name used in the dropdown. Frontend mirrors
    /// the same labels in `api/render.ts`; kept here as documentation
    /// of the canonical wording.
    #[allow(dead_code)]
    pub fn display_label(self) -> &'static str {
        match self {
            Encoder::H264Qsv => "Intel QSV (h264_qsv)",
            Encoder::H264Nvenc => "NVIDIA NVENC (h264_nvenc)",
            Encoder::H264Amf => "AMD AMF (h264_amf)",
            Encoder::Libx264 => "CPU (libx264)",
        }
    }
}

/// Walk `ffmpeg -hide_banner -encoders` stdout looking for the known
/// H.264 encoder lines. Returns the intersection with [`Encoder::PRIORITY`],
/// preserving priority order regardless of the position ffmpeg printed
/// them at.
///
/// ffmpeg's encoder list rows look like:
///
/// ```text
///  V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
///  V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
///  V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
///  V..... h264_amf             AMD AMF H.264 Encoder (codec h264)
/// ```
///
/// The parser doesn't care about the flag column or the description —
/// it tokenises each line and looks for one of the four known keys as
/// the second column.
pub fn parse_ffmpeg_encoders(stdout: &str) -> Vec<Encoder> {
    let mut found = std::collections::HashSet::<Encoder>::new();
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        // The header section ends with a `------` separator after which
        // every row starts with a flag column (`V.....` etc.). We don't
        // strictly need to skip the header — `from_key` rejects
        // unrelated tokens — but tokenisation is cheap so let it scan.
        let mut tokens = trimmed.split_whitespace();
        let Some(_flags) = tokens.next() else {
            continue;
        };
        let Some(key) = tokens.next() else {
            continue;
        };
        if let Some(enc) = Encoder::from_key(key) {
            found.insert(enc);
        }
    }
    Encoder::PRIORITY
        .iter()
        .copied()
        .filter(|e| found.contains(e))
        .collect()
}

/// Spawn `ffmpeg -hide_banner -encoders` and parse the result. Used by
/// the `encoder_probe_rescan` Tauri command. Spawn failure /
/// non-zero exit collapses to an empty vec — the caller surfaces a
/// danger toast when this happens.
pub fn probe_via_ffmpeg(ffmpeg_path: &Path) -> Vec<Encoder> {
    let mut cmd = Command::new(ffmpeg_path);
    cmd.arg("-hide_banner")
        .arg("-encoders")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if !output.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_ffmpeg_encoders(&stdout)
}

/// Result of resolving a configured encoder against the current
/// machine's `available_encoders`.
///
/// `chosen` is the encoder the runner actually invokes;
/// `fallback_from` is `Some(original)` when the configured encoder
/// wasn't available and the picker fell back — drives the one-time
/// "Encoder X không khả dụng trên máy này, dùng Y" toast.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedEncoder {
    pub chosen: Encoder,
    pub fallback_from: Option<Encoder>,
}

/// Resolve `configured` (either the literal string `"auto"` or one of
/// the four known keys) against `available`. Returns `None` only when
/// `available` is empty — in that case the caller surfaces a hard
/// error since no Render Job can run.
///
/// Behaviour:
/// - `configured == "auto"` → first entry in `available` (which is
///   already priority-ordered).
/// - `configured` is a known key AND in `available` → that key.
/// - `configured` is a known key but NOT in `available` → fall back
///   to first in `available`, mark `fallback_from`.
/// - `configured` is an unknown key → treated as `"auto"`.
pub fn resolve_encoder(configured: &str, available: &[Encoder]) -> Option<ResolvedEncoder> {
    if available.is_empty() {
        return None;
    }
    let first = available[0];
    if configured == "auto" {
        return Some(ResolvedEncoder {
            chosen: first,
            fallback_from: None,
        });
    }
    let Some(parsed) = Encoder::from_key(configured) else {
        return Some(ResolvedEncoder {
            chosen: first,
            fallback_from: None,
        });
    };
    if available.contains(&parsed) {
        Some(ResolvedEncoder {
            chosen: parsed,
            fallback_from: None,
        })
    } else {
        Some(ResolvedEncoder {
            chosen: first,
            fallback_from: Some(parsed),
        })
    }
}

/// Map slider 0..100 → engine-specific ffmpeg argv tokens that follow
/// the `-c:v <encoder>` argument. Returned `Vec<String>` is empty when
/// the engine takes no quality flag (none of the four do, but the
/// shape is preserved in case a future codec drop changes that).
///
/// Mapping (per AC):
///  - QSV / NVENC / libx264 → numeric flag `28..18` linear (slider 0 = 28,
///    slider 100 = 18). Lower numeric = higher quality.
///  - AMF → discrete step (`speed` / `balanced` / `quality`).
pub fn quality_args(encoder: Encoder, slider: u32) -> Vec<String> {
    let s = slider.min(100);
    match encoder {
        Encoder::H264Qsv => {
            let q = map_linear_quality(s);
            vec!["-global_quality".to_string(), q.to_string()]
        }
        Encoder::H264Nvenc => {
            let q = map_linear_quality(s);
            vec!["-cq".to_string(), q.to_string()]
        }
        Encoder::Libx264 => {
            let q = map_linear_quality(s);
            vec!["-crf".to_string(), q.to_string()]
        }
        Encoder::H264Amf => {
            let preset = amf_preset(s);
            vec!["-quality".to_string(), preset.to_string()]
        }
    }
}

/// Map slider 0..100 → numeric quality flag in the `28..18` range
/// (slider 0 = 28 = worst quality, slider 100 = 18 = highest quality).
/// Linear interpolation, rounded to nearest integer.
fn map_linear_quality(slider: u32) -> u32 {
    // 28 - (slider * 10 / 100), but use floats for accurate rounding.
    let s = slider.min(100) as f32;
    let value = 28.0 - (s * 10.0 / 100.0);
    value.round() as u32
}

/// AMF takes a categorical quality preset rather than a numeric value.
/// Thresholds per AC:
///  - `slider < 33` → `speed`
///  - `33 ≤ slider ≤ 66` → `balanced`
///  - `slider > 66` → `quality`
fn amf_preset(slider: u32) -> &'static str {
    let s = slider.min(100);
    if s < 33 {
        "speed"
    } else if s <= 66 {
        "balanced"
    } else {
        "quality"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_ffmpeg_encoders_output() {
        let sample = r#"Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
 V..... h264_amf             AMD AMF H.264 Encoder (codec h264)
 A..... aac                  AAC (Advanced Audio Coding)
"#;
        let found = parse_ffmpeg_encoders(sample);
        // Priority-ordered: QSV first, then NVENC, AMF, libx264.
        assert_eq!(
            found,
            vec![
                Encoder::H264Qsv,
                Encoder::H264Nvenc,
                Encoder::H264Amf,
                Encoder::Libx264,
            ]
        );
    }

    #[test]
    fn parses_subset_when_only_libx264_present() {
        // CPU-only ffmpeg build (no hardware encoders compiled in) —
        // common on minimal/portable builds.
        let sample = r#"Encoders:
 V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 A..... aac                  AAC (Advanced Audio Coding)
"#;
        let found = parse_ffmpeg_encoders(sample);
        assert_eq!(found, vec![Encoder::Libx264]);
    }

    #[test]
    fn parses_empty_output_gracefully() {
        assert_eq!(parse_ffmpeg_encoders(""), Vec::<Encoder>::new());
        assert_eq!(
            parse_ffmpeg_encoders("totally garbage\nno encoders here"),
            Vec::<Encoder>::new()
        );
    }

    #[test]
    fn resolve_auto_picks_first_available() {
        let available = vec![Encoder::H264Nvenc, Encoder::Libx264];
        let resolved = resolve_encoder("auto", &available).expect("non-empty available");
        assert_eq!(resolved.chosen, Encoder::H264Nvenc);
        assert!(resolved.fallback_from.is_none());
    }

    #[test]
    fn resolve_specific_when_available() {
        let available = vec![Encoder::H264Qsv, Encoder::Libx264];
        let resolved = resolve_encoder("libx264", &available).expect("non-empty available");
        assert_eq!(resolved.chosen, Encoder::Libx264);
        assert!(resolved.fallback_from.is_none());
    }

    #[test]
    fn resolve_falls_back_when_specific_unavailable() {
        // Project saved on QSV machine, opened on AMD-only rig.
        let available = vec![Encoder::H264Amf, Encoder::Libx264];
        let resolved = resolve_encoder("h264_qsv", &available).expect("non-empty available");
        assert_eq!(resolved.chosen, Encoder::H264Amf);
        assert_eq!(resolved.fallback_from, Some(Encoder::H264Qsv));
    }

    #[test]
    fn resolve_unknown_treated_as_auto() {
        let available = vec![Encoder::Libx264];
        let resolved = resolve_encoder("h264_vp9", &available).expect("non-empty available");
        assert_eq!(resolved.chosen, Encoder::Libx264);
        assert!(resolved.fallback_from.is_none());
    }

    #[test]
    fn resolve_returns_none_when_no_encoders_available() {
        let resolved = resolve_encoder("auto", &[]);
        assert!(resolved.is_none());
    }

    #[test]
    fn quality_args_qsv_uses_global_quality() {
        let args = quality_args(Encoder::H264Qsv, 65);
        assert_eq!(args[0], "-global_quality");
        // slider 65 → 28 - 6.5 = 21.5 → rounds to 22.
        let q: u32 = args[1].parse().unwrap();
        assert!((20..=22).contains(&q));
    }

    #[test]
    fn quality_args_nvenc_uses_cq() {
        let args = quality_args(Encoder::H264Nvenc, 50);
        assert_eq!(args[0], "-cq");
        // slider 50 → 23.
        assert_eq!(args[1], "23");
    }

    #[test]
    fn quality_args_libx264_uses_crf() {
        let args = quality_args(Encoder::Libx264, 0);
        assert_eq!(args[0], "-crf");
        // slider 0 → 28.
        assert_eq!(args[1], "28");
    }

    #[test]
    fn quality_args_libx264_max() {
        let args = quality_args(Encoder::Libx264, 100);
        assert_eq!(args, vec!["-crf", "18"]);
    }

    #[test]
    fn quality_args_amf_speed_below_33() {
        assert_eq!(quality_args(Encoder::H264Amf, 0), vec!["-quality", "speed"]);
        assert_eq!(quality_args(Encoder::H264Amf, 32), vec!["-quality", "speed"]);
    }

    #[test]
    fn quality_args_amf_balanced_33_to_66() {
        assert_eq!(
            quality_args(Encoder::H264Amf, 33),
            vec!["-quality", "balanced"]
        );
        assert_eq!(
            quality_args(Encoder::H264Amf, 50),
            vec!["-quality", "balanced"]
        );
        assert_eq!(
            quality_args(Encoder::H264Amf, 66),
            vec!["-quality", "balanced"]
        );
    }

    #[test]
    fn quality_args_amf_quality_above_66() {
        assert_eq!(
            quality_args(Encoder::H264Amf, 67),
            vec!["-quality", "quality"]
        );
        assert_eq!(
            quality_args(Encoder::H264Amf, 100),
            vec!["-quality", "quality"]
        );
    }

    #[test]
    fn quality_args_clamps_slider_above_100() {
        // Defensive: a malformed input shouldn't extrapolate the formula.
        let args = quality_args(Encoder::Libx264, 250);
        assert_eq!(args[1], "18");
    }

    #[test]
    fn encoder_key_and_from_key_round_trip() {
        for e in Encoder::PRIORITY.iter().copied() {
            assert_eq!(Encoder::from_key(e.key()), Some(e));
        }
        assert!(Encoder::from_key("h264_vp9").is_none());
    }
}
