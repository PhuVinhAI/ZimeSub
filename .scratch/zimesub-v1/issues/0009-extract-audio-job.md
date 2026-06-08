---
title: "Extract audio Job"
labels: [ready-for-agent]
type: AFK
blocked_by: [0008]
user_stories: [31, 32, 33, 34]
---

# 0009 — Extract audio Job

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

A new `JobKind::ExtractAudio` runs ffmpeg to produce `<basename>.mp3` (default `libmp3lame -q:a 2`) in the EpisodeFolder. The codec and quality are configurable at the Project level. Audio extraction is OPTIONAL — it does not gate `EpisodeState` progression (an Episode with `<basename>.eng.ass` but no `<basename>.mp3` is still `Extracted`). Progress is parsed from ffmpeg stderr `time=` lines.

## Acceptance criteria

- [ ] "Trích xuất audio" button on each Episode panel. Always enabled (audio is independent of subtitle stage). Disabled only when Episode is `MissingSource` (slice 0012).
- [ ] Clicking enqueues a `Job { kind: ExtractAudio, episode_id }`. Runs in the Extract tier of the queue (concurrent with `ExtractSubtitle` up to N).
- [ ] ffmpeg invocation: `ffmpeg -hide_banner -i <source_mkv_path> -vn -c:a <codec> <quality-flags> <basename>.<ext>`, cwd = EpisodeFolder.
- [ ] Stderr parsed by `progress_parsers::parse_ffmpeg` for `time=`, combined with a known total duration (queried via `mkvmerge -J` or `ffprobe` whichever is available). If neither, fall back to indeterminate spinner with line count.
- [ ] Project settings panel exposes an "Trích xuất audio" sub-form:
  - codec dropdown: `libmp3lame` (default) / `aac` / `flac`
  - quality input: `q:a` (0=highest, 9=lowest, default 2) for mp3; bitrate for aac; no extra param for flac
  - saved to `default_extract_audio` in `zimesub.json`
- [ ] If `<basename>.mp3` already exists, confirm modal "Ghi đè audio hiện có?".
- [ ] Cancelling deletes the partial `<basename>.mp3` (cleanup-on-cancel from slice 0008).
- [ ] `EpisodeState` does not change when audio is added or removed: it is decorative only. Row shows a small "audio" indicator badge when present.
- [ ] All UI strings Vietnamese.

## Blocked by

- 0008
