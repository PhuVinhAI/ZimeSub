//! Pure parsers for subprocess progress lines.
//!
//! Each parser is stateless: the job worker pipes one stderr (or stdout)
//! line through the matching parser and either gets a typed
//! [`ProgressUpdate`] back (which becomes a `job-progress` event) or
//! `None` (line is dropped from the progress stream but still
//! accumulated for the failure-modal stderr buffer).
//!
//! Slice 0007 added [`parse_mkvextract`] for the mkvextract `Progress: N%`
//! line shape. Slice 0009 adds [`parse_ffmpeg_time_us`] and
//! [`parse_ffmpeg_duration`]: ffmpeg streams its progress via
//! `frame= … time=HH:MM:SS.cs …` lines on stderr, and the audio-extract
//! runner combines the parsed elapsed `time=` with a known total
//! duration (queried up-front via `mkvmerge -J` or `ffprobe`) to
//! produce the same `[0, 1]`-ratio surface as mkvextract.
//!
//! Pure module: no I/O, no allocations beyond the small `String` inside
//! the returned struct. Fixture-driven unit tests live at the bottom.

use serde::Serialize;

/// Typed update emitted from a parsed progress line.
///
/// `ratio` is a `[0.0, 1.0]`-clamped fraction so the frontend can render
/// the determinate progress bar without further math. `hint` is the
/// short human-readable label the row pairs next to the bar (`"35%"`,
/// later `"00:04:17 / 00:23:40"` for ffmpeg `time=` lines).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProgressUpdate {
    pub ratio: f32,
    pub hint: String,
}

/// Parse one stderr line from `mkvextract`.
///
/// mkvextract reports extraction progress as a fresh `Progress: N%`
/// line per percent (no carriage returns / TUI redraws), so the parser
/// is a simple prefix + suffix strip. Whitespace around the line is
/// tolerated because some Windows shells inject trailing `\r` on
/// stderr; that ends up trimmed by [`str::trim`] before we look at
/// the content.
///
/// Returns `None` for any line that doesn't match the `Progress: N%`
/// shape (banner lines, warnings, etc.) and for percentages outside
/// `0..=100` (defensive — keeps the progress bar from rendering
/// nonsense if mkvextract ever changes its format).
pub fn parse_mkvextract(line: &str) -> Option<ProgressUpdate> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("Progress:")?.trim_start();
    let percent_str = rest.strip_suffix('%')?.trim();
    let percent: u32 = percent_str.parse().ok()?;
    if percent > 100 {
        return None;
    }
    Some(ProgressUpdate {
        ratio: (percent as f32) / 100.0,
        hint: format!("{percent}%"),
    })
}

/// Parse the elapsed `time=HH:MM:SS.cs` token out of one ffmpeg stderr
/// line and return microseconds.
///
/// ffmpeg's progress reporter emits a continuously-overwritten status
/// row on stderr that looks like:
///
/// ```text
/// size=     128kB time=00:01:23.45 bitrate= 12.4kbits/s speed=15.6x
/// ```
///
/// The shape varies slightly between codecs (audio-only encodes don't
/// emit `frame=` / `fps=`) so the parser walks the line token-by-token,
/// keys off the `time=` prefix, and decodes the remainder as
/// `HH:MM:SS[.cs]`. Returns `None` for non-matching lines, lines whose
/// `time=` value is `N/A` (ffmpeg emits this very early before the
/// first packet has been processed), or any malformed timestamp.
///
/// Returning microseconds keeps the math integer-precise even for
/// long videos — a 24h source is still inside `u64::MAX / 10`.
pub fn parse_ffmpeg_time_us(line: &str) -> Option<u64> {
    for token in line.split_whitespace() {
        let Some(value) = token.strip_prefix("time=") else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() || value.eq_ignore_ascii_case("n/a") {
            return None;
        }
        return parse_hms_to_micros(value);
    }
    None
}

/// Same `HH:MM:SS[.cs]` shape but for the `Duration: HH:MM:SS.cs, …`
/// line ffmpeg prints during its container-probe banner. The
/// audio-extract runner uses this as a *fallback* duration source when
/// neither `mkvmerge -J` nor `ffprobe` is available — kept here so the
/// pure parser layer owns every ffmpeg-shape parser in one place.
///
/// Returns microseconds, or `None` when the line doesn't contain a
/// `Duration:` prefix or the timestamp is malformed.
pub fn parse_ffmpeg_duration(line: &str) -> Option<u64> {
    let idx = line.find("Duration:")?;
    let after = &line[idx + "Duration:".len()..];
    let value = after.split(',').next().unwrap_or("").trim();
    if value.is_empty() || value.eq_ignore_ascii_case("n/a") {
        return None;
    }
    parse_hms_to_micros(value)
}

