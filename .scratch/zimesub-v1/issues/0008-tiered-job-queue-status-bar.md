---
title: "Tiered JobQueue + bottom status bar + Jobs panel + cancel/cleanup"
labels: [done]
type: AFK
blocked_by: [0007]
user_stories: [52, 53, 54, 55, 56, 57, 58]
status: done
---

# 0008 — Tiered JobQueue + bottom status bar + Jobs panel + cancel/cleanup

## Status

Done — shipped on master. Tiered scheduler enforces 1 Render + N Extract Running with N persisted in `settings.json`; bottom status bar + expandable Jobs panel render off a single backend snapshot; cancel kills the process tree and runs per-`JobKind` cleanup; `project_open` walks every EpisodeFolder for stale 0-byte artefacts.

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

Promote the minimal queue from 0007 into the full tiered `JobQueue` per [ADR-0003](../../../docs/adr/0003-tiered-job-queue.md): at most 1 `Render` Running + at most N `ExtractSubtitle`/`ExtractAudio` Running (N defaults to 2, configurable in Settings). Bottom status bar always visible showing aggregate progress + current Job; clicking expands the Jobs panel with pending/running/done/failed lists. Cancelling a Running Job kills the process tree and deletes per-JobKind partial output. Crash recovery on Project open detects orphan partial files and cleans them up.

## Acceptance criteria

- [x] `JobQueue` enforces tiered concurrency: max 1 `Render` Running, max N (default 2; settable in app settings as `queue_concurrency_extract`) `ExtractSubtitle` / `ExtractAudio` Running. Pending jobs dispatch FIFO within each tier.
- [x] Bottom status bar (always visible per `style-guide.md`) shows: count of Running jobs (e.g. "JOBS ●●○○○"), "X / Y" running/total, current top-of-list Job's progress bar with episode + JobKind label. If no jobs, shows the empty placeholder from 0001.
- [x] Clicking the status bar expands a Jobs panel listing pending / running / done / failed jobs, newest at top. Each row: timestamp (relative), episode name (click jumps to that Episode in its Project), JobKind, JobStatus, progress %, action button (cancel for Running, remove for Pending, retry for Failed).
- [x] Cancelling a Running Job: kills the process tree (Windows: `TerminateProcess` via `tokio::process::Child::kill`); per-JobKind cleanup deletes the partial output. Per-kind cleanup table:
  - `ExtractSubtitle` → delete `<basename>.eng.ass`
  - `ExtractAudio` → delete `<basename>.mp3` (audio slice 0009 will reuse this rule)
  - `Render` → delete `<basename>.VietSub.mp4` (render slice 0011 will reuse this rule)
- [x] Removing a Pending Job: just pops from the queue. No process, no cleanup.
- [x] Crash recovery on Project open: scan every EpisodeFolder for files matching the partial-output extensions. v1 heuristic for stale files: a `.mp4` whose size is 0 OR a `.ass` whose size is 0. Stale files are deleted with a log entry.
- [x] Settings panel exposes a numeric input for `queue_concurrency_extract` (range 1–8). Changes take effect for newly-dispatched jobs.
- [x] Done/Failed jobs persist in the panel for the lifetime of the app session (cleared on restart). No persistent history file in v1.
- [x] All UI strings Vietnamese.

## Blocked by

- 0007

## Implementation notes

### Architecture overview

The slice-0007 single-job extract pipeline is promoted into a full tiered scheduler that owns every background process spawn (`ExtractSubtitle` today; `ExtractAudio` slice 0009 and `Render` slice 0011 plug into the same plumbing). The Rust `JobQueue` holds a single shared `QueueState` behind a `tokio::sync::Mutex`; a dispatcher task waits on `Notify` and walks the pending list FIFO per tier promoting whatever fits the current budgets (`1 - running_render_count` for Render, `extract_concurrency - running_extract_count` for the combined extract tier). Two Tauri events drive the UI: `jobs-changed` (full `JobsSnapshot` on every structural change) and `job-progress` (lightweight `{job_id, ratio, hint}` per parsed stderr line). The frontend's `jobsStore` replaces its list wholesale on `jobs-changed` and mutates only the relevant job's progress fields on `job-progress`, keeping cost proportional to actual work.

