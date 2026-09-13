//! The congregation-facing display, and the live content it shows.
//!
//! Live content is owned here rather than in either window. That matters for
//! one reason: the projector can be opened at any point during a service, and
//! it has to come up showing whatever is already live rather than blank until
//! the operator next presses Display. Both windows read the same state and
//! react to the same event, so they cannot disagree about what the
//! congregation is seeing.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const EVENT_LIVE: &str = "live:changed";
pub const EVENT_AUDIO: &str = "audio:changed";
pub const EVENT_TICKER: &str = "ticker:changed";
pub const EVENT_MEDIA: &str = "media:command";
pub const EVENT_MEDIA_PROGRESS: &str = "media:progress";
pub const EVENT_THEME: &str = "theme:changed";
pub const EVENT_STAGE: &str = "stage:changed";
/**
 * A display shape was drawn over or deleted; payload is its library id.
 *
 * Appearance is otherwise *fetched* by each window rather than pushed to it,
 * which is right for a look: a window asks after a settings save and the answer
 * depends on which output it is. A shape is the one piece of appearance that
 * changes without the settings changing at all — the studio writes a catalog
 * row — so an output drawing it went on drawing the version it read when it
 * opened, and an operator moving the band watched nothing happen on the wall.
 *
 * The id rather than the elements: the window already knows how to read one,
 * and the ones that do not name this shape then do nothing at all.
 */
pub const EVENT_SHAPE: &str = "shape:changed";
pub const WINDOW_LABEL: &str = "projector";
/**
 * A second congregation-facing display.
 *
 * The same view on another screen -- an overflow room, a foyer, a second hall.
 * It loads `projector.html` exactly as the first one does, so the content, the
 * theme and every future change to either arrive in both without anybody
 * remembering to do it twice.
 *
 * A separate window rather than a wider one: the two screens are rarely
 * adjacent and never the same size, and a window stretched across both would
 * put half a verse in each room.
 */
pub const SECOND_LABEL: &str = "second";

/// The reserved id of the first output.
///
/// Its window keeps the label and the title it has always had, because other
/// things already know them: `ndi_capture` finds "Pulpitry — Projector" by
/// name, and a church's switcher has a source by that name in its list. A
/// generalisation that renamed it would take a working feed off the air on
/// upgrade, which is not a thing to do to somebody on a Sunday.
pub const MAIN_ID: &str = "main";

/// The reserved id of the second display, for the same reason.
pub const SECOND_ID: &str = "second";

/// The window label for an output.
///
/// The two reserved ids keep their original labels; everything else is
/// prefixed so nothing can collide with them, or with a label some future
/// window wants. The id is the output's own, generated once and never reused,
/// so a label cannot be inherited by a different output later and start
/// showing the wrong translation on a screen nobody re-checked.
pub fn label_for(id: &str) -> String {
    match id {
        MAIN_ID => WINDOW_LABEL.to_string(),
        SECOND_ID => SECOND_LABEL.to_string(),
        other => format!("output-{other}"),
    }
}

/// The output a window label belongs to: `label_for` read backwards.
///
/// Wanted because a window sometimes has to act on itself -- Escape closing the
/// screen it is drawn on -- and all it knows about itself is its label. Kept
/// beside `label_for` and tested against it, because the two drifting apart
/// would mean a window closing a different screen from the one in front of the
/// person pressing the key.
pub fn id_for(label: &str) -> String {
    match label {
        WINDOW_LABEL => MAIN_ID.to_string(),
        SECOND_LABEL => SECOND_ID.to_string(),
        other => other.strip_prefix("output-").unwrap_or(other).to_string(),
    }
}

/// The label of the window the operator works in.
pub const OPERATOR_LABEL: &str = "operator";

/**
 * Whether a window is sitting on the screen the desk is on.
 *
 * An output is a borderless window with no title bar, always on top, filling a
 * screen, with the pointer hidden — which is exactly right on a wall and
 * indistinguishable from a crash when it lands on the only screen the operator
 * has. Opening one there is allowed on purpose: somebody setting this up at
 * home has one screen and still wants to see what it looks like. What was
 * missing is that the window knew nothing about where it had landed, so it
 * behaved as though it were on a wall in a hall.
 *
 * By monitor rather than by index: the window was told an index when it opened,
 * and screens are unplugged, rearranged and woken up in a different order. What
 * matters is where it is now, which is a question only the window can answer.
 */
pub fn covers_desk(app: &AppHandle, label: &str) -> bool {
    let Some(mine) = app.get_webview_window(label) else {
        return false;
    };

    /*
     * An output with no screen is never covering one.
     *
     * It is parked past the left edge of the leftmost monitor (see
     * `PAST_THE_EDGE`) so nothing composites it away, and a window out there
     * is still answered by `current_monitor` with the nearest screen -- which
     * is usually the desk's. Taken at face value that would put a pointer and a
     * "press Esc" chip into an NDI feed on its way to a switcher, which is the
     * one place neither may ever appear. So the window's own corner is checked
     * against the screens first: on none of them means on no screen.
     */
    let Ok(at) = mine.outer_position() else {
        return false;
    };
    let on_a_screen = app.available_monitors().is_ok_and(|monitors| {
        monitors.iter().any(|monitor| {
            let corner = monitor.position();
            let size = monitor.size();
            at.x >= corner.x
                && at.y >= corner.y
                && at.x < corner.x + size.width as i32
                && at.y < corner.y + size.height as i32
        })
    });
    if !on_a_screen {
        return false;
    }

    let screen = |window: tauri::WebviewWindow| {
        window
            .current_monitor()
            .ok()
            .flatten()
            .and_then(|monitor| monitor.name().cloned())
    };

    match (
        screen(mine),
        app.get_webview_window(OPERATOR_LABEL).and_then(screen),
    ) {
        (Some(mine), Some(desk)) => mine == desk,
        // Unknown is answered as "no": the pointer and the way out are worth
        // showing where they are needed and not worth putting on a wall on a
        // guess.
        _ => false,
    }
}

