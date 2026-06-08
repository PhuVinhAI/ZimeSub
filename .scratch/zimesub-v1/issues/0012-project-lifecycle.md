---
title: "Project lifecycle: MissingSource, Relocate, Rename, Remove"
labels: [ready-for-agent]
type: AFK
blocked_by: [0011]
user_stories: [11, 12, 13, 19, 20, 21, 22, 23]
status: done
---

# 0012 — Project lifecycle: MissingSource, Relocate, Rename, Remove

## Status

Done — implemented in slice 0012.

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

Lifecycle operations that protect the user from data loss and broken state:

1. **MissingSource overlay** — detect when `SourceMkv` has been moved / renamed / deleted on disk; Episode enters the `MissingSource` overlay state. `Extract*` and `Render` buttons disabled with explanatory tooltip; Translate buttons remain enabled (artifacts in the EpisodeFolder are independent).
2. **Relocate** — file picker to update `source_mkv_path` for a MissingSource Episode.
3. **Rename Project** — rename ProjectFolder + update `name` in `zimesub.json`.
4. **Remove Episode** — delete EpisodeFolder + json entry, with confirm.
5. **Delete Project** — strong confirm, deletes ProjectFolder contents (SourceMkv files outside untouched per ADR-0001).

## Acceptance criteria

- [x] On Project open AND before enqueueing any Job, `project_store::check_source_exists` verifies each Episode's `source_mkv_path` exists on disk. If not, that Episode is flagged with the `MissingSource` overlay.
- [x] `MissingSource` UI: red badge "MKV gốc không tìm thấy" on the Episode row. `Trích xuất sub`, `Trích xuất audio`, `Render` buttons disabled with tooltip "MKV gốc không tìm thấy". Translate buttons (open folder, draft, paste back, StylePatch) remain enabled.
- [x] **Relocate** — "Relocate…" button on MissingSource Episodes opens a `.mkv`-filtered file picker. On select, `source_mkv_path` in `zimesub.json` is updated, the overlay clears, `EpisodeState` is re-derived.
- [x] **Rename Project** — "Đổi tên project" action from the project view header opens a modal with the current name. On submit, the ProjectFolder is renamed (`std::fs::rename`) and the `name` field in `zimesub.json` is updated. If folder rename fails (e.g. permission, in-use), the json is NOT updated and the user sees the OS-level error.
- [x] **Remove Episode** — action available on each Episode row (e.g. via row dropdown menu). Opens a confirm modal "Xoá Episode '<folder_name>'? EpisodeFolder và toàn bộ artifact bên trong sẽ bị xoá. File MKV gốc không bị đụng tới." On confirm, EpisodeFolder is deleted and the `episodes` array in json is filtered.
- [x] **Delete Project** — action from the project view's settings menu. Strong two-step confirm modal listing what will be deleted (ProjectFolder content) and what will NOT (SourceMkv files outside it). Confirmation requires typing the project name verbatim to enable the destructive button. On confirm, the project is removed from `recent_projects` and the ProjectFolder is recursively deleted.
- [x] All lifecycle operations log to `zimesub.log` with operation name + outcome.
- [x] All UI strings Vietnamese.

## Blocked by

- 0011

## Implementation notes

### Files created

- `src/views/project/RenameProjectModal.tsx` — modal launched from the project header "Đổi tên" button. Text field seeded with the current name; submit calls `renameActiveProject` and pivots `activeFolder` to the post-rename path. Surfaces the raw OS error in an inline banner when the folder rename fails (in-use, permission denied, destination collision).
- `src/views/project/RemoveEpisodeModal.tsx` — confirm modal for removing a single Episode. Vietnamese copy verbatim per AC. Backend cancels in-flight jobs for the Episode before deleting the EpisodeFolder.
- `src/views/project/DeleteProjectModal.tsx` — strong two-step confirm. Lists "SẼ BỊ XOÁ" / "KHÔNG BỊ XOÁ" boxes, then requires typing the project name verbatim to enable the destructive button. Backend cancels every in-flight job belonging to this project before recursively removing the folder.

### Files modified

