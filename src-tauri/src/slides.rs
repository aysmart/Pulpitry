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

/// How much of a sermon is sent.
///
/// Generous: an outline is short, and a transcript that reaches this is an hour
/// of preaching, which the excerpting in [`crate::summarise`] already handles
/// better than truncation would.
const MAX_WORDS: usize = 4_000;

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
        .timeout(std::time::Duration::from_secs(120))
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

    let trimmed: String = sermon.split_whitespace().take(MAX_WORDS).collect::<Vec<_>>().join(" ");

    let content =
        castavox_core::assistant::complete(&client, &route, body(settings, &trimmed), true)
            .map_err(|failure| advise(&failure, hosted))?;

    if content.trim().is_empty() {
        bail!("The model returned nothing to read. Try again in a moment.");
    }
    read(&content)
}

fn body(settings: &Settings, sermon: &str) -> serde_json::Value {
    serde_json::json!({
        "model": settings.assist_model.trim(),
        // Low. Slides are somebody else's sermon, and invention is the failure
        // mode -- a heading that sounds better than what they said is still not
        // what they said.
        "temperature": 0.2,
        "max_tokens": 1600,
        "messages": [
            {
                "role": "system",
                "content":
                    "You turn a preacher's sermon or outline into slides for a church screen. \
                     Return JSON: {\"slides\":[{\"title\":\"…\",\"lines\":[\"…\"],\"reference\":\"…\"}]}. \
                     \
                     What a good church slide is, and this matters more than being thorough: \
                     it is read at a glance, from the back, by somebody listening to a person \
                     rather than reading a page. So it carries a few words, not a summary. \
                     \
                     TITLE: at most five words. Title Case. No trailing punctuation. It is a \
                     signpost, not a sentence — 'The Father Runs', not 'The father runs to \
                     meet his son while he is still far off'. \
                     \
                     LINES: at most three, at most seven words each. Each is a phrase, not a \
                     sentence: no full stops at the end, no numbering, no bullet characters, \
                     no 'Point 1' or '2.' — the slide is the numbering. Sentence case. Cut \
                     every word that is not doing work: 'Grace we did not earn' beats 'This is \
                     the grace that we did not and could not ever earn'. \
                     A slide with a strong title and one line is better than one with four \
                     weak lines. Leave `lines` empty if the title says it. \
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
                     than inventing content if there is nothing worth putting on a wall."
            },
            { "role": "user", "content": sermon }
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
    // A trailing stop, but not an ellipsis or a question -- those are the
    // author's and mean something.
    let text = if text.ends_with("..") { text } else { text.trim_end_matches('.') };

    // Whitespace a model put in for a page, collapsed for a screen.
    text.split_whitespace().collect::<Vec<_>>().join(" ")
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

    #[derive(Deserialize)]
    struct Reply {
        #[serde(default)]
        slides: Vec<DraftSlide>,
    }

    let reply: Reply =
        serde_json::from_str(text).context("the model's reply was not the shape asked for")?;

    // Tidied here rather than trusted. Asked for three short phrases, a model
    // will return five numbered sentences often enough that cleaning them is
    // part of the feature rather than a workaround -- and the artefacts are
    // always the same few, so they are cheap to remove.
    let slides: Vec<DraftSlide> = reply
        .slides
        .into_iter()
        .map(|slide| DraftSlide {
            title: tidy(&slide.title),
            lines: slide
                .lines
                .iter()
                .map(|line| tidy(line))
                .filter(|line| !line.is_empty())
                .take(3)
                .collect(),
            reference: slide.reference.trim().trim_end_matches('.').to_string(),
        })
        .filter(|slide| !slide.title.is_empty() || !slide.lines.is_empty())
        .take(MAX_SLIDES)
        .collect();

    Ok(slides)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn drops_a_full_stop_but_keeps_what_the_author_meant() {
        // A phrase on a slide does not end in a full stop. A question mark and
        // an ellipsis are doing work, and taking them would change the line.
        assert_eq!(tidy("He was still a long way off."), "He was still a long way off");
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
        // goes back to paragraphs chopped into lines.
        let prompt = body(&Settings::default(), "a sermon").to_string();
        assert!(prompt.contains("at most five words"));
        assert!(prompt.contains("no numbering"));
        assert!(prompt.contains("read at a glance"));
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
        let prompt = body(&settings, "a sermon").to_string();
        assert!(prompt.contains("Never write out scripture text"));
        assert!(prompt.contains("the application holds the"));
    }
}