/// What the window is called in the title bar, and therefore to the capture.
///
/// `ndi_capture` finds a window by title and process id, so this is not
/// cosmetic: two outputs sharing a title makes which one reaches the network
/// a coin toss. The operator's name for an output is not unique -- two can
/// both be called "Foyer" -- so the id is what actually tells them apart, and
/// it is in the title for that reason rather than for anybody to read.
pub fn title_for(id: &str, name: &str) -> String {
    match id {
        MAIN_ID => "Pulpitry — Projector".to_string(),
        SECOND_ID => "Pulpitry — Second display".to_string(),
        other if name.trim().is_empty() => format!("Pulpitry — Output [{other}]"),
        other => format!("Pulpitry — {} [{other}]", name.trim()),
    }
}

/// How far past the desktop's left edge a screenless output is placed.
///
/// # Why not simply a very large negative number
///
/// It was -32000, which on macOS is only a coordinate -- and on Windows is
/// the position the system reports for a *minimised* window. Code that finds
/// a window there takes it for minimised and restores it somewhere sensible,
/// which is on a screen: an NDI-only output appeared on the source laptop in
/// front of whoever was using it. The spike that approved off-screen windows
/// ran on a Mac, which is exactly why it did not see this.
///
/// So the window goes just beyond wherever the leftmost monitor actually
/// ends, measured each time. Off every screen, composited as an ordinary
/// window, and nowhere near a value any platform treats specially.
const PAST_THE_EDGE: f64 = 200.0;

/// What every webview in the application is started with on Windows.
///
/// # Why an output needs it
///
/// WebView2 is Chromium, and Chromium stops drawing a window it calculates is
/// covered or off every screen -- the same economy WebKit makes on a Mac (see
/// [`keep_painting`]). An output with no screen is off every screen by design,
/// so without this its network feed would be whatever was drawn before it was
/// moved there, for the rest of the service. `CalculateNativeWinOcclusion` is
/// the Chromium feature that does the calculating.
///
/// Unverified on Windows, as all of Windows is until a release reaches a
/// machine. A feed from a screenless output that freezes or never shows the
/// verse is this paragraph being wrong.
///
/// # Why it is on every window and not only the outputs
///
/// WebView2 will not start a second webview with different arguments from the
/// first; the window fails to open. So the operator window in
/// `tauri.conf.json` carries this exact string too, and a test holds the two
/// together.
///
/// The first three features and the autoplay flag are what wry passes when
/// nobody says anything. Naming our own replaces those rather than adding to
/// them, so they are repeated here -- autoplay is what lets a video background
/// start on a screen nobody can click.
pub const WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required";

/// Keeps an output's page drawing when macOS says nobody can see it.
///
/// # What went wrong without it
///
/// An NDI-only output on a Mac appeared on the network and showed nothing.
/// Measured in the window itself: `document.visibilityState` was `hidden`, no
/// animation frames ran, and its timers fired forty seconds late in a burst.
/// WebKit asks the window server whether any of a window is visible, and for
/// one placed off every screen the answer is no -- so it stops drawing, and the
/// capture faithfully sends the page as it was before anything went live.
///
/// # What does not fix it
///
/// Tauri's background-throttling policy, measured: the timers came back, the
/// page stayed hidden and nothing was drawn. It governs scheduling, not
/// whether the view counts as visible.
///
/// # What does
///
/// Telling the webview not to consult occlusion at all -- a private WebKit
/// switch, asked for by selector and skipped if a future macOS drops it -- and
/// then hiding and showing the view once, because WebKit only re-reads its
/// visibility when something changes. Measured afterwards: `visible`, sixty
/// frames a second, off every screen.
///
/// The cost is that an output keeps drawing while it is covered. It has work
/// to do only when something on it changes, and an output that has stopped
/// drawing is an output that has stopped working.
#[cfg(target_os = "macos")]
fn keep_painting(window: &tauri::WebviewWindow) {
    let done = window.with_webview(|platform| {
        let view = platform.inner() as *mut objc2::runtime::AnyObject;
        if view.is_null() {
            return;
        }
        // SAFETY: `view` is the live WKWebView wry hands us on the main thread,
        // and each message is sent only after the view says it answers it.
        unsafe {
            let switch = objc2::sel!(_setWindowOcclusionDetectionEnabled:);
            let answers: bool = objc2::msg_send![view, respondsToSelector: switch];
            if !answers {
                crate::log_line!("[projector] this WebKit has no occlusion switch; a covered output may stop drawing");
                return;
            }
            let () = objc2::msg_send![view, _setWindowOcclusionDetectionEnabled: false];
            let () = objc2::msg_send![view, setHidden: true];
            let () = objc2::msg_send![view, setHidden: false];
        }
    });
    if let Err(error) = done {
        crate::log_line!("[projector] could not reach the output's webview: {error}");
    }
}

/// What the platform sees, and only the platform.
///
/// # Why this is not the congregation's screen with extras on it
///
/// A stage display answers questions the congregation must never be asked:
/// how long have I been speaking, what is next, and is the person at the desk
/// trying to tell me something. Putting any of that on the wall would be a
/// mistake nobody could take back, so a stage output carries its own state and
/// draws its own view rather than being the projector with a clock added.
///
/// The timer is a start instant rather than a count, deliberately. A count
/// broadcast every second is a message a second from a machine that has a
/// service to run, and it drifts the moment one is dropped; an instant is sent
/// once and each screen counts for itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StageState {
    /// Unix milliseconds the timer was started, or zero for a timer that is
    /// not running. Not an elapsed count: see above.
    pub started_at: i64,
    /// Where the timer is counting to, in minutes. Zero counts up instead.
    ///
    /// Both are wanted and by different people: a preacher wants to know how
    /// long they have been going, and a service leader wants to know how long
    /// is left. Counting down is the one that changes behaviour, so it is
    /// offered rather than assumed.
    pub limit_minutes: i64,
    /// A line from the desk to the platform. Never reaches a congregation.
    pub note: String,
    /// What comes after this in the service plan, as the plan labels it.
    ///
    /// Empty when there is no plan, or when the plan has run out. Filled by
    /// the operator window, which is the only place that knows both the
    /// running order and where it has got to -- and sending the label rather
    /// than the plan keeps the congregation-facing window ignorant of the
    /// library, which is most of why it can be trusted.
    ///
    /// # Why a preacher wants this
    ///
    /// Knowing what is coming is the difference between finishing a point and
    /// trailing off. It is also the question that otherwise gets asked by
    /// turning round and mouthing it at the desk, in front of everybody.
    #[serde(default)]
    pub next_up: String,
}

