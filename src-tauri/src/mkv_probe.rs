//! Pure parser for `mkvmerge -i -F json` output.
//!
//! The Rust module is intentionally I/O-free: callers (the Tauri command in
//! `commands.rs`) are responsible for spawning `mkvmerge` and feeding the
//! captured stdout into [`parse_mkvmerge_json`]. This makes the parser
//! cheap to unit-test against fixture JSON, which is exactly what the
//! tests at the bottom of this module do.
//!
//! The companion [`preselect_index`] function applies the slice 0006
//! acceptance-criteria heuristic to suggest the row the track-picker
//! modal should highlight on open — keeping it next to the parser so
//! the two stay in lockstep when codec/language semantics evolve.

use serde::{Deserialize, Serialize};

/// Categorisation of a subtitle track relative to the v1 pipeline's
/// capabilities. The frontend uses this to decide row interactivity and
/// the disabled-reason badge.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubtitleKind {
    /// Text-based codec the pipeline can extract straight to `.ass`
    /// (`ass`/`ssa` → copy, `srt` → convert during extract per slice
    /// 0007). Only this variant is "selectable" in the track-picker.
    Text,
    /// Bitmap codec (PGS, VobSub, DVBSUB). Bitmap subs require OCR — out
    /// of scope for v1 per the PRD. Rendered disabled with the
    /// "Bitmap — không hỗ trợ" badge.
    Bitmap,
    /// Anything else (WebVTT, Kate, HDMV TextST, unrecognised). Rare in
    /// anime MKVs — still rendered disabled, without the "Bitmap" badge,
    /// so the user knows the row is unsupported without it being
    /// misclassified as a bitmap codec.
    Other,
}

/// Typed representation of one subtitle track inside an MKV. Field shapes
/// match the columns the frontend's track-picker table renders.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubtitleTrack {
    /// `id` from mkvmerge JSON — the value mkvextract expects when the
    /// streaming extract job is wired in slice 0007.
    pub mkv_track_id: u32,
    /// Raw `properties.codec_id` (e.g. `S_TEXT/ASS`). Kept for debugging
    /// and forward-compat with codecs we don't classify yet.
    pub codec_id: String,
    /// Normalised codec slug: `ass`, `srt`, `pgs`, `vobsub`, `dvbsub`,
    /// `webvtt`, `kate`, `textst`, or `unknown`.
    pub codec: String,
    pub kind: SubtitleKind,
    /// `kind == SubtitleKind::Text`. Pre-computed for the frontend so the
    /// table can disable rows without re-checking the kind enum.
    pub extractable: bool,
    /// 3-letter ISO 639-2 code from `properties.language`. Defaults to
    /// `"und"` when missing/unknown so the language tag column always
    /// has something to render.
    pub language: String,
    /// `properties.language_ietf` (BCP-47, e.g. `en`, `ja`) if mkvmerge
    /// produced one. Useful future-proofing for chapters/scripts that
    /// only label BCP-47.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_ietf: Option<String>,
    /// `properties.track_name`. Empty/missing maps to `None` so the
    /// table cell renders as `—` instead of a blank.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub is_default: bool,
    pub is_forced: bool,
}

/// Errors emitted by [`parse_mkvmerge_json`]. The string variants exist
/// so the Tauri command can surface them verbatim in the modal's error
/// pane without further mapping.
#[derive(Debug)]
pub enum ProbeError {
    Parse(serde_json::Error),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::Parse(e) => write!(f, "Không đọc được kết quả mkvmerge: {e}"),
        }
    }
}

impl std::error::Error for ProbeError {}

impl From<serde_json::Error> for ProbeError {
    fn from(value: serde_json::Error) -> Self {
        ProbeError::Parse(value)
    }
}

/// Raw deserialiser for the `mkvmerge -i -F json` top-level shape. Only
/// fields the picker cares about are listed; mkvmerge happily emits a
/// lot of metadata (container info, attachments, chapters) which we
/// drop on the floor.
#[derive(Deserialize)]
struct RawMkvmergeOutput {
    #[serde(default)]
    tracks: Vec<RawTrack>,
}

#[derive(Deserialize)]
struct RawTrack {
    id: u32,
    #[serde(default, rename = "type")]
    track_type: String,
    #[serde(default)]
    properties: RawTrackProperties,
}

