---
title: "Render Job + EncoderProbe + auto-fallback"
labels: [ready-for-agent]
type: AFK
blocked_by: [0008, 0010]
user_stories: [42, 43, 44, 45, 46, 47, 48, 49, 50, 51]
---

# 0011 — Render Job + EncoderProbe + auto-fallback

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

A new `JobKind::Render` runs ffmpeg to hardsub `<basename>.vietsub.ass` into `<source_mkv_path>` and produce `<basename>.VietSub.mp4` (cwd = EpisodeFolder, relative subtitles filter — [ADR-0004](../../../docs/adr/0004-render-encoder-and-path-handling.md)). The encoder is determined by `EncoderProbe` on app start. Project-level `RenderConfig` default and optional per-Episode override are both stored in `zimesub.json`. A single 0–100 quality slider maps per engine. If the configured encoder isn't on the current machine, auto-fallback to the highest-available with a one-time toast.

## Acceptance criteria

- [ ] On app start (and on "Quét lại" in Settings), `EncoderProbe` runs `ffmpeg -hide_banner -encoders` and the parser returns the encoders that ffmpeg reports as available, intersected with `[h264_qsv, h264_nvenc, h264_amf, libx264]`. Result cached in app settings as `available_encoders`.
- [ ] Project settings panel exposes a `Render` sub-form:
  - encoder dropdown ("auto" default + each available encoder)
  - quality slider 0–100 (default 65)
  - audio bitrate input (default 192 kbps; audio codec fixed to `aac` in v1)
  - saved to `default_render_config` in `zimesub.json`
- [ ] Each Episode panel exposes a "Render" button (enabled only when `EpisodeState >= Translated`) and a collapsible "Cấu hình override" section that lets the user set a per-Episode `render_config_override` (saved to `zimesub.json`).
- [ ] Clicking "Render" enqueues a `Job { kind: Render, episode_id }`. Queue ensures only 1 Render Running at a time (ADR-0003).
- [ ] ffmpeg invocation: cwd = EpisodeFolder, args = `-hide_banner -i <abs source_mkv_path> -vf subtitles=<basename>.vietsub.ass -c:v <encoder> <engine-quality-flag> <quality-value> -c:a aac -b:a <bitrate>k -y <basename>.VietSub.mp4`. The subtitles filter argument MUST be the relative filename so Windows path escaping is avoided (ADR-0004).
- [ ] Quality slider mapping (slider 0..100 → engine param):
  - QSV: `-global_quality 28..18` (linear)
  - NVENC: `-cq 28..18` (linear)
  - AMF: `-quality {speed|balanced|quality}` step thresholds (`<33` = speed, `33..66` = balanced, `>66` = quality)
  - libx264: `-crf 28..18` (linear)
- [ ] Encoder resolution:
  - `auto` → pick first available in priority `QSV > NVENC > AMF > libx264`
  - specific encoder NOT available on this machine → show a one-time toast "Encoder X không khả dụng trên máy này, dùng Y" and use the highest-available, but do NOT overwrite the saved config.
- [ ] Progress parsed via `progress_parsers::parse_ffmpeg` from `frame=` / `time=` lines. Total duration queried up-front via ffprobe (or `mkvmerge -J` fallback) so progress is determinate.
- [ ] On cancel: process tree killed + `<basename>.VietSub.mp4` deleted (cleanup rule from slice 0008).
- [ ] On success: `EpisodeState` transitions to `Rendered`. The stale-render badge from 0010 disappears.
- [ ] All UI strings Vietnamese.

## Blocked by

- 0008
- 0010
