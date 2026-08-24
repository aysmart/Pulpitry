//! Somewhere for the app to say what went wrong.
//!
//! Release builds on Windows are compiled as GUI applications, which have no
//! console attached: every `eprintln!` in this codebase is written to a handle
//! that goes nowhere. On macOS the same lines appear if the app is launched
//! from a terminal, so the gap was invisible to whoever wrote them.
//!
//! The cost of that showed up the first time somebody tested on Windows: the
//! app stopped answering, and the only way to find out why was to read the
//! source and guess. A wrong guess cost a release.
//!
//! So everything written to stderr is also written to a file beside the app's
//! own data, which is the first thing to ask for when somebody reports a fault.
//! Two runs are kept -- the current one and the one before, because the
//! interesting run is often the one that ended badly and was restarted.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Where the current run is being written, once `start` has been called.
static FILE: Mutex<Option<File>> = Mutex::new(None);

/// Opens the log, rotating the previous run out of the way.
///
/// Never fails loudly: an app that will not start because it could not open a
/// log file would be a worse fault than the one the log exists to explain.
pub fn start(directory: &Path) -> Option<PathBuf> {
    let _ = fs::create_dir_all(directory);

    let current = directory.join("pulpitry.log");
    let previous = directory.join("pulpitry.previous.log");
    let _ = fs::rename(&current, &previous);

    let mut file = File::create(&current).ok()?;
    let _ = writeln!(
        file,
        "Pulpitry {} on {} — {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        stamp()
    );
    let _ = file.flush();

    *FILE.lock().ok()? = Some(file);
    Some(current)
}

/// Writes one line, to the log and to stderr.
///
/// Both, deliberately: the file is for the operator to send on, and stderr is
/// still where a developer running from a terminal expects to see it.
pub fn line(message: &str) {
    /*
     * Written, not printed. `eprintln!` panics when the write fails.
     *
     * Stderr is not always there to be written to: a GUI application on
     * Windows has no console at all, and a process whose parent has gone --
     * a terminal closed, a launcher that exited -- is writing into a pipe
     * with nobody on the other end, which fails with EPIPE.
     *
     * That panic was fatal rather than merely unfortunate, because the panic
     * hook below reports panics by calling this function: the report panicked
     * on the same broken stderr, and a panic inside a panic hook aborts the
     * process. Pulpitry died with SIGABRT in the middle of summarising a
     * service, and the crash report was six frames of the logger calling
     * itself.
     *
     * A log line that cannot be written is not worth a process.
     */
    let _ = writeln!(std::io::stderr(), "{message}");

    to_file(message);
}

/// The file half of [`line`], which is the half that must never fail.
fn to_file(message: &str) {
    let Ok(mut slot) = FILE.lock() else { return };
    let Some(file) = slot.as_mut() else { return };
    let _ = writeln!(file, "[{}] {message}", stamp());
    // Flushed every line. A crash is exactly when the log matters, and a
    // buffered last line is the one that would have said why.
    let _ = file.flush();
}

/// A timestamp with no dependency on a date library.
///
/// Local time, which is the only kind an operator can compare against the clock
/// on the wall. It was UTC, so every line in a British summer read an hour
/// early -- and a log that disagrees with the clock is worse than one with no
/// times in it, because it is believed. An afternoon went into re-reading
/// failures as stale that had happened a minute earlier.
///
/// The offset comes from the platform rather than a crate: `localtime_r` is
/// what every date library would call here anyway.
fn stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64 + local_offset(now.as_secs() as i64);
    let secs = secs.rem_euclid(86_400);
    let (h, m, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}")
}

/// Seconds this machine is ahead of UTC, at the given moment.
///
/// At the given moment, not in general: the offset changes twice a year and a
/// log stamped with the wrong half of that is exactly as misleading as one
/// stamped in UTC.
#[cfg(unix)]
fn local_offset(at: i64) -> i64 {
    // SAFETY: `localtime_r` writes into a struct we own and reads a value we
    // pass by pointer. It is the reentrant form precisely so that this is safe
    // to call from any thread, which a logger has to be.
    unsafe {
        let mut out: libc::tm = std::mem::zeroed();
        let time = at as libc::time_t;
        if libc::localtime_r(&time, &mut out).is_null() {
            return 0;
        }
        out.tm_gmtoff as i64
    }
}

#[cfg(windows)]
fn local_offset(_at: i64) -> i64 {
    // SAFETY: the call fills a struct we own and reports failure in its return
    // value, which is checked.
    unsafe {
        let mut zone: windows_sys::Win32::System::Time::TIME_ZONE_INFORMATION =
            std::mem::zeroed();
        match windows_sys::Win32::System::Time::GetTimeZoneInformation(&mut zone) {
            // TIME_ZONE_ID_INVALID
            0xFFFF_FFFF => 0,
            // Bias is minutes *behind* UTC, and daylight saving is a further
            // bias on top of it. 2 is TIME_ZONE_ID_DAYLIGHT.
            id => {
                let bias = zone.Bias + if id == 2 { zone.DaylightBias } else { zone.StandardBias };
                -(bias as i64) * 60
            }
        }
    }
}

/// Reports a panic to the log before the process goes.
///
/// Without this a crash on Windows leaves nothing at all: no console, no
/// dialogue, no file -- just an app that was there a moment ago.
pub fn catch_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let where_ = info
            .location()
            .map(|at| format!("{}:{}", at.file(), at.line()))
            .unwrap_or_else(|| "somewhere".into());
        // To the file only, and never through anything that can fail loudly:
        // a panic raised while reporting a panic aborts the process, which is
        // how a broken stderr turned a recoverable fault into a crash.
        to_file(&format!("PANIC at {where_}: {info}"));
        previous(info);
    }));
}

/// Writes a line to the log. Use exactly like `eprintln!`.
#[macro_export]
macro_rules! log_line {
    ($($arg:tt)*) => {
        $crate::log::line(&format!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn writes_a_file_and_rotates_the_previous_run() {
        let dir = std::env::temp_dir().join("pulpitry-log-test");
        let _ = std::fs::remove_dir_all(&dir);

        let first = start(&dir).expect("log should open");
        line("first run");
        assert!(std::fs::read_to_string(&first).unwrap().contains("first run"));

        // A second run keeps the first as .previous, since the interesting run
        // is often the one that ended badly.
        let second = start(&dir).expect("log should reopen");
        line("second run");
        let now = std::fs::read_to_string(&second).unwrap();
        let before = std::fs::read_to_string(dir.join("pulpitry.previous.log")).unwrap();
        assert!(now.contains("second run") && !now.contains("first run"));
        assert!(before.contains("first run"));
    }
}
