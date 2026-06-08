---
title: "Create Project + persist zimesub.json + recent list"
labels: [ready-for-agent]
type: AFK
blocked_by: [0001]
user_stories: [8, 9, 10, 65, 66]
---

# 0004 — Create Project + persist zimesub.json + recent list

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

User can create a new `Project` from the Sidebar by entering a name and choosing a `ProjectFolder`. The app creates `zimesub.json` with schema version 1 (name, `created_at`, empty `episodes`, `default_render_config` with `encoder: "auto"`, `default_extract_audio`). The folder path is appended to `recent_projects` in app settings. Opening a recent project loads the json. Sidebar lists recent projects with the active one highlighted by a 3 px accent left border.

This slice can be developed in parallel with the tool-gate slices (0002, 0003) — it only depends on the shell from 0001.

## Acceptance criteria

- [ ] "＋ Tạo project" CTA in the Sidebar opens a modal: text field for project name (required, non-empty), "Chọn thư mục" button using `tauri-plugin-dialog`'s folder picker.
- [ ] On submit:
  - If the folder is non-empty and does NOT already contain `zimesub.json`, modal shows error "Thư mục đã có file khác".
  - If the folder already has `zimesub.json`, modal offers "Mở project hiện có" instead of "Tạo".
  - Otherwise, create.
- [ ] On successful create, `zimesub.json` is written with:
  - `version: 1`
  - `name`
  - `created_at` — ISO 8601 with timezone
  - `episodes: []`
  - `default_render_config` and `default_extract_audio` populated with the PRD defaults
- [ ] `recent_projects` in app settings is updated (append, dedupe, cap at 20).
- [ ] Sidebar shows the recent projects list (most recent first), each row showing project name + relative last-opened time. Active project has a 3 px `accent` left border.
- [ ] Clicking a recent project opens it: loads `zimesub.json`, shows project name as Main view heading, Episode list empty state "Thả file MKV vào đây để thêm Episode".
- [ ] If a recent project's folder or `zimesub.json` is missing, the row is shown with a danger badge "Không tìm thấy" + "Gỡ khỏi danh sách" button.
- [ ] After Onboarding gate clears on app launch, if `recent_projects` is non-empty, auto-open the most recent. Otherwise show the empty state.
- [ ] All UI strings Vietnamese.

## Blocked by

- 0001
