//! Pure disk-presence derivation for the per-Episode pipeline stages.
//!
//! The PRD's `derive_state` pseudocode keys the Episode row's badge
//! off two inputs: which artefacts exist on disk inside the
//! EpisodeFolder, and whether a Job is currently Running for that
//! Episode. This module covers the disk half — a single
//! [`inspect_artifacts`] call returns a typed [`EpisodeArtifacts`]
//! struct the frontend overlays with its live JobsStore snapshot to
//! pick the final badge ("Trống" / "Đang trích xuất" / "Đã extract" /
//! "Lỗi extract").
//!
//! Slice 0007 only cares about the extracted subtitle artefact
//! (`<basename>.eng.ass`); the audio / translated / rendered artefact
//! flags arrive in later slices alongside their respective pipeline
//! stages. The struct is already shaped for them so the frontend
//! shape stabilises now.
//!
//! Slice 0008 adds [`clean_stale_artifacts`] — the crash-recovery
//! pass run on Project open. The AC's v1 heuristic ("a `.mp4` whose
//! size is 0 OR a `.ass` whose size is 0") is exactly what
//! `<basename>.VietSub.mp4` and `<basename>.eng.ass` look like when
//! a Render or ExtractSubtitle job was killed before it wrote
//! anything. The cleanup is silent on missing folders so a project
//! whose folder was deleted out from under ZimeSub still loads.
//!
//! Slice 0010 lights up the translate-stage flags: `has_translation_draft`
//! (`<basename>.eng.ass.txt`) and `has_translated_sub`
//! (`<basename>.vietsub.ass`). It also adds [`is_render_stale`] —
//! the mtime check the row uses to surface the yellow "Render lỗi
//! thời" badge when a TranslatedSub was edited after the last render.
//!
//! Pure-ish: the function calls `Path::is_file` (one syscall per
//! artefact) but performs no other I/O and never mutates the folder.
//! Fixture-driven unit tests use a tempdir.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tracing::{info, warn};

/// Snapshot of which derived artefacts currently exist inside one
/// Episode's folder.
///
/// Field order mirrors the four pipeline stages from the PRD's
/// `derive_state` pseudocode (Extract → Translate → Render).
/// All four fields are present in the wire shape from slice 0007
/// onward; only `has_extracted_sub` is computed and used today —
/// the others always return `false` until their owning slices land.
///
/// Slice 0009 wires `has_extracted_audio`. Per PRD, the audio
/// artefact is decorative — the EpisodeState progression does not
/// depend on it, so the row badge derivation keeps using
/// `has_extracted_sub` / `has_translated_sub` / `has_render`. The new
/// flag drives a small companion "audio" indicator badge.
///
/// Slice 0010 wires `has_translation_draft` (`<basename>.eng.ass.txt`),
/// `has_translated_sub` (`<basename>.vietsub.ass`), and
/// `is_render_stale` (Render mtime older than TranslatedSub mtime).
/// `has_render` is also lit up early so the staleness check has
/// something to compare against; the Render pipeline itself arrives
/// in slice 0011.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EpisodeArtifacts {
    pub has_extracted_sub: bool,
    pub has_extracted_audio: bool,
    pub has_translation_draft: bool,
    pub has_translated_sub: bool,
    pub has_render: bool,
    /// `true` when a Render artefact exists AND its mtime is older
    /// than the TranslatedSub's mtime — i.e. the user re-translated
    /// (or StylePatch'd) after the last render so the on-disk
    /// `<basename>.VietSub.mp4` no longer reflects the current
    /// translation. Drives the yellow "Render lỗi thời" badge on the
    /// Episode row. `false` when either file is missing (no render
    /// → nothing to be stale).
    pub is_render_stale: bool,
}