Per-`JobKind` cleanup on cancel mirrors the AC table verbatim — `cleanup_partial_output` deletes `<basename>.eng.ass` for `ExtractSubtitle`, `<basename>.mp3` for `ExtractAudio`, `<basename>.VietSub.mp4` for `Render`. `ExtractSubtitle` additionally clears the legacy `.eng.srt` intermediate so a future SRT→ASS pipeline never leaks a half-written file.

Crash recovery runs synchronously inside `project_open`: every Episode's folder is scanned (non-recursive) and any `.mp4`/`.ass` whose size is 0 is removed with an `info!` log line. Silent on missing folders so a project whose EpisodeFolder was removed externally still opens.

### Files modified

- `src-tauri/src/job_queue.rs` — Replaced the slice-0007 serial queue with the tiered dispatcher. New types: `JobKind` (discriminator), `Tier`, `JobStatus`, `JobsSnapshot`, `JobView`, `JobSpec`, `ExtractSubtitleSpec`, `InternalJob`. New API: `JobQueue::new(app, initial_extract_concurrency)`, `enqueue`, `cancel`, `remove_pending`, `snapshot`, `set_extract_concurrency`. Constants `DEFAULT_EXTRACT_CONCURRENCY`, `MAX_EXTRACT_CONCURRENCY`, event names. Added `pick_dispatchable`/`promote_to_running`/`spawn_runner` for the dispatcher, `supervise`/`run_extract_subtitle`/`post_process_output`/`cleanup_partial_output` for the runner, plus unit tests covering tier budgets, snapshot ordering, SRT detection, and the cleanup table.
- `src-tauri/src/episode_state.rs` — Added `clean_stale_artifacts(episode_folder) -> Vec<PathBuf>`: the crash-recovery scan. Walks the folder for `.mp4`/`.ass` files at 0 bytes and removes them; logs each deletion at `info`. Silent on missing folders. Unit tests cover zero-byte mp4/ass deletion, real outputs surviving, substring extensions (`foo.mp4.bak`) being ignored, and missing folders.
- `src-tauri/src/settings_store.rs` — Added `queue_concurrency_extract: u8` field on `Settings` with `#[serde(default = "default_queue_concurrency_extract")]` so legacy installs load with the default `2`. Constant `DEFAULT_QUEUE_CONCURRENCY_EXTRACT`. Unit tests cover the legacy-load + round-trip cases.
- `src-tauri/src/commands.rs` — Lazy `OnceLock<Arc<JobQueue>>` on `AppState` (seeded from the persisted `queue_concurrency_extract` on first use). New commands: `job_snapshot`, `job_cancel`, `job_remove_pending`, `settings_get_queue_concurrency`, `settings_set_queue_concurrency`. `project_open` now calls `episode_state::clean_stale_artifacts` for every Episode folder before returning the manifest. `extract_subtitle_start` now wraps `JobQueue::enqueue(JobSpec::ExtractSubtitle(spec))`.
- `src-tauri/src/lib.rs` — Registered the five new commands in `invoke_handler!`.
- `src/api/extract.ts` — Kept `extract_subtitle_start` / `extract_subtitle_cancel` / `episode_inspect_artifacts` wrappers, removed the slice-0007 event subscriptions (now lives in `@api/jobs.ts`). Updated docstrings to point at the generic job events.
- `src/stores/jobs.ts` — Rewrote as the global jobs mirror. Holds `jobs: JobView[]`, `extractConcurrency`, per-Episode `artifacts` cache, `dontAskOverwrite` set, `activeFolder`. Derived selectors `queueSummary`, `topRunningJob`, `jobStateFor(episodeId)`, `artifactStateFor`. Actions `startExtractSubtitle`, `cancelExtractSubtitle`, `cancelJobById`, `removePendingJobById`, `retryJob`, `setActiveProject`, `refreshArtifactsForEpisode`. `ensureJobSubscriptions()` binds `jobs-changed` + `job-progress` listeners and pulls the initial snapshot. `handleSnapshot` re-inspects the disk for every Episode whose job flipped terminal in this tick so the row badge keeps up.
- `src/components/shell/StatusBar.tsx` — Replaced the slice-0001 placeholder with the full status bar. Reads `queueSummary` + `topRunningJob` reactively, renders `JOBS ●●○○○` (5-dot baseline, filled count = running jobs), `X / Y` counter, top-job slot (episode label + JobKind tag + live progress bar + percent). Clicking the left cluster toggles the Jobs panel via `onToggleJobsPanel`; gear icon (right) opens Settings.
- `src/components/shell/AppShell.tsx` — Added `jobsPanelOpen` signal, mounted `<JobsPanel>` alongside `<SettingsModal>`. Boots `ensureJobSubscriptions()` and `bootstrapSettings()` in `onMount` alongside the existing tool bootstrap. Bridges projects→jobs via a `createEffect(on(...))` that calls `setActiveProject(folder, episodeIds)` whenever the active project changes.
- `src/views/settings/SettingsModal.tsx` — Added `QueueConcurrencyField` section. Local draft state mirrors `settingsStore.queueConcurrencyExtract`; commit goes through `setQueueConcurrencyExtract` (which round-trips to the backend, clamps 1–8, persists, and propagates to the live queue). `−` / `+` buttons step by 1, the numeric input accepts free typing committed on blur or Enter.
- `src/views/onboarding/OnboardingView.tsx`, `src/views/onboarding/ToolRow.tsx`, `src/components/shell/Sidebar.tsx`, `src/design-system/Button.tsx`, `src/design-system/TerminalLog.tsx`, `src/lib/time.ts`, `src/stores/tools.ts`, `src/api/install.ts`, `src/api/opener.ts`, `src/api/tooling.ts`, `src/views/project/CreateProjectModal.tsx` — Minor sweep: docstring updates pointing at the generic job events, removal of slice-0007-only references, lint/formatting consistency. No behavioural change.
- `src-tauri/.gitignore` — Added `/gen/` so Tauri-regenerated permission schemas don't churn the working tree.

