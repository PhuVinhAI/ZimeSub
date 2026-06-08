//! winget install pipeline for `RequiredTool`.
//!
//! Per ADR-0002 and PRD § "Onboarding & tool gating", the install path drives
//! `winget` directly so the user sees the same console output they'd see on
//! the command line — including the per-package UAC prompt that `winget`
//! itself triggers. The app deliberately does *not* request UAC elevation.
//!
//! Architecture:
//!
//! 1. [`winget_available`] is a cheap PATH probe that the frontend uses to
//!    decide between the install button and the "Mở trang tải" fallback.
//! 2. [`start_install`] spawns `winget install ...` under `tokio::process` with
//!    `stdout`/`stderr` piped. Two reader tasks emit one Tauri event per line
//!    as the line is flushed — no buffering until exit (PRD acceptance).
//! 3. Cancellation is opt-in via a [`tokio::sync::Notify`] handle stored in
//!    [`InstallRegistry`]. Calling [`cancel_install`] triggers the supervisor
//!    task to `child.start_kill()` and then drain.
//!
//! Events emitted to the webview:
//!
//! * `tool-install-log`  — `{ install_id, stream: "stdout"|"stderr", line }`
//! * `tool-install-done` — `{ install_id, exit_code, success, error?, cancelled }`

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;
use tracing::{error, info, warn};

use crate::tooling::RequiredTool;

/// Event name carrying one stdout/stderr line per emission. Slashes and
/// colons are avoided so the name is friendly across every Tauri event
/// transport.
pub const EVENT_LOG: &str = "tool-install-log";

/// Event name carrying the install completion record (success, failure, or
/// cancellation).
pub const EVENT_DONE: &str = "tool-install-done";

/// Suppress the transient console flash on Windows when winget itself
/// inherits stdio (we already pipe it, but the flag is cheap insurance for
/// any short-lived helper invocations winget spawns internally — they would
/// otherwise pop up briefly behind the elevation prompt).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Per-install cancellation handle. Stored in [`InstallRegistry`] for the
/// lifetime of the running install; removed once the supervisor task exits.
#[derive(Clone)]
struct InstallEntry {
    cancel: Arc<Notify>,
}

/// Map install-id → cancellation handle. Wrapped in a `std::sync::Mutex` —
/// critical sections are short and never await.
#[derive(Default)]
pub struct InstallRegistry {
    inner: Mutex<HashMap<String, InstallEntry>>,
}

impl InstallRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, install_id: &str, entry: InstallEntry) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(install_id.to_string(), entry);
    }

    fn remove(&self, install_id: &str) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.remove(install_id);
    }

    fn cancel_handle(&self, install_id: &str) -> Option<Arc<Notify>> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.get(install_id).map(|e| e.cancel.clone())
    }

    fn contains(&self, install_id: &str) -> bool {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.contains_key(install_id)
    }
}

/// Payload for [`EVENT_LOG`]. Serialised verbatim across the IPC bridge —
/// the frontend type in `src/api/install.ts` mirrors these field names.
#[derive(Clone, Debug, Serialize)]
struct LogPayload<'a> {
    install_id: &'a str,
    stream: &'static str,
    line: String,
}

/// Payload for [`EVENT_DONE`]. `cancelled` distinguishes a user-initiated
/// kill from an organic failure so the UI can show a different message.
#[derive(Clone, Debug, Serialize)]
struct DonePayload<'a> {
    install_id: &'a str,
    exit_code: Option<i32>,
    success: bool,
    cancelled: bool,
    error: Option<String>,
}

/// `true` if `winget` is on PATH.
///
/// Win 10 pre-1809 and locked-down enterprise machines won't have it; the
/// frontend uses the result to flip the install button into the manual
/// download fallback.
pub fn winget_available() -> bool {
    which::which("winget").is_ok()
}

/// winget package id for a given `RequiredTool`. Both mkvmerge and mkvextract
/// are shipped by the same MKVToolNix package — the acceptance criteria
/// pin these exact ids:
///
/// * `MKVToolNix.MKVToolNix` for mkvmerge / mkvextract
/// * `Gyan.FFmpeg`           for ffmpeg
pub fn winget_package_id(tool: RequiredTool) -> &'static str {
    match tool {
        RequiredTool::Mkvmerge | RequiredTool::Mkvextract => "MKVToolNix.MKVToolNix",
        RequiredTool::Ffmpeg => "Gyan.FFmpeg",
    }
}