/// Inspect `episode_folder` and report which derived artefacts are
/// present on disk. `basename` is the sanitised MKV basename (also
/// used as the EpisodeFolder name per the slice 0005 contract) and
/// drives the artefact filename prefix: `<basename>.eng.ass` for the
/// extracted subtitle, etc.
///
/// Slice 0009 added `audio_extension` so the audio check can match
/// the codec the project is configured for (`mp3` / `aac` / `flac`).
/// Passing `None` keeps the audio flag `false` — handy for the
/// pre-slice-0009 callers that don't carry a codec yet.
pub fn inspect_artifacts(
    episode_folder: &Path,
    basename: &str,
    audio_extension: Option<&str>,
) -> EpisodeArtifacts {
    let extracted_sub = episode_folder.join(format!("{basename}.eng.ass"));
    let translation_draft = episode_folder.join(format!("{basename}.eng.ass.txt"));
    let translated_sub = episode_folder.join(format!("{basename}.vietsub.ass"));
    let render = episode_folder.join(format!("{basename}.VietSub.mp4"));
    let has_extracted_audio = audio_extension
        .map(|ext| {
            let candidate = episode_folder.join(format!("{basename}.{ext}"));
            candidate.is_file()
        })
        .unwrap_or(false);
    let has_translated_sub = translated_sub.is_file();
    let has_render = render.is_file();
    let is_render_stale = if has_render && has_translated_sub {
        is_first_older_than_second(&render, &translated_sub)
    } else {
        false
    };
    EpisodeArtifacts {
        has_extracted_sub: extracted_sub.is_file(),
        has_extracted_audio,
        has_translation_draft: translation_draft.is_file(),
        has_translated_sub,
        has_render,
        is_render_stale,
    }
}

/// Compare two existing files' mtimes. Returns `true` when `a` is
/// strictly older than `b`. Used by [`inspect_artifacts`] for the
/// render-staleness check.
///
/// Silent on metadata errors — returns `false` so a transient
/// permissions glitch never surfaces a misleading "stale render"
/// badge. The forensic readback path lives in
/// [`clean_stale_artifacts`] for actual disk problems.
fn is_first_older_than_second(a: &Path, b: &Path) -> bool {
    let Ok(a_meta) = fs::metadata(a) else {
        return false;
    };
    let Ok(b_meta) = fs::metadata(b) else {
        return false;
    };
    let Ok(a_mtime) = a_meta.modified() else {
        return false;
    };
    let Ok(b_mtime) = b_meta.modified() else {
        return false;
    };
    a_mtime < b_mtime
}

