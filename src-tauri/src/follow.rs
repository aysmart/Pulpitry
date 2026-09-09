//! Following the service: which slide of the staged deck the speaker is on.
//!
//! # What this is, and what it is deliberately not
//!
//! It matches the rolling transcript against the slides of the deck that is
//! already staged, and says which one the speaker seems to have reached. That
//! is the whole of it. It does not choose a deck, does not search the library,
//! and cannot put anything on a screen by itself.
//!
//! # Suggesting, not advancing
//!
//! The default is to say so and stop there, and that is not timidity. A wrong
//! verse in the queue is a shrug: the operator ignores it and nobody else ever
//! knows. A deck that jumps to the wrong slide is a visible failure in front of
//! a congregation, at the exact moment a preacher is depending on it, and the
//! person who looks incompetent is the volunteer at the desk rather than us.
//!
//! So the confident thing is offered and the irreversible thing is asked for.
//! Auto-advance exists because some churches will want it and are entitled to;
//! it is off, and the pane says what it does rather than calling it "smart".
//!
//! # Why the deck is embedded here and the Bible is not
//!
//! The Bible's index is tens of thousands of verses, built once and cached to
//! disk. A deck is seven slides, or twenty. Embedding it on the spot costs
//! well under a second and avoids a cache that would have to be invalidated
//! every time somebody edited a heading -- which, on a Sunday morning, is
//! constantly.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// How alike the speech and a slide must be before it is worth saying.
///
/// Higher than the scripture threshold, and for a reason: a verse suggestion
/// appears in a list the operator can ignore, and this one asks them to move
/// the screen. The cost of a wrong answer is higher, so the bar is.
const FLOOR: f32 = 0.42;

/// How much better the best slide must be than the runner-up.
///
/// A sermon's slides are about one subject and read alike; three of them
/// scoring 0.44, 0.43 and 0.43 is not a match, it is the deck being coherent.
/// Without this the suggestion flickers between them sentence by sentence,
/// which is worse than silence because it invites the operator to follow it.
const LEAD: f32 = 0.05;

pub const EVENT: &str = "slide:suggested";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// Which slide of the staged deck, counted from zero.
    pub index: usize,
    /// How alike, 0 to 1, for a pane that wants to show its confidence.
    pub score: f32,
    /// Whether the operator asked for this to be acted on rather than offered.
    pub advance: bool,
}

#[derive(Default)]
struct Deck {
    /// One embedding per slide, in the deck's own order.
    slides: Vec<Vec<f32>>,
    /// The last slide suggested, so the same one is not offered twice running.
    last: Option<usize>,
}

pub struct Follower {
    app: AppHandle,
    deck: Mutex<Deck>,
    /// Whether a match should move the screen rather than be offered.
    advance: Mutex<bool>,
}

impl Follower {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self { app, deck: Mutex::new(Deck::default()), advance: Mutex::new(false) })
    }

    /// Takes the staged deck, already embedded by the caller.
    ///
    /// The embedding is done outside because it needs the model, which belongs
    /// to `Semantic` -- and one owner of that model is one queue for it.
    pub fn watch(&self, slides: Vec<Vec<f32>>) {
        *self.deck.lock() = Deck { slides, last: None };
    }

    /// Stops following. Called when the deck is cleared or replaced.
    pub fn forget(&self) {
        *self.deck.lock() = Deck::default();
    }

    pub fn set_advance(&self, on: bool) {
        *self.advance.lock() = on;
    }

    pub fn following(&self) -> bool {
        !self.deck.lock().slides.is_empty()
    }

    /// Which slide this stretch of speech is nearest, if any is near enough.
    ///
    /// Returns nothing far more often than something, which is the intended
    /// behaviour: most sentences in a sermon are not on any slide, and a
    /// follower that answers every one of them is a follower nobody can trust.
    pub fn consider(&self, spoken: &[f32]) {
        let (index, score) = {
            let deck = self.deck.lock();
            if deck.slides.is_empty() {
                return;
            }

            let mut scored: Vec<(usize, f32)> = deck
                .slides
                .iter()
                .enumerate()
                .map(|(at, slide)| (at, castavox_core::embed::cosine(spoken, slide)))
                .collect();
            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

            let (index, score) = scored[0];
            if score < FLOOR {
                return;
            }
            // Clearly ahead of the next, or the deck is simply consistent and
            // this is not a reading of where the speaker is.
            if let Some((_, runner_up)) = scored.get(1) {
                if score - runner_up < LEAD {
                    return;
                }
            }
            (index, score)
        };

        // The same slide again is not news. It is what a speaker staying on a
        // point sounds like, and repeating the suggestion would make the pane
        // look like it were finding something new each sentence.
        {
            let mut deck = self.deck.lock();
            if deck.last == Some(index) {
                return;
            }
            deck.last = Some(index);
        }

        let _ = self.app.emit(
            EVENT,
            Suggestion { index, score, advance: *self.advance.lock() },
        );
    }
}
