//! What the sermon was about.
//!
//! A transcript is thousands of words and nobody rereads one. What a church
//! actually wants afterwards is a title, a few paragraphs, and the subjects
//! that came up -- so the person who missed it can catch up, and so the week
//! can be found again a year later.
//!
//! # Only with a model
//!
//! This is the one feature here that cannot be done on the machine. Verse
//! detection, paraphrase matching and transcription all have local answers;
//! summarising an hour of speech does not. So it appears only when the
//! assistant is configured, and says why when it is not, rather than sitting
//! greyed out with no explanation.
//!
//! # Markdown, once
//!
//! The model is asked for Markdown and the summary is stored as Markdown. The
//! app renders it, and every export converts from it. One representation to get
//! right rather than one per output format, and the thing stored is readable on
//! its own if every renderer we ever write disappears.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::settings::Settings;

/// Roughly how much transcript to send.
///
/// A long service runs past what a context window will take and past what is
/// worth paying for. The middle is dropped rather than the end: a sermon states
/// its subject early and concludes late, and losing either costs more than
/// losing an illustration from the middle.
const HEAD_WORDS: usize = 4_000;
const TAIL_WORDS: usize = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Description {
    /// What the speaker called it, or what it was plainly about when they never
    /// said. Never empty by the time this is returned.
    pub title: String,
    /// Markdown.
    pub summary: String,
    /// The subjects raised, as short noun phrases.
    pub topics: Vec<String>,
}

/// Whether a model is configured well enough to ask.
pub fn available(settings: &Settings, has_key: bool) -> bool {
    has_key
        && !settings.assist_endpoint.trim().is_empty()
        && !settings.assist_model.trim().is_empty()
}

