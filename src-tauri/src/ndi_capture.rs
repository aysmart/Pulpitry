//! Taking the projector's pixels, so [`crate::ndi`] has something to send.
//!
//! # Why the window and not the screen
//!
//! The projector is borderless and sized to a monitor rather than truly
//! fullscreen, because macOS fullscreen moves a window to its own Space and
//! takes it away from the operator. That makes screen capture the wrong tool:
//! it would send the desktop underneath whenever the window was not covering
//! everything, and it would send whatever the operator dragged across it -- a
//! notification, a file dialog, their email -- out to the stream and into a
//! recording, in front of a congregation.
//!
//! Capturing the window sends what the window contains and nothing else, and
//! keeps doing so if it is moved to another monitor mid-service.
//!
//! # Only when it changes
//!
//! A projector output is mostly still. A verse goes up and stays up for two
//! minutes; a slide holds through a prayer. So the capture is asked for frames
//! at a modest rate and the send loop repeats the last one at the rate NDI is
//! clocked to -- a receiver wants a steady feed, but nothing is gained by
//! decoding the same still picture sixty times a second.
//!
//! Video playback is the exception, and it is why this captures at all rather
//! than re-drawing the layout in Rust: a re-drawn frame can reproduce a verse
//! and cannot reproduce a video.
//!
//! # macOS asks the operator first
//!
//! ScreenCaptureKit needs Screen Recording permission, even for an
//! application's own window. There is no way around that and no way to ask for
//! it quietly, so the settings panel says what the prompt will be before it
//! appears rather than letting it arrive unexplained.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

// The trait that puts `image_buffer()` on a sample buffer. At module scope
// because both the sink and the copy below need it.
#[cfg(target_os = "macos")]
use screencapturekit::cm::CMSampleBufferExt;

/// One frame, as the sender wants it: 8-bit BGRA, top row first, no padding.
#[derive(Clone, Default)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Frame {
    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0 || self.pixels.is_empty()
    }
}

/// The most recent frame, shared between whoever captures and whoever sends.
///
/// One slot rather than a queue, and deliberately: a frame that arrived while
/// we were still sending the last one is not a frame anybody wants later, it is
/// a frame that is already out of date. Dropping it is the correct behaviour
/// and a queue would only decide when to do so, more slowly.
#[derive(Clone, Default)]
pub struct Latest(Arc<Mutex<Frame>>);

impl Latest {
    pub fn put(&self, frame: Frame) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = frame;
        }
    }

    pub fn get(&self) -> Frame {
        self.0.lock().map(|slot| slot.clone()).unwrap_or_default()
    }
}

/// A capture that stops when it is dropped.
pub struct Capture {
    running: Arc<AtomicBool>,
    #[cfg(target_os = "macos")]
    stream: Option<screencapturekit::stream::SCStream>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);

        #[cfg(target_os = "macos")]
        if let Some(stream) = self.stream.take() {
            // Never `unwrap`: this runs while the application is closing, and a
            // stream the system has already torn down is not a reason to abort.
            if let Err(error) = stream.stop_capture() {
                crate::log_line!("[ndi] the capture did not stop cleanly: {error:?}");
            }
        }
    }
}

/// What went wrong, in words an operator can act on.
///
/// Three outcomes and three different things to do, which is why this is not
/// one string: the window not being open is fixed by opening the projector,
/// permission is fixed in System Settings, and the rest is ours.
#[derive(Debug)]
pub enum Problem {
    /// Nothing to capture. The projector is not open.
    NoProjector,
    /// macOS has not been told this application may record the screen.
    NotPermitted,
    /// Anything else, already logged.
    Failed(String),
}

impl std::fmt::Display for Problem {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoProjector => write!(
                out,
                "The projector is not open, so there is nothing to send. Open it first.",
            ),
            Self::NotPermitted => write!(
                out,
                "macOS has not given Pulpitry permission to record the screen, which is what \
                 reading the projector window needs. Allow Pulpitry under Privacy & Security → \
                 Screen Recording, then reopen Pulpitry.",
            ),
            Self::Failed(detail) => write!(out, "The projector could not be captured: {detail}"),
        }
    }
}