/// One verse within a passage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptureLine {
    pub number: i64,
    pub text: String,
}

/// A run of authored text with the little formatting a slide needs.
///
/// Structured rather than HTML on purpose. Rich text from an editor would have
/// to be sanitised before it could be injected into the projector, and getting
/// that wrong is a real hazard; a closed set of fields cannot carry markup at
/// all.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub text: String,
    /// "heading" or "body".
    pub level: String,
    /// "left", "center" or "right".
    pub align: String,
    pub bold: bool,
    pub italic: bool,
}

/// What the congregation is looking at.
///
/// A tagged union rather than a single string, because the things a service
/// needs to put on a screen are genuinely different shapes: a passage is a
/// numbered sequence, a song section is unnumbered lines that must break where
/// they were written, an image has no text at all, and a clip has a timeline.
/// Flattening them all to one block of text would lose something in each case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LiveBody {
    /// One or more verses shown together.
    Scripture { lines: Vec<ScriptureLine> },
    /// A labelled block of lyrics. Line breaks are the author's and are kept.
    Lyric { lines: Vec<String> },
    /// Free text the operator wrote.
    RichText { blocks: Vec<TextBlock> },
    /*
     * `fill` crosses with them, and has to.
     *
     * Everything the projector draws goes through this type, and `serde` drops
     * a field it does not know about without saying so. The switch worked on
     * Preview, which reads the catalogue item directly, and did nothing on
     * Live or the wall -- both of which come back through here.
     *
     * That is the fourth feature lost to this exact hole: a slide's
     * components, a mirrored comparison, a background image, and now this.
     */
    Image {
        path: String,
        #[serde(default)]
        fill: bool,
    },
    Media {
        path: String,
        looping: bool,
        #[serde(default)]
        fill: bool,
    },
    /**
     * A slide made of components: text, a list, a table, a quote, a reference.
     *
     * Carried rather than understood. This side puts what is live in front of
     * the projector window and never draws it, so mirroring the component union
     * here would be a second definition to keep in step with the one in
     * `projector.ts` for no benefit -- and the two would drift the first time
     * either gained a kind.
     *
     * It exists because it did not: a composed slide failed to deserialise
     * here, `set_live` returned an error, and nothing reached the wall. Preview
     * drew the table perfectly, because Preview never crosses this bridge.
     */
    Composed { components: Vec<serde_json::Value>, layout: String },
    /**
     * A slide laid out by hand, with the deck's background travelling with it.
     *
     * Carried, not understood, for the same reason `Composed` is: this side
     * hands what is live to the windows that draw it and never draws one
     * itself. The background is here rather than read from settings because
     * four surfaces render this -- the projector, the second display, the
     * mirror and a paired Castavox -- and a deck whose gradient stayed in the
     * library would be drawn against whatever theme each of them held.
     */
    Designed {
        elements: Vec<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        background: Option<serde_json::Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveContent {
    pub body: LiveBody,
    /// Shown small beneath: a reference, a song title, or nothing.
    pub caption: String,
    /// Verse ids behind this, so lists can highlight what is live. Empty for
    /// anything that did not come from the verse library.
    #[serde(default)]
    pub ids: Vec<i64>,
    /// How far through a long body it has been wound, 0 at the top and 1 at
    /// the end.
    ///
    /// A fraction rather than a screen number, because every surface showing
    /// this holds a different amount of text -- the projector, the second
    /// display, a paired Castavox -- and a screen number is a place that exists
    /// on one of them and not the others.
    #[serde(default)]
    pub progress: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    /// True when the projector window is currently on this display.
    pub in_use: bool,
    /**
     * True where the operator's own window is.
     *
     * Choosing this one is allowed and is sometimes exactly what is wanted --
     * one laptop, nothing plugged in, setting the thing up at home. But an
     * output covers the screen completely and always sits on top, so choosing
     * it hides the desk, and an operator who did not know that has every reason
     * to read it as the application having crashed. Said here so the pane can
     * say it too.
     */
    pub is_desk: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectorState {
    pub open: bool,
    pub display: Option<usize>,
}

/// How loud a clip plays, and whether it plays at all.
///
/// Deliberately not persisted. An operator who left the volume down last week
/// would otherwise open a service to silent video and no obvious reason why;
/// starting audible and letting them turn it down is the safer default.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioState {
    pub muted: bool,
    /// 0.0 to 1.0.
    pub volume: f32,
}

impl Default for AudioState {
    fn default() -> Self {
        Self { muted: false, volume: 1.0 }
    }
}

/// What the operator has asked the clip to do.
///
/// Held here rather than in a window because two surfaces render the same
/// clip. Both obey this, so pausing in the operator's pane pauses the wall.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaCommand {
    pub playing: bool,
    pub looping: bool,
    /// Bumped whenever a jump is asked for. A bare position could not express
    /// it: "go back to the start" twice running is two instructions, not one,
    /// and an unchanged number would look like no instruction at all.
    pub seek_nonce: u64,
    pub seek_to: f32,
}

impl Default for MediaCommand {
    fn default() -> Self {
        Self { playing: true, looping: false, seek_nonce: 0, seek_to: 0.0 }
    }
}

