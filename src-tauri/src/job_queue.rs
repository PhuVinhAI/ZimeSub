//! Background job runner — slice 0007 minimal (serial extract-subtitle).
//!
//! ADR-0003 calls for a tiered scheduler (`max 1 Render + N Extract`
//! concurrent). Slice 0007 ships only the `ExtractSubtitle` job kind
//! and runs jobs serially via a single worker task — enough for the
//! per-Episode "Trích xuất sub" flow without prematurely committing
//! to the tiered concurrency surface. The full scheduler lands in
//! slice 0008 alongside the bottom-bar Jobs panel; the `JobKind`
//! discriminator and the `controls` map make that drop-in.
//!
//! ## Architecture
//!
//! 1. The frontend invokes `extract_subtitle_start(job_id, ...)`.
//!    Backend resolves the episode targets + `mkvextract` tool path
//!    and calls [`JobQueue::enqueue_extract_subtitle`]. The cancel
//!    handle is registered atomically with the enqueue.
//! 2. A single worker task drains the channel and runs jobs one at a
//!    time. For each job it:
//!     * Emits `job-started` so the row's progress bar appears.
//!     * Spawns `mkvextract tracks <src> <track>:<out.ass>` via
//!       `tokio::process::Command` with cwd = EpisodeFolder.
//!     * Reads stderr line-by-line, runs each line through
//!       [`crate::progress_parsers::parse_mkvextract`], emits a
//!       `job-progress` event per parse hit, and accumulates the
//!       full stderr text for the failure-modal payload.
//!     * On clean exit, post-processes the on-disk file: if the
//!       content looks like SRT, runs [`crate::ass_ops::srt_to_ass`]
//!       and rewrites in place. The on-disk artefact is always
//!       `<basename>.eng.ass` regardless of source codec.
//!     * On failure / cancel, deletes the partial output files so
//!       `EpisodeState::derive` does not falsely promote the row to
//!       `Extracted` next time it inspects the folder.
//! 3. Cancellation: per-job `Arc<Notify>` for in-flight wake-ups,
//!    backed by an `Arc<AtomicBool>` so a cancel that arrives before
//!    the worker picks the job up is still observed. The supervisor
//!    races `child.wait()` against the notify, kills the process on
//!    cancel, and the cleanup pass takes care of the on-disk files.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, Notify, mpsc};
use tracing::{error, info, warn};

use crate::ass_ops;
use crate::progress_parsers;

/// Event name fired once per job, right before mkvextract spawns.
/// The frontend uses this to flip the row from `queued` → `running`
/// so the progress bar appears even before the first percentage
/// crosses the wire.
pub const EVENT_STARTED: &str = "job-started";

/// Event name fired once per parsed progress line. Payload carries
/// `{ job_id, episode_id, ratio, hint }`.
pub const EVENT_PROGRESS: &str = "job-progress";

/// Event name fired once per job at completion (success, failure, or
/// cancellation). Payload carries `{ job_id, episode_id, success,
/// cancelled, exit_code, error, stderr }`.
pub const EVENT_DONE: &str = "job-done";

/// Suppress the transient console flash on Windows when the worker
/// spawns mkvextract — mirrors the same convention `install` and
/// `tooling` already use.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Discriminator for the kind of work a job represents. Only
/// [`JobKind::ExtractSubtitle`] is implemented in slice 0007; the
/// other variants (audio extract / render) land with the slices
/// that own their pipelines and will appear here without churning
/// the surrounding queue plumbing.
///
/// `#[allow(dead_code)]` because the discriminator isn't read in the
/// current single-kind queue — once the tiered scheduler arrives in
/// 0008 the worker selects between branches on `kind`.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    ExtractSubtitle,
}

/// Concrete spec for an `ExtractSubtitle` job. All paths are absolute
/// so the worker never has to consult the project store mid-run.
#[derive(Clone, Debug)]
pub struct ExtractSubtitleSpec {
    pub job_id: String,
    pub episode_id: String,
    pub mkvextract_path: PathBuf,
    pub source_mkv_path: PathBuf,
    pub episode_folder: PathBuf,
    pub mkv_track_id: u32,
    /// Filename stem used for both the EpisodeFolder name and the
    /// output artefact (`<basename>.eng.ass`). Matches
    /// `EpisodeRecord::folder_name` from `project_store`.
    pub output_basename: String,
}

impl ExtractSubtitleSpec {
    fn output_ass(&self) -> PathBuf {
        self.episode_folder
            .join(format!("{}.eng.ass", self.output_basename))
    }
}

