//! Offering what is on the projector to a Castavox on the same wifi.
//!
//! The desk half of the mirror. `castavox_core::mirror` holds the protocol —
//! discovery, the pairing handshake, the connection — and this holds the two
//! things that are Pulpitry's own: when to advertise, and what Pulpitry's live
//! content means in the vocabulary the wire speaks.
//!
//! # Off unless asked for
//!
//! It opens a port and announces the machine on the local network, and neither
//! is something to do to a church that never asked. A church running Pulpitry
//! alone should be indistinguishable on the network from one that has never
//! heard of the mirror.
//!
//! # Why the staging is a subscription rather than a call
//!
//! `Projector::set_live` already tells every window what is live, and the
//! mirror is one more window. Hanging the push off that event rather than
//! calling into the mirror from `set_live` keeps the projector unaware that any
//! of this exists — which is what stops the two drifting apart the next time
//! somebody adds a way to put something on screen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

use castavox_core::mirror::{self, Desk, Line, Pairing, Shown, Table};

use crate::projector::{LiveBody, LiveContent};
use crate::settings;

/// The port the desk listens on.
///
/// Fixed rather than ephemeral so a church's firewall rule, if it ever needs
/// one, stays true. Registered to nobody; chosen high and unlikely.
const PORT: u16 = 7854;

/// What the operator's window is told about the mirror.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorState {
    pub enabled: bool,
    /// The code being offered right now, or empty. Shown large: somebody is
    /// reading it off this screen and typing it into another.
    pub code: String,
    /// How many screens are connected.
    pub watching: usize,
    pub paired: Vec<PairedScreen>,
    /// Empty unless something is wrong, in which case it is what to do.
    pub problem: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedScreen {
    pub id: String,
    pub name: String,
}

pub const EVENT_MIRROR: &str = "mirror:changed";

/// The desk, and the advertisement that makes it findable.
pub struct Mirror {
    app: AppHandle,
    inner: Mutex<Option<Running>>,
    code: Mutex<String>,
    problem: Mutex<String>,
    beating: Arc<AtomicBool>,
}

struct Running {
    desk: Desk,
    // Held, not read: dropping it withdraws the advertisement, which is the
    // whole of its job.
    _advert: mirror::Advertisement,
}

impl Mirror {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            inner: Mutex::new(None),
            code: Mutex::new(String::new()),
            problem: Mutex::new(String::new()),
            beating: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Starts or stops, following the setting.
    pub fn configure(self: &Arc<Self>, stored: &settings::Settings) {
        if stored.mirror_enabled {
            self.start(stored);
        } else {
            self.stop();
        }
    }

    fn start(self: &Arc<Self>, stored: &settings::Settings) {
        if self.inner.lock().is_some() {
            return;
        }

        let known: Vec<Pairing> = stored.mirror_pairings.clone();
        let name = machine_name();

        let started = Desk::start(&name, known, PORT).and_then(|desk| {
            let advert = mirror::advertise(
                &stored.hosted_device_id,
                &name,
                "pulpitry",
                env!("CARGO_PKG_VERSION"),
                desk.port(),
            )?;
            Ok(Running { desk, _advert: advert })
        });

        match started {
            Ok(running) => {
                *self.inner.lock() = Some(running);
                *self.problem.lock() = String::new();
                self.start_beating();
                // Whatever is already on the projector, so a screen pairing
                // mid-service is not looking at a blank.
                if let Some(projector) = self.app.try_state::<Arc<crate::projector::Projector>>() {
                    self.stage(projector.live().as_ref());
                }
            }
            Err(error) => {
                crate::log_line!("[mirror] could not start: {error:#}");
                // Named plainly. The likely cause is the port being taken by
                // another copy of Pulpitry, and "try again" would not help.
                *self.problem.lock() = format!(
                    "The mirror could not start on port {PORT}. Another copy of Pulpitry may \
                     already be running. ({error})"
                );
            }
        }
        self.announce();
    }

    fn stop(self: &Arc<Self>) {
        // Dropping it closes the port and disconnects every screen.
        *self.inner.lock() = None;
        self.beating.store(false, Ordering::Relaxed);
        self.code.lock().clear();
        self.announce();
    }

