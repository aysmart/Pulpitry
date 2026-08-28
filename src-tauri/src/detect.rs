//! Exact verse detection.
//!
//! Watches the confirmed transcript for stretches of text that appear verbatim
//! in scripture. Paraphrase and loose allusion are phase 5's problem, handled
//! semantically; this module only claims a detection when the speaker's words
//! and the verse's words line up in the same order.
//!
//! The whole design is shaped by one asymmetry: a missed detection costs the
//! operator nothing (the verse is a search away), while a false one puts the
//! wrong reference in front of them mid-service. So every threshold here errs
//! toward staying quiet.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::assist::Assistant;
use crate::bible::{Library, Verse};
use crate::semantic::Semantic;
use crate::spoken;

pub const EVENT_DETECTION: &str = "detection:verse";
pub const EVENT_SPOKEN: &str = "detection:reference";

/// Words in each probe phrase. Long enough that stock phrasing rarely fills it,
/// short enough to survive a recogniser dropping the odd word.
const WINDOW: usize = 7;
/// How far the probe advances each step. Overlapping windows mean a quotation
/// is still found when it does not begin on a window boundary.
const STRIDE: usize = 3;
/// Rolling context, so a quotation split across two transcript segments is
/// still seen as one run.
const BUFFER_WORDS: usize = 48;
/// A phrase matching more verses than this is stock biblical language ("and it
/// came to pass"), not a quotation of any particular verse.
const MAX_VERSES_PER_PHRASE: i64 = 6;
/// Shorter runs than this are common English, not a recognisable quotation.
const MIN_MATCH_WORDS: usize = 6;
/// A matched run has to carry at least this many words that are not function
/// words or narrative formula, or it identifies no verse in particular.
const MIN_DISTINCTIVE_WORDS: usize = 3;
const MIN_CONFIDENCE: f32 = 0.45;
/// Interim results arrive several times a second; a full pass on each is
/// wasted work. Short enough that detection still lands mid-sentence.
const INTERIM_INTERVAL: Duration = Duration::from_millis(250);
/// The rolling buffer re-examines the same words as new speech arrives, so a
/// verse would otherwise be reported once per segment for as long as it stays
/// in view.
const REPEAT_SUPPRESSION: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub verse: Verse,
    /// The speaker's own words that matched, for the operator to compare.
    pub snippet: String,
    pub words_matched: usize,
    pub confidence: f32,
    pub at: u64,
}

#[derive(Clone, Debug)]
struct Word {
    /// Comparison form: lowercase, punctuation stripped.
    normalized: String,
    /// What the operator sees in the snippet.
    display: String,
}

/// Whether a segment is settled or still being revised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Segment {
    /// Azure is still revising these words.
    Interim,
    /// Azure has settled on them.
    Final,
}

/// The words detection runs against.
///
/// Two parts, because interim results behave completely differently from final
/// ones. Azure re-sends the *same* utterance repeatedly as it revises it, so
/// appending each interim would stack the same sentence over and over and match
/// phrases nobody said. Interim text therefore replaces a pending tail, while
/// final text is appended to the settled history and clears that tail.
#[derive(Default)]
struct Transcript {
    settled: VecDeque<Word>,
    pending: Vec<Word>,
}

impl Transcript {
    fn push_final(&mut self, words: Vec<Word>) {
        self.settled.extend(words);
        // The final is the corrected form of whatever was pending, so the
        // pending copy has to go or the words appear twice.
        self.pending.clear();
        while self.settled.len() > BUFFER_WORDS {
            self.settled.pop_front();
        }
    }

    fn push_interim(&mut self, words: Vec<Word>) {
        self.pending = words;
    }

    fn clear(&mut self) {
        self.settled.clear();
        self.pending.clear();
    }

    /// Settled history followed by whatever is currently being said.
    fn words(&self) -> Vec<Word> {
        let mut words: Vec<Word> = self.settled.iter().cloned().collect();
        words.extend(self.pending.iter().cloned());
        let overflow = words.len().saturating_sub(BUFFER_WORDS);
        words.drain(..overflow);
        words
    }
}

/// A reference the speaker named out loud.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpokenDetection {
    pub verse: Verse,
    /// Whether the speaker named a verse or only a chapter.
    pub whole_chapter: bool,
    /// The words that named it.
    pub phrase: String,
    pub at: u64,
}

