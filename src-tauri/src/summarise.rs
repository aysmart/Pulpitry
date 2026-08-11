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
/// Roughly 30,000 words: about four hours of speech, which is longer than any
/// single service, so in practice a whole one is sent whole. The middle is
/// still what gives way if something ever runs past it.
const HEAD_WORDS: usize = 20_000;
const TAIL_WORDS: usize = 10_000;

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
///
/// On a Castavox subscription there is nothing to configure: the deployment is
/// ours and is metered against the same plan as the hours. Anywhere else it is
/// the church's own endpoint, model and key.
pub fn available(settings: &Settings, has_key: bool) -> bool {
    if settings.speech_engine == "hosted" {
        return crate::settings::has_hosted_token();
    }
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

    // Before the client is built, not after: rustls picks its provider when the
    // client is constructed, and installing one afterwards is too late -- the
    // build panics on a background thread and takes the request with it. This
    // is not a test-only concern; it would have failed for every operator who
    // ever pressed Summarise.
    castavox_core::tls::install();

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("could not prepare the request")?;

    // Ours or theirs, decided by the engine the operator chose.
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

    let excerpt = excerpt(transcript);

    /*
     * Strict JSON, asked for and retried without.
     *
     * One endpoint serves models from several families. The OpenAI ones honour
     * response_format and return JSON that always parses; a Llama or Mistral
     * deployment rejects the entire request rather than ignoring the parameter.
     * The transport tries the strict request and asks again without it when the
     * deployment says it cannot -- feature detection rather than a list of
     * model names, which would be wrong the week after it was written.
     *
     * That retry, the two ways of authenticating and the reading of the reply
     * were all written out here as well, identically, in Castavox. They are in
     * castavox-core now, where a fix reaches both.
     */
    let content = castavox_core::assistant::complete(
        &client,
        &route,
        body(settings, &excerpt, false),
        true,
    )
    .map_err(|failure| advise(&failure, hosted))?;

    if content.trim().is_empty() {
        bail!("The model returned nothing to read. Try again in a moment.");
    }
    read(&content)
}

/// Turns a failure into the one sentence the operator can act on.
///
/// The detail goes to the log and never to the screen. What comes back can be a
/// page of somebody else's HTML, and a few hundred characters of it in front of
/// an operator tells them nothing and buries the sentence that would have
/// helped.
fn advise(failure: &castavox_core::assistant::Failure, hosted: bool) -> anyhow::Error {
    use castavox_core::assistant::Failure;

    crate::log_line!("[summarise] {failure}");

    match failure {
        Failure::Unreachable(_) => anyhow!(
            "The assistant could not be reached. Check the internet connection and try again."
        ),
        Failure::Unexpected(_) => {
            anyhow!("The model could not answer that just now. Try again in a moment.")
        }
        Failure::Refused { status, .. } => {
            // What is worth saying is the one thing they can do about it, and
            // that depends on whose deployment it is. A church on a
            // subscription has no endpoint and no key to check.
            if hosted {
                return anyhow!(
                    "The assistant could not be reached just now. Your transcript is safe -- try again in a moment."
                );
            }
            // A 404 from Foundry almost never means the deployment is missing.
            // It means the route was wrong -- most often an API version
            // predating the /models route, which fails exactly like a typo.
            match status.as_u16() {
                404 => anyhow!("The model endpoint answered but the address was not recognised. Clearing the API version field in Settings restores the default, which is known to work."),
                401 | 403 => anyhow!("The model refused the key. Check the key and endpoint under Settings -> Model assistance."),
                _ => anyhow!("The model could not answer that just now. Try again in a moment."),
            }
        }
    }
}

/// The request body, with or without the parameter not every model accepts.
fn body(settings: &Settings, excerpt: &str, strict_json: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": settings.assist_model.trim(),
        // Low, not zero: the summary is prose and should read as prose, but the
        // topics and the title must not drift on a re-run of the same service.
        "temperature": 0.3,
        // Room to be thorough. A summary worth reading instead of the service
        // runs to well over a thousand words once it has main points, the
        // passages, the illustrations and the application -- and a budget that
        // cuts it off mid-sentence arrives as a JSON parse failure rather than
        // as the length problem it actually is.
        "max_tokens": 8000,
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": excerpt },
        ],
    });

    if strict_json {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }
    body
}

const SYSTEM: &str = "\
You are given the transcript of a sermon or teaching, produced by automatic \
speech recognition. It will contain mishearings, especially of names and \
places; read past them.