    /// A heartbeat, so a screen that has vanished is noticed and dropped.
    fn start_beating(self: &Arc<Self>) {
        if self.beating.swap(true, Ordering::Relaxed) {
            return;
        }
        let mirror = Arc::clone(self);
        let beating = Arc::clone(&self.beating);
        std::thread::Builder::new()
            .name("pulpitry-mirror-beat".into())
            .spawn(move || {
                while beating.load(Ordering::Relaxed) {
                    std::thread::sleep(mirror::link::HEARTBEAT);
                    let held = mirror.inner.lock();
                    let Some(running) = held.as_ref() else { break };
                    running.desk.beat();
                    // Nothing is announced from here. This runs every few
                    // seconds for the whole service, and an event per beat
                    // would have the settings window redrawing all morning to
                    // say the same thing.
                }
            })
            .ok();
    }

    /// Offers a pairing code for somebody to carry to the other machine.
    pub fn offer_code(self: &Arc<Self>) -> String {
        let code = match self.inner.lock().as_ref() {
            Some(running) => running.desk.offer_code(),
            None => String::new(),
        };
        *self.code.lock() = code.clone();
        self.announce();
        code
    }

    pub fn withdraw_code(self: &Arc<Self>) {
        if let Some(running) = self.inner.lock().as_ref() {
            running.desk.withdraw_code();
        }
        self.code.lock().clear();
        self.announce();
    }

    /// Forgets a screen, and remembers that it was forgotten.
    pub fn forget(self: &Arc<Self>, peer_id: &str) {
        let pairings = {
            let held = self.inner.lock();
            let Some(running) = held.as_ref() else { return };
            running.desk.forget(peer_id);
            running.desk.pairings()
        };
        self.remember(pairings);
        self.announce();
    }

    /// Persists the pairings, so a screen paired last Sunday still works today.
    fn remember(&self, pairings: Vec<Pairing>) {
        let Ok(mut stored) = settings::load(&self.app) else { return };
        if stored.mirror_pairings == pairings {
            return;
        }
        stored.mirror_pairings = pairings;
        if let Err(error) = settings::save(&self.app, &stored) {
            crate::log_line!("[mirror] could not remember a pairing: {error:#}");
        }
    }

    /// Pushes what is live now.
    pub fn stage(&self, live: Option<&LiveContent>) {
        let held = self.inner.lock();
        let Some(running) = held.as_ref() else { return };
        // The wind position travels beside the text, so a screen mirroring a
        // lexicon entry follows the operator down it rather than sitting on the
        // first frame while the desk reads the fourth.
        running.desk.stage(live.map(shown_of).unwrap_or(Shown::Nothing),
                           live.map(|content| content.progress).unwrap_or(0.0));
    }

    pub fn state(&self) -> MirrorState {
        let held = self.inner.lock();
        let (watching, paired) = match held.as_ref() {
            Some(running) => (
                running.desk.watching(),
                running
                    .desk
                    .pairings()
                    .into_iter()
                    .map(|p| PairedScreen { id: p.peer_id, name: p.name })
                    .collect(),
            ),
            None => (0, Vec::new()),
        };

        MirrorState {
            enabled: held.is_some(),
            code: self.code.lock().clone(),
            watching,
            paired,
            problem: self.problem.lock().clone(),
        }
    }

    fn announce(self: &Arc<Self>) {
        // A pairing that just happened has to survive a restart, and this is
        // the moment it is known about.
        /*
         * The lock is released before the pairings are written down.
         *
         * `remember` loads and saves the settings file, and `stage` takes this
         * same lock for every verse put on the wall. Holding it across a disk
         * write means a service stalls behind one -- briefly, and on the one
         * path that runs while somebody is pairing a machine mid-setup.
         *
         * This read `drop(running)`, which dropped a *reference* and did
         * nothing at all: the guard was a temporary living to the end of the
         * `if let`, and the compiler said so in a warning that went unread
         * until a release build printed it. Taking the value out in its own
         * scope is what actually ends the borrow.
         */
        let pairings = {
            let held = self.inner.lock();
            held.as_ref().map(|running| running.desk.pairings())
        };
        if let Some(pairings) = pairings {
            self.remember(pairings);
        }
        let _ = self.app.emit(EVENT_MIRROR, self.state());
    }
}

