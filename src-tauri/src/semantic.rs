//! Paraphrase matching against a local embedding index.
//!
//! Every verse in the working translation is embedded once and kept in SQLite.
//! Spoken phrases are embedded as they arrive and compared against that index,
//! so scripture the speaker renders in their own words still surfaces.
//!
//! This is the offline half of paraphrase matching. It costs nothing to run,
//! needs no network, and works in a hall with no wifi — which is why it exists
//! alongside the optional remote model rather than being replaced by it.
//!
//! Building the index takes a couple of minutes for 31,102 verses, so it runs
//! on a background thread, reports progress, and resumes where it stopped if
//! interrupted.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;

use anyhow::{Context, Result};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::bible::{Library, Verse};
use crate::embed::{self, Embedder, DIMENSIONS};
use crate::settings::Settings;
use crate::suggestion::{epoch_millis, Suggestion, EVENT_SUGGESTION, SOURCE_SEMANTIC};

pub const EVENT_INDEX: &str = "semantic:status";

/// Verses embedded per pass. Larger batches amortise the matrix multiplies;
/// beyond this the memory churn stops paying for itself.
const BATCH: usize = 32;
/// How many verses to hold back for the next progress report.
const REPORT_EVERY: usize = 512;
/// Candidates fetched per query. Only the best is ever surfaced: verses
/// cluster by theme, so the runners-up are by construction the neighbours of
/// the right answer rather than alternatives to it, and offering five is how
/// the panel fills with passages nobody meant.
const TOP_N: usize = 3;
/// Below this many words there is not enough meaning to embed usefully.
const MIN_WORDS: usize = 8;
/// The floor for a search somebody asked for, rather than one that interrupts.
///
/// Low on purpose. The operator's threshold exists to keep unasked-for guesses
/// off a panel mid-sermon; an operator who has typed a description wants the
/// nearest verses to it, and a strict floor would answer a loosely phrased
/// question with nothing at all. This only keeps out text with no scriptural
/// neighbour whatsoever.
const SEARCH_FLOOR: f32 = 0.25;
/// A verse already suggested is not repeated for this long.
const REPEAT_SUPPRESSION: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub translation: String,
    /// disabled | building | ready | error
    pub state: String,
    pub done: i64,
    pub total: i64,
    pub error: Option<String>,
}

impl IndexStatus {
    fn disabled() -> Self {
        Self {
            translation: String::new(),
            state: "disabled".into(),
            done: 0,
            total: 0,
            error: None,
        }
    }
}

/// The searchable index, held as one contiguous block so scanning it is a
/// linear walk rather than chasing 31,000 separate allocations.
#[derive(Default)]
struct Vectors {
    translation: String,
    ids: Vec<i64>,
    data: Vec<f32>,
}

impl Vectors {
    fn len(&self) -> usize {
        self.ids.len()
    }

