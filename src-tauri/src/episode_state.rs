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
//! Pure-ish: the function calls `Path::is_file` (one syscall per
//! artefact) but performs no other I/O and never mutates the folder.
//! Fixture-driven unit tests use a tempdir.

use std::path::Path;

use serde::Serialize;

/// Snapshot of which derived artefacts currently exist inside one
/// Episode's folder.
///
/// Field order mirrors the four pipeline stages from the PRD's
/// `derive_state` pseudocode (Extract → Translate → Render).
/// All four fields are present in the wire shape from slice 0007
/// onward; only `has_extracted_sub` is computed and used today —
/// the others always return `false` until their owning slices land.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EpisodeArtifacts {
    pub has_extracted_sub: bool,
    pub has_translation_draft: bool,
    pub has_translated_sub: bool,
    pub has_render: bool,
}

/// Inspect `episode_folder` and report which derived artefacts are
/// present on disk. `basename` is the sanitised MKV basename (also
/// used as the EpisodeFolder name per the slice 0005 contract) and
/// drives the artefact filename prefix: `<basename>.eng.ass` for the
/// extracted subtitle, etc.
///
/// Slice 0007 implements only the extracted-subtitle check; the
/// other three return `false` until their owning slices ship and
/// hook into the same function. Keeping the shape stable from the
/// start means the frontend / JobsStore code paths that read this
/// struct don't need a follow-up rewrite.
pub fn inspect_artifacts(episode_folder: &Path, basename: &str) -> EpisodeArtifacts {
    let extracted_sub = episode_folder.join(format!("{basename}.eng.ass"));
    EpisodeArtifacts {
        has_extracted_sub: extracted_sub.is_file(),
        has_translation_draft: false,
        has_translated_sub: false,
        has_render: false,
    }
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
        let artifacts = inspect_artifacts(&dir, "show-01");
        assert!(!artifacts.has_extracted_sub);
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
        let artifacts = inspect_artifacts(&dir, basename);
        assert!(artifacts.has_extracted_sub);
        // The other slice-7-out-of-scope flags stay false.
        assert!(!artifacts.has_translation_draft);
        assert!(!artifacts.has_translated_sub);
        assert!(!artifacts.has_render);
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
        let artifacts = inspect_artifacts(&dir, basename);
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
        let artifacts = inspect_artifacts(&dir, "this-show");
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
        let artifacts = inspect_artifacts(&dir, basename);
        assert!(artifacts.has_extracted_sub);
        let _ = fs::remove_dir_all(&dir);
    }
}
