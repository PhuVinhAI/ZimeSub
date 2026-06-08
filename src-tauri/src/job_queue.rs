//! Tiered background job runner — slice 0008.
//!
//! ADR-0003 calls for a tiered scheduler (at most 1 `Render` Running
//! + at most N `ExtractSubtitle`/`ExtractAudio` Running, with N
//! defaulting to 2 and user-configurable in Settings). This module
//! promotes the slice-0007 serial queue into that shape:
//!
//! ## Architecture
//!
//! 1. A single shared [`QueueState`] holds the full ordered list of
//!    `InternalJob`s along with the configurable
//!    `extract_concurrency` knob. All mutation goes through
//!    `state.lock()` so the snapshot the dispatcher reads and the
//!    state the runners mutate are coherent.
//! 2. A dispatcher task waits on an `Arc<Notify>` and, on wake,
//!    walks the pending list FIFO, promoting jobs to Running as long
//!    as the tier budgets allow:
//!     * `Render` budget: `1 - running_render_count`.
//!     * Extract budget: `extract_concurrency - running_extract_count`
//!       (combined `ExtractSubtitle` + `ExtractAudio`).
//!    Each newly-promoted job is `tokio::spawn`'d as its own task;
//!    on exit the task calls `notify_dispatcher` so freed slots are
//!    immediately consumed by the next FIFO pending job.
//! 3. Events: a high-frequency `job-progress` event (per parsed
//!    stderr line) carries `{ job_id, ratio, hint }` only; every
//!    structural change (enqueue, start, finish, remove) emits a
//!    `jobs-changed` event with the full [`JobsSnapshot`]. The
//!    frontend store replaces its full list on `jobs-changed` and
//!    updates only the relevant job's ratio/hint on `job-progress`,
//!    keeping cost proportional to actual work.
//! 4. Cancel: cancelling a Running job kills the process tree
//!    (Windows: `TerminateProcess` via `tokio::process::Child::kill`)
//!    and the runner's cleanup pass deletes the partial output
//!    matching the [`JobKind`] cleanup table. Cancelling a Pending
//!    job is the same as `remove_pending` — drop from the queue with
//!    no process kill and no on-disk cleanup, per AC.
//! 5. Per-`JobKind` cleanup table (mirrors the AC, applies on cancel
//!    or failed completion of a Running job):
//!     * `ExtractSubtitle` → `<basename>.eng.ass`
//!     * `ExtractAudio`    → `<basename>.mp3`   (audio runner lands in 0009)
//!     * `Render`          → `<basename>.VietSub.mp4` (render runner lands in 0011)
//!
//! Only `ExtractSubtitle` has a runnable [`JobSpec`] variant in slice
//! 0008; the `JobKind` discriminator and the cleanup table are
//! defined for all three from day one so 0009/0011 land without
//! churning the surrounding queue plumbing.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};
use tracing::{error, info, warn};

use crate::ass_ops;
use crate::progress_parsers;

/// Event name fired on every structural change to the queue (enqueue,
/// start, complete, remove). Payload: [`JobsSnapshot`] — the full
/// ordered list so the frontend replaces its store wholesale rather
/// than reconciling individual diffs.
pub const EVENT_JOBS_CHANGED: &str = "jobs-changed";

/// Event name fired once per parsed stderr line for a Running job.
/// Lightweight on purpose — high frequency. Payload:
/// `{ job_id, ratio, hint }`.
pub const EVENT_JOB_PROGRESS: &str = "job-progress";

/// Default tier budget for extract jobs, per ADR-0003 + AC. Users can
/// override via Settings (`queue_concurrency_extract`). The canonical
/// persisted default lives in `settings_store::DEFAULT_QUEUE_CONCURRENCY_EXTRACT`;
/// the two constants are kept in sync.
#[allow(dead_code)]
pub const DEFAULT_EXTRACT_CONCURRENCY: u8 = 2;

/// Upper bound for the user-configurable extract concurrency, per AC
/// ("numeric input for `queue_concurrency_extract`, range 1–8"). Lower
/// bound is enforced as 1 in the setter.
pub const MAX_EXTRACT_CONCURRENCY: u8 = 8;

/// Suppress the transient console flash on Windows when the worker
/// spawns mkvextract — mirrors the same convention `install` and
/// `tooling` already use.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Discriminator for the kind of work a job represents.
///
/// All three variants are recognised by the dispatcher's tier budget
/// + the per-kind cleanup table from day one of slice 0008, but only
/// [`JobKind::ExtractSubtitle`] has a runnable [`JobSpec`] variant —
/// audio and render runners land with slices 0009 and 0011.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    ExtractSubtitle,
    /// Audio extract — runnable spec lands in slice 0009.
    #[allow(dead_code)]
    ExtractAudio,
    /// Hardsub render — runnable spec lands in slice 0011.
    #[allow(dead_code)]
    Render,
}

impl JobKind {
    /// Tier classification used by the dispatcher budgeting.
    fn tier(self) -> Tier {
        match self {
            JobKind::ExtractSubtitle | JobKind::ExtractAudio => Tier::Extract,
            JobKind::Render => Tier::Render,
        }
    }