/// Build the argument vector for the install. ADR-0002 + acceptance criteria
/// fix these flags exactly so re-runs (and the on-screen log) are
/// reproducible.
fn winget_args(tool: RequiredTool) -> Vec<String> {
    vec![
        "install".to_string(),
        "--id".to_string(),
        winget_package_id(tool).to_string(),
        "-e".to_string(),
        "--accept-package-agreements".to_string(),
        "--accept-source-agreements".to_string(),
        // Disable interactive output so winget streams plain text instead of
        // redrawing TUI widgets that would garble in the log panel.
        "--disable-interactivity".to_string(),
    ]
}

/// Errors returned synchronously from [`start_install`] — i.e. failures that
/// happen *before* the supervisor task takes over. Once the supervisor is
/// running, all failures are surfaced via the `done` event.
#[derive(Debug)]
pub enum StartError {
    WingetMissing,
    AlreadyRunning,
    Spawn(std::io::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::WingetMissing => f.write_str("winget không khả dụng trên máy này"),
            StartError::AlreadyRunning => f.write_str("Cài đặt khác đang chạy"),
            StartError::Spawn(e) => write!(f, "Không thể khởi chạy winget: {e}"),
        }
    }
}

impl std::error::Error for StartError {}

/// Kick off a winget install. Returns as soon as the child process is spawned
/// and the supervisor task is scheduled; the actual install proceeds in the
/// background and reports completion via [`EVENT_DONE`].
///
/// The caller (Tauri command layer) is responsible for re-running ToolProbe
/// when the `done` event arrives — this module is install-only.
pub async fn start_install(
    app: AppHandle,
    registry: Arc<InstallRegistry>,
    install_id: String,
    tool: RequiredTool,
) -> Result<(), StartError> {
    if !winget_available() {
        return Err(StartError::WingetMissing);
    }
    if registry.contains(&install_id) {
        return Err(StartError::AlreadyRunning);
    }

    let args = winget_args(tool);
    info!(
        install_id,
        tool = tool.key(),
        package = winget_package_id(tool),
        "starting winget install"
    );

    let mut cmd = Command::new("winget");
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Disable inherited environment quirks — winget reads its own env, no need to scrub.
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(StartError::Spawn)?;

    let stdout = child
        .stdout
        .take()
        .expect("piped above, take()-once contract");
    let stderr = child
        .stderr
        .take()
        .expect("piped above, take()-once contract");

    let cancel = Arc::new(Notify::new());
    registry.insert(&install_id, InstallEntry {
        cancel: cancel.clone(),
    });

    // Surface the exact command being run as the first log line so the user
    // can see (and copy/paste) what we're invoking on their behalf.
    let invocation = format!("> winget {}", args.join(" "));
    emit_log(&app, &install_id, "stdout", invocation);

    let app_for_task = app.clone();
    let registry_for_task = registry.clone();
    let install_id_for_task = install_id.clone();

    tauri::async_runtime::spawn(async move {
        supervise(
            app_for_task,
            registry_for_task,
            install_id_for_task,
            child,
            stdout,
            stderr,
            cancel,
        )
        .await;
    });

    Ok(())
}

/// Look up the install by id and trip the cancellation [`Notify`]. The
/// supervisor task takes care of killing the OS process and draining.
pub fn cancel_install(registry: &InstallRegistry, install_id: &str) -> Result<(), String> {
    match registry.cancel_handle(install_id) {
        Some(cancel) => {
            info!(install_id, "cancellation requested");
            cancel.notify_waiters();
            Ok(())
        }
        None => Err(format!("Không có cài đặt nào với id {install_id}")),
    }
}