/// Pulpitry's live content, in the words the wire speaks.
///
/// The mapping is deliberately lossy in one direction: a photograph or a video
/// clip becomes [`Shown::Nothing`] rather than being left as whatever was there
/// before. A stream overlay still showing Psalm 23 while the projector has moved
/// on to a photograph is worse than an overlay showing nothing — the first is
/// wrong and looks deliberate, the second is merely empty.
/// A component as a comparison the far end can draw, if that is what it is.
fn mirrored_table(component: &serde_json::Value) -> Option<Table> {
    if component.get("kind").and_then(|v| v.as_str()) != Some("table") {
        return None;
    }
    let strings = |value: Option<&serde_json::Value>| -> Vec<String> {
        value
            .and_then(|v| v.as_array())
            .map(|items| {
                items.iter().filter_map(|i| i.as_str()).map(|s| s.trim().to_string()).collect()
            })
            .unwrap_or_default()
    };

    let header = strings(component.get("header"));
    let rows: Vec<Vec<String>> = component
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|rows| rows.iter().map(|row| strings(Some(row))).collect())
        .unwrap_or_default();

    // Two columns is the least that compares anything, and a table with no
    // rows is a heading. Neither is worth sending.
    if header.len() < 2 || rows.is_empty() {
        return None;
    }
    Some(Table { header, rows })
}

/// A component as the passage it cites, if that is what it is.
fn mirrored_reference(component: &serde_json::Value) -> Option<String> {
    if component.get("kind").and_then(|v| v.as_str()) != Some("passage") {
        return None;
    }
    let reference =
        component.get("reference").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
    if reference.is_empty() { None } else { Some(reference) }
}

/// Whether this component is the slide's title, which the caption carries.
fn is_title(component: &serde_json::Value) -> bool {
    component.get("kind").and_then(|v| v.as_str()) == Some("text")
        && component.get("level").and_then(|v| v.as_str()) == Some("title")
}

