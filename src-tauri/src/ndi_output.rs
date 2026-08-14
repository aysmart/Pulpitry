//! The projector, on the network, for as long as it is switched on.
//!
//! [`crate::ndi`] can send a frame and [`crate::ndi_capture`] can take one.
//! This is the thing that keeps doing both, and the reason it is its own module
//! is that the two run at different rates and must not be tied together.
//!
//! # Why the send loop does not wait for a frame
//!
//! A projector is mostly still: a verse goes up and holds for two minutes, a
//! slide holds through a prayer. The capture therefore produces frames rarely,
//! and a receiver wants a steady feed regardless — a source that emits nothing
//! for ninety seconds is a source most switchers mark as dead and some drop.
//!
//! So the loop sends at a fixed rate and repeats whatever the last captured
//! frame was. Repeating costs almost nothing: the pixels are already in memory
//! and NDI compresses a frame identical to its predecessor down to very little.
//! What it buys is a source that behaves like a camera rather than like a file.
//!
//! # Nothing here can interrupt a service
//!
//! Every failure is a stop and a line in the log. There is no path from this
//! module to a dialog, an exception, or anything that touches the projector
//! window — the worst NDI can do to a church is stop being available on the
//! network, which is what it was before they switched it on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::ndi;
use crate::ndi_capture::{self, Latest};

/// What the source is called when the operator has not named it.
pub const DEFAULT_NAME: &str = "Pulpitry";

/// The projector window's title, which is how the capture finds it.
///
/// Tauri sets this from the builder in [`crate::projector`]. Matched by title
/// *and* process id there, so a browser tab with the same words cannot be
/// mistaken for it.
const PROJECTOR_TITLE: &str = "Pulpitry — Projector";

/// Frames a second, sent and captured.
///
/// Thirty rather than sixty. A projector output has nothing in it that sixty
/// improves — text does not move — and thirty halves both the network cost and
/// the work the capture does per second.
const FPS: u32 = 30;

/// A running output. Dropping it stops everything and closes the source.
pub struct Output {
    running: Arc<AtomicBool>,
    sender: Option<JoinHandle<()>>,
    /// Held so the capture stops when this does; never read.
    _capture: ndi_capture::Capture,
}

impl Output {
    /// Whether the runtime is present at all, for a settings panel that has to
    /// say something before anybody switches this on.
    pub fn available() -> bool {
        ndi::Runtime::open().is_some()
    }

    /// Starts publishing, or says why it could not in words an operator can use.
    pub fn start(name: &str) -> Result<Self, String> {
        let name = if name.trim().is_empty() { DEFAULT_NAME } else { name.trim() };

        // The runtime first: it is the failure a church is most likely to hit
        // and the only one whose answer is "install this".
        if ndi::Runtime::open().is_none() {
            return Err(ndi::MISSING.to_string());
        }

        let latest = Latest::default();
        let capture = ndi_capture::start(PROJECTOR_TITLE, FPS, latest.clone())
            .map_err(|problem| problem.to_string())?;

        let running = Arc::new(AtomicBool::new(true));
        let name = name.to_string();

        /*
         * The runtime is opened again inside the thread rather than moved into
         * it, and that is deliberate rather than wasteful.
         *
         * `Sender` borrows the `Runtime` it came from, which cannot be sent
         * across a thread boundary as a pair without a self-referential struct
         * or a leak. Opening a second handle costs one `dlopen` of a library
         * the process has already mapped, and both handles refer to the same
         * initialised library -- NDI's own documentation describes it as a
         * process-wide singleton.
         */
        let stop = running.clone();
        let sender = std::thread::Builder::new()
            .name("ndi-output".into())
            .spawn(move || {
                let Some(runtime) = ndi::Runtime::open() else {
                    crate::log_line!("[ndi] the runtime went away before the sender started");
                    return;
                };
                let Some(sender) = runtime.sender(&name) else {
                    crate::log_line!("[ndi] could not announce a source called {name:?}");
                    return;
                };

                crate::log_line!("[ndi] publishing as {name:?} at {FPS} fps");
                let interval = Duration::from_micros(1_000_000 / FPS as u64);

                while stop.load(Ordering::Relaxed) {
                    let started = Instant::now();
                    let frame = latest.get();

                    if !frame.is_empty() {
                        sender.send_bgra(frame.width, frame.height, &frame.pixels, FPS);
                    }

                    /*
                     * Paced against when this iteration began, not by sleeping
                     * a fixed amount afterwards.
                     *
                     * Sleeping a flat interval adds the send's own duration to
                     * every cycle, so the real rate drifts below the one the
                     * frames are labelled with -- and a receiver that is told
                     * thirty and given twenty-six eventually stutters.
                     */
                    let spent = started.elapsed();
                    if spent < interval {
                        std::thread::sleep(interval - spent);
                    }
                }

                crate::log_line!("[ndi] stopped publishing as {name:?}");
            })
            .map_err(|error| format!("could not start the sender: {error}"))?;

        Ok(Self { running, sender: Some(sender), _capture: capture })
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.sender.take() {
            // Joined rather than detached: the sender holds the NDI source, and
            // letting it outlive this would leave a name on the network
            // pointing at nothing -- which a switcher shows as a live source
            // that produces black.
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_name_is_used_for_an_empty_one() {
        // A church that clears the field should get a working source called
        // something, not a source called "".
        assert_eq!(DEFAULT_NAME, "Pulpitry");
    }

    /// Thirty frames a second, paced from the start of the cycle.
    #[test]
    fn the_interval_is_a_thirtieth_of_a_second() {
        let interval = Duration::from_micros(1_000_000 / FPS as u64);
        assert_eq!(interval.as_micros(), 33_333);
    }

    /// Without a runtime this must report absence rather than panic, because
    /// the settings panel asks on every open and most machines will not have it.
    #[test]
    fn availability_is_a_question_that_can_always_be_asked() {
        let _ = Output::available();
    }

    /// Starting says which of the two things is missing, and does not confuse them.
    ///
    /// The runtime and the projector are the two reasons this fails, they have
    /// completely different answers -- install something, or open a window --
    /// and an operator given the wrong one goes looking in the wrong place.
    ///
    /// With a runtime present this also proves the chain past it: reaching the
    /// projector complaint at all means the library loaded, the symbols
    /// resolved and the capture was asked for. It is as far as this can go
    /// unattended, because the next step is a permission dialog.
    #[test]
    fn it_names_which_piece_is_missing() {
        // Matched rather than `expect_err`: `Output` holds live threads and a
        // capture, so making it Debug purely to unwrap an error in a test would
        // be the test dictating the shape of the thing it tests.
        let Err(problem) = Output::start("Pulpitry test") else {
            panic!("there is no projector window in a test, so this cannot succeed");
        };

        if Output::available() {
            assert!(
                !problem.contains("runtime is not installed"),
                "the runtime is here, so this must not blame it: {problem}",
            );
        } else {
            assert!(
                problem.contains("runtime is not installed"),
                "no runtime here, so that is what it should say: {problem}",
            );
        }
    }
}