/// Crash-recovery scan for one EpisodeFolder. Walks the folder
/// (non-recursive) and deletes any `.mp4` / `.ass` / `.mp3` / `.aac`
/// / `.flac` whose size is 0 bytes — the AC's v1 heuristic for "this
/// file is a partial output from a job that died before it could
/// flush anything". Slice 0009 extends the original mp4/ass set with
/// the three audio extensions ExtractAudio writes to. Returns the
/// list of deleted paths so the caller can log them.
///
/// Silent on a missing or unreadable folder so a project whose
/// EpisodeFolder was deleted out from under ZimeSub (e.g. via
/// Explorer between launches) still opens — those Episode rows will
/// be flagged `MissingSource` by their own derivation path.
///
/// Pure-ish: only deletes files that match the size-0 criterion;
/// other files (real outputs, unrelated user files) are never
/// touched. Each deletion is logged at `info` so a forensic readback
/// of the app log shows which artefacts were considered stale.
pub fn clean_stale_artifacts(episode_folder: &Path) -> Vec<PathBuf> {
    const STALE_EXTENSIONS: &[&str] = &[".mp4", ".ass", ".mp3", ".aac", ".flac"];
    let mut deleted: Vec<PathBuf> = Vec::new();
    if !episode_folder.is_dir() {
        return deleted;
    }
    let entries = match fs::read_dir(episode_folder) {
        Ok(e) => e,
        Err(e) => {
            warn!(
                folder = %episode_folder.display(),
                error = %e,
                "crash-recovery scan: failed to read EpisodeFolder"
            );
            return deleted;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if !STALE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
            continue;
        }
        let len = match fs::metadata(&path) {
            Ok(m) => m.len(),
            Err(_) => continue,
        };
        if len != 0 {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                info!(
                    path = %path.display(),
                    "crash-recovery: deleted stale 0-byte artefact"
                );
                deleted.push(path);
            }
            Err(e) => {
                warn!(
                    path = %path.display(),
                    error = %e,
                    "crash-recovery: failed to delete stale artefact"
                );
            }
        }
    }
    deleted
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir_for_test(name: &str) -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let path = env::temp_dir().join(format!("zimesub-test-state-{name}-{pid}-{nanos}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn empty_folder_reports_no_artifacts() {
        let dir = temp_dir_for_test("empty");
        let artifacts = inspect_artifacts(&dir, "show-01", Some("mp3"));
        assert!(!artifacts.has_extracted_sub);
        assert!(!artifacts.has_extracted_audio);
        assert!(!artifacts.has_translation_draft);
        assert!(!artifacts.has_translated_sub);
        assert!(!artifacts.has_render);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn presence_of_eng_ass_flips_has_extracted_sub() {
        let dir = temp_dir_for_test("has-ass");
        let basename = "show-01";
        fs::write(dir.join(format!("{basename}.eng.ass")), b"[Script Info]\n").expect("write");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(artifacts.has_extracted_sub);
        // The other slice-7-out-of-scope flags stay false.
        assert!(!artifacts.has_extracted_audio);
        assert!(!artifacts.has_translation_draft);
        assert!(!artifacts.has_translated_sub);
        assert!(!artifacts.has_render);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn presence_of_audio_file_flips_has_extracted_audio() {
        let dir = temp_dir_for_test("has-audio");
        let basename = "show-01";
        fs::write(dir.join(format!("{basename}.mp3")), b"binary").expect("write");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(artifacts.has_extracted_audio);
        assert!(!artifacts.has_extracted_sub);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_check_matches_configured_extension_only() {
        let dir = temp_dir_for_test("audio-ext");
        let basename = "show-01";
        // Project is configured for `mp3`; an existing `.aac` doesn't
        // flip the flag because that's the wrong codec for this
        // project's audio default.
        fs::write(dir.join(format!("{basename}.aac")), b"binary").expect("write");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(!artifacts.has_extracted_audio);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_check_skipped_when_extension_is_none() {
        let dir = temp_dir_for_test("audio-none");
        let basename = "show-01";
        fs::write(dir.join(format!("{basename}.mp3")), b"binary").expect("write");
        // Caller didn't supply a codec → audio flag stays false even
        // when the file exists. Used by pre-slice-0009 callers and the
        // test isolation here.
        let artifacts = inspect_artifacts(&dir, basename, None);
        assert!(!artifacts.has_extracted_audio);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn directory_named_like_artifact_does_not_count() {
        // Defensive: someone could pathologically create a *folder* named
        // `<basename>.eng.ass`. `is_file()` rejects that so the badge
        // never claims "Đã extract" for a non-file path.
        let dir = temp_dir_for_test("dir-not-file");
        let basename = "show-02";
        fs::create_dir(dir.join(format!("{basename}.eng.ass"))).expect("mkdir");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(!artifacts.has_extracted_sub);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn basename_matches_exactly_not_substring() {
        // Files named with a different basename inside the same folder
        // must not flip the flag — sibling EpisodeFolders happen when
        // two MKVs in the same Project share a folder (PRD edge case).
        let dir = temp_dir_for_test("basename-exact");
        fs::write(dir.join("other-show.eng.ass"), b"[Script Info]\n").expect("write");
        let artifacts = inspect_artifacts(&dir, "this-show", Some("mp3"));
        assert!(!artifacts.has_extracted_sub);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn handles_basename_with_brackets_and_spaces() {
        // Real-world anime release filename — the EpisodeFolder name is
        // never sanitised further than what `project_store::sanitize_folder_name`
        // does, so brackets, spaces, and dashes survive into `basename`.
        let dir = temp_dir_for_test("real-basename");
        let basename = "[Erai-raws] Oi Tonbo - 01 [1080p][HEVC][1E1E044E]";
        fs::write(dir.join(format!("{basename}.eng.ass")), b"x").expect("write");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(artifacts.has_extracted_sub);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_stale_artifacts_removes_zero_byte_mp4_ass_and_audio() {
        let dir = temp_dir_for_test("stale");
        fs::write(dir.join("ep.VietSub.mp4"), b"").expect("write empty mp4");
        fs::write(dir.join("ep.eng.ass"), b"").expect("write empty ass");
        fs::write(dir.join("ep.mp3"), b"").expect("write empty mp3");
        fs::write(dir.join("ep.aac"), b"").expect("write empty aac");
        fs::write(dir.join("ep.flac"), b"").expect("write empty flac");
        // Real outputs survive — same extensions but with content.
        fs::write(dir.join("good.mp4"), b"binary content").expect("write good mp4");
        fs::write(dir.join("good.ass"), b"[Script Info]\n").expect("write good ass");
        fs::write(dir.join("good.mp3"), b"audio bytes").expect("write good mp3");
        // Unrelated files of other extensions are never touched.
        fs::write(dir.join("notes.txt"), b"").expect("write txt");

        let deleted = clean_stale_artifacts(&dir);
        assert_eq!(deleted.len(), 5);
        assert!(!dir.join("ep.VietSub.mp4").exists());
        assert!(!dir.join("ep.eng.ass").exists());
        assert!(!dir.join("ep.mp3").exists());
        assert!(!dir.join("ep.aac").exists());
        assert!(!dir.join("ep.flac").exists());
        assert!(dir.join("good.mp4").exists());
        assert!(dir.join("good.ass").exists());
        assert!(dir.join("good.mp3").exists());
        assert!(dir.join("notes.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_stale_artifacts_is_silent_on_missing_folder() {
        let dir = temp_dir_for_test("missing");
        let missing = dir.join("does-not-exist");
        let deleted = clean_stale_artifacts(&missing);
        assert!(deleted.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_stale_artifacts_does_not_match_substring_extensions() {
        // A file named foo.mp4.bak ends with ".bak", not ".mp4" — must
        // not be deleted even at 0 bytes. Same for foo.ass.txt.
        let dir = temp_dir_for_test("substring");
        fs::write(dir.join("foo.mp4.bak"), b"").expect("write");
        fs::write(dir.join("foo.ass.txt"), b"").expect("write");
        let deleted = clean_stale_artifacts(&dir);
        assert!(deleted.is_empty());
        assert!(dir.join("foo.mp4.bak").exists());
        assert!(dir.join("foo.ass.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn presence_of_eng_ass_txt_flips_has_translation_draft() {
        let dir = temp_dir_for_test("has-draft");
        let basename = "show-01";
        fs::write(dir.join(format!("{basename}.eng.ass.txt")), b"x").expect("write");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(artifacts.has_translation_draft);
        assert!(!artifacts.has_translated_sub);
        assert!(!artifacts.has_render);
        assert!(!artifacts.is_render_stale);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn presence_of_vietsub_ass_flips_has_translated_sub() {
        let dir = temp_dir_for_test("has-vietsub");
        let basename = "show-01";
        fs::write(dir.join(format!("{basename}.vietsub.ass")), b"x").expect("write");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(artifacts.has_translated_sub);
        assert!(!artifacts.has_render);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn presence_of_vietsub_mp4_flips_has_render() {
        let dir = temp_dir_for_test("has-render");
        let basename = "show-01";
        fs::write(dir.join(format!("{basename}.VietSub.mp4")), b"x").expect("write");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(artifacts.has_render);
        // No TranslatedSub to compare against — staleness must be false.
        assert!(!artifacts.is_render_stale);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn render_older_than_translated_sub_flips_is_render_stale() {
        let dir = temp_dir_for_test("stale-render");
        let basename = "show-01";
        let render = dir.join(format!("{basename}.VietSub.mp4"));
        let translated = dir.join(format!("{basename}.vietsub.ass"));
        fs::write(&render, b"old-render").expect("write");
        // Sleep enough for the OS mtime resolution to actually tick —
        // 100 ms is safe on every common FS (FAT32 = 2 s is not in
        // play here, NTFS = 100 ns, tmpfs = nanosecond).
        std::thread::sleep(std::time::Duration::from_millis(100));
        fs::write(&translated, b"newer-translation").expect("write");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(artifacts.has_render);
        assert!(artifacts.has_translated_sub);
        assert!(artifacts.is_render_stale);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn render_newer_than_translated_sub_keeps_is_render_stale_false() {
        let dir = temp_dir_for_test("fresh-render");
        let basename = "show-01";
        fs::write(dir.join(format!("{basename}.vietsub.ass")), b"old").expect("write");
        std::thread::sleep(std::time::Duration::from_millis(100));
        fs::write(dir.join(format!("{basename}.VietSub.mp4")), b"new").expect("write");
        let artifacts = inspect_artifacts(&dir, basename, Some("mp3"));
        assert!(artifacts.has_render);
        assert!(!artifacts.is_render_stale);
        let _ = fs::remove_dir_all(&dir);
    }
}
