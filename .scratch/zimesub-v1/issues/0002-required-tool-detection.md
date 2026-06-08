---
title: "RequiredTool detection + Onboarding gate view"
labels: [done]
type: AFK
blocked_by: [0001]
user_stories: [1, 4, 7, 67]
status: done
---

# 0002 — RequiredTool detection + Onboarding gate view

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## Status

**Done.** `cargo check`, `cargo clippy --lib --all-targets --no-deps -- -D warnings`, `cargo test --lib` (7 tests passing), `bun run lint` (lint:classes + eslint), and `bun run typecheck` all green. Verified on 2026-06-08.

## What to build

When the app starts, detect whether `mkvmerge`, `mkvextract`, and `ffmpeg` are installed at acceptable versions per [ADR-0002](../../../docs/adr/0002-tooling-via-winget.md). If any are Missing or Outdated, show an Onboarding view that gates the rest of the app. If all three are Ready, fall through to the empty Main view from slice 0001. Tool paths + versions cache to `%APPDATA%\ZimeSub\settings.json`.

This slice does NOT install tools — it only detects and displays. Install lands in 0003.

Also bootstraps the app-level log file infrastructure since this is the first slice that writes logs.

## Acceptance criteria

- [x] A detection routine probes each `RequiredTool`: try via `PATH` (e.g. via the `which` crate), fall back to the Windows default install path (e.g. `C:\Program Files\MKVToolNix\mkvmerge.exe`). On success, record absolute path + version parsed from `--version` stdout.
- [x] Version floors enforced: `ffmpeg ≥ 4.0`, `MKVToolNix ≥ 60.0`. Below floor → `Outdated`. Not found → `Missing`. Found and ≥ floor → `Ready`.
- [x] On app start, detection runs once and results are cached to settings.json. Cached results are reused on subsequent launches; cache is invalidated if a cached absolute path no longer exists on disk.
- [x] Onboarding view shows a single panel listing the 3 RequiredTool rows. Each row: tool name, status badge (`Ready` accent / `Outdated` warn with current+minimum / `Missing` danger), and resolved absolute path when known.
- [x] Onboarding view fully covers the Main app. Sidebar items, drag-drop, and project actions are inaccessible while gating. Bottom status bar is hidden during Onboarding.
- [x] When all 3 are `Ready`, the app skips Onboarding and shows the empty Projects state from slice 0001.
- [x] A "Quét lại" button on Onboarding re-runs detection and updates the UI.
- [x] App-level log file (`%APPDATA%\ZimeSub\logs\zimesub.log`, rotated 5 × 2 MB) is initialised at app start. Detection results and errors are logged.
- [x] All UI strings Vietnamese.

## Blocked by

- 0001

## Implementation notes