Write the summary a capable assistant would write if handed this transcript \
and asked to do a thorough job. Someone who missed the service should be able \
to read it and know what was taught, how it was argued, and what they were \
asked to do -- not merely what the subject was. Length follows the material: a \
forty-minute exposition deserves several hundred words and often more. Never \
pad, and never cut something the speaker clearly laboured over.

Reply with JSON only, with exactly these keys:

  \"title\"   a short title. If the speaker gave one, use theirs. If not, write \
one that says what the teaching was actually about. Never invent a series name \
or a date.
  \"summary\" Markdown, structured as set out below.
  \"topics\"  four to ten short subjects, as noun phrases: \"forgiveness\", \
\"the parable of the sower\", \"suffering and hope\".

Structure the summary like this, leaving out any section the transcript does \
not support:

  Two or three sentences of prose saying what was taught and where it landed. \
No heading above this; it opens the document.

  ## Main points
  A numbered list, one item per movement of the argument. Open each with a \
short **bold** phrase naming the point, then an em dash and two or three \
sentences developing it -- what was claimed, how it was argued, and any \
distinction the speaker drew. Indent bullets beneath an item for sub-points \
they genuinely developed.

  ## Passages
  A bulleted list of the scripture actually expounded, each reference in \
**bold**, then an em dash and what was drawn from it. Where a verse was quoted \
and the wording matters, put it on its own line beneath as a > blockquote.

  ## Illustrations
  Any story, image, analogy or example used, as a bulleted list: what it was, \
and what it was for. Omit the section entirely if there were none.

  ## Application
  What the speaker actually called for, as a bulleted list. Only what they \
said; never add your own.

  ## Notable quotations
  Up to three sentences worth preserving in the speaker's own words, each as a \
> blockquote. Omit if nothing stood out.

Formatting. Use **bold** for the thing being named and *italic* for emphasis \
and for the speaker's phrases quoted inline. Use > blockquotes for scripture \
and for direct quotations of more than a few words. Use a table only where the \
speaker genuinely set things side by side. A --- rule may separate major \
sections. Always put a heading on its own line. No images, no code blocks, no \
links. Do not put a heading above the opening paragraph, and do not repeat the \
title inside the summary.

