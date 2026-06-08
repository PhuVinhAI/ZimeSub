//! Synchronous run-to-completion subprocess helper.
//!
//! Slice 0006 introduces this helper to run `mkvmerge -i -F json` and
//! capture its stdout/stderr/exit code in one round-trip — the picker
//! modal blocks on the result, so streaming progress would be wasted
//! work. The tiered streaming [`JobQueue`] arrives in slice 0007 and
//! takes over for extract/render jobs that need live progress and
//! cancellation; this helper stays in place for short synchronous
//! probes where the round-trip latency is dominated by the OS spawn,
//! not the workload itself.
//!
//! On Windows the child is spawned with `CREATE_NO_WINDOW` so no console
//! window flashes in front of the user mid-probe — mirroring the
//! convention `tooling::read_version` already uses.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Suppress the transient console flash on Windows when running a
/// short-lived probe. CREATE_NO_WINDOW (`0x08000000`) —
/// <https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags>.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Specification of a subprocess invocation. Pure data — the helper
/// reads this once and never mutates it.
#[derive(Clone, Debug)]
pub struct RunSpec<'a> {
    /// Absolute path to the executable. Callers resolve this from
    /// `settings.tool_paths` so the helper never has to consult `PATH`
    /// or the OS-default install locations on its own.
    pub executable: PathBuf,
    /// argv passed to the child, NOT including argv[0]. Always argv form
    /// — the PRD forbids shell-interpolated commands so user-supplied
    /// strings (e.g. `source_mkv_path`) flow into the child unchanged
    /// regardless of spaces, brackets, or quotes.
    pub args: Vec<String>,
    /// Working directory for the child. PRD § "Process spawn rules"
    /// fixes this for Render jobs (cwd = EpisodeFolder) so the
    /// `subtitles=` filter resolves relative file names without
    /// tripping the Windows backslash quirks; the same convention
    /// applies to the slice 0006 mkvmerge probe so the cwd in the log
    /// matches what the eventual extract job will use.
    pub cwd: &'a Path,
}

/// Captured outcome of a run. Stdout/stderr are owned `String`s so the
/// modal can render them without lifetime gymnastics — mkvmerge output
/// is at most a few KB, so the allocation is irrelevant.
#[derive(Clone, Debug)]
pub struct RunOutcome {
    /// Exit status. `None` is reserved for the cross-platform case
    /// where the child was terminated by a signal (Unix-only concept,
    /// but `std::process::ExitStatus::code()` returns `None` for it).
    /// On Windows this only ever happens when the process is killed
    /// externally; for the slice 0006 sync use case we treat any
    /// non-`Some(0)` value as a failure.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl RunOutcome {
    /// `true` when the child exited with status `0`. Matches the
    /// "success" semantic the modal uses to decide between rendering
    /// the table and rendering the stderr-plus-Retry pane.
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// Errors that prevent the child from running to completion in the
/// first place (most commonly: the executable path doesn't exist).
/// A non-zero exit code is NOT a `RunError` — it lands in
/// [`RunOutcome::exit_code`] so the caller can surface stderr instead
/// of a generic spawn failure.
#[derive(Debug)]
pub enum RunError {
    Spawn(std::io::Error),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Spawn(e) => write!(f, "Không chạy được lệnh: {e}"),
        }
    }
}

impl std::error::Error for RunError {}

/// Run `spec` to completion and capture stdout/stderr/exit code in one
/// blocking call. The caller's thread parks on the OS subprocess wait
/// until the child exits or fails to spawn.
///
/// Tauri's `#[tauri::command]` handlers without `async` already run on
/// the runtime's worker thread pool, so a blocking call here is fine
/// for the slice 0006 modal flow — it does NOT block the Tokio reactor
/// even though the rest of the backend uses tokio for streaming jobs.
pub fn run_to_completion(spec: RunSpec<'_>) -> Result<RunOutcome, RunError> {
    let mut cmd = Command::new(&spec.executable);
    cmd.args(&spec.args).current_dir(spec.cwd);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(RunError::Spawn)?;
    Ok(RunOutcome {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn success_is_only_true_for_exit_zero() {
        let outcome = RunOutcome {
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
        };
        assert!(outcome.success());

        let outcome = RunOutcome {
            exit_code: Some(1),
            stdout: String::new(),
            stderr: String::new(),
        };
        assert!(!outcome.success());

        let outcome = RunOutcome {
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
        };
        assert!(!outcome.success());
    }

    /// Sanity-check the helper against the OS shell — `cmd /c echo …`
    /// is guaranteed to exist on every Windows machine the v1 PRD
    /// targets, so this exercises the spawn → wait → capture path
    /// without depending on an actual `mkvmerge` install.
    #[test]
    #[cfg(windows)]
    fn captures_stdout_and_exit_code_via_cmd_echo() {
        let tmp = env::temp_dir();
        let outcome = run_to_completion(RunSpec {
            executable: PathBuf::from("cmd"),
            args: vec!["/c".into(), "echo zimesub-probe".into()],
            cwd: &tmp,
        })
        .expect("run cmd echo");
        assert!(outcome.success());
        assert!(
            outcome.stdout.contains("zimesub-probe"),
            "expected stdout to contain the echo marker; got {:?}",
            outcome.stdout
        );
    }

    /// A non-zero exit from the child must surface as
    /// `RunOutcome { exit_code: Some(n), … }`, NOT as a `RunError` —
    /// the modal relies on this contract to distinguish "tool ran but
    /// said no" (show stderr + Retry) from "we couldn't even spawn it"
    /// (different error path).
    #[test]
    #[cfg(windows)]
    fn nonzero_exit_is_outcome_not_error() {
        let tmp = env::temp_dir();
        let outcome = run_to_completion(RunSpec {
            executable: PathBuf::from("cmd"),
            args: vec!["/c".into(), "exit 7".into()],
            cwd: &tmp,
        })
        .expect("run cmd exit 7");
        assert!(!outcome.success());
        assert_eq!(outcome.exit_code, Some(7));
    }

    /// Spawn failure (executable does not exist) returns
    /// [`RunError::Spawn`] without panicking. The frontend surfaces the
    /// underlying OS error string verbatim in the modal's error pane.
    #[test]
    fn missing_executable_is_spawn_error() {
        let tmp = env::temp_dir();
        let err = run_to_completion(RunSpec {
            executable: PathBuf::from("zimesub-totally-not-an-executable-9f3b"),
            args: vec![],
            cwd: &tmp,
        })
        .unwrap_err();
        assert!(matches!(err, RunError::Spawn(_)));
    }
}