    /// Per-kind partial-output filename derived from `basename`.
    /// Used by the cleanup pass on cancel / failed completion of a
    /// Running job. The mapping mirrors the AC's per-kind cleanup
    /// table verbatim.
    fn partial_output_filename(self, basename: &str) -> String {
        match self {
            JobKind::ExtractSubtitle => format!("{basename}.eng.ass"),
            JobKind::ExtractAudio => format!("{basename}.mp3"),
            JobKind::Render => format!("{basename}.VietSub.mp4"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tier {
    Render,
    Extract,
}

/// Lifecycle status carried in [`JobView`] and the [`InternalJob`]
/// state machine. Mirrors ADR-0003's `Pending | Running | Done |
/// Failed | Cancelled` shape exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Pending,
    Running,
    Done,
    Failed,
    Cancelled,
}

/// Concrete spec for an `ExtractSubtitle` job. All paths are absolute
/// so the runner never has to consult the project store mid-run.
#[derive(Clone, Debug)]
pub struct ExtractSubtitleSpec {
    pub job_id: String,
    pub episode_id: String,
    pub episode_name: String,
    pub project_folder: PathBuf,
    pub mkvextract_path: PathBuf,
    pub source_mkv_path: PathBuf,
    pub episode_folder: PathBuf,
    pub mkv_track_id: u32,
    /// Filename stem used for both the EpisodeFolder name and the
    /// output artefact (`<basename>.eng.ass`). Matches
    /// `EpisodeRecord::folder_name` from `project_store`.
    pub output_basename: String,
}

/// Per-kind runnable specs. Only `ExtractSubtitle` is implemented in
/// slice 0008; the `ExtractAudio` and `Render` variants will be added
/// by their owning slices.
#[derive(Clone, Debug)]
pub enum JobSpec {
    ExtractSubtitle(ExtractSubtitleSpec),
}

impl JobSpec {
    fn kind(&self) -> JobKind {
        match self {
            JobSpec::ExtractSubtitle(_) => JobKind::ExtractSubtitle,
        }
    }

    fn job_id(&self) -> &str {
        match self {
            JobSpec::ExtractSubtitle(s) => &s.job_id,
        }
    }

    fn episode_id(&self) -> &str {
        match self {
            JobSpec::ExtractSubtitle(s) => &s.episode_id,
        }
    }

    fn episode_name(&self) -> &str {
        match self {
            JobSpec::ExtractSubtitle(s) => &s.episode_name,
        }
    }

    fn project_folder(&self) -> PathBuf {
        match self {
            JobSpec::ExtractSubtitle(s) => s.project_folder.clone(),
        }
    }
}

/// Serialized projection of one job — what the frontend's Jobs panel
/// renders. The `spec` is *not* exposed; only the fields the UI
/// actually reads (episode display name, project folder for
/// navigation, status, progress, timing, error context).
#[derive(Clone, Debug, Serialize)]
pub struct JobView {
    pub id: String,
    pub kind: JobKind,
    pub episode_id: String,
    pub episode_name: String,
    pub project_folder: String,
    pub status: JobStatus,
    pub ratio: f32,
    pub hint: String,
    pub error: Option<String>,
    /// Captured stderr text — the failure-modal viewer renders this
    /// verbatim in a `TerminalLog` so the user can read the
    /// underlying tool complaint without a second IPC round-trip.
    pub stderr: String,
    pub exit_code: Option<i32>,
    /// Unix milliseconds of `enqueue()` — drives the relative
    /// timestamp column in the Jobs panel ("3 phút trước").
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    /// `true` when the terminal status is the result of a cancel
    /// rather than the runner finishing on its own. Always false for
    /// `Done` / `Failed`; matches the `JobStatus::Cancelled` arm.
    pub cancelled: bool,
}

/// Serialized snapshot of the full queue — payload for the
/// `jobs-changed` event.
#[derive(Clone, Debug, Serialize)]
pub struct JobsSnapshot {
    pub jobs: Vec<JobView>,
    /// Echo of the current `extract_concurrency` so the status bar's
    /// "JOBS ●●○○○" indicator can render the right number of dots
    /// without a second `settings_get` round-trip.
    pub extract_concurrency: u8,
}

/// Internal job state — owns the runnable spec, the live cancel
/// handles, and the mutable status/progress fields the dispatcher +
/// runners flip. Never serialised directly; see [`JobView`].
struct InternalJob {
    id: String,
    kind: JobKind,
    spec: JobSpec,
    episode_id: String,
    episode_name: String,
    project_folder: String,
    status: JobStatus,
    ratio: f32,
    hint: String,
    error: Option<String>,
    stderr: String,
    exit_code: Option<i32>,
    created_at: i64,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    cancelled: bool,
    cancel_notify: Arc<Notify>,
    cancelled_flag: Arc<AtomicBool>,
}

impl InternalJob {
    fn to_view(&self) -> JobView {
        JobView {
            id: self.id.clone(),
            kind: self.kind,
            episode_id: self.episode_id.clone(),
            episode_name: self.episode_name.clone(),
            project_folder: self.project_folder.clone(),
            status: self.status,
            ratio: self.ratio,
            hint: self.hint.clone(),
            error: self.error.clone(),
            stderr: self.stderr.clone(),
            exit_code: self.exit_code,
            created_at: self.created_at,
            started_at: self.started_at,
            completed_at: self.completed_at,
            cancelled: self.cancelled,
        }
    }
}

/// Shared queue state behind a single async `Mutex` — both the
/// dispatcher and the per-job runners take this lock to read +
/// mutate. Lock holds are intentionally short; long-running I/O
/// (mkvextract, ffmpeg) happens outside the critical section.
struct QueueState {
    jobs: Vec<InternalJob>,
    extract_concurrency: u8,
}

impl QueueState {
    fn running_count(&self, tier: Tier) -> u8 {
        self.jobs
            .iter()
            .filter(|j| j.status == JobStatus::Running && j.kind.tier() == tier)
            .count() as u8
    }

    /// Indexes of pending jobs (FIFO order) that match `tier`. The
    /// dispatcher consumes these front-to-back as long as the tier
    /// budget allows.
    fn pending_indexes(&self, tier: Tier) -> Vec<usize> {
        self.jobs
            .iter()
            .enumerate()
            .filter(|(_, j)| j.status == JobStatus::Pending && j.kind.tier() == tier)
            .map(|(i, _)| i)
            .collect()
    }

    fn snapshot(&self) -> JobsSnapshot {
        // Newest-first ordering matches the Jobs panel AC ("newest at
        // top"). The internal `jobs` vec is kept oldest-first so FIFO
        // dispatch is a trivial front-to-back walk; we sort on the
        // way out.
        let mut views: Vec<JobView> = self.jobs.iter().map(InternalJob::to_view).collect();
        views.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        JobsSnapshot {
            jobs: views,
            extract_concurrency: self.extract_concurrency,
        }
    }
}

/// Tiered job queue + dispatcher. Construct once per app via
/// [`JobQueue::new`]; the resulting `Arc` handle is stored on
/// `commands::AppState` and shared by all command handlers.
pub struct JobQueue {
    app: AppHandle,
    state: Arc<Mutex<QueueState>>,
    dispatch_notify: Arc<Notify>,
}

impl JobQueue {
    /// Spawn the dispatcher task and return an `Arc` handle.
    /// `initial_extract_concurrency` is the persisted user setting
    /// (clamped 1..=8 by the setter; clamped here too as defence in
    /// depth).
    pub fn new(app: AppHandle, initial_extract_concurrency: u8) -> Arc<Self> {
        let state = Arc::new(Mutex::new(QueueState {
            jobs: Vec::new(),
            extract_concurrency: clamp_extract_concurrency(initial_extract_concurrency),
        }));
        let dispatch_notify = Arc::new(Notify::new());
        let queue = Arc::new(Self {
            app,
            state,
            dispatch_notify,
        });

        let dispatcher_queue = queue.clone();
        tauri::async_runtime::spawn(async move {
            dispatcher_loop(dispatcher_queue).await;
        });

        queue
    }

    /// Enqueue `spec` as a new Pending job. Emits `jobs-changed`
    /// and pokes the dispatcher.
    pub async fn enqueue(&self, spec: JobSpec) {
        let now = now_ms();
        let kind = spec.kind();
        let job = InternalJob {
            id: spec.job_id().to_string(),
            kind,
            episode_id: spec.episode_id().to_string(),
            episode_name: spec.episode_name().to_string(),
            project_folder: spec.project_folder().to_string_lossy().into_owned(),
            status: JobStatus::Pending,
            ratio: 0.0,
            hint: String::new(),
            error: None,
            stderr: String::new(),
            exit_code: None,
            created_at: now,
            started_at: None,
            completed_at: None,
            cancelled: false,
            cancel_notify: Arc::new(Notify::new()),
            cancelled_flag: Arc::new(AtomicBool::new(false)),
            spec,
        };
        {
            let mut state = self.state.lock().await;
            state.jobs.push(job);
        }
        self.emit_snapshot().await;
        self.dispatch_notify.notify_one();
    }

    /// Cancel a Pending or Running job by id. Pending → drop from
    /// queue (no process, no cleanup). Running → mark cancellation
    /// flag + notify the runner's supervisor so it kills the child
    /// and runs the per-kind cleanup pass. Idempotent: cancelling an
    /// unknown / already-finished job is a no-op.
    pub async fn cancel(&self, job_id: &str) -> bool {
        // We need to know the status to pick between drop-pending vs
        // notify-running. Take the lock briefly to read it + tweak
        // the flags atomically, then drop the lock before emitting.
        let outcome = {
            let mut state = self.state.lock().await;
            let Some(idx) = state.jobs.iter().position(|j| j.id == job_id) else {
                return false;
            };
            let job = &state.jobs[idx];
            match job.status {
                JobStatus::Pending => {
                    state.jobs.remove(idx);
                    CancelOutcome::Removed
                }
                JobStatus::Running => {
                    job.cancelled_flag.store(true, Ordering::SeqCst);
                    job.cancel_notify.notify_waiters();
                    CancelOutcome::Signalled
                }
                _ => CancelOutcome::AlreadyTerminal,
            }
        };

        match outcome {
            CancelOutcome::Removed => {
                self.emit_snapshot().await;
                self.dispatch_notify.notify_one();
                true
            }
            CancelOutcome::Signalled | CancelOutcome::AlreadyTerminal => {
                // Running → runner emits jobs-changed itself when it
                // unwinds. Already-terminal → no change to emit.
                matches!(outcome, CancelOutcome::Signalled)
            }
        }
    }

    /// Remove a Pending job from the queue without touching the
    /// process or on-disk state. Returns `true` when the id matched
    /// a Pending row. Running / Done / Failed / Cancelled rows are
    /// left alone — the caller (frontend) should call [`cancel`] for
    /// Running jobs and accept terminal rows as immovable.
    pub async fn remove_pending(&self, job_id: &str) -> bool {
        let removed = {
            let mut state = self.state.lock().await;
            let Some(idx) = state.jobs.iter().position(|j| j.id == job_id) else {
                return false;
            };
            if state.jobs[idx].status != JobStatus::Pending {
                return false;
            }
            state.jobs.remove(idx);
            true
        };
        if removed {
            self.emit_snapshot().await;
            self.dispatch_notify.notify_one();
        }
        removed
    }

    /// Snapshot of the queue (newest-first). Drives `job_snapshot`
    /// Tauri command — UI uses this on mount to populate the panel
    /// before the first event arrives, in case the user opens the
    /// panel after the first jobs have already been enqueued.
    pub async fn snapshot(&self) -> JobsSnapshot {
        let state = self.state.lock().await;
        state.snapshot()
    }

    /// Update the extract-tier budget at runtime — wired to the
    /// Settings panel numeric input. Clamps to `1..=MAX` and pokes
    /// the dispatcher so freed slots are immediately consumed.
    /// Emits `jobs-changed` so the status bar's "●●○○○" indicator
    /// re-renders with the new dot count.
    pub async fn set_extract_concurrency(&self, value: u8) {
        let clamped = clamp_extract_concurrency(value);
        {
            let mut state = self.state.lock().await;
            if state.extract_concurrency == clamped {
                return;
            }
            state.extract_concurrency = clamped;
        }
        self.emit_snapshot().await;
        self.dispatch_notify.notify_one();
    }

    async fn emit_snapshot(&self) {
        let snapshot = {
            let state = self.state.lock().await;
            state.snapshot()
        };
        if let Err(e) = self.app.emit(EVENT_JOBS_CHANGED, &snapshot) {
            error!(error = %e, "failed to emit jobs-changed event");
        }
    }
}

enum CancelOutcome {
    Removed,
    Signalled,
    AlreadyTerminal,
}

fn clamp_extract_concurrency(value: u8) -> u8 {
    value.clamp(1, MAX_EXTRACT_CONCURRENCY)
}

/// Wall-clock unix milliseconds (UTC). Used as the `created_at` /
/// `started_at` / `completed_at` timestamps so the panel can render
/// "X giây trước" relative deltas off a single monotonic clock.
fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Dispatcher main loop. Idle on the notify, then walk pending jobs
/// FIFO promoting whatever fits the current tier budgets.
async fn dispatcher_loop(queue: Arc<JobQueue>) {
    loop {
        // Drain whatever can run right now, then go to sleep until
        // the next enqueue / completion / concurrency change.
        loop {
            let to_dispatch = {
                let mut state = queue.state.lock().await;
                pick_dispatchable(&mut state)
            };

            if to_dispatch.is_empty() {
                break;
            }

            // We already updated each job's status to Running in
            // `pick_dispatchable` so the snapshot reflects the
            // running state before the runner emits its first
            // progress event.
            queue.emit_snapshot().await;

            for job_id in to_dispatch {
                spawn_runner(queue.clone(), job_id);
            }
        }
        queue.dispatch_notify.notified().await;
    }
}

/// Promote as many pending jobs to Running as the tier budgets
/// allow. Returns the ids of the promoted jobs so the caller can
/// spawn their runner tasks outside the lock.
fn pick_dispatchable(state: &mut QueueState) -> Vec<String> {
    let mut dispatched: Vec<String> = Vec::new();

    // Render tier first — heavy GPU work is the limiting factor and
    // promoting it before extract jobs avoids a starvation pattern
    // where a flood of Pending Extracts pushes a queued Render
    // behind them inside the snapshot ordering. Inside a tier the
    // walk is strict FIFO over `state.jobs.iter()`.
    let render_budget = 1u8.saturating_sub(state.running_count(Tier::Render));
    if render_budget > 0 {
        let render_pending = state.pending_indexes(Tier::Render);
        for (taken, idx) in render_pending.into_iter().enumerate() {
            if taken as u8 >= render_budget {
                break;
            }
            promote_to_running(state, idx, &mut dispatched);
        }
    }

    let extract_budget = state
        .extract_concurrency
        .saturating_sub(state.running_count(Tier::Extract));
    if extract_budget > 0 {
        let extract_pending = state.pending_indexes(Tier::Extract);
        for (taken, idx) in extract_pending.into_iter().enumerate() {
            if taken as u8 >= extract_budget {
                break;
            }
            promote_to_running(state, idx, &mut dispatched);
        }
    }

    dispatched
}

fn promote_to_running(state: &mut QueueState, idx: usize, dispatched: &mut Vec<String>) {
    let job = &mut state.jobs[idx];
    job.status = JobStatus::Running;
    job.started_at = Some(now_ms());
    dispatched.push(job.id.clone());
}

fn spawn_runner(queue: Arc<JobQueue>, job_id: String) {
    tauri::async_runtime::spawn(async move {
        // Snapshot the per-job inputs we need while holding the
        // lock, then release before running the I/O so other queue
        // ops (snapshot, cancel) aren't blocked.
        let runner_input = {
            let state = queue.state.lock().await;
            let job = state.jobs.iter().find(|j| j.id == job_id);
            job.map(|j| RunnerInput {
                spec: j.spec.clone(),
                cancel_notify: j.cancel_notify.clone(),
                cancelled_flag: j.cancelled_flag.clone(),
            })
        };
        let Some(input) = runner_input else {
            // Job was removed (e.g. cancelled-as-pending in a race)
            // between promotion and this spawn — nothing to do.
            return;
        };

        let outcome = match input.spec {
            JobSpec::ExtractSubtitle(spec) => {
                run_extract_subtitle(
                    queue.app.clone(),
                    spec,
                    input.cancel_notify,
                    input.cancelled_flag,
                )
                .await
            }
        };

        apply_terminal_outcome(&queue, &job_id, outcome).await;
        queue.emit_snapshot().await;
        queue.dispatch_notify.notify_one();
    });
}

struct RunnerInput {
    spec: JobSpec,
    cancel_notify: Arc<Notify>,
    cancelled_flag: Arc<AtomicBool>,
}

/// Result the runner reports back to the queue so the queue can
/// commit a terminal state transition. Kept separate from
/// [`JobStatus`] so the runner doesn't have to know about the
/// `Pending` arm at all.
struct TerminalOutcome {
    status: JobStatus,
    ratio: f32,
    hint: String,
    error: Option<String>,
    stderr: String,
    exit_code: Option<i32>,
    cancelled: bool,
}

async fn apply_terminal_outcome(queue: &JobQueue, job_id: &str, outcome: TerminalOutcome) {
    let mut state = queue.state.lock().await;
    let Some(job) = state.jobs.iter_mut().find(|j| j.id == job_id) else {
        return;
    };
    job.status = outcome.status;
    job.ratio = outcome.ratio;
    job.hint = outcome.hint;
    job.error = outcome.error;
    job.stderr = outcome.stderr;
    job.exit_code = outcome.exit_code;
    job.cancelled = outcome.cancelled;
    job.completed_at = Some(now_ms());
}

/// Run one `ExtractSubtitle` job to completion (success, failure, or
/// cancellation). The function returns the terminal outcome; the
/// queue dispatcher applies it to the job record and emits the
/// `jobs-changed` event.
async fn run_extract_subtitle(
    app: AppHandle,
    spec: ExtractSubtitleSpec,
    cancel: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
) -> TerminalOutcome {
    let output_ass = spec
        .episode_folder
        .join(format!("{}.eng.ass", spec.output_basename));

    // Short-circuit: cancellation that arrived between promotion
    // and the runner starting. The promotion already flipped the
    // status to Running so the user briefly saw "Đang chạy"; the
    // terminal outcome now flips it to Cancelled with no on-disk
    // side-effects.
    if cancelled.load(Ordering::SeqCst) {
        return TerminalOutcome {
            status: JobStatus::Cancelled,
            ratio: 0.0,
            hint: String::new(),
            error: None,
            stderr: String::new(),
            exit_code: None,
            cancelled: true,
        };
    }

    let arg_target = format!("{}:{}", spec.mkv_track_id, output_ass.to_string_lossy());
    let args = [
        "tracks".to_string(),
        spec.source_mkv_path.to_string_lossy().into_owned(),
        arg_target,
    ];

    info!(
        job_id = spec.job_id,
        episode_id = spec.episode_id,
        track = spec.mkv_track_id,
        source = %spec.source_mkv_path.display(),
        output = %output_ass.display(),
        "starting extract subtitle job"
    );

    let mut cmd = Command::new(&spec.mkvextract_path);
    cmd.args(&args)
        .current_dir(&spec.episode_folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Không khởi chạy được mkvextract: {e}");
            error!(job_id = spec.job_id, error = %e, "mkvextract spawn failed");
            // Spawn failure has no partial output to clean up
            // (the process never created the file).
            return TerminalOutcome {
                status: JobStatus::Failed,
                ratio: 0.0,
                hint: String::new(),
                error: Some(msg),
                stderr: String::new(),
                exit_code: None,
                cancelled: false,
            };
        }
    };

    let supervised = supervise(app.clone(), &spec, child, cancel, cancelled).await;
    let final_outcome = if supervised.success {
        match post_process_output(&output_ass) {
            Ok(()) => supervised,
            Err(msg) => {
                error!(
                    job_id = spec.job_id,
                    error = msg,
                    "post-extract SRT→ASS conversion failed"
                );
                Supervised {
                    success: false,
                    cancelled: false,
                    exit_code: supervised.exit_code,
                    error: Some(msg),
                    stderr: supervised.stderr,
                    ratio: supervised.ratio,
                    hint: supervised.hint,
                }
            }
        }
    } else {
        supervised
    };

    if !final_outcome.success {
        cleanup_partial_output(JobKind::ExtractSubtitle, &spec.episode_folder, &spec.output_basename);
    }

    info!(
        job_id = spec.job_id,
        episode_id = spec.episode_id,
        success = final_outcome.success,
        cancelled = final_outcome.cancelled,
        exit_code = ?final_outcome.exit_code,
        "extract subtitle job finished"
    );

    let status = if final_outcome.cancelled {
        JobStatus::Cancelled
    } else if final_outcome.success {
        JobStatus::Done
    } else {
        JobStatus::Failed
    };

    TerminalOutcome {
        status,
        ratio: if final_outcome.success {
            1.0
        } else {
            final_outcome.ratio
        },
        hint: final_outcome.hint,
        error: final_outcome.error,
        stderr: final_outcome.stderr,
        exit_code: final_outcome.exit_code,
        cancelled: final_outcome.cancelled,
    }
}

/// Mid-flight outcome from the child supervisor — folded into the
/// runner's terminal `TerminalOutcome` after the post-process step.
struct Supervised {
    success: bool,
    cancelled: bool,
    exit_code: Option<i32>,
    error: Option<String>,
    stderr: String,
    ratio: f32,
    hint: String,
}

/// Drive the child to completion, racing against the cancel signal.
/// Drains stdout / stderr concurrently with the child so neither pipe
/// can back-pressure the process; stderr lines additionally feed the
/// progress parser + the failure-modal buffer.
async fn supervise(
    app: AppHandle,
    spec: &ExtractSubtitleSpec,
    mut child: tokio::process::Child,
    cancel: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
) -> Supervised {
    let stderr = child.stderr.take().expect("piped above; take-once contract");
    let stdout = child.stdout.take().expect("piped above; take-once contract");

    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let progress_buf: Arc<Mutex<(f32, String)>> = Arc::new(Mutex::new((0.0, String::new())));
    let stderr_buf_for_task = stderr_buf.clone();
    let progress_buf_for_task = progress_buf.clone();
    let app_for_stderr = app.clone();
    let job_id_for_stderr = spec.job_id.clone();

    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    {
                        let mut buf = stderr_buf_for_task.lock().await;
                        buf.push_str(&line);
                        buf.push('\n');
                    }
                    if let Some(progress) = progress_parsers::parse_mkvextract(&line) {
                        {
                            let mut latest = progress_buf_for_task.lock().await;
                            *latest = (progress.ratio, progress.hint.clone());
                        }
                        emit_progress(
                            &app_for_stderr,
                            &job_id_for_stderr,
                            progress.ratio,
                            progress.hint,
                        );
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    warn!(error = %e, "extract stderr reader failed");
                    break;
                }
            }
        }
    });

    let stdout_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(_)) = lines.next_line().await {}
    });

    let cancel_signal = cancel.notified();
    tokio::pin!(cancel_signal);

    let (exit_code, was_cancelled, runtime_error) = tokio::select! {
        biased;
        _ = &mut cancel_signal => {
            warn!(job_id = spec.job_id, "extract cancellation received");
            let _ = child.start_kill();
            match child.wait().await {
                Ok(status) => (status.code(), true, None),
                Err(e) => (None, true, Some(format!("Lỗi khi chờ mkvextract thoát: {e}"))),
            }
        }
        wait_result = child.wait() => {
            match wait_result {
                Ok(status) => {
                    // Tolerate a cancel that arrived between the
                    // `select!` arms — if the flag flipped right
                    // before the child exited on its own, still treat
                    // the outcome as cancelled.
                    let was_cancelled = cancelled.load(Ordering::SeqCst);
                    (status.code(), was_cancelled, None)
                }
                Err(e) => (None, false, Some(format!("Lỗi khi chờ mkvextract thoát: {e}"))),
            }
        }
    };

    let _ = tokio::join!(stderr_task, stdout_task);

    let stderr_text = {
        let buf = stderr_buf.lock().await;
        buf.clone()
    };
    let (ratio, hint) = {
        let latest = progress_buf.lock().await;
        latest.clone()
    };

    let success = !was_cancelled && exit_code == Some(0) && runtime_error.is_none();
    let error_msg = runtime_error.or_else(|| {
        if !success && !was_cancelled {
            Some(match exit_code {
                Some(c) => format!("mkvextract trả về exit code {c}"),
                None => "mkvextract kết thúc bất thường".to_string(),
            })
        } else {
            None
        }
    });

    Supervised {
        success,
        cancelled: was_cancelled,
        exit_code,
        error: error_msg,
        stderr: stderr_text,
        ratio,
        hint,
    }
}