/// One component as the lines a text overlay can carry.
fn component_lines(component: &serde_json::Value) -> Vec<String> {
    let text = |key: &str| {
        component.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string()
    };
    let strings = |key: &str| -> Vec<String> {
        component
            .get(key)
            .and_then(|v| v.as_array())
            .map(|items| {
                items.iter().filter_map(|i| i.as_str()).map(|s| s.trim().to_string()).collect()
            })
            .unwrap_or_default()
    };

    match component.get("kind").and_then(|v| v.as_str()).unwrap_or_default() {
        "text" | "passage" => {
            let one = if component.get("text").is_some() { text("text") } else { text("reference") };
            if one.is_empty() { vec![] } else { vec![one] }
        }
        "list" => strings("items"),
        "quote" => {
            let said = text("text");
            let who = text("attribution");
            match (said.is_empty(), who.is_empty()) {
                (true, _) => vec![],
                (false, true) => vec![said],
                (false, false) => vec![said, format!("— {who}")],
            }
        }
        "table" => {
            let header = strings("header");
            component
                .get("rows")
                .and_then(|v| v.as_array())
                .map(|rows| {
                    rows.iter()
                        .filter_map(|row| row.as_array())
                        .map(|row| {
                            row.iter()
                                .enumerate()
                                .filter_map(|(at, cell)| {
                                    let cell = cell.as_str()?.trim();
                                    Some(match header.get(at) {
                                        Some(head) if !head.is_empty() => format!("{head}: {cell}"),
                                        _ => cell.to_string(),
                                    })
                                })
                                .collect::<Vec<_>>()
                                .join(" \u{b7} ")
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        _ => vec![],
    }
}

pub fn shown_of(live: &LiveContent) -> Shown {
    match &live.body {
        LiveBody::Scripture { lines } => Shown::Scripture {
            reference: live.caption.clone(),
            // Carried so the screen can label the translation if it shows one.
            // Pulpitry keeps it in the caption, so this is what is known.
            translation: String::new(),
            lines: lines
                .iter()
                .map(|line| Line { number: line.number, text: line.text.clone() })
                .collect(),
        },
        LiveBody::Lyric { lines } => {
            Shown::Words {
                title: live.caption.clone(),
                lines: lines.clone(),
                table: None,
                reference: String::new(),
            }
        }
        LiveBody::RichText { blocks } => Shown::Words {
            title: live.caption.clone(),
            // The styling is dropped rather than translated. The screen has its
            // own idea of what a heading looks like, and imposing Pulpitry's
            // would be the pixel-mirroring this deliberately does not do.
            lines: blocks.iter().map(|block| block.text.clone()).collect(),
            table: None,
            reference: String::new(),
        },
        /*
         * A composed slide, as lines a lower third can hold.
         *
         * The overlay is a card beside a camera, not a 16:9 frame, so a table
         * is not sent as one -- it is sent as something that still reads there.
         * Each row is paired with its heading rather than run together, because
         * "Activity: busy  Progress: arrives" survives a strip at the bottom of
         * a video frame and "Activity Progress busy arrives" does not.
         */
        LiveBody::Composed { components, .. } => {
            let table = components.iter().find_map(mirrored_table);
            let reference = components.iter().find_map(mirrored_reference).unwrap_or_default();
            Shown::Words {
                title: live.caption.clone(),
                lines: components
                    .iter()
                    // The title is already the caption, and an overlay that
                    // draws it above the body would show it twice. On the
                    // projector it is a component like any other; here it is
                    // the heading.
                    .filter(|component| !is_title(component))
                    // The comparison travels *both* ways: as a shape below, and
                    // flattened here. Only the far screen knows whether its card
                    // can hold a grid -- a full card can, a lower third cannot --
                    // so it is given both and picks. Sending only the shape put
                    // column headings and half a row on a lower third and cut
                    // the rest off, which is worse than the prose it replaced.
                    //
                    // The citation is the opposite case and travels once, below:
                    // there is no screen that would rather have it as prose, and
                    // in the lines it was drawn at body size under the statement
                    // it belonged to and read as part of the sentence.
                    .filter(|component| mirrored_reference(component).is_none())
                    .flat_map(component_lines)
                    .collect(),
                table,
                reference,
            }
        }
        // Nothing a text overlay can honestly show.
        LiveBody::Image { .. } | LiveBody::Media { .. } => Shown::Nothing,
    }
}

fn machine_name() -> String {
    for name in ["COMPUTERNAME", "HOSTNAME", "USER", "USERNAME"] {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim();
            if !value.is_empty() {
                return value.chars().take(60).collect();
            }
        }
    }
    "Pulpitry".to_string()
}

/// Subscribes the mirror to whatever goes live.
///
/// Hung off the event rather than called from `set_live`, so the projector never
/// learns that the mirror exists — which is what keeps the next way of putting
/// something on screen from forgetting to tell it.
pub fn follow_live(app: &AppHandle, mirror: Arc<Mirror>) {
    app.listen_any(crate::projector::EVENT_LIVE, move |event| {
        // The payload is the same JSON the projector window renders from, so a
        // shape it can draw is a shape this can read.
        let live: Option<LiveContent> = serde_json::from_str(event.payload()).unwrap_or(None);
        mirror.stage(live.as_ref());
    });
}

#[tauri::command]
pub fn mirror_state(mirror: State<'_, Arc<Mirror>>) -> MirrorState {
    mirror.state()
}

#[tauri::command]
pub fn mirror_offer_code(mirror: State<'_, Arc<Mirror>>) -> String {
    mirror.offer_code()
}

#[tauri::command]
pub fn mirror_withdraw_code(mirror: State<'_, Arc<Mirror>>) {
    mirror.withdraw_code();
}

#[tauri::command]
pub fn mirror_forget(mirror: State<'_, Arc<Mirror>>, peer_id: String) {
    mirror.forget(&peer_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projector::{ScriptureLine, TextBlock};

    fn live(body: LiveBody, caption: &str) -> LiveContent {
        LiveContent { body, caption: caption.into(), ids: Vec::new(), progress: 0.0 }
    }

    #[test]
    fn a_composed_slide_reaches_the_overlay_as_lines() {
        // The bridge had no variant for one at all: `set_live` failed to
        // deserialise it, the command errored, and nothing went live. Preview
        // drew the table perfectly, because Preview never crosses this bridge.
        let live = LiveContent {
            body: LiveBody::Composed {
                components: vec![
                    serde_json::json!({"kind":"text","level":"title","text":"Activity And Progress"}),
                    serde_json::json!({"kind":"passage","reference":"Joshua 1:9"}),
                    serde_json::json!({
                        "kind":"table",
                        "header":["Activity","Progress"],
                        "rows":[["Keeps the hands busy","Moves toward an outcome"]]
                    }),
                ],
                layout: "stacked".into(),
            },
            caption: "Activity And Progress".into(),
            ids: vec![],
            progress: 0.0,
        };

        match shown_of(&live) {
            Shown::Words { title, lines, table, reference } => {
                assert_eq!(title, "Activity And Progress");
                // Not repeated in the body: the overlay draws the caption as a
                // heading, and the slide would carry its title twice.
                assert_ne!(lines.first().map(String::as_str), Some("Activity And Progress"));

                // The comparison crosses as a comparison, for a screen that can
                // draw one. It was flattened into the lines before, and arrived
                // as a paragraph of "Fear: ... \u{b7} Faith: ..." nobody reads.
                let table = table.expect("the comparison did not cross");
                assert_eq!(table.header, ["Activity", "Progress"]);
                assert_eq!(table.rows[0][1], "Moves toward an outcome");

                // And in the lines as well. A screen with no room for a grid
                // -- a lower third is two tenths of a frame -- falls back to
                // these and can wind through them; one with room draws the
                // table and ignores them.
                assert!(lines.iter().any(|line| line.contains("Keeps the hands busy")));

                // A screen too old to draw one still reads it, paired with its
                // headings, because the columns are the meaning.
                assert_eq!(
                    table.as_lines()[0],
                    "Activity: Keeps the hands busy \u{b7} Progress: Moves toward an outcome"
                );

                // The citation crosses as a citation, and is not left in the
                // lines as well: there it was drawn at body size under the
                // statement it belonged to and read as part of the sentence.
                assert_eq!(reference, "Joshua 1:9");
                assert!(!lines.iter().any(|line| line.contains("Joshua")));
            }
            other => panic!("a composed slide showed as {other:?}"),
        }
    }

    #[test]
    fn a_passage_crosses_as_its_reference_and_verses() {
        let shown = shown_of(&live(
            LiveBody::Scripture {
                lines: vec![ScriptureLine { number: 16, text: "For God so loved".into() }],
            },
            "John 3:16",
        ));

        match shown {
            Shown::Scripture { reference, lines, .. } => {
                assert_eq!(reference, "John 3:16");
                assert_eq!(lines.len(), 1);
                assert_eq!(lines[0].number, 16);
            }
            other => panic!("expected scripture, got {other:?}"),
        }
    }

    #[test]
    fn a_photograph_blanks_the_overlay_rather_than_leaving_the_last_verse() {
        // The first is wrong and looks deliberate; the second is merely empty.
        // A stream showing Psalm 23 over a photograph is the worse of the two.
        assert_eq!(shown_of(&live(LiveBody::Image { path: "/a.jpg".into() }, "")), Shown::Nothing);
        assert_eq!(
            shown_of(&live(LiveBody::Media { path: "/a.mp4".into(), looping: false }, "")),
            Shown::Nothing,
        );
    }

    #[test]
    fn authored_text_crosses_without_its_styling() {
        // The screen has its own idea of what a heading looks like. Imposing
        // Pulpitry's would be the pixel-mirroring this exists not to do.
        let shown = shown_of(&live(
            LiveBody::RichText {
                blocks: vec![
                    TextBlock {
                        text: "Welcome".into(),
                        level: "heading".into(),
                        align: "center".into(),
                        bold: true,
                        italic: false,
                    },
                    TextBlock {
                        text: "Please stand".into(),
                        level: "body".into(),
                        align: "left".into(),
                        bold: false,
                        italic: false,
                    },
                ],
            },
            "Notices",
        ));

        assert_eq!(
            shown,
            Shown::Words {
                title: "Notices".into(),
                lines: vec!["Welcome".into(), "Please stand".into()],
                table: None,
                reference: String::new(),
            },
        );
    }
}
