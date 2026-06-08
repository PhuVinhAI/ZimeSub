//! ASS subtitle ops — pure text transformations + thin disk helpers.
//!
//! Slice 0007 shipped [`srt_to_ass`]. It is invoked after `mkvextract`
//! has written a freshly-demuxed SRT track to disk so the on-disk
//! artefact can be promoted to a valid ASS file matching the rest of
//! the pipeline's naming convention (`<basename>.eng.ass`). The
//! converter keeps the dialogue text verbatim and prepends a default
//! `[V4+ Styles]` section so popular players (mpv, VLC, Aegisub) load
//! the file without complaint.
//!
//! Slice 0010 adds the translate-stage helpers:
//!  * [`make_draft`] — copy `<basename>.eng.ass` → `<basename>.eng.ass.txt`
//!    so the user can paste the content into ChatGPT/Gemini (which
//!    refuse the `.ass` extension on the upload UI). Pure file copy
//!    with overwrite control.
//!  * [`write_translated`] — atomic write of the full translated ASS
//!    blob the user pasted into the modal. Writes to a `.tmp` sibling
//!    then renames so a mid-write crash never leaves a half-flushed
//!    `<basename>.vietsub.ass`.
//!  * [`replace_styles_section`] — pure text transform: parse the
//!    target ASS by `[Section]` headers, swap the `[V4+ Styles]` block
//!    for the pasted content, leave every other section untouched.
//!    Drives the StylePatch button.
//!  * [`validate_styles_block`] — pure validator the UI checks before
//!    saving: input must contain a `[V4+ Styles]` header (exact, case-
//!    sensitive) and the next non-blank line must start with `Format:`.
//!
//! The two text transforms ([`srt_to_ass`] + [`replace_styles_section`])
//! are pure and fixture-tested; the two disk helpers ([`make_draft`] +
//! [`write_translated`]) are thin enough to test directly with a tempdir.

use std::path::{Path, PathBuf};

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

/// Errors from the translate-stage disk helpers + style-block validator.
#[derive(Debug)]
pub enum AssOpsError {
    /// `source` doesn't exist or isn't a regular file.
    SourceMissing,
    /// `target` already exists and the caller opted out of overwrite.
    TargetExists,
    /// The pasted `[V4+ Styles]` block is missing the section header.
    MissingStylesHeader,
    /// The `[V4+ Styles]` header is present but the next non-blank
    /// line doesn't start with `Format:`.
    MissingFormatLine,
    /// The target ASS file the StylePatch tries to update doesn't
    /// contain a `[V4+ Styles]` section.
    TargetMissingStylesSection,
    /// Underlying I/O error (read/write/copy/rename).
    Io(std::io::Error),
}

impl std::fmt::Display for AssOpsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceMissing => write!(f, "Không tìm thấy file nguồn"),
            Self::TargetExists => write!(f, "File đích đã tồn tại"),
            Self::MissingStylesHeader => write!(
                f,
                "Khối dán phải bắt đầu bằng dòng [V4+ Styles]"
            ),
            Self::MissingFormatLine => write!(
                f,
                "Sau [V4+ Styles] phải có dòng Format: ..."
            ),
            Self::TargetMissingStylesSection => write!(
                f,
                "File phụ đề đích không có section [V4+ Styles] để thay thế"
            ),
            Self::Io(e) => write!(f, "Lỗi I/O: {e}"),
        }
    }
}

impl std::error::Error for AssOpsError {}

impl From<std::io::Error> for AssOpsError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

/// Copy `source` (the extracted `<basename>.eng.ass`) to `target` (the
/// translation draft `<basename>.eng.ass.txt`).
///
/// `overwrite = false` and an existing `target` returns
/// [`AssOpsError::TargetExists`] so the frontend can surface the
/// confirm modal before retrying with `overwrite = true`.
///
/// Both paths must be absolute — the caller (Tauri command) resolves
/// them off the EpisodeFolder so the rest of this module stays
/// platform-agnostic.
pub fn make_draft(source: &Path, target: &Path, overwrite: bool) -> Result<(), AssOpsError> {
    if !source.is_file() {
        return Err(AssOpsError::SourceMissing);
    }
    if target.exists() && !overwrite {
        return Err(AssOpsError::TargetExists);
    }
    std::fs::copy(source, target)?;
    Ok(())
}

