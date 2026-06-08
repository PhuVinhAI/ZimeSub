---
title: "Render Job + EncoderProbe + auto-fallback"
labels: [done]
type: AFK
status: Done
blocked_by: [0008, 0010]
user_stories: [42, 43, 44, 45, 46, 47, 48, 49, 50, 51]
---

# 0011 — Render Job + EncoderProbe + auto-fallback

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

A new `JobKind::Render` runs ffmpeg to hardsub `<basename>.vietsub.ass` into `<source_mkv_path>` and produce `<basename>.VietSub.mp4` (cwd = EpisodeFolder, relative subtitles filter — [ADR-0004](../../../docs/adr/0004-render-encoder-and-path-handling.md)). The encoder is determined by `EncoderProbe` on app start. Project-level `RenderConfig` default and optional per-Episode override are both stored in `zimesub.json`. A single 0–100 quality slider maps per engine. If the configured encoder isn't on the current machine, auto-fallback to the highest-available with a one-time toast.

## Acceptance criteria

- [x] On app start (and on "Quét lại" in Settings), `EncoderProbe` runs `ffmpeg -hide_banner -encoders` and the parser returns the encoders that ffmpeg reports as available, intersected with `[h264_qsv, h264_nvenc, h264_amf, libx264]`. Result cached in app settings as `available_encoders`.
- [x] Project settings panel exposes a `Render` sub-form:
  - encoder dropdown ("auto" default + each available encoder)
  - quality slider 0–100 (default 65)
  - audio bitrate input (default 192 kbps; audio codec fixed to `aac` in v1)
  - saved to `default_render_config` in `zimesub.json`
- [x] Each Episode panel exposes a "Render" button (enabled only when `EpisodeState >= Translated`) and a collapsible "Cấu hình override" section that lets the user set a per-Episode `render_config_override` (saved to `zimesub.json`).
- [x] Clicking "Render" enqueues a `Job { kind: Render, episode_id }`. Queue ensures only 1 Render Running at a time (ADR-0003).
- [x] ffmpeg invocation: cwd = EpisodeFolder, args = `-hide_banner -i <abs source_mkv_path> -vf subtitles=<basename>.vietsub.ass -c:v <encoder> <engine-quality-flag> <quality-value> -c:a aac -b:a <bitrate>k -y <basename>.VietSub.mp4`. The subtitles filter argument MUST be the relative filename so Windows path escaping is avoided (ADR-0004).
- [x] Quality slider mapping (slider 0..100 → engine param):
  - QSV: `-global_quality 28..18` (linear)
  - NVENC: `-cq 28..18` (linear)
  - AMF: `-quality {speed|balanced|quality}` step thresholds (`<33` = speed, `33..66` = balanced, `>66` = quality)
  - libx264: `-crf 28..18` (linear)
- [x] Encoder resolution:
  - `auto` → pick first available in priority `QSV > NVENC > AMF > libx264`
  - specific encoder NOT available on this machine → show a one-time toast "Encoder X không khả dụng trên máy này, dùng Y" and use the highest-available, but do NOT overwrite the saved config.
- [x] Progress parsed via `progress_parsers::parse_ffmpeg` from `frame=` / `time=` lines. Total duration queried up-front via ffprobe (or `mkvmerge -J` fallback) so progress is determinate.
- [x] On cancel: process tree killed + `<basename>.VietSub.mp4` deleted (cleanup rule from slice 0008).
- [x] On success: `EpisodeState` transitions to `Rendered`. The stale-render badge from 0010 disappears.
- [x] All UI strings Vietnamese.

## Blocked by

- 0008
- 0010

## Implementation notes

### Files created

- `src-tauri/src/encoder_probe.rs` — pure parser + helpers for the EncoderProbe pipeline. Exposes `Encoder` enum (priority chain `H264Qsv > H264Nvenc > H264Amf > Libx264`), `parse_ffmpeg_encoders(stdout)` that intersects the ffmpeg `-encoders` output with the priority list, `probe_via_ffmpeg(path)` that spawns ffmpeg, `resolve_encoder(configured, available) -> ResolvedEncoder` for the auto + fallback policy, and `quality_args(encoder, slider 0..100)` that maps the 0–100 slider to engine-specific argv tokens (`-global_quality`, `-cq`, `-crf` linear 28→18 for QSV/NVENC/libx264; `-quality speed|balanced|quality` step thresholds for AMF). Fully unit-tested (17 fixture-driven tests).
- `src/api/render.ts` — TypeScript bindings for the new render-stage Tauri commands (`encoderProbeGetCached`, `encoderProbeRescan`, `projectGetRenderConfig`, `projectSetRenderConfig`, `episodeGetEffectiveRenderConfig`, `episodeSetRenderConfigOverride`, `renderStart`, `renderCancel`). Also exports `ENCODER_LABELS` (Vietnamese labels for each encoder key) used by both the project Settings sub-form and the per-Episode override panel.
- `src/views/project/render/RenderPanel.tsx` — per-Episode render strip rendered below `TranslatePanel` when `<basename>.vietsub.ass` exists on disk. Surfaces the primary "Render" CTA, a live progress bar + "Hủy" button while running, an accent "Đã render" / warn "Render lỗi thời" badge driven by the disk-artefact cache, and a collapsible "Cấu hình override" section with encoder dropdown + 0..100 quality slider + AAC bitrate input that round-trip to `render_config_override` in `zimesub.json`. Includes a "Khôi phục mặc định" button that clears the override.

