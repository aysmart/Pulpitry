//! The shape of a paraphrase suggestion, shared by both things that produce one.
//!
//! Two independent paths can decide the speaker is referring to a passage
//! without quoting it: the local embedding index ([`crate::semantic`]) and,
//! optionally, a remote model ([`crate::assist`]). They disagree usefully — the
//! index is offline, free and literal-minded; the model is better at loose
//! allusion but costs a request and needs the network. Both feed the same
//! Paraphrase list, tagged with where they came from so the operator can weigh
//! them differently.

use serde::Serialize;

use crate::bible::Verse;

pub const EVENT_SUGGESTION: &str = "suggestion:verse";

/// Which path produced a suggestion.
pub const SOURCE_SEMANTIC: &str = "semantic";
pub const SOURCE_MODEL: &str = "model";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// Always read from the local library, never from a model.
    pub verse: Verse,
    /// [`SOURCE_SEMANTIC`] or [`SOURCE_MODEL`].
    pub source: String,
    /// "quotation" or "allusion".
    pub kind: String,
    /// Cosine similarity for the index; the model's own estimate otherwise.
    /// Neither is a calibrated probability.
    pub confidence: f32,
    pub reason: String,
    /// The speech the suggestion was drawn from.
    pub context: String,
    pub at: u64,
}

pub fn epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}