/// Atomically write `content` (the user's pasted full ASS blob) to
/// `target`. The write goes to a `<target>.tmp` sibling first then
/// renames — so a mid-write crash never leaves a partially-flushed
/// `<basename>.vietsub.ass` that a subsequent project-open would
/// misread as a real artefact.
///
/// `overwrite = false` and an existing `target` returns
/// [`AssOpsError::TargetExists`]. The tmp file is cleaned up on any
/// downstream rename failure so we never leak `*.tmp` siblings into
/// the EpisodeFolder.
pub fn write_translated(
    target: &Path,
    content: &str,
    overwrite: bool,
) -> Result<(), AssOpsError> {
    if target.exists() && !overwrite {
        return Err(AssOpsError::TargetExists);
    }
    let tmp = tmp_sibling(target);
    std::fs::write(&tmp, content)?;
    if let Err(e) = std::fs::rename(&tmp, target) {
        // Best-effort tmp cleanup so a failed rename doesn't leak it.
        let _ = std::fs::remove_file(&tmp);
        return Err(AssOpsError::Io(e));
    }
    Ok(())
}

/// Replace exactly the `[V4+ Styles]` section in the ASS blob at
/// `target` with the pasted `styles_block`. All other sections
/// (`[Script Info]`, `[Events]`, custom sections) are left untouched.
///
/// The pasted block must already be validated via
/// [`validate_styles_block`] (the UI calls it before save). Returns
/// [`AssOpsError::TargetMissingStylesSection`] when the target itself
/// has no `[V4+ Styles]` section to swap.
///
/// Written atomically via [`write_translated`] so a mid-write crash
/// leaves the previous TranslatedSub intact.
pub fn replace_styles_section(target: &Path, styles_block: &str) -> Result<(), AssOpsError> {
    let original = std::fs::read_to_string(target)?;
    let patched = patch_styles_in_place(&original, styles_block)?;
    write_translated(target, &patched, true)
}

/// Pure half of [`replace_styles_section`]: take the original ASS text
/// + the pasted `[V4+ Styles]` block and return the merged document.
///
/// Section boundaries are detected by lines whose first non-whitespace
/// character is `[` and whose trimmed form ends with `]` — the ASS
/// spec leaves whitespace around section headers untouched and
/// real-world files vary, so the detection is lenient about trailing
/// whitespace but strict about the bracket framing.
///
/// `styles_block` is normalised to end with exactly one trailing
/// newline so the next section's header doesn't get concatenated onto
/// the last style line.
pub fn patch_styles_in_place(
    original: &str,
    styles_block: &str,
) -> Result<String, AssOpsError> {
    let (start, end) = find_styles_section_bounds(original)
        .ok_or(AssOpsError::TargetMissingStylesSection)?;

    let prefix = &original[..start];
    let suffix = &original[end..];
    let normalised_block = normalise_styles_block(styles_block);

    let mut out = String::with_capacity(prefix.len() + normalised_block.len() + suffix.len());
    out.push_str(prefix);
    out.push_str(&normalised_block);
    out.push_str(suffix);
    Ok(out)
}

/// Return the `[start, end)` byte range of the `[V4+ Styles]` section
/// in `text` — from the start of the section header line to the start
/// of the next section header line (or EOF if the styles section is
/// the last one in the file).
fn find_styles_section_bounds(text: &str) -> Option<(usize, usize)> {
    let mut start: Option<usize> = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']).trim();
        let is_section_header = trimmed.starts_with('[') && trimmed.ends_with(']');
        if start.is_none() {
            if is_section_header && trimmed == "[V4+ Styles]" {
                start = Some(offset);
            }
        } else if is_section_header {
            return Some((start.unwrap(), offset));
        }
        offset += line.len();
    }
    start.map(|s| (s, text.len()))
}

/// Ensure the pasted styles block starts at column 0, has its CRLF
/// line endings normalised to LF, and ends with exactly one trailing
/// newline so the next section's header stays on its own line after
/// the swap.
fn normalise_styles_block(block: &str) -> String {
    let mut s: String = block.replace("\r\n", "\n").replace('\r', "\n");
    while s.ends_with("\n\n") {
        s.pop();
    }
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// Validate the pasted `[V4+ Styles]` block before save. The slice
/// 0010 AC says the input must contain a line that, after trimming,
/// equals `[V4+ Styles]` exactly (case-sensitive); and the next
/// non-blank line must start with `Format:`.
///
/// Returns the offending error variant when either check fails so the
/// modal can render a Vietnamese hint inline. Whitespace-only inputs
/// fall into [`AssOpsError::MissingStylesHeader`] — keeps the error
/// surface narrow and the message specific.
pub fn validate_styles_block(block: &str) -> Result<(), AssOpsError> {
    let mut lines = block.split('\n').map(|l| l.trim_end_matches('\r'));
    // Walk to the section header.
    let mut saw_header = false;
    for line in lines.by_ref() {
        if line.trim() == "[V4+ Styles]" {
            saw_header = true;
            break;
        }
    }
    if !saw_header {
        return Err(AssOpsError::MissingStylesHeader);
    }
    // Look at the next non-blank line.
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        if line.trim_start().starts_with("Format:") {
            return Ok(());
        }
        return Err(AssOpsError::MissingFormatLine);
    }
    Err(AssOpsError::MissingFormatLine)
}

