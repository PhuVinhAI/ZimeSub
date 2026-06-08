---
title: "Drag-drop MKV → Episodes (full-window overlay)"
labels: [done]
type: AFK
blocked_by: [0004]
user_stories: [14, 15, 16, 17, 18]
status: done
---

# 0005 — Drag-drop MKV → Episodes (full-window overlay)

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## Status

**Done.** `cargo check --all-targets`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib` (39 tests passing — 28 existing + 5 new `sanitize_folder_name` tests + 6 new `add_episodes` tests covering happy path, case-insensitive duplicate skip, no-op manifest write when all duplicates, partial batch with mixed accept/skip, error on missing project, basename strip + reserved-char sanitisation), `bun run lint` (lint:classes + eslint), `bun run typecheck`, and `prettier --check` on the touched files all green. Verified on 2026-06-08.

## What to build

With a Project open, the user can drag MKV files onto the app window. A full-window overlay appears during drag. On drop, each MKV becomes an `Episode`: a new `EpisodeFolder` is created in the `ProjectFolder` (named by sanitized MKV basename per [`CONTEXT.md`](../../../CONTEXT.md)), `zimesub.json` is updated, rows appear in the Episode list. An "Thêm Episode…" alternative button uses the native multi-file picker. Non-MKV files are rejected. `SourceMkv` files are never moved or copied — only referenced by absolute path (ADR-0001).

## Acceptance criteria

- [x] A full-window overlay renders when the OS reports a file drag entering the window with a Project open: semi-opaque `bg` ~0.92 alpha + 3 px dashed `accent` border inset 24 px + centered Vietnamese label "Thả file MKV vào đây để thêm Episode". Overlay disappears on drop, dragleave, or Esc.
- [x] On drop, each file is validated by extension: `.mkv` accepted; anything else surfaces a red toast "Chỉ chấp nhận file .mkv" and is skipped (without aborting valid siblings in the same drop).
- [x] For each accepted file: a new Episode is appended to `zimesub.json` with
  - `id: uuid v4`
  - `source_mkv_path: <absolute path of source MKV, untouched>`
  - `folder_name: <sanitized basename>` (replace Windows-reserved chars `: < > | " \ / ? *` with `_`)
  - `selected_subtitle_track_id: null`
  - `render_config_override: null`
- [x] A real subfolder with `folder_name` is created inside the `ProjectFolder`. Empty initially.
- [x] "Thêm Episode…" button in the project view opens `tauri-plugin-dialog`'s multi-file picker filtered to `.mkv`. Selected files follow the same import flow.
- [x] Episode list shows rows in the Main view: folder name (clipped on overflow, full path on hover), `source_mkv_path` (muted text), state badge "Trống" (Empty) since no artifacts yet.
- [x] Adding a `source_mkv_path` that already exists in the same Project surfaces a yellow toast "Episode này đã có trong project"; no duplicate is created.
- [x] All UI strings Vietnamese.

## Blocked by

- 0004

## Implementation notes

The slice splits cleanly along the existing thin-command pattern from 0004: pure Rust logic in `project_store.rs`, one new Tauri command (`project_add_episodes`) wrapping it, a TS mirror in `api/projects.ts`, and three frontend pieces — `DropOverlay`, `ToastStack` + toast store, and the Episode-list rewrite of `ProjectView`. No new Tauri capabilities were needed: the dialog plugin (already wired in 0004) supports the multi-file picker via its existing permission set, and Tauri's `dragDropEnabled: true` window flag (set in 0001) routes drag events through the standard `getCurrentWebview().onDragDropEvent` callback without any extra ACL.

`project_store::sanitize_folder_name` is a pure character-substitution routine: it replaces the Windows-reserved set `: < > | " \ / ? *` plus all ASCII control characters with `_`, then trims trailing dots and spaces (NTFS refuses to create folders ending in either — an undocumented quirk that surfaces as a cryptic `CreateDirectory` failure if you skip the trim). Empty or all-replaced inputs fall back to the literal string `"episode"` so we never hand `create_dir_all` an empty path. Square brackets, dashes, and unicode round-trip unchanged because anime release groups (e.g. `[Erai-raws]`) and Vietnamese filenames depend on them — the rule strictly targets the platform-illegal set, not the "looks weird" set. Five fixture-driven unit tests document each branch.

