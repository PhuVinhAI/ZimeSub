//! App-level log file initialisation.
//!
//! Writes structured log records to `%APPDATA%\ZimeSub\logs\zimesub.log` with
//! a 5 × 2 MB rolling window (the active file plus four rotated archives
//! `zimesub.log.1` … `zimesub.log.4`). Backed by a custom `MakeWriter` so
//! `tracing-subscriber` keeps a single open handle and rotates in-process —
//! `tracing-appender` only ships time-based rotation, not size-based.
//!
//! Format: RFC 3339 UTC timestamp + level + message, no ANSI. The first slice
//! that needs a log (0002 — RequiredTool detection) bootstraps this writer
//! from `lib::run` so later slices can just `tracing::info!`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::Utc;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::FormatTime;

/// 2 MB per file (PRD § "Settings & persistence").
const MAX_BYTES_PER_FILE: u64 = 2 * 1024 * 1024;

/// 5 total log files retained at any time.
const MAX_FILES: usize = 5;

/// Errors that can prevent the file logger from initialising.
#[derive(Debug)]
pub enum InitError {
    NoAppDataDir,
    Io(io::Error),
}

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InitError::NoAppDataDir => f.write_str("Roaming AppData directory not available"),
            InitError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for InitError {}

impl From<io::Error> for InitError {
    fn from(value: io::Error) -> Self {
        InitError::Io(value)
    }
}

/// Initialise the global `tracing` subscriber, writing to the rotating log
/// file under `%APPDATA%\ZimeSub\logs\`.
///
/// Safe to call multiple times — `try_init` returns silently if a subscriber
/// is already installed (e.g. when the lib is reloaded for tests).
pub fn init() -> Result<(), InitError> {
    let log_path = crate::paths::log_path().ok_or(InitError::NoAppDataDir)?;
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let writer = RotatingWriter::new(log_path, MAX_BYTES_PER_FILE, MAX_FILES)?;

    let env_filter = EnvFilter::try_from_env("ZIMESUB_LOG")
        .or_else(|_| EnvFilter::try_new("info"))
        .expect("static filter parses");

    let _ = tracing_subscriber::fmt()
        .with_writer(writer)
        .with_env_filter(env_filter)
        .with_ansi(false)
        .with_target(false)
        .with_timer(RfcTimer)
        .try_init();

    Ok(())
}

/// `tracing_subscriber::fmt::time::FormatTime` impl using RFC 3339 UTC with
/// millisecond precision. Avoids pulling in `tracing-subscriber`'s `chrono`
/// feature, which would double-version `chrono` against the rest of the
/// graph.
struct RfcTimer;

impl FormatTime for RfcTimer {
    fn format_time(&self, w: &mut Writer<'_>) -> std::fmt::Result {
        write!(
            w,
            "{}",
            Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        )
    }
}

/// `Send + Sync` handle to the rotating file. Cloning preserves a single
/// underlying file handle so all events serialise through one `Mutex`.
#[derive(Clone)]
struct RotatingWriter {
    inner: Arc<Mutex<RotatingFile>>,
}

impl RotatingWriter {
    fn new(base_path: PathBuf, max_bytes: u64, max_files: usize) -> io::Result<Self> {
        Ok(Self {
            inner: Arc::new(Mutex::new(RotatingFile {
                base_path,
                max_bytes,
                max_files,
                file: None,
                bytes_written: 0,
            })),
        })
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RotatingWriter {
    type Writer = LockedWriter<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        LockedWriter {
            guard: self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        }
    }
}

/// Holds the mutex guard for the duration of a single `tracing` write so
/// concurrent events don't interleave bytes mid-line.
struct LockedWriter<'a> {
    guard: MutexGuard<'a, RotatingFile>,
}

impl Write for LockedWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.guard.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.guard.flush()
    }
}

/// Size-rolling append-only file. Lazily opens the active file on first
/// write; rotates by closing the handle, renaming `N` → `N+1` (dropping
/// `max_files` and beyond), then reopening a fresh empty file at the base
/// path on the next write. Rotation runs in the writer hot path because
/// 2 MB cuts are infrequent and avoid the complexity of background flushers.
struct RotatingFile {
    base_path: PathBuf,
    max_bytes: u64,
    max_files: usize,
    file: Option<File>,
    bytes_written: u64,
}

impl RotatingFile {
    fn ensure_open(&mut self) -> io::Result<&mut File> {
        if self.file.is_none() {
            let f = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.base_path)?;
            self.bytes_written = f.metadata()?.len();
            self.file = Some(f);
        }
        Ok(self
            .file
            .as_mut()
            .expect("file just populated above this line"))
    }

    fn rotate(&mut self) -> io::Result<()> {
        if let Some(f) = self.file.take() {
            let _ = f.sync_all();
            drop(f);
        }

        for i in (1..self.max_files).rev() {
            let from = numbered_path(&self.base_path, i);
            let to = numbered_path(&self.base_path, i + 1);
            if from.exists() {
                if to.exists() {
                    let _ = fs::remove_file(&to);
                }
                fs::rename(&from, &to)?;
            }
        }

        if self.base_path.exists() {
            let one = numbered_path(&self.base_path, 1);
            if one.exists() {
                let _ = fs::remove_file(&one);
            }
            fs::rename(&self.base_path, &one)?;
        }

        self.bytes_written = 0;
        Ok(())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.bytes_written > 0 && self.bytes_written + buf.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        let f = self.ensure_open()?;
        let n = f.write(buf)?;
        self.bytes_written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }
}

fn numbered_path(base: &Path, n: usize) -> PathBuf {
    let mut p = base.to_path_buf();
    let name = base
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "log".to_string());
    p.set_file_name(format!("{name}.{n}"));
    p
}