/// Inspect the freshly-extracted file and promote it to ASS if the
/// content looks like SRT. SRT detection is intentionally loose
/// (`looks_like_srt` returns true when the first non-empty line is a
/// numeric block index AND the second is a timing line, OR the first
/// line itself is a timing line). Anything else passes through
/// untouched — `.ass` source content lands as-is.
fn post_process_output(output_ass: &std::path::Path) -> Result<(), String> {
    let text = match std::fs::read_to_string(output_ass) {
        Ok(t) => t,
        Err(e) => return Err(format!("Không đọc được file extract: {e}")),
    };
    if !looks_like_srt(&text) {
        return Ok(());
    }
    let ass = ass_ops::srt_to_ass(&text);
    write_atomic(output_ass, ass.as_bytes())
        .map_err(|e| format!("Không ghi được file ASS sau chuyển đổi SRT: {e}"))
}

fn looks_like_srt(text: &str) -> bool {
    let mut iter = text.lines().filter(|l| !l.trim().is_empty());
    let Some(first) = iter.next() else { return false };
    let first_trimmed = first.trim();
    if first_trimmed.starts_with('[') || first_trimmed.eq_ignore_ascii_case("WEBVTT") {
        return false;
    }
    if first_trimmed.parse::<u32>().is_ok() {
        return iter.next().is_some_and(|l| l.contains(" --> "));
    }
    first_trimmed.contains(" --> ")
}

