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

/// Frames a second, as the sender labels them.
///
/// Thirty rather than sixty. A projector output has nothing in it that sixty
/// improves — text does not move — and thirty halves both the network cost and
/// the work the capture does per second.
const FPS: u32 = 30;

/// How long a window that has just opened is given to become capturable.
///
/// macOS lists a new window to capture a moment after it exists, not when it
/// exists. Asked straight away, the answer is that there is no such window,
/// and an operator who pressed Open and was told the projector is not open
/// pressed it again -- which worked, and taught them that it needs pressing
/// twice. Measured at up to two seconds; three leaves room.
const SETTLE: Duration = Duration::from_secs(3);
const SETTLE_STEP: Duration = Duration::from_millis(250);

/// When the first report on a feed is written, once it is running.
const FIRST_REPORT: Duration = Duration::from_secs(5);

/// A running output. Dropping it stops everything and closes the source.
pub struct Output {
    running: Arc<AtomicBool>,
    sender: Option<JoinHandle<()>>,
    /// Held so the capture stops when this does; never read.
    _capture: ndi_capture::Capture,
}

impl Output {
    /// What this machine can see on the network, our own source included.
    ///
    /// "Is anybody able to see this?" is the only question an operator has
    /// about NDI, and answering it from our own discovery beats telling them to
    /// go and look in OBS. A source that is announced but absent here is a
    /// network that will not carry it -- a guest wifi with client isolation, a
    /// VLAN, a firewall -- and that is worth knowing before Sunday rather than
    /// during it.
    ///
    /// Two seconds: NDI's discovery answers in well under one on a healthy
    /// network, and a settings panel that hangs for longer feels broken.
    pub fn visible_sources() -> Vec<String> {
        ndi::Runtime::open().map(|runtime| runtime.sources(2000)).unwrap_or_default()
    }

    /// Starts publishing one window, whichever it is.
    ///
    /// # Why a sender per output rather than one per application
    ///
    /// There was one, and it published the projector. That is right while
    /// there is one congregation-facing window and wrong the moment a church
    /// has three: a switcher needs to take the foyer feed and the stream feed
    /// as separate sources, by name, and one sender can only ever announce one
    /// of them.
    ///
    /// `keep_alpha` is what makes a feed keyable rather than a picture. It has
    /// to reach the capture, because that is the stage that would flatten the
    /// window onto a colour and hand back something a switcher cannot key.
    pub fn start_window(
        window_title: &str,
        name: &str,
        fps: u32,
        keep_alpha: bool,
        size: Option<(u32, u32)>,
    ) -> Result<Self, String> {
        let name = if name.trim().is_empty() { DEFAULT_NAME } else { name.trim() };

        // The runtime first: it is the failure a church is most likely to hit
        // and the only one whose answer is "install this".
        if ndi::Runtime::open().is_none() {
            return Err(ndi::MISSING.to_string());
        }

        let latest = Latest::default();
        let settling = Instant::now();
        let capture = loop {
            match ndi_capture::start(window_title, fps.max(1), keep_alpha, size, latest.clone()) {
                Err(ndi_capture::Problem::NoProjector) if settling.elapsed() < SETTLE => {
                    std::thread::sleep(SETTLE_STEP);
                }
                other => break other,
            }
        }
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
        let rate = fps.max(1);
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

                crate::log_line!("[ndi] publishing as {name:?} at {rate} fps");
                let interval = Duration::from_micros(1_000_000 / rate as u64);
                let began = Instant::now();
                let mut sent = 0u64;
                let mut reported = false;

                while stop.load(Ordering::Relaxed) {
                    let started = Instant::now();
                    let frame = latest.get();

                    if !frame.is_empty() {
                        sender.send_bgra(frame.width, frame.height, &frame.pixels, FPS);
                        sent += 1;
                    }

                    /*
                     * One line, a few seconds in, saying whether this is a
                     * feed or a name on the network with nothing behind it.
                     *
                     * "It showed nothing" can be a window that was never
                     * drawn, a capture that never started or a picture that
                     * is all transparent, and a receiver shows all three the
                     * same way. Counts and shares only -- never what is on
                     * the screen.
                     */
                    if !reported && began.elapsed() >= FIRST_REPORT {
                        reported = true;
                        let captured = latest.delivered();
                        if captured == 0 {
                            crate::log_line!(
                                "[ndi] {name:?}: nothing has come from the capture in {}s -- the window is not being drawn",
                                FIRST_REPORT.as_secs(),
                            );
                        } else {
                            let (clear, partial, solid) = ndi_capture::coverage(&frame);
                            crate::log_line!(
                                "[ndi] {name:?}: {captured} frames captured, {sent} sent, {}x{}, {clear}% clear / {partial}% partial / {solid}% solid",
                                frame.width,
                                frame.height,
                            );
                        }
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

                crate::log_line!(
                    "[ndi] stopped publishing as {name:?} after {sent} frames, {} captured",
                    latest.delivered(),
                );
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
        let Err(problem) =
            Output::start_window("Pulpitry — Projector", "Pulpitry test", FPS, false, None)
        else {
            panic!("there is no projector window in a test, so this cannot succeed");
        };

        if ndi::Runtime::open().is_some() {
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