/// Per-job cancellation primitive. The `cancelled` flag is the
/// source of truth for "should this job stop?"; the [`Notify`] is
/// the wake-up channel the supervisor [`tokio::select!`]'s on.
struct JobControl {
    cancel: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
}

/// Serial job runner. A single worker task drains an mpsc channel
/// and executes one job at a time. Cancellation handles live in a
/// shared map so external callers (Tauri commands) can flip a job's
/// state by id regardless of whether it's still queued or already
/// running.
pub struct JobQueue {
    tx: mpsc::UnboundedSender<ExtractSubtitleSpec>,
    controls: Arc<Mutex<HashMap<String, JobControl>>>,
}

impl JobQueue {
    /// Spawn the singleton worker task and return an `Arc` handle.
    /// Call once per app instance — the resulting handle is stored
    /// on `commands::AppState` via `OnceLock` so subsequent commands
    /// reuse the same worker.
    pub fn new(app: AppHandle) -> Arc<Self> {
        let (tx, mut rx) = mpsc::unbounded_channel::<ExtractSubtitleSpec>();
        let controls = Arc::new(Mutex::new(HashMap::<String, JobControl>::new()));

        let controls_for_worker = controls.clone();
        let app_for_worker = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(spec) = rx.recv().await {
                let control_handles = {
                    let map = controls_for_worker.lock().await;
                    map.get(&spec.job_id)
                        .map(|c| (c.cancel.clone(), c.cancelled.clone()))
                };
                let Some((cancel, cancelled)) = control_handles else {
                    // The job was cancelled + dropped from the map
                    // before it reached the worker — surface a
                    // cancelled `done` event so the frontend can clear
                    // the queued badge.
                    emit_done(
                        &app_for_worker,
                        DonePayload {
                            job_id: &spec.job_id,
                            episode_id: &spec.episode_id,
                            success: false,
                            cancelled: true,
                            exit_code: None,
                            error: None,
                            stderr: String::new(),
                        },
                    );
                    continue;
                };

                run_extract_subtitle(app_for_worker.clone(), spec.clone(), cancel, cancelled).await;

                let mut map = controls_for_worker.lock().await;
                map.remove(&spec.job_id);
            }
        });

        Arc::new(Self { tx, controls })
    }

    /// Register a fresh control handle and enqueue the job. The two
    /// steps are bundled to keep the "registered before sent"
    /// invariant atomic — without it a cancel arriving between
    /// `insert` and `send` could land in an unobservable state.
    pub async fn enqueue_extract_subtitle(&self, spec: ExtractSubtitleSpec) {
        let job_id = spec.job_id.clone();
        {
            let mut map = self.controls.lock().await;
            map.insert(
                job_id.clone(),
                JobControl {
                    cancel: Arc::new(Notify::new()),
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        if self.tx.send(spec).is_err() {
            warn!(job_id, "job queue worker dropped; rolling back control entry");
            let mut map = self.controls.lock().await;
            map.remove(&job_id);
        }
    }

    /// Mark `job_id` cancelled and wake the supervisor if it's
    /// running. Returns `true` when the id was known. Idempotent —
    /// cancelling an already-cancelled or already-finished job is a
    /// no-op.
    pub async fn cancel(&self, job_id: &str) -> bool {
        let map = self.controls.lock().await;
        match map.get(job_id) {
            Some(c) => {
                c.cancelled.store(true, Ordering::SeqCst);
                c.cancel.notify_waiters();
                true
            }
            None => false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct StartedPayload<'a> {
    job_id: &'a str,
    episode_id: &'a str,
}

#[derive(Clone, Debug, Serialize)]
struct ProgressPayload<'a> {
    job_id: &'a str,
    episode_id: &'a str,
    ratio: f32,
    hint: String,
}

#[derive(Clone, Debug, Serialize)]
struct DonePayload<'a> {
    job_id: &'a str,
    episode_id: &'a str,
    success: bool,
    cancelled: bool,
    exit_code: Option<i32>,
    error: Option<String>,
    /// Full captured stderr text — the failure-modal renders this
    /// verbatim in a `TerminalLog` so the user can read the
    /// underlying mkvextract complaint without having to dig into
    /// app logs.
    stderr: String,
}

/// Captured per-job outcome from the supervisor. Folded into the
/// final `DonePayload` after the post-extract SRT→ASS conversion
/// step (which can downgrade an otherwise-successful exit into a
/// failure when the on-disk file can't be read or rewritten).
struct Outcome {
    success: bool,
    cancelled: bool,
    exit_code: Option<i32>,
    error: Option<String>,
    stderr: String,
}

async fn run_extract_subtitle(
    app: AppHandle,
    spec: ExtractSubtitleSpec,
    cancel: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
) {
    let output_ass = spec.output_ass();

    // Short-circuit: cancellation that arrived between enqueue and
    // the worker picking the job up. The map entry is still present
    // (cleanup happens in the worker loop after this returns) so the
    // frontend won't see a stale "running" badge.
    if cancelled.load(Ordering::SeqCst) {
        emit_done(
            &app,
            DonePayload {
                job_id: &spec.job_id,
                episode_id: &spec.episode_id,
                success: false,
                cancelled: true,
                exit_code: None,
                error: None,
                stderr: String::new(),
            },
        );
        return;
    }

    emit_started(&app, &spec.job_id, &spec.episode_id);

    // mkvextract argv: `tracks <source.mkv> <track_id>:<output.ass>`.
    // The output path is always `<basename>.eng.ass`; if the source
    // codec is SRT, mkvextract writes SRT content into the .ass file
    // and the post-extract step below converts in place.
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
            emit_done(
                &app,
                DonePayload {
                    job_id: &spec.job_id,
                    episode_id: &spec.episode_id,
                    success: false,
                    cancelled: false,
                    exit_code: None,
                    error: Some(msg),
                    stderr: String::new(),
                },
            );
            return;
        }
    };

    let outcome = supervise(app.clone(), &spec, child, cancel, cancelled).await;
    let final_outcome = if outcome.success {
        match post_process_output(&output_ass) {
            Ok(()) => outcome,
            Err(msg) => {
                error!(
                    job_id = spec.job_id,
                    error = msg,
                    "post-extract SRT→ASS conversion failed"
                );
                Outcome {
                    success: false,
                    cancelled: false,
                    exit_code: outcome.exit_code,
                    error: Some(msg),
                    stderr: outcome.stderr,
                }
            }
        }
    } else {
        outcome
    };

    // Cleanup partial output on any non-success path (cancel, mkvextract
    // failure, post-process failure). Without this an aborted job would
    // leave a half-written .ass that `derive_state` would later
    // misidentify as a valid extract.
    if !final_outcome.success {
        cleanup_partial_output(&spec);
    }

    info!(
        job_id = spec.job_id,
        episode_id = spec.episode_id,
        success = final_outcome.success,
        cancelled = final_outcome.cancelled,
        exit_code = ?final_outcome.exit_code,
        "extract subtitle job finished"
    );

    emit_done(
        &app,
        DonePayload {
            job_id: &spec.job_id,
            episode_id: &spec.episode_id,
            success: final_outcome.success,
            cancelled: final_outcome.cancelled,
            exit_code: final_outcome.exit_code,
            error: final_outcome.error.clone(),
            stderr: final_outcome.stderr.clone(),
        },
    );
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
) -> Outcome {
    let stderr = child.stderr.take().expect("piped above; take-once contract");
    let stdout = child.stdout.take().expect("piped above; take-once contract");

    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let stderr_buf_for_task = stderr_buf.clone();
    let app_for_stderr = app.clone();
    let job_id_for_stderr = spec.job_id.clone();
    let episode_id_for_stderr = spec.episode_id.clone();

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
                        emit_progress(
                            &app_for_stderr,
                            &job_id_for_stderr,
                            &episode_id_for_stderr,
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

    // mkvextract emits very little on stdout (banner + the "Extracting
    // track …" line) — drain it anyway so the pipe never back-pressures.
    let stdout_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        // Discard the lines: slice 0007 doesn't surface stdout to the
        // frontend (the only signal the modal needs is the progress
        // ratio + the final stderr on failure).
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

    Outcome {
        success,
        cancelled: was_cancelled,
        exit_code,
        error: error_msg,
        stderr: stderr_text,
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

/// Best-effort heuristic for "is this text an SRT subtitle?". Returns
/// false for ASS (which starts with `[Script Info]`), WebVTT (`WEBVTT`
/// magic), empty input, and anything else that doesn't match the SRT
/// block shape. Used by [`post_process_output`] to decide whether to
/// rewrite the file.
fn looks_like_srt(text: &str) -> bool {
    let mut iter = text.lines().filter(|l| !l.trim().is_empty());
    let Some(first) = iter.next() else { return false };
    let first_trimmed = first.trim();
    // Reject the obvious non-SRT magic markers.
    if first_trimmed.starts_with('[') || first_trimmed.eq_ignore_ascii_case("WEBVTT") {
        return false;
    }
    // Standard SRT: first line is the numeric block index, second is
    // the timing arrow.
    if first_trimmed.parse::<u32>().is_ok() {
        return iter.next().is_some_and(|l| l.contains(" --> "));
    }
    // Index-less SRT: first line itself carries the timing.
    first_trimmed.contains(" --> ")
}

/// Walk the EpisodeFolder for files the job may have written and
/// delete any that exist. Idempotent — missing files are silently
/// ignored. Called on any non-success exit so the user is never
/// left staring at a half-written .ass that `derive_state` would
/// misidentify as a real extract.
fn cleanup_partial_output(spec: &ExtractSubtitleSpec) {
    let candidates = [
        spec.episode_folder
            .join(format!("{}.eng.ass", spec.output_basename)),
        // Mirror the future SRT-intermediate path (currently not
        // produced — we extract straight to .ass — but listing it
        // means a future change that introduces an intermediate
        // `.srt` won't leak a file on cancel).
        spec.episode_folder
            .join(format!("{}.eng.srt", spec.output_basename)),
    ];
    for path in &candidates {
        if path.exists()
            && let Err(e) = std::fs::remove_file(path)
        {
            warn!(
                job_id = spec.job_id,
                path = %path.display(),
                error = %e,
                "failed to clean up partial extract output"
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

fn emit_started(app: &AppHandle, job_id: &str, episode_id: &str) {
    let payload = StartedPayload { job_id, episode_id };
    if let Err(e) = app.emit(EVENT_STARTED, &payload) {
        error!(job_id, error = %e, "failed to emit job-started event");
    }
}

fn emit_progress(app: &AppHandle, job_id: &str, episode_id: &str, ratio: f32, hint: String) {
    let payload = ProgressPayload {
        job_id,
        episode_id,
        ratio,
        hint,
    };
    if let Err(e) = app.emit(EVENT_PROGRESS, &payload) {
        error!(job_id, error = %e, "failed to emit job-progress event");
    }
}

fn emit_done(app: &AppHandle, payload: DonePayload<'_>) {
    if let Err(e) = app.emit(EVENT_DONE, &payload) {
        error!(
            job_id = payload.job_id,
            error = %e,
            "failed to emit job-done event"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_srt_recognises_standard_block() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
        assert!(looks_like_srt(srt));
    }

    #[test]
    fn looks_like_srt_recognises_indexless_block() {
        let srt = "00:00:01,000 --> 00:00:02,000\nHello\n";
        assert!(looks_like_srt(srt));
    }

    #[test]
    fn looks_like_srt_recognises_crlf_input() {
        let srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n";
        assert!(looks_like_srt(srt));
    }

    #[test]
    fn looks_like_srt_rejects_ass_header() {
        let ass = "[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: ...\n";
        assert!(!looks_like_srt(ass));
    }

    #[test]
    fn looks_like_srt_rejects_webvtt() {
        assert!(!looks_like_srt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n"));
        assert!(!looks_like_srt("webvtt\n\n"));
    }

    #[test]
    fn looks_like_srt_rejects_empty_and_garbage() {
        assert!(!looks_like_srt(""));
        assert!(!looks_like_srt("   \n  \n"));
        assert!(!looks_like_srt("just one line of text"));
        assert!(!looks_like_srt("1\nbut second line is not timing\n"));
    }

    #[test]
    fn output_ass_path_uses_basename_and_eng_suffix() {
        let spec = ExtractSubtitleSpec {
            job_id: "j1".into(),
            episode_id: "e1".into(),
            mkvextract_path: PathBuf::from("mkvextract"),
            source_mkv_path: PathBuf::from(r"C:\src\file.mkv"),
            episode_folder: PathBuf::from(r"C:\proj\ep01"),
            mkv_track_id: 2,
            output_basename: "ep01".into(),
        };
        let p = spec.output_ass();
        assert_eq!(p, PathBuf::from(r"C:\proj\ep01\ep01.eng.ass"));
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
        // An unrelated file in the same folder must NOT be touched.
        std::fs::write(dir.join("keepme.txt"), b"safe").unwrap();

        let spec = ExtractSubtitleSpec {
            job_id: "j".into(),
            episode_id: "e".into(),
            mkvextract_path: PathBuf::new(),
            source_mkv_path: PathBuf::new(),
            episode_folder: dir.clone(),
            mkv_track_id: 0,
            output_basename: "ep".into(),
        };
        cleanup_partial_output(&spec);

        assert!(!dir.join("ep.eng.ass").exists());
        assert!(!dir.join("ep.eng.srt").exists());
        assert!(dir.join("keepme.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_overwrites_existing_file() {
        use std::env;
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let dir = env::temp_dir().join(format!("zimesub-atomic-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("foo.ass");
        std::fs::write(&target, b"old").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