/// Compose `elapsed_us` against `total_us` into a [`ProgressUpdate`]
/// with the AC's hint shape `"HH:MM:SS / HH:MM:SS"`. Used by the
/// audio-extract runner once it has both numbers in hand; kept in this
/// module so the formatting policy stays alongside the parser.
///
/// `total_us == 0` (degenerate) and `elapsed_us > total_us` (ffmpeg
/// ran past the duration estimate on the very last packet, common
/// with VBR audio) are clamped to `1.0`. `None` is never returned
/// here — the runner decides whether to emit the update at all based
/// on whether it has a known total.
pub fn ffmpeg_progress(elapsed_us: u64, total_us: u64) -> ProgressUpdate {
    let ratio = if total_us == 0 {
        0.0
    } else {
        (elapsed_us as f32 / total_us as f32).clamp(0.0, 1.0)
    };
    ProgressUpdate {
        ratio,
        hint: format!(
            "{} / {}",
            format_hms(elapsed_us),
            format_hms(total_us)
        ),
    }
}

/// `HH:MM:SS[.cs]` → microseconds. Tolerates a missing centisecond
/// fraction (ffmpeg sometimes prints `HH:MM:SS` when the decoder
/// doesn't have sub-second precision). Returns `None` for any
/// malformed component (>59 minutes/seconds, non-numeric, missing
/// colons). Pure helper; not exposed.
fn parse_hms_to_micros(value: &str) -> Option<u64> {
    let mut parts = value.split(':');
    let hh = parts.next()?.parse::<u64>().ok()?;
    let mm = parts.next()?.parse::<u64>().ok()?;
    let ss_part = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if mm >= 60 {
        return None;
    }
    let (ss, frac_us) = match ss_part.split_once('.') {
        Some((ss_str, frac)) => {
            let ss = ss_str.parse::<u64>().ok()?;
            // Pad / truncate to 6 digits so we always end up with µs.
            let mut padded = frac.to_string();
            if padded.len() > 6 {
                padded.truncate(6);
            } else {
                while padded.len() < 6 {
                    padded.push('0');
                }
            }
            let frac_us = padded.parse::<u64>().ok()?;
            (ss, frac_us)
        }
        None => (ss_part.parse::<u64>().ok()?, 0),
    };
    if ss >= 60 {
        return None;
    }
    Some(((hh * 3600 + mm * 60 + ss) * 1_000_000) + frac_us)
}