- `src-tauri/src/project_store.rs`
  - `check_source_exists(episodes) -> HashSet<id>` — pure I/O verdict over each Episode's `source_mkv_path`. Drives both the project-open log line and the per-Episode `is_source_missing` flag.
  - `episode_source_is_missing(&EpisodeRecord) -> bool` — single-Episode form, used by the pipeline preflights.
  - `relocate_episode(folder, id, new_path) -> ProjectJson` — atomic rewrite of `source_mkv_path` for one Episode.
  - `rename_project(folder, new_name) -> RenameProjectOutcome` — folder rename first (most failure-prone), then `name` field. Sanitises through `sanitize_folder_name`; rejects when the destination folder already exists.
  - `remove_episode(folder, id) -> ProjectJson` — deletes EpisodeFolder, drops record. Re-inserts the in-memory record if `remove_dir_all` fails so the on-disk and in-memory views stay consistent.
  - `delete_project(folder)` — recursive `fs::remove_dir_all`; idempotent on a missing folder.
  - Test coverage: 11 new unit tests in `project_store::tests` covering happy / missing / sanitisation / preserves-other-Episodes / folder-already-gone cases.
- `src-tauri/src/commands.rs`
  - New commands: `project_missing_sources`, `project_relocate_episode`, `project_rename`, `project_remove_episode`, `project_delete`.
  - `extract_subtitle_start`, `extract_audio_start`, `render_start` — added `episode_source_is_missing` preflight; reject with `"MKV gốc không tìm thấy"` so the UI's race-condition surface (button clicked between the disk check and IPC) still degrades cleanly.
  - `project_open` — logs `lifecycle: <count> Episode(s) flagged MissingSource` so a forensic readback shows which projects booted with overlays.
  - `EpisodeArtifactsView` — added `is_source_missing` field consumed by the JobsStore artifact cache.
  - `project_remove_episode` / `project_delete` — cancel every in-flight job belonging to the affected scope first, then delete; per ADR-0001 SourceMkv files outside the project folder are never touched.
  - `project_rename` — refreshes recents MRU (drops the old path, stamps the new path at the head) so the Sidebar reflects reality immediately.
- `src-tauri/src/lib.rs` — registered the five new commands in the `invoke_handler!`.
- `src/api/projects.ts` — TS bindings for `projectMissingSources`, `projectRelocateEpisode`, `projectRename`, `projectRemoveEpisode`, `projectDelete`. `RenameProjectOutcome` interface mirrors the Rust struct.
- `src/api/extract.ts` — added `is_source_missing` to `EpisodeArtifactsView`.
- `src/api/dialog.ts` — added `pickSingleMkv(title)` for the relocate file picker.
- `src/stores/jobs.ts` — `EpisodeArtifactState.isSourceMissing` field; `applyArtifactSnapshot` propagates the new flag.
- `src/stores/projects.ts` — `relocateEpisode`, `renameActiveProject`, `removeEpisode`, `deleteActiveProject` actions. Each surfaces an accent toast on success + danger toast on failure; modal callers catch the throw to keep the modal open for retry.
- `src/views/project/ProjectView.tsx` — header gains "Đổi tên" + "Xoá project" buttons. Each Episode row gains a `MoreVertical` dropdown ("Đổi đường dẫn MKV…" / "Xoá Episode…") and a red badge + inline "Relocate…" button when `isSourceMissing`. `ActionButton` / `AudioActionButton` accept the new prop and pass it to `disabled` + `title`.
- `src/views/project/render/RenderPanel.tsx` — Render CTA disabled with `MKV gốc không tìm thấy` tooltip when `isSourceMissing`.

### Files deleted

None.

### Verification

- `bun run lint` — clean (forbidden-classes + ESLint).
- `bun run typecheck` — clean.
- `cargo test --lib` — 188 tests pass (49 in `project_store`, including 11 new ones).
- `cargo check --all-targets` — clean.

### Design choices worth noting

- **`is_source_missing` lives on the artefact view, not on `ProjectJson`.** Disk presence is volatile (user can drag the file back at any moment) so we never persist the flag — every `episode_inspect_artifacts` call re-checks. The `project_open` log line is informational only.
- **Preflight in both UI and backend.** The UI disables Extract / Render buttons via the artefact cache; the backend rejects the same commands with `"MKV gốc không tìm thấy"` so a race between the cache and a recent file deletion still produces a clean error instead of a cryptic mkvextract/ffmpeg failure.
- **Job cancellation before destructive operations.** `project_remove_episode` and `project_delete` cancel matching jobs before invoking the filesystem ops so the runner's cleanup pass doesn't fight an active subprocess writing into a folder that's about to be removed.
- **Two-step delete confirm uses a typed name, not just a checkbox.** Matches the PRD AC verbatim and defends against muscle-memory mis-clicks better than a single button.
- **Rename atomic boundary is on the folder rename.** If `fs::rename` fails (in-use lock, permission denied, destination exists) the json is never touched — the user can fix the underlying issue and retry without ending up with a project where the folder name and the json `name` field disagree.
