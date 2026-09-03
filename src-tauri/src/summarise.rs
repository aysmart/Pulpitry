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
/// The most that is sent as one request before the service is read in stretches
/// instead.
///
/// Under this, one request gives the better summary: the model has the whole
/// service in front of it and can see how the end answers the beginning. Over
/// it, the service is read in stretches and the readings drawn together --
/// which is slower and costs more, and loses nothing.
///
/// Nothing being lost is the point. This used to send the first 30,000 words
/// and the last 15,000 and tell the model the middle had been dropped, which
/// for a four-hour teaching session is most of the teaching. A summary of the
/// first and last hours of a service is not a summary of the service.
const SINGLE_PASS_WORDS: usize = 25_000;

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
pub fn describe(
    settings: &Settings,
    key: &str,
    transcript: &str,
    say: &dyn Fn(&str),
) -> Result<Description> {
    if transcript.split_whitespace().count() < 50 {
        bail!("There is not enough here to summarise yet.");
    }

    // Before the client is built, not after: rustls picks its provider when the
    // client is constructed, and installing one afterwards is too late -- the
    // build panics on a background thread and takes the request with it. This
    // is not a test-only concern; it would have failed for every operator who
    // ever pressed Summarise.

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

    // Ours or theirs, decided by the engine the operator chose.
    let hosted = settings.speech_engine == "hosted";
    let deployment = castavox_core::assistant::Deployment {
        endpoint: settings.assist_endpoint.clone(),
        model: settings.assist_model.clone(),
        api_version: settings.assist_api_version.clone(),
        shape: crate::assist::shape_of(&settings.assist_shape),
    };
    let base;
    let route = if hosted {
        base = crate::hosted::broker_base();
        castavox_core::assistant::Route::Hosted { base: &base, device_token: key }
    } else {
        castavox_core::assistant::Route::Own { deployment: &deployment, key }
    };


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
    /*
     * One request where the whole service fits, stretches where it does not.
     *
     * The word count decides the first attempt and the model decides the
     * second: a deployment with a small context refuses a transcript this
     * thinks is comfortable, and the honest response to that refusal is to
     * read the service in pieces, not to send less of it.
     */
    let whole = transcript.split_whitespace().count();
    /*
     * A ceiling on the whole job, not on any one request.
     *
     * A long service is several requests, each of which may wait out a busy
     * model, so the wall-clock time is no longer anything like the time one
     * request takes. Without a limit an exhausted quota is indistinguishable
     * from a hang, and the operator's only move is to press the button again --
     * which starts the whole thing over and makes the quota worse.
     */
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    // How long it took and how much was sent, on the way out as well as the way
    // in: a failure that arrives in two seconds and one that arrives in sixty
    // are different faults, and guessing which from the clock on two separate
    // attempts is how an afternoon goes on the wrong one.
    let started = std::time::Instant::now();
    crate::log_line!("[summarise] asking about {whole} words");
    let _timing = TimeIt { started, words: whole };
    let content = if whole > SINGLE_PASS_WORDS {
        crate::log_line!("[summarise] {whole} words: reading in stretches");
        in_stretches(&client, &route, settings, transcript, hosted, CHUNK_WORDS, CHUNK_OVERLAP, say, deadline, whole)?
    } else {
        match castavox_core::assistant::complete(
            &client,
            &route,
            // true: send the schema. `complete` leaves a format the caller has
            // already set, and the schema is the only thing this model treats
            // as binding.
            body(settings, transcript, true, whole),
            true,
        ) {
            Ok(content) => content,
            Err(failure) if worth_splitting(&failure) => {
                // How small the pieces need to be depends on what was wrong
                // with the whole: too much to read, or one phrase in it.
                let (size, overlap) = if refused_by_filter(&failure) {
                    (FILTER_WORDS, FILTER_OVERLAP)
                } else {
                    (CHUNK_WORDS, CHUNK_OVERLAP)
                };
                crate::log_line!("[summarise] refused whole; reading in stretches instead");
                in_stretches(&client, &route, settings, transcript, hosted, size, overlap, say, deadline, whole)?
            }
            Err(failure) => return Err(advise(&failure, hosted)),
        }
    };

    if content.trim().is_empty() {
        bail!("The model returned nothing to read. Try again in a moment.");
    }
    read(&content)
}

/// How much of a transcript goes into one stretch, and how much each shares
/// with the one before it.
///
/// 12,000 words is around 16,000 tokens: inside the context of every deployment
/// these ship against, with room for the notes to come back. The overlap is
/// four hundred words, a couple of minutes of speech -- enough that a passage
/// read at the end of one stretch is still there when the next one expounds it.
const CHUNK_WORDS: usize = 12_000;
const CHUNK_OVERLAP: usize = 400;