    /// Highest-scoring rows, best first.
    fn nearest(&self, query: &[f32], limit: usize) -> Vec<(i64, f32)> {
        let mut scored: Vec<(i64, f32)> = self
            .ids
            .iter()
            .enumerate()
            .map(|(row, id)| {
                let start = row * DIMENSIONS;
                let vector = &self.data[start..start + DIMENSIONS];
                (*id, embed::cosine(query, vector))
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        scored
    }
}

#[derive(Debug, Clone, Default)]
struct Config {
    enabled: bool,
    threshold: f32,
    translation: String,
}

pub struct Semantic {
    app: AppHandle,
    library: Arc<Library>,
    model_dir: PathBuf,
    /// Loaded on first use: 45 MB of weights is not worth paying for at launch
    /// if the operator never turns paraphrase matching on.
    embedder: Mutex<Option<Arc<Embedder>>>,
    vectors: RwLock<Vectors>,
    config: Mutex<Config>,
    status: Mutex<IndexStatus>,
    /// Bumped whenever the target translation changes, so an in-flight build
    /// for the old one stops instead of racing the new one.
    generation: AtomicU64,
    recent: Mutex<Vec<(i64, std::time::Instant)>>,
    queue: SyncSender<u64>,
}

/// Keeps the index build off the last few cores.
///
/// The matrix multiplies underneath run on rayon, which by default takes every
/// core there is. On macOS that is survivable: the window server runs the
/// interface at a higher quality of service and it stays responsive regardless.
/// Windows makes no such distinction -- a thread pool at normal priority
/// competes with the interface on equal terms, and the result is an app that
/// looks hung for as long as the build takes.
///
/// So the pool is capped, leaving room for the interface, the microphone and
/// whatever else the machine is doing during a service. A build that takes
/// somewhat longer and lets the operator keep working is the better trade every
/// time: nobody is waiting on the index, and everybody is waiting on the app.
///
/// Returns the pool. Work has to be handed to it with `install`; holding it is
/// not enough, since rayon routes by the calling thread's pool rather than by
/// what happens to be in scope.
fn restrain() -> Option<rayon::ThreadPool> {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    // Two spare on anything with room for them, and never fewer than one.
    let spare = if cores >= 8 { 3 } else { 2 };
    let workers = cores.saturating_sub(spare).max(1);

    rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .thread_name(|index| format!("pulpitry-embed-{index}"))
        .build()
        .ok()
}

impl Semantic {
    pub fn new(app: AppHandle, library: Arc<Library>, model_dir: PathBuf) -> Arc<Self> {
        let (queue, incoming) = sync_channel::<u64>(4);
        let semantic = Arc::new(Self {
            app,
            library,
            model_dir,
            embedder: Mutex::new(None),
            vectors: RwLock::new(Vectors::default()),
            config: Mutex::new(Config::default()),
            status: Mutex::new(IndexStatus::disabled()),
            generation: AtomicU64::new(0),
            recent: Mutex::new(Vec::new()),
            queue,
        });

        let weak = Arc::downgrade(&semantic);
        std::thread::Builder::new()
            .name("pulpitry-semantic".into())
            .spawn(move || {
                while let Ok(generation) = incoming.recv() {
                    let Some(semantic) = weak.upgrade() else { break };
                    if let Err(err) = semantic.prepare(generation) {
                        crate::log_line!("[semantic] {err:#}");
                        semantic.set_status(|status| {
                            status.state = "error".into();
                            status.error = Some(format!("{err:#}"));
                        });
                    }
                }
            })
            .ok();

        semantic
    }

    pub fn status(&self) -> IndexStatus {
        self.status.lock().clone()
    }

    /// Applies settings and, if anything material changed, rebuilds or reloads.
    pub fn configure(&self, settings: &Settings) {
        let next = Config {
            enabled: settings.semantic_enabled,
            threshold: settings.semantic_threshold,
            translation: settings.translation.clone(),
        };

        let changed = {
            let mut current = self.config.lock();
            let material = current.enabled != next.enabled || current.translation != next.translation;
            *current = next.clone();
            material
        };

        if !changed {
            return;
        }

        self.recent.lock().clear();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        if !next.enabled {
            *self.vectors.write() = Vectors::default();
            self.set_status(|status| *status = IndexStatus::disabled());
            return;
        }
        let _ = self.queue.try_send(generation);
    }

    pub fn reset(&self) {
        self.recent.lock().clear();
    }

    fn current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn set_status(&self, update: impl FnOnce(&mut IndexStatus)) {
        let next = {
            let mut status = self.status.lock();
            update(&mut status);
            status.clone()
        };
        let _ = self.app.emit(EVENT_INDEX, next);
    }

    /// Ensures every verse of the working translation is embedded, then loads
    /// the index into memory.
    fn prepare(&self, generation: u64) -> Result<()> {
        let config = self.config.lock().clone();
        if !config.enabled || config.translation.is_empty() {
            return Ok(());
        }

        let (done, total) = self.library.embedding_progress(&config.translation)?;
        self.set_status(|status| {
            *status = IndexStatus {
                translation: config.translation.clone(),
                state: if done >= total { "ready" } else { "building" }.into(),
                done,
                total,
                error: None,
            }
        });

        if done < total {
            self.build(&config.translation, generation, done, total)?;
            if !self.current(generation) {
                return Ok(());
            }
        }

        let unreadable = self.load(&config.translation)?;
        if unreadable > 0 {
            // Row counts would otherwise report the index as complete while it
            // matched nothing at all — a silent failure. Discard and redo.
            crate::log_line!(
                "[semantic] {unreadable} stored vectors are in an old format; rebuilding {}",
                config.translation
            );
            self.library.clear_embeddings(&config.translation)?;
            let (_, total) = self.library.embedding_progress(&config.translation)?;
            self.build(&config.translation, generation, 0, total)?;
            self.load(&config.translation)?;
        }
        if !self.current(generation) {
            return Ok(());
        }

        let loaded = self.vectors.read().len() as i64;
        self.set_status(|status| {
            status.state = "ready".into();
            status.done = loaded;
            status.total = loaded;
            status.error = None;
        });
        Ok(())
    }

    fn build(&self, translation: &str, generation: u64, mut done: i64, total: i64) -> Result<()> {
        let embedder = self.embedder()?;
        let pool = restrain();
        let mut since_report = 0usize;
        // Where the scan has reached. Verses arrive in id order, so this only
        // ever moves forward.
        let mut after = 0i64;

        loop {
            if !self.current(generation) {
                return Ok(());
            }

            let pending = self
                .library
                .verses_awaiting_embedding(translation, after, BATCH as i64)?;
            if pending.is_empty() {
                break;
            }
            after = pending.last().map(|(id, _)| *id).unwrap_or(after);

            let texts: Vec<String> = pending.iter().map(|(_, text)| text.clone()).collect();
            // Inside the pool, not merely alongside it: rayon dispatches to
            // whichever pool the calling thread belongs to, so work handed to it
            // from outside still lands on the global one and takes every core.
            let vectors = match &pool {
                Some(pool) => pool.install(|| embedder.embed(&texts))?,
                None => embedder.embed(&texts)?,
            };

            let rows: Vec<(i64, Vec<u8>)> = pending
                .iter()
                .zip(&vectors)
                .map(|((id, _), vector)| (*id, embed::to_blob(vector)))
                .collect();
            self.library.store_embeddings(translation, &rows)?;

            done += rows.len() as i64;
            since_report += rows.len();
            if since_report >= REPORT_EVERY {
                since_report = 0;
                self.set_status(|status| {
                    status.state = "building".into();
                    status.done = done;
                    status.total = total;
                });
            }
        }
        Ok(())
    }

    /// Loads the stored index. Returns how many rows were unreadable.
    fn load(&self, translation: &str) -> Result<usize> {
        let stored = self.library.load_embeddings(translation)?;

        let mut ids = Vec::with_capacity(stored.len());
        let mut data = Vec::with_capacity(stored.len() * DIMENSIONS);
        let mut unreadable = 0usize;
        for (id, blob) in stored {
            // A vector of the wrong width means the stored format no longer
            // matches the model. Using it would corrupt every comparison.
            let Some(vector) = embed::from_blob(&blob) else {
                unreadable += 1;
                continue;
            };
            ids.push(id);
            data.extend_from_slice(&vector);
        }

        *self.vectors.write() = Vectors { translation: translation.to_string(), ids, data };
        Ok(unreadable)
    }

    fn embedder(&self) -> Result<Arc<Embedder>> {
        let mut slot = self.embedder.lock();
        if let Some(embedder) = slot.as_ref() {
            return Ok(Arc::clone(embedder));
        }
        let embedder = Arc::new(
            Embedder::load(&self.model_dir).context("could not load the embedding model")?,
        );
        *slot = Some(Arc::clone(&embedder));
        Ok(embedder)
    }

    /// Embeds a handful of texts, for anything that needs the model but not
    /// the Bible's index.
    ///
    /// The follower needs a deck embedded and has no business loading a second
    /// copy of the model to do it: one owner of the model is one queue for it,
    /// and two would be two copies of a few hundred megabytes in a laptop that
    /// is also transcribing.
    ///
    /// Batched, because the model is far quicker asked once for twenty strings
    /// than twenty times for one.
    pub fn embed_texts(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        self.embedder()?.embed(texts)
    }

    /// The same, for one stretch of speech.
    pub fn embed_spoken(&self, text: &str) -> Result<Vec<f32>> {
        self.embedder()?.embed_one(text)
    }

    /// Matches a stretch of speech against the index and emits what clears the
    /// operator's threshold.
    ///
    /// `had_exact_match` suppresses the work entirely: if verbatim detection
    /// already named the passage, a fuzzy second opinion is just noise.
    pub fn consider(&self, context: &str, had_exact_match: bool) {
        if had_exact_match {
            return;
        }
        let config = self.config.lock().clone();
        if !config.enabled || context.split_whitespace().count() < MIN_WORDS {
            return;
        }
        if self.status.lock().state != "ready" {
            return;
        }

        if let Err(err) = self.match_and_emit(&config, context) {
            crate::log_line!("[semantic] {err:#}");
        }
    }

    /// Searches the index with arbitrary text, returning verses above the
    /// operator's threshold, best first.
    ///
    /// Exposed so the model-assist path can search with a *restatement* of what
    /// the speaker said rather than the raw transcript. Speech recognition
    /// output is noisy and preachers paraphrase loosely; a restatement in
    /// scriptural terms sits far closer to the verse in embedding space, which
    /// is the whole idea behind hypothetical-document retrieval.
    pub fn matches_for(&self, text: &str, limit: usize) -> Result<Vec<(Verse, f32)>> {
        let config = self.config.lock().clone();
        if !config.enabled || self.status.lock().state != "ready" {
            return Ok(Vec::new());
        }

        let embedder = self.embedder()?;
        let query = embedder.embed_one(text)?;

        let hits = {
            let vectors = self.vectors.read();
            if vectors.len() == 0 {
                return Ok(Vec::new());
            }
            vectors.nearest(&query, limit)
        };

        let wanted: Vec<i64> = hits
            .iter()
            .filter(|(_, score)| *score >= config.threshold)
            .map(|(id, _)| *id)
            .collect();
        if wanted.is_empty() {
            return Ok(Vec::new());
        }

        let verses = self.library.verses_by_id(&wanted)?;
        Ok(verses
            .into_iter()
            .filter_map(|verse| {
                hits.iter()
                    .find(|(id, _)| *id == verse.id)
                    .map(|(_, score)| (verse, *score))
            })
            .collect())
    }

    /// The same index, searched with text the operator typed.
    ///
    /// Separate from [`Self::matches_for`] because the threshold means two
    /// different things. That one decides, unprompted, whether to put a passage
    /// in front of somebody mid-service, so it has to be strict: a wrong guess
    /// there spends attention nobody offered. This one was *asked* — somebody
    /// typed "the widow who gave everything she had" — and answering that with
    /// an empty panel because the phrasing was loose reads as a broken search
    /// rather than as a careful one. So only [`SEARCH_FLOOR`] applies, and the
    /// scores come back so the panel can show how close each verse came.
    ///
    /// Needs the index, which means paraphrase matching has to be on: the
    /// vectors are dropped when it is turned off. Callers read [`Self::status`]
    /// and say so, rather than reporting a search that found nothing.
    pub fn search(&self, text: &str, limit: usize) -> Result<Vec<(Verse, f32)>> {
        let text = text.trim();
        if text.is_empty() || self.status.lock().state != "ready" {
            return Ok(Vec::new());
        }

        let embedder = self.embedder()?;
        let query = embedder.embed_one(text)?;

        let hits = {
            let vectors = self.vectors.read();
            if vectors.len() == 0 {
                return Ok(Vec::new());
            }
            vectors.nearest(&query, limit.clamp(1, 50))
        };

        let wanted: Vec<i64> = hits
            .iter()
            .filter(|(_, score)| *score >= SEARCH_FLOOR)
            .map(|(id, _)| *id)
            .collect();
        if wanted.is_empty() {
            return Ok(Vec::new());
        }

        // Walked in score order rather than in the order the library hands the
        // rows back: the closest verse is the answer, and a list that buries it
        // third because of how SQLite found it is a worse answer.
        let verses = self.library.verses_by_id(&wanted)?;
        Ok(hits
            .iter()
            .filter_map(|(id, score)| {
                verses
                    .iter()
                    .find(|verse| verse.id == *id)
                    .map(|verse| (verse.clone(), *score))
            })
            .collect())
    }

    /// Whether a verse has been suggested recently, and records it if not.
    /// Shared with the assist path so the two sources do not double up.
    pub fn claim(&self, verse_id: i64) -> bool {
        !self.was_recently_suggested(verse_id)
    }

    pub fn emit_suggestion(&self, verse: Verse, score: f32, kind: &str, reason: &str, context: &str) {
        let suggestion = Suggestion {
            verse,
            source: SOURCE_SEMANTIC.into(),
            kind: kind.into(),
            confidence: score,
            reason: reason.into(),
            context: context.to_string(),
            at: epoch_millis(),
        };
        let _ = self.app.emit(EVENT_SUGGESTION, &suggestion);
    }

    fn match_and_emit(&self, config: &Config, context: &str) -> Result<()> {
        let embedder = self.embedder()?;
        let query = embedder.embed_one(context)?;

        let hits = {
            let vectors = self.vectors.read();
            if vectors.translation != config.translation || vectors.len() == 0 {
                return Ok(());
            }
            vectors.nearest(&query, TOP_N)
        };

        // Best only. A thematic passage pulls a whole cluster above any
        // threshold; the second and third are the same idea worded differently,
        // not competing answers.
        let Some((id, score)) = hits.first().copied() else { return Ok(()) };
        if score < config.threshold {
            return Ok(());
        }
        if self.was_recently_suggested(id) {
            return Ok(());
        }

        if let Some(verse) = self.library.verses_by_id(&[id])?.into_iter().next() {
            self.emit(verse, score, context);
        }
        Ok(())
    }

    fn emit(&self, verse: Verse, score: f32, context: &str) {
        let suggestion = Suggestion {
            verse,
            source: SOURCE_SEMANTIC.into(),
            kind: "allusion".into(),
            confidence: score,
            reason: "similar in meaning".into(),
            context: context.to_string(),
            at: epoch_millis(),
        };
        let _ = self.app.emit(EVENT_SUGGESTION, &suggestion);
    }

    fn was_recently_suggested(&self, verse_id: i64) -> bool {
        let now = std::time::Instant::now();
        let mut recent = self.recent.lock();
        recent.retain(|(_, seen)| now.duration_since(*seen) < REPEAT_SUPPRESSION);
        if recent.iter().any(|(id, _)| *id == verse_id) {
            return true;
        }
        recent.push((verse_id, now));
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(values: &[f32]) -> Vec<f32> {
        let mut vector = vec![0.0f32; DIMENSIONS];
        vector[..values.len()].copy_from_slice(values);
        let norm: f32 = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        vector.iter().map(|v| v / norm).collect()
    }

    fn index(rows: &[(i64, Vec<f32>)]) -> Vectors {
        let mut ids = Vec::new();
        let mut data = Vec::new();
        for (id, vector) in rows {
            ids.push(*id);
            data.extend_from_slice(vector);
        }
        Vectors { translation: "KJV".into(), ids, data }
    }

    #[test]
    fn nearest_ranks_by_similarity() {
        let vectors = index(&[
            (1, unit(&[1.0, 0.0, 0.0])),
            (2, unit(&[0.9, 0.4, 0.0])),
            (3, unit(&[0.0, 1.0, 0.0])),
            (4, unit(&[-1.0, 0.0, 0.0])),
        ]);

        let hits = vectors.nearest(&unit(&[1.0, 0.0, 0.0]), 3);

        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].0, 1);
        assert_eq!(hits[1].0, 2);
        assert_eq!(hits[2].0, 3);
        assert!(hits[0].1 > hits[1].1 && hits[1].1 > hits[2].1);
        // The opposing vector must not make the cut at all.
        assert!(!hits.iter().any(|(id, _)| *id == 4));
    }

    #[test]
    fn nearest_handles_an_empty_index() {
        assert!(index(&[]).nearest(&unit(&[1.0]), 5).is_empty());
    }

    #[test]
    fn nearest_returns_everything_when_asked_for_more_than_it_has() {
        let vectors = index(&[(1, unit(&[1.0, 0.0])), (2, unit(&[0.0, 1.0]))]);
        assert_eq!(vectors.nearest(&unit(&[1.0, 0.0]), 10).len(), 2);
    }

    #[test]
    fn an_identical_vector_scores_one() {
        let vector = unit(&[0.3, 0.7, 0.2]);
        let hits = index(&[(1, vector.clone())]).nearest(&vector, 1);
        assert!((hits[0].1 - 1.0).abs() < 1e-5, "scored {}", hits[0].1);
    }
}

#[cfg(test)]
mod quality {
    //! Retrieval quality against the real library and the real model.
    //!
    //!   cargo test --manifest-path src-tauri/Cargo.toml --release --lib \
    //!     quality -- --ignored --nocapture
    //!
    //! Ignored by default: it embeds several thousand verses, which takes
    //! about half a minute even in release. This is the only place the
    //! threshold can be judged honestly — a toy corpus makes any retrieval
    //! look good.

