---
title: "List SubtitleTracks for an Episode (modal table)"
labels: [done]
type: AFK
blocked_by: [0005]
user_stories: [24, 25, 26]
status: done
---

# 0006 — List SubtitleTracks for an Episode (modal table)

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## Status

**Done.** `cargo check --all-targets`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib` (65 tests passing — 39 existing + 15 new `mkv_probe` parser/heuristic tests + 4 new `process_runner` helper tests + 7 new `project_store` tests covering `set_selected_track` round-trip + overwrite + missing-episode + missing-project errors, `resolve_episode_targets` happy + missing-episode paths, and the legacy-manifest forward-compat load), `bun run lint` (lint:classes + eslint), `bun run typecheck`, and `prettier --check` on the touched files all green. Verified on 2026-06-08.

## What to build

User clicks an Episode → "Chọn track" button opens a modal showing all `SubtitleTrack`s parsed from the MKV via `mkvmerge -i -F json`. Bitmap codecs (PGS, VobSub) are shown disabled. The most likely track is pre-selected by heuristic. Confirming saves `selected_subtitle_track_id` to `zimesub.json`.

This slice introduces only the synchronous run-to-completion process helper (no streaming). The streaming `JobQueue` arrives in 0007.

## Acceptance criteria

- [x] "Chọn track" button visible on each Episode row that has no `selected_subtitle_track_id`. An "Đổi track" link replaces it when one is already set.
- [x] Clicking opens a modal that runs `mkvmerge -i -F json <source_mkv_path>` in the background (cwd = EpisodeFolder). On completion, stdout is parsed by the `mkv_probe` parser into typed `SubtitleTrack`s.
- [x] Modal table columns: `track id`, `language`, `codec`, `title`, `default/forced` flags.
- [x] Rows with codec `ass` or `srt` are selectable. Rows with `pgs` or any bitmap codec are rendered at reduced opacity with a "Bitmap — không hỗ trợ" badge and cannot be picked.
- [x] Pre-selection heuristic, evaluated top-down:
  1. First row matching `codec=ass AND (lang=eng OR is_default) AND title does NOT contain "sign"/"song"`
  2. Fall back to first row matching `codec=ass AND lang=eng`
  3. Fall back to first selectable row
  4. If no selectable rows, modal shows error "Không có subtitle track text-based trong file này"
- [x] If `mkvmerge -i` fails (non-zero exit), modal shows the stderr in a Geist Mono block and a "Thử lại" button.
- [x] Confirming saves `selected_subtitle_track_id` to `zimesub.json`. Modal closes; the Episode row reflects the selection (shows the picked track's language tag).
- [x] All UI strings Vietnamese.

## Blocked by

- 0005

## Implementation notes

The slice splits along the existing thin-command pattern from 0004/0005: two new pure Rust modules (`mkv_probe`, `process_runner`) hold the testable logic, `project_store` grows one mutating function (`set_selected_track`) plus a read-only helper (`resolve_episode_targets`), two new Tauri commands wire the pair, and the frontend gains one new TS api file, one new view (the track-picker modal), and a per-Episode-row affordance in `ProjectView`. No new Tauri capabilities were needed — the mkvmerge subprocess is spawned from Rust via `std::process::Command` (mirroring `tooling::read_version`), so neither `core:shell:execute` nor a JS-side process API is in play.

`mkv_probe::parse_mkvmerge_json` is the pure parser the AC asks for. It takes the captured `mkvmerge -i -F json` stdout string and emits a `Vec<SubtitleTrack>` keyed by Matroska `codec_id`. Codec classification is a small lookup table mapping the documented codec ids (`S_TEXT/ASS`, `S_TEXT/SSA`, `S_TEXT/UTF8`, `S_TEXT/ASCII`, `S_HDMV/PGS`, `S_VOBSUB`, `S_DVBSUB`, `S_TEXT/WEBVTT`, `S_KATE`, `S_HDMV/TEXTST`, plus an `unknown` fallback) onto a normalised slug (`ass`/`srt`/`pgs`/…) and a three-way `SubtitleKind` discriminator (`text` | `bitmap` | `other`). `text` is the only kind that yields `extractable: true`, and the frontend uses `kind === 'bitmap'` to pick the "Bitmap — không hỗ trợ" badge wording vs. the generic "Không hỗ trợ" badge for the `other` bucket (rare WebVTT/Kate/TextST rows). Non-subtitle tracks (video, audio, buttons, attachments) are silently dropped at parse time — the picker only cares about subtitle rows, and surfacing the others would crowd the table. Missing `language` defaults to `"und"` so the language column always has something to render; missing `track_name` flows through as `None` and renders as `—` in the table cell. Eight parser tests + seven heuristic tests cover the happy path, every codec branch, the `und`/missing-field fallback, the `tracks: []` edge case, the `{}` no-tracks-field edge case, malformed-JSON rejection, and each of the AC's three pre-selection rules including the case-insensitive "sign"/"song" filter and the no-extractable-row terminator.

The pre-selection heuristic also lives in `mkv_probe` as the `preselect_index(tracks)` pure function so it's testable next to the parser. The Tauri command computes it once and returns the result alongside `tracks` in `ListSubtitleTracksOutcome.preselected_index`, so the frontend never re-implements the rules — it just consumes the suggested index. The frontend's only addition on top is the precedence rule for the "Đổi track" flow: when the user re-opens the picker on an Episode that already has a saved `selected_subtitle_track_id`, the modal locks the highlight onto the previously-picked track (iff it's still present + extractable in the re-probed list) before falling through to the heuristic suggestion.

`process_runner::run_to_completion` is the synchronous run-to-completion subprocess helper the issue calls out. Interface: `RunSpec { executable: PathBuf, args: Vec<String>, cwd: &Path } -> RunOutcome { exit_code: Option<i32>, stdout: String, stderr: String }`. On Windows the child is spawned with the `CREATE_NO_WINDOW` flag (mirroring `tooling::read_version`) so no console window flashes in front of the user during the probe. A non-zero exit code is NOT a `RunError` — it lands in `RunOutcome.exit_code` so the caller (the track-picker command) can distinguish "tool ran but said no" (render stderr + Retry button per AC) from "we couldn't even spawn it" (different error path, surfaced as a Tauri error string). Spawn failure (missing binary) is the only failure mode that returns `Err(RunError::Spawn)`. Four unit tests cover the success boolean, the `cmd /c echo` round-trip (windows-only — guaranteed-available on every v1 target machine), the `cmd /c exit 7` non-zero-exit-is-outcome contract, and the missing-executable spawn-error path.

`project_store::EpisodeRecord` gains a single new `Option<String>` field `selected_subtitle_language` — a denormalised display cache for the picked track's language tag. The track id in `selected_subtitle_track_id` remains the source of truth for the eventual extract pipeline; this cache exists so the Episode row can render `ENG`/`JPN`/`UND` after restart without re-running `mkvmerge -i` on every project open. The field is `#[serde(default)]` so manifests written by pre-0006 builds (which only know about `selected_subtitle_track_id`) load cleanly with the cache as `None`. One legacy-manifest fixture test pins this forward-compat behaviour.

