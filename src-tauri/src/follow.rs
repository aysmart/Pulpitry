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

/// How many sentences in a row a slide must win before it is offered.
///
/// # Why consistency and not a lead
///
/// This asked the best slide to beat the runner-up by 0.05, and measured
/// against a real sermon that was close to a mute button. A twenty-slide deck
/// about one subject scores 0.53 to 0.69 across the board, with gaps of 0.02
/// to 0.04 -- so almost every genuine match was thrown away for being in a
/// coherent deck, which is the normal case rather than the exception.
///
/// The signal was never the size of the gap. It is that the same slide keeps
/// winning: over one stretch of preaching slide four came first in nine
/// consecutive sentences, never by much, and it was obviously the right
/// answer. One sentence agreeing is noise; two in a row is a speaker who has
/// arrived somewhere.
const STREAK: u32 = 2;

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
    /// Which slide has been winning, and for how many sentences.
    streak: Option<(usize, u32)>,
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
        crate::log_line!("[follow] watching {} slides", slides.len());
        *self.deck.lock() = Deck { slides, last: None, streak: None };
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
            let runner_up = scored.get(1).map(|(_, s)| *s).unwrap_or(0.0);

            drop(deck);
            let mut deck = self.deck.lock();

            // A slide that stops winning ends its own run, so a speaker moving
            // on does not carry a half-built streak to the next slide.
            let run = match deck.streak {
                Some((at, count)) if at == index => count + 1,
                _ => 1,
            };
            deck.streak = Some((index, run));

            // Logged whether or not it clears: a follower that declines is
            // indistinguishable from one that is not running, and the numbers
            // are the only way to tell a threshold that is too strict from a
            // deck that genuinely does not match.
            crate::log_line!(
                "[follow] slide {} at {score:.3}, next {runner_up:.3}, run {run} (floor {FLOOR}, streak {STREAK})",
                index + 1
            );

            if score < FLOOR || run < STREAK {
                return;
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

        crate::log_line!("[follow] offering slide {}", index + 1);

        let _ = self.app.emit(
            EVENT,
            Suggestion { index, score, advance: *self.advance.lock() },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule, measured against a real sermon.
    ///
    /// These are the scores a twenty-slide deck actually produced while
    /// somebody preached through it, taken from the log. They are here because
    /// the first rule -- beat the runner-up by 0.05 -- looked reasonable
    /// written down and rejected almost every one of them.
    const MEASURED: &[(usize, f32, f32)] = &[
        // (winning slide, its score, the runner-up's)
        (6, 0.541, 0.529),
        (0, 0.637, 0.565),
        (0, 0.624, 0.545),
        (3, 0.568, 0.545),
        (3, 0.627, 0.590),
        (3, 0.640, 0.611),
        (3, 0.643, 0.608),
        (3, 0.687, 0.656),
    ];

    /// What the old rule did to that stretch: almost nothing.
    #[test]
    fn a_lead_over_the_runner_up_rejects_a_coherent_deck() {
        let old_lead = 0.05;
        let passed = MEASURED
            .iter()
            .filter(|(_, best, next)| *best >= FLOOR && best - next >= old_lead)
            .count();

        // Two out of eight, and both of them early -- the nine sentences where
        // the speaker was plainly on one slide produced nothing at all.
        assert_eq!(passed, 2, "a lead rule is near-silent on a real deck");
    }

    /// What the rule does now: finds the slide the speaker settled on.
    #[test]
    fn a_run_of_agreement_finds_where_the_speaker_is() {
        let mut runs: Vec<(usize, u32)> = Vec::new();
        let mut streak: Option<(usize, u32)> = None;

        for (slide, best, _) in MEASURED {
            if *best < FLOOR {
                continue;
            }
            let run = match streak {
                Some((at, count)) if at == *slide => count + 1,
                _ => 1,
            };
            streak = Some((*slide, run));
            if run >= STREAK {
                runs.push((*slide, run));
            }
        }

        // Slide 1 twice, then slide 4 for the rest of the stretch: both the
        // answers a person watching would have given.
        assert!(runs.iter().any(|(slide, _)| *slide == 0), "slide 1 was missed");
        assert!(runs.iter().any(|(slide, _)| *slide == 3), "slide 4 was missed");

        // And the noise is not offered: slide 7 won once and never again.
        assert!(!runs.iter().any(|(slide, _)| *slide == 6), "one sentence is not an answer");
    }
}