    use super::*;
    use crate::embed::Embedder;

    fn library() -> Option<Library> {
        let home = std::env::var_os("HOME")?;
        let path = std::path::PathBuf::from(home)
            .join("Library/Application Support/com.pulpitry.desktop/pulpitry.db");
        if !path.exists() {
            return None;
        }
        Library::open_read_only(&path).ok()
    }

    fn embedder() -> Option<Embedder> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/embedder");
        if !dir.join("model.safetensors").exists() {
            return None;
        }
        Embedder::load(&dir).ok()
    }

    /// Loads the operator's real, fully built index straight from the database.
    fn full_index(library: &Library, translation: &str) -> Vectors {
        let stored = library.load_embeddings(translation).expect("embeddings");
        let mut ids = Vec::with_capacity(stored.len());
        let mut data = Vec::with_capacity(stored.len() * DIMENSIONS);
        for (id, blob) in stored {
            let Some(vector) = crate::embed::from_blob(&blob) else { continue };
            ids.push(id);
            data.extend_from_slice(&vector);
        }
        Vectors { translation: translation.into(), ids, data }
    }

    #[test]
    #[ignore = "needs the imported library and a built index"]
    fn the_threshold_holds_against_the_whole_translation() {
        // The earlier calibration used a 7,972-verse subset. The real index is
        // four times that, so every query has four times as many chances to
        // find a spurious close match. This measures the noise ceiling where
        // it actually matters.
        let (Some(library), Some(embedder)) = (library(), embedder()) else {
            panic!("run the app once and scripts/build-embedder.mjs first");
        };
        let index = full_index(&library, "KJV");
        if index.len() < 30_000 {
            panic!("index has only {} verses; build it first", index.len());
        }
        println!("\n  index: {} verses\n", index.len());

        // Speech that refers to no passage whatsoever.
        let noise = [
            "good morning church it is wonderful to see you all here this morning",
            "please remember to silence your mobile phones before we begin",
            "the offering will be taken up during the next hymn so please have it ready",
            "we have a few announcements about the youth trip next weekend",
            "if you are visiting with us today please fill in a welcome card",
            "the youth group meets on wednesday evening at seven in the church hall",
            "car park is full so please use the overflow across the road",
            "we are so glad you could join us and hope you feel at home",
            "let me tell you a story about something that happened to me last week",
            "there is tea and coffee served afterwards in the room behind you",
        ];

        let mut ceiling = 0.0f32;
        let mut worst = String::new();
        println!("  ordinary speech:");
        for phrase in noise {
            let query = embedder.embed_one(phrase).expect("embed");
            let hits = index.nearest(&query, 1);
            let score = hits[0].1;
            let verse = library.verses_by_id(&[hits[0].0]).expect("resolve");
            println!(
                "  {:<58} {score:.2}  -> {} {}:{}",
                truncate(phrase, 56),
                verse[0].book,
                verse[0].chapter,
                verse[0].verse
            );
            if score > ceiling {
                ceiling = score;
                worst = phrase.to_string();
            }
        }

        println!("\n  highest unrelated score: {ceiling:.2}  ({})\n", truncate(&worst, 60));
    }