pub struct Detector {
    app: AppHandle,
    library: Arc<Library>,
    assistant: Arc<Assistant>,
    semantic: Arc<Semantic>,
    translation: Mutex<String>,
    transcript: Mutex<Transcript>,
    last_interim: Mutex<Option<Instant>>,
    /*
     * Reading the same stream for an instruction rather than a reference.
     *
     * Here because this is the one funnel every word passes through: the local
     * engine, Azure's stream and a typed transcript all arrive at `on_final`
     * and `on_interim`, and a listener anywhere else would hear some of them
     * and not others.
     *
     * `None` until a church turns it on.
     */
    commands: Mutex<Option<castavox_core::commands::Listener>>,
    recent: Mutex<Vec<(i64, Instant)>>,
    /// Separate from verse suppression: a reference and a quotation of the same
    /// verse are different events and both worth surfacing.
    recent_spoken: Mutex<Vec<(String, Instant)>>,
    queue: SyncSender<(Segment, String)>,
}

impl Detector {
    pub fn new(
        app: AppHandle,
        library: Arc<Library>,
        assistant: Arc<Assistant>,
        semantic: Arc<Semantic>,
        translation: String,
    ) -> Arc<Self> {
        let (queue, incoming) = sync_channel::<(Segment, String)>(32);
        let detector = Arc::new(Self {
            app,
            library,
            assistant,
            semantic,
            translation: Mutex::new(translation),
            transcript: Mutex::new(Transcript::default()),
            last_interim: Mutex::new(None),
            commands: Mutex::new(None),
            recent: Mutex::new(Vec::new()),
            recent_spoken: Mutex::new(Vec::new()),
            queue,
        });

        // Detection runs on its own thread: it holds the database lock while it
        // works, and must never delay the transcript reaching the screen.
        let weak = Arc::downgrade(&detector);
        std::thread::Builder::new()
            .name("pulpitry-detect".into())
            .spawn(move || {
                while let Ok((segment, text)) = incoming.recv() {
                    let Some(detector) = weak.upgrade() else { break };
                    if let Err(err) = detector.examine(segment, &text) {
                        crate::log_line!("[detect] {err:#}");
                    }
                }
            })
            .ok();

        detector
    }

    pub fn set_translation(&self, translation: &str) {
        if translation.is_empty() {
            return;
        }
        let mut current = self.translation.lock();
        if *current != translation {
            *current = translation.to_string();
            // Verse ids differ between translations, so the suppression list no
            // longer refers to anything meaningful.
            self.recent.lock().clear();
        }
    }

    /// Hands a settled segment to the detection thread. Dropped if detection
    /// has fallen behind — skipping a segment is better than growing a backlog.
    /// Turns listening for instructions on, off, or on with different words.
    pub fn set_commands(&self, listener: Option<castavox_core::commands::Listener>) {
        *self.commands.lock() = listener;
    }

    /// Reads the text for an instruction and tells the window about it.
    ///
    /// Ahead of the interim throttle rather than behind it. The throttle exists
    /// so the database is not searched several times a second; a command costs
    /// a string comparison, and the whole point of speaking one is that it acts
    /// before the operator could have reached the laptop.
    ///
    /// `ended` separates an utterance that is finished from one still being
    /// revised, which is the only thing that tells a repeat from a revision --
    /// as text they are identical.
    fn listen_for_command(&self, text: &str, ended: bool) {
        let heard = {
            let mut listener = self.commands.lock();
            let Some(listener) = listener.as_mut() else { return };
            listener.hear(text, ended)
        };
        if let Some(command) = heard {
            // The window acts on it: only that end knows what is staged.
            let _ = self.app.emit("voice-command", command);
        }
    }

    pub fn on_final(&self, text: &str) {
        self.listen_for_command(text, true);
        let _ = self.queue.try_send((Segment::Final, text.to_string()));
    }