/// The same, when the reason for splitting is the safety filter rather than
/// length.
///
/// Length wants the largest stretch that fits; the filter wants the smallest
/// stretch that isolates whatever it objected to. Splitting a 969-word service
/// into one 12,000-word stretch and sending it again is sending the same
/// request twice, which is what happened the first time this was tried.
///
/// Three hundred words is a couple of minutes of speech: small enough that a
/// refused stretch costs little, large enough to still be worth summarising.
const FILTER_WORDS: usize = 300;
const FILTER_OVERLAP: usize = 40;

/// The whole service, in stretches, then drawn back together.
///
/// The alternative -- and what this replaces -- was to send the beginning and
/// the end and admit the middle had been dropped. For a forty-minute sermon
/// that never happened. For a four-hour teaching session it is most of the
/// teaching, and a summary of the first and last hours is not a summary of the
/// service.
///
/// Each stretch is read for notes, in order and told where it sits in the
/// whole. The notes are then given to the same instructions that would have
/// read the transcript, so the summary that comes out has the shape it always
/// had -- it has simply been assembled from readings rather than one.
fn in_stretches(
    client: &reqwest::blocking::Client,
    route: &castavox_core::assistant::Route,
    settings: &Settings,
    transcript: &str,
    hosted: bool,
    size: usize,
    overlap: usize,
    say: &dyn Fn(&str),
    deadline: std::time::Instant,
    service_words: usize,
) -> Result<String> {
    let stretches = castavox_core::assistant::chunks(transcript, size, overlap);
    if stretches.is_empty() {
        bail!("There is not enough here to summarise yet.");
    }
    crate::log_line!("[summarise] reading {} stretches", stretches.len());

    let mut notes: Vec<String> = Vec::with_capacity(stretches.len());
    let mut refused = 0usize;
    for (index, stretch) in stretches.iter().enumerate() {
        crate::log_line!("[summarise] stretch {} of {}", index + 1, stretches.len());
        if std::time::Instant::now() > deadline {
            bail!(
                "The model is taking too long to answer -- it may be busy with other work. {} of {} parts of this service were read; your transcript is safe. Try again in a few minutes.",
                index,
                stretches.len()
            );
        }
        say(&format!("Reading part {} of {}…", index + 1, stretches.len()));
        match castavox_core::assistant::complete(
            client,
            route,
            notes_body(settings, stretch, index + 1, stretches.len()),
            false,
        ) {
            Ok(content) if !content.trim().is_empty() => notes.push(content),
            Ok(_) => {}
            /*
             * One stretch refused is not the service lost.
             *
             * The filter objects to a phrase, and a phrase sits in one stretch.
             * Refusing the whole summary because six minutes of a four-hour
             * session contained a mishearing serves nobody -- so that stretch
             * is stepped over, said to be missing, and the rest is summarised.
             * A summary with a stated gap is worth having; no summary is not.
             */
            Err(failure) if refused_by_filter(&failure) => {
                crate::log_line!("[summarise] the model would not read stretch {} of {}", index + 1, stretches.len());
                refused += 1;
                notes.push(format!(
                    "--- This stretch of the service could not be read: the model's safety filter \
                     blocked its own summary of it, most often because scripture was quoted at \
                     length. Its content is missing from what follows. ---"
                ));
            }
            Err(failure) => return Err(advise(&failure, hosted)),
        }
    }

    // Every stretch refused means the objection is to the service throughout,
    // and there is nothing left to summarise from.
    if refused == stretches.len() {
        return Err(anyhow!(
            "The model's safety filter blocked every part of its summary of this service. It objects most often to scripture quoted at length, which it treats as copyrighted text. There is nothing wrong with your recording."
        ));
    }
    if refused > 0 {
        crate::log_line!("[summarise] {refused} of {} stretches were refused", stretches.len());
    }

    if notes.is_empty() {
        bail!("The model returned nothing to read. Try again in a moment.");
    }

    /*
     * Drawing the notes together, and again if there are too many of them.
     *
     * Notes are a fraction of the words they came from, so for any real service
     * they fit in one request. A service long enough that they do not is
     * exactly the one that must not fail here, so the notes are condensed in
     * pairs and offered again. Bounded, because a loop that cannot make
     * progress must stop rather than spend a church's tokens discovering that.
     */
    // Set once the filter has objected, and never unset: the second attempt
    // trades the speaker's own wording for a summary that is allowed through.
    let mut plain_prose = false;
    say("Drawing the parts together…");
    crate::log_line!("[summarise] {} words of notes from {} stretches",
        notes.iter().map(|n| n.split_whitespace().count()).sum::<usize>(),
        notes.len()
    );
    for _ in 0..3 {
        match castavox_core::assistant::complete(
            client,
            route,
            body(
                settings,
                &joined(&notes, service_words, plain_prose),
                true,
                service_words,
            ),
            true,
        ) {
            Ok(content) => return Ok(content),
            Err(failure) if refused_on_length(&failure) && notes.len() > 1 => {
                crate::log_line!("[summarise] {} sets of notes is still too much", notes.len());
                notes = condensed(client, route, settings, &notes, hosted)?;
            }
            /*
             * Refused for quoting, so asked again without quoting.
             *
             * The filter objects to scripture reproduced at length, and a
             * summary of a service full of exposition will quote a great deal
             * of it unless told plainly not to. That instruction is not in the
             * ordinary request because a summary is better for having the
             * speaker's own sentences in it; it goes in only when the first
             * attempt has been blocked, which is the one occasion the trade is
             * worth making.
             */
            Err(failure) if refused_by_filter(&failure) && !plain_prose => {
                crate::log_line!("[summarise] blocked for quoting; asking again without quotation");
                say("Asking again without quotations…");
                plain_prose = true;
            }
            Err(failure) => return Err(advise(&failure, hosted)),
        }
    }

    bail!("This service was too long to summarise in one piece. Summarising it in parts will work.")
}

