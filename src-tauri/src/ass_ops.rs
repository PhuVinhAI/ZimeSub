//! ASS subtitle ops — pure text transformations.
//!
//! Slice 0007 ships [`srt_to_ass`] only. It is invoked after `mkvextract`
//! has written a freshly-demuxed SRT track to disk so the on-disk
//! artefact can be promoted to a valid ASS file matching the rest of
//! the pipeline's naming convention (`<basename>.eng.ass`). The
//! converter keeps the dialogue text verbatim and prepends a default
//! `[V4+ Styles]` section so popular players (mpv, VLC, Aegisub) load
//! the file without complaint.
//!
//! `make_draft` (copy-to-`.ass.txt`), `replace_styles_section`
//! (StylePatch), and `write_translated` arrive with the translate-stage
//! slices.
//!
//! Pure module: no I/O. Fixture-driven unit tests cover the SRT shapes
//! the converter has to handle (with/without block index, comma or dot
//! decimal separator, CRLF input, multi-line dialogue, malformed blocks).

/// Default `[Script Info]` + `[V4+ Styles]` + `[Events]` preamble.
///
/// The single `Default` style is white-on-transparent with a 2 px
/// outline and a 2 px shadow — the closest neutral approximation to
/// what most fansubs render before any custom styling is applied.
/// Bumped users will override this via the StylePatch flow in a later
/// slice; until then this gives the freshly-converted file enough
/// metadata to render at all.
const ASS_HEADER: &str = "\
[Script Info]
Title: ZimeSub Auto-Converted
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
";