#[cfg(target_os = "macos")]
pub fn start(window_title: &str, fps: u32, latest: Latest) -> Result<Capture, Problem> {
    use screencapturekit::shareable_content::SCShareableContent;
    use screencapturekit::stream::configuration::SCStreamConfiguration;
    use screencapturekit::stream::content_filter::SCContentFilter;
    use screencapturekit::stream::output_trait::SCStreamOutputTrait;
    use screencapturekit::stream::output_type::SCStreamOutputType;
    use screencapturekit::stream::SCStream;

    /*
     * Asking what is shareable is also how permission is asked for.
     *
     * The first call raises the system prompt and fails until it is granted, so
     * a failure here is far more likely to be an operator who has not answered
     * yet than a real fault -- and telling them "capture failed" when the
     * answer is a checkbox in System Settings is the unhelpful version of true.
     */
    let content = SCShareableContent::get()
        .map_err(|error| {
            crate::log_line!("[ndi] shareable content refused: {error:?}");
            Problem::NotPermitted
        })?;

    /*
     * Our own window, by title and by process.
     *
     * The title alone is not enough. A church may have a browser tab, a file, or
     * a second copy of these notes open with the same words in the title bar,
     * and sending somebody else's window to the stream would be the worst
     * possible failure of this feature. The process id makes it exact.
     */
    let ours = std::process::id();
    let window = content
        .windows()
        .into_iter()
        .find(|window| {
            let mine = window
                .owning_application()
                .is_some_and(|app| app.process_id() as u32 == ours);
            mine && window.title().as_deref() == Some(window_title)
        })
        .ok_or(Problem::NoProjector)?;

    let width = window.frame().size.width as u32;
    let height = window.frame().size.height as u32;
    if width == 0 || height == 0 {
        return Err(Problem::NoProjector);
    }

    let filter = SCContentFilter::create().with_window(&window).build();

    // BGRA is this crate's default and is what the sender wants, so the pixels
    // go from the compositor to the network without a per-pixel touch on the
    // way. Set explicitly all the same: a default is not a promise.
    let mut configuration = SCStreamConfiguration::new();
    configuration
        .set_width(width)
        .set_height(height)
        .set_pixel_format(screencapturekit::stream::configuration::pixel_format::PixelFormat::BGRA)
        .set_fps(fps.max(1));

    struct Sink {
        latest: Latest,
    }

    impl SCStreamOutputTrait for Sink {
        fn did_output_sample_buffer(
            &self,
            sample: screencapturekit::cm::CMSampleBuffer,
            of_type: SCStreamOutputType,
        ) {
            if of_type != SCStreamOutputType::Screen {
                return;
            }
            if let Some(frame) = frame_from(&sample) {
                self.latest.put(frame);
            }
        }
    }

    let mut stream = SCStream::new(&filter, &configuration);
    stream.add_output_handler(Sink { latest }, SCStreamOutputType::Screen);
    stream
        .start_capture()
        .map_err(|error| Problem::Failed(format!("{error:?}")))?;

    crate::log_line!("[ndi] capturing the projector at {width}x{height}, {fps} fps");
    Ok(Capture { running: Arc::new(AtomicBool::new(true)), stream: Some(stream) })
}

/// Copies a captured buffer into a tightly packed frame.
///
/// The copy is not avoidable and not regretted. A captured buffer belongs to
/// the system and is recycled the moment this returns, and its rows are padded
/// to an alignment the sender does not want -- so the choice is a copy here or
/// a copy inside NDI, and doing it here is where the padding can be dropped at
/// the same time.
#[cfg(target_os = "macos")]
fn frame_from(sample: &screencapturekit::cm::CMSampleBuffer) -> Option<Frame> {
    let buffer = sample.image_buffer()?;

    // Read-only: the system owns these pixels and recycles them, and a
    // read-write lock would ask it to give up any hardware surface backing.
    let locked = buffer.lock_read_only().ok()?;

    let width = buffer.width() as u32;
    let height = buffer.height() as u32;
    let stride = buffer.bytes_per_row();

    let row = width as usize * 4;
    if width == 0 || height == 0 || stride < row {
        return None;
    }

    let base = locked.base_address();
    if base.is_null() {
        return None;
    }

    let mut pixels = Vec::with_capacity(row * height as usize);
    for line in 0..height as usize {
        // Row by row, dropping the padding the compositor aligns each line to.
        // Reading `stride * height` in one go and trimming later would copy the
        // padding as well, and on a 4K frame that is megabytes a second of it.
        let from = unsafe { base.add(line * stride) };
        pixels.extend_from_slice(unsafe { std::slice::from_raw_parts(from, row) });
    }

    Some(Frame { width, height, pixels })
}

#[cfg(not(target_os = "macos"))]
pub fn start(_window_title: &str, _fps: u32, _latest: Latest) -> Result<Capture, Problem> {
    // Windows is next, and is the platform this feature is really for -- a
    // church with a video team is usually running Windows. Until then the
    // settings panel offers nothing rather than offering something that fails.
    Err(Problem::Failed(
        "Sending the projector over NDI is macOS-only in this version.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_latest_frame_replaces_rather_than_queues() {
        // A frame that arrived while the last one was still going out is not a
        // frame anybody wants later: it is already wrong. Keeping only the
        // newest is the behaviour, not an optimisation.
        let latest = Latest::default();
        latest.put(Frame { width: 2, height: 1, pixels: vec![1; 8] });
        latest.put(Frame { width: 2, height: 1, pixels: vec![9; 8] });
        assert_eq!(latest.get().pixels, vec![9; 8]);
    }

    #[test]
    fn nothing_captured_yet_is_an_empty_frame_rather_than_a_panic() {
        // The send loop starts before the first frame arrives, every time.
        assert!(Latest::default().get().is_empty());
    }

    /// The three failures an operator can actually do something about.
    #[test]
    fn each_problem_says_what_to_do_about_it() {
        assert!(Problem::NoProjector.to_string().contains("Open it"));
        assert!(Problem::NotPermitted.to_string().contains("Screen Recording"));
        assert!(Problem::Failed("disk on fire".into()).to_string().contains("disk on fire"));
    }
}