/// Notes from consecutive stretches, labelled so their order is not guessed at.
fn joined(notes: &[String], service_words: usize, plain_prose: bool) -> String {
    let body = notes
        .iter()
        .enumerate()
        .map(|(i, note)| format!("--- Notes from part {} of {} ---\n{}", i + 1, notes.len(), note))
        .collect::<Vec<_>>()
        .join("\n\n");

    /*
     * Said out loud, because the model cannot tell from what it is holding.
     *
     * These notes are a fraction of the service they came from, and a model
     * given three pages of notes writes a summary for three pages of notes. It
     * has to be told that behind them is a four-hour teaching session, and that
     * the summary is expected to carry all of it.
     */
    let hours = (service_words as f32 / 9_000.0).max(0.5);
    /*
     * A length asked for in words, because everything softer was ignored.
     *
     * "Length follows the material" and "several thousand words" produced a
     * 566-word summary of a 27,000-word teaching session -- barely longer than
     * the 475 words it gave a nine-minute one. The budget was never the limit:
     * 566 words is some 750 tokens against a ceiling of twelve thousand. The
     * model was simply writing the length a summary is usually written at.
     *
     * A tenth of the service, which is a summary somebody who missed it can
     * actually learn from, and a floor and ceiling so that neither a two-minute
     * notice nor a day-long conference produces something absurd.
     */
    let target = (service_words / 10).clamp(300, 6_000);
    /*
     * Added only on the second attempt, after the filter has objected.
     *
     * A summary reads better for carrying a sentence the speaker actually
     * said, so this is not asked for by default. But a blocked summary is
     * worth nothing at all, and paraphrase is the price of getting one.
     */
    let quoting = if plain_prose {
        "\n\nDo not quote anything. Not scripture, not the speaker, not a hymn: no sentence \
         from the notes may appear word for word. Put everything in your own words, however \
         plainly. A previous attempt at this summary was refused for reproducing copyrighted \
         text, and paraphrase is what makes it publishable."
    } else {
        ""
    };
    format!(
        "These are ordered notes taken from consecutive parts of ONE service of about \
         {service_words} words -- roughly {hours:.1} hours of teaching. They are notes, not the \
         service: everything in them was actually said, and much that was said is only \
         summarised here.\n\n\
         Write the summary of the whole service from them. It must cover every theme and every \
         passage the notes contain, in the order they were taught, with a section for each \
         movement of the teaching.\n\n\
         Length: at least {target} words. That is not a target to approach and stop short of; \
         it is the floor. A summary of {hours:.1} hours that runs to a few hundred words has \
         left out most of what was taught, which is the one thing it must not do. If you find \
         yourself summarising the notes, stop: expand them instead. Every theme in the notes \
         earns its own paragraph, and a theme the speaker spent twenty minutes on earns \
         more.{quoting}\n\n{body}"
    )
}

/// Half as many sets of notes, by reading them in pairs.
fn condensed(
    client: &reqwest::blocking::Client,
    route: &castavox_core::assistant::Route,
    settings: &Settings,
    notes: &[String],
    hosted: bool,
) -> Result<Vec<String>> {
    let mut out = Vec::with_capacity(notes.len().div_ceil(2));
    for (index, pair) in notes.chunks(2).enumerate() {
        if pair.len() == 1 {
            out.push(pair[0].clone());
            continue;
        }
        let merged = format!("{}\n\n{}", pair[0], pair[1]);
        let content = castavox_core::assistant::complete(
            client,
            route,
            notes_body(settings, &merged, index + 1, notes.len().div_ceil(2)),
            false,
        )
        .map_err(|failure| advise(&failure, hosted))?;
        out.push(content);
    }
    Ok(out)
}