/// Delete the per-`JobKind` partial output file inside
/// `episode_folder`, plus any historical sibling output that earlier
/// pipeline revisions may have written. Idempotent — missing files
/// are silently ignored. Called on any non-success exit so the user
/// is never left staring at a half-written artefact that
/// `derive_state` would misidentify as a real output.
///
/// The mapping mirrors the AC's per-kind cleanup table verbatim.
/// `ExtractSubtitle` additionally clears the legacy `.eng.srt`
/// intermediate name even though slice 0008 extracts straight to
/// `.eng.ass` — listing it means a future change that re-introduces
/// an intermediate SRT won't leak a file on cancel.
fn cleanup_partial_output(kind: JobKind, episode_folder: &std::path::Path, basename: &str) {
    let mut candidates: Vec<PathBuf> = vec![episode_folder.join(kind.partial_output_filename(basename))];
    if kind == JobKind::ExtractSubtitle {
        candidates.push(episode_folder.join(format!("{basename}.eng.srt")));
    }
    for path in &candidates {
        if path.exists()
            && let Err(e) = std::fs::remove_file(path)
        {
            warn!(
                kind = ?kind,
                path = %path.display(),
                error = %e,
                "failed to clean up partial output"
            );
        }
    }
}

/// Atomic-rename write — `tmp + rename` keeps a crash from leaving a
/// half-flushed file behind. Same pattern `project_store` and
/// `settings_store` use for their manifest writes.
fn write_atomic(target: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = target.to_path_buf();
    let file_name = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "extract.tmp".to_string());
    tmp.set_file_name(format!("{file_name}.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, target)?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
struct ProgressEventPayload<'a> {
    job_id: &'a str,
    ratio: f32,
    hint: String,
}

fn emit_progress(app: &AppHandle, job_id: &str, ratio: f32, hint: String) {
    let payload = ProgressEventPayload {
        job_id,
        ratio,
        hint,
    };
    if let Err(e) = app.emit(EVENT_JOB_PROGRESS, &payload) {
        error!(job_id, error = %e, "failed to emit job-progress event");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Map of episode_id → most-recent job summary, useful for
    /// derive-state computations on the frontend without scanning the
    /// full job list. Single helper for tests; the frontend derives
    /// this off the snapshot directly via reactive Solid stores.
    fn job_summaries_by_episode(snapshot: &JobsSnapshot) -> HashMap<String, JobView> {
        let mut out = HashMap::<String, JobView>::new();
        for j in &snapshot.jobs {
            out.entry(j.episode_id.clone()).or_insert_with(|| j.clone());
        }
        out
    }

    fn make_extract_spec(job_id: &str, episode_id: &str) -> ExtractSubtitleSpec {
        ExtractSubtitleSpec {
            job_id: job_id.into(),
            episode_id: episode_id.into(),
            episode_name: format!("ep-{episode_id}"),
            project_folder: PathBuf::from(r"C:\proj"),
            mkvextract_path: PathBuf::from("mkvextract"),
            source_mkv_path: PathBuf::from(r"C:\src\file.mkv"),
            episode_folder: PathBuf::from(r"C:\proj\ep01"),
            mkv_track_id: 2,
            output_basename: "ep01".into(),
        }
    }

    #[test]
    fn job_kind_partial_output_table_matches_ac() {
        assert_eq!(
            JobKind::ExtractSubtitle.partial_output_filename("ep01"),
            "ep01.eng.ass"
        );
        assert_eq!(
            JobKind::ExtractAudio.partial_output_filename("ep01"),
            "ep01.mp3"
        );
        assert_eq!(
            JobKind::Render.partial_output_filename("ep01"),
            "ep01.VietSub.mp4"
        );
    }

    #[test]
    fn extract_concurrency_clamps_into_one_through_eight() {
        assert_eq!(clamp_extract_concurrency(0), 1);
        assert_eq!(clamp_extract_concurrency(1), 1);
        assert_eq!(clamp_extract_concurrency(2), 2);
        assert_eq!(clamp_extract_concurrency(8), 8);
        assert_eq!(clamp_extract_concurrency(9), 8);
        assert_eq!(clamp_extract_concurrency(255), 8);
    }

    #[test]
    fn looks_like_srt_recognises_standard_block() {
        assert!(looks_like_srt("1\n00:00:01,000 --> 00:00:02,000\nHello\n"));
    }

    #[test]
    fn looks_like_srt_recognises_indexless_block() {
        assert!(looks_like_srt("00:00:01,000 --> 00:00:02,000\nHello\n"));
    }

    #[test]
    fn looks_like_srt_rejects_ass_header() {
        let ass = "[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: ...\n";
        assert!(!looks_like_srt(ass));
    }

    #[test]
    fn looks_like_srt_rejects_webvtt() {
        assert!(!looks_like_srt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n"));
    }

    #[test]
    fn cleanup_partial_output_removes_known_candidates() {
        use std::env;
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let dir = env::temp_dir().join(format!("zimesub-cleanup-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ep.eng.ass"), b"partial").unwrap();
        std::fs::write(dir.join("ep.eng.srt"), b"partial").unwrap();
        std::fs::write(dir.join("keepme.txt"), b"safe").unwrap();

        cleanup_partial_output(JobKind::ExtractSubtitle, &dir, "ep");

        assert!(!dir.join("ep.eng.ass").exists());
        assert!(!dir.join("ep.eng.srt").exists());
        assert!(dir.join("keepme.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_for_render_targets_vietsub_mp4_only() {
        use std::env;
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let dir = env::temp_dir().join(format!("zimesub-cleanup-render-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ep.VietSub.mp4"), b"partial").unwrap();
        std::fs::write(dir.join("ep.eng.ass"), b"safe").unwrap();

        cleanup_partial_output(JobKind::Render, &dir, "ep");

        assert!(!dir.join("ep.VietSub.mp4").exists());
        assert!(dir.join("ep.eng.ass").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_orders_newest_first() {
        let now = now_ms();
        let mut state = QueueState {
            jobs: Vec::new(),
            extract_concurrency: 2,
        };
        for i in 0..3 {
            let spec = make_extract_spec(&format!("job-{i}"), &format!("ep-{i}"));
            state.jobs.push(InternalJob {
                id: spec.job_id.clone(),
                kind: JobKind::ExtractSubtitle,
                episode_id: spec.episode_id.clone(),
                episode_name: spec.episode_name.clone(),
                project_folder: spec.project_folder.to_string_lossy().into_owned(),
                status: JobStatus::Pending,
                ratio: 0.0,
                hint: String::new(),
                error: None,
                stderr: String::new(),
                exit_code: None,
                created_at: now + i,
                started_at: None,
                completed_at: None,
                cancelled: false,
                cancel_notify: Arc::new(Notify::new()),
                cancelled_flag: Arc::new(AtomicBool::new(false)),
                spec: JobSpec::ExtractSubtitle(spec),
            });
        }
        let snap = state.snapshot();
        assert_eq!(snap.jobs[0].id, "job-2");
        assert_eq!(snap.jobs[1].id, "job-1");
        assert_eq!(snap.jobs[2].id, "job-0");
    }

    #[test]
    fn pick_dispatchable_respects_render_and_extract_budgets() {
        let now = now_ms();
        let mut state = QueueState {
            jobs: Vec::new(),
            extract_concurrency: 2,
        };
        let mut push = |id: &str, kind: JobKind, status: JobStatus, created: i64| {
            let spec = make_extract_spec(id, "ep");
            state.jobs.push(InternalJob {
                id: spec.job_id.clone(),
                kind,
                episode_id: spec.episode_id.clone(),
                episode_name: spec.episode_name.clone(),
                project_folder: spec.project_folder.to_string_lossy().into_owned(),
                status,
                ratio: 0.0,
                hint: String::new(),
                error: None,
                stderr: String::new(),
                exit_code: None,
                created_at: created,
                started_at: None,
                completed_at: None,
                cancelled: false,
                cancel_notify: Arc::new(Notify::new()),
                cancelled_flag: Arc::new(AtomicBool::new(false)),
                spec: JobSpec::ExtractSubtitle(spec),
            });
        };

        // 1 already-running Render saturates that tier.
        push("r-running", JobKind::Render, JobStatus::Running, now);
        // Another Render is pending — it must NOT be dispatched (budget = 0).
        push("r-pending", JobKind::Render, JobStatus::Pending, now + 1);
        // Three pending extracts; budget = 2 so only the first two go.
        push("e1", JobKind::ExtractSubtitle, JobStatus::Pending, now + 2);
        push("e2", JobKind::ExtractAudio, JobStatus::Pending, now + 3);
        push("e3", JobKind::ExtractSubtitle, JobStatus::Pending, now + 4);

        let dispatched = pick_dispatchable(&mut state);
        assert_eq!(dispatched.len(), 2);
        assert!(dispatched.contains(&"e1".to_string()));
        assert!(dispatched.contains(&"e2".to_string()));
        assert!(!dispatched.contains(&"r-pending".to_string()));
        assert!(!dispatched.contains(&"e3".to_string()));

        // Statuses on the picked jobs should now be Running.
        for id in ["e1", "e2"] {
            let job = state.jobs.iter().find(|j| j.id == id).unwrap();
            assert_eq!(job.status, JobStatus::Running);
            assert!(job.started_at.is_some());
        }
    }

    #[test]
    fn pick_dispatchable_promotes_pending_render_when_slot_free() {
        let now = now_ms();
        let mut state = QueueState {
            jobs: Vec::new(),
            extract_concurrency: 2,
        };
        let mut push = |id: &str, kind: JobKind, status: JobStatus, created: i64| {
            let spec = make_extract_spec(id, "ep");
            state.jobs.push(InternalJob {
                id: spec.job_id.clone(),
                kind,
                episode_id: spec.episode_id.clone(),
                episode_name: spec.episode_name.clone(),
                project_folder: spec.project_folder.to_string_lossy().into_owned(),
                status,
                ratio: 0.0,
                hint: String::new(),
                error: None,
                stderr: String::new(),
                exit_code: None,
                created_at: created,
                started_at: None,
                completed_at: None,
                cancelled: false,
                cancel_notify: Arc::new(Notify::new()),
                cancelled_flag: Arc::new(AtomicBool::new(false)),
                spec: JobSpec::ExtractSubtitle(spec),
            });
        };
        push("r1", JobKind::Render, JobStatus::Pending, now);
        push("e1", JobKind::ExtractSubtitle, JobStatus::Running, now + 1);

        let dispatched = pick_dispatchable(&mut state);
        // Render slot free → r1 promoted. Extract has 1 running of 2
        // budget so one more would fit, but no pending extract to take.
        assert_eq!(dispatched, vec!["r1".to_string()]);
    }

    #[test]
    fn job_summaries_by_episode_keeps_newest_per_episode() {
        let now = now_ms();
        let mut state = QueueState {
            jobs: Vec::new(),
            extract_concurrency: 2,
        };
        for (i, (id, ep)) in [
            ("j0", "epA"),
            ("j1", "epA"),
            ("j2", "epB"),
        ]
        .iter()
        .enumerate()
        {
            let spec = make_extract_spec(id, ep);
            state.jobs.push(InternalJob {
                id: spec.job_id.clone(),
                kind: JobKind::ExtractSubtitle,
                episode_id: spec.episode_id.clone(),
                episode_name: spec.episode_name.clone(),
                project_folder: spec.project_folder.to_string_lossy().into_owned(),
                status: JobStatus::Pending,
                ratio: 0.0,
                hint: String::new(),
                error: None,
                stderr: String::new(),
                exit_code: None,
                created_at: now + i as i64,
                started_at: None,
                completed_at: None,
                cancelled: false,
                cancel_notify: Arc::new(Notify::new()),
                cancelled_flag: Arc::new(AtomicBool::new(false)),
                spec: JobSpec::ExtractSubtitle(spec),
            });
        }
        let snap = state.snapshot();
        let summaries = job_summaries_by_episode(&snap);
        // The snapshot lists newest-first, so the first encountered
        // job for epA is j1 (the newer one); epB has only j2.
        assert_eq!(summaries["epA"].id, "j1");
        assert_eq!(summaries["epB"].id, "j2");
    }
}