    #[test]
    #[ignore = "needs the imported library and a built index"]
    fn half_finished_sentences_match_things_nobody_said() {
        // Detection now runs on interim results, which arrive several times a
        // second mid-sentence. If those fragments score above the threshold
        // against unrelated verses, every sentence sprays the Paraphrase tab
        // with matches before the speaker has finished the thought.
        let (Some(library), Some(embedder)) = (library(), embedder()) else {
            panic!("run the app once first");
        };
        let index = full_index(&library, "KJV");

        let sentence = "and so this morning I want us to think about what it means \
                        to walk in the light as he is in the light";
        let words: Vec<&str> = sentence.split_whitespace().collect();

        println!("\n  growing fragments of one sentence:");
        let mut above = 0;
        for count in (4..=words.len()).step_by(3) {
            let fragment = words[..count].join(" ");
            let query = embedder.embed_one(&fragment).expect("embed");
            let hits = index.nearest(&query, 1);
            let verse = library.verses_by_id(&[hits[0].0]).expect("resolve");
            let over = hits[0].1 >= 0.60;
            if over {
                above += 1;
            }
            println!(
                "  {:>2}w {:<52} {:.2}{}  -> {} {}:{}",
                count,
                truncate(&fragment, 50),
                hits[0].1,
                if over { " *" } else { "  " },
                verse[0].book,
                verse[0].chapter,
                verse[0].verse
            );
        }
        println!("\n  fragments clearing the 0.60 threshold: {above}\n");
    }