Summarise only what was said. Do not add doctrine, application or scripture \
the speaker did not raise, and do not smooth over a passage they left \
unresolved. Where the recognition is too garbled to be sure, say so in passing \
rather than guessing. If the transcript is too fragmentary to summarise \
honestly, say that in the summary instead of inventing content.";

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
    fn the_strict_parameter_is_the_only_difference_between_the_two_bodies() {
        let mut settings = Settings::default();
        settings.assist_model = "gpt-4o-mini".into();

        let strict = body(&settings, "a transcript", true);
        let plain = body(&settings, "a transcript", false);

        assert_eq!(strict["response_format"]["type"], "json_object");
        assert!(plain.get("response_format").is_none(), "the fallback must not send it");

        // Everything the summary depends on survives the fallback.
        for field in ["model", "temperature", "max_tokens", "messages"] {
            assert_eq!(strict[field], plain[field], "{field} differed");
        }
    }

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
        // Past HEAD + TAIL, which is about four hours of speech -- longer than
        // any real service, so this is the safety valve rather than the norm.
        let words: Vec<String> = (0..40_000).map(|i| format!("w{i}")).collect();
        let excerpt = excerpt(&words.join(" "));

        assert!(excerpt.contains("w0"), "the opening states the subject");
        assert!(excerpt.contains("w39999"), "the conclusion is where it lands");
        assert!(excerpt.contains("omitted"), "and the gap is admitted to");
        assert!(!excerpt.contains(" w25000 "), "the middle is what gives way");
    }

    #[test]
    fn a_short_transcript_is_sent_whole() {
        let text = "For God so loved the world.";
        assert_eq!(excerpt(text), text);
    }

    /*
     * The real thing: this deployment, this key, a transcript of the length a
     * service actually produces.
     *
     * Ignored by default because it costs money and needs the network. Run it
     * deliberately, and run it after any change to the request body -- the
     * whole class of bug it exists to catch is a parameter one model family
     * accepts and another rejects, which no amount of local testing finds.
     *
     *   cargo test --release --lib summarise::tests::against_the_real_model -- --ignored --nocapture
     */
    #[test]
    #[ignore = "calls the configured model and costs money"]
    fn against_the_real_model() {
        let home = std::env::var("HOME").expect("HOME");
        let path = format!("{home}/Library/Application Support/com.pulpitry.desktop/settings.json");
        let stored = std::fs::read_to_string(&path).expect("settings.json -- configure the app first");
        let mut settings: Settings = serde_json::from_str(&stored).expect("settings.json did not parse");
        // A version stored before the default moved on would 404 against the
        // /models route, which is a stale setting rather than a broken build.
        if settings.assist_api_version.trim().is_empty() || settings.assist_api_version == "2024-02-01" {
            crate::log_line!("(overriding stale api version {})", settings.assist_api_version);
            settings.assist_api_version = crate::settings::DEFAULT_ASSIST_API_VERSION.into();
        }

        let key = crate::settings::load_assist_key()
            .expect("keychain")
            .expect("no model key stored -- set one in Settings first");

        crate::log_line!("endpoint: {}", settings.assist_endpoint);
        crate::log_line!("model:    {}", settings.assist_model);
        crate::log_line!("version:  {}", settings.assist_api_version);
        assert!(available(&settings, true), "the assistant is not fully configured");

        let described = describe(&settings, &key, SERMON).expect("the model call failed");

        crate::log_line!("\n--- title ---\n{}", described.title);
        crate::log_line!("\n--- summary (markdown) ---\n{}", described.summary);
        crate::log_line!("\n--- topics ---\n{:?}", described.topics);

        assert!(!described.title.is_empty());
        assert!(described.summary.len() > 80, "suspiciously short for a whole talk");
        assert!(!described.topics.is_empty(), "no subjects were identified");

        // The exports read this, so it has to be the Markdown we promised.
        let text = crate::exports::to_text(&described.title, &described.summary, &described.topics);
        crate::log_line!("\n--- as plain text ---\n{text}");
        assert!(crate::exports::to_pdf(&described.title, &described.summary, &described.topics).is_ok());
        assert!(crate::exports::to_docx(&described.title, &described.summary, &described.topics).is_ok());
    }

    /// A transcript with the shape of the real thing: a stated subject, a
    /// passage expounded, illustration, and a conclusion that lands.
    const SERMON: &str = "\
Good morning church. Turn with me if you would to Luke chapter fifteen, and we \
are going to read from verse eleven. Jesus said a certain man had two sons and \
the younger of them said to his father, father give me the portion of goods \
that falleth to me. Now I want you to notice something about that request. He \
is not asking for a loan. He is asking for his inheritance, and an inheritance \
is what you receive when your father has died. So what the younger son is \
really saying is, I wish you were dead. And the remarkable thing, the thing \
that ought to stop us this morning, is that the father gives it to him. He \
divides unto them his living. He lets him go. \
Now the boy goes into a far country and there he wastes his substance with \
riotous living, and when he has spent all there arose a mighty famine in that \
land and he began to be in want. Isn't that always the way. The famine always \
comes after the money runs out. And he goes and joins himself to a citizen of \
that country who sends him into the fields to feed pigs, and remember this is a \
Jewish boy, there is no lower place for him to go. And he would gladly have \
filled his belly with the husks that the pigs did eat, and no man gave unto \
him. \
But then it says, and when he came to himself. When he came to himself. He \
had not been himself all that time. And he says I will arise and go to my \
father, and I will say unto him, father I have sinned against heaven and before \
thee and am no more worthy to be called thy son, make me as one of thy hired \
servants. Now he rehearses that speech. He practises it all the way home. And \
here is what I want you to see. He never gets to finish it. \
Because when he was yet a great way off his father saw him. A great way off. \
Which means the father was looking. Which means the father had been looking \
every day since the boy left. And he ran. In that culture an old man did not \
run, he would have to gather up his robes and expose his legs and it was \
undignified, and the father does not care. He runs and falls on his neck and \
kisses him. And the boy starts his speech, father I have sinned against heaven \
and in thy sight and am no more worthy to be called thy son, and the father is \
not even listening, he is calling to the servants, bring forth the best robe \
and put it on him and put a ring on his hand and shoes on his feet. \
And I have to tell you about the elder brother, because the parable does not \
end with the party. The elder brother is in the field and he hears the music \
and he will not go in. He says lo these many years do I serve thee, neither \
transgressed I at any time thy commandment. Do you hear it. Serve. He has been \
in the father's house all this time and he has been thinking of himself as a \
servant. He is as lost as his brother was, he is just lost in the field instead \
of in the far country. And the father comes out to him too. The father goes out \
twice in this story. \
So let me close with this. Some of us this morning are in the far country and \
you know exactly what I am talking about. And some of us have never left the \
field, and we are angry, and we do not know why. And the father is out looking \
for both of you. Let us pray.";

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