### Files modified

- `src-tauri/src/lib.rs` — registered the new `encoder_probe` module and the seven new Tauri commands (`encoder_probe_get_cached`, `encoder_probe_rescan`, `project_get_render_config`, `project_set_render_config`, `episode_get_effective_render_config`, `episode_set_render_config_override`, `render_start`, `render_cancel`).
- `src-tauri/src/settings_store.rs` — added `available_encoders: Vec<String>` field with `#[serde(default)]` for forward-compat loading of pre-0011 `settings.json` files. The EncoderProbe rescan command writes back through `settings_store::save`.
- `src-tauri/src/project_store.rs` — added three helpers: `set_default_render_config(folder, config)` for the project-level setter; `set_render_config_override(folder, episode_id, Option<config>)` for the per-Episode override setter (`None` clears it); `effective_render_config(folder, episode_id)` to resolve override-vs-default for the render runner; plus a private `normalise_render_config` that clamps quality to 0..=100, coerces unknown encoder keys to `"auto"`, forces `audio_codec = "aac"`, and clamps bitrate to 32..=512 kbps.
- `src-tauri/src/job_queue.rs` — added the `JobSpec::Render(RenderSpec)` variant alongside the existing extract specs. `RenderSpec` carries the absolute paths, the resolved encoder key, the pre-computed `video_quality_args`, and the audio bitrate. New `run_render` coroutine spawns ffmpeg with cwd = EpisodeFolder, args `-hide_banner -y -i <source> -vf subtitles=<basename>.vietsub.ass -c:v <encoder> <quality args> -c:a aac -b:a <bitrate>k <basename>.VietSub.mp4`. Reuses the `Supervised` mid-flight outcome and the same `progress_parsers::parse_ffmpeg_time_us` / `parse_ffmpeg_duration` / `ffmpeg_progress` stack as the audio extract for determinate progress. New `cleanup_partial_output_for_render` deletes the `.VietSub.mp4` partial on any non-success exit; the spawn_runner match arm dispatches `JobSpec::Render` to the new runner. The dispatcher's existing tier policy already enforced 1 Render at a time — wiring the runner light up the variant the dispatcher had been counting since slice 0008.
- `src-tauri/src/commands.rs` — added the seven new commands listed above. `render_start` enforces the AC pre-conditions: project exists, episode exists, `<basename>.vietsub.ass` exists on disk (else `"Cần TranslatedSub trước"`), `ffmpeg` cached path resolves (else `"Chưa phát hiện đường dẫn ffmpeg"`), at least one encoder available (else `"Chưa có encoder khả dụng. Hãy chạy lại bước dò encoder trong Cài đặt."`). Calls `encoder_probe::resolve_encoder` and returns `RenderStartOutcome { chosen_encoder, fallback_from }` so the frontend can fire the one-time fallback toast. The saved `RenderConfig` is never mutated by a fallback resolution.
- `src/stores/jobs.ts` — added `startRender(episodeId)` (generates jobId, calls `renderStart`, surfaces the one-time `pushWarnToast("Encoder X không khả dụng trên máy này, dùng Y")` via a session-level `encoderFallbackToastShown` Set keyed by the `(from→to)` pair), and `cancelRender(episodeId)` (mirrors the extract cancel helpers). `retryJob` now handles `kind === 'render'` too.
- `src/stores/projects.ts` — added `setDefaultRenderConfig(config)` and `setRenderConfigOverride(episodeId, config | null)` wrappers that swap `state.active` with the post-write `ProjectJson` so any downstream selector reads the new values without a second `project_open` round-trip.
- `src/views/project/ProjectSettingsModal.tsx` — added the "RENDER (HARDSUB)" sub-form alongside the existing "TRÍCH XUẤT AUDIO" sub-form: encoder dropdown populated from `encoderProbeGetCached()` (with a "Quét lại" button that calls `encoderProbeRescan`), 0..100 quality slider with live numeric readout in the label, AAC bitrate input. The save button now persists both audio and render configs.
- `src/views/project/ProjectView.tsx` — added `hasTranslatedSub` accessor on `EpisodeRow` and mounts `<RenderPanel>` below the TranslatePanel when the flag is true (per AC: "Render button enabled only when `EpisodeState >= Translated`").

### Files deleted

None.