    #[test]
    #[ignore = "needs the imported library and a built index"]
    fn the_default_threshold_separates_quotation_from_theme() {
        // The operating point, against the full index and against the negative
        // class that actually matters: preaching that is thematic without
        // quoting anything. Announcements are the easy case; this is the one
        // that fills the panel with wrong references when the bar is too low.
        let (Some(library), Some(embedder)) = (library(), embedder()) else {
            panic!("run the app once first");
        };
        let index = full_index(&library, "KJV");
        const DEFAULT_THRESHOLD: f32 = 0.70;

        let paraphrases = [
            "God loved the world so much that he gave his one and only son",
            "faith means being certain of the things we hope for but cannot see",
            "everyone has sinned and nobody measures up to God's glory",
            "he was wounded because of the wrong things we did",
        ];
        let thematic = [
            "and so this morning I want us to think about what it means to walk in the light as he is in the light",
            "we need to be people who pray more and trust God with everything",
            "the church is called to love one another and serve the community",
            "God is faithful and his mercy endures through every season of life",
            "good morning church it is wonderful to see you all here this morning",
            "the offering will be taken up during the next hymn so please have it ready",
        ];

        let top = |text: &str| index.nearest(&embedder.embed_one(text).expect("embed"), 1)[0].1;

        let surfaced = paraphrases.iter().filter(|t| top(t) >= DEFAULT_THRESHOLD).count();
        let leaked: Vec<(&str, f32)> = thematic
            .iter()
            .map(|t| (*t, top(t)))
            .filter(|(_, score)| *score >= DEFAULT_THRESHOLD)
            .collect();

        println!(
            "\n  at {:.0}%: {surfaced}/{} paraphrases surface, {} of {} thematic passages leak\n",
            DEFAULT_THRESHOLD * 100.0,
            paraphrases.len(),
            leaked.len(),
            thematic.len()
        );
        for (text, score) in &leaked {
            println!("  leaked {score:.2}  {}", truncate(text, 64));
        }

        assert!(
            leaked.is_empty(),
            "thematic speech cleared the threshold; it needs raising"
        );
        assert!(
            surfaced >= paraphrases.len() - 1,
            "only {surfaced} of {} paraphrases still surface",
            paraphrases.len()
        );
    }