/// Background supervisor — owns the child process for the lifetime of the
/// install. Drains stdout/stderr concurrently with `child.wait()` so reads
/// don't block on each other, and races against the cancellation `Notify`.
async fn supervise(
    app: AppHandle,
    registry: Arc<InstallRegistry>,
    install_id: String,
    mut child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    cancel: Arc<Notify>,
) {
    let stdout_task = spawn_line_reader(stdout, "stdout", app.clone(), install_id.clone());
    let stderr_task = spawn_line_reader(stderr, "stderr", app.clone(), install_id.clone());

    let cancel_signal = cancel.notified();
    tokio::pin!(cancel_signal);

    let (exit_code, success, cancelled, error) = tokio::select! {
        biased;
        () = &mut cancel_signal => {
            warn!(install_id, "cancellation received — killing winget child");
            let _ = child.start_kill();
            match child.wait().await {
                Ok(status) => (status.code(), false, true, None),
                Err(e) => (None, false, true, Some(format!("Lỗi khi chờ winget thoát: {e}"))),
            }
        }
        wait_result = child.wait() => {
            match wait_result {
                Ok(status) => {
                    let code = status.code();
                    let ok = status.success();
                    (code, ok, false, None)
                }
                Err(e) => (None, false, false, Some(format!("Lỗi khi chờ winget thoát: {e}"))),
            }
        }
    };

    // Make sure all output lines reach the UI before we fire `done` — racing
    // them produces a flicker where the UI thinks the install finished while
    // the last few lines of progress are still in flight.
    let _ = tokio::join!(stdout_task, stderr_task);

    info!(
        install_id,
        exit_code, success, cancelled, error = ?error, "winget install finished"
    );

    let payload = DonePayload {
        install_id: &install_id,
        exit_code,
        success,
        cancelled,
        error,
    };
    if let Err(e) = app.emit(EVENT_DONE, &payload) {
        error!(install_id, error = %e, "failed to emit tool-install-done event");
    }

    registry.remove(&install_id);
}

/// Spawn a `tokio` task reading lines from `reader` and emitting one
/// [`EVENT_LOG`] event per line. The task ends when the underlying pipe
/// closes (which happens when the child exits).
fn spawn_line_reader<R>(
    reader: R,
    stream: &'static str,
    app: AppHandle,
    install_id: String,
) -> tauri::async_runtime::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => emit_log(&app, &install_id, stream, line),
                Ok(None) => break,
                Err(e) => {
                    warn!(
                        install_id,
                        stream,
                        error = %e,
                        "line reader failed; stopping early"
                    );
                    break;
                }
            }
        }
    })
}

fn emit_log(app: &AppHandle, install_id: &str, stream: &'static str, line: String) {
    let payload = LogPayload {
        install_id,
        stream,
        line,
    };
    if let Err(e) = app.emit(EVENT_LOG, &payload) {
        error!(install_id, error = %e, "failed to emit tool-install-log event");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winget_package_id_matches_acceptance_criteria() {
        assert_eq!(winget_package_id(RequiredTool::Mkvmerge), "MKVToolNix.MKVToolNix");
        assert_eq!(winget_package_id(RequiredTool::Mkvextract), "MKVToolNix.MKVToolNix");
        assert_eq!(winget_package_id(RequiredTool::Ffmpeg), "Gyan.FFmpeg");
    }

    #[test]
    fn winget_args_carry_required_flags() {
        let args = winget_args(RequiredTool::Ffmpeg);
        assert_eq!(args[0], "install");
        assert!(args.contains(&"--id".to_string()));
        assert!(args.contains(&"Gyan.FFmpeg".to_string()));
        assert!(args.contains(&"-e".to_string()));
        assert!(args.contains(&"--accept-package-agreements".to_string()));
        assert!(args.contains(&"--accept-source-agreements".to_string()));
    }

    #[test]
    fn registry_insert_and_remove_round_trip() {
        let reg = InstallRegistry::new();
        let cancel = Arc::new(Notify::new());
        reg.insert("abc", InstallEntry {
            cancel: cancel.clone(),
        });
        assert!(reg.contains("abc"));
        assert!(reg.cancel_handle("abc").is_some());
        reg.remove("abc");
        assert!(!reg.contains("abc"));
        assert!(reg.cancel_handle("abc").is_none());
    }
}