`project_store::set_selected_track(folder, episode_id, track_id, language)` is the mutator the new `project_set_selected_track` Tauri command wraps. It opens the project, mutates the matching `EpisodeRecord` in place, and rewrites `zimesub.json` atomically via the same `tmp + rename` helper `add_episodes` uses — so a panic during the write never leaves a half-flushed manifest. The post-write `ProjectJson` is returned to the frontend so `projectsStore.active` swaps in one round-trip with no follow-up `project_open` call. A new `ProjectError::EpisodeNotFound` variant exists so the command can surface "Không tìm thấy Episode trong project" distinct from `NotAProject`'s "Thư mục chưa có zimesub.json" — both errors are useful but they imply different UI affordances (retry vs. relocate). Two round-trip tests + two error-path tests + one overwrite-test pin the contract.

`project_store::resolve_episode_targets(project_folder, episode_id)` is a read-only helper introduced for the picker command. It returns the absolute `source_mkv_path` (the MKV the picker probes) and the absolute `EpisodeFolder` (used as `cwd` for the `mkvmerge` subprocess per the PRD's "Process spawn rules" convention). Wiring this from the command rather than passing both pieces from the frontend keeps `(project_folder, episode_id)` as the only stable cross-boundary identity for an Episode — folder name renames or future restructuring won't change the IPC surface.

The picker command (`episode_list_subtitle_tracks`) glues the pieces together: it resolves the targets via `resolve_episode_targets`, reads `mkvmerge` from `settings.tool_paths["mkvmerge"]` (populated during Onboarding's `tool_probe` flow — rejects with "Chưa phát hiện đường dẫn mkvmerge" if the cache is empty), spawns the subprocess via `process_runner::run_to_completion`, and routes the result into a `ListSubtitleTracksOutcome { ok, tracks, preselected_index, stderr, exit_code }`. The outcome type is shaped specifically so the modal can render exactly the three states the AC requires without further branching: `ok = true` → table from `tracks` + heuristic highlight from `preselected_index`; `ok = false` → stderr pane + Retry button (covering both "non-zero exit" and "zero exit but unparseable stdout" — the parse-failure branch prefixes the parser's message onto stderr so the user sees both the OS-level output and the parse hint without a second IPC trip).

The frontend wiring lives in three layers. **`src/api/mkv_probe.ts`** mirrors the new Rust shapes 1:1: `SubtitleTrack`, `SubtitleKind`, `ListSubtitleTracksOutcome`, plus the two `invoke` bindings (`listSubtitleTracks`, `projectSetSelectedTrack`). `EpisodeRecord` in `api/projects.ts` grows the matching `selected_subtitle_language: string | null` field so the existing project store keeps round-trip parity with the manifest. **`stores/projects.ts`** gains one new action — `setEpisodeSelectedTrack(episodeId, trackId, language)` — that calls the backend, swaps `state.active` with the post-write project, and surfaces backend failures as a danger toast while re-throwing for the caller (the modal) so it can restore the previous phase rather than auto-closing on error.

**`views/track-picker/TrackPickerModal.tsx`** is the new modal. It's a four-state state machine keyed by an internal `Phase` discriminated union (`idle` / `loading` / `error` / `success` / `no-text` / `saving`) — the explicit `saving` state keeps the previous `tracks`+`selectedIdx` rendered during the brief `project_set_selected_track` round-trip so the table doesn't visually clear under the user's mouse. On `open` flipping `true`, a `createEffect(on(...))` fires `probe()` which calls `listSubtitleTracks`, classifies the outcome into the appropriate phase, and on success applies `pickInitialIndex` to choose the initial highlight (previous pick > heuristic > null). Closing the modal resets the phase to `idle` so the next open starts fresh. Selection is click-driven (with Enter/Space keyboard equivalents on the row) and constrained to `track.extractable` — bitmap and `other` rows are non-interactive at `opacity-50`. The error pane renders the captured stderr through the existing `TerminalLog` primitive (slice 0003) with `stream: 'stderr'` for the warn tint, and the "Thử lại" button calls `probe()` again. The no-text branch shows the AC-mandated "Không có subtitle track text-based trong file này" banner above the table so the user sees which bitmap rows are blocking them.

The view-model layer inside the modal uses `createMemo` for the table data (`{ tracks, selectedIdx, disabled }` or `null` for non-table phases), the error log lines, the error exit code, and the confirm-enabled boolean — keeping each derived value as a memo lets Solid track props precisely so `selectedIdx` ticks during click-through don't unmount the table. A naive IIFE-inside-`<Match>` pattern would have captured the phase as a non-reactive const and lost the click highlight; the memo-plus-`<Show>`-with-function-children pattern reads each value live from the signal so updates flow through.

`Modal` (design-system) is extended with one new optional prop — `maxWidthClass` defaulting to `max-w-xl` — so the track-picker can bump itself to `max-w-3xl` (768 px) for the table without sideways scrolling on the 1024 px minimum window width. The change is forward-compatible: existing callers that don't pass the prop see no behaviour change.

`StatusBadge` (design-system) gains one new tone — `neutral` (`border-text-muted text-text-muted`) — used by the Episode row's language tag so it sits next to the existing accent-tone "Trống" state badge without competing visually. The three pre-existing tones (`accent` / `warn` / `danger`) are unchanged. The track-picker modal uses the `warn` tone for the bitmap / unsupported badges so they read as "needs attention" rather than a hard error.

`ProjectView`'s `EpisodeRow` grows a right-aligned cluster: the language tag (a `StatusBadge tone="neutral"` showing the cached uppercased ISO 639-2 code, or hidden when no track is picked), the existing accent "Trống" state badge, and the track-pick affordance — a `Button variant="secondary"` reading "Chọn track" when no track is selected, or a borderless text link reading "Đổi track" (accent text + underline-on-hover) when one is. The link form mirrors the AC's "An 'Đổi track' link replaces it" wording — a button would have visually overpowered the row once every Episode has a track picked, so the link form keeps the row light. Both affordances open the same `TrackPickerModal` mounted at the `ProjectView` root with `pickerEpisode` as a single signal that flips between `null` and the picked-on Episode record — the modal's `initialTrackId` prop drives the "Đổi track" pre-selection in `pickInitialIndex`.

The state-badge ("Trống") is retained even when a track is picked because picking a track does NOT advance the `EpisodeState` derivation per the PRD's `derive_state` pseudocode — `Empty` only flips to `Extracted` once `<basename>.eng.ass` exists on disk, which is slice 0007 work. Showing both the language tag (pick made) and the state badge ("Trống" = nothing extracted yet) gives the user the two independent facts at a glance: "I've picked which track to extract" and "I haven't extracted it yet".

### Files created

| File | Purpose |
|---|---|
| `src-tauri/src/mkv_probe.rs` | Pure parser for `mkvmerge -i -F json` output. Exposes `SubtitleTrack`, `SubtitleKind`, `parse_mkvmerge_json(stdout) -> Vec<SubtitleTrack>`, and the testable `preselect_index(tracks) -> Option<usize>` heuristic. Codec classification covers ASS/SSA/UTF8/ASCII/PGS/VobSub/DVBSUB/WebVTT/Kate/HDMV TextST plus a defensive `unknown` fallback. 15 unit tests against fixture JSON. |
| `src-tauri/src/process_runner.rs` | Synchronous run-to-completion subprocess helper. `RunSpec { executable, args, cwd } -> RunOutcome { exit_code, stdout, stderr }` with `CREATE_NO_WINDOW` on Windows. Non-zero exits are `RunOutcome` values, not `RunError`s. 4 unit tests covering success boolean + cmd echo round-trip + non-zero exit + missing-executable spawn error. |
| `src/api/mkv_probe.ts` | TS mirrors of `SubtitleTrack`, `SubtitleKind`, `ListSubtitleTracksOutcome` + the two `invoke` bindings (`listSubtitleTracks`, `projectSetSelectedTrack`). Field names match the Rust `#[derive(Serialize)]` outputs 1:1. |
| `src/views/track-picker/TrackPickerModal.tsx` | The track-picker modal — six-phase state machine (`idle`/`loading`/`error`/`success`/`no-text`/`saving`) over a `<Modal maxWidthClass="max-w-3xl">`. Probes via `listSubtitleTracks` on open, renders a 5-column table (#, Ngôn ngữ, Codec, Tiêu đề, Cờ) with click-to-select rows, "Bitmap — không hỗ trợ" / "Không hỗ trợ" badges on disabled rows, the heuristic / previous-pick initial highlight, an `errorPane` that wraps `TerminalLog` for stderr + "Thử lại", the no-text banner above the table when applicable, and an `Đang lưu...` footer state during the `project_set_selected_track` round-trip. All strings Vietnamese. |

### Files modified

| File | Change |
|---|---|
| `src-tauri/src/project_store.rs` | New `selected_subtitle_language: Option<String>` field on `EpisodeRecord` (`#[serde(default)]` for legacy-manifest forward compat). New `ProjectError::EpisodeNotFound` variant with Vietnamese display string. New `EpisodeTargets` struct + `resolve_episode_targets(project_folder, episode_id)` read-only helper. New `set_selected_track(folder, episode_id, track_id, language)` mutator that atomically rewrites `zimesub.json` and returns the post-write `ProjectJson`. `add_episodes` updated to initialise the new field to `None` per accepted entry. 7 new unit tests (two for `set_selected_track` round-trips, two for the missing-project / missing-episode error paths, one for overwrite, two for `resolve_episode_targets`, plus one legacy-manifest fixture test pinning the `#[serde(default)]` forward-compat). |
| `src-tauri/src/commands.rs` | New `ListSubtitleTracksOutcome` serialisable shape. New `episode_list_subtitle_tracks(state, folder, episode_id)` command — resolves the targets via `project_store::resolve_episode_targets`, reads mkvmerge from `settings.tool_paths`, spawns the subprocess via `process_runner::run_to_completion`, parses stdout via `mkv_probe::parse_mkvmerge_json`, applies `mkv_probe::preselect_index`, and routes the result into the outcome. New `project_set_selected_track(folder, episode_id, track_id, language)` command — thin glue over `project_store::set_selected_track`. |
| `src-tauri/src/lib.rs` | Registered `mkv_probe` + `process_runner` modules. Added `commands::episode_list_subtitle_tracks` and `commands::project_set_selected_track` to the `invoke_handler!` macro. |
| `src/api/projects.ts` | Added `selected_subtitle_language: string \| null` to the `EpisodeRecord` interface so the TS shape stays 1:1 with the Rust `serde` output. |
| `src/stores/projects.ts` | New `setEpisodeSelectedTrack(episodeId, trackId, language)` action — calls `projectSetSelectedTrack`, swaps `state.active` with the post-write project, danger-toasts on failure and re-throws for the modal so it can restore the previous phase. Import added for `projectSetSelectedTrack`. |
| `src/design-system/Modal.tsx` | New optional `maxWidthClass?: string` prop (default `'max-w-xl'`). The track-picker passes `'max-w-3xl'` so the 5-column table fits on the 1024 px minimum window width. No behaviour change for existing callers. |
| `src/design-system/StatusBadge.tsx` | New `neutral` tone (`border-text-muted text-text-muted`) used by the Episode-row language tag so it sits next to the accent `Trống` state badge without competing visually. The pre-existing `accent` / `warn` / `danger` tones are unchanged. |
| `src/views/project/ProjectView.tsx` | `EpisodeRow` now renders a right-aligned cluster: language tag (`StatusBadge tone="neutral"`, hidden when no pick), existing `Trống` state badge, and the track-pick affordance — `Button variant="secondary"` reading "Chọn track" when none picked, borderless accent text link reading "Đổi track" when one is. The `TrackPickerModal` is mounted once at the `ProjectView` root with `open={pickerEpisode() !== null}` and the picked-on Episode's id / folder name / `selected_subtitle_track_id` as props (`initialTrackId` drives the "Đổi track" pre-selection path inside the modal). |

### Files deleted

None.
