---
title: "List SubtitleTracks for an Episode (modal table)"
labels: [ready-for-agent]
type: AFK
blocked_by: [0005]
user_stories: [24, 25, 26]
---

# 0006 — List SubtitleTracks for an Episode (modal table)

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

User clicks an Episode → "Chọn track" button opens a modal showing all `SubtitleTrack`s parsed from the MKV via `mkvmerge -i -F json`. Bitmap codecs (PGS, VobSub) are shown disabled. The most likely track is pre-selected by heuristic. Confirming saves `selected_subtitle_track_id` to `zimesub.json`.

This slice introduces only the synchronous run-to-completion process helper (no streaming). The streaming `JobQueue` arrives in 0007.

## Acceptance criteria

- [ ] "Chọn track" button visible on each Episode row that has no `selected_subtitle_track_id`. An "Đổi track" link replaces it when one is already set.
- [ ] Clicking opens a modal that runs `mkvmerge -i -F json <source_mkv_path>` in the background (cwd = EpisodeFolder). On completion, stdout is parsed by the `mkv_probe` parser into typed `SubtitleTrack`s.
- [ ] Modal table columns: `track id`, `language`, `codec`, `title`, `default/forced` flags.
- [ ] Rows with codec `ass` or `srt` are selectable. Rows with `pgs` or any bitmap codec are rendered at reduced opacity with a "Bitmap — không hỗ trợ" badge and cannot be picked.
- [ ] Pre-selection heuristic, evaluated top-down:
  1. First row matching `codec=ass AND (lang=eng OR is_default) AND title does NOT contain "sign"/"song"`
  2. Fall back to first row matching `codec=ass AND lang=eng`
  3. Fall back to first selectable row
  4. If no selectable rows, modal shows error "Không có subtitle track text-based trong file này"
- [ ] If `mkvmerge -i` fails (non-zero exit), modal shows the stderr in a Geist Mono block and a "Thử lại" button.
- [ ] Confirming saves `selected_subtitle_track_id` to `zimesub.json`. Modal closes; the Episode row reflects the selection (shows the picked track's language tag).
- [ ] All UI strings Vietnamese.

## Blocked by

- 0005