/// Asks the model to describe a transcript.
///
/// Blocking: callers run it off the UI thread. It is one request and can take
/// the better part of a minute on a long service.
pub fn describe(settings: &Settings, key: &str, transcript: &str) -> Result<Description> {
    if transcript.split_whitespace().count() < 50 {
        bail!("There is not enough here to summarise yet.");
    }

    let body = serde_json::json!({
        "model": settings.assist_model.trim(),
        // Low, not zero: the summary is prose and should read as prose, but the
        // topics and the title must not drift on a re-run of the same service.
        "temperature": 0.2,
        // Room for a summary of a whole service plus its topics. Too small and
        // the JSON arrives truncated, which reads as a parse failure rather
        // than as the length problem it is.
        "max_tokens": 2000,
        //
        // Deliberately no "response_format": Azure AI Foundry serves models
        // from several families and only the OpenAI ones accept it -- a Llama
        // or Mistral deployment rejects the whole request with a 400, which is
        // a strange way to be told the parameter was optional. The prompt asks
        // for JSON and `read` copes with the ways a model dresses it up, which
        // is what the rest of this file already relies on.
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": excerpt(transcript) },
        ],
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("could not prepare the request")?;
    crate::assist::install_crypto_provider();

    let response = client
        .post(crate::assist::endpoint_url(
            &settings.assist_endpoint,
            &settings.assist_api_version,
        ))
        .header("api-key", key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .context("could not reach the Azure AI Foundry endpoint")?;

    let status = response.status();
    let payload = response.text().unwrap_or_default();
    if !status.is_success() {
        bail!(
            "Azure AI Foundry returned {status}: {}",
            payload.chars().take(300).collect::<String>()
        );
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&payload).context("the model response was not JSON")?;
    let content = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| anyhow!("the model returned nothing to read"))?;

    read(content)
}

const SYSTEM: &str = "\
You are given the transcript of a sermon or teaching, produced by automatic \
speech recognition. It will contain mishearings, especially of names and \
places; read past them.

Reply with JSON only, with exactly these keys:

  \"title\"   a short title. If the speaker gave one, use theirs. If not, write \
one that says what the teaching was actually about. Never invent a series name \
or a date.
  \"summary\" Markdown. Open with two or three sentences saying what was \
taught. Then '## Main points' as a bulleted list, and '## Passages' listing any \
scripture that was clearly being expounded, if there was any. Use only \
headings, bullets, bold and italics.
  \"topics\"  three to eight short subjects, as noun phrases: \"forgiveness\", \
\"the parable of the sower\", \"suffering and hope\".

Summarise only what was said. Do not add doctrine, application or scripture the \
speaker did not raise. If the transcript is too fragmentary to summarise \
honestly, say so in the summary rather than inventing content.";

/// The head and tail of a long transcript, joined with a note.
fn excerpt(transcript: &str) -> String {
    let words: Vec<&str> = transcript.split_whitespace().collect();
    if words.len() <= HEAD_WORDS + TAIL_WORDS {
        return transcript.to_string();
    }

    let head = words[..HEAD_WORDS].join(" ");
    let tail = words[words.len() - TAIL_WORDS..].join(" ");
    // Said rather than hidden: a model told that a passage is continuous will
    // write a summary that claims the middle followed from the beginning.
    format!("{head}\n\n[... the middle of this transcript has been omitted for length ...]\n\n{tail}")
}

/// Reads the model's reply, tolerating the ways it dresses JSON up.
fn read(content: &str) -> Result<Description> {
    let text = content.trim();
    // Fenced blocks, despite being asked for bare JSON. Models do this.
    let text = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .map(|rest| rest.trim_start())
        .unwrap_or(text);
    let text = text.strip_suffix("```").map(str::trim_end).unwrap_or(text);

    // Straight parse first; failing that, the JSON object out of the middle of
    // whatever else was said. Without a response_format to compel it, a model
    // is free to open with "Here is the summary:" -- and throwing that away is
    // cheaper than a failed summary of an hour of speech.
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => {
            let embedded = text
                .find('{')
                .zip(text.rfind('}'))
                .filter(|(open, close)| close > open)
                .map(|(open, close)| &text[open..=close])
                .ok_or_else(|| anyhow!("the model did not return JSON at all"))?;
            serde_json::from_str(embedded)
                .context("the model did not return usable JSON")?
        }
    };

    let title = value.get("title").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
    let summary =
        value.get("summary").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();

    let topics = value
        .get("topics")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if summary.is_empty() {
        bail!("the model returned no summary");
    }

    Ok(Description {
        // Never blank: an untitled row in a list of services is unfindable, and
        // the operator can rename it afterwards.
        title: if title.is_empty() { "Untitled".to_string() } else { title },
        summary,
        topics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_plain_reply() {
        let got = read(r#"{"title":"Coming Home","summary":"He taught on the prodigal.","topics":["grace","repentance"]}"#).unwrap();
        assert_eq!(got.title, "Coming Home");
        assert_eq!(got.topics, vec!["grace", "repentance"]);
    }

    #[test]
    fn reads_a_reply_wrapped_in_a_code_fence() {
        // Asked for bare JSON, models fence it anyway.
        let got = read("```json\n{\"title\":\"A\",\"summary\":\"B\",\"topics\":[]}\n```").unwrap();
        assert_eq!(got.title, "A");
        assert_eq!(got.summary, "B");
    }

    #[test]
    fn an_untitled_reply_still_gets_a_title() {
        // A blank row in a list of services cannot be found again.
        let got = read(r#"{"title":"","summary":"Something was said.","topics":[]}"#).unwrap();
        assert_eq!(got.title, "Untitled");
    }

    #[test]
    fn a_reply_with_no_summary_is_an_error() {
        assert!(read(r#"{"title":"A","topics":[]}"#).is_err());
    }

    #[test]
    fn json_buried_in_chat_is_still_read() {
        // Without response_format nothing compels a model to answer with bare
        // JSON, and several like to introduce themselves first.
        let got = read("Certainly! Here is the summary you asked for:\n\n\
                        {\"title\":\"Coming Home\",\"summary\":\"He taught on the prodigal.\",\
                        \"topics\":[\"grace\"]}\n\nLet me know if you would like more detail.")
            .unwrap();
        assert_eq!(got.title, "Coming Home");
        assert_eq!(got.topics, vec!["grace"]);
    }

    #[test]
    fn rubbish_is_an_error_rather_than_an_empty_summary() {
        assert!(read("I'm sorry, I can't help with that.").is_err());
    }

    #[test]
    fn a_long_transcript_keeps_its_beginning_and_its_end() {
        let words: Vec<String> = (0..10_000).map(|i| format!("w{i}")).collect();
        let excerpt = excerpt(&words.join(" "));

        assert!(excerpt.contains("w0"), "the opening states the subject");
        assert!(excerpt.contains("w9999"), "the conclusion is where it lands");
        assert!(excerpt.contains("omitted"), "and the gap is admitted to");
        assert!(!excerpt.contains(" w5000 "), "the middle is what gives way");
    }

    #[test]
    fn a_short_transcript_is_sent_whole() {
        let text = "For God so loved the world.";
        assert_eq!(excerpt(text), text);
    }

    #[test]
    fn a_model_is_needed_before_this_is_offered() {
        let mut settings = Settings::default();
        settings.assist_endpoint = "https://x.services.ai.azure.com".into();
        settings.assist_model = "gpt-4o-mini".into();

        assert!(available(&settings, true));
        assert!(!available(&settings, false), "a key is required");
        settings.assist_model = String::new();
        assert!(!available(&settings, true), "so is a deployment");
    }
}