/// Says how long the attempt took, whichever way it ended.
struct TimeIt {
    started: std::time::Instant,
    words: usize,
}

impl Drop for TimeIt {
    fn drop(&mut self) {
        crate::log_line!(
            "[summarise] {} words took {:.1}s",
            self.words,
            self.started.elapsed().as_secs_f32()
        );
    }
}

/// Whether the model read the request and would not accept it on length.
fn refused_on_length(failure: &castavox_core::assistant::Failure) -> bool {
    matches!(
        failure,
        castavox_core::assistant::Failure::Refused { payload, .. }
            if castavox_core::assistant::is_too_long_refusal(payload)
    )
}

/// Whether the model's safety filter objected.
fn refused_by_filter(failure: &castavox_core::assistant::Failure) -> bool {
    matches!(
        failure,
        castavox_core::assistant::Failure::Refused { payload, .. }
            if castavox_core::assistant::is_filtered_refusal(payload)
    )
}

/// Whether asking again in smaller pieces is worth doing.
///
/// Both reasons are answered the same way and for the same reason: the model
/// judges the whole request at once, so a request it will not take whole it may
/// well take in parts. Too long is obvious. The filter is less so -- it objects
/// to a phrase, and splitting the service means only the stretch containing
/// that phrase is refused instead of the entire afternoon's teaching.
fn worth_splitting(failure: &castavox_core::assistant::Failure) -> bool {
    refused_on_length(failure) || refused_by_filter(failure)
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

    /*
     * Length first, before anything about reaching anybody.
     *
     * A four-hour teaching session produced a 27,000-word transcript, the
     * deployment refused it on length, and the branch below told the operator
     * the assistant could not be reached and to try again in a moment. It was
     * reached. It read the whole request and would not accept it, and it would
     * have refused identically every time they tried. Sending a church to check
     * a network that was never at fault is worse than saying nothing.
     */
    if let Failure::Refused { payload, .. } = failure {
        /*
         * Our own broker's sentence, when it has one.
         *
         * The rule elsewhere is that a payload never reaches the screen: it can
         * be a page of somebody else's HTML and none of it is actionable. This
         * is the exception, and it is one because the broker composed it for
         * this operator -- it knows the model refused and why, which is knowledge
         * that exists nowhere on this side. Recognised by its own shape, so a
         * reply from anything else still goes nowhere near the screen.
         */
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
            if value.get("error").and_then(|e| e.as_str()) == Some("assistant_failed") {
                if let Some(message) = value.get("message").and_then(|m| m.as_str()) {
                    if !message.trim().is_empty() {
                        return anyhow!("{message}");
                    }
                }
            }
        }

        if castavox_core::assistant::is_too_long_refusal(payload) {
            return anyhow!(
                "The service was too long for the model to read in one go. Your transcript is safe. Summarising a shorter stretch of it will work -- or a model with a larger context window will take the whole thing."
            );
        }
    }

    match failure {
        Failure::Unreachable(detail) if castavox_core::assistant::is_intercepted(detail) => {
            /*
             * The connection worked; something on the way inspected it.
             *
             * A school, office or hotel network may terminate HTTPS at an
             * appliance and re-sign it. Telling an operator to check a
             * connection that is working is the fault this application spent a
             * day removing from everywhere else, and it would be a poor joke to
             * leave it here.
             */
            anyhow!(
                "Something on this network is inspecting secure connections, and this computer does not trust the certificate it is using. The connection itself is fine. A church or office firewall usually causes this: its certificate has to be installed on this machine, or use a different network."
            )
        }
        /*
         * Nothing was listening, which is not a network fault.
         *
         * A church pointed the assistant at LM Studio running on their PC and
         * left the address on `localhost` -- the preset's default, and the
         * desk's own machine. The connection was refused in milliseconds and
         * they were told to check an internet connection that was working
         * perfectly, and that nothing in this had used.
         */
        Failure::Unreachable(detail) if castavox_core::assistant::is_nothing_listening(detail) => {
            anyhow!(
                "Nothing answered at the model's address. Check that the model's own server is \
                 started — an application being open is not the same as its server running — and \
                 that the address matches it. A model on another machine needs that machine's \
                 address rather than localhost."
            )
        }
        Failure::Unreachable(_) => anyhow!(
            "The assistant could not be reached. Check the internet connection and try again."
        ),
        Failure::Unexpected(_) => {
            anyhow!("The model could not answer that just now. Try again in a moment.")
        }
        Failure::Refused { status, .. } if status.is_server_error() => {
            /*
             * 502, 503, 504: the request never reached a model.
             *
             * A gateway between here and the model failed or timed out, which
             * is the one case where "try again shortly" is honest advice --
             * nothing about the request was wrong and nothing the operator can
             * change will help. Worth its own sentence, because it is otherwise
             * indistinguishable from the model declining, which is not
             * something waiting fixes.
             */
            anyhow!(
                "The summarising service is not answering just now ({}). Your transcript is safe -- try again in a few minutes.",
                status.as_u16()
            )
        }
        Failure::Refused { status, .. } => {
            // What is worth saying is the one thing they can do about it, and
            // that depends on whose deployment it is. A church on a
            // subscription has no endpoint and no key to check.
            if hosted {
                return anyhow!(
                    "The model would not answer that just now. Your transcript is safe -- try again in a moment."
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

/// How long the summary may run, given how long the service was.
///
/// Four hours of teaching has several times as much in it worth writing down as
/// a forty-minute sermon, and a fixed budget either cuts the long one short or
/// invites the short one to pad. The ceiling is 16,000 because that is what the
/// deployments this ships against actually allow; asking for more is refused,
/// and a refusal costs the operator their summary.
fn reply_budget(service_words: usize) -> usize {
    match service_words {
        0..=2_999 => 4_000,
        3_000..=9_999 => 8_000,
        10_000..=19_999 => 12_000,
        _ => 16_000,
    }
}

/// The request body, with or without the parameter not every model accepts.
fn body(
    settings: &Settings,
    excerpt: &str,
    strict_json: bool,
    // How long the *service* was, which is not the length of what is being
    // sent: the final request carries notes, and notes are a fraction of the
    // words they came from. Sizing the reply by them gave a four-hour teaching
    // session the budget meant for a sermon, and the summary came back short.
    service_words: usize,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": settings.assist_model.trim(),
        // Low, not zero: the summary is prose and should read as prose, but the
        // topics and the title must not drift on a re-run of the same service.
        "temperature": 0.3,
        // Room to be thorough, and more of it for a longer service. A summary
        // worth reading instead of the service runs to well over a thousand
        // words once it has main points, the passages, the illustrations and
        // the application -- and a budget that cuts it off mid-sentence arrives
        // as a JSON parse failure rather than as the length problem it is.
        //
        // A flat 8,000 was set for a sermon and then asked to carry a
        // four-hour teaching session, which has several times as much in it
        // worth writing down.
        "max_tokens": reply_budget(service_words),
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": excerpt },
        ],
    });

    if strict_json {
        /*
         * The shape as a contract. A schema cannot make the model write a
         * section, but it can stop it inventing keys, omitting the topics, or
         * returning the summary as an array of paragraphs -- all of which it
         * did once the model changed. `complete` asks again without this where
         * a deployment cannot take one.
         */
        body["response_format"] = serde_json::json!({
            "type": "json_schema",
            "json_schema": {
                "name": "description",
                "strict": true,
                "schema": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "title", "opening", "mainPoints", "passages",
                        "illustrations", "application", "quotations", "topics"
                    ],
                    "properties": {
                        "title": { "type": "string" },
                        "opening": { "type": "string" },
                        "mainPoints": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["point", "detail"],
                                "properties": {
                                    "point": { "type": "string" },
                                    "detail": { "type": "string" }
                                }
                            }
                        },
                        "passages": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["reference", "teaching"],
                                "properties": {
                                    "reference": { "type": "string" },
                                    "teaching": { "type": "string" }
                                }
                            }
                        },
                        "illustrations": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["what", "purpose"],
                                "properties": {
                                    "what": { "type": "string" },
                                    "purpose": { "type": "string" }
                                }
                            }
                        },
                        "application": { "type": "array", "items": { "type": "string" } },
                        "quotations": { "type": "array", "items": { "type": "string" } },
                        "topics": { "type": "array", "items": { "type": "string" } }
                    }
                }
            }
        });
    }
    body
}