/// Build the `<target>.tmp` sibling path used by [`write_translated`]'s
/// atomic-write dance. Lives next to the target so the rename never
/// crosses a mount boundary (and therefore stays atomic on Windows
/// NTFS / Unix tmpfs alike).
fn tmp_sibling(target: &Path) -> PathBuf {
    let mut s = target.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
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

    /* ---------------------------------------------------------------- */
    /* Slice 0010 — translate-stage helpers                              */
    /* ---------------------------------------------------------------- */

    use std::env;
    use std::fs;
    use std::path::PathBuf as TestPathBuf;

    fn ass_tmp_dir(name: &str) -> TestPathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let path = env::temp_dir().join(format!("zimesub-test-ass-{name}-{pid}-{nanos}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn make_draft_copies_source_to_target() {
        let dir = ass_tmp_dir("draft-copy");
        let source = dir.join("show.eng.ass");
        let target = dir.join("show.eng.ass.txt");
        fs::write(&source, "[Script Info]\nTitle: x\n").expect("seed source");
        make_draft(&source, &target, false).expect("copy");
        let copied = fs::read_to_string(&target).expect("read");
        assert!(copied.contains("Title: x"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn make_draft_refuses_overwrite_when_disabled() {
        let dir = ass_tmp_dir("draft-no-overwrite");
        let source = dir.join("show.eng.ass");
        let target = dir.join("show.eng.ass.txt");
        fs::write(&source, "src").expect("seed source");
        fs::write(&target, "existing").expect("seed target");
        let err = make_draft(&source, &target, false).expect_err("must refuse");
        assert!(matches!(err, AssOpsError::TargetExists));
        // The existing target was NOT overwritten.
        assert_eq!(fs::read_to_string(&target).unwrap(), "existing");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn make_draft_overwrites_when_enabled() {
        let dir = ass_tmp_dir("draft-overwrite");
        let source = dir.join("show.eng.ass");
        let target = dir.join("show.eng.ass.txt");
        fs::write(&source, "fresh").expect("seed");
        fs::write(&target, "stale").expect("seed");
        make_draft(&source, &target, true).expect("overwrite");
        assert_eq!(fs::read_to_string(&target).unwrap(), "fresh");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn make_draft_errors_on_missing_source() {
        let dir = ass_tmp_dir("draft-no-src");
        let source = dir.join("missing.ass");
        let target = dir.join("out.txt");
        let err = make_draft(&source, &target, false).expect_err("missing");
        assert!(matches!(err, AssOpsError::SourceMissing));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_translated_creates_file_and_no_tmp_left_behind() {
        let dir = ass_tmp_dir("write-translated");
        let target = dir.join("show.vietsub.ass");
        write_translated(&target, "[Script Info]\nNew\n", false).expect("write");
        assert_eq!(fs::read_to_string(&target).unwrap(), "[Script Info]\nNew\n");
        // The atomic-write tmp sibling must not survive the rename.
        assert!(!dir.join("show.vietsub.ass.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_translated_refuses_overwrite_when_disabled() {
        let dir = ass_tmp_dir("write-no-overwrite");
        let target = dir.join("show.vietsub.ass");
        fs::write(&target, "existing").expect("seed");
        let err = write_translated(&target, "new", false).expect_err("refuse");
        assert!(matches!(err, AssOpsError::TargetExists));
        assert_eq!(fs::read_to_string(&target).unwrap(), "existing");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_translated_overwrites_when_enabled() {
        let dir = ass_tmp_dir("write-overwrite");
        let target = dir.join("show.vietsub.ass");
        fs::write(&target, "old").expect("seed");
        write_translated(&target, "new", true).expect("write");
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_styles_block_accepts_minimum_shape() {
        let block = "[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,48\n";
        validate_styles_block(block).expect("minimum shape passes");
    }

    #[test]
    fn validate_styles_block_tolerates_leading_blank_lines() {
        let block = "\n\n\n[V4+ Styles]\nFormat: Name, Fontname\n";
        validate_styles_block(block).expect("leading blanks ok");
    }

    #[test]
    fn validate_styles_block_tolerates_blank_lines_between_header_and_format() {
        let block = "[V4+ Styles]\n\n\nFormat: Name\n";
        validate_styles_block(block).expect("internal blanks ok");
    }

    #[test]
    fn validate_styles_block_rejects_missing_header() {
        let block = "Format: Name\nStyle: Default,Arial\n";
        let err = validate_styles_block(block).expect_err("must reject");
        assert!(matches!(err, AssOpsError::MissingStylesHeader));
    }

    #[test]
    fn validate_styles_block_rejects_lowercase_header() {
        // Case-sensitive per AC.
        let block = "[v4+ styles]\nFormat: Name\n";
        let err = validate_styles_block(block).expect_err("case-sensitive");
        assert!(matches!(err, AssOpsError::MissingStylesHeader));
    }

    #[test]
    fn validate_styles_block_rejects_missing_format_line() {
        let block = "[V4+ Styles]\nStyle: Default,Arial,48\n";
        let err = validate_styles_block(block).expect_err("no format header");
        assert!(matches!(err, AssOpsError::MissingFormatLine));
    }

    #[test]
    fn validate_styles_block_rejects_empty_input() {
        let err = validate_styles_block("").expect_err("empty");
        assert!(matches!(err, AssOpsError::MissingStylesHeader));
    }

    #[test]
    fn patch_styles_replaces_only_the_styles_section() {
        let original = "\
[Script Info]
Title: original
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname
Style: Old,Arial,48

[Events]
Format: Layer, Start, End, Style, Name, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Old,,Hello
";
        let new_block = "\
[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: NewStyle,Comic Sans,72
";
        let patched = patch_styles_in_place(original, new_block).expect("patch");
        // Script Info untouched.
        assert!(patched.contains("Title: original"));
        // Old style gone, new style present.
        assert!(!patched.contains("Style: Old,Arial,48"));
        assert!(patched.contains("Style: NewStyle,Comic Sans,72"));
        // Events untouched.
        assert!(patched.contains("Dialogue: 0,0:00:00.00,0:00:01.00,Old,,Hello"));
        // The Events header must still be a fresh section line, not glued to the styles tail.
        assert!(patched.contains("\n[Events]"));
    }

    #[test]
    fn patch_styles_when_styles_section_is_last_in_file() {
        // No trailing section after styles → swap should still produce a
        // file ending cleanly with the new styles block.
        let original = "\
[Script Info]
Title: x

[V4+ Styles]
Format: Name
Style: Old,Arial
";
        let new_block = "[V4+ Styles]\nFormat: Name, Bold\nStyle: New,Arial,1\n";
        let patched = patch_styles_in_place(original, new_block).expect("patch");
        assert!(patched.contains("Title: x"));
        assert!(patched.contains("Style: New,Arial,1"));
        assert!(!patched.contains("Style: Old,Arial"));
    }

    #[test]
    fn patch_styles_errors_when_target_has_no_styles_section() {
        let original = "[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer\n";
        let new_block = "[V4+ Styles]\nFormat: Name\n";
        let err = patch_styles_in_place(original, new_block).expect_err("must error");
        assert!(matches!(err, AssOpsError::TargetMissingStylesSection));
    }

    #[test]
    fn patch_styles_normalises_crlf_in_pasted_block() {
        let original = "[V4+ Styles]\nFormat: A\n\n[Events]\nFormat: B\n";
        let crlf_block = "[V4+ Styles]\r\nFormat: A, B\r\nStyle: x\r\n";
        let patched = patch_styles_in_place(original, crlf_block).expect("patch");
        // The original `\n[Events]` boundary stays intact (no extra CR).
        assert!(patched.contains("\n[Events]"));
        assert!(!patched.contains("\r"));
    }

    #[test]
    fn replace_styles_section_writes_atomically_and_clears_tmp() {
        let dir = ass_tmp_dir("style-patch");
        let target = dir.join("show.vietsub.ass");
        fs::write(
            &target,
            "[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: A\nStyle: Old\n\n[Events]\nFormat: B\n",
        )
        .expect("seed");
        let block = "[V4+ Styles]\nFormat: A, B\nStyle: New,Arial,1\n";
        replace_styles_section(&target, block).expect("style patch");
        let body = fs::read_to_string(&target).unwrap();
        assert!(body.contains("Style: New,Arial,1"));
        assert!(!body.contains("Style: Old"));
        assert!(!dir.join("show.vietsub.ass.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