    /// Hands in speech that is still being revised.
    ///
    /// This is what makes detection feel immediate: a verse surfaces while the
    /// sentence is still being spoken, instead of waiting for Azure to decide
    /// the speaker has paused. Rate-limited because interim results arrive
    /// several times a second and each one costs a full pass.
    pub fn on_interim(&self, text: &str) {
        self.listen_for_command(text, false);
        {
            let mut last = self.last_interim.lock();
            if last.is_some_and(|when| when.elapsed() < INTERIM_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }
        let _ = self.queue.try_send((Segment::Interim, text.to_string()));
    }

    pub fn reset(&self) {
        self.transcript.lock().clear();
        self.recent_spoken.lock().clear();
        *self.last_interim.lock() = None;
        self.recent.lock().clear();
        self.assistant.reset();
        self.semantic.reset();
    }

    fn examine(&self, segment: Segment, text: &str) -> Result<()> {
        let incoming = tokenize(text);
        if incoming.is_empty() && segment == Segment::Final {
            return Ok(());
        }

        let words = {
            let mut transcript = self.transcript.lock();
            match segment {
                Segment::Final => transcript.push_final(incoming),
                Segment::Interim => transcript.push_interim(incoming),
            }
            transcript.words()
        };

        if words.len() < WINDOW {
            return Ok(());
        }

        let translation = self.translation.lock().clone();
        if translation.is_empty() {
            return Ok(());
        }

        // Cheapest and most certain signal there is, so it runs first and on
        // every update: a named reference is plain parsing, no search, and the
        // speaker has told us exactly where they are going.
        self.examine_spoken(&translation, &words)?;

        let found = find_detections(&self.library, &translation, &words)?;
        let had_exact_match = !found.is_empty();

        for detection in found {
            if self.was_recently_reported(detection.verse.id) {
                continue;
            }
            let _ = self.app.emit(EVENT_DETECTION, &detection);
        }

        // Only worth asking the model about speech that verbatim matching could
        // not place. If the passage is already identified, a request would buy
        // nothing and still cost.
        let context: String = words
            .iter()
            .map(|word| word.display.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        // Both paraphrase paths see settled text only.
        //
        // Exact matching gains from interim results: a partial sentence still
        // contains whole words in order, so a quotation is found early and
        // precisely. Meaning does not work that way. A half-finished sentence
        // embeds to something vague that lands near whatever shares its
        // vocabulary, so searching on fragments fills the panel with passages
        // the speaker was not heading towards.
        if segment == Segment::Final {
            self.semantic.consider(&context, had_exact_match);
            self.assistant.consider(&context, had_exact_match);
        }

        Ok(())
    }

    /// Looks for a reference the speaker named, and resolves it against the
    /// library so an impossible reading is discarded rather than shown.
    fn examine_spoken(&self, translation: &str, words: &[Word]) -> Result<()> {
        let text: String = words
            .iter()
            .map(|word| word.display.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        let books: Vec<String> = self
            .library
            .books(translation)?
            .into_iter()
            .map(|book| book.name)
            .collect();
        let Some(spoken) = spoken::find_reference(&text, &books) else { return Ok(()) };

        // Readings come out best-guess first; the first that actually exists
        // wins. This is what turns "psalm one nineteen" into Psalm 119.
        for reading in &spoken.readings {
            let Some(reference) =
                self.library
                    .locate(translation, &spoken.book, reading.chapter, reading.verse)?
            else {
                continue;
            };

            let verse = reference.verse.unwrap_or(1);
            let key = format!("{}:{}:{}", reference.book, reference.chapter, verse);
            if self.was_recently_spoken(&key) {
                return Ok(());
            }

            let Some(found) = self
                .library
                .chapter(translation, reference.book_number, reference.chapter)?
                .into_iter()
                .find(|candidate| candidate.verse == verse)
            else {
                continue;
            };

            let _ = self.app.emit(
                EVENT_SPOKEN,
                SpokenDetection {
                    verse: found,
                    whole_chapter: reference.verse.is_none(),
                    phrase: spoken.phrase.clone(),
                    at: epoch_millis(),
                },
            );
            return Ok(());
        }
        Ok(())
    }

    fn was_recently_spoken(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut recent = self.recent_spoken.lock();
        recent.retain(|(_, seen)| now.duration_since(*seen) < REPEAT_SUPPRESSION);
        if recent.iter().any(|(seen, _)| seen == key) {
            return true;
        }
        recent.push((key.to_string(), now));
        false
    }

    fn was_recently_reported(&self, verse_id: i64) -> bool {
        let now = Instant::now();
        let mut recent = self.recent.lock();
        recent.retain(|(_, seen)| now.duration_since(*seen) < REPEAT_SUPPRESSION);
        if recent.iter().any(|(id, _)| *id == verse_id) {
            return true;
        }
        recent.push((verse_id, now));
        false
    }
}

/// Finds every verse the spoken words appear to quote, most convincing first.
///
/// Split out from [`Detector`] so the matching can be tested against a real
/// database and a real FTS5 index without an app handle in the way.
fn find_detections(library: &Library, translation: &str, words: &[Word]) -> Result<Vec<Detection>> {
    let spoken: Vec<String> = words.iter().map(|word| word.normalized.clone()).collect();
    if spoken.len() < WINDOW {
        return Ok(Vec::new());
    }

    // Several overlapping windows can land on the same verse; keep the longest
    // run each one produced.
    let mut best: HashMap<i64, Detection> = HashMap::new();

    for start in (0..=spoken.len() - WINDOW).step_by(STRIDE) {
        let probe = &spoken[start..start + WINDOW];
        let candidates = library.phrase_search(translation, probe, MAX_VERSES_PER_PHRASE + 1)?;

        // Stock phrasing appears all over scripture, so it identifies nothing.
        if candidates.len() as i64 > MAX_VERSES_PER_PHRASE {
            continue;
        }

        for verse in candidates {
            let verse_words: Vec<String> =
                tokenize(&verse.text).into_iter().map(|word| word.normalized).collect();
            let run = longest_common_run(&spoken, &verse_words);
            if run.length < MIN_MATCH_WORDS {
                continue;
            }

            // Length alone is not evidence. A run built entirely from function
            // words and narrative formula is verbatim scripture that points at
            // no verse in particular, and would otherwise be reported against
            // every verse that happens to open the same way.
            let matched = &spoken[run.start..run.start + run.length];
            if distinctive_words(matched) < MIN_DISTINCTIVE_WORDS {
                continue;
            }

            let confidence = confidence(run.length, verse_words.len());
            if confidence < MIN_CONFIDENCE {
                continue;
            }

            let id = verse.id;
            let snippet = words[run.start..run.start + run.length]
                .iter()
                .map(|word| word.display.as_str())
                .collect::<Vec<_>>()
                .join(" ");

            let detection = Detection {
                verse,
                snippet,
                words_matched: run.length,
                confidence,
                at: epoch_millis(),
            };

            match best.get(&id) {
                Some(existing) if existing.words_matched >= detection.words_matched => {}
                _ => {
                    best.insert(id, detection);
                }
            }
        }
    }

    let mut found: Vec<Detection> = best.into_values().collect();
    // Most convincing first, so the operator reads the best candidate top.
    found.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(found)
}

/// English function words plus the narrative formulas the King James translators
/// used to open verse after verse ("and it came to pass, when...").
///
/// A closed class, so this list does not rot. It exists because a run can be
/// long, verbatim and still identify nothing: "and it came to pass when they
/// were in the" is ten consecutive words of scripture that could introduce any
/// of dozens of verses.
const COMMON_WORDS: &[&str] = &[
    "a", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be",
    "because", "been", "before", "behold", "being", "but", "by", "came", "come", "did", "do",
    "doth", "even", "for", "from", "go", "had", "hath", "have", "he", "her", "him", "his", "how",
    "i", "if", "in", "into", "is", "it", "its", "let", "may", "me", "might", "more", "must", "my",
    "no", "nor", "not", "now", "of", "on", "or", "our", "out", "over", "pass", "said", "saith",
    "say", "saying", "shall", "she", "so", "that", "the", "thee", "their", "them", "then", "there",
    "therefore", "these", "they", "thine", "this", "those", "thou", "thus", "thy", "to", "unto",
    "up", "upon", "us", "was", "we", "went", "were", "what", "when", "where", "which", "while",
    "who", "whom", "will", "with", "would", "ye", "yet", "you", "your",
];

fn is_distinctive(word: &str) -> bool {
    !COMMON_WORDS.contains(&word)
}

fn distinctive_words(run: &[String]) -> usize {
    run.iter().filter(|word| is_distinctive(word)).count()
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn tokenize(text: &str) -> Vec<Word> {
    text.split_whitespace()
        .filter_map(|raw| {
            let normalized: String = raw
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '\'')
                .flat_map(|c| c.to_lowercase())
                .collect();
            if normalized.is_empty() {
                return None;
            }
            Some(Word { normalized, display: raw.to_string() })
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
struct Run {
    length: usize,
    /// Where the run begins in the first sequence.
    start: usize,
}

/// Longest stretch of words the two sequences share in the same order.
///
/// This is what separates a quotation from a coincidence: scattered shared
/// words mean nothing, an unbroken run of them means the speaker is reading.
fn longest_common_run(spoken: &[String], verse: &[String]) -> Run {
    let mut best = Run { length: 0, start: 0 };
    if spoken.is_empty() || verse.is_empty() {
        return best;
    }

    let mut previous = vec![0usize; verse.len() + 1];
    for i in 1..=spoken.len() {
        let mut current = vec![0usize; verse.len() + 1];
        for j in 1..=verse.len() {
            if spoken[i - 1] == verse[j - 1] {
                current[j] = previous[j - 1] + 1;
                if current[j] > best.length {
                    best = Run { length: current[j], start: i - current[j] };
                }
            }
        }
        previous = current;
    }
    best
}

/// How convincing a match of `matched` words against a verse of `verse_words`
/// is, from 0 to 1.
///
/// Takes the better of two readings rather than blending them: a long verse
/// quoted in part is a real detection despite low coverage, and a short verse
/// quoted whole is certain despite a short run.
fn confidence(matched: usize, verse_words: usize) -> f32 {
    let coverage = if verse_words == 0 {
        0.0
    } else {
        matched as f32 / verse_words as f32
    };
    // 14 words of verbatim scripture is conclusive on its own.
    let length = (matched as f32 / 14.0).min(1.0);
    coverage.max(length).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalized(text: &str) -> Vec<String> {
        tokenize(text).into_iter().map(|word| word.normalized).collect()
    }

    #[test]
    fn tokenize_strips_punctuation_and_case() {
        assert_eq!(normalized("For God, so LOVED the world!"), [
            "for", "god", "so", "loved", "the", "world"
        ]);
    }

    #[test]
    fn tokenize_keeps_apostrophes() {
        // Kept rather than stripped, so "God's" and "Gods" stay distinct when
        // runs are compared. Both sides of every comparison use this same
        // tokenizer, so the two stay consistent.
        assert_eq!(normalized("the LORD's anointed"), ["the", "lord's", "anointed"]);
    }

    #[test]
    fn finds_the_quoted_run() {
        let spoken = normalized("as we all know for God so loved the world that he gave");
        let verse = normalized(
            "For God so loved the world, that he gave his only begotten Son",
        );
        let run = longest_common_run(&spoken, &verse);

        // "for god so loved the world that he gave" — the run stops where the
        // speaker did, not where the verse does.
        assert_eq!(run.length, 9);
        assert_eq!(&spoken[run.start], "for");
        assert_eq!(&spoken[run.start + run.length - 1], "gave");
    }

    #[test]
    fn scattered_shared_words_are_not_a_run() {
        // Every word here appears in the verse, but never consecutively.
        let spoken = normalized("world the god gave he loved");
        let verse = normalized("For God so loved the world, that he gave his only begotten Son");
        assert!(longest_common_run(&spoken, &verse).length < MIN_MATCH_WORDS);
    }

    #[test]
    fn run_is_empty_for_unrelated_text() {
        let spoken = normalized("please silence your mobile phones before the service");
        let verse = normalized("In the beginning God created the heaven and the earth");
        assert!(longest_common_run(&spoken, &verse).length <= 1);
    }

    #[test]
    fn a_short_verse_quoted_whole_is_certain() {
        // "Jesus wept." — two words, but complete coverage.
        assert_eq!(confidence(2, 2), 1.0);
    }

    #[test]
    fn a_long_verse_quoted_in_part_still_scores() {
        // 12 verbatim words out of a 40-word verse: coverage is only 0.3, but
        // the run alone is convincing.
        let score = confidence(12, 40);
        assert!(score > MIN_CONFIDENCE, "expected a detection, scored {score}");
    }

    #[test]
    fn a_brief_overlap_with_a_long_verse_does_not() {
        assert!(confidence(6, 60) < MIN_CONFIDENCE);
    }

    #[test]
    fn confidence_never_exceeds_one() {
        assert_eq!(confidence(80, 10), 1.0);
        assert_eq!(confidence(0, 0), 0.0);
    }

    // ---------------------------------------------------------------------
    // End-to-end against a real SQLite database and a real FTS5 index.
    // ---------------------------------------------------------------------

    /// Verbatim KJV, including several verses that share stock phrasing so the
    /// common-phrase guard has something real to reject.
    fn library() -> Library {
        let library = Library::in_memory().expect("in-memory library");
        library
            .seed(
                "KJV",
                &[
                    (43, "John", 3, 16, "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life."),
                    (19, "Psalms", 23, 1, "The LORD is my shepherd; I shall not want."),
                    (43, "John", 11, 35, "Jesus wept."),
                    (1, "Genesis", 1, 1, "In the beginning God created the heaven and the earth."),
                    (40, "Matthew", 5, 9, "Blessed are the peacemakers: for they shall be called the children of God."),
                    // Stock phrasing, repeated the way it is across scripture.
                    (1, "Genesis", 4, 8, "And it came to pass, when they were in the field, that Cain rose up against Abel his brother, and slew him."),
                    (1, "Genesis", 6, 1, "And it came to pass, when men began to multiply on the face of the earth, and daughters were born unto them,"),
                    (1, "Genesis", 7, 10, "And it came to pass, when the waters of the flood were upon the earth,"),
                    (1, "Genesis", 8, 6, "And it came to pass, when forty days were ended, that Noah opened the window of the ark which he had made:"),
                    (1, "Genesis", 11, 2, "And it came to pass, when they journeyed from the east, that they found a plain in the land of Shinar; and they dwelt there."),
                    (1, "Genesis", 12, 11, "And it came to pass, when he was come near to enter into Egypt, that he said unto Sarai his wife,"),
                    (1, "Genesis", 19, 17, "And it came to pass, when they had brought them forth abroad, that he said, Escape for thy life;"),
                    (1, "Genesis", 20, 13, "And it came to pass, when God caused me to wander from my father's house, that I said unto her,"),
                ],
            )
            .expect("seed");
        library
    }

    fn detect(spoken: &str) -> Vec<Detection> {
        find_detections(&library(), "KJV", &tokenize(spoken)).expect("detection")
    }

    #[test]
    fn detects_a_verse_quoted_verbatim() {
        let found = detect(
            "turn with me to the gospel of John where it says for God so loved \
             the world that he gave his only begotten Son that whosoever believeth in him",
        );

        let first = found.first().expect("expected a detection");
        assert_eq!(first.verse.book, "John");
        assert_eq!(first.verse.chapter, 3);
        assert_eq!(first.verse.verse, 16);
        assert!(first.confidence > 0.6, "confidence was {}", first.confidence);
        assert!(first.snippet.starts_with("for God so loved"));
    }

    #[test]
    fn ignores_ordinary_speech() {
        assert!(detect(
            "good morning everyone and welcome please take your seats we have a \
             few announcements before we begin this morning"
        )
        .is_empty());
    }

    #[test]
    fn rejects_stock_phrasing_shared_across_many_verses() {
        // "And it came to pass when" opens verse after verse. Whatever the
        // speaker is reading, this phrase cannot tell us which.
        let found = detect("and it came to pass when they were in the");
        assert!(
            found.is_empty(),
            "stock phrasing produced {} detection(s): {:?}",
            found.len(),
            found.iter().map(|d| &d.verse.book).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_passing_allusion_is_not_a_quotation() {
        // Mentions the shepherd image without quoting it.
        assert!(detect(
            "the lord is like a shepherd to us and we are the sheep of his \
             pasture who follow wherever he leads"
        )
        .is_empty());
    }

    #[test]
    fn survives_a_quotation_split_across_segments() {
        // The rolling buffer joins segments, which is what this simulates: the
        // quotation begins mid-sentence and is preceded by unrelated speech.
        let found = detect(
            "and so the psalmist tells us plainly in that most familiar of \
             psalms The LORD is my shepherd I shall not want",
        );
        let first = found.first().expect("expected a detection");
        assert_eq!(first.verse.book, "Psalms");
        assert_eq!(first.verse.chapter, 23);
    }

    #[test]
    fn a_quotation_is_found_before_the_speaker_pauses() {
        // Azure streams interim results as the sentence is spoken and only
        // emits a final after 800ms of silence. This is the whole point of
        // detecting on interim: the verse has to be found while the words are
        // still being said, not once the speaker stops.
        let library = library();
        let spoken = "turn with me to John chapter three for God so loved the world \
                      that he gave his only begotten Son that whosoever believeth";
        let words: Vec<&str> = spoken.split_whitespace().collect();

        let mut transcript = Transcript::default();
        let mut found_at = None;

        for count in 1..=words.len() {
            // Each interim is the whole utterance so far, revised.
            transcript.push_interim(tokenize(&words[..count].join(" ")));
            let detections =
                find_detections(&library, "KJV", &transcript.words()).expect("detection");
            if detections.iter().any(|d| d.verse.book == "John" && d.verse.verse == 16) {
                found_at = Some(count);
                break;
            }
        }

        let at = found_at.expect("John 3:16 should be found from interim text alone");
        println!(
            "\n  John 3:16 detected after {at} of {} words \u{2014} {} words before the speaker \
             even finished the sentence\n",
            words.len(),
            words.len() - at
        );

        assert!(
            at < words.len(),
            "detection needed the whole utterance, so nothing was gained"
        );
    }

    // ---------------------------------------------------------------------
    // Buffer semantics. Interim results are the same utterance sent over and
    // over as it is revised, so getting this wrong stacks duplicate words and
    // fabricates phrases nobody said.
    // ---------------------------------------------------------------------

    fn spoken(transcript: &Transcript) -> String {
        transcript
            .words()
            .iter()
            .map(|word| word.normalized.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn interim_replaces_rather_than_accumulates() {
        let mut transcript = Transcript::default();

        // Azure revising one sentence as the speaker says it.
        transcript.push_interim(tokenize("for god so"));
        transcript.push_interim(tokenize("for god so loved"));
        transcript.push_interim(tokenize("for god so loved the world"));

        assert_eq!(spoken(&transcript), "for god so loved the world");
    }

    #[test]
    fn a_final_supersedes_the_pending_interim() {
        let mut transcript = Transcript::default();
        transcript.push_interim(tokenize("for god so loved the word"));
        // Azure corrects "word" to "world" when it settles.
        transcript.push_final(tokenize("For God so loved the world."));

        assert_eq!(spoken(&transcript), "for god so loved the world");
    }

    #[test]
    fn finals_accumulate_across_segments() {
        let mut transcript = Transcript::default();
        transcript.push_final(tokenize("for god so loved the world"));
        transcript.push_final(tokenize("that he gave his only begotten son"));

        assert_eq!(
            spoken(&transcript),
            "for god so loved the world that he gave his only begotten son"
        );
    }

    #[test]
    fn interim_follows_settled_history() {
        let mut transcript = Transcript::default();
        transcript.push_final(tokenize("for god so loved the world"));
        transcript.push_interim(tokenize("that he gave"));

        assert_eq!(spoken(&transcript), "for god so loved the world that he gave");
    }

    #[test]
    fn an_abandoned_interim_leaves_no_trace() {
        // The speaker starts a sentence, then Azure discards it.
        let mut transcript = Transcript::default();
        transcript.push_final(tokenize("turn with me to the gospel"));
        transcript.push_interim(tokenize("of mmm er"));
        transcript.push_interim(tokenize(""));

        assert_eq!(spoken(&transcript), "turn with me to the gospel");
    }

    #[test]
    fn the_buffer_stays_bounded() {
        let mut transcript = Transcript::default();
        for _ in 0..40 {
            transcript.push_final(tokenize("and it came to pass"));
        }
        assert!(transcript.words().len() <= BUFFER_WORDS);
    }

    #[test]
    fn a_verse_spanning_interim_and_final_is_still_one_run() {
        // The reason this matters: the quotation is only detectable if the two
        // halves sit next to each other with nothing duplicated between them.
        let mut transcript = Transcript::default();
        transcript.push_final(tokenize("as it is written for god so loved the world"));
        transcript.push_interim(tokenize("that he gave his only begotten son"));

        let verse = tokenize("For God so loved the world, that he gave his only begotten Son")
            .into_iter()
            .map(|word| word.normalized)
            .collect::<Vec<_>>();
        let words: Vec<String> =
            transcript.words().iter().map(|word| word.normalized.clone()).collect();

        assert_eq!(longest_common_run(&words, &verse).length, verse.len());
    }

    #[test]
    fn a_long_run_of_pure_formula_is_not_distinctive() {
        let formula = normalized("and it came to pass when they were in the");
        assert!(distinctive_words(&formula) < MIN_DISTINCTIVE_WORDS);

        let quotation = normalized("for god so loved the world that he gave");
        assert!(distinctive_words(&quotation) >= MIN_DISTINCTIVE_WORDS);
    }

    // ---------------------------------------------------------------------
    // Against the operator's real, fully imported library.
    //
    //   cargo test --lib -- --ignored --nocapture
    //
    // Ignored by default because it needs the app to have been run once. A
    // 13-verse fixture cannot show what 311,000 verses do to the false
    // positive rate, so this is where the thresholds are really judged.
    // ---------------------------------------------------------------------

    fn real_library() -> Option<Library> {
        let path = dirs_app_data()?.join("pulpitry.db");
        if !path.exists() {
            return None;
        }
        Library::open_read_only(&path).ok()
    }

    fn dirs_app_data() -> Option<std::path::PathBuf> {
        let home = std::env::var_os("HOME")?;
        Some(
            std::path::PathBuf::from(home)
                .join("Library/Application Support/com.pulpitry.desktop"),
        )
    }

    #[test]
    #[ignore = "needs the imported library; run the app once first"]
    fn real_library_finds_real_quotations() {
        let Some(library) = real_library() else {
            panic!("no imported library found — run the app once first");
        };

        let cases: &[(&str, &str, i64, i64)] = &[
            (
                "open your bibles with me to John chapter three verse sixteen for God so loved \
                 the world that he gave his only begotten Son that whosoever believeth in him \
                 should not perish but have everlasting life",
                "John", 3, 16,
            ),
            (
                "the psalmist declares the LORD is my shepherd I shall not want he maketh me \
                 to lie down in green pastures",
                "Psalms", 23, 1,
            ),
            (
                "we read that in the beginning God created the heaven and the earth and the \
                 earth was without form and void",
                "Genesis", 1, 1,
            ),
            (
                "Jesus said I am the good shepherd the good shepherd giveth his life for the sheep",
                "John", 10, 11,
            ),
        ];

        for (spoken, book, chapter, verse) in cases {
            let found = find_detections(&library, "KJV", &tokenize(spoken)).expect("detection");
            let hit = found
                .iter()
                .find(|d| d.verse.book == *book && d.verse.chapter == *chapter && d.verse.verse == *verse);
            assert!(
                hit.is_some(),
                "missed {book} {chapter}:{verse}; got {:?}",
                found
                    .iter()
                    .map(|d| format!("{} {}:{}", d.verse.book, d.verse.chapter, d.verse.verse))
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    #[ignore = "needs the imported library; run the app once first"]
    fn real_library_stays_quiet_through_ordinary_preaching() {
        let Some(library) = real_library() else {
            panic!("no imported library found — run the app once first");
        };

        // Sermon speech that talks *about* scripture without quoting it, plus
        // ordinary service announcements. None of this should raise a verse.
        let passages = [
            "good morning church it is wonderful to see you all here this morning \
             please do take your seats and turn off your mobile phones",
            "what I want us to see this morning is that God's love is not something \
             we earn it is something freely given to us long before we ever thought \
             to ask for it",
            "now the shepherd imagery would have been familiar to everyone listening \
             because most of them kept sheep or knew someone who did",
            "and it came to pass when they were gathered together that the offering \
             will be taken up during the next hymn",
            "so let me ask you this morning where are you standing right now are you \
             standing in faith or are you standing in fear",
        ];

        let mut noise = Vec::new();
        for passage in passages {
            for detection in find_detections(&library, "KJV", &tokenize(passage)).expect("detection")
            {
                noise.push(format!(
                    "{} {}:{} ({:.0}%) from {:?}",
                    detection.verse.book,
                    detection.verse.chapter,
                    detection.verse.verse,
                    detection.confidence * 100.0,
                    detection.snippet
                ));
            }
        }

        assert!(noise.is_empty(), "false positives:\n  {}", noise.join("\n  "));
    }

    #[test]
    fn detection_carries_the_speakers_words_not_the_verses() {
        let found = detect(
            "as it is written in the beginning God created the heaven and the \
             earth and that is where we start",
        );
        let first = found.first().expect("expected a detection");
        assert_eq!(first.verse.book, "Genesis");
        // The snippet is what was heard, so the operator can compare the two.
        assert!(
            first.snippet.contains("in the beginning God created"),
            "snippet was {:?}",
            first.snippet
        );
    }
}