/// The JSON object out of whatever the model actually said.
///
/// Straight parse first; failing that, the object out of the middle of whatever
/// else was said. Without a response_format to compel it a model is free to
/// open with "Here is the summary:", and throwing that away is cheaper than a
/// failed summary of an hour of speech.
fn json_of(text: &str) -> Result<serde_json::Value> {
    let text = text.trim();
    let text = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .map(|rest| rest.trim_start())
        .unwrap_or(text);
    let text = text.strip_suffix("```").map(str::trim_end).unwrap_or(text);

    match serde_json::from_str(text) {
        Ok(value) => Ok(value),
        Err(_) => {
            let embedded = text
                .find('{')
                .zip(text.rfind('}'))
                .filter(|(open, close)| close > open)
                .map(|(open, close)| &text[open..=close])
                .ok_or_else(|| anyhow!("the model did not return JSON at all"))?;
            serde_json::from_str(embedded).context("the model did not return usable JSON")
        }
    }
}

/// One stretch of the service, read for notes rather than summarised.
fn notes_body(settings: &Settings, stretch: &str, part: usize, of: usize) -> serde_json::Value {
    serde_json::json!({
        "model": settings.assist_model.trim(),
        "temperature": 0.3,
        // Generous: these notes are the only record of this stretch that the
        // final summary will ever see, so anything they leave out is gone.
        "max_tokens": 8000,
        "messages": [
            { "role": "system", "content": NOTES },
            {
                "role": "user",
                "content": format!("Part {part} of {of} of one service.\n\n{stretch}"),
            },
        ],
    })
}

