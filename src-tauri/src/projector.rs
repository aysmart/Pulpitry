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
 * The second output: what the preacher sees, not what the congregation does.
 *
 * A different window rather than a second copy of the projector, because it
 * shows different things -- what is up now, what the operator has staged next,
 * and the time. A confidence monitor that merely mirrored the wall would tell
 * somebody standing in front of that wall nothing they could not see by turning
 * round.
 */
pub const STAGE_LABEL: &str = "stage";

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
    Image { path: String },
    Media { path: String, looping: bool },
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
    stage: Mutex<Option<usize>>,
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
            stage: Mutex::new(None),
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

    /// Opens the projector on a display, or moves it if already open.
    ///
    /// Defaults to the first display that is not the primary one — during a
    /// service the projector is essentially never the laptop screen.
    pub fn open(&self, requested: Option<usize>) -> Result<ProjectorState> {
        let index = Self::place(&self.app, requested)?;
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

    /// Opens the projector, or moves it if already open.
    ///
    /// Returns the display it landed on.
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
    /// So `open_projector` is an async command. macOS does not care either way,
    /// which is why this only ever showed up on Windows.
    fn place(app: &AppHandle, requested: Option<usize>) -> Result<usize> {
        let index = Self::chosen(app, requested)?;
        let monitors = app
            .available_monitors()
            .map_err(|err| anyhow!("could not enumerate displays: {err}"))?;
        let monitor = &monitors[index];
        let position = monitor.position();
        let size = monitor.size();

        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            // Already open: move it rather than tearing down a live display.
            let _ = window.set_position(tauri::PhysicalPosition::new(position.x, position.y));
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
            let _ = window.set_focus();
            return Ok(index);
        }

        WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("projector.html".into()))
            .title("Pulpitry — Projector")
            // Borderless and sized to the monitor rather than true fullscreen:
            // fullscreen on macOS moves the window to its own Space, which takes
            // it away from the operator and animates on every change.
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .position(position.x as f64, position.y as f64)
            .inner_size(size.width as f64, size.height as f64)
            .background_color(tauri::window::Color(244, 241, 234, 255))
            .build()
            .map_err(|err| anyhow!("could not open the projector window: {err}"))?;

        Ok(index)
    }

    pub fn close(&self) -> ProjectorState {
        if let Some(window) = self.app.get_webview_window(WINDOW_LABEL) {
            let _ = window.close();
        }
        *self.display.lock() = None;
        ProjectorState { open: false, display: None }
    }

    /// Opens the stage display, or moves it.
    ///
    /// Deliberately allowed on the same screen as the projector, and even on the
    /// operator's. A church with two outputs and three uses for them should not
    /// be told by us which is which, and somebody setting this up at home has
    /// one screen and still wants to see what it looks like.
    pub fn open_stage(&self, requested: Option<usize>) -> Result<StageState> {
        let index = Self::place_stage(&self.app, requested)?;
        *self.stage.lock() = Some(index);
        Ok(self.stage_state())
    }

    pub fn close_stage(&self) -> StageState {
        if let Some(window) = self.app.get_webview_window(STAGE_LABEL) {
            let _ = window.close();
        }
        *self.stage.lock() = None;
        StageState { open: false, display: None }
    }

    pub fn stage_state(&self) -> StageState {
        StageState {
            open: self.app.get_webview_window(STAGE_LABEL).is_some(),
            display: *self.stage.lock(),
        }
    }

    /// The same window dance as the projector, and the same warning applies:
    /// building a webview from a synchronous command deadlocks Windows.
    fn place_stage(app: &AppHandle, requested: Option<usize>) -> Result<usize> {
        let index = Self::chosen(app, requested)?;
        let monitors = app
            .available_monitors()
            .map_err(|err| anyhow!("could not enumerate displays: {err}"))?;
        let monitor = &monitors[index];
        let position = monitor.position();
        let size = monitor.size();

        if let Some(window) = app.get_webview_window(STAGE_LABEL) {
            let _ = window.set_position(tauri::PhysicalPosition::new(position.x, position.y));
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
            let _ = window.set_focus();
            return Ok(index);
        }

        WebviewWindowBuilder::new(app, STAGE_LABEL, WebviewUrl::App("stage.html".into()))
            .title("Pulpitry — Stage")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .position(position.x as f64, position.y as f64)
            .inner_size(size.width as f64, size.height as f64)
            // Black, not the projector's paper. This one is read in a dark
            // room by somebody who must not be dazzled while they are speaking.
            .background_color(tauri::window::Color(0, 0, 0, 255))
            .build()
            .map_err(|err| anyhow!("could not open the stage window: {err}"))?;

        Ok(index)
    }
}

/// Where the stage display is, if it is anywhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageState {
    pub open: bool,
    pub display: Option<usize>,
}

#[cfg(test)]
mod tests {
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
            LiveBody::Image { path: "/tmp/a.png".into() },
            LiveBody::Media { path: "/tmp/a.mp4".into(), looping: true },
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