/// Where the clip has actually reached.
///
/// Reported by whichever surface is the output — the projector when it is
/// open, the operator's pane otherwise — so the number on the transport is a
/// real position rather than an estimate.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaProgress {
    pub position: f32,
    pub duration: f32,
    /// A clip that has run out holds its last frame. Blanking the screen
    /// unasked mid-service would be worse than a still picture.
    pub ended: bool,
}

/// A band of text crawling across the screen, over whatever is live.
///
/// Not persisted, like everything else that describes what is on the screen
/// right now. An announcement is for one gathering, and a ticker that came
/// back by itself a week later — quite possibly about an event that has
/// already happened — would be worse than retyping it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Ticker {
    pub text: String,
    pub visible: bool,
    /// Its own colour rather than the theme's: the band sits on a scrim, not
    /// on the background, so what reads there is a different question.
    pub text_color: String,
    /// The scrim behind the words, and how much of the screen shows through.
    pub band_color: String,
    /// 0 to 1. Zero leaves the words floating on whatever is behind them.
    pub band_opacity: f32,
    /// "top" or "bottom". Bottom by default: it is the half of the screen
    /// least likely to be carrying the words people are reading.
    pub position: String,
    /// Seconds for one pass across the screen. Larger is slower.
    pub speed: f32,
}

impl Default for Ticker {
    fn default() -> Self {
        Self {
            text: String::new(),
            visible: false,
            text_color: "#F4F1EA".into(),
            band_color: "#000000".into(),
            band_opacity: 0.45,
            position: "bottom".into(),
            speed: 24.0,
        }
    }
}

pub struct Projector {
    app: AppHandle,
    live: Mutex<Option<LiveContent>>,
    ticker: Mutex<Ticker>,
    display: Mutex<Option<usize>>,
    second: Mutex<Option<usize>>,
    /// Where each output's window landed, by output id. `None` for one that
    /// has no screen and exists only on the network.
    windows: Mutex<std::collections::HashMap<String, Option<usize>>>,
    /// Whether each output's window was built see-through, by output id.
    ///
    /// Remembered because it cannot be changed afterwards: a window has paper
    /// or it does not from the moment it exists. See [`Self::refit`].
    keyable: Mutex<std::collections::HashMap<String, bool>>,
    audio: Mutex<AudioState>,
    media: Mutex<MediaCommand>,
    progress: Mutex<MediaProgress>,
    stage: Mutex<StageState>,
}