/// What to do with a stretch of a service that is being read in pieces.
///
/// Deliberately not a summary. A summary of a stretch throws away the detail
/// the final summary needs, and no later step can recover it -- so this asks
/// for full notes and lets the drawing-together be the thing that condenses.
const NOTES: &str = "\
You are given one consecutive stretch of the transcript of a single church \
service or teaching session, produced by automatic speech recognition. It will \
contain mishearings, especially of names and places; read past them.

This is not the whole service. Do not write an introduction or a conclusion for \
it, do not speculate about what came before or after, and do not describe it as \
though it were complete.

Take detailed notes on this stretch alone, in the order things were said. Keep:

- every point made, and the reasoning used to make it
- every scripture reference, quoted or alluded to, and what was said about it \
  (the reference and the point made; not the wording of the passage itself)
- illustrations, stories and examples, briefly but recognisably
- anything the hearers were asked to do
- sentences worth preserving in the speaker's own words, quoted exactly
- announcements, and anything else that is not teaching

Notes, not prose: brevity in the wording, not in what is covered. Err towards \
keeping something rather than dropping it -- these notes are all that will be \
seen of this stretch when the summary is written, so whatever you leave out is \
lost. If a passage is too garbled to be sure of, note that rather than \
guessing at it.";

const SYSTEM: &str = "\
You are given the transcript of a sermon or teaching, produced by automatic \
speech recognition. It will contain mishearings, especially of names and \
places; read past them.

Write the summary a capable assistant would write if handed this transcript \
and asked to do a thorough job. Someone who missed the service should be able \
to read it and know what was taught, how it was argued, and what they were \
asked to do -- not merely what the subject was. Length follows the material, \
and follows it the whole way: a forty-minute exposition deserves several \
hundred words and often more, while a teaching session of three, four or five \
hours deserves several thousand and a section for each movement of it. Do not \
compress hours into the same page you would give a sermon -- work through the \
material in the order it was taught, and let the summary be as long as the \
teaching requires. Never \
pad, and never cut something the speaker clearly laboured over.

Reply with JSON only, with exactly these keys:

  \"title\"   a short title. If the speaker gave one, use theirs. If not, write \
one that says what the teaching was actually about. Never invent a series name \
or a date.
  \"summary\" Markdown, structured as set out below.
  \"topics\"  four to ten short subjects, as noun phrases: \"forgiveness\", \
\"the parable of the sower\", \"suffering and hope\".

Fill in every field. The application writes the document from them, so a field \
you leave empty is a section the reader never sees. A section you find thin is \
one to write briefly, not one to leave out -- and a summary missing its \
passages or its application is the commonest complaint about this feature. \
Only `illustrations` may be an empty list, and only when the speaker used none.

  \"opening\"       two or three sentences of prose saying what was taught and \
where it landed.
  \"mainPoints\"    one entry per movement of the argument, each with a short \
`point` naming it and a `detail` of two or three sentences developing it: what \
was claimed, how it was argued, any distinction the speaker drew.
  \"passages\"      every scripture actually expounded: the `reference` alone -- \
never the words of the passage -- and what was drawn from it in `teaching`.
  \"illustrations\" each story, image or example: `what` it was and its \
`purpose`.
  \"application\"   what the speaker actually called for. Only what they said.
  \"quotations\"    up to three sentences worth preserving in the speaker's own \
words.

The old shape, for reference, was one Markdown string; it is now these fields \
and the headings are added here:

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
**bold**, then an em dash and what was drawn from it. Name the passage; do not \
reproduce it. Anyone reading this has a Bible, and the reference is what they \
need. Where the speaker's own handling of a particular phrase is the point, say \
which phrase and what they made of it, in your words rather than by quoting the \
translation at length.

  ## Illustrations
  Any story, image, analogy or example used, as a bulleted list: what it was, \
