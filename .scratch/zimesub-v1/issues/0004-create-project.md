---
title: "Create Project + persist zimesub.json + recent list"
labels: [done]
type: AFK
blocked_by: [0001]
user_stories: [8, 9, 10, 65, 66]
status: done
---

# 0004 — Create Project + persist zimesub.json + recent list

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## Status

**Done.** `cargo check --all-targets`, `cargo clippy --lib --all-targets --no-deps -- -D warnings`, `cargo test --lib` (28 tests passing — 18 existing + 6 new `settings_store` recents-MRU tests + 4 new `project_store` schema/inspect tests + 6 new `project_store` create/open round-trip tests), `bun run lint` (lint:classes + eslint), `bun run typecheck`, and `bun run build` all green. Verified on 2026-06-08.

## What to build

User can create a new `Project` from the Sidebar by entering a name and choosing a `ProjectFolder`. The app creates `zimesub.json` with schema version 1 (name, `created_at`, empty `episodes`, `default_render_config` with `encoder: "auto"`, `default_extract_audio`). The folder path is appended to `recent_projects` in app settings. Opening a recent project loads the json. Sidebar lists recent projects with the active one highlighted by a 3 px accent left border.

This slice can be developed in parallel with the tool-gate slices (0002, 0003) — it only depends on the shell from 0001.

## Acceptance criteria

- [x] "＋ Tạo project" CTA in the Sidebar opens a modal: text field for project name (required, non-empty), "Chọn thư mục" button using `tauri-plugin-dialog`'s folder picker.
- [x] On submit:
  - If the folder is non-empty and does NOT already contain `zimesub.json`, modal shows error "Thư mục đã có file khác".
  - If the folder already has `zimesub.json`, modal offers "Mở project hiện có" instead of "Tạo".
  - Otherwise, create.
- [x] On successful create, `zimesub.json` is written with:
  - `version: 1`
  - `name`
  - `created_at` — ISO 8601 with timezone
  - `episodes: []`
  - `default_render_config` and `default_extract_audio` populated with the PRD defaults
- [x] `recent_projects` in app settings is updated (append, dedupe, cap at 20).
- [x] Sidebar shows the recent projects list (most recent first), each row showing project name + relative last-opened time. Active project has a 3 px `accent` left border.
- [x] Clicking a recent project opens it: loads `zimesub.json`, shows project name as Main view heading, Episode list empty state "Thả file MKV vào đây để thêm Episode".
- [x] If a recent project's folder or `zimesub.json` is missing, the row is shown with a danger badge "Không tìm thấy" + "Gỡ khỏi danh sách" button.
- [x] After Onboarding gate clears on app launch, if `recent_projects` is non-empty, auto-open the most recent. Otherwise show the empty state.
- [x] All UI strings Vietnamese.

## Blocked by

- 0001

## Implementation notes

The backend grows by one Rust module (`project_store`) and five Tauri commands (`project_inspect_folder`, `project_create`, `project_open`, `project_list_recents`, `project_remove_recent`). The thin command layer pattern from slices 0002/0003 is preserved — every command locks `AppState.settings`, delegates to `project_store`, persists settings atomically when `recent_projects` is touched, and maps typed `ProjectError` variants into the `Result<_, String>` shape the IPC bridge serialises. The new module ships with 11 unit tests (folder inspection verdicts, name-trimming + validation, PRD-default round-trip, error mapping) using `std::env::temp_dir()` for isolated per-test directories — no test framework is added beyond the standard library, matching the prior-art style from `tooling.rs` and `install.rs`.

`settings_store::Settings` gains one new field — `recent_projects: Vec<RecentProject>` where each entry is `{path, last_opened}`. The PRD's settings schema example showed plain path strings, but the AC requires showing "relative last-opened time" per row, so the field is extended to objects within the same key. Forward-compatible load is preserved by `#[serde(default)]` (a legacy settings file without the key still loads cleanly — verified by `settings_loads_without_recent_projects_field`). Move-to-front insertion + dedupe + cap-at-20 lives on `Settings::touch_recent_project` so both the create and open paths share the same logic. Path comparison is `eq_ignore_ascii_case` because Windows file systems are case-insensitive — without it the same folder accessed as `C:\foo` and `c:\Foo` would produce duplicate Sidebar rows.

`project_store::ProjectJson` mirrors the PRD `zimesub.json` schema field-for-field, with struct declaration order driving the JSON output order so hand-inspecting the file matches the documented example. `default_render_config` defaults to `encoder="auto"` (the EncoderProbe priority list resolves it at render time in slice 0011), `quality=65`, `audio_codec="aac"`, `audio_bitrate_kbps=192`; `default_extract_audio` defaults to `codec="libmp3lame"`, `quality_or_bitrate="q:a 2"`. `EpisodeRecord` is defined now (with all PRD fields) even though the array is always `[]` on create, so slice 0005's drag-drop just pushes into an existing-typed vector instead of retrofitting the schema.

