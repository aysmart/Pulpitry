//! Optional model-assisted verse suggestion, via Azure AI Foundry.
//!
//! Exact detection (see [`crate::detect`]) only fires on verbatim quotation. A
//! preacher who says "God loved the world so much he gave his only son" is
//! plainly referring to John 3:16, and no amount of string matching will see
//! it. That is what this module is for.
//!
//! # The model never supplies scripture
//!
//! It is asked for *references only*, never verse text. Every reference it
//! returns is resolved against the local library, and the words the operator
//! sees are read out of SQLite. A reference that does not resolve is thrown
//! away. So the model can be wrong about *which* verse — the operator reviews
//! it, and nothing reaches the projector without them pressing Display — but it
//! cannot invent scripture that never existed.
//!
//! This layer is strictly additive: it is off by default, and everything in
//! phase 4 keeps working with no network at all.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::bible::{Library, Verse};
use crate::semantic::Semantic;
use crate::settings::Settings;
use crate::suggestion::{epoch_millis, Suggestion, EVENT_SUGGESTION, SOURCE_MODEL};

/// Cheapest possible cost control: never more than one call per interval, no
/// matter how fast the speaker is going.
const MIN_CALL_INTERVAL: Duration = Duration::from_secs(6);
/// Below this there is not enough speech to reason about, and calling would
/// mostly buy noise.
const MIN_WORDS: usize = 12;
/// Words of context sent to the model. Enough for a thought, short enough to
/// keep each call small.
const CONTEXT_WORDS: usize = 60;
/// The model's own confidence, which is not calibrated — used only to drop the
/// suggestions it is already unsure about.
const MIN_CONFIDENCE: f32 = 0.5;
const REPEAT_SUPPRESSION: Duration = Duration::from_secs(120);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Verses to consider from a restatement search.
const RESTATEMENT_MATCHES: usize = 3;

const SYSTEM_PROMPT: &str = "\
You read a live sermon transcript and help locate the scripture behind it.

The transcript comes from speech recognition: it may mishear words, drop \
punctuation, and cut off mid-sentence. Read through those errors.

Do two things.

1. \"restated\": rewrite what the speaker is saying as a single plain sentence \
in the vocabulary of scripture, resolving pronouns and correcting obvious \
mishearings. Write it as the passage itself would put it, not as a description \
of the speaker. If the speaker is not touching on scripture at all, use an \
empty string.

2. \"references\": passages you are confident the speaker means.