impl Projector {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            live: Mutex::new(None),
            ticker: Mutex::new(Ticker::default()),
            display: Mutex::new(None),
            second: Mutex::new(None),
            windows: Mutex::new(std::collections::HashMap::new()),
            keyable: Mutex::new(std::collections::HashMap::new()),
            audio: Mutex::new(AudioState::default()),
            media: Mutex::new(MediaCommand::default()),
            progress: Mutex::new(MediaProgress::default()),
            stage: Mutex::new(StageState::default()),
        })
    }

    pub fn stage(&self) -> StageState {
        self.stage.lock().clone()
    }

    /// Sets what the platform sees, and tells every window at once.
    ///
    /// Broadcast like content rather than fetched like appearance: two stage
    /// screens showing different timers would be worse than one, and a
    /// preacher checking two clocks is a preacher not preaching.
    pub fn set_stage(&self, state: StageState) -> StageState {
        *self.stage.lock() = state.clone();
        let _ = self.app.emit(EVENT_STAGE, &state);
        state
    }

    pub fn ticker(&self) -> Ticker {
        self.ticker.lock().clone()
    }

    pub fn set_ticker(&self, ticker: Ticker) -> Ticker {
        let clamped = Ticker {
            // A pass faster than about six seconds cannot be read; slower than
            // two minutes looks stopped.
            speed: ticker.speed.clamp(6.0, 120.0),
            ..ticker
        };
        {
            let mut current = self.ticker.lock();
            if *current == clamped {
                return clamped;
            }
            *current = clamped.clone();
        }
        let _ = self.app.emit(EVENT_TICKER, clamped.clone());
        clamped
    }

    pub fn media(&self) -> MediaCommand {
        *self.media.lock()
    }

    pub fn set_media(&self, command: MediaCommand) -> MediaCommand {
        {
            let mut current = self.media.lock();
            if *current == command {
                return command;
            }
            *current = command;
        }
        let _ = self.app.emit(EVENT_MEDIA, command);
        command
    }

    pub fn progress(&self) -> MediaProgress {
        *self.progress.lock()
    }

    /// Called by the surface that is actually playing.
    pub fn report_progress(&self, progress: MediaProgress) {
        {
            let mut current = self.progress.lock();
            if *current == progress {
                return;
            }
            *current = progress;
        }
        let _ = self.app.emit(EVENT_MEDIA_PROGRESS, progress);
    }

    pub fn audio(&self) -> AudioState {
        *self.audio.lock()
    }

    /// Sets the volume everywhere at once.
    ///
    /// Held here rather than in either window for the same reason as `live`:
    /// the operator's pane and the projector must not disagree about what the
    /// congregation is hearing.
    pub fn set_audio(&self, state: AudioState) -> AudioState {
        let clamped = AudioState {
            muted: state.muted,
            volume: state.volume.clamp(0.0, 1.0),
        };
        {
            let mut current = self.audio.lock();
            if *current == clamped {
                return clamped;
            }
            *current = clamped;
        }
        let _ = self.app.emit(EVENT_AUDIO, clamped);
        clamped
    }

    pub fn live(&self) -> Option<LiveContent> {
        self.live.lock().clone()
    }

    /// Sets what is live and tells every window at once.
    pub fn set_live(&self, content: Option<LiveContent>) {
        {
            let mut current = self.live.lock();
            if *current == content {
                return;
            }
            *current = content.clone();
        }

        // A clip going up starts from the beginning, playing, at whatever loop
        // setting it was imported with. Inheriting the last clip's paused,
        // half-finished transport would be baffling.
        if let Some(LiveBody::Media { looping, .. }) = content.as_ref().map(|live| &live.body) {
            let nonce = self.media.lock().seek_nonce.wrapping_add(1);
            self.report_progress(MediaProgress::default());
            self.set_media(MediaCommand {
                playing: true,
                looping: *looping,
                seek_nonce: nonce,
                seek_to: 0.0,
            });
        }
        // Emitted to all windows: the operator's Live pane and the projector
        // render from the same message, so they cannot drift apart.
        let _ = self.app.emit(EVENT_LIVE, content);
    }

    pub fn state(&self) -> ProjectorState {
        ProjectorState {
            open: self.app.get_webview_window(WINDOW_LABEL).is_some(),
            display: *self.display.lock(),
        }
    }

    pub fn displays(&self) -> Result<Vec<Display>> {
        let in_use = *self.display.lock();
        Self::enumerate(&self.app, in_use)
    }

    /// Reads the monitor list. Only ever called on the main thread.
    fn enumerate(app: &AppHandle, in_use: Option<usize>) -> Result<Vec<Display>> {
        let monitors = app
            .available_monitors()
            .map_err(|err| anyhow!("could not enumerate displays: {err}"))?;
        let primary = app
            .primary_monitor()
            .ok()
            .flatten()
            .and_then(|monitor| monitor.name().cloned());
        // By name, not by index: the operator can drag their window to another
        // screen and the list is read again every time the pane opens.
        let desk = app
            .get_webview_window(OPERATOR_LABEL)
            .and_then(|window| window.current_monitor().ok().flatten())
            .and_then(|monitor| monitor.name().cloned());

        Ok(monitors
            .iter()
            .enumerate()
            .map(|(index, monitor)| {
                let name = monitor
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("Display {}", index + 1));
                let size = monitor.size();
                Display {
                    index,
                    is_primary: primary.as_ref() == Some(&name),
                    is_desk: desk.as_ref() == Some(&name),
                    name,
                    width: size.width,
                    height: size.height,
                    in_use: in_use == Some(index),
                }
            })
            .collect())
    }

    /// Opens an output's window, or moves it if it is already open.
    ///
    /// The one place a congregation-facing window is built. It was two copies
    /// of this -- `place` and `place_second`, identical but for a label and a
    /// title -- and a third output would have made it three, which is how a
    /// setting comes to be honoured on two screens out of three.
    ///
    /// `display` of `None` puts the window off the desktop. It is still drawn,
    /// still captured, and still an ordinary window; it simply has no screen,
    /// which is what an output that exists only on the network is.
    ///
    /// # Must not be called from a synchronous command
    ///
    /// Tauri runs a synchronous command on the main thread, and building a
    /// WebView2 window needs that thread free to pump its message loop while
    /// the webview starts. Called from one, it waits for a loop that is waiting
    /// for it -- and because every IPC message crosses that loop, the whole app
    /// stops answering: no scripture, no songs, no settings, and nothing to
    /// connect the symptom to the projector.
    ///
    /// So every command that reaches this is async. macOS does not care either
    /// way, which is why this only ever showed up on Windows.
    pub fn open_output(
        &self,
        id: &str,
        name: &str,
        display: Option<usize>,
        size: (u32, u32),
        overlay: bool,
    ) -> Result<Option<usize>> {
        let label = label_for(id);
        let title = title_for(id, name);

        // A monitor decides its own position and size; an output without one
        // is told, because there is nothing to ask.
        let (position, extent, landed) = match display {
            Some(requested) => {
                let index = Self::chosen(&self.app, Some(requested))?;
                let monitors = self
                    .app
                    .available_monitors()
                    .map_err(|err| anyhow!("could not enumerate displays: {err}"))?;
                let monitor = &monitors[index];
                let at = monitor.position();
                let of = monitor.size();
                (
                    (at.x as f64, at.y as f64),
                    (of.width as f64, of.height as f64),
                    Some(index),
                )
            }
            None => {
                let wide = size.0.max(16) as f64;
                let high = size.1.max(16) as f64;
                // The leftmost edge of every monitor there is, so the window
                // clears all of them whatever order they are arranged in.
                let (left, top) = self
                    .app
                    .available_monitors()
                    .ok()
                    .and_then(|monitors| {
                        monitors
                            .iter()
                            .map(|monitor| (monitor.position().x as f64, monitor.position().y as f64))
                            .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1)))
                    })
                    .unwrap_or((0.0, 0.0));
                ((left - wide - PAST_THE_EDGE, top), (wide, high), None)
            }
        };

        if let Some(window) = self.app.get_webview_window(&label) {
            if self.keyable.lock().get(id).copied() == Some(overlay) {
                // Already open: move it rather than tearing down a live display.
                return Ok(self.move_open(id, &window, position, extent, landed));
            }
            /*
             * Open, but with the wrong paper, and that cannot be changed in
             * place: a window is transparent or not from the moment it is
             * built. An output opened as a full picture and then switched to a
             * lower third kept its opaque window, and the lower third went out
             * over NDI on a solid block.
             *
             * So it is closed and built again: a blink, once, when its look
             * changes between a full picture and an overlay.
             */
            let _ = window.destroy();
            let asked = std::time::Instant::now();
            while self.app.get_webview_window(&label).is_some()
                && asked.elapsed() < std::time::Duration::from_secs(2)
            {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }

        let window = WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::App("projector.html".into()))
            .title(&title)
            // Borderless and sized to the monitor rather than true fullscreen:
            // fullscreen on macOS moves the window to its own Space, which
            // takes it away from the operator and animates on every change.
            .decorations(false)
            .resizable(false)
            // Only over a screen somebody is watching. An off-desktop window
            // kept above everything can surprise an operator if a monitor is
            // unplugged and the desktop re-arranges under it.
            .always_on_top(landed.is_some())
            // Not in the taskbar or the window switcher when it has no screen.
            // A window nobody is meant to see should not be one a volunteer can
            // Alt-Tab onto mid-service and then close.
            .skip_taskbar(landed.is_none())
            // Nor does it take the keyboard when it opens. Built focused, it
            // would take the operator's shortcuts with it -- the space bar
            // going to a window that is not on any screen.
            .focused(landed.is_some())
            .position(position.0, position.1)
            .inner_size(extent.0, extent.1)
            /*
             * Transparent, for an output that is furniture rather than a
             * picture.
             *
             * An overlay is drawn on nothing so the far end can key it over
             * a camera. That needs three things to agree, and this is the
             * first: the window itself must have no paper. The page draws no
             * backdrop, and the capture is told to keep the alpha rather than
             * flattening it onto a colour.
             *
             * The paper stays for a full-screen output, because a projector
             * that flashed black between items would be the one thing
             * distinguishing it from a screen showing nothing.
             */
            .transparent(overlay)
            // A window's drop shadow is captured with it, and a grey halo
            // down two edges of an overlay is not something a switcher can
            // key away.
            .shadow(!overlay)
            .background_color(if overlay {
                tauri::window::Color(0, 0, 0, 0)
            } else {
                tauri::window::Color(244, 241, 234, 255)
            })
            .additional_browser_args(WEBVIEW_ARGS)
            .build()
            .map_err(|err| anyhow!("could not open the {name} window: {err}"))?;

        // Unconditionally, and not only for an output with no screen: one on a
        // monitor that something covers -- a stage display under a slide
        // deck, a feed on the laptop screen under the operator's window -- is
        // just as occluded, and its network feed would freeze just the same.
        #[cfg(target_os = "macos")]
        keep_painting(&window);
        #[cfg(not(target_os = "macos"))]
        let _ = window;

        self.windows.lock().insert(id.to_string(), landed);
        self.keyable.lock().insert(id.to_string(), overlay);
        Ok(landed)
    }

    /// Moves a window that is already open rather than tearing down a live display.
    fn move_open(
        &self,
        id: &str,
        window: &tauri::WebviewWindow,
        position: (f64, f64),
        extent: (f64, f64),
        landed: Option<usize>,
    ) -> Option<usize> {
        /*
         * In the units the window was built in.
         *
         * A monitor's position and size are physical pixels, and are moved as
         * such. An output with no screen was built at its width and height in
         * logical units -- and moving it in physical ones halved it on a
         * Retina Mac, where a 1920x1080 feed became a 960x540 window that the
         * capture then stretched back to 1920: soft text, from a setting
         * nobody changed.
         */
        if landed.is_some() {
            let _ = window.set_position(tauri::PhysicalPosition::new(position.0, position.1));
            let _ = window.set_size(tauri::PhysicalSize::new(extent.0, extent.1));
        } else {
            let _ = window.set_position(tauri::LogicalPosition::new(position.0, position.1));
            let _ = window.set_size(tauri::LogicalSize::new(extent.0, extent.1));
        }
        let _ = window.set_skip_taskbar(landed.is_none());
        // Not focused when it has no screen: taking the operator's focus to
        // a window they cannot see is the worst kind of nothing happening.
        if landed.is_some() {
            let _ = window.set_focus();
        }
        self.windows.lock().insert(id.to_string(), landed);
        landed
    }

    /// Brings open windows into line with their outputs' settings.
    ///
    /// Called after the Displays dialog saves. Two things need the window
    /// itself changed: its paper, when the look moves between a full picture
    /// and an overlay, which means rebuilding it; and the size of one with no
    /// screen, which is its feed's resolution. Before this, a resolution
    /// changed on an open output did nothing until it was closed and opened
    /// again, and the feed went on at the old size. Everything else an output
    /// can be told reaches its window without either.
    ///
    /// Not from the main thread: a rebuild waits for the old window to go, and
    /// the main thread is what makes it go.
    pub fn refit(&self, outputs: &[crate::settings::Output]) {
        for output in outputs {
            let Some(window) = self.app.get_webview_window(&label_for(&output.id)) else {
                continue;
            };
            let built = self.keyable.lock().get(&output.id).copied();
            let paper_right = built == Some(output.is_overlay());
            let size_right = output.display.is_some() || {
                let scale = window.scale_factor().unwrap_or(1.0);
                window.inner_size().is_ok_and(|now| {
                    let now = now.to_logical::<f64>(scale);
                    (now.width.round() as u32, now.height.round() as u32)
                        == (output.width.max(16), output.height.max(16))
                })
            };
            if paper_right && size_right {
                continue;
            }
            if let Err(error) = self.open_output(
                &output.id,
                &output.name,
                output.display,
                (output.width, output.height),
                output.is_overlay(),
            ) {
                crate::log_line!("[projector] could not rebuild {}: {error}", output.name);
            }
        }
    }

    /// Closes an output's window. Closing one that is not open is not an error.
    pub fn close_output(&self, id: &str) {
        if let Some(window) = self.app.get_webview_window(&label_for(id)) {
            let _ = window.close();
        }
        self.windows.lock().remove(id);
        self.keyable.lock().remove(id);
    }

    /// Whether an output's window is open.
    ///
    /// Asked of the windows rather than of what we remember: a window can be
    /// closed by the operating system, and a list that says otherwise is a
    /// list an operator will act on.
    pub fn output_open(&self, id: &str) -> bool {
        self.app.get_webview_window(&label_for(id)).is_some()
    }

    /// Opens the projector on a display, or moves it if already open.
    ///
    /// Defaults to the first display that is not the primary one — during a
    /// service the projector is essentially never the laptop screen.
    pub fn open(&self, requested: Option<usize>) -> Result<ProjectorState> {
        let index = self
            .open_output(
                MAIN_ID,
                "Projector",
                Some(Self::chosen(&self.app, requested)?),
                (0, 0),
                self.is_overlay(MAIN_ID),
            )?
            .ok_or_else(|| anyhow!("the projector must land on a display"))?;
        *self.display.lock() = Some(index);
        Ok(self.state())
    }

    /// Whether an output's look is an overlay, as its settings say.
    ///
    /// The keyboard opens the projector and the second display without going
    /// through the Displays dialog, and used to build both opaque whatever
    /// they were set to -- then the next save from the dialog rebuilt them.
    fn is_overlay(&self, id: &str) -> bool {
        crate::settings::load(&self.app)
            .ok()
            .and_then(|settings| settings.outputs.into_iter().find(|output| output.id == id))
            .is_some_and(|output| output.is_overlay())
    }

    /// Which monitor a request lands on. Only ever called on the main thread.
    ///
    /// Defaults to the first display that is not the primary one -- during a
    /// service the projector is essentially never the laptop screen.
    fn chosen(app: &AppHandle, requested: Option<usize>) -> Result<usize> {
        let monitors = app
            .available_monitors()
            .map_err(|err| anyhow!("could not enumerate displays: {err}"))?;
        if monitors.is_empty() {
            return Err(anyhow!("no displays were found"));
        }

        let primary = app
            .primary_monitor()
            .ok()
            .flatten()
            .and_then(|monitor| monitor.name().cloned());
        // By name, not by index: the operator can drag their window to another
        // screen and the list is read again every time the pane opens.
        let desk = app
            .get_webview_window(OPERATOR_LABEL)
            .and_then(|window| window.current_monitor().ok().flatten())
            .and_then(|monitor| monitor.name().cloned());

        Ok(requested
            .filter(|index| *index < monitors.len())
            .or_else(|| {
                monitors.iter().position(|monitor| monitor.name().cloned() != primary)
            })
            .unwrap_or(0))
    }


    pub fn close(&self) -> ProjectorState {
        self.close_output(MAIN_ID);
        *self.display.lock() = None;
        ProjectorState { open: false, display: None }
    }

    /// Opens the second display, or moves it to another screen.
    ///
    /// Deliberately allowed on the same screen as the projector, and even on
    /// the operator's. Somebody setting this up at home has one screen and
    /// still wants to see what it looks like, and refusing would be us deciding
    /// which of a church's screens is for what.
    pub fn open_second(&self, requested: Option<usize>) -> Result<SecondState> {
        let index = self
            .open_output(
                SECOND_ID,
                "Second display",
                Some(Self::chosen(&self.app, requested)?),
                (0, 0),
                self.is_overlay(SECOND_ID),
            )?
            .ok_or_else(|| anyhow!("the second display must land on a display"))?;
        *self.second.lock() = Some(index);
        Ok(self.second_state())
    }

    pub fn close_second(&self) -> SecondState {
        self.close_output(SECOND_ID);
        *self.second.lock() = None;
        SecondState { open: false, display: None }
    }

    pub fn second_state(&self) -> SecondState {
        SecondState {
            open: self.app.get_webview_window(SECOND_LABEL).is_some(),
            display: *self.second.lock(),
        }
    }

}

