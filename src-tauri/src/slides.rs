//! Slides from a sermon.
//!
//! An operator is handed an outline on Sunday morning — sometimes typed,
//! sometimes a photograph of a notebook that has been retyped, sometimes three
//! headings and a verse. Turning that into slides is twenty minutes of work
//! nobody has, and it is why so many services have no slides at all.
//!
//! This asks a model to do the shaping and hands the result back as *drafts*.
//!
//! # Nothing is saved without somebody reading it
//!
//! The slides come back to the operator's window and are saved only when they
//! press Keep. A model writing directly into a church's slide library would be
//! the wrong shape twice over: it puts words nobody has read one gesture away
//! from a wall in front of a congregation, and it makes a mistake permanent
//! before anybody has seen it.
//!
//! This is the same rule the assistant already follows for scripture, where
//! every reference it proposes is looked up in the local library and discarded
//! if it does not resolve. It cannot invent a verse. It *can* write a sentence
//! nobody meant, so a person reads it first.
//!
//! # What it is asked for, and what it is not
//!
//! Headings and short lines — the shape of a slide. Not paragraphs, because a
//! congregation reads a wall at a glance and a slide of prose is a slide nobody
//! finishes. Not scripture text, because we already hold eleven translations and
//! a model quoting from memory is a model getting a verse subtly wrong. Where
//! the outline cites a passage, the reference is kept as a reference and the
//! operator can stage the real verse from the library beside it.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::settings::Settings;

/// How much of a service goes into one request.
///
/// This used to be a hard limit with `take` behind it: the first 4,000 words
/// were sent and the rest was dropped, silently, with neither the model nor the
/// operator told. A 27,633-word teaching session contributed its opening 14% --
/// and a service that begins with welcome and notices had its least
/// representative part turned into the slides for the whole of it.
///
/// Now it is a stretch size. The service is read in overlapping stretches, the
/// way [`crate::summarise`] reads it, and every part of it can produce slides.
const STRETCH_WORDS: usize = 4_000;

/// How much of the previous stretch each one repeats.
///
/// A point made across a boundary is otherwise halved: stated at the end of one
/// stretch and expounded at the start of the next, with neither able to make a
/// slide of it.
const STRETCH_OVERLAP: usize = 200;

/// The most slides worth making from one sermon.
///
/// A ceiling rather than a target. Twenty is already more than most services
/// use, and a model asked for "as many as you like" produces one per sentence.
const MAX_SLIDES: usize = 20;

/// One slide, before anybody has approved it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSlide {
    pub title: String,
    /// Short lines. Not a paragraph — see the module note.
    pub lines: Vec<String>,
    /// A passage the outline referred to, as a reference and never as text.
    /// The operator stages the real verse from the library.
    #[serde(default)]
    pub reference: String,
    /// The words in the transcript this slide was drawn from, quoted exactly.
    ///
    /// Checked against the transcript, not trusted: a slide whose anchor is not
    /// in what was actually said is dropped before anybody sees it. The prompt
    /// has always forbidden invention and mostly been obeyed, but "mostly" is
    /// not a property a church can rely on at nine on a Sunday -- and a model
    /// that has invented a point cannot produce the sentence it came from, so
    /// this catches exactly the case the instruction misses.
    ///
    /// Shown beneath the slide when the operator reviews it, which is the other
    /// half of its job: approving a slide stops being an act of faith.
    #[serde(default)]
    pub anchor: String,
    /// A comparison the preacher drew, where they drew one.
    ///
    /// Often the literal shape of an argument — "under the law" beside "under
    /// grace" — and the thing a slide of centred lines could never show. Every
    /// cell is held to the same rule as the rest of the slide: it is in the
    /// anchor's stretch of transcript or the slide does not survive.
    #[serde(default)]
    pub table: Option<SlideTable>,
}

/// A comparison, as rows under headings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideTable {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