    #[test]
    #[ignore = "needs the imported library and a built index"]
    fn a_true_match_stands_out_from_its_thematic_neighbours() {
        // Many verses share vocabulary. What separates "the speaker means this
        // verse" from "the speaker used words several verses happen to share"
        // is whether one candidate stands clear of the rest.
        let (Some(library), Some(embedder)) = (library(), embedder()) else {
            panic!("run the app once first");
        };
        let index = full_index(&library, "KJV");

        let cases: &[(&str, &str)] = &[
            ("God loved the world so much that he gave his one and only son", "real"),
            ("faith means being certain of the things we hope for but cannot see", "real"),
            ("everyone has sinned and nobody measures up to God's glory", "real"),
            ("he was wounded because of the wrong things we did", "real"),
            // Thematic but not a quotation of any one passage.
            ("and so this morning I want us to think about what it means to walk in the light as he is in the light", "cluster"),
            ("we need to be people who pray more and trust God with everything", "cluster"),
            ("the church is called to love one another and serve the community", "cluster"),
            ("God is faithful and his mercy endures through every season of life", "cluster"),
        ];

        println!("\n  {:<58} {:>5} {:>6} {:>7}", "", "top", "next", "margin");
        let mut real_min = f32::MAX;
        let mut cluster_max = 0.0f32;

        for (text, kind) in cases {
            let query = embedder.embed_one(text).expect("embed");
            let hits = index.nearest(&query, 2);
            let margin = hits[0].1 - hits[1].1;
            let verse = library.verses_by_id(&[hits[0].0]).expect("resolve");

            println!(
                "  {:<58} {:>5.2} {:>6.2} {:>7.3}  {} {}:{}",
                truncate(text, 56),
                hits[0].1,
                hits[1].1,
                margin,
                verse[0].book,
                verse[0].chapter,
                verse[0].verse
            );

            if *kind == "real" {
                real_min = real_min.min(margin);
            } else {
                cluster_max = cluster_max.max(margin);
            }
        }

        println!("\n  smallest real margin {real_min:.3} vs largest cluster margin {cluster_max:.3}\n");
    }

