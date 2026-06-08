---
title: "Tiered JobQueue + bottom status bar + Jobs panel + cancel/cleanup"
labels: [ready-for-agent]
type: AFK
blocked_by: [0007]
user_stories: [52, 53, 54, 55, 56, 57, 58]
---

# 0008 — Tiered JobQueue + bottom status bar + Jobs panel + cancel/cleanup

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

Promote the minimal queue from 0007 into the full tiered `JobQueue` per [ADR-0003](../../../docs/adr/0003-tiered-job-queue.md): at most 1 `Render` Running + at most N `ExtractSubtitle`/`ExtractAudio` Running (N defaults to 2, configurable in Settings). Bottom status bar always visible showing aggregate progress + current Job; clicking expands the Jobs panel with pending/running/done/failed lists. Cancelling a Running Job kills the process tree and deletes per-JobKind partial output. Crash recovery on Project open detects orphan partial files and cleans them up.

## Acceptance criteria

- [ ] `JobQueue` enforces tiered concurrency: max 1 `Render` Running, max N (default 2; settable in app settings as `queue_concurrency_extract`) `ExtractSubtitle` / `ExtractAudio` Running. Pending jobs dispatch FIFO within each tier.
- [ ] Bottom status bar (always visible per `style-guide.md`) shows: count of Running jobs (e.g. "JOBS ●●○○○"), "X / Y" running/total, current top-of-list Job's progress bar with episode + JobKind label. If no jobs, shows the empty placeholder from 0001.
- [ ] Clicking the status bar expands a Jobs panel listing pending / running / done / failed jobs, newest at top. Each row: timestamp (relative), episode name (click jumps to that Episode in its Project), JobKind, JobStatus, progress %, action button (cancel for Running, remove for Pending, retry for Failed).
- [ ] Cancelling a Running Job: kills the process tree (Windows: `TerminateProcess` via `tokio::process::Child::kill`); per-JobKind cleanup deletes the partial output. Per-kind cleanup table:
  - `ExtractSubtitle` → delete `<basename>.eng.ass`
  - `ExtractAudio` → delete `<basename>.mp3` (audio slice 0009 will reuse this rule)
  - `Render` → delete `<basename>.VietSub.mp4` (render slice 0011 will reuse this rule)
- [ ] Removing a Pending Job: just pops from the queue. No process, no cleanup.
- [ ] Crash recovery on Project open: scan every EpisodeFolder for files matching the partial-output extensions. v1 heuristic for stale files: a `.mp4` whose size is 0 OR a `.ass` whose size is 0. Stale files are deleted with a log entry.
- [ ] Settings panel exposes a numeric input for `queue_concurrency_extract` (range 1–8). Changes take effect for newly-dispatched jobs.
- [ ] Done/Failed jobs persist in the panel for the lifetime of the app session (cleared on restart). No persistent history file in v1.
- [ ] All UI strings Vietnamese.

## Blocked by

- 0007