pub fn generate(settings: &Settings, key: &str, sermon: &str) -> Result<Vec<DraftSlide>> {
    let words = sermon.split_whitespace().count();
    if words < 20 {
        bail!("There is not enough here to make slides from yet.");
    }

    // Before the client is built. rustls picks its provider at construction and
    // installing one afterwards panics on a background thread -- the same trap
    // the summariser documents, and the same fix.

    let client = castavox_core::tls::client()
        /*
         * Long, because the far end is allowed to be.
         *
         * The broker waits 280 seconds for a reasoning model, and a client that
         * gives up at 120 turns a slow answer into a failure while the work
         * carries on being paid for. Whichever timeout is shorter is the one
         * that decides, so this has to be the longer of the two.
         */
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .context("could not prepare the request")?;

    let hosted = settings.speech_engine == "hosted";
    let deployment = castavox_core::assistant::Deployment {
        endpoint: settings.assist_endpoint.clone(),
        model: settings.assist_model.clone(),
        api_version: settings.assist_api_version.clone(),
    };
    let base;
    let route = if hosted {
        base = crate::hosted::broker_base();
        castavox_core::assistant::Route::Hosted { base: &base, device_token: key }
    } else {
        castavox_core::assistant::Route::Own { deployment: &deployment, key }
    };

    /*
     * Every part of the service, in stretches, rather than the opening of it.
     *
     * One request per stretch: a model given four hours at once returns twenty
     * slides about the first twenty minutes, because that is where it started
     * reading. Asking about each stretch in turn is what makes the back half of
     * a service capable of producing a slide at all.
     */
    let stretches =
        castavox_core::assistant::chunks(sermon, STRETCH_WORDS, STRETCH_OVERLAP);
    let mut drafts: Vec<DraftSlide> = Vec::new();

    let mut refused = 0usize;
    for (index, stretch) in stretches.iter().enumerate() {
        crate::log_line!("[slides] stretch {} of {}", index + 1, stretches.len());
        let content = match castavox_core::assistant::complete(
            &client,
            &route,
            body(settings, stretch, index + 1, stretches.len()),
            true,
        ) {
            Ok(content) => content,
            /*
             * One part refused is not the service lost.
             *
             * The filter objects to reproduced scripture, and an anchor is
             * transcript quoted exactly -- so a stretch where the preacher read
             * a passage aloud is the likeliest thing in a service to be
             * blocked. Seven stretches once produced slides and every one of
             * them was thrown away because the eighth was refused, which serves
             * nobody: that stretch contributes nothing and the rest still do.
             */
            Err(failure) if refused_by_filter(&failure) => {
                crate::log_line!(
                    "[slides] stretch {} of {} was refused",
                    index + 1,
                    stretches.len()
                );
                refused += 1;
                continue;
            }
            Err(failure) => return Err(advise(&failure, hosted)),
        };

        if content.trim().is_empty() {
            continue;
        }
        drafts.extend(read(&content)?);
    }

    if refused > 0 {
        crate::log_line!("[slides] {refused} of {} stretches were refused", stretches.len());
    }

    if drafts.is_empty() {
        bail!("The model returned nothing to read. Try again in a moment.");
    }

    let asked = drafts.len();
    let kept = keep_what_was_said(drafts, sermon);
    crate::log_line!("[slides] {} of {asked} slides were in the transcript", kept.len());

    if kept.is_empty() {
        bail!(
            "None of the slides the model produced could be found in what was actually said, so none were kept. Try again, or make the slides by hand from the transcript."
        );
    }
    Ok(kept.into_iter().take(MAX_SLIDES).collect())
}

/// Whether the model's safety filter objected.
///
/// Its own copy rather than the summariser's, because the two modules do not
/// share an `advise` and importing one into the other for a three-line matcher
/// would tie them together for no benefit.
fn refused_by_filter(failure: &castavox_core::assistant::Failure) -> bool {
    matches!(
        failure,
        castavox_core::assistant::Failure::Refused { payload, .. }
            if castavox_core::assistant::is_filtered_refusal(payload)
    )
}

/// Drops every slide whose anchor is not in the transcript.
///
/// The whole of the fidelity guarantee, and deliberately mechanical: the model
/// is asked for the sentence a slide came from, and this looks for it. A slide
/// built out of something the preacher never said has no such sentence to give,
/// so it fails here rather than on the wall.
///
/// Normalised on both sides before comparing -- case folded and whitespace
/// collapsed -- because a model quoting accurately will still reflow the line
/// breaks and capitalise a fragment it starts mid-sentence.
fn keep_what_was_said(drafts: Vec<DraftSlide>, transcript: &str) -> Vec<DraftSlide> {
    let haystack = flatten(transcript);
    let mut seen: Vec<String> = Vec::new();

    drafts
        .into_iter()
        .filter(|slide| {
            let anchor = flatten(&slide.anchor);
            // Short anchors match by accident: "and he said" is in every
            // service ever preached and proves nothing about this slide.
            if anchor.split(' ').count() < 4 {
                crate::log_line!("[slides] dropped, anchor too short: {}", slide.title);
                return false;
            }
            if !was_really_said(&haystack, &anchor) {
                // The anchor, not just the title. Whether a rejected slide was
                // invented or merely quoted loosely is the difference between
                // this check working and this check throwing away good slides,
                // and the title alone cannot tell them apart.
                crate::log_line!(
                    "[slides] dropped, not in the transcript: {} — anchored to “{}”",
                    slide.title,
                    slide.anchor.chars().take(90).collect::<String>()
                );
                return false;
            }
            true
        })
        // Stretches overlap, so the same point can be drawn twice -- once by
        // the stretch that ended in it and once by the stretch that began there.
        .filter(|slide| {
            let key = flatten(&slide.title);
            // Nothing to compare: a slide can be all lines and no title, and
            // two of those are not duplicates of each other.
            if key.is_empty() {
                return true;
            }
            if seen.contains(&key) {
                return false;
            }
            seen.push(key);
            true
        })
        .collect()
}