/// Where the second display is, if it is anywhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecondState {
    pub open: bool,
    pub display: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every webview is started with the same arguments, or Windows opens one.
    ///
    /// WebView2 refuses a second webview whose arguments differ from the
    /// first's. The operator window's are in the config file and the outputs'
    /// are in code, so an edit to either alone passes every Mac test and ships
    /// a Windows build whose projector cannot open.
    #[test]
    fn every_window_starts_its_webview_the_same_way() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("the config parses");
        let windows = config["app"]["windows"].as_array().expect("windows are listed");
        assert!(!windows.is_empty());
        for window in windows {
            assert_eq!(
                window["additionalBrowserArgs"].as_str(),
                Some(WEBVIEW_ARGS),
                "window {} must start its webview exactly as the outputs do",
                window["label"],
            );
        }
    }

    /// A window can find its way back to the output it belongs to.
    ///
    /// Escape closes the screen in front of the person pressing it, and all a
    /// window knows about itself is its label. If these two ever disagree, that
    /// key closes some other screen and leaves the one covering the operator
    /// exactly where it was -- which is the trap the key exists to open.
    #[test]
    fn a_label_leads_back_to_the_output_that_owns_it() {
        for id in [MAIN_ID, SECOND_ID, "k3f9ab", "second-foyer"] {
            assert_eq!(id_for(&label_for(id)), id, "{id} could not close itself");
        }
    }

    /// The arguments keep what wry would have passed on its own.
    #[test]
    fn the_webview_arguments_keep_the_defaults_they_replace() {
        for kept in ["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection", "--autoplay-policy=no-user-gesture-required"] {
            assert!(WEBVIEW_ARGS.contains(kept), "{kept} was dropped");
        }
        assert!(WEBVIEW_ARGS.contains("CalculateNativeWinOcclusion"));
    }

    #[test]
    fn a_picture_keeps_how_it_meets_the_frame() {
        /*
         * The fourth field to be silently dropped by this type, after a
         * slide's components, a mirrored comparison and a background image.
         *
         * `serde` ignores what it does not know, so a frontend that sends a
         * field this struct has not got loses it with no error anywhere. The
         * symptom is always the same and never points here: the setting works
         * on the one surface that does not make the round trip, and does
         * nothing on the two that do.
         */
        let staged: LiveBody = serde_json::from_str(
            r#"{"kind":"image","path":"/a.jpg","fill":true}"#,
        )
        .expect("the projector could not read a staged picture");

        match staged {
            LiveBody::Image { fill, .. } => assert!(fill, "fill was dropped crossing into Rust"),
            other => panic!("read as {other:?}"),
        }

        // And back out again, because the projector window reads it from here.
        let sent = serde_json::to_string(&LiveBody::Media {
            path: "/a.mp4".into(),
            looping: false,
            fill: true,
        })
        .unwrap();
        assert!(sent.contains("\"fill\":true"), "fill was dropped leaving Rust: {sent}");
    }

    use super::*;

    fn passage() -> LiveContent {
        LiveContent {
            body: LiveBody::Scripture {
                lines: vec![
                    ScriptureLine { number: 16, text: "For God so loved the world".into() },
                    ScriptureLine { number: 17, text: "For God sent not his Son".into() },
                ],
            },
            caption: "John 3:16-17 (KJV)".into(),
            ids: vec![26137, 26138],
            // Nothing this short is ever wound; the field exists for a lexicon
            // entry, which is the one body that outgrows a screen.
            progress: 0.0,
        }
    }

    #[test]
    fn content_round_trips_through_json() {
        let encoded = serde_json::to_string(&passage()).expect("encode");
        // The tag is what lets the projector switch on shape.
        assert!(encoded.contains("\"kind\":\"scripture\""));
        assert_eq!(serde_json::from_str::<LiveContent>(&encoded).expect("decode"), passage());
    }

    #[test]
    fn every_variant_survives_a_round_trip() {
        let variants = vec![
            LiveBody::Lyric { lines: vec!["Amazing grace".into(), "how sweet the sound".into()] },
            LiveBody::RichText {
                blocks: vec![TextBlock {
                    text: "Welcome".into(),
                    level: "heading".into(),
                    align: "center".into(),
                    bold: true,
                    italic: false,
                }],
            },
            LiveBody::Image { path: "/tmp/a.png".into(), fill: true },
            LiveBody::Media { path: "/tmp/a.mp4".into(), looping: true, fill: true },
        ];
        for body in variants {
            let encoded = serde_json::to_string(&body).expect("encode");
            assert_eq!(serde_json::from_str::<LiveBody>(&encoded).expect("decode"), body);
        }
    }

    #[test]
    fn a_passage_keeps_its_verses_separate() {
        // Not one blob of text: the projector numbers them, and the operator's
        // lists need to know which verses are live.
        let LiveBody::Scripture { lines } = passage().body else { panic!("wrong variant") };
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].number, 16);
        assert_eq!(lines[1].number, 17);
    }

    #[test]
    fn lyrics_keep_their_line_breaks() {
        // A song section breaks where the writer broke it, so lines stay
        // separate rather than being reflowed into a paragraph.
        let body = LiveBody::Lyric { lines: vec!["Amazing grace".into(), "how sweet".into()] };
        let encoded = serde_json::to_string(&body).expect("encode");
        assert_eq!(serde_json::from_str::<LiveBody>(&encoded).expect("decode"), body);
        let LiveBody::Lyric { lines } = body else { panic!("wrong variant") };
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn clearing_is_distinct_from_showing_nothing() {
        // `None` means the screen is blank; an empty body would still be
        // "showing something", which the projector renders differently.
        let cleared: Option<LiveContent> = None;
        assert_eq!(serde_json::to_string(&cleared).expect("encode"), "null");
    }

    #[test]
    fn a_ticker_parses_what_the_operator_window_sends() {
        let json = r##"{"text":"Church picnic Saturday","visible":true,"position":"top",
            "speed":18.0,"textColor":"#FFFFFF","bandColor":"#101010","bandOpacity":0.6}"##;
        let ticker: Ticker = serde_json::from_str(json).expect("ticker");
        assert_eq!(ticker.text, "Church picnic Saturday");
        assert_eq!(ticker.position, "top");
        assert_eq!(ticker.band_color, "#101010");
        assert_eq!(ticker.band_opacity, 0.6);
        assert!(ticker.visible);

        // The struct-level default means a payload written before the colours
        // existed still parses rather than rejecting the whole call.
        let older = r#"{"text":"Notice","visible":true,"position":"bottom","speed":20.0}"#;
        let ticker: Ticker = serde_json::from_str(older).expect("an older ticker");
        assert_eq!(ticker.text_color, "#F4F1EA");
    }

    #[test]
    fn an_unreadable_ticker_speed_is_brought_back_into_range() {
        // A pass faster than a few seconds cannot be read at all, and one
        // slower than a couple of minutes looks like it has frozen.
        let ticker = Ticker { speed: 0.2, ..Ticker::default() };
        let clamped = Ticker { speed: ticker.speed.clamp(6.0, 120.0), ..ticker };
        assert_eq!(clamped.speed, 6.0);

        let crawling = Ticker { speed: 900.0, ..Ticker::default() };
        assert_eq!(crawling.speed.clamp(6.0, 120.0), 120.0);
    }

    #[test]
    fn the_transport_parses_what_the_operator_window_sends() {
        // Same lesson as the service plan: agreeing with ourselves proves
        // nothing. These are the exact payloads the TypeScript builds.
        let command = r#"{"playing":false,"looping":true,"seekNonce":3,"seekTo":12.5}"#;
        assert_eq!(
            serde_json::from_str::<MediaCommand>(command).expect("command"),
            MediaCommand { playing: false, looping: true, seek_nonce: 3, seek_to: 12.5 }
        );

        let progress = r#"{"position":4.25,"duration":90.0,"ended":false}"#;
        assert_eq!(
            serde_json::from_str::<MediaProgress>(progress).expect("progress"),
            MediaProgress { position: 4.25, duration: 90.0, ended: false }
        );

        // And back out again, since both windows read what we emit.
        let encoded = serde_json::to_string(&MediaCommand::default()).expect("encode");
        assert!(encoded.contains("\"seekNonce\""), "wire format drifted: {encoded}");
    }

    #[test]
    fn a_new_clip_starts_from_the_beginning() {
        // Inheriting the previous clip's paused, half-finished transport would
        // leave the operator pressing play on a frame nobody expected.
        let previous = MediaCommand { playing: false, looping: false, seek_nonce: 7, seek_to: 40.0 };
        let next = MediaCommand {
            playing: true,
            looping: true,
            seek_nonce: previous.seek_nonce.wrapping_add(1),
            seek_to: 0.0,
        };

        assert!(next.playing);
        assert_eq!(next.seek_to, 0.0);
        // The nonce must move, or the surface would ignore the rewind.
        assert_ne!(next.seek_nonce, previous.seek_nonce);
    }
}