`add_episodes` is the batch entry point that drag-drop and the multi-file picker both call. It opens the project (mapping a missing manifest to the same `NotAProject` error variant the Sidebar already understands), builds a case-insensitive lookup of the existing `source_mkv_path` set, and then loops through the input list — appending an `EpisodeRecord` and `create_dir_all`'ing the EpisodeFolder for each non-duplicate, accumulating duplicates into a separate `Vec<String>` for the UI to surface as yellow toasts. Three deliberate properties matter:

- **Atomic-ish batch**: the manifest is rewritten via the same `tmp + rename` dance as `create_project`, but only after the in-memory vector has all new entries. A panic mid-loop never produces a partial manifest write; on-disk EpisodeFolders that were created before the panic are harmless empties.
- **No write when nothing changed**: if every input is a duplicate, the manifest is left untouched (no mtime tick, no atomic rename). This matters because the slice 0004 recents MRU is keyed by mtime hints in the future, and we don't want a "noop drag" to bump it.
- **Case-insensitive duplicate detection**: Windows file systems are case-insensitive, so `C:\foo\X.mkv` and `c:\Foo\X.MKV` reference the same physical file. Lower-cased comparison mirrors the Sidebar `pathsEqual` helper from 0004.

Six unit tests cover the happy path (records + folders both created, project state returned), the case-insensitive duplicate skip, the no-write-when-all-duplicates property (verified by capturing the manifest's mtime), partial batches that mix accepted + duplicate inputs, the missing-project error path, the basename-without-`.mkv` extraction, and the reserved-char sanitisation flowing through to the on-disk folder.

`basename_without_mkv_ext` is a small helper that strips the `.mkv` (case-insensitive) extension from the path's basename. It does not strip arbitrary extensions — non-MKV input passes through to the sanitiser, which is the safety net for the (theoretically impossible) case where a non-MKV path slips past the frontend filter and through the Tauri command boundary.

`AddEpisodesOutcome` is the new return type that surfaces all three pieces the UI needs in one round-trip: the post-write `ProjectJson` (so the store can swap `active` without a second `project_open`), the `added_count` for any future toast/log line, and the `duplicates: Vec<String>` so the toast stack pushes one yellow card per skipped path. The PRD didn't spell this contract out — designing it explicitly keeps the IPC surface narrow (one command call per drop, even with mixed accept/skip outcomes).

The `uuid` crate is added with the `v4` and `serde` features. `v4` is the AC's stipulated id form; `serde` lets `Uuid::new_v4().to_string()` flow through the existing `EpisodeRecord` serde impl without any custom code. Backend cargo deps are touched only here; the frontend never sees `Uuid` as a typed value because the boundary serialises everything to strings.

The frontend wiring lives in three layers. **Toast infrastructure**: `lib/toast/toastStore.ts` is a tiny `createStore`-backed signal stack with `pushToast(tone, message, durationMs?)` plus convenience wrappers (`pushDangerToast`, `pushWarnToast`, `pushAccentToast`); auto-dismiss is per-entry via `setTimeout`, and `dismissToast(id)` is idempotent so a stale id from an already-fired timer is a safe no-op. `design-system/ToastStack.tsx` renders a fixed top-right column subscribed to the store, using the same three tones as `StatusBadge` (`accent` / `warn` / `danger`) so the toast palette stays in lockstep with the rest of the design system. The stack is mounted by `AppShell` so it's visible in every gate (Onboarding, Empty, Project) — slice 0005 uses it for drag-drop feedback, but later slices (job failures, render staleness, etc.) get it for free.

**Drag-drop subscription**: `AppShell` binds `getCurrentWebview().onDragDropEvent` inside a `createEffect` so the listener is owned by the component lifetime — `onCleanup` calls the unlisten fn on unmount/HMR. The handler reads `allReady() && projectsStore.active !== null` live on each event so dragging during Onboarding (or before a project is open) is silently ignored, with a defensive flip-to-hidden if the overlay was visible from a previous valid project that the user has since closed. Tauri's `DragDropEvent` discriminator is enumerated explicitly: `enter`/`over` flip the overlay on, `leave` flips it off, `drop` flips it off and forwards `payload.paths` to `addEpisodes`.

**The overlay component itself** (`components/drop-overlay/DropOverlay.tsx`) renders the spec from `docs/style-guide.md` § "Drag & drop" verbatim: a `bg-bg/92` semi-opaque backdrop, a 3 px `border-dashed border-accent` rectangle inset 24 px, and a centered Vietnamese label with a `FilePlus2` Lucide icon. `pointer-events-none` keeps the overlay non-interactive — the OS still owns the drag operation, so any consumed pointer event would risk swallowing the drop. Esc dismissal is handled through the existing `modalStack` mechanism: while the overlay is visible, a `pushModal(closeFn)` entry sits on the stack, so the global `Escape` shortcut (already installed in `globalShortcuts.ts`) calls `closeTopModal()` which fires our `onDismiss`. This avoids registering a parallel `Escape` binding (the registry's "latest registration wins" rule would otherwise shadow modal Escape handling for any modal opened during drag).

`stores/projects.ts` grows two new exports — `partitionMkvPaths` and `addEpisodes`. `partitionMkvPaths` is the AC's per-file extension validator: a pure function that splits a flat path list into `accepted` / `rejected` (where `rejected` is the basenames, not full paths, because the toast text shouldn't leak absolute paths the user may not want flashed across the screen). `addEpisodes` is the unified action that both the `DropOverlay`'s drop handler and `ProjectView`'s "Thêm Episode…" button invoke: it filters via `partitionMkvPaths`, fires one red toast per rejected basename, calls the backend if any accepted paths remain, swaps `state.active` with the post-write project, fires one yellow toast per duplicate the backend reports, and surfaces backend errors as a final red toast. Valid siblings are NOT aborted on a sibling rejection — that's the AC's "without aborting valid siblings in the same drop" requirement, satisfied because we collect all rejections, push toasts for them, then proceed to the backend with whatever survived the filter.

`ProjectView` is rewritten to host the Episode list. The empty-state retains its slice-0004 prompt ("Thả file MKV vào đây để thêm Episode") for the moment before the first add — but the muted note is updated to point users to the "Thêm Episode…" button as the keyboard alternative. Once `episodes.length > 0`, the empty card is replaced by a `<ul>` of `EpisodeRow` cards inside a 2 px outer border, each row showing the folder name (truncated, full source path on hover via `title`), the `source_mkv_path` in mono with the same hover behaviour, and a `StatusBadge tone="accent">Trống</StatusBadge>` per the AC. The badge will be replaced by a derived `EpisodeState` in slices 0006+; for now every freshly-added Episode is `Empty` because no pipeline artefacts exist yet. The "Thêm Episode…" button lives in the Episode-list section header and uses the existing `Button variant="secondary"` primitive — its handler delegates to `pickMkvFiles` (a new helper in `api/dialog.ts`) which calls the dialog plugin's `open({ multiple: true, filters: [{ name: 'MKV video', extensions: ['mkv'] }] })`, then forwards the returned array to `addEpisodes` for the same partition + backend round-trip the drag-drop path uses. The button is disabled while a picker dialog is open so a double-click can't fire two pickers in parallel.

`api/dialog.ts` gets `pickMkvFiles(title)` returning `Promise<string[]>` — `null` (cancel) and a non-array (single selection in unexpected shapes) both normalise to `[]`. The single-folder picker (`pickFolder`) keeps its prior shape so `CreateProjectModal` is untouched.

The Tauri capability set is unchanged — `dialog:default` and `dialog:allow-open` (added in 0004) are sufficient. No `fs` permission added; every filesystem mutation continues to flow through Rust commands so the JS-side FS attack surface stays at zero.

### Files created

| File | Purpose |
|---|---|
| `src/lib/toast/toastStore.ts` | Solid `createStore`-backed transient toast stack with auto-dismiss timers. Exports `pushToast`, `pushDangerToast`, `pushWarnToast`, `pushAccentToast`, `dismissToast`, `clearToasts`, plus the `ToastTone` type alias mirroring `StatusBadge` tones. |
| `src/design-system/ToastStack.tsx` | Top-right transient-message stack subscribed to `toastStore`. Three tones use 2 px borders + matching Lucide icons (`AlertCircle` / `AlertTriangle` / `CheckCircle2`). `aria-live="assertive"` so screen readers announce errors immediately. Mounted at the `AppShell` root so every gate has access. |
| `src/components/drop-overlay/DropOverlay.tsx` | Full-window drag overlay: `bg-bg/92` backdrop + 3 px dashed `accent` border inset 24 px + centered Vietnamese label per `docs/style-guide.md`. Esc dismissal wired through the existing `modalStack` so it cohabits with modal Escape handling. `pointer-events-none` keeps the OS in charge of the drag operation. |

### Files modified

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Added `uuid = { version = "1.13.1", features = ["v4", "serde"] }` for `EpisodeRecord.id`. |
| `src-tauri/src/project_store.rs` | New pure `sanitize_folder_name` (replaces Windows-reserved chars `: < > \| " \\ / ? *` + ASCII control chars with `_`; trims trailing dots/spaces; `"episode"` fallback for empty input). New `basename_without_mkv_ext` helper. New `AddEpisodesOutcome` struct. New `add_episodes(folder, source_paths)` function that opens the project, deduplicates against existing source paths case-insensitively, creates an EpisodeFolder per accept, appends `EpisodeRecord` rows with uuid v4 ids, atomically rewrites `zimesub.json` only when at least one Episode was added. 11 new unit tests (5 sanitiser branches, 6 add-episodes scenarios). Doc-comments updated to reflect slice 0005 surface. |
| `src-tauri/src/commands.rs` | Added `project_add_episodes(folder, source_paths) -> AddEpisodesOutcome` command (thin glue over `project_store::add_episodes`, mapping `ProjectError` to `String`). |
| `src-tauri/src/lib.rs` | Registered `commands::project_add_episodes` in the `invoke_handler!` macro. |
| `src-tauri/Cargo.lock` | Lockfile updates for `uuid` + its `getrandom` dependency. |
| `src/api/projects.ts` | Added `AddEpisodesOutcome` interface (TS mirror of the new Rust struct) and `projectAddEpisodes(folder, sourcePaths) -> Promise<AddEpisodesOutcome>` invoke binding. |
| `src/api/dialog.ts` | Added `pickMkvFiles(title) -> Promise<string[]>` — dialog plugin's `open({ multiple: true, filters: [{ name: 'MKV video', extensions: ['mkv'] }] })`, normalising `null` / single-string returns to `[]` / `[s]` so the caller never has to discriminate the union. |
| `src/stores/projects.ts` | Added `partitionMkvPaths(paths) -> {accepted, rejected}` (AC's per-file `.mkv` extension filter, returning rejected basenames so the toast text never leaks absolute paths) and `addEpisodes(paths)` action that surfaces red toasts per non-MKV, calls the backend if any accepted paths remain, swaps `active`, surfaces yellow toasts per duplicate, and red-toasts backend errors. Imports the new toast store helpers. |
| `src/components/shell/AppShell.tsx` | Added `dragOverlayVisible` signal and a `createEffect` that subscribes to `getCurrentWebview().onDragDropEvent` for the AppShell lifetime. Handler ignores events when `!allReady() || !projectsStore.active`, defensively clears stale overlay state on the no-op path, and dispatches on the four event variants (`enter`/`over` → show, `leave` → hide, `drop` → hide + forward `paths` to `addEpisodes`). Mounts the new `DropOverlay` inside the `allReady()` Match arm and the `ToastStack` outside the gate so toasts appear in every state. |
| `src/views/project/ProjectView.tsx` | Replaced the slice-0004 placeholder with: section header that reads `EPISODES · N` plus a "Thêm Episode…" `Button` calling `pickMkvFiles` → `addEpisodes`; an Episode list `<ul>` of `EpisodeRow` cards (folder name truncated with full path on hover title, `source_mkv_path` in mono, `StatusBadge tone="accent">Trống</StatusBadge>`); the `EpisodeListEmpty` empty-state retained for the pre-first-add view, with its hint updated to point at the new button as the keyboard alternative. |

### Files deleted

None.
