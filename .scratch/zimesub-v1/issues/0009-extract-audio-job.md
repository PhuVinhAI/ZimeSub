---
title: "Extract audio Job"
labels: [done]
type: AFK
blocked_by: [0008]
user_stories: [31, 32, 33, 34]
status: done
---

# 0009 — Extract audio Job

## Status

**Done.** `cargo check --all-targets`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib` (135 tests passing — 97 existing + 11 new `progress_parsers` tests for ffmpeg time / duration parsing + 5 new `duration_probe` tests + 8 new `project_store` tests for `ExtractAudioConfig` / `set_default_extract_audio` + 3 new `episode_state` tests for `has_extracted_audio` / audio stale-file cleanup + 1 new `job_queue` test for the audio spec shape), `cargo build --bin zimesub`, `bun run lint` (`lint:classes` + `eslint`), `bun run typecheck`, and `prettier --check` on the touched files all green. Verified on 2026-06-08.

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

A new `JobKind::ExtractAudio` runs ffmpeg to produce `<basename>.mp3` (default `libmp3lame -q:a 2`) in the EpisodeFolder. The codec and quality are configurable at the Project level. Audio extraction is OPTIONAL — it does not gate `EpisodeState` progression (an Episode with `<basename>.eng.ass` but no `<basename>.mp3` is still `Extracted`). Progress is parsed from ffmpeg stderr `time=` lines.

## Acceptance criteria

- [x] "Trích xuất audio" button on each Episode panel. Always enabled (audio is independent of subtitle stage). Disabled only when Episode is `MissingSource` (slice 0012).
- [x] Clicking enqueues a `Job { kind: ExtractAudio, episode_id }`. Runs in the Extract tier of the queue (concurrent with `ExtractSubtitle` up to N).
- [x] ffmpeg invocation: `ffmpeg -hide_banner -i <source_mkv_path> -vn -c:a <codec> <quality-flags> <basename>.<ext>`, cwd = EpisodeFolder.
- [x] Stderr parsed by `progress_parsers::parse_ffmpeg` for `time=`, combined with a known total duration (queried via `mkvmerge -J` or `ffprobe` whichever is available). If neither, fall back to indeterminate spinner with line count.
- [x] Project settings panel exposes an "Trích xuất audio" sub-form:
  - codec dropdown: `libmp3lame` (default) / `aac` / `flac`
  - quality input: `q:a` (0=highest, 9=lowest, default 2) for mp3; bitrate for aac; no extra param for flac
  - saved to `default_extract_audio` in `zimesub.json`
- [x] If `<basename>.mp3` already exists, confirm modal "Ghi đè audio hiện có?".
- [x] Cancelling deletes the partial `<basename>.mp3` (cleanup-on-cancel from slice 0008).
- [x] `EpisodeState` does not change when audio is added or removed: it is decorative only. Row shows a small "audio" indicator badge when present.
- [x] All UI strings Vietnamese.

## Blocked by

- 0008

## Implementation notes

### Architecture overview

The slice 0008 tiered scheduler was already plumbed for `JobKind::ExtractAudio` (tier classification + cleanup table + dispatcher budget), so slice 0009 only fills in the runnable spec, the runner, and the per-codec output-extension plumbing. ffmpeg streams progress on stderr as a `time=HH:MM:SS.cs` token inside a continuously-overwritten status row; the slice combines that elapsed counter with a pre-computed total duration (probed once at runner start via `mkvmerge -J` → ffprobe fallback → in-stream `Duration:` banner) to produce the same `[0, 1]` ratio shape the mkvextract pipeline already emits, with the hint changed from `"35%"` to `"HH:MM:SS / HH:MM:SS"` so the user can read elapsed against total directly.

Per-codec output extension and ffmpeg quality argv resolve once on the project side via two new `ExtractAudioConfig` helpers — `output_extension()` maps `libmp3lame → mp3`, `aac → aac`, `flac → flac`, and `quality_args()` maps `libmp3lame → -q:a N`, `aac → -b:a Nk`, `flac → []`. Malformed `quality_or_bitrate` strings fall back to the codec's default so the runner never produces argv ffmpeg rejects.

Audio is decorative: `EpisodeState` derivation continues to key on `<basename>.eng.ass` / `<basename>.vietsub.ass` / `<basename>.VietSub.mp4` only. `has_extracted_audio` lights up a small companion "audio" indicator badge alongside (not replacing) the slice 0007 "Đã extract" / "Trống" badges, and the audio extract is an independent action — the button is always enabled regardless of subtitle stage.

Crash recovery in slice 0008's `clean_stale_artifacts` is extended from `.mp4 + .ass` to `.mp4 + .ass + .mp3 + .aac + .flac` so a killed audio extract that flushed zero bytes is cleaned up on next project open the same way subtitle / render partials already are.

### Files created

- `src-tauri/src/duration_probe.rs` — Two pure parsers (`parse_mkvmerge_duration_us` for the `mkvmerge -J` JSON nanosecond field, `parse_ffprobe_duration_us` for ffprobe's decimal-seconds output) plus two thin spawn helpers (`probe_duration_via_mkvmerge` / `probe_duration_via_ffprobe`) and `ffprobe_path_from_ffmpeg` which derives the sibling ffprobe binary path from the cached ffmpeg path (both ship in the same `bin/` directory on the official Gyan builds Onboarding installs). 5 unit tests cover the JSON / decimal / sibling-resolution happy paths and the malformed / missing-field rejections.
- `src/views/project/AudioOverwriteConfirmModal.tsx` — AC-mandated "Ghi đè audio hiện có?" modal. Mirrors `ExtractConfirmModal` shape: filename pre-rendered as `<basename>.<ext>` in mono so the user knows which file is about to be replaced (the extension is read off the artefact cache so a codec switch is reflected immediately), session-only "Không hỏi lại cho Episode này" checkbox bound to the JobsStore's new `dontAskAudioOverwrite` set, Hủy / Ghi đè footer.
- `src/views/project/ProjectSettingsModal.tsx` — Project-level Settings modal triggered by a "Cấu hình" button in the project header (sibling to the app-level `SettingsModal` from slice 0008). Hosts the "Trích xuất audio" sub-form: codec dropdown (libmp3lame / aac / flac), per-codec quality input (mp3 `q:a 0..9` VBR / aac `b:a NNNk` bitrate / flac no quality knob), Hủy / Lưu footer. Local draft state mirrors the project's `default_extract_audio` block; commit goes through `setExtractAudioConfig` on the projects store which round-trips through `project_set_extract_audio_config` and swaps `active` with the post-write `ProjectJson`. Both quality fields stay pre-populated when toggling the codec dropdown so the user can A/B between codecs without retyping.

### Files modified

- `src-tauri/src/progress_parsers.rs` — Added `parse_ffmpeg_time_us` (matches `time=HH:MM:SS[.cs]` tokens with `N/A` rejection and per-component validation), `parse_ffmpeg_duration` (matches the `Duration: HH:MM:SS.cs,` banner line for the in-stream fallback), and `ffmpeg_progress(elapsed_us, total_us) -> ProgressUpdate` which composes the AC's `"HH:MM:SS / HH:MM:SS"` hint shape with `[0, 1]` overshoot clamping. Pure-helper `parse_hms_to_micros` and `format_hms` keep timestamp handling integer-precise (µs) so 24h-long sources still fit comfortably inside `u64`. 11 new tests cover audio-only and `frame=`-bearing variants, comma/dot decimal separators, fraction omission, `N/A` rejection, malformed-component rejection, the banner-line happy path, overshoot clamping, and the zero-total defensive branch.
- `src-tauri/src/project_store.rs` — Added `ExtractAudioConfig::output_extension()` and `quality_args()` so the runner never has to know the codec/quality mapping; added the top-level `set_default_extract_audio(folder, config) -> Result<ProjectJson>` writer mirroring the `set_selected_track` shape. Unknown codecs are coerced to `libmp3lame` on write so a future codec drop can't poison the manifest. `parse_mp3_quality` / `parse_aac_bitrate` pure helpers tolerate whitespace + trailing case variants. 8 new tests cover defaults, aac bitrate args, flac (empty args), malformed-quality fallback, mp3 out-of-range clamping, persist + round-trip, unknown-codec coercion, and missing-project rejection.
- `src-tauri/src/episode_state.rs` — `inspect_artifacts(folder, basename, audio_extension)` now takes an optional codec extension; presence of `<basename>.<ext>` flips the new `EpisodeArtifacts::has_extracted_audio` flag. `audio_extension: None` keeps the audio flag `false` (used by pre-slice-0009 callers that don't carry a codec yet). `clean_stale_artifacts` extended from the `.mp4 + .ass` candidate set to `.mp4 + .ass + .mp3 + .aac + .flac` so audio partials clean up on project open the same way. 3 new tests cover the audio-presence flip, the codec-mismatch isolation case (mp3 file exists but project is configured for aac), and the audio cleanup integration test.
- `src-tauri/src/job_queue.rs` — Promoted `JobKind::ExtractAudio` from "discriminator-only" to a fully-runnable variant. Added `ExtractAudioSpec` (carries the resolved codec / output extension / ffmpeg quality argv / optional mkvmerge path), `JobSpec::ExtractAudio(spec)` arm, dispatch through `spawn_runner`, and the full `run_extract_audio` / `supervise_audio` / `probe_total_duration` pipeline. The reader task lazily seeds the total duration from ffmpeg's banner `Duration:` line when the up-front probe fails, and falls back to an indeterminate "Đang trích xuất (~N)" hint with `ratio = 0.0` when neither source yields a usable total. Cleanup-on-cancel is split into `cleanup_partial_output_for_subtitle` / `cleanup_partial_output_for_audio` so cancelling an aac extract doesn't touch a sibling mp3 from an earlier extract. 2 new tests cover the audio cleanup table and the audio spec shape.
- `src-tauri/src/commands.rs` — `EpisodeArtifactsView` gained `has_extracted_audio` + `audio_extension` fields; `episode_inspect_artifacts` now reads the project's `default_extract_audio.output_extension()` and passes it into the inspector. Four new commands: `extract_audio_start(job_id, folder, episode_id)` (resolves ffmpeg path from settings cache, reads codec/quality from the project, enqueues an `ExtractAudioSpec` on the shared `JobQueue`), `extract_audio_cancel(job_id)` (idempotent generic cancel), `project_get_extract_audio_config(folder)` / `project_set_extract_audio_config(folder, config)` (drive the Settings sub-form's hydrate + commit paths).
- `src-tauri/src/lib.rs` — Registered the new `duration_probe` module and the four new commands in `invoke_handler!`.
- `src-tauri/src/settings_store.rs` — Fixed two pre-existing clippy lints (`doc_lazy_continuation` on the field docstring + `field_reassign_with_default` in the round-trip test) so the slice ships with `cargo clippy --all-targets -- -D warnings` clean.
- `src/api/extract.ts` — Added `EpisodeArtifactsView` fields (`has_extracted_audio`, `audio_extension`), plus `extractAudioStart(jobId, folder, episodeId)` and `extractAudioCancel(jobId)` invoke wrappers. Field names match the Rust `#[derive(Serialize)]` outputs 1:1.
- `src/api/projects.ts` — Added `projectGetExtractAudioConfig(folder)` + `projectSetExtractAudioConfig(folder, config)` invoke wrappers feeding the Settings sub-form.
- `src/stores/projects.ts` — Added `setExtractAudioConfig(config)` action that round-trips through the backend and updates `state.active` with the post-write `ProjectJson` so the artefact-cache audio extension and Episode-row audio badge derivation stay in lockstep.
- `src/stores/jobs.ts` — `EpisodeArtifactState` carries `hasExtractedAudio` + `audioExtension`; the store gained `dontAskAudioOverwrite: Record<string, boolean>` as a session-only sibling to the subtitle variant. `jobStateFor(episodeId, kind = 'extract_subtitle')` generalised to any `JobKind` so the EpisodeRow can derive subtitle and audio state independently. New actions: `startExtractAudio`, `cancelExtractAudio`, `shouldConfirmAudioOverwrite`, `rememberDontAskAudioOverwrite`. `retryJob` now dispatches by kind (`extract_subtitle` / `extract_audio`) so the Jobs panel's Thử lại button works for both. The `JobKind` type import is no longer treated as subtitle-only.
- `src/views/project/ProjectView.tsx` — EpisodeRow's right cluster is now a two-tier layout: a stacked column of subtitle state (slice 0007) + audio state (slice 0009) above a stacked column of subtitle action (slice 0007) + audio action (slice 0009). New sub-components `AudioStateSlot` (progress bar / queued / "Lỗi audio" / muted "audio" indicator badge / nothing) and `AudioActionButton` (idle "Trích xuất audio" secondary / cancel / "Thử lại audio") sit alongside the existing `StateSlot` / `ActionButton`. The project header gained a "Cấu hình" button that opens `ProjectSettingsModal`. Three new entry points wire the audio click flow: `handleAudioExtractRequest` consults `shouldConfirmAudioOverwrite` and routes between modal / direct enqueue; `handleAudioOverwriteConfirm` flips the session don't-ask memory and enqueues; cancel goes through `cancelExtractAudio` straight to the JobsStore. The audio indicator badge uses a muted neutral tone (border-border + text-text-muted) so it reads as a passive presence marker rather than a status callout — the dialogue track stays the row's primary affordance.

### Files deleted

None.