    #[test]
    #[ignore = "needs the imported library and the bundled model"]
    fn a_restatement_recovers_what_raw_speech_misses() {
        // The premise of feeding the model's restatement into the index: a
        // preacher's own words sit far from the verse in embedding space,
        // while the same idea in scriptural phrasing sits close to it.
        //
        // "ask and it will be given to you, search and you will find" scored
        // only 0.39 against Matthew 7:7 — below any workable threshold. This
        // measures whether restating it clears that.
        let (Some(library), Some(embedder)) = (library(), embedder()) else {
            panic!("run the app once and scripts/build-embedder.mjs first");
        };

        let corpus = library.verses_in_books("KJV", &[19, 40, 43, 45]).expect("corpus");
        let texts: Vec<String> = corpus.iter().map(|verse| verse.text.clone()).collect();
        let mut ids = Vec::new();
        let mut data = Vec::new();
        for (chunk_index, chunk) in texts.chunks(64).enumerate() {
            for (offset, vector) in embedder.embed(&chunk.to_vec()).expect("embed").iter().enumerate() {
                ids.push(corpus[chunk_index * 64 + offset].id);
                data.extend_from_slice(vector);
            }
        }
        let index = Vectors { translation: "KJV".into(), ids, data };

        let cases: &[(&str, &str, &str)] = &[
            (
                "ask and it will be given to you, search and you will find",
                "Ask, and it shall be given you; seek, and ye shall find.",
                "Matthew",
            ),
            (
                "he takes care of me the way a shepherd looks after his sheep",
                "The LORD is my shepherd; I shall not want.",
                "Psalms",
            ),
        ];

        println!("\n  {:<52} {:>7} {:>11}", "", "spoken", "restated");
        for (spoken, restated, book) in cases {
            let raw = index.nearest(&embedder.embed_one(spoken).expect("embed"), 1)[0];
            let hyde = index.nearest(&embedder.embed_one(restated).expect("embed"), 1)[0];

            let named = library.verses_by_id(&[hyde.0]).expect("resolve");
            println!(
                "  {:<52} {:>7.2} {:>11.2}   -> {} {}:{}",
                truncate(spoken, 50),
                raw.1,
                hyde.1,
                named[0].book,
                named[0].chapter,
                named[0].verse
            );

            assert_eq!(&named[0].book, book, "restatement landed on the wrong book");
            assert!(
                hyde.1 > raw.1,
                "restating made the match worse: {:.2} -> {:.2}",
                raw.1,
                hyde.1
            );
        }
        println!();
    }