#[derive(Default, Deserialize)]
struct RawTrackProperties {
    #[serde(default)]
    codec_id: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    language_ietf: Option<String>,
    #[serde(default)]
    track_name: Option<String>,
    #[serde(default)]
    default_track: Option<bool>,
    #[serde(default)]
    forced_track: Option<bool>,
}

/// Parse `mkvmerge -i -F json` stdout into the list of subtitle tracks
/// the picker renders. Non-subtitle tracks (video, audio, buttons) are
/// silently dropped — the modal only cares about subtitles, and surfacing
/// the others would crowd the table.
pub fn parse_mkvmerge_json(stdout: &str) -> Result<Vec<SubtitleTrack>, ProbeError> {
    let raw: RawMkvmergeOutput = serde_json::from_str(stdout)?;
    let tracks = raw
        .tracks
        .into_iter()
        .filter(|t| t.track_type.eq_ignore_ascii_case("subtitles"))
        .map(map_track)
        .collect();
    Ok(tracks)
}

fn map_track(raw: RawTrack) -> SubtitleTrack {
    let (codec, kind) = classify(&raw.properties.codec_id);
    let extractable = matches!(kind, SubtitleKind::Text);
    SubtitleTrack {
        mkv_track_id: raw.id,
        codec_id: raw.properties.codec_id,
        codec,
        kind,
        extractable,
        language: raw
            .properties
            .language
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "und".to_string()),
        language_ietf: raw.properties.language_ietf.filter(|s| !s.trim().is_empty()),
        title: raw.properties.track_name.filter(|s| !s.trim().is_empty()),
        is_default: raw.properties.default_track.unwrap_or(false),
        is_forced: raw.properties.forced_track.unwrap_or(false),
    }
}

/// Map a raw `codec_id` (Matroska codec spec strings) to the
/// (normalised slug, kind) pair the picker renders.
///
/// Codec ids documented at <https://www.matroska.org/technical/codec_specs.html>.
fn classify(codec_id: &str) -> (String, SubtitleKind) {
    let upper = codec_id.to_ascii_uppercase();
    match upper.as_str() {
        "S_TEXT/ASS" | "S_TEXT/SSA" => ("ass".to_string(), SubtitleKind::Text),
        "S_TEXT/UTF8" | "S_TEXT/ASCII" => ("srt".to_string(), SubtitleKind::Text),
        "S_HDMV/PGS" => ("pgs".to_string(), SubtitleKind::Bitmap),
        "S_VOBSUB" => ("vobsub".to_string(), SubtitleKind::Bitmap),
        "S_DVBSUB" => ("dvbsub".to_string(), SubtitleKind::Bitmap),
        "S_TEXT/WEBVTT" => ("webvtt".to_string(), SubtitleKind::Other),
        "S_KATE" => ("kate".to_string(), SubtitleKind::Other),
        "S_HDMV/TEXTST" => ("textst".to_string(), SubtitleKind::Other),
        _ => ("unknown".to_string(), SubtitleKind::Other),
    }
}

