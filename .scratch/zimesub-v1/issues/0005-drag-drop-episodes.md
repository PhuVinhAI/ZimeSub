---
title: "Drag-drop MKV → Episodes (full-window overlay)"
labels: [ready-for-agent]
type: AFK
blocked_by: [0004]
user_stories: [14, 15, 16, 17, 18]
---

# 0005 — Drag-drop MKV → Episodes (full-window overlay)

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

With a Project open, the user can drag MKV files onto the app window. A full-window overlay appears during drag. On drop, each MKV becomes an `Episode`: a new `EpisodeFolder` is created in the `ProjectFolder` (named by sanitized MKV basename per [`CONTEXT.md`](../../../CONTEXT.md)), `zimesub.json` is updated, rows appear in the Episode list. An "Thêm Episode…" alternative button uses the native multi-file picker. Non-MKV files are rejected. `SourceMkv` files are never moved or copied — only referenced by absolute path (ADR-0001).

## Acceptance criteria

- [ ] A full-window overlay renders when the OS reports a file drag entering the window with a Project open: semi-opaque `bg` ~0.92 alpha + 3 px dashed `accent` border inset 24 px + centered Vietnamese label "Thả file MKV vào đây để thêm Episode". Overlay disappears on drop, dragleave, or Esc.
- [ ] On drop, each file is validated by extension: `.mkv` accepted; anything else surfaces a red toast "Chỉ chấp nhận file .mkv" and is skipped (without aborting valid siblings in the same drop).
- [ ] For each accepted file: a new Episode is appended to `zimesub.json` with
  - `id: uuid v4`
  - `source_mkv_path: <absolute path of source MKV, untouched>`
  - `folder_name: <sanitized basename>` (replace Windows-reserved chars `: < > | " \ / ? *` with `_`)
  - `selected_subtitle_track_id: null`
  - `render_config_override: null`
- [ ] A real subfolder with `folder_name` is created inside the `ProjectFolder`. Empty initially.
- [ ] "Thêm Episode…" button in the project view opens `tauri-plugin-dialog`'s multi-file picker filtered to `.mkv`. Selected files follow the same import flow.
- [ ] Episode list shows rows in the Main view: folder name (clipped on overflow, full path on hover), `source_mkv_path` (muted text), state badge "Trống" (Empty) since no artifacts yet.
- [ ] Adding a `source_mkv_path` that already exists in the same Project surfaces a yellow toast "Episode này đã có trong project"; no duplicate is created.
- [ ] All UI strings Vietnamese.

## Blocked by

- 0004