/// How many of the anchor's words must appear together, exactly, in the service.
///
/// A whole-anchor match is too strict for an honest quote. A model quoting from
/// memory changes a word, shifts a tense, drops "and" -- "he started using it
/// more frequently" against "he started to use it more frequently" is the same
/// sentence remembered slightly wrong, and requiring every word rejected it.
/// Twenty-two per cent of slides were being dropped, most of them real.
///
/// Six consecutive words is a run nobody produces by accident. A model that has
/// invented a point cannot put six of the service's words in the service's
/// order, because it has never seen them; a model quoting loosely will still
/// get six right somewhere in a fifteen-word anchor.
const RUN: usize = 6;

/// Whether any long-enough run of the anchor is really in the transcript.
fn was_really_said(haystack: &str, anchor: &str) -> bool {
    let words: Vec<&str> = anchor.split(' ').filter(|w| !w.is_empty()).collect();
    if words.len() < RUN {
        // Shorter than a run, so it has to match whole -- and the caller has
        // already refused anything under four words as meaningless.
        return haystack.contains(anchor);
    }
    words
        .windows(RUN)
        .any(|window| haystack.contains(&window.join(" ")))
}

/// The words alone, for comparing what was said with what a model says was said.
///
/// Case, whitespace *and punctuation* all go. The first two were obvious; the
/// third was not, and it was rejecting honest slides. A transcript comes from
/// speech recognition and is full of commas the model does not reproduce when
/// it quotes — "still far off, when his father saw him" against "still far off
/// when his father saw him" is the same sentence and failed an exact match.
///
/// What remains is the words in the order they were said, which is the thing
/// actually being checked. A model that invents a point still cannot produce
/// its words in the right order, so nothing is given away by this.
fn flatten(text: &str) -> String {
    text.split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|c| c.is_alphanumeric() || *c == '\'')
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn body(settings: &Settings, sermon: &str, part: usize, of: usize) -> serde_json::Value {
    serde_json::json!({
        "model": settings.assist_model.trim(),
        // Low. Slides are somebody else's sermon, and invention is the failure
        // mode -- a heading that sounds better than what they said is still not
        // what they said.
        "temperature": 0.2,
        // Raised from 1,600: every slide now carries the run of transcript it
        // came from, quoted in full, and a terse-slide budget cut the reply off
        // mid-anchor -- which arrives as a JSON parse failure rather than as the
        // length problem it is.
        "max_tokens": 4000,
        /*
         * The shape as a contract rather than a request.
         *
         * Six rewordings of the prose failed to produce one table, and a
         * seventh produced slides with the lines emptied and no table put in
         * their place. Every one of those was the model declining to follow a
         * rule it was merely told. A schema is not a rule it can decline: a
         * required field is present or the reply is rejected before it reaches
         * us.
         *
         * `additionalProperties: false` and every field required, which is what
         * strict mode demands -- optionality is expressed by allowing null, not
         * by leaving a field out.
         *
         * A deployment that cannot take a schema is refused, and
         * `castavox_core::assistant::complete` asks again without one; the
         * prose below still says everything the schema does.
         */
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "slides",
                "strict": true,
                "schema": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["slides"],
                    "properties": {
                        "slides": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["title", "lines", "reference", "anchor", "table"],
                                "properties": {
                                    "title": { "type": "string" },
                                    "lines": { "type": "array", "items": { "type": "string" } },
                                    "reference": { "type": "string" },
                                    "anchor": { "type": "string" },
                                    "table": {
                                        "type": ["object", "null"],
                                        "additionalProperties": false,
                                        "required": ["header", "rows"],
                                        "properties": {
                                            "header": {
                                                "type": "array",
                                                "items": { "type": "string" }
                                            },
                                            "rows": {
                                                "type": "array",
                                                "items": {
                                                    "type": "array",
                                                    "items": { "type": "string" }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        "messages": [
            {
                "role": "system",
                "content":
                    "You turn a preacher's sermon or outline into slides for a church screen. \
                     Return JSON: {\"slides\":[{\"title\":\"…\",\"lines\":[\"…\"],\"reference\":\"…\",\
                     \"anchor\":\"…\",\"table\":{\"header\":[\"…\",\"…\"],\"rows\":[[\"…\",\"…\"]]}}]}. \
                     \
                     Two kinds of slide, and you should be producing both. A slide of LINES, \
                     and a slide of a TABLE where the preacher compared two things. Both are \
                     described below. \
                     \
                     EVERY slide must carry one or the other. A slide with lines has \
                     `\"table\":null`; a slide with a table has `\"lines\":[]`. A slide with \
                     neither is a heading with nothing underneath it, and is thrown away — so \
                     if you empty the lines, you must supply the table. \
                     \
                     ANCHOR, and this one is checked: six to fifteen words from the \
                     transcript that this slide came from, copied exactly as they appear. \
                     Enough to find again and no more -- it is a bookmark, not a quotation, \
                     and a long one is no better than a short one. Do not paraphrase it, do \
                     not tidy it, do not join two distant sentences into one: copy a run of \
                     words that is actually there. \
                     \
                     The anchor must be the PREACHER'S OWN WORDS, never the words of a \
                     passage. Quoting scripture you remember is the commonest way this goes \
                     wrong: 'let us not forsake the assembling of ourselves together' is \
                     Hebrews, not this service, and a slide anchored to it is thrown away \
                     even though the preacher really did teach on it. Anchor to what they \
                     said ABOUT the passage — their explanation, their application, the \
                     sentence where they introduced it. If the only words you can quote are \
                     the passage itself, that slide should not exist. \
                     \
                     What a good church slide is, and this matters more than being thorough: \
                     it is read at a glance, from the back, by somebody listening to a person \
                     rather than reading a page. So it carries a few words, not a summary. \
                     \
                     TITLE: at most seven words. Title Case. No trailing punctuation. It is \
                     a signpost, not the point itself — 'The Father Runs To Meet Him'. \
                     \
                     LINES: at most three. Each one must make complete sense on its own, \
                     read by somebody who has just looked up and does not know what came \
                     before it. A whole thought, not a fragment: 'The father ran while his \
                     son was still far off' — not 'Still far off'. Write it as a sentence \
                     where it is one, and punctuate it properly. Up to about fifteen words; \
                     if the thought genuinely needs more, use two lines rather than cutting \
                     it in half. \
                     \
                     TABLE. Preachers compare things constantly — 'under the law' against \
                     'under grace', before and after, what was promised against what was \
                     given, what the world says against what scripture says — and a \
                     comparison is the shape of the argument, not a decoration on it. \
                     Wherever the material in front of you sets two things against each \
                     other, make that slide a table: \
                     {\"header\":[\"Under the Law\",\"Under Grace\"],\"rows\":[[\"Bondage\",\"Freedom\"]]} \
                     with `lines` left empty. Two or three columns, up to five rows, a few \
                     words in each cell. \
                     \
                     The one caution: the comparison has to be one the preacher actually \
                     drew. Do not turn a plain list of points into a table to have one. \
                     \
                     No numbering, no bullet characters, no 'Point 1' or '2.' — the slide is \
                     the numbering. Do not compress a sentence into a headline: 'Grace we \
                     did not earn' is three words that mean nothing on their own, and the \
                     congregation is reading this without the preacher's paragraph around \
                     it. Fewer, fuller lines beat more, terser ones. \
                     \
                     Use the preacher's own words and order wherever you can. Do not add \
                     points they did not make, and do not improve their theology. \
                     \
                     Never write out scripture text. If a passage is cited, put the reference \
                     in `reference` — 'Luke 15:20', nothing else — and leave it out of `lines`; \
                     the application holds the translations and shows the real verse. \
                     \
                     Prefer fewer slides: one idea each, in the order they were preached. \
                     Skip notices, greetings and housekeeping. Return an empty list rather \
                     than inventing content if there is nothing worth putting on a wall. \
                     \
                     You are given one consecutive part of a longer service. Make slides for \
                     what is in front of you and nothing else: no opening slide for the service \
                     as a whole unless this part opens it, no closing one unless it closes it, \
                     and no summary of material you have not been shown."
            },
            {
                "role": "user",
                "content": format!("Part {part} of {of} of one service.\n\n{sermon}"),
            }
        ]
    })
}

fn advise(failure: &castavox_core::assistant::Failure, hosted: bool) -> anyhow::Error {
    use castavox_core::assistant::Failure;

    crate::log_line!("[slides] {failure}");

    // The same shape as the summariser's advice, and for the same reason: a
    // church on a subscription has no key and no endpoint, and being told to
    // check them sends them looking for a second thing to buy.
    match failure {
        Failure::Unreachable(_) => anyhow!(
            "Could not reach the model. Check the connection and try again — nothing else in \
             Pulpitry needs it."
        ),
        Failure::Refused { status, .. } if *status == 401 || *status == 403 => {
            if hosted {
                anyhow!("Your Castavox subscription would not answer. Check it under Settings.")
            } else {
                anyhow!("The model key was refused. Check it under Settings.")
            }
        }
        Failure::Refused { status, .. } if *status == 429 => {
            anyhow!("The model is busy. Try again in a moment.")
        }
        _ => anyhow!("The model could not make slides from this. Try again in a moment."),
    }
}

/// Strips the marks a model leaves on a line that a slide should not carry.
///
/// Numbering, bullets, wrapping quotes and a trailing full stop. Each is
/// harmless in prose and wrong on a wall: "2. Social Media Content — the…"
/// projected behind a preacher reads as a document somebody forgot to format,
/// and the numbering is doing a job the sequence of slides already does.
fn tidy(line: &str) -> String {
    let mut text = line.trim();

    // "1.", "2)", "-", "*", "•", "–" at the start, in any combination, because
    // a model asked not to number things will sometimes number them anyway.
    loop {
        let before = text;
        text = text.trim_start();
        text = text.trim_start_matches(['-', '*', '•', '–', '—']);
        let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            let rest = &text[digits.len()..];
            if let Some(after) = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')')) {
                text = after;
            }
        }
        if text == before {
            break;
        }
    }

    let text = text.trim().trim_matches('"').trim_matches('\'').trim();
    /*
     * The full stop stays now, where once it was stripped.
     *
     * Lines used to be fragments -- 'Grace we did not earn' -- and a stop on the
     * end of a fragment looks like a mistake. They are whole thoughts now, read
     * by somebody who has just looked up, and a sentence without its stop looks
     * like a sentence that was cut off.
     */

    // Whitespace a model put in for a page, collapsed for a screen.
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A table worth drawing, or none at all.
///
/// A model asked for a comparison will sometimes return the shape of one with
/// nothing in it, or a single column, or twelve rows of a list it has decided
/// is a table. None of those are comparisons, and a half-built table on a wall
/// is worse than the lines it replaced.
fn usable_table(table: SlideTable) -> Option<SlideTable> {
    let header: Vec<String> = table.header.iter().map(|cell| tidy(cell)).collect();
    let rows: Vec<Vec<String>> = table
        .rows
        .into_iter()
        .map(|row| row.iter().map(|cell| tidy(cell)).collect::<Vec<_>>())
        // Ragged rows are a parse gone wrong, not a comparison.
        .filter(|row: &Vec<String>| row.len() == header.len())
        .filter(|row| row.iter().any(|cell| !cell.is_empty()))
        .take(5)
        .collect();

    // Two columns is the least that can compare anything; one is a list.
    if header.len() < 2 || rows.is_empty() {
        return None;
    }
    Some(SlideTable { header, rows })
}

fn read(content: &str) -> Result<Vec<DraftSlide>> {
    let text = content.trim();
    // Fenced blocks, despite being asked for bare JSON. Models do this.
    let text = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .map(|rest| rest.trim_start())
        .and_then(|rest| rest.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(text);

    /*
     * Read slide by slide, so one bad field costs one slide.
     *
     * Deserialising straight into `Vec<DraftSlide>` meant a single malformed
     * value anywhere in the reply — a table returned as columns-and-data rather
     * than header-and-rows, say — rejected the whole thing, and a stretch that
     * had produced nine good slides produced none. The strictness was mine, and
     * it cost far more than the field it was protecting.
     *
     * `table` is read separately for the same reason: a comparison in a shape
     * this does not recognise loses the comparison, not the slide it was on.
     */
    /*
     * Every field optional *and* nullable, which are not the same thing.
     *
     * `#[serde(default)]` covers a field that is absent. It does nothing for a
     * field that is present and null — and a model told to leave `lines` empty
     * writes `"lines": null`, which is the honest reading of the instruction.
     * Forty-nine slides were rejected in one run for this, and because the
     * instruction to leave lines empty is the one attached to tables, the
     * slides being thrown away were exactly the ones carrying a comparison.
     * The feature looked as though the model would not produce tables. It was
     * producing them and this was deleting them.
     */
    #[derive(Deserialize)]
    struct RawSlide {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        lines: Option<Vec<String>>,
        #[serde(default)]
        reference: Option<String>,
        #[serde(default)]
        anchor: Option<String>,
        #[serde(default)]
        table: Option<serde_json::Value>,
    }

    #[derive(Deserialize)]
    struct Reply {
        #[serde(default)]
        slides: Vec<serde_json::Value>,
    }

    let reply: Reply = serde_json::from_str(text).map_err(|error| {
        // The reply itself, where it can be read. Guessing at the shape of a
        // thing nobody kept a copy of is how an afternoon goes.
        crate::log_line!(
            "[slides] the reply would not parse ({error}): {}",
            text.chars().take(400).collect::<String>()
        );
        anyhow!("the model's reply was not the shape asked for")
    })?;

    let slides: Vec<RawSlide> = reply
        .slides
        .into_iter()
        .filter_map(|value| match serde_json::from_value::<RawSlide>(value) {
            Ok(slide) => Some(slide),
            Err(error) => {
                crate::log_line!("[slides] a slide could not be read and was skipped: {error}");
                None
            }
        })
        .collect();

    // Tidied here rather than trusted. Asked for three short phrases, a model
    // will return five numbered sentences often enough that cleaning them is
    // part of the feature rather than a workaround -- and the artefacts are
    // always the same few, so they are cheap to remove.
    let slides: Vec<DraftSlide> = slides
        .into_iter()
        .map(|slide| DraftSlide {
            title: tidy(&slide.title.unwrap_or_default()),
            lines: slide
                .lines
                .unwrap_or_default()
                .iter()
                .map(|line| tidy(line))
                .filter(|line| !line.is_empty())
                .take(3)
                .collect(),
            reference: slide
                .reference
                .unwrap_or_default()
                .trim()
                .trim_end_matches('.')
                .to_string(),
            // Not tidied. Every other field is cleaned up for a screen; this one
            // is quoted evidence, and cleaning it would stop it matching the
            // transcript it is meant to be found in.
            anchor: slide.anchor.unwrap_or_default(),
            // A comparison in a shape we do not know loses the comparison, and
            // the slide keeps its lines.
            table: {
                let offered = slide.table.as_ref().is_some_and(|value| !value.is_null());
                let table = slide
                    .table
                    .and_then(|value| serde_json::from_value::<SlideTable>(value).ok())
                    .and_then(usable_table);
                if offered && table.is_none() {
                    crate::log_line!("[slides] a table was offered and was not usable");
                }
                table
            },
        })
        /*
         * A title on its own is not a slide.
         *
         * It became possible to produce one by telling the model to leave
         * `lines` empty where a slide has a table: it emptied the lines and
         * then did not produce the table, and what reached the wall was a
         * heading with nothing under it. Whatever the instructions say, a slide
         * that carries neither lines nor a comparison has nothing on it.
         */
        .filter(|slide| !slide.lines.is_empty() || slide.table.is_some())
        .take(MAX_SLIDES)
        .collect();

    Ok(slides)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slide(title: &str, anchor: &str) -> DraftSlide {
        DraftSlide {
            title: title.into(),
            lines: vec![],
            reference: String::new(),
            anchor: anchor.into(),
            table: None,
        }
    }

    const SAID: &str = "He was still a long way off when his father saw him and was moved \
                        with compassion, and ran to him. The son had prepared a speech and \
                        never finished it.";

    fn table(header: &[&str], rows: &[&[&str]]) -> SlideTable {
        SlideTable {
            header: header.iter().map(|c| c.to_string()).collect(),
            rows: rows.iter().map(|r| r.iter().map(|c| c.to_string()).collect()).collect(),
        }
    }

    #[test]
    fn a_table_in_a_shape_we_do_not_know_costs_the_table_and_not_the_slide() {
        // Asked for header-and-rows, given columns-and-data. Strict parsing
        // rejected the whole reply for this and a stretch that had produced
        // nine good slides produced none.
        let got = read(
            r#"{"slides":[{"title":"Two Ways","lines":["He set them side by side"],
                "anchor":"he set the two of them side by side","table":{"columns":["a"],"data":[]}}]}"#,
        )
        .unwrap();

        assert_eq!(got.len(), 1, "the slide was lost with its table");
        assert!(got[0].table.is_none());
        assert_eq!(got[0].lines, vec!["He set them side by side".to_string()]);
    }

    #[test]
    fn one_unreadable_slide_does_not_take_the_others() {
        let got = read(
            r#"{"slides":[{"title":"Good","lines":["a line"],"anchor":"x"},
                          "not a slide at all",
                          {"title":"Also Good","lines":["another"],"anchor":"y"}]}"#,
        )
        .unwrap();

        assert_eq!(got.len(), 2, "a stray value in the list cost the good slides");
    }

    #[test]
    fn a_comparison_survives_and_is_tidied() {
        let got = usable_table(table(
            &["Under the Law", "Under Grace"],
            &[&["- bondage", "1. freedom"]],
        ))
        .expect("a two-column comparison was refused");

        assert_eq!(got.rows[0], vec!["bondage".to_string(), "freedom".to_string()]);
    }

    #[test]
    fn one_column_is_a_list_and_not_a_table() {
        assert!(usable_table(table(&["Points"], &[&["first"], &["second"]])).is_none());
    }

    #[test]
    fn a_table_with_no_rows_is_no_table() {
        assert!(usable_table(table(&["Before", "After"], &[])).is_none());
    }

    #[test]
    fn a_ragged_row_is_dropped_rather_than_drawn_half_built() {
        // A row short of a cell is a parse gone wrong, and a table missing a
        // cell on a wall is worse than the lines it replaced.
        let got = usable_table(table(
            &["Before", "After"],
            &[&["dark", "light"], &["only one"]],
        ))
        .unwrap();
        assert_eq!(got.rows.len(), 1, "the ragged row was drawn anyway");
    }

    #[test]
    fn a_slide_the_preacher_did_not_say_is_dropped() {
        let kept = keep_what_was_said(
            vec![
                slide("The Father Runs", "his father saw him and was moved with compassion"),
                slide("Tithing Unlocks Blessing", "the tithe unlocks the windows of heaven"),
            ],
            SAID,
        );

        assert_eq!(kept.len(), 1, "the invented slide survived");
        assert_eq!(kept[0].title, "The Father Runs");
    }

    #[test]
    fn an_anchor_matches_across_reflowed_lines_and_case() {
        // A model quoting accurately still reflows and re-capitalises.
        let kept = keep_what_was_said(
            vec![slide("Still Far Off", "He Was Still\n  a Long Way   OFF")],
            SAID,
        );
        assert_eq!(kept.len(), 1, "an honest quote was rejected for its whitespace");
    }

    #[test]
    fn punctuation_does_not_decide_whether_a_quote_is_honest() {
        // A transcript is speech recognition output and is full of commas the
        // model will not reproduce. The words are the thing being checked.
        let kept = keep_what_was_said(
            vec![slide("Still Far Off", "still a long way off when his father saw him")],
            "He was still a long way off, when his father saw him — and was moved.",
        );
        assert_eq!(kept.len(), 1, "an honest quote was rejected over a comma");
    }

    #[test]
    fn a_quote_remembered_slightly_wrong_still_counts() {
        // "started using it" against "started to use it": the same sentence,
        // recalled imperfectly. Requiring every word dropped a fifth of the
        // slides, most of them real.
        let kept = keep_what_was_said(
            vec![slide(
                "From That Day",
                "from that day going forward he started using it more frequently",
            )],
            "and from that day going forward he started to use it more frequently in his \
             preaching",
        );
        assert_eq!(kept.len(), 1, "an honest quote was rejected over one word");
    }

    #[test]
    fn an_invention_cannot_borrow_six_words_it_never_heard() {
        let kept = keep_what_was_said(
            vec![slide(
                "Tithing Unlocks Blessing",
                "the tithe unlocks the windows of heaven over your finances",
            )],
            SAID,
        );
        assert!(kept.is_empty(), "an invented anchor passed the run check");
    }

    #[test]
    fn an_anchor_too_short_to_mean_anything_is_refused() {
        // "and ran" appears here and in every service ever preached.
        let kept = keep_what_was_said(vec![slide("Running", "and ran")], SAID);
        assert!(kept.is_empty(), "a three-word anchor proved nothing and was accepted");
    }

    #[test]
    fn a_slide_with_no_anchor_at_all_is_refused() {
        let kept = keep_what_was_said(vec![slide("From Nowhere", "")], SAID);
        assert!(kept.is_empty());
    }

    #[test]
    fn the_same_point_drawn_from_two_stretches_is_kept_once() {
        // Stretches overlap, so the boundary material is read twice.
        let kept = keep_what_was_said(
            vec![
                slide("The Father Runs", "his father saw him and was moved with compassion"),
                slide("the father runs", "and ran to him. The son had prepared a speech"),
            ],
            SAID,
        );
        assert_eq!(kept.len(), 1, "the overlap produced the same slide twice");
    }

    #[test]
    fn reads_a_plain_reply() {
        let got = read(
            r#"{"slides":[{"title":"Coming Home","lines":["He was still a long way off"],"reference":"Luke 15:20"}]}"#,
        )
        .unwrap();

        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "Coming Home");
        assert_eq!(got[0].reference, "Luke 15:20");
    }

    #[test]
    fn reads_a_reply_wrapped_in_a_code_fence() {
        // Asked for bare JSON and given a fenced block anyway, which models do.
        let got = read("```json\n{\"slides\":[{\"title\":\"One\",\"lines\":[\"a\"]}]}\n```").unwrap();
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn keeps_a_slide_readable_from_the_back_of_a_hall() {
        // Asked for at most three lines and given eight. A slide nobody can
        // read is worse than no slide, so the extra are dropped here rather
        // than reaching a wall.
        let many: Vec<String> = (1..=8).map(|n| format!("\"line {n}\"")).collect();
        let got = read(&format!(
            r#"{{"slides":[{{"title":"Long","lines":[{}]}}]}}"#,
            many.join(",")
        ))
        .unwrap();

        assert_eq!(got[0].lines.len(), 3);
    }

    #[test]
    fn strips_the_marks_that_belong_on_a_page_and_not_on_a_wall() {
        /*
         * The output that prompted this. A model told not to number things
         * numbers them anyway, and "2. Social Media Content — the…" projected
         * behind a preacher reads as a document somebody forgot to format.
         *
         * The numbering is also doing a job the sequence of slides already
         * does, which is why it is removed rather than tolerated.
         */
        assert_eq!(tidy("2. Social Media Content"), "Social Media Content");
        assert_eq!(tidy("1) The Father Runs"), "The Father Runs");
        assert_eq!(tidy("- Grace we did not earn"), "Grace we did not earn");
        assert_eq!(tidy("• A far country"), "A far country");
        assert_eq!(tidy("  \"He was still far off\"  "), "He was still far off");
    }

    #[test]
    fn keeps_the_punctuation_a_whole_thought_needs() {
        // Lines were fragments once, and a full stop on a fragment looks like a
        // mistake. They are whole thoughts now, read by somebody who has just
        // looked up -- and a sentence without its stop looks cut off.
        assert_eq!(tidy("He was still a long way off."), "He was still a long way off.");
        assert_eq!(tidy("Who is my neighbour?"), "Who is my neighbour?");
        assert_eq!(tidy("But while he was still far off.."), "But while he was still far off..");
    }

    #[test]
    fn collapses_whitespace_meant_for_a_page() {
        assert_eq!(tidy("Grace   we  did\n not earn"), "Grace we did not earn");
    }

    #[test]
    fn asks_for_a_slide_rather_than_a_summary() {
        // The prompt is the feature here. If these instructions go, the output
        // goes back to paragraphs chopped into lines at one end, or to headline
        // fragments nobody can read cold at the other.
        let prompt = body(&Settings::default(), "a sermon", 1, 1).to_string();
        assert!(prompt.contains("at most seven words"), "the title has no ceiling");
        assert!(prompt.contains("complete sense on its own"), "lines may be fragments again");
        assert!(prompt.contains("no bullet characters"), "bullets and numbering are allowed again");
        assert!(prompt.contains("read at a glance"));
    }

    #[test]
    fn asks_for_the_anchor_it_intends_to_check() {
        // The check in keep_what_was_said is worth nothing if the reply carries
        // no anchor to check, and the two are written a long way apart.
        let prompt = body(&Settings::default(), "a sermon", 2, 5).to_string();
        assert!(prompt.contains("anchor"), "the reply will have nothing to verify");
        assert!(prompt.contains("copied exactly"), "a paraphrased anchor never matches");
        // Long anchors reproduce whole passages, which is what the copyright
        // filter blocks -- and a blocked stretch contributes no slides at all.
        assert!(prompt.contains("six to fifteen words"), "the anchor has no ceiling");
        // Anchoring to remembered scripture is the commonest way an honest
        // slide gets thrown away, and the rule against it is easily lost when
        // this prompt is edited.
        assert!(prompt.contains("PREACHER'S OWN WORDS"), "scripture may be anchored to again");
        /*
         * The skeleton has to show a table, not a null.
         *
         * It said `"table":null`, which is the first thing the model reads, and
         * the case for tables was made five hundred words later. Not one table
         * was produced in any run. A worked example contradicted by the schema
         * above it is not an instruction, it is a suggestion the model is right
         * to ignore.
         */
        assert!(
            prompt.contains(r#"\"table\":{\"header\""#),
            "the schema shows no table, so none will be produced"
        );
        assert!(prompt.contains("Part 2 of 5"), "the model was not told which part it has");
    }

    #[test]
    fn a_heading_with_nothing_under_it_is_not_a_slide() {
        // Produced by telling the model to empty `lines` for a table slide and
        // getting the emptying without the table. It reached the wall as a
        // title over blank space.
        let got = read(
            r#"{"slides":[{"title":"Activity vs Progress","lines":[],"anchor":"a","table":null},
                          {"title":"Real","lines":["something was said"],"anchor":"b"}]}"#,
        )
        .unwrap();

        assert_eq!(got.len(), 1, "an empty slide survived");
        assert_eq!(got[0].title, "Real");
    }

    #[test]
    fn drops_a_slide_with_nothing_on_it() {
        let got = read(r#"{"slides":[{"title":"","lines":[]},{"title":"Real","lines":["a"]}]}"#)
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "Real");
    }

    #[test]
    fn an_empty_list_is_an_answer_rather_than_a_failure() {
        // The model was told to return nothing rather than invent content, and
        // it doing so is not an error -- it is the honest reply to a page of
        // notices.
        assert_eq!(read(r#"{"slides":[]}"#).unwrap().len(), 0);
    }

    #[test]
    fn a_reply_that_is_not_the_shape_asked_for_is_refused() {
        assert!(read("I could not do that.").is_err());
    }

    #[test]
    fn never_asks_for_scripture_text() {
        // The application holds eleven translations. A model quoting from
        // memory is a model getting a verse subtly wrong in front of a
        // congregation that knows it.
        let settings = Settings::default();
        let prompt = body(&settings, "a sermon", 1, 1).to_string();
        assert!(prompt.contains("Never write out scripture text"));
        assert!(prompt.contains("the application holds the"));
    }
}
