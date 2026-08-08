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
    eprintln!("{message}");

    let Ok(mut slot) = FILE.lock() else { return };
    let Some(file) = slot.as_mut() else { return };
    let _ = writeln!(file, "[{}] {message}", stamp());
    // Flushed every line. A crash is exactly when the log matters, and a
    // buffered last line is the one that would have said why.
    let _ = file.flush();
}

/// A timestamp with no dependency on a date library.
fn stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}")
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
        line(&format!("PANIC at {where_}: {info}"));
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
