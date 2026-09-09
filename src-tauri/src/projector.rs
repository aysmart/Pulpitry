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

/// Far enough off the desktop that no arrangement of real monitors reaches it.
///
/// Where an output with no screen of its own lives. The window server still
/// composites it and ScreenCaptureKit still captures it -- measured, both
/// cases returning identical frames -- so an NDI-only output is an ordinary
/// window that nobody looks at rather than a second rendering path.
const OFF_SCREEN: f64 = -32_000.0;

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
    audio: Mutex<AudioState>,
    media: Mutex<MediaCommand>,
    progress: Mutex<MediaProgress>,
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
            audio: Mutex::new(AudioState::default()),
            media: Mutex::new(MediaCommand::default()),
            progress: Mutex::new(MediaProgress::default()),
        })
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
            None => (
                (OFF_SCREEN, OFF_SCREEN),
                (size.0.max(16) as f64, size.1.max(16) as f64),
                None,
            ),
        };

        if let Some(window) = self.app.get_webview_window(&label) {
            // Already open: move it rather than tearing down a live display.
            let _ = window.set_position(tauri::PhysicalPosition::new(position.0, position.1));
            let _ = window.set_size(tauri::PhysicalSize::new(extent.0, extent.1));
            // Not focused when it has no screen: taking the operator's focus to
            // a window they cannot see is the worst kind of nothing happening.
            if landed.is_some() {
                let _ = window.set_focus();
            }
            self.windows.lock().insert(id.to_string(), landed);
            return Ok(landed);
        }

        WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::App("projector.html".into()))
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
            .position(position.0, position.1)
            .inner_size(extent.0, extent.1)
            // The projector's own paper: every output is the same output, and
            // one that flashed black between items would be the one thing
            // distinguishing it.
            .background_color(tauri::window::Color(244, 241, 234, 255))
            .build()
            .map_err(|err| anyhow!("could not open the {name} window: {err}"))?;

        self.windows.lock().insert(id.to_string(), landed);
        Ok(landed)
    }

    /// Closes an output's window. Closing one that is not open is not an error.
    pub fn close_output(&self, id: &str) {
        if let Some(window) = self.app.get_webview_window(&label_for(id)) {
            let _ = window.close();
        }
        self.windows.lock().remove(id);
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
            .open_output(MAIN_ID, "Projector", Some(Self::chosen(&self.app, requested)?), (0, 0))?
            .ok_or_else(|| anyhow!("the projector must land on a display"))?;
        *self.display.lock() = Some(index);
        Ok(self.state())
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
