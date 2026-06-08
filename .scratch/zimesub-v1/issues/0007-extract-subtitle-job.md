---
title: "Extract subtitle Job (minimal queue + per-row progress)"
labels: [ready-for-agent]
type: AFK
blocked_by: [0006]
user_stories: [27, 28, 29, 30]
---

# 0007 — Extract subtitle Job (minimal queue + per-row progress)

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

User clicks "Trích xuất sub" on an Episode that has a `selected_subtitle_track_id`. A `Job` of kind `ExtractSubtitle` is enqueued and runs in a background tokio task. Progress (parsed from `mkvextract` stderr by `progress_parsers::parse_mkvextract`) streams to the Episode row as a percentage. On success, `<basename>.eng.ass` exists in the EpisodeFolder and EpisodeState advances to `Extracted`. If the picked track was SRT, it is converted to ASS during/after extract so the on-disk file is always `.eng.ass`.

This slice ships a minimal queue: serial execution, no UI other than per-Episode inline progress bars. Full tiered concurrency + bottom status bar arrive in 0008.

## Acceptance criteria

- [ ] "Trích xuất sub" button enabled only on Episodes with `selected_subtitle_track_id` set; tooltip on disabled state explains.
- [ ] Clicking enqueues a `Job { kind: ExtractSubtitle, episode_id, mkv_track_id }`. Minimal queue runs jobs serially in a tokio task.
- [ ] mkvextract is invoked: `mkvextract tracks <source_mkv_path> <track_id>:<basename>.eng.ass`, cwd = EpisodeFolder.
- [ ] Stderr is parsed line-by-line by `progress_parsers::parse_mkvextract` (matches `Progress: N%`). Each `ProgressUpdate` is emitted as a Tauri event scoped to the Job id. The Episode row subscribes and renders a determinate progress bar.
- [ ] If the picked track has codec `srt`, after mkvextract completes the resulting SRT file is converted in-place to ASS (preserve dialogue text, generate a default `[V4+ Styles]` section). The on-disk artifact is always `<basename>.eng.ass`.
- [ ] If `<basename>.eng.ass` already exists, a confirm modal "Ghi đè bản extract hiện có?" appears with a checkbox "Không hỏi lại cho Episode này".
- [ ] On Job success, `EpisodeState` is recomputed from disk (now sees `<basename>.eng.ass`); row badge updates to "Đã extract".
- [ ] On Job failure (mkvextract non-zero exit), Episode row shows a red badge "Lỗi extract" with click-through to view the captured stderr.
- [ ] `EpisodeState` derivation remains a pure function over disk presence + queue snapshot (per the PRD's `derive_state` pseudocode). No state is stored separately.

## Blocked by

- 0006