/// Convert an SRT subtitle blob to a minimal valid ASS subtitle.
///
/// The output is always [`ASS_HEADER`] followed by zero or more
/// `Dialogue:` lines — one per parseable SRT block. Malformed blocks
/// (missing timing line, unparseable timestamps) are silently skipped
/// so a partial source still produces a loadable file rather than an
/// error string the caller would have to surface separately.
///
/// Pure function — the caller owns the on-disk write.
pub fn srt_to_ass(srt: &str) -> String {
    let mut out = String::with_capacity(srt.len() + ASS_HEADER.len());
    out.push_str(ASS_HEADER);
    for block in iter_srt_blocks(srt) {
        if let Some(line) = block_to_dialogue_line(&block) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out
}

/// Split `srt` into per-block line groups. Blocks are separated by one
/// or more blank lines; CRLF and LF line endings are both tolerated.
fn iter_srt_blocks(srt: &str) -> Vec<Vec<String>> {
    let mut blocks: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for line in srt.lines() {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(trimmed.to_string());
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
}

/// Map one SRT block into the corresponding ASS `Dialogue:` line.
///
/// Accepts both block shapes:
///   * Standard SRT — first line is the numeric block index, second
///     line is the timing, remaining lines are dialogue text.
///   * Index-less SRT — first line is the timing (some tools omit the
///     index when exporting; the spec is loose enough that both forms
///     show up in the wild).
///
/// Returns `None` when the block lacks dialogue text, has unparseable
/// timing, or is otherwise malformed.
fn block_to_dialogue_line(block: &[String]) -> Option<String> {
    let first = block.first()?.trim();
    let timing_idx = if first.parse::<u32>().is_ok() { 1 } else { 0 };
    let timing = block.get(timing_idx)?.as_str();
    let (start_raw, end_raw) = parse_timing(timing)?;
    let start = srt_ts_to_ass_ts(start_raw)?;
    let end = srt_ts_to_ass_ts(end_raw)?;

    let text_lines: Vec<String> = block[(timing_idx + 1)..]
        .iter()
        .map(|l| scrub_dialogue_text(l))
        .collect();
    if text_lines.is_empty() {
        return None;
    }
    let joined = text_lines.join("\\N");

    Some(format!(
        "Dialogue: 0,{start},{end},Default,,0,0,0,,{joined}"
    ))
}

/// Split an SRT timing line (`HH:MM:SS,mmm --> HH:MM:SS,mmm`) into the
/// two timestamp halves. Returns `None` when the arrow separator is
/// missing or one side is empty.
fn parse_timing(line: &str) -> Option<(&str, &str)> {
    let mut parts = line.split(" --> ");
    let s = parts.next()?.trim();
    let e = parts.next()?.trim();
    if s.is_empty() || e.is_empty() {
        return None;
    }
    Some((s, e))
}

/// Convert one SRT timestamp (`HH:MM:SS,mmm` — comma or dot separator
/// tolerated) into the ASS form (`H:MM:SS.cc` — centiseconds, single-
/// digit hours).
///
/// Returns `None` when the component counts or ranges are off. We
/// truncate milliseconds → centiseconds rather than rounding because
/// rounding can push a timestamp past the next subtitle's start and
/// produce mid-line flicker; truncation always stays "≤ original" so
/// adjacent cues never collide.
fn srt_ts_to_ass_ts(srt_ts: &str) -> Option<String> {
    let normalised = srt_ts.replace(',', ".");
    let mut parts = normalised.split(':');
    let hh: u32 = parts.next()?.parse().ok()?;
    let mm: u32 = parts.next()?.parse().ok()?;
    let sec_full = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if mm >= 60 {
        return None;
    }
    let mut sec_parts = sec_full.split('.');
    let ss: u32 = sec_parts.next()?.parse().ok()?;
    if ss >= 60 {
        return None;
    }
    let ms_raw = sec_parts.next().unwrap_or("0");
    if sec_parts.next().is_some() {
        return None;
    }
    let ms: u32 = ms_raw.parse().ok()?;
    let cs = (ms / 10).min(99);
    Some(format!("{hh}:{mm:02}:{ss:02}.{cs:02}"))
}

/// Strip carriage returns / stray newlines from a dialogue text line.
///
/// ASS dialogue lines are comma-separated by field, but the final
/// `Text` field accepts commas verbatim — so we don't need to escape
/// commas, only the line-terminating characters that would split the
/// dialogue across multiple Events records.
fn scrub_dialogue_text(line: &str) -> String {
    line.replace(['\r', '\n'], "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_yields_header_only() {
        let out = srt_to_ass("");
        assert!(out.starts_with("[Script Info]"));
        assert!(out.contains("[V4+ Styles]"));
        assert!(out.contains("[Events]"));
        // No Dialogue: lines.
        assert!(!out.contains("Dialogue:"));
    }

    #[test]
    fn single_block_with_index_round_trips_timing_and_text() {
        let srt = "1\n00:01:23,456 --> 00:01:25,789\nHello world\n";
        let out = srt_to_ass(srt);
        // 456ms → 45 centiseconds (truncate), 789ms → 78 centiseconds.
        assert!(
            out.contains("Dialogue: 0,0:01:23.45,0:01:25.78,Default,,0,0,0,,Hello world"),
            "unexpected dialogue line in:\n{out}"
        );
    }

    #[test]
    fn multi_line_text_joins_with_ass_newline() {
        let srt = "1\n00:00:01,000 --> 00:00:03,000\nFirst line\nSecond line\nThird line\n";
        let out = srt_to_ass(srt);
        assert!(out.contains("Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,First line\\NSecond line\\NThird line"));
    }

    #[test]
    fn handles_indexless_block_shape() {
        // Some SRT exports omit the leading block index.
        let srt = "00:00:05,000 --> 00:00:07,000\nNo index line\n";
        let out = srt_to_ass(srt);
        assert!(out.contains("Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,No index line"));
    }

    #[test]
    fn handles_crlf_line_endings() {
        let srt = "1\r\n00:00:00,000 --> 00:00:01,000\r\nCRLF test\r\n\r\n";
        let out = srt_to_ass(srt);
        assert!(out.contains("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,CRLF test"));
        // CRLF was scrubbed from the dialogue text.
        assert!(!out.contains("CRLF test\r"));
    }

    #[test]
    fn tolerates_dot_decimal_in_addition_to_comma() {
        // Some non-Windows tools emit SRT with `.` instead of `,` between
        // the seconds and milliseconds — accept both rather than failing.
        let srt = "1\n00:00:01.000 --> 00:00:02.500\nDot separator\n";
        let out = srt_to_ass(srt);
        assert!(out.contains("Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Dot separator"));
    }

    #[test]
    fn multi_block_input_produces_one_dialogue_per_block() {
        let srt = "\
1
00:00:01,000 --> 00:00:02,000
First

2
00:00:03,000 --> 00:00:04,000
Second

3
00:00:05,000 --> 00:00:06,000
Third
";
        let out = srt_to_ass(srt);
        let dialogue_count = out.matches("Dialogue:").count();
        assert_eq!(dialogue_count, 3);
        assert!(out.contains(",,First"));
        assert!(out.contains(",,Second"));
        assert!(out.contains(",,Third"));
    }

    #[test]
    fn skips_blocks_with_unparseable_timing() {
        // A garbled middle block must not abort the whole conversion;
        // the surrounding valid blocks still survive.
        let srt = "\
1
00:00:01,000 --> 00:00:02,000
Good A

2
not-a-timing-line
Garbled

3
00:00:05,000 --> 00:00:06,000
Good B
";
        let out = srt_to_ass(srt);
        assert!(out.contains(",,Good A"));
        assert!(out.contains(",,Good B"));
        assert!(!out.contains("Garbled"));
    }

    #[test]
    fn rejects_invalid_timestamp_components() {
        assert!(srt_ts_to_ass_ts("12:60:00,000").is_none()); // minutes ≥ 60
        assert!(srt_ts_to_ass_ts("12:00:60,000").is_none()); // seconds ≥ 60
        assert!(srt_ts_to_ass_ts("not a timestamp").is_none());
        assert!(srt_ts_to_ass_ts("12:00:00,abc").is_none());
        assert!(srt_ts_to_ass_ts("12:00:00,000,extra").is_none());
    }

    #[test]
    fn truncates_milliseconds_to_centiseconds() {
        // 999ms must become 99cs (not 100cs), to keep the timestamp from
        // overflowing into the next second.
        assert_eq!(srt_ts_to_ass_ts("00:00:00,999").as_deref(), Some("0:00:00.99"));
        assert_eq!(srt_ts_to_ass_ts("00:00:00,990").as_deref(), Some("0:00:00.99"));
        assert_eq!(srt_ts_to_ass_ts("00:00:00,001").as_deref(), Some("0:00:00.00"));
    }

    #[test]
    fn dialogue_text_with_internal_commas_passes_through_unchanged() {
        // The Text field is the last comma-separated cell — internal
        // commas are part of the text and must NOT be escaped.
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nHello, world, again\n";
        let out = srt_to_ass(srt);
        assert!(out.contains(",,Hello, world, again"));
    }
}