/// Pre-selection heuristic per slice 0006 AC. Returns the index of the
/// row the picker should initially highlight, or `None` when no row is
/// selectable.
///
/// Top-down rules — returns the first hit:
///  1. `codec=ass AND (lang=eng OR is_default) AND title does NOT contain
///     "sign"/"song"` (case-insensitive substring)
///  2. `codec=ass AND lang=eng`
///  3. First selectable row (extractable text-based track)
///  4. `None` — caller surfaces the "Không có subtitle track text-based
///     trong file này" empty state instead.
///
/// The "sign"/"song" check filters out the typical anime sub releases
/// that bundle a "signs & songs only" track alongside the full dialogue
/// — the user almost certainly wants the dialogue track, not the
/// karaoke/signage one.
pub fn preselect_index(tracks: &[SubtitleTrack]) -> Option<usize> {
    let is_sign_or_song = |title: &Option<String>| -> bool {
        title
            .as_ref()
            .map(|t| {
                let lower = t.to_lowercase();
                lower.contains("sign") || lower.contains("song")
            })
            .unwrap_or(false)
    };

    for (i, t) in tracks.iter().enumerate() {
        if t.extractable
            && t.codec == "ass"
            && (t.language == "eng" || t.is_default)
            && !is_sign_or_song(&t.title)
        {
            return Some(i);
        }
    }

    for (i, t) in tracks.iter().enumerate() {
        if t.extractable && t.codec == "ass" && t.language == "eng" {
            return Some(i);
        }
    }

    tracks.iter().position(|t| t.extractable)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ass_track(id: u32, language: &str, default: bool, title: Option<&str>) -> SubtitleTrack {
        SubtitleTrack {
            mkv_track_id: id,
            codec_id: "S_TEXT/ASS".into(),
            codec: "ass".into(),
            kind: SubtitleKind::Text,
            extractable: true,
            language: language.into(),
            language_ietf: None,
            title: title.map(|s| s.into()),
            is_default: default,
            is_forced: false,
        }
    }

    fn srt_track(id: u32, language: &str) -> SubtitleTrack {
        SubtitleTrack {
            mkv_track_id: id,
            codec_id: "S_TEXT/UTF8".into(),
            codec: "srt".into(),
            kind: SubtitleKind::Text,
            extractable: true,
            language: language.into(),
            language_ietf: None,
            title: None,
            is_default: false,
            is_forced: false,
        }
    }

    fn pgs_track(id: u32, language: &str) -> SubtitleTrack {
        SubtitleTrack {
            mkv_track_id: id,
            codec_id: "S_HDMV/PGS".into(),
            codec: "pgs".into(),
            kind: SubtitleKind::Bitmap,
            extractable: false,
            language: language.into(),
            language_ietf: None,
            title: None,
            is_default: false,
            is_forced: false,
        }
    }

    #[test]
    fn parses_subtitle_tracks_and_drops_non_subtitle_rows() {
        // Typical anime MKV: 1 video, 1 audio, 3 subtitle tracks. Only
        // the subtitle rows survive the filter.
        let json = r#"{
          "tracks": [
            {
              "id": 0,
              "type": "video",
              "properties": { "codec_id": "V_MPEG4/ISO/AVC" }
            },
            {
              "id": 1,
              "type": "audio",
              "properties": { "codec_id": "A_FLAC", "language": "jpn" }
            },
            {
              "id": 2,
              "type": "subtitles",
              "properties": {
                "codec_id": "S_TEXT/ASS",
                "language": "eng",
                "language_ietf": "en",
                "track_name": "Full Dialogue",
                "default_track": true,
                "forced_track": false
              }
            },
            {
              "id": 3,
              "type": "subtitles",
              "properties": {
                "codec_id": "S_TEXT/ASS",
                "language": "eng",
                "track_name": "Signs & Songs",
                "default_track": false,
                "forced_track": true
              }
            },
            {
              "id": 4,
              "type": "subtitles",
              "properties": {
                "codec_id": "S_HDMV/PGS",
                "language": "jpn"
              }
            }
          ]
        }"#;
        let tracks = parse_mkvmerge_json(json).expect("parse");
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].mkv_track_id, 2);
        assert_eq!(tracks[0].codec, "ass");
        assert_eq!(tracks[0].kind, SubtitleKind::Text);
        assert!(tracks[0].extractable);
        assert_eq!(tracks[0].language, "eng");
        assert_eq!(tracks[0].language_ietf.as_deref(), Some("en"));
        assert_eq!(tracks[0].title.as_deref(), Some("Full Dialogue"));
        assert!(tracks[0].is_default);
        assert!(!tracks[0].is_forced);

        assert!(tracks[1].is_forced);
        assert_eq!(tracks[1].title.as_deref(), Some("Signs & Songs"));

        assert_eq!(tracks[2].codec, "pgs");
        assert_eq!(tracks[2].kind, SubtitleKind::Bitmap);
        assert!(!tracks[2].extractable);
    }

    #[test]
    fn classifies_srt_via_codec_id_utf8() {
        let json = r#"{
          "tracks": [{
            "id": 2,
            "type": "subtitles",
            "properties": { "codec_id": "S_TEXT/UTF8", "language": "eng" }
          }]
        }"#;
        let tracks = parse_mkvmerge_json(json).expect("parse");
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].codec, "srt");
        assert!(tracks[0].extractable);
    }

    #[test]
    fn classifies_vobsub_and_dvbsub_as_bitmap() {
        let json = r#"{
          "tracks": [
            { "id": 2, "type": "subtitles", "properties": { "codec_id": "S_VOBSUB" } },
            { "id": 3, "type": "subtitles", "properties": { "codec_id": "S_DVBSUB" } }
          ]
        }"#;
        let tracks = parse_mkvmerge_json(json).expect("parse");
        assert_eq!(tracks[0].codec, "vobsub");
        assert_eq!(tracks[0].kind, SubtitleKind::Bitmap);
        assert!(!tracks[0].extractable);
        assert_eq!(tracks[1].codec, "dvbsub");
        assert_eq!(tracks[1].kind, SubtitleKind::Bitmap);
    }

    #[test]
    fn classifies_unknown_codec_as_other_and_disables_extract() {
        let json = r#"{
          "tracks": [{
            "id": 2,
            "type": "subtitles",
            "properties": { "codec_id": "S_TOTALLY_NEW_CODEC" }
          }]
        }"#;
        let tracks = parse_mkvmerge_json(json).expect("parse");
        assert_eq!(tracks[0].codec, "unknown");
        assert_eq!(tracks[0].kind, SubtitleKind::Other);
        assert!(!tracks[0].extractable);
    }

    #[test]
    fn missing_language_falls_back_to_und() {
        let json = r#"{
          "tracks": [{
            "id": 2,
            "type": "subtitles",
            "properties": { "codec_id": "S_TEXT/ASS" }
          }]
        }"#;
        let tracks = parse_mkvmerge_json(json).expect("parse");
        assert_eq!(tracks[0].language, "und");
        assert_eq!(tracks[0].language_ietf, None);
        assert_eq!(tracks[0].title, None);
    }

    #[test]
    fn empty_track_list_returns_empty_vec() {
        let tracks = parse_mkvmerge_json(r#"{"tracks": []}"#).expect("parse");
        assert!(tracks.is_empty());
    }

    #[test]
    fn missing_tracks_field_returns_empty_vec() {
        // mkvmerge always emits `tracks`, but the field is `#[serde(default)]`
        // so an unexpected omission still parses cleanly instead of erroring.
        let tracks = parse_mkvmerge_json(r#"{}"#).expect("parse");
        assert!(tracks.is_empty());
    }

    #[test]
    fn rejects_malformed_json() {
        let err = parse_mkvmerge_json("not json at all").unwrap_err();
        assert!(matches!(err, ProbeError::Parse(_)));
    }

    #[test]
    fn preselect_picks_default_ass_skipping_signs_songs() {
        // Anime release pattern: a "Signs & Songs" forced track is the
        // first ASS row, followed by the full dialogue track marked
        // default. The heuristic must skip Signs/Songs even when it's
        // first in the list.
        let tracks = vec![
            ass_track(2, "eng", false, Some("Signs & Songs")),
            ass_track(3, "eng", true, Some("Full Dialogue")),
        ];
        assert_eq!(preselect_index(&tracks), Some(1));
    }

    #[test]
    fn preselect_picks_eng_ass_when_no_default() {
        // Rule 1: ASS + lang=eng matches even without `default_track`.
        let tracks = vec![ass_track(2, "jpn", false, None), ass_track(3, "eng", false, None)];
        assert_eq!(preselect_index(&tracks), Some(1));
    }

    #[test]
    fn preselect_falls_back_to_rule2_when_default_eng_title_is_sign() {
        // Rule 1 fails because the only eng+default row is signs/songs.
        // Rule 2 also requires `lang=eng` AND `codec=ass`: with a single
        // candidate that's already disqualified by Rule 1's title rule,
        // Rule 2 picks it anyway (lang=eng, codec=ass — no title check).
        let tracks = vec![ass_track(2, "eng", true, Some("Signs only"))];
        assert_eq!(preselect_index(&tracks), Some(0));
    }

    #[test]
    fn preselect_falls_back_to_first_selectable_when_no_eng_ass() {
        // No ASS + eng — heuristic falls all the way through to Rule 3
        // (first extractable row).
        let tracks = vec![
            pgs_track(2, "jpn"),
            srt_track(3, "jpn"),
            ass_track(4, "jpn", false, None),
        ];
        assert_eq!(preselect_index(&tracks), Some(1));
    }

    #[test]
    fn preselect_returns_none_when_all_bitmap() {
        let tracks = vec![pgs_track(2, "jpn"), pgs_track(3, "eng")];
        assert_eq!(preselect_index(&tracks), None);
    }

    #[test]
    fn preselect_returns_none_when_track_list_empty() {
        assert_eq!(preselect_index(&[]), None);
    }

    #[test]
    fn preselect_sign_song_match_is_case_insensitive() {
        // "SIGN" / "Song" / "sign" all match — the heuristic lowercases
        // the title once.
        let tracks = vec![
            ass_track(2, "eng", true, Some("SIGNS ONLY")),
            ass_track(3, "eng", true, Some("Full")),
        ];
        assert_eq!(preselect_index(&tracks), Some(1));
    }
}