The backend grows from 2 Rust files to 6: a `paths` helper centralises `%APPDATA%\ZimeSub\` resolution, `logging` owns a custom size-rotating `tracing_subscriber::MakeWriter` (the `tracing-appender` crate ships time-based rotation only, not size-based), `settings_store` persists the PRD's `settings.json` schema (currently only `tool_paths` + `tool_versions` — the other fields land slice-by-slice), `tooling` does the cache-aware probe per tool, and `commands` exposes a thin Tauri command surface (`tool_probe`, `tool_rescan`) over a single `Mutex<Settings>` managed via `tauri::State`.

Version parsing is regex-free: a small character-by-character walker extracts the leading `MAJOR.MINOR(.PATCH)?` from the first line of each tool's `--version` output. This handles all three observed shapes — `mkvmerge v84.0 ('Sunshine') 64-bit`, `ffmpeg version 6.1.1-essentials_build-www.gyan.dev`, and ffmpeg's `nN.N` flavour — without pulling `regex` (deferred to slice 0007 for `progress_parsers`). Floor comparison reduces both sides to `(major, minor)` tuples; an unparseable version is treated as `Outdated` rather than swallowed silently, since a tool whose binary works but won't report a version is suspicious.

Subprocess spawns set `CREATE_NO_WINDOW` (`0x08000000`) on Windows so the version probe never flashes a console window in front of the user.

The Onboarding gate is composed of three exclusive `Switch`/`Match` branches inside the existing `AppShell`: an initial spinner overlay during the very first probe (so the Onboarding panel never flickers in front of empty data), the `OnboardingView` itself when any tool is not Ready, and the original 0001 three-region layout (Sidebar + Main + StatusBar) once all three report Ready. Sidebar and StatusBar are simply absent from the DOM during Onboarding — drag-drop targets and project actions therefore become unreachable for free, no additional disabling logic needed.

Settings are persisted atomically via a temp-file + rename dance so a mid-write crash never leaves a half-flushed `settings.json`. The rotating log file is opened lazily on the first write, then rotated in-place by closing the handle, renaming `zimesub.log` → `zimesub.log.1` (cascading `.1` → `.2`, …, dropping anything past `.5`), and reopening on the next write — necessary because Windows does not allow renaming an open file.

Frontend follows the PRD's directory layout: `api/` for Tauri command bindings (1 file per Rust module's surface), `stores/` for SolidJS stores subscribed to those bindings, `design-system/` for primitives (Button, StatusBadge introduced here; Card / TerminalLog / ProgressBar land in their respective slices), and `views/onboarding/` for the gate UI. New tsconfig path aliases (`@api/*`, `@stores/*`, `@views/*`, `@design-system/*`) accompany the existing `@components/*` and `@lib/*`.

The `tool_probe` Tauri command is cache-aware: cached results are returned when the absolute path still exists on disk, otherwise the tool is re-resolved fresh. `tool_rescan` always re-probes — wired to the "Quét lại" button so users who install tools while ZimeSub is open never have to relaunch (PRD user story 5; the matching Settings re-check button lands in a later slice).

### Files created

| File | Purpose |
|---|---|
| `src-tauri/src/paths.rs` | Resolves `%APPDATA%\ZimeSub\`, `settings.json`, and `logs/zimesub.log` paths. Single source of truth for the AppData layout so future modules don't drift. |
| `src-tauri/src/logging.rs` | Initialises `tracing-subscriber` with a custom `Arc<Mutex<RotatingFile>>` `MakeWriter` enforcing 5 × 2 MB rolling files at `%APPDATA%\ZimeSub\logs\zimesub.log`. Uses a chrono-backed RFC 3339 timer; ANSI off (file output). |
| `src-tauri/src/settings_store.rs` | `Settings` struct (`version`, `tool_paths`, `tool_versions` — extensible with `#[serde(default)]`). `load()` returns defaults on missing file; `save()` writes atomically via temp-file rename. |
| `src-tauri/src/tooling.rs` | `RequiredTool` enum + per-tool floor table, `ToolStatus`/`ToolReport` types, regex-free version parser, cache-aware `probe_with_cache` and full `probe_fresh`. Spawns version probes with `CREATE_NO_WINDOW` on Windows. Includes 7 unit tests covering all observed `--version` line shapes and the floor classifier. |
| `src-tauri/src/commands.rs` | `AppState` (`Mutex<Settings>` loaded at construction) + `#[tauri::command]` glue for `tool_probe` and `tool_rescan`. Persists `settings.json` after each probe. |
| `src/api/tooling.ts` | TS mirror of the Rust `ToolReport` shape and `invoke()` bindings for `tool_probe` / `tool_rescan`. |
| `src/stores/tools.ts` | SolidJS `createStore` holding `{ phase, reports, error }` plus the `bootstrapTools()` and `rescanTools()` actions and the `allReady()` selector consumed by `AppShell`. |
| `src/design-system/Button.tsx` | Flat 44 px-min-target button primitive with `primary` (accent fill) and `secondary` (bordered) variants. Spreads native `<button>` props. |
| `src/design-system/StatusBadge.tsx` | Compact mono-font status pill with `accent`/`warn`/`danger` tones, used by `ToolRow` today and `EpisodeState`/`JobStatus` rendering in later slices. |
| `src/views/onboarding/OnboardingView.tsx` | Full-window Onboarding gate: title, RequiredTool panel, "Quét lại" button (with spinning `RefreshCw` icon while in flight). All copy Vietnamese. |
| `src/views/onboarding/ToolRow.tsx` | One row per `RequiredTool` — tool name + version + status badge + path (Ready) / current-vs-minimum hint (Outdated) / not-found message (Missing). |

### Files modified

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Added `which 8`, `dirs 6`, `tracing 0.1`, `chrono 0.4` (no defaults, `clock`+`std` features), `tracing-subscriber 0.3` (no defaults, `fmt`+`env-filter` — drops ANSI for file logging). |
| `src-tauri/Cargo.lock` | Lockfile updates for the new deps. |
| `src-tauri/src/lib.rs` | Initialises `logging` before anything else, logs the startup banner, registers `AppState` and the two new commands on the Tauri builder. |
| `src/components/shell/AppShell.tsx` | Adds the gating `Switch`/`Match` — initial-probe overlay vs Onboarding vs the original 0001 three-region layout. Boots `bootstrapTools()` on mount alongside `installGlobalShortcuts()`. |
| `tsconfig.json` | Added path aliases `@api/*`, `@stores/*`, `@views/*`, `@design-system/*`. |

### Files deleted

None.
