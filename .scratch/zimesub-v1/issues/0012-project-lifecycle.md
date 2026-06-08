---
title: "Project lifecycle: MissingSource, Relocate, Rename, Remove"
labels: [ready-for-agent]
type: AFK
blocked_by: [0011]
user_stories: [11, 12, 13, 19, 20, 21, 22, 23]
---

# 0012 — Project lifecycle: MissingSource, Relocate, Rename, Remove

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

- [ ] On Project open AND before enqueueing any Job, `project_store::check_source_exists` verifies each Episode's `source_mkv_path` exists on disk. If not, that Episode is flagged with the `MissingSource` overlay.
- [ ] `MissingSource` UI: red badge "MKV gốc không tìm thấy" on the Episode row. `Trích xuất sub`, `Trích xuất audio`, `Render` buttons disabled with tooltip "MKV gốc không tìm thấy". Translate buttons (open folder, draft, paste back, StylePatch) remain enabled.
- [ ] **Relocate** — "Relocate…" button on MissingSource Episodes opens a `.mkv`-filtered file picker. On select, `source_mkv_path` in `zimesub.json` is updated, the overlay clears, `EpisodeState` is re-derived.
- [ ] **Rename Project** — "Đổi tên project" action from the project view header opens a modal with the current name. On submit, the ProjectFolder is renamed (`std::fs::rename`) and the `name` field in `zimesub.json` is updated. If folder rename fails (e.g. permission, in-use), the json is NOT updated and the user sees the OS-level error.
- [ ] **Remove Episode** — action available on each Episode row (e.g. via row dropdown menu). Opens a confirm modal "Xoá Episode '<folder_name>'? EpisodeFolder và toàn bộ artifact bên trong sẽ bị xoá. File MKV gốc không bị đụng tới." On confirm, EpisodeFolder is deleted and the `episodes` array in json is filtered.
- [ ] **Delete Project** — action from the project view's settings menu. Strong two-step confirm modal listing what will be deleted (ProjectFolder content) and what will NOT (SourceMkv files outside it). Confirmation requires typing the project name verbatim to enable the destructive button. On confirm, the project is removed from `recent_projects` and the ProjectFolder is recursively deleted.
- [ ] All lifecycle operations log to `zimesub.log` with operation name + outcome.
- [ ] All UI strings Vietnamese.

## Blocked by

- 0011