and what it was for. This is the one section that may be left out entirely, \
and only when the speaker genuinely used none.

  ## Application
  What the speaker actually called for, as a bulleted list. Only what they \
said; never add your own.

  ## Notable quotations
  Up to three sentences worth preserving in the speaker's own words, each as a \
> blockquote. Omit if nothing stood out.

Formatting. Use **bold** for the thing being named and *italic* for emphasis \
and for the speaker's phrases quoted inline. Use > blockquotes for what the \
speaker themselves said, not for scripture: a summary cites the reference and \
lets the reader open their own Bible at it. Use a table only where the \
speaker genuinely set things side by side. A --- rule may separate major \
sections. Always put a heading on its own line. No images, no code blocks, no \
links. Do not put a heading above the opening paragraph, and do not repeat the \
title inside the summary.

Summarise only what was said. Do not add doctrine, application or scripture \
the speaker did not raise, and do not smooth over a passage they left \
unresolved. Where the recognition is too garbled to be sure, say so in passing \
rather than guessing. If the transcript is too fragmentary to summarise \
honestly, say that in the summary instead of inventing content.";

/// Reads the model's reply, tolerating the ways it dresses JSON up.
/// The Markdown, out of the sections the model returned.
fn assemble(value: &serde_json::Value) -> String {
    let text = |key: &str| {
        value.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string()
    };
    let list = |key: &str| -> Vec<&serde_json::Value> {
        value.get(key).and_then(|v| v.as_array()).map(|a| a.iter().collect()).unwrap_or_default()
    };
    let field = |item: &serde_json::Value, key: &str| {
        item.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string()
    };

    let mut out = String::new();
    let opening = text("opening");
    if !opening.is_empty() {
        out.push_str(&opening);
    }

    let points = list("mainPoints");
    if !points.is_empty() {
        out.push_str("\n\n## Main points\n");
        for (index, item) in points.iter().enumerate() {
            let (point, detail) = (field(item, "point"), field(item, "detail"));
            out.push_str(&format!("\n{}. **{point}** — {detail}", index + 1));
        }
    }

    let passages = list("passages");
    if !passages.is_empty() {
        out.push_str("\n\n## Passages\n");
        for item in &passages {
            out.push_str(&format!(
                "\n- **{}** — {}",
                field(item, "reference"),
                field(item, "teaching")
            ));
        }
    }

    let illustrations = list("illustrations");
    if !illustrations.is_empty() {
        out.push_str("\n\n## Illustrations\n");
        for item in &illustrations {
            out.push_str(&format!("\n- {} — {}", field(item, "what"), field(item, "purpose")));
        }
    }

    let application = list("application");
    if !application.is_empty() {
        out.push_str("\n\n## Application\n");
        for item in &application {
            out.push_str(&format!("\n- {}", item.as_str().unwrap_or_default().trim()));
        }
    }

    let quotations = list("quotations");
    if !quotations.is_empty() {
        out.push_str("\n\n## Notable quotations\n");
        for item in &quotations {
            out.push_str(&format!("\n> {}", item.as_str().unwrap_or_default().trim()));
        }
    }

    out.trim().to_string()
}

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
    let value = json_of(text)?;

    let title = value.get("title").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
    /*
     * Assembled from its parts, where the model returned parts.
     *
     * `summary` used to be one string of Markdown, with the headings asked for
     * in prose -- and a model that follows prose loosely returned the opening
     * paragraph and stopped. Passages and Application, the two an operator
     * actually wants, were the ones that went. No amount of insisting fixed it,
     * because a heading inside a string is not something a schema can require.
     *
     * Each section is now its own field, so a missing one is a schema violation
     * rather than a stylistic choice, and the Markdown is written here. The
     * plain `summary` is still read first: a deployment that cannot take a
     * schema answers in the old shape, and that answer is still worth having.
     */
    let summary = match value.get("summary").and_then(|v| v.as_str()) {
        Some(written) if !written.trim().is_empty() => written.trim().to_string(),
        _ => assemble(&value),
    };

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
    fn the_notes_are_labelled_so_their_order_is_not_guessed_at() {
        let notes = vec!["first".to_string(), "second".to_string(), "third".to_string()];
        let text = joined(&notes, 27_000, false);
        assert!(text.contains("part 1 of 3"), "{text}");
        assert!(text.contains("part 3 of 3"), "{text}");
        assert!(
            text.find("first").unwrap() < text.find("third").unwrap(),
            "the service was reassembled out of order"
        );
    }

    #[test]
    fn the_document_is_written_from_the_sections() {
        // The model returns fields; the headings are ours. A section it fills
        // is a section the reader sees, which is the whole point of moving them
        // out of one Markdown string it could quietly truncate.
        let reply = r#"{
            "title":"Activity and Progress",
            "opening":"The teaching examined pairs of ideas that look alike.",
            "mainPoints":[{"point":"Busy is not moving","detail":"He drew the treadmill out."}],
            "passages":[{"reference":"Hebrews 12:1","teaching":"Run with patience."}],
            "illustrations":[],
            "application":["Slow down before deciding."],
            "quotations":["Activity is not progress."],
            "topics":["discernment","habits"]
        }"#;
        let got = read(reply).unwrap();

        assert_eq!(got.title, "Activity and Progress");
        assert!(got.summary.starts_with("The teaching examined"), "the opening is not first");
        for heading in ["## Main points", "## Passages", "## Application", "## Notable quotations"]
        {
            assert!(got.summary.contains(heading), "{heading} is missing");
        }
        // The one section that may genuinely be absent leaves no empty heading.
        assert!(!got.summary.contains("## Illustrations"), "an empty section was given a heading");
        assert_eq!(got.topics, vec!["discernment".to_string(), "habits".to_string()]);
    }

    #[test]
    fn a_reply_in_the_old_shape_is_still_read() {
        // A deployment that cannot take a schema answers with one Markdown
        // string, and that answer is still worth having.
        // r###, because the sample contains `"##` -- a Markdown heading right
        // after a quote closes anything shorter.
        let got =
            read(r###"{"title":"T","summary":"## Main points\n\n1. **A** — b","topics":["x"]}"###)
                .unwrap();
        assert!(got.summary.contains("## Main points"));
    }

    #[test]
    fn a_longer_service_is_given_a_longer_summary() {
        assert_eq!(reply_budget(500), 4_000);
        assert_eq!(reply_budget(5_000), 8_000);
        assert_eq!(reply_budget(15_000), 12_000);
        // The four-hour teaching session this was written for.
        assert_eq!(reply_budget(27_000), 16_000);
    }

    #[test]
    fn the_budget_never_asks_for_more_than_deployments_allow() {
        assert!(reply_budget(90_000) <= 16_000, "would be refused for asking too much");
    }

    #[test]
    fn the_request_actually_carries_the_schema() {
        // The schema lived in `body` behind a flag both call sites passed as
        // false, so it was written, tested, deployed and never sent. Two rounds
        // of prompt work were spent explaining behaviour it would have fixed.
        let settings = Settings::default();
        let sent = body(&settings, "a transcript", true, 6_000);
        assert_eq!(
            sent["response_format"]["type"], "json_schema",
            "the schema is not in the request"
        );
    }

    #[test]
    fn the_strict_parameter_is_the_only_difference_between_the_two_bodies() {
        let mut settings = Settings::default();
        settings.assist_model = "gpt-4o-mini".into();

        let strict = body(&settings, "a transcript", true, 2);
        let plain = body(&settings, "a transcript", false, 2);

        // A schema now, not merely "some JSON": the shape is a contract the
        // model cannot decline, which is the whole reason for sending one.
        assert_eq!(strict["response_format"]["type"], "json_schema");
        assert_eq!(strict["response_format"]["json_schema"]["strict"], true);
        // Every section, because a field the schema does not require is a
        // section the model may decide not to write -- which is how Passages
        // and Application went missing.
        for key in ["title", "opening", "mainPoints", "passages", "application", "topics"] {
            assert!(
                strict["response_format"]["json_schema"]["schema"]["required"]
                    .as_array()
                    .is_some_and(|required| required.iter().any(|r| r == key)),
                "{key} is not required, so it may be omitted"
            );
        }
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
    fn a_short_transcript_is_sent_whole() {
        let text = "For God so loved the world.";
        let sent = body(&Settings::default(), text, false, 5);
        assert_eq!(sent["messages"][1]["content"], text, "the transcript was altered on its way out");
    }

    #[test]
    fn a_service_too_long_for_one_request_still_keeps_every_word() {
        // The property that matters: the stretches together contain the whole
        // service. Nothing is dropped for length any more.
        let words: Vec<String> = (0..60_000).map(|i| format!("w{i}")).collect();
        let stretches = castavox_core::assistant::chunks(&words.join(" "), CHUNK_WORDS, CHUNK_OVERLAP);
        assert!(stretches.len() > 1, "a five-hour service should be read in stretches");
        for word in [&words[0], &words[30_000], &words[59_999]] {
            assert!(
                stretches.iter().any(|s| s.split_whitespace().any(|w| w == word)),
                "{word} is in no stretch -- the middle was dropped again"
            );
        }
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

        let described = describe(&settings, &key, SERMON, &|_| {}).expect("the model call failed");

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