/// Microseconds → `HH:MM:SS`. Used for the progress hint shape; we
/// drop the sub-second fraction so the row label stays compact.
fn format_hms(us: u64) -> String {
    let total_secs = us / 1_000_000;
    let hh = total_secs / 3600;
    let mm = (total_secs % 3600) / 60;
    let ss = total_secs % 60;
    format!("{hh:02}:{mm:02}:{ss:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zero_percent() {
        let p = parse_mkvextract("Progress: 0%").expect("parse");
        assert_eq!(p.ratio, 0.0);
        assert_eq!(p.hint, "0%");
    }

    #[test]
    fn parses_mid_percent() {
        let p = parse_mkvextract("Progress: 35%").expect("parse");
        assert!((p.ratio - 0.35).abs() < f32::EPSILON);
        assert_eq!(p.hint, "35%");
    }

    #[test]
    fn parses_full_percent() {
        let p = parse_mkvextract("Progress: 100%").expect("parse");
        assert_eq!(p.ratio, 1.0);
        assert_eq!(p.hint, "100%");
    }

    #[test]
    fn tolerates_surrounding_whitespace_and_trailing_carriage_return() {
        let p = parse_mkvextract("  Progress: 42%  \r").expect("parse");
        assert!((p.ratio - 0.42).abs() < f32::EPSILON);
    }

    #[test]
    fn ignores_non_progress_lines() {
        // mkvextract emits a banner and per-track "Extracting track …"
        // lines that the parser must drop on the floor.
        assert!(parse_mkvextract("mkvextract v84.0").is_none());
        assert!(parse_mkvextract("Extracting track 2 with the CodecID 'S_TEXT/ASS'").is_none());
        assert!(parse_mkvextract("").is_none());
        assert!(parse_mkvextract("Progress").is_none());
        assert!(parse_mkvextract("Progress:").is_none());
        assert!(parse_mkvextract("Progress: 35").is_none()); // missing %
    }

    #[test]
    fn rejects_out_of_range_percent() {
        // Defensive: future-proofs the bar against a mkvextract change
        // that ever emits >100% (we'd rather skip the line than render
        // a bar past 1.0).
        assert!(parse_mkvextract("Progress: 101%").is_none());
        assert!(parse_mkvextract("Progress: 200%").is_none());
    }

    #[test]
    fn rejects_non_numeric_percent() {
        assert!(parse_mkvextract("Progress: abc%").is_none());
        assert!(parse_mkvextract("Progress: -5%").is_none());
        assert!(parse_mkvextract("Progress: 12.5%").is_none());
    }

    #[test]
    fn parses_ffmpeg_time_in_audio_only_status_row() {
        // Real ffmpeg audio-only line — no `frame=` / `fps=` because
        // we ran with `-vn`.
        let line = "size=    1024kB time=00:01:23.45 bitrate= 100.4kbits/s speed=15.6x";
        let us = parse_ffmpeg_time_us(line).expect("parse");
        // 1m23.45s = 83.45s = 83_450_000 µs
        assert_eq!(us, 83_450_000);
    }

    #[test]
    fn parses_ffmpeg_time_with_centiseconds_only() {
        let line = "time=00:00:00.10";
        let us = parse_ffmpeg_time_us(line).expect("parse");
        assert_eq!(us, 100_000);
    }

    #[test]
    fn parses_ffmpeg_time_without_fraction() {
        // Some encoders drop the fractional segment entirely.
        let line = "size= 1kB time=00:02:30 bitrate=…";
        let us = parse_ffmpeg_time_us(line).expect("parse");
        assert_eq!(us, 150_000_000);
    }

    #[test]
    fn ffmpeg_time_rejects_na_marker() {
        // ffmpeg emits `time=N/A` on the very first status row before
        // any packet has been demuxed.
        let line = "size=N/A time=N/A bitrate=N/A speed=N/A";
        assert!(parse_ffmpeg_time_us(line).is_none());
    }

    #[test]
    fn ffmpeg_time_returns_none_when_token_absent() {
        // Banner / info lines never contain `time=`.
        assert!(parse_ffmpeg_time_us("ffmpeg version 6.1 …").is_none());
        assert!(parse_ffmpeg_time_us("").is_none());
    }

    #[test]
    fn ffmpeg_time_rejects_malformed_components() {
        // Missing colons, non-numeric, out-of-range mm/ss.
        assert!(parse_ffmpeg_time_us("time=abc").is_none());
        assert!(parse_ffmpeg_time_us("time=00:60:00").is_none());
        assert!(parse_ffmpeg_time_us("time=00:00:60").is_none());
        assert!(parse_ffmpeg_time_us("time=00:00:00:00").is_none());
    }

    #[test]
    fn parses_ffmpeg_duration_banner_line() {
        let line = "  Duration: 00:23:40.00, start: 0.000000, bitrate: 1234 kb/s";
        let us = parse_ffmpeg_duration(line).expect("parse");
        // 23m40s = 1420s
        assert_eq!(us, 1_420_000_000);
    }

    #[test]
    fn ffmpeg_duration_rejects_na_line() {
        let line = "Duration: N/A, start: 0.000000, bitrate: N/A";
        assert!(parse_ffmpeg_duration(line).is_none());
    }

    #[test]
    fn ffmpeg_duration_returns_none_when_marker_absent() {
        assert!(parse_ffmpeg_duration("Input #0, matroska …").is_none());
    }

    #[test]
    fn ffmpeg_progress_builds_hint_and_ratio() {
        // 1m mark on a 2m source → 0.5 ratio.
        let update = ffmpeg_progress(60_000_000, 120_000_000);
        assert!((update.ratio - 0.5).abs() < f32::EPSILON);
        assert_eq!(update.hint, "00:01:00 / 00:02:00");
    }

    #[test]
    fn ffmpeg_progress_clamps_overshoot_to_one() {
        // ffmpeg often emits a final `time=` slightly past the
        // demuxer-reported duration. We never paint the bar past 100%.
        let update = ffmpeg_progress(125_000_000, 120_000_000);
        assert!((update.ratio - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn ffmpeg_progress_zero_total_does_not_panic() {
        // Defensive: if the duration probe somehow returned 0 we still
        // emit a valid update with ratio = 0 instead of NaN/Inf.
        let update = ffmpeg_progress(5_000_000, 0);
        assert_eq!(update.ratio, 0.0);
        assert_eq!(update.hint, "00:00:05 / 00:00:00");
    }
}