`inspect_folder` is the workhorse for the three-way modal CTA decision. A folder that does not exist on disk is treated as `is_empty: true` so the create path can `create_dir_all` it. When the folder hosts a `zimesub.json`, the inspection eagerly reads the project name so the modal previews it (the name input flips to read-only with that value). The non-empty-without-manifest case is reported via the flag combo, not an error, so the frontend can render an inline message without unwrapping a typed exception. `create_project` does its own re-check (defence in depth) — even though the modal routes around the "has manifest" case to the open path, a direct backend invocation never stomps an existing file.

`created_at` uses `chrono::Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)` — local timezone with an explicit `±HH:MM` offset (not `Z`) to match the PRD example (`2026-06-08T15:00:00+07:00`). Same format used for `last_opened` so the two timestamps round-trip cleanly through the same parser.

`zimesub.json` is written via the same atomic tmp + rename dance as `settings.json` — `<basename>.json.tmp` is staged with the serialised JSON, then renamed over the destination. A mid-write crash never leaves a half-flushed manifest, which is critical because losing `zimesub.json` is unrecoverable (the PRD's CONTEXT.md spells this out: the app cannot rebuild the SourceMkv path mapping from folder structure alone).

The frontend grows a new `stores/projects` Solid store, two `api/` modules (`projects.ts`, `dialog.ts`), and a `views/project/` folder. The store mirrors the existing `stores/tools` patterns: a `createStore` with a `phase` discriminator (`idle | loading | loaded | error`), idempotent bootstrap, and explicit action functions. `bootstrapActiveProject` runs once after the Onboarding gate clears (driven by a `createEffect(on(() => allReady(), ...))` from `AppShell` so the trigger is pure-Solid). It refreshes the recents list, then auto-opens the most recent entry whose folder + manifest both exist on disk — missing rows stay visible in the Sidebar with their "Không tìm thấy" badge so the user can fix or remove them.

`CreateProjectModal` uses the existing `Modal` design-system primitive (which auto-registers in the modal stack so the global `Escape` shortcut pops it). The folder picker is wired through a small `api/dialog.ts` wrapper over `@tauri-apps/plugin-dialog`'s `open({ directory: true })`. The modal state machine tracks `name`, `folder`, `inspection`, `inspecting`, `submitting`, and `submitError` as independent signals; the CTA label toggles between "Tạo project" and "Mở project hiện có" depending on `inspection.has_zimesub_json`, and the name input flips to read-only showing the existing project's name when opening. Inline messages cover all four inspection states — empty/missing/has-manifest/blocked — using bordered status bars (`accent` / `border` / `danger`) consistent with the style guide's flat-dark + electric-green aesthetic.

`Sidebar` is rewritten to render the live `projectsStore.recents` list. Each row is a `<button>` with: project name (or last path segment as fallback), the relative "vừa mở / X phút trước / X giờ trước / X ngày trước / X tuần trước / DD/MM/YYYY" formatted by the tiny new `lib/time.ts` helper, and a 3 px accent left border applied via `border-l-[3px] border-l-accent` when the row matches `projectsStore.activeFolder`. Missing rows get a `StatusBadge tone="danger"` ("Không tìm thấy") plus an inline "Gỡ khỏi danh sách" affordance (a focusable span styled as a small chip — keeping the outer `<button>` semantics simple while still being keyboard-reachable). The "Tạo project" CTA is enabled and bound to `setCreateProjectOpen(true)` lifted in `AppShell`.

`ProjectView` is the new Main-view content shown when `projectsStore.active` is set. It renders the project name as the page heading, the absolute folder path in mono below it, and an Episode-list empty state with the AC string "Thả file MKV vào đây để thêm Episode". The drag-drop overlay + actual Episode list land in slice 0005; today the placeholder also calls that out in muted mono text so the next-slice scope is obvious to a tester.

`Ctrl+N` is bound at the `AppShell` level via the existing `useKeyboardShortcut` composable from slice 0001's keyboard scaffold, gated on `allReady()` so it never fires while Onboarding is showing. The binding lives on the component (not the global installer) so Solid's HMR disposes it cleanly on edit.

Two new Tauri capabilities — `dialog:default` and `dialog:allow-open` — are the minimum permission surface for the folder picker. All filesystem operations happen in Rust commands (which have full `std::fs` access by virtue of running in the host process), so `tauri-plugin-fs` and its `core:fs:default` capability are intentionally NOT added in this slice. That keeps the JS-side FS attack surface to zero — every `zimesub.json` read/write is mediated by a typed command that validates intent.

`Settings` previously had no in-memory mutation API beyond direct field access; this slice introduces `touch_recent_project` / `remove_recent_project` so the commands layer stays terse and the move-to-front logic is one canonical implementation (rather than once per command).

### Files created

| File | Purpose |
|---|---|
| `src-tauri/src/project_store.rs` | New module owning the `zimesub.json` schema, `FolderInspection`, `create_project` / `open_project` / `inspect_folder`, `peek_project_name`, atomic tmp+rename writes, ISO 8601 timestamping. 11 unit tests covering empty/missing/non-empty folder inspection, PRD-default round-trip, name-trim + validation, refusal to stomp existing manifests, open-roundtrip, RFC 3339 format. |
| `src/api/projects.ts` | TS mirror of the Rust project schemas (`RenderConfig`, `ExtractAudioConfig`, `EpisodeRecord`, `ProjectJson`, `FolderInspection`, `RecentProjectStatus`) + invoke bindings for the 5 new Tauri commands. |
| `src/api/dialog.ts` | Thin wrapper over `@tauri-apps/plugin-dialog`'s `open({ directory: true })` returning `string \| null`. |
| `src/lib/time.ts` | Allocation-light Vietnamese relative-time formatter (`vừa mở` / `N phút trước` / `N giờ trước` / `N ngày trước` / `N tuần trước` / `DD/MM/YYYY`). Used by the Sidebar recents rows. |
| `src/stores/projects.ts` | Solid store + actions (`bootstrapActiveProject`, `openProjectByPath`, `createNewProject`, `removeRecent`, `closeActiveProject`, `refreshRecents`). Phase discriminator + active project + recents list. |
| `src/views/project/CreateProjectModal.tsx` | Modal opened by the Sidebar CTA: name input (required, read-only when opening existing), folder picker, three-way inspection result banner, dynamic CTA label ("Tạo project" vs "Mở project hiện có"), inline error pipeline. |
| `src/views/project/ProjectView.tsx` | Main-view content when a project is active: heading + folder path + episode-list empty state with the AC's drag-drop prompt placeholder. |

### Files modified

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Added `tauri-plugin-dialog = "2"`. |
| `src-tauri/Cargo.lock` | Lockfile updates for `tauri-plugin-dialog` + its `rfd` / `tauri-plugin-fs` / `windows-sys` graph. |
| `src-tauri/src/lib.rs` | Registers the new `project_store` module, the `tauri_plugin_dialog::init()` plugin, and the 5 new Tauri commands. |
| `src-tauri/src/commands.rs` | Adds `project_inspect_folder`, `project_create`, `project_open`, `project_list_recents`, `project_remove_recent`, plus a shared `touch_recent_and_save` helper. |
| `src-tauri/src/settings_store.rs` | Extends `Settings` with `recent_projects: Vec<RecentProject>`, the `RecentProject` struct, `RECENT_PROJECTS_CAP = 20`, `touch_recent_project` (move-to-front + dedupe + cap, case-insensitive on Windows paths) and `remove_recent_project`. 6 unit tests covering insert/move-to-front/dedupe/cap/case-insensitivity/serde round-trip + legacy-load. |
| `src-tauri/capabilities/default.json` | Added `dialog:default` and `dialog:allow-open` permissions for the folder picker. No `fs` permission added — all filesystem operations are mediated by Rust commands. |
| `package.json` | Added `@tauri-apps/plugin-dialog` ^2.7.1. |
| `bun.lockb` | Updated for the new dialog plugin dependency. |
| `src/components/shell/AppShell.tsx` | Adds `createProjectOpen` signal + `Ctrl+N` binding, mounts `CreateProjectModal`, runs `bootstrapActiveProject` via `createEffect(on(allReady, ...))` once the Onboarding gate clears, swaps `EmptyProjectsState` for `ProjectView` whenever `projectsStore.active` is set. |
| `src/components/shell/Sidebar.tsx` | Replaces the empty `PROJECTS` placeholder with the live recents list. Each row renders project name + relative last-opened time, applies the 3 px accent left border for the active row, shows a `Không tìm thấy` danger badge + `Gỡ khỏi danh sách` chip for missing rows. CTA is now bound to `props.onCreateProject`. |
| `src/lib/keyboard/globalShortcuts.ts` | Doc-comment update reflecting that `Ctrl+N` now lives on the `AppShell` component rather than in this boot-time installer. |

### Files deleted

None.