    #[test]
    #[ignore = "needs the imported library and the bundled model"]
    fn paraphrases_retrieve_the_passage_they_refer_to() {
        let (Some(library), Some(embedder)) = (library(), embedder()) else {
            panic!("run the app once and scripts/build-embedder.mjs first");
        };

        // Genesis, Psalms, Isaiah, Matthew, John, Romans, Hebrews: a corpus
        // large enough that the right answer is not the only plausible one.
        let corpus = library
            .verses_in_books("KJV", &[1, 19, 23, 40, 43, 45, 58])
            .expect("corpus");
        assert!(corpus.len() > 6000, "corpus too small: {}", corpus.len());

        let texts: Vec<String> = corpus.iter().map(|verse| verse.text.clone()).collect();
        let mut ids = Vec::with_capacity(corpus.len());
        let mut data = Vec::with_capacity(corpus.len() * DIMENSIONS);
        for (chunk_index, chunk) in texts.chunks(64).enumerate() {
            let vectors = embedder.embed(&chunk.to_vec()).expect("embed");
            for (offset, vector) in vectors.iter().enumerate() {
                ids.push(corpus[chunk_index * 64 + offset].id);
                data.extend_from_slice(vector);
            }
        }
        let index = Vectors { translation: "KJV".into(), ids, data };
        println!("\n  corpus: {} verses\n", index.len());

        // Spoken the way a preacher actually would, not quoted.
        let probes: &[(&str, &str, i64, i64)] = &[
            ("God loved the world so much that he gave his one and only son", "John", 3, 16),
            ("the Lord takes care of me like a shepherd, I have everything I need", "Psalms", 23, 1),
            ("ask and it will be given to you, search and you will find", "Matthew", 7, 7),
            ("faith means being certain of the things we hope for but cannot see", "Hebrews", 11, 1),
            ("everyone has sinned and nobody measures up to God's glory", "Romans", 3, 23),
            ("he was wounded because of the wrong things we did", "Isaiah", 53, 5),
        ];

        let mut hits = 0;
        for (spoken, book, chapter, verse) in probes {
            let query = embedder.embed_one(spoken).expect("embed query");
            let nearest = index.nearest(&query, 5);
            let verses = library
                .verses_by_id(&nearest.iter().map(|(id, _)| *id).collect::<Vec<_>>())
                .expect("resolve");

            let rank = verses.iter().position(|candidate| {
                candidate.book == *book && candidate.chapter == *chapter && candidate.verse == *verse
            });

            let top = verses.first().expect("a result");
            let score = nearest.first().map(|(_, s)| *s).unwrap_or_default();
            println!(
                "  {:<62} -> {} {}:{} ({score:.2}){}",
                format!("\"{spoken}\""),
                top.book,
                top.chapter,
                top.verse,
                match rank {
                    Some(0) => "  [top]".to_string(),
                    Some(n) => format!("  [wanted {book} {chapter}:{verse} at #{}]", n + 1),
                    None => format!("  [MISSED {book} {chapter}:{verse}]"),
                }
            );
            if rank.is_some() {
                hits += 1;
            }
        }
        println!();

        assert!(
            hits >= probes.len() - 1,
            "only {hits} of {} paraphrases found their passage in the top 5",
            probes.len()
        );

        // The default threshold has to be justified against speech that means
        // nothing scriptural, not only against paraphrases. Ordinary service
        // announcements still find *some* verse to be vaguely near.
        let noise = [
            "good morning church it is wonderful to see you all here this morning",
            "please remember to silence your mobile phones before we begin",
            "the offering will be taken up during the next hymn so please have it ready",
            "we have a few announcements about the youth trip next weekend",
            "if you are visiting with us today please fill in a welcome card",
        ];

        const DEFAULT_THRESHOLD: f32 = 0.60;

        let mut noise_ceiling = 0.0f32;
        println!("  noise floor:");
        for phrase in noise {
            let query = embedder.embed_one(phrase).expect("embed");
            let score = index.nearest(&query, 1)[0].1;
            noise_ceiling = noise_ceiling.max(score);
            println!("  {:<62} {score:.2}", truncate(phrase, 60));
        }

        let surfaced = probes
            .iter()
            .filter(|(spoken, _, _, _)| {
                let query = embedder.embed_one(spoken).expect("embed");
                index.nearest(&query, 1)[0].1 >= DEFAULT_THRESHOLD
            })
            .count();

        println!(
            "\n  at the {:.0}% default: {surfaced}/{} paraphrases surface, \
             highest unrelated score {noise_ceiling:.2}\n",
            DEFAULT_THRESHOLD * 100.0,
            probes.len()
        );

        assert!(
            noise_ceiling < DEFAULT_THRESHOLD,
            "ordinary speech reached {noise_ceiling:.2}, at or above the {DEFAULT_THRESHOLD:.2} \
             default — the default needs raising or the noise sample is unrepresentative"
        );
        assert!(
            surfaced >= 4,
            "only {surfaced} of {} paraphrases clear the default threshold",
            probes.len()
        );
    }

    fn truncate(text: &str, width: usize) -> String {
        if text.len() <= width {
            text.to_string()
        } else {
            format!("{}…", &text[..width - 1])
        }
    }
}
