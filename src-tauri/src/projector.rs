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
pub const EVENT_THEME: &str = "theme:changed";
pub const WINDOW_LABEL: &str = "projector";

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

pub struct Projector {
    app: AppHandle,
    live: Mutex<Option<LiveContent>>,
    display: Mutex<Option<usize>>,
}

impl Projector {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            live: Mutex::new(None),
            display: Mutex::new(None),
        })
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
        let monitors = self
            .app
            .available_monitors()
            .map_err(|err| anyhow!("could not enumerate displays: {err}"))?;
        let primary = self
            .app
            .primary_monitor()
            .ok()
            .flatten()
            .and_then(|monitor| monitor.name().cloned());
        let in_use = *self.display.lock();

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
        let monitors = self
            .app
            .available_monitors()
            .map_err(|err| anyhow!("could not enumerate displays: {err}"))?;
        if monitors.is_empty() {
            return Err(anyhow!("no displays were found"));
        }

        let primary = self
            .app
            .primary_monitor()
            .ok()
            .flatten()
            .and_then(|monitor| monitor.name().cloned());

        let index = requested
            .filter(|index| *index < monitors.len())
            .or_else(|| {
                monitors
                    .iter()
                    .position(|monitor| monitor.name().cloned() != primary)
            })
            .unwrap_or(0);

        let monitor = &monitors[index];
        let position = monitor.position();
        let size = monitor.size();

        if let Some(window) = self.app.get_webview_window(WINDOW_LABEL) {
            // Already open: move it rather than tearing down a live display.
            let _ = window.set_position(tauri::PhysicalPosition::new(position.x, position.y));
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
            let _ = window.set_focus();
            *self.display.lock() = Some(index);
            return Ok(self.state());
        }

        WebviewWindowBuilder::new(
            &self.app,
            WINDOW_LABEL,
            WebviewUrl::App("projector.html".into()),
        )
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

        *self.display.lock() = Some(index);
        Ok(self.state())
    }

    pub fn close(&self) -> ProjectorState {
        if let Some(window) = self.app.get_webview_window(WINDOW_LABEL) {
            let _ = window.close();
        }
        *self.display.lock() = None;
        ProjectorState { open: false, display: None }
    }
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
}