### Files created

- `src/api/jobs.ts` — Generic TS bindings: `JobKind`, `JobStatus`, `JobView`, `JobsSnapshot`, `JobProgressEvent` types + `jobSnapshot()`, `jobCancel(id)`, `jobRemovePending(id)`, `onJobsChanged(handler)`, `onJobProgress(handler)`.
- `src/api/settings.ts` — `settingsGetQueueConcurrency()` + `settingsSetQueueConcurrency(value)` bindings.
- `src/stores/settings.ts` — Autonomous settings mirror. Holds `queueConcurrencyExtract` + `loaded` flag; `bootstrapSettings()` pulls the persisted value on AppShell mount; `setQueueConcurrencyExtract(value)` round-trips through the backend and updates the local mirror with the post-clamp value. Exports `MIN_EXTRACT_CONCURRENCY` (1), `MAX_EXTRACT_CONCURRENCY` (8), `DEFAULT_EXTRACT_CONCURRENCY` (2).
- `src/views/jobs-panel/JobsPanel.tsx` — Slide-up overlay above the status bar with four lifecycle buckets (`running` → `pending` → `failed` → `cancelled` → `done`). Each row: relative timestamp ("2 phút trước"), episode name (clickable — jumps to that Episode in its Project, opening the project first if needed), project folder tail, JobKind label, JobStatus pill (toned by status), live progress bar (Running) or check/X icon (Done/Failed), action button (Hủy for Running, Xóa for Pending, Thử lại for Failed/Cancelled). Registers in the modal stack so Escape closes it; backdrop click also dismisses. Empty state matches the slice-0001 placeholder copy.

### Files deleted

- `dist/.gitkeep` — `dist/` is gitignored; the placeholder was a stale artefact from the initial commit. Removed as housekeeping while the working tree was open.