Rules:
- Reply with JSON only. No prose, no code fences.
- Return REFERENCES ONLY. Never include verse text; it will be looked up.
- Shape: {\"restated\":\"\",\"references\":[{\"reference\":\"John 3:16\",\
\"kind\":\"quotation\",\"confidence\":0.0,\"why\":\"\"}]}
- \"kind\" is \"quotation\" when the wording is close to the text, \"allusion\" \
when the speaker is referring to the passage in their own words.
- \"why\" is at most 12 words explaining the link.
- Omit a reference rather than guess; an empty list is a good answer.
- Never return more than 3 references.";

/// Everything one model reply carries.
#[derive(Debug, Clone, Default, PartialEq)]
struct Reading {
    /// The speaker's meaning rewritten in scriptural terms. Searched against
    /// the embedding index, which raw transcript text matches poorly.
    restated: String,
    references: Vec<Proposal>,
}

/// What the model proposed, before it has been checked against the library.
#[derive(Debug, Clone, PartialEq)]
struct Proposal {
    reference: String,
    kind: String,
    confidence: f32,
    reason: String,
}

#[derive(Debug, Clone, Default)]
struct Config {
    enabled: bool,
    endpoint: String,
    model: String,
    api_version: String,
    key: String,
    translation: String,
}

impl Config {
    fn usable(&self) -> bool {
        self.enabled
            && !self.endpoint.trim().is_empty()
            && !self.model.trim().is_empty()
            && !self.key.trim().is_empty()
            && !self.translation.trim().is_empty()
    }
}

pub struct Assistant {
    app: AppHandle,
    library: Arc<Library>,
    /// Set once the index exists; the restatement is searched against it.
    semantic: Mutex<Option<Arc<Semantic>>>,
    config: Mutex<Config>,
    last_call: Mutex<Option<Instant>>,
    recent: Mutex<Vec<(i64, Instant)>>,
    /// Set after a failure so the operator is told once, not once per segment.
    reported_failure: AtomicBool,
    queue: SyncSender<String>,
    client: reqwest::blocking::Client,
}

impl Assistant {
    pub fn new(app: AppHandle, library: Arc<Library>) -> Arc<Self> {
        install_crypto_provider();
        let (queue, incoming) = sync_channel::<String>(4);
        let client = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default();

        let assistant = Arc::new(Self {
            app,
            library,
            semantic: Mutex::new(None),
            config: Mutex::new(Config::default()),
            last_call: Mutex::new(None),
            recent: Mutex::new(Vec::new()),
            reported_failure: AtomicBool::new(false),
            queue,
            client,
        });

        let weak = Arc::downgrade(&assistant);
        std::thread::Builder::new()
            .name("pulpitry-assist".into())
            .spawn(move || {
                while let Ok(context) = incoming.recv() {
                    let Some(assistant) = weak.upgrade() else { break };
                    assistant.handle(&context);
                }
            })
            .ok();

        assistant
    }

    /// Wires in the embedding index. Deferred because the index is built after
    /// the verse library, which is after this exists.
    pub fn attach_semantic(&self, semantic: Arc<Semantic>) {
        *self.semantic.lock() = Some(semantic);
    }

    /// Runs the model's restatement through the embedding index and emits
    /// whatever clears the operator's threshold.
    fn search_restatement(&self, restated: &str, context: &str) {
        // An empty restatement is the model saying the speaker is not on
        // scripture at all, which is a useful answer.
        if restated.split_whitespace().count() < 4 {
            return;
        }
        let Some(semantic) = self.semantic.lock().clone() else { return };

        match semantic.matches_for(restated, RESTATEMENT_MATCHES) {
            Ok(matches) => {
                for (verse, score) in matches {
                    if !semantic.claim(verse.id) {
                        continue;
                    }
                    semantic.emit_suggestion(verse, score, "allusion", restated, context);
                }
            }
            Err(err) => eprintln!("[assist] restatement search failed: {err:#}"),
        }
    }

    /// Applies the operator's settings, reading the key from the OS credential
    /// store. Called at startup and whenever settings are saved.
    pub fn configure(&self, settings: &Settings) {
        let key = crate::settings::load_assist_key().ok().flatten().unwrap_or_default();
        *self.config.lock() = Config {
            enabled: settings.assist_enabled,
            endpoint: settings.assist_endpoint.clone(),
            model: settings.assist_model.clone(),
            api_version: settings.assist_api_version.clone(),
            key,
            translation: settings.translation.clone(),
        };
        self.reported_failure.store(false, Ordering::SeqCst);
    }

    pub fn reset(&self) {
        self.recent.lock().clear();
        *self.last_call.lock() = None;
        self.reported_failure.store(false, Ordering::SeqCst);
    }

    /// Considers a stretch of speech for model review.
    ///
    /// `had_exact_match` suppresses the call: if verbatim detection already
    /// identified the passage, there is nothing for the model to add and no
    /// reason to spend a request on it.
    pub fn consider(&self, context: &str, had_exact_match: bool) {
        if had_exact_match {
            return;
        }
        if !self.config.lock().usable() {
            return;
        }
        if context.split_whitespace().count() < MIN_WORDS {
            return;
        }

        {
            let mut last = self.last_call.lock();
            if last.is_some_and(|when| when.elapsed() < MIN_CALL_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }

        let trimmed = last_words(context, CONTEXT_WORDS);
        let _ = self.queue.try_send(trimmed);
    }

    fn handle(&self, context: &str) {
        let config = self.config.lock().clone();
        if !config.usable() {
            return;
        }

        let reading = match ask(&self.client, &config, context) {
            Ok(reading) => {
                self.reported_failure.store(false, Ordering::SeqCst);
                reading
            }
            Err(err) => {
                // Losing the network mid-service must not produce a wall of
                // identical errors; say it once until something changes.
                if !self.reported_failure.swap(true, Ordering::SeqCst) {
                    eprintln!("[assist] {err:#}");
                }
                return;
            }
        };

        // Search the index with the model's restatement rather than the raw
        // transcript. A preacher's own words sit a long way from the verse in
        // embedding space; scriptural phrasing of the same idea sits close to
        // it, which is what recovers passages the transcript alone misses.
        self.search_restatement(&reading.restated, context);

        for proposal in reading.references {
            if proposal.confidence < MIN_CONFIDENCE {
                continue;
            }
            // The verification step: a reference the library cannot resolve is
            // discarded rather than shown.
            let Some(verse) = self.verify(&config.translation, &proposal.reference) else {
                eprintln!(
                    "[assist] discarded unresolvable reference {:?}",
                    proposal.reference
                );
                continue;
            };
            if self.was_recently_suggested(verse.id) {
                continue;
            }

            let suggestion = Suggestion {
                verse,
                source: SOURCE_MODEL.into(),
                kind: proposal.kind,
                confidence: proposal.confidence,
                reason: proposal.reason,
                context: context.to_string(),
                at: epoch_millis(),
            };
            let _ = self.app.emit(EVENT_SUGGESTION, &suggestion);
        }
    }

    /// Resolves a proposed reference to a real verse, or nothing.
    fn verify(&self, translation: &str, reference: &str) -> Option<Verse> {
        let resolved = self.library.resolve_reference(translation, reference).ok()??;
        // A chapter with no verse is too vague to stage; the operator can open
        // the chapter themselves.
        let verse = resolved.verse?;
        self.library
            .verse_at(translation, resolved.book_number, resolved.chapter, verse)
            .ok()?
    }

    fn was_recently_suggested(&self, verse_id: i64) -> bool {
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

fn request_body(config: &Config, context: &str) -> serde_json::Value {
    serde_json::json!({
        "model": config.model,
        // Deterministic: the same sermon should not produce different
        // references on different runs.
        "temperature": 0,
        "max_tokens": 400,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": format!("Transcript:\n{context}") },
        ],
    })
}

/// Chooses the TLS backend once, before anything can make a request.
///
/// Naming the provider is the price of not compiling aws-lc-rs, which drags a
/// C build chain onto every machine that builds this. Failure here means one
/// was already installed, which is equally fine.
fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn ask(
    client: &reqwest::blocking::Client,
    config: &Config,
    context: &str,
) -> Result<Reading> {
    {
        let url = endpoint_url(&config.endpoint, &config.api_version);
        let body = request_body(config, context);

        let response = client
            .post(&url)
            .header("api-key", &config.key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .context("could not reach the Azure AI Foundry endpoint")?;

        let status = response.status();
        let payload = response.text().unwrap_or_default();
        if !status.is_success() {
            bail!("Azure AI Foundry returned {status}: {}", payload.chars().take(300).collect::<String>());
        }

        let parsed: serde_json::Value =
            serde_json::from_str(&payload).context("the model response was not JSON")?;
        let content = parsed
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(|content| content.as_str())
            .unwrap_or_default();

        Ok(parse_reading(content))
    }
}

/// Azure AI Foundry's inference route, tolerating either the resource root or a
/// full path, with or without a trailing slash.
fn endpoint_url(endpoint: &str, api_version: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    let path = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };
    let version = if api_version.trim().is_empty() {
        crate::settings::DEFAULT_ASSIST_API_VERSION
    } else {
        api_version.trim()
    };
    format!("{path}?api-version={version}")
}

fn last_words(text: &str, count: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let start = words.len().saturating_sub(count);
    words[start..].join(" ")
}

/// Pulls proposals out of a model reply.
///
/// Models wrap JSON in prose or code fences however they like, and Foundry
/// hosts many model families with different habits, so this finds the outermost
/// JSON object rather than trusting the reply to be clean.
fn parse_reading(content: &str) -> Reading {
    let Some(json) = extract_json_object(content) else { return Reading::default() };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
        return Reading::default();
    };

    let restated = value
        .get("restated")
        .and_then(|text| text.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    let Some(entries) = value.get("references").and_then(|list| list.as_array()) else {
        return Reading { restated, references: Vec::new() };
    };

    let references = entries
        .iter()
        .filter_map(|entry| {
            let reference = entry.get("reference")?.as_str()?.trim().to_string();
            if reference.is_empty() {
                return None;
            }
            let kind = entry
                .get("kind")
                .and_then(|kind| kind.as_str())
                .filter(|kind| *kind == "quotation" || *kind == "allusion")
                .unwrap_or("allusion")
                .to_string();
            let confidence = entry
                .get("confidence")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0)
                .clamp(0.0, 1.0) as f32;
            let reason = entry
                .get("why")
                .and_then(|why| why.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();

            Some(Proposal { reference, kind, confidence, reason })
        })
        .take(3)
        .collect();

    Reading { restated, references }
}

/// The substring from the first `{` to its matching `}`, ignoring braces inside
/// strings.
fn extract_json_object(text: &str) -> Option<String> {
    let bytes: Vec<char> = text.chars().collect();
    let start = bytes.iter().position(|c| *c == '{')?;

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, character) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if *character == '\\' {
                escaped = true;
            } else if *character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(bytes[start..=index].iter().collect());
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tls_backend_is_installed_before_any_request() {
        // Without a provider, rustls refuses at the first HTTPS call — which
        // would be mid-service, not at build time. Naming it is the trade for
        // not compiling aws-lc-rs, so it has to actually happen.
        install_crypto_provider();
        assert!(
            rustls::crypto::CryptoProvider::get_default().is_some(),
            "no TLS backend installed; the model assist would fail on first use",
        );
    }

    use super::*;

    /// Most tests care only about the references half of a reply.
    fn parse_proposals(content: &str) -> Vec<Proposal> {
        parse_reading(content).references
    }

    #[test]
    fn builds_the_foundry_route_from_a_resource_root() {
        assert_eq!(
            endpoint_url("https://x.services.ai.azure.com/models", "2024-05-01-preview"),
            "https://x.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview"
        );
    }

    #[test]
    fn tolerates_a_trailing_slash_or_a_full_path() {
        let expected =
            "https://x.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview";
        assert_eq!(endpoint_url("https://x.services.ai.azure.com/models/", "2024-05-01-preview"), expected);
        assert_eq!(
            endpoint_url("https://x.services.ai.azure.com/models/chat/completions", "2024-05-01-preview"),
            expected
        );
    }

    #[test]
    fn falls_back_to_a_default_api_version() {
        assert!(endpoint_url("https://x/models", "  ")
            .ends_with(crate::settings::DEFAULT_ASSIST_API_VERSION));
    }

    #[test]
    fn a_reply_carries_both_a_restatement_and_references() {
        let reading = parse_reading(
            r#"{"restated":"Ask and it shall be given you; seek and ye shall find.",
                "references":[{"reference":"Matthew 7:7","kind":"allusion","confidence":0.8}]}"#,
        );
        assert!(reading.restated.starts_with("Ask and it shall be given"));
        assert_eq!(reading.references.len(), 1);
    }

    #[test]
    fn an_empty_restatement_is_a_valid_answer() {
        // The model saying "this is not about scripture" is useful, not a
        // failure, and must not be turned into a search.
        let reading = parse_reading(r#"{"restated":"","references":[]}"#);
        assert!(reading.restated.is_empty());
        assert!(reading.references.is_empty());
    }

    #[test]
    fn a_reply_with_only_a_restatement_still_parses() {
        let reading = parse_reading(r#"{"restated":"The LORD is my shepherd."}"#);
        assert_eq!(reading.restated, "The LORD is my shepherd.");
        assert!(reading.references.is_empty());
    }

    #[test]
    fn parses_a_clean_reply() {
        let proposals = parse_proposals(
            r#"{"references":[{"reference":"John 3:16","kind":"quotation","confidence":0.9,"why":"gave his only son"}]}"#,
        );
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].reference, "John 3:16");
        assert_eq!(proposals[0].kind, "quotation");
        assert!((proposals[0].confidence - 0.9).abs() < 1e-6);
    }

    #[test]
    fn parses_a_reply_wrapped_in_prose_and_fences() {
        let proposals = parse_proposals(
            "Sure! Here is the JSON you asked for:\n```json\n{\"references\": [\
             {\"reference\": \"Psalm 23:1\", \"kind\": \"allusion\", \"confidence\": 0.7, \
             \"why\": \"shepherd imagery\"}]}\n```\nHope that helps.",
        );
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].reference, "Psalm 23:1");
    }

    #[test]
    fn survives_braces_inside_strings() {
        let proposals = parse_proposals(
            r#"{"references":[{"reference":"John 1:1","kind":"quotation","confidence":1,"why":"a } brace"}]}"#,
        );
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].reason, "a } brace");
    }

    #[test]
    fn an_empty_list_is_a_valid_answer() {
        assert!(parse_proposals(r#"{"references":[]}"#).is_empty());
    }

    #[test]
    fn junk_replies_yield_nothing_rather_than_panicking() {
        assert!(parse_proposals("").is_empty());
        assert!(parse_proposals("I'm sorry, I can't help with that.").is_empty());
        assert!(parse_proposals("{ this is not json").is_empty());
        assert!(parse_proposals(r#"{"references":"John 3:16"}"#).is_empty());
        assert!(parse_proposals(r#"{"other":[1,2,3]}"#).is_empty());
    }

    #[test]
    fn caps_how_many_suggestions_one_reply_can_produce() {
        let many: Vec<String> = (1..=10)
            .map(|n| format!(r#"{{"reference":"John 3:{n}","kind":"allusion","confidence":0.9}}"#))
            .collect();
        let reply = format!(r#"{{"references":[{}]}}"#, many.join(","));
        assert_eq!(parse_proposals(&reply).len(), 3);
    }

    #[test]
    fn an_unknown_kind_falls_back_to_allusion() {
        let proposals = parse_proposals(
            r#"{"references":[{"reference":"John 3:16","kind":"prophecy","confidence":0.8}]}"#,
        );
        assert_eq!(proposals[0].kind, "allusion");
    }

    #[test]
    fn confidence_is_clamped() {
        let proposals = parse_proposals(
            r#"{"references":[{"reference":"John 3:16","confidence":9.5},{"reference":"John 3:17","confidence":-2}]}"#,
        );
        assert_eq!(proposals[0].confidence, 1.0);
        assert_eq!(proposals[1].confidence, 0.0);
    }

    #[test]
    fn context_is_trimmed_to_the_most_recent_words() {
        let text = (1..=100).map(|n| n.to_string()).collect::<Vec<_>>().join(" ");
        let trimmed = last_words(&text, 10);
        assert_eq!(trimmed, "91 92 93 94 95 96 97 98 99 100");
    }

    // ---------------------------------------------------------------------
    // The safety property: a model reference that does not exist in the
    // library must not survive verification.
    // ---------------------------------------------------------------------

    fn library() -> Library {
        let library = Library::in_memory().expect("library");
        library
            .seed(
                "KJV",
                &[
                    (43, "John", 3, 16, "For God so loved the world, that he gave his only begotten Son."),
                    (19, "Psalms", 23, 1, "The LORD is my shepherd; I shall not want."),
                ],
            )
            .expect("seed");
        library
    }

    /// Mirrors `Assistant::verify` without needing an app handle.
    fn verify(library: &Library, reference: &str) -> Option<Verse> {
        let resolved = library.resolve_reference("KJV", reference).ok()??;
        let verse = resolved.verse?;
        library
            .verse_at("KJV", resolved.book_number, resolved.chapter, verse)
            .ok()?
    }

    #[test]
    fn verification_returns_the_librarys_text_not_the_models() {
        let verse = verify(&library(), "John 3:16").expect("should resolve");
        assert_eq!(verse.book, "John");
        assert_eq!(verse.verse, 16);
        assert!(verse.text.starts_with("For God so loved"));
    }

    #[test]
    fn verification_rejects_a_book_that_does_not_exist() {
        assert!(verify(&library(), "Hezekiah 4:12").is_none());
    }

    #[test]
    fn verification_rejects_a_verse_outside_the_chapter() {
        // John 3 exists in the fixture, but not verse 999.
        assert!(verify(&library(), "John 3:999").is_none());
    }

    #[test]
    fn verification_rejects_a_chapter_only_reference() {
        // Too vague to stage; the operator can open the chapter themselves.
        assert!(verify(&library(), "John 3").is_none());
    }

    #[test]
    fn verification_accepts_a_range_at_its_starting_verse() {
        let verse = verify(&library(), "John 3:16-18").expect("should resolve");
        assert_eq!(verse.verse, 16);
    }

    // ---------------------------------------------------------------------
    // The request path, against a stub standing in for Azure AI Foundry.
    // ---------------------------------------------------------------------

    #[test]
    fn the_prompt_forbids_the_model_from_supplying_verse_text() {
        // The safety property is enforced by verification, but the prompt has
        // to ask for the right thing too.
        assert!(SYSTEM_PROMPT.contains("REFERENCES ONLY"));
        assert!(SYSTEM_PROMPT.contains("Never include verse text"));
    }

    #[test]
    fn the_request_body_is_deterministic_and_carries_the_transcript() {
        let config = Config { model: "gpt-4o-mini".into(), ..Config::default() };
        let body = request_body(&config, "he gave his only son");

        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert!(body["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("he gave his only son"));
    }

    /// Serves one canned reply and hands back what it was sent.
    fn stub_server(reply: &'static str, status: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();

        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut received = vec![0u8; 8192];
            let read = stream.read(&mut received).unwrap_or(0);
            let request = String::from_utf8_lossy(&received[..read]).to_string();

            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            request
        });

        (format!("http://127.0.0.1:{port}/models"), handle)
    }

    fn config_for(endpoint: &str) -> Config {
        Config {
            enabled: true,
            endpoint: endpoint.to_string(),
            model: "gpt-4o-mini".into(),
            api_version: "2024-05-01-preview".into(),
            key: "secret-key".into(),
            translation: "KJV".into(),
        }
    }

    /// A client with the TLS backend already chosen.
    ///
    /// `rustls-no-provider` means nothing installs one for us, so a client
    /// built without this panics on first use. The app installs it when the
    /// assistant starts; a test that builds its own client reaches a client
    /// sooner than that. It passed on macOS and Windows only because some
    /// other test happened to install the provider first, which is a race
    /// rather than a guarantee -- and on Linux it lost.
    fn client() -> reqwest::blocking::Client {
        install_crypto_provider();
        reqwest::blocking::Client::new()
    }

    #[test]
    fn sends_a_well_formed_foundry_request_and_reads_the_reply() {
        let reply = r#"{"choices":[{"message":{"content":"{\"references\":[{\"reference\":\"John 3:16\",\"kind\":\"allusion\",\"confidence\":0.86,\"why\":\"gave his only son\"}]}"}}]}"#;
        let (endpoint, server) = stub_server(reply, "200 OK");

        let client = client();
        let reading = ask(&client, &config_for(&endpoint), "God loved the world so much he gave his only son")
            .expect("request should succeed");
        let proposals = reading.references;

        let request = server.join().expect("server thread");

        // Route, auth and payload all have to be right for a real endpoint.
        assert!(
            request.starts_with("POST /models/chat/completions?api-version=2024-05-01-preview"),
            "unexpected request line: {}",
            request.lines().next().unwrap_or_default()
        );
        assert!(request.contains("api-key: secret-key"), "missing api-key header");
        assert!(request.contains("\"model\":\"gpt-4o-mini\""));
        assert!(request.contains("he gave his only son"));

        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].reference, "John 3:16");
        assert_eq!(proposals[0].kind, "allusion");
    }

    #[test]
    fn a_rejected_request_is_an_error_not_a_silent_empty_result() {
        let (endpoint, server) = stub_server(r#"{"error":"unauthorized"}"#, "401 Unauthorized");
        let client = client();

        let outcome = ask(&client, &config_for(&endpoint), "some speech to consider");
        let _ = server.join();

        let message = outcome.expect_err("401 should surface").to_string();
        assert!(message.contains("401"), "unhelpful error: {message}");
    }
}
