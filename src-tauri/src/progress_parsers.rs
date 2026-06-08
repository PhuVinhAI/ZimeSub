//! Pure parsers for subprocess progress lines.
//!
//! Each parser is stateless: the job worker pipes one stderr (or stdout)
//! line through the matching parser and either gets a typed
//! [`ProgressUpdate`] back (which becomes a `job-progress` event) or
//! `None` (line is dropped from the progress stream but still
//! accumulated for the failure-modal stderr buffer).
//!
//! Slice 0007 only needs [`parse_mkvextract`]; [`parse_ffmpeg`] arrives
//! with the audio-extract / render slices alongside the tiered scheduler
//! in 0008. Keeping the modules in one file from the start means the
//! second parser drops in next to the first without touching call sites.
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
}
