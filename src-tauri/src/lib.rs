/*
 * The slide schema outgrew `json!`'s default expansion depth.
 *
 * That schema is one object with a slide's shape inside it, and the shape has
 * grown a field at a time: a table, then headings on the points, then a chart
 * with its own bars. Nothing about it is deep for a human to read; it is deep
 * for a macro to expand.
 *
 * Raised rather than worked around. The alternative was splitting the schema
 * across two macros, which puts the shape of a slide in two places to keep the
 * expander happy -- and this file has already paid for that kind of split
 * three times over.
 */
#![recursion_limit = "256"]

// Six modules now live in castavox-core, shared with Castavox rather than
// copied into it. Named here so the rest of this file reads unchanged.
use castavox_core::{audio, checkin, embed, exports, node, transcripts, whisper};

mod assist;
mod bible;
mod catalog;
mod detect;
mod hosted;
mod menu;
mod mirror;
mod ndi;
mod ndi_capture;
mod ndi_output;
mod follow;
mod fonts;
mod projector;
mod semantic;
mod settings;
mod slides;
mod songbook;
mod songs_import;
mod speech;
mod log;
mod summarise;
mod spoken;
mod suggestion;

use std::sync::Arc;

use audio::AudioDevice;
use assist::Assistant;
use bible::{Book, Library, LibraryStatus, Reference, Translation, Verse};
use catalog::{Catalog, Item};
use detect::Detector;
use projector::{
    AudioState, Display, LiveContent, MediaCommand, MediaProgress, Projector, ProjectorState,
    Ticker,
};
use semantic::{IndexStatus, Semantic};
use settings::{ProjectorTheme, Settings, SettingsView};
use speech::{SpeechManager, SpeechStatus};
use summarise::Description;
use transcripts::{Session, Transcripts};
use anyhow::Context;
use tauri::{AppHandle, Emitter, Manager, State};

/// Commands return plain strings on failure so the operator UI can show them.
type CommandResult<T> = Result<T, String>;

fn to_message(err: anyhow::Error) -> String {
    err.to_string()
}

#[tauri::command]
fn list_audio_inputs() -> CommandResult<Vec<AudioDevice>> {
    audio::list_input_devices().map_err(to_message)
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> CommandResult<SettingsView> {
    let settings = settings::load(&app).map_err(to_message)?;
    Ok(view(settings))
}

fn view(mut settings: Settings) -> SettingsView {
    // The pairing tokens are not the window's business.
    //
    // They are derived secrets: whoever holds one can receive whatever this
    // desk stages. The webview has no use for them -- it shows the *names* of
    // paired screens, which the mirror state carries separately -- and the same
    // rule that keeps an Azure key out of the settings file keeps these out of
    // the UI. `save_settings` puts the stored ones back, so a view that never
    // saw them cannot send back an empty list and forget every screen.
    settings.mirror_pairings = Vec::new();

    SettingsView {
        settings,
        has_assist_key: settings::has_assist_key(),
        has_hosted_subscription: settings::has_hosted_token(),
    }
}

/**
 * Points the listener at the current settings and the installed translations.
 *
 * Rebuilt rather than mutated whenever either changes, because it holds the
 * names every translation answers to -- and a church that has just downloaded
 * the ESV should be able to ask for it by name without restarting.
 */
fn apply_voice(app: &tauri::AppHandle, detector: &Arc<Detector>, settings: &Settings) {
    // The wake word may be empty. It is a second way to be heard, not the thing
    // that makes listening possible: without one an instruction still works, it
    // just has to be the whole of what was said.
    if !settings.voice_commands {
        detector.set_commands(None);
        return;
    }
    let named: Vec<(String, String)> = app
        .try_state::<Arc<Library>>()
        .map(|library| {
            library
                .translations()
                .unwrap_or_default()
                .into_iter()
                .map(|t| (t.id, t.name))
                .collect()
        })
        .unwrap_or_default();

    // Book names from the translation being read, so a reference said aloud is
    // matched against the spellings this library actually has -- and a Catholic
    // canon's extra books can be asked for by name like any other.
    let books: Vec<String> = app
        .try_state::<Arc<Library>>()
        .map(|library| {
            library
                .books(&settings.translation)
                .unwrap_or_default()
                .into_iter()
                .map(|book| book.name)
                .collect()
        })
        .unwrap_or_default();

    detector.set_commands(Some(castavox_core::commands::Listener::new(
        &settings.wake_word,
        &named,
        &books,
        &settings.voice_phrases,
    )));
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    detector: State<'_, Arc<Detector>>,
    assistant: State<'_, Arc<Assistant>>,
    semantic: State<'_, Arc<Semantic>>,
    settings: Settings,
) -> CommandResult<SettingsView> {
    // Read before the save, so the engine can be compared against what it was.
    let was = settings::load(&app).ok();

    // The window was never given the pairing tokens (see `view`), so what it
    // sends back has none. Taking them from disk rather than from the caller is
    // what stops a save from the settings dialog forgetting every paired
    // screen.
    let mut settings = settings;
    settings.mirror_pairings = was.as_ref().map(|old| old.mirror_pairings.clone()).unwrap_or_default();

    settings::save(&app, &settings).map_err(to_message)?;

    // Switching to local without naming a model is allowed, and is the ordinary
    // case: the dialog no longer insists on one. This picks one and fetches it,
    // exactly as a first launch does, so the settings on disk may now hold a
    // model the caller did not send -- which is why the view below is read back
    // rather than echoing the argument.
    provision_local_model(&app);
    let settings = settings::load(&app).unwrap_or(settings);

    // Reaches a session already listening: the model is picked up between
    // utterances, and changing engine replaces the recogniser while capture
    // keeps going. Without this, both would wait for a restart.
    //
    // Only when the engine actually changed. Signalled on every save, adjusting
    // the paraphrase threshold would rebuild the recogniser mid-service, which
    // is exactly the interruption this exists to avoid.
    if let Some(speech) = app.try_state::<Arc<SpeechManager>>() {
        let engine_moved = was.as_ref().is_none_or(|old| old.speech_engine != settings.speech_engine);
        if engine_moved {
            speech.engine_changed();
        } else {
            speech.model_changed();
        }
    }
    apply_voice(&app, &detector, &settings);

    /*
     * Every open output's feed follows what was just saved.
     *
     * On a thread of its own: this is a synchronous command, so it runs on
     * the main thread, and starting a capture can wait up to three seconds
     * for a window macOS has not listed yet. The dialog saves as it is
     * changed; it must not freeze while it does.
     */
    {
        let app = app.clone();
        let saved = settings.clone();
        std::thread::spawn(move || {
            // Windows first: a rebuilt window is a new window, and its feed
            // has to find that one rather than the one that just went.
            if let Some(projector) = app.try_state::<Arc<Projector>>() {
                projector.refit(&saved.outputs);
            }
            if let Some(senders) = app.try_state::<NdiOutputs>() {
                senders.reconcile(&app, &saved);
            }
        });
    }

    if let Some(mirror) = app.try_state::<Arc<mirror::Mirror>>() {
        mirror.configure(&settings);
    }
    detector.set_translation(&settings.translation);
    assistant.configure(&settings);
    // Switching translation invalidates the index; configure() rebuilds it.
    semantic.configure(&settings);

    allow_asset(&app, settings.projector.background_path.as_deref());
    // The projector window applies this without being reopened.
    let _ = app.emit(projector::EVENT_THEME, &settings.projector);

    Ok(view(settings))
}

/// Widens the asset-protocol scope to exactly one file the operator chose.
///
/// The scope ships empty, so the webview can read no arbitrary file. Each
/// picked background or imported image is allowed individually rather than
/// opening up the directory it happened to be sitting in.
fn allow_asset(app: &tauri::AppHandle, path: Option<&str>) {
    let Some(path) = path.filter(|path| !path.is_empty()) else { return };
    if let Err(err) = app.asset_protocol_scope().allow_file(path) {
        crate::log_line!("[assets] could not grant access to {path}: {err}");
    }
}

#[tauri::command]
fn set_background(
    app: tauri::AppHandle,
    path: Option<String>,
) -> CommandResult<()> {
    allow_asset(&app, path.as_deref());
    Ok(())
}

/// A line from the window into the same log the rest of the application uses.
///
/// The two halves of a voice command fail in ways that look identical from
/// outside -- not heard, and heard but not acted on -- and only the Rust half
/// could say anything. A window that cannot write to the log leaves the more
/// interesting half of every such question unanswerable.
#[tauri::command]
fn note(line: String) {
    log_line!("[window] {}", line.chars().take(300).collect::<String>());
}

/// Starts following a deck, or stops when given none.
///
/// The slides arrive as text because only the window knows what a deck is: it
/// holds the sections, their headings and their order. Embedding happens here,
/// where the model already lives.
///
/// Off by default and switched on per service rather than remembered. A church
/// that followed one sermon has not asked to follow every service afterwards,
/// and a deck being watched from a previous week is a suggestion nobody can
/// account for.
#[tauri::command]
async fn follow_deck(
    semantic: State<'_, Arc<Semantic>>,
    follower: State<'_, Arc<follow::Follower>>,
    slides: Vec<String>,
    advance: bool,
    at: Option<usize>,
) -> CommandResult<bool> {
    follower.set_advance(advance);

    if slides.is_empty() {
        follower.forget();
        return Ok(false);
    }

    let vectors = match semantic.embed_texts(&slides) {
        Ok(vectors) => vectors,
        Err(why) => {
            // Said out loud: this is the step that needs the embedding model,
            // and a church whose model is missing would otherwise see a button
            // that turns on and never does anything.
            log_line!("[follow] could not embed the deck: {why:#}");
            return Err(to_message(why));
        }
    };
    follower.watch(vectors, at);
    Ok(true)
}

/// Where the staged deck is now.
///
/// Sent whenever the operator moves, by hand or by voice. The follower weighs
/// it: a deck is presented in order, and a slide behind the speaker is the
/// less likely answer -- which is information the similarity does not contain
/// and cannot be recovered by any amount of tuning it.
#[tauri::command]
fn follow_at(follower: State<'_, Arc<follow::Follower>>, index: usize) {
    follower.at(index);
}

#[tauri::command]
fn get_stage(projector: State<'_, Arc<Projector>>) -> projector::StageState {
    projector.stage()
}

#[tauri::command]
fn set_stage(
    projector: State<'_, Arc<Projector>>,
    state: projector::StageState,
) -> projector::StageState {
    projector.set_stage(state)
}

#[tauri::command]
fn get_theme(app: tauri::AppHandle) -> CommandResult<ProjectorTheme> {
    Ok(settings::load(&app).map_err(to_message)?.projector)
}

/// The theme one congregation-facing window should draw with.
///
/// Asked by the window, of itself, rather than pushed to all of them. That is
/// the whole difference between two outputs and several: content is broadcast
/// because every screen must agree about what is live, and appearance is
/// fetched because they need not agree about anything else.
///
/// An output with no template of its own gets the shared theme -- which is
/// what both windows always had, and what a church that never opens the
/// outputs pane keeps.
#[tauri::command]
fn theme_for_window(
    app: tauri::AppHandle,
    catalog: State<'_, Arc<catalog::Catalog>>,
    label: String,
) -> CommandResult<WindowLook> {
    let settings = settings::load(&app).map_err(to_message)?;

    let found = settings
        .outputs
        .iter()
        .find(|output| projector::label_for(&output.id) == label);

    // Empty for the two original windows, which are whole-screen outputs and
    // have no row in this list to carry an overlay.
    let overlay = found
        .map(|output| output.overlay.trim().to_string())
        .filter(|form| !form.is_empty())
        .unwrap_or_else(|| "none".to_string());
    let template = found.map(|output| output.template.trim().to_string()).unwrap_or_default();
    // Empty follows the Scripture panel, which is what every window did and
    // what most churches want: one Bible in the building.
    let translation =
        found.map(|output| output.translation.trim().to_string()).unwrap_or_default();
    let uppercase = found.is_some_and(|output| output.uppercase);
    // True for a window with no row of its own, which is the shipped stage
    // display: both halves on unless somebody turns one off.
    let stage_clock = found.map_or(true, |output| output.stage_clock);
    let stage_live = found.map_or(true, |output| output.stage_live);

    if template.is_empty() {
        return Ok(WindowLook {
            theme: settings.projector,
            overlay,
            translation,
            uppercase,
            stage_clock,
            stage_live,
        });
    }

    // A template the operator has since deleted falls back to the shared theme
    // rather than to nothing. A blank screen in front of a congregation is the
    // worst reading of "that template is gone".
    let found = template
        .parse::<i64>()
        .ok()
        .and_then(|id| catalog.get(id).ok().flatten())
        .and_then(|item| match item.body {
            catalog::ItemBody::Template { theme } => Some(*theme),
            _ => None,
        });

    Ok(WindowLook {
        theme: found.unwrap_or(settings.projector),
        overlay,
        translation,
        uppercase,
        stage_clock,
        stage_live,
    })
}

/// How one window should draw: its look, and the shape it draws in.
///
/// Both at once because the window needs both before it can paint anything,
/// and two round trips would let it paint once wrongly first.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLook {
    pub theme: ProjectorTheme,
    /// The overlay form, or "none" for the whole screen.
    pub overlay: String,
    /// The translation this window draws scripture in. Empty follows the panel.
    pub translation: String,
    /// Whether this window sets its words in capitals.
    pub uppercase: bool,
    /// A stage display's two halves, each of which can be turned off.
    pub stage_clock: bool,
    pub stage_live: bool,
}

/// Searching the Songbook, which is the subscription's catalogue of songs.
///
/// Blocking work on a worker thread: it is a network call, and a search box
/// that froze the desk while somebody typed would be worse than no search.
#[tauri::command]
async fn songbook_search(query: String, limit: Option<usize>) -> CommandResult<Vec<songbook::Hit>> {
    tauri::async_runtime::spawn_blocking(move || songbook::search(&query, limit.unwrap_or(40)))
        .await
        .map_err(|err| err.to_string())?
        .map_err(to_message)
}

/// One song's words, for the pane that shows what would be added.
#[tauri::command]
async fn songbook_get(id: String) -> CommandResult<songbook::Song> {
    tauri::async_runtime::spawn_blocking(move || songbook::song(&id))
        .await
        .map_err(|err| err.to_string())?
        .map_err(to_message)
}

/// Adds a Songbook song to this church's own library.
///
/// It is theirs from that moment: editable, exportable, and unaffected by
/// anything that later happens to the subscription. Nothing is kept pointing
/// back at the catalogue, because a song a church has is not a licence they are
/// renting.
#[tauri::command]
async fn songbook_add(
    catalog: State<'_, Arc<Catalog>>,
    id: String,
) -> CommandResult<Item> {
    let song = tauri::async_runtime::spawn_blocking(move || songbook::song(&id))
        .await
        .map_err(|err| err.to_string())?
        .map_err(to_message)?;

    catalog.save(&songbook::as_item(&song)).map_err(to_message)
}

/// The typefaces this machine has, for the pickers in Settings and the studio.
///
/// Read on demand rather than at launch: it is a few milliseconds of platform
/// call that nothing needs until somebody opens a font list, and a church that
/// never changes a typeface should not pay for it at all.
#[tauri::command]
fn list_fonts() -> Vec<String> {
    fonts::families()
}

#[tauri::command]
fn semantic_status(semantic: State<'_, Arc<Semantic>>) -> IndexStatus {
    semantic.status()
}

/// A verse found by meaning, and how close it came.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub verse: Verse,
    /// Cosine similarity, 0 to 1. Shown, because "how sure is this" is the
    /// question an operator asks of a search that matched no words.
    pub score: f32,
}

/// Searching the Bible by what a passage says rather than by what it spells.
///
/// The index has been here since paraphrase matching shipped and only speech
/// could reach it, which left an operator who *remembers* a passage without
/// remembering its words — "the one about the widow's offering" — with nothing
/// but a reference lookup that cannot help them.
///
/// An empty list is a real answer, not a failure: nothing came close enough.
/// Whether the index exists at all is a separate question, and the panel asks
/// it with `semantic_status` before searching.
#[tauri::command]
fn semantic_search(
    semantic: State<'_, Arc<Semantic>>,
    text: String,
    limit: Option<usize>,
) -> CommandResult<Vec<Found>> {
    let found = semantic.search(&text, limit.unwrap_or(20)).map_err(to_message)?;
    Ok(found
        .into_iter()
        .map(|(verse, score)| Found { verse, score })
        .collect())
}

#[tauri::command]
fn save_assist_key(
    app: tauri::AppHandle,
    assistant: State<'_, Arc<Assistant>>,
    key: String,
) -> CommandResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("The model key cannot be empty.".into());
    }
    settings::save_assist_key(key).map_err(to_message)?;
    // Pick the new key up without waiting for the next settings save.
    if let Ok(settings) = settings::load(&app) {
        assistant.configure(&settings);
    }
    Ok(())
}

#[tauri::command]
fn clear_assist_key(
    app: tauri::AppHandle,
    assistant: State<'_, Arc<Assistant>>,
) -> CommandResult<()> {
    settings::clear_assist_key().map_err(to_message)?;
    if let Ok(settings) = settings::load(&app) {
        assistant.configure(&settings);
    }
    Ok(())
}

/// One real request to the church's own model, so they learn it works now
/// rather than during a service.
///
/// Takes what is in the dialog rather than what is saved: an operator testing
/// a new address has not pressed Save yet, and asking them to save a setting
/// before they can find out whether it is right has it backwards. The key is
/// the same -- freshly typed if they typed one, otherwise the stored one.
///
/// Blocking, on a thread of its own: this waits on somebody else's model, and
/// a local one on a busy laptop can take tens of seconds.
#[tauri::command]
async fn test_assist_model(
    endpoint: String,
    model: String,
    api_version: String,
    shape: String,
    key: Option<String>,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = match key.map(|typed| typed.trim().to_string()) {
            Some(typed) if !typed.is_empty() => typed,
            // Nothing typed, so they are testing the key already in the
            // credential store. An empty one falls through to "fill it in".
            _ => settings::load_assist_key().ok().flatten().unwrap_or_default(),
        };
        let deployment = castavox_core::assistant::Deployment {
            endpoint: endpoint.trim().to_string(),
            model: model.trim().to_string(),
            api_version: api_version.trim().to_string(),
            shape: assist::shape_of(&shape),
        };
        let client = reqwest::blocking::Client::builder()
            // Long enough for a small model on a church laptop, short enough
            // that a wrong address does not hold the dialog for a minute.
            .timeout(std::time::Duration::from_secs(45))
            .build()
            .map_err(|error| error.to_string())?;
        castavox_core::assistant::check(
            &client,
            &castavox_core::assistant::Route::Own { deployment: &deployment, key: &key },
        )
    })
    .await
    .map_err(|error| format!("The test could not be run: {error}"))?
}

#[tauri::command]
fn start_transcription(manager: State<'_, Arc<SpeechManager>>) -> CommandResult<()> {
    manager.start().map_err(to_message)
}

#[tauri::command]
fn stop_transcription(manager: State<'_, Arc<SpeechManager>>) -> CommandResult<()> {
    manager.stop();
    Ok(())
}

/// Whether the machine has a Node runtime the sidecar can use.
#[tauri::command]
fn node_status() -> node::NodeStatus {
    node::status()
}

/// Which whisper.cpp models exist and which are already here.
///
/// Asked of whisper.cpp's own repository rather than listed in this app, so it
/// gains new models without a release and the sizes are whatever the files
/// actually are. Works offline, reporting what is already downloaded.
#[tauri::command]
async fn speech_models(app: AppHandle) -> CommandResult<Vec<whisper::ModelInfo>> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // Off the UI thread: this reaches the network.
    tauri::async_runtime::spawn_blocking(move || whisper::catalogue(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// Chooses and fetches a speech model for a machine that has none.
///
/// The local engine used to open on a question — thirty model files, sizes from
/// 30 MB to 1.5 GB, and a settings dialog that would not save until one was
/// picked. A volunteer cannot answer that. Nothing in it says whether this
/// laptop keeps up with `base` or `small`, so the question went unanswered, the
/// engine that costs nothing sat unusable behind it, and local transcription
/// read as not working.
///
/// So the machine is measured instead and one is chosen. At launch rather than
/// at Start: this is up to 466 MB over whatever connection the church has, and
/// Sunday morning is the wrong time to discover that. Progress goes out as the
/// same `speech-model-progress` events the settings dialog already draws.
///
/// Does nothing unless the engine is local and no model has been chosen: an
/// operator who picked one has answered the question, and re-answering it for
/// them would be worse than never asking.
fn provision_local_model(app: &AppHandle) {
    let Ok(mut settings) = settings::load(app) else { return };
    if settings.speech_engine != "local" || !settings.speech_model.trim().is_empty() {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else { return };

    let file = whisper::recommended(&settings.language);
    settings.speech_model = file.clone();
    if let Err(error) = settings::save(app, &settings) {
        crate::log_line!("[speech] could not record the chosen model: {error:#}");
        return;
    }
    crate::log_line!("[speech] chose {file} for this machine");

    if whisper::is_installed(&dir, &file) {
        return;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let report = |received: u64, total: u64| {
            let _ = handle.emit(
                "speech-model-progress",
                serde_json::json!({
                    "file": file, "received": received, "total": total, "state": "downloading",
                }),
            );
        };
        let payload = match whisper::download(&dir, &file, report) {
            Ok(_) => serde_json::json!({ "file": file, "state": "ready" }),
            // Reported and not retried. There is no network, or no disk, and an
            // app that quietly tries again every launch is how a church on a
            // metered connection finds out later.
            Err(error) => {
                crate::log_line!("[speech] could not fetch {file}: {error:#}");
                serde_json::json!({ "file": file, "state": "error", "error": format!("{error:#}") })
            }
        };
        let _ = handle.emit("speech-model-progress", payload);
    });
}

/// How fast this machine decodes.
///
/// Answered by measuring rather than by reasoning about the processor. Every
/// version of that reasoning has been wrong in one direction or the other, and
/// four seconds of decoding settles it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechSpeed {
    /// Seconds of work per second of audio. Below 1.0 is faster than speech.
    factor: f32,
    detail: String,
}

/// Where a check-in goes. The broker, which derives the country at its edge and
/// discards the address before anything is written down.
const CHECK_IN_ENDPOINT: &str = "https://castavox.com/api/v1/check-in";

/// Where the tally of what a church has made goes. Informational only.
const MADE_ENDPOINT: &str = "https://castavox.com/api/v1/made";

/// Where a report goes, to be sent on by the broker.
///
/// Posted rather than opened as a mail link. A church laptop with no mail
/// client configured is exactly the machine most likely to have something to
/// report, and there the link does nothing at all -- and the operator is often
/// not the person whose email account is on the machine.
const FEEDBACK_ENDPOINT: &str = "https://castavox.com/api/v1/feedback";

/**
 * Sends a report to the broker, which mails it on.
 *
 * In Rust rather than from the window because the window cannot reach another
 * origin -- the content policy that keeps a projector from loading anything off
 * the network also stops this, and loosening it for one form would be paying
 * for a form with the thing that makes the application safe to run.
 *
 * Errors are returned rather than swallowed, unlike the check-in. Somebody is
 * watching this one: they pressed send. A silent failure would leave a church
 * believing it reported something nobody will ever read.
 */
#[tauri::command]
async fn send_feedback(
    kind: String,
    text: String,
    email: String,
    platform: String,
) -> CommandResult<()> {
    let body = serde_json::json!({
        "kind": kind,
        "app": "Pulpitry",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": platform,
        "email": email,
        "text": text,
    });

    let response = reqwest::Client::new()
        .post(FEEDBACK_ENDPOINT)
        .json(&body)
        // Long enough for a slow hall connection, short enough that somebody
        // is not left watching a spinner wondering whether to press it again.
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| format!("That could not be sent. {error}"))?;

    if response.status().is_success() {
        return Ok(());
    }

    // The broker words this for a church; passing it through beats inventing a
    // second sentence that says the same thing differently.
    let message = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|body| body.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or_else(|| "That could not be sent just now.".into());
    Err(message)
}

#[tauri::command]
async fn measure_speech(
    app: AppHandle,
    manager: State<'_, Arc<SpeechManager>>,
) -> CommandResult<SpeechSpeed> {
    /*
     * What this machine has actually done beats what a benchmark says it might.
     *
     * The benchmark decodes a synthetic clip, and it turned out to report
     * whatever the clip length implied rather than anything about the hardware:
     * whisper pads every decode to a thirty-second window, so the same laptop
     * reads 16x from one second of audio and 422x from twenty-nine, having done
     * identical work. It also decodes silence, which whisper short-circuits, so
     * the decoder -- the part a processor without a GPU is slowest at -- never
     * runs.
     *
     * A session that has been running has real speech behind it, at the lengths
     * the preacher actually speaks in. When there is one, it answers.
     */
    if let Some(factor) = manager.inner().sustained() {
        return Ok(SpeechSpeed { factor, detail: whisper::describe_speed(factor) });
    }

    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let model = settings::load(&app).map(|s| s.speech_model).unwrap_or_default();

    // Off the UI thread: it decodes twice, and the window has to keep painting.
    tauri::async_runtime::spawn_blocking(move || match whisper::measure(&dir, &model) {
        Ok(factor) => SpeechSpeed { factor, detail: whisper::describe_speed(factor) },
        // Almost always "not downloaded yet", which is a thing to wait for
        // rather than a fault.
        Err(error) => SpeechSpeed {
            factor: 0.0,
            detail: format!("Could not measure this machine: {error:#}"),
        },
    })
    .await
    .map_err(|e| e.to_string())
}

/// Fetches a model, reporting progress as `speech-model-progress` events.
#[tauri::command]
async fn download_speech_model(app: AppHandle, file: String) -> CommandResult<()> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = |received: u64, total: u64| {
            let _ = handle.emit(
                "speech-model-progress",
                serde_json::json!({
                    "file": file, "received": received, "total": total, "state": "downloading",
                }),
            );
        };
        let payload = match whisper::download(&dir, &file, report) {
            Ok(_) => serde_json::json!({ "file": file, "state": "ready" }),
            Err(error) => serde_json::json!({
                "file": file, "state": "error", "error": format!("{error:#}"),
            }),
        };
        let _ = handle.emit("speech-model-progress", payload);
    });
    Ok(())
}

#[tauri::command]
fn speech_status(manager: State<'_, Arc<SpeechManager>>) -> SpeechStatus {
    manager.status()
}

#[tauri::command]
fn library_status(library: State<'_, Arc<Library>>) -> CommandResult<LibraryStatus> {
    library.status().map_err(to_message)
}

/*
 * The scripture library: what a church has, and what it can have.
 *
 * The catalogue is fetched rather than compiled in, so a translation added next
 * month appears in a church's list without an application update. That is the
 * difference between adding a translation and shipping a release to add one,
 * and it is why the URL below points at a file rather than at a version.
 */
const TRANSLATION_CATALOGUE: &str =
    "https://raw.githubusercontent.com/aysmart/castavox-downloads/main/translations/catalogue.json";

/// Where the packs sit, which is beside the catalogue that names them.
const TRANSLATION_PACKS: &str =
    "https://raw.githubusercontent.com/aysmart/castavox-downloads/main/translations";

/// One row of the library, as the operator reads it.
///
/// The catalogue and the installed table are joined here rather than in the
/// window, because the interesting states are the ones a naive join gets wrong:
/// a translation installed from an older catalogue that has since been
/// withdrawn is still installed and must still be listed, and a translation
/// installed at a size the catalogue no longer quotes should report the size it
/// actually is.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Offered {
    id: String,
    name: String,
    year: i64,
    /// Empty for anything the catalogue does not describe, which the window
    /// groups under "Installed" rather than inventing a language for.
    language: String,
    /// Compressed download size. Zero when it is installed and no longer
    /// offered, where there is nothing to download and so nothing to warn about.
    bytes: u64,
    verse_count: i64,
    installed: bool,
    /// What a church should know before choosing it: a translation that is not
    /// a whole Bible, or one short of chapters the source could not give us.
    note: Option<String>,
    licence: Option<String>,
    attribution: Option<String>,
}

/// Everything a church could read, whether or not this machine holds it.
///
/// Fails loudly when the catalogue cannot be reached. The window already knows
/// what is installed -- it asked for that separately and shows it regardless --
/// so the only thing lost to a hall with no internet is the list of things that
/// would need internet anyway.
#[tauri::command]
async fn translation_library(library: State<'_, Arc<Library>>) -> CommandResult<Vec<Offered>> {
    let installed = library.translations().map_err(to_message)?;

    let catalogue = tauri::async_runtime::spawn_blocking(|| {
        castavox_core::packs::catalogue(TRANSLATION_CATALOGUE)
    })
    .await
    .map_err(|error| format!("The catalogue could not be read. {error}"))?
    .map_err(to_message)?;

    let mut offered: Vec<Offered> = catalogue
        .into_iter()
        .map(|pack| {
            let here = installed.iter().find(|t| t.id == pack.id);
            Offered {
                verse_count: here.map_or(pack.verse_count, |t| t.verse_count),
                installed: here.is_some(),
                // Nothing to download once it is here, and a size beside an
                // installed translation reads as a cost rather than a fact.
                bytes: if here.is_some() { 0 } else { pack.bytes },
                id: pack.id,
                name: pack.name,
                year: pack.year,
                language: pack.language,
                note: pack.note,
                licence: pack.licence,
                attribution: pack.attribution,
            }
        })
        .collect();

    // Anything installed that the catalogue no longer offers. A church that
    // downloaded it last year still reads from it every Sunday, and a library
    // that omits it would be telling them it is gone.
    for translation in installed {
        if offered.iter().any(|o| o.id == translation.id) {
            continue;
        }
        offered.push(Offered {
            id: translation.id,
            name: translation.name,
            year: translation.year,
            language: String::new(),
            bytes: 0,
            verse_count: translation.verse_count,
            installed: true,
            note: None,
            licence: None,
            attribution: None,
        });
    }

    Ok(offered)
}

/// How a download is going, for the row that shows it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslationProgress {
    id: String,
    received: u64,
    total: u64,
    /// Set once the rows are in and the library has changed.
    done: bool,
}

/**
 * Downloads one translation and puts it in the library.
 *
 * Blocking work on a blocking thread: the download is a socket read loop and
 * the import is a SQLite transaction, and neither belongs on the thread that
 * answers the window.
 *
 * The order is deliberate. The file is fetched and its SHA-256 checked before
 * anything touches the database, and the import is a transaction, so the two
 * states a church can be left in are "as it was" and "with the translation".
 * There is no third state where a Bible has holes in it.
 *
 * The pack is deleted afterwards. It is 1.3 MB of a file whose contents are now
 * rows in a database, and a church that removes the translation later should
 * get the disk back rather than most of it.
 */
#[tauri::command]
async fn install_translation(
    app: AppHandle,
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<()> {
    let library = Arc::clone(&library);
    let into = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("There is nowhere to download to. {error}"))?
        .join("packs");

    tauri::async_runtime::spawn_blocking(move || {
        let catalogue = castavox_core::packs::catalogue(TRANSLATION_CATALOGUE)?;
        let pack = catalogue
            .into_iter()
            .find(|pack| pack.id == id)
            .with_context(|| format!("{id} is not in the catalogue"))?;

        // Percentage, not bytes: a row that repaints on every 64 KB chunk is
        // work nobody can see, and the number the operator reads changes a
        // hundred times at most.
        let last = std::sync::atomic::AtomicU64::new(u64::MAX);
        let handle = app.clone();
        let downloaded = castavox_core::packs::download(&pack, TRANSLATION_PACKS, &into, |p| {
            let percent = if p.total > 0 { p.received * 100 / p.total } else { 0 };
            if last.swap(percent, std::sync::atomic::Ordering::Relaxed) == percent {
                return;
            }
            let _ = handle.emit(
                "translation-progress",
                TranslationProgress {
                    id: pack.id.clone(),
                    received: p.received,
                    total: p.total,
                    done: false,
                },
            );
        })?;

        let result = library.install(&pack, &downloaded);
        // Removed whether or not the import worked. A failed import is retried
        // by downloading again, which is a few seconds, and a kept pack is a
        // file that looks like part of the library and is not.
        let _ = std::fs::remove_file(&downloaded);
        result?;

        announce(&app, &library);
        let _ = app.emit(
            "translation-progress",
            TranslationProgress { id: pack.id, received: 0, total: 0, done: true },
        );
        anyhow::Ok(())
    })
    .await
    .map_err(|error| format!("The download could not be started. {error}"))?
    .map_err(to_message)
}

/// Removes a translation, its search index and its meaning index.
#[tauri::command]
async fn remove_translation(
    app: AppHandle,
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<()> {
    let library = Arc::clone(&library);
    tauri::async_runtime::spawn_blocking(move || {
        let removed = library.remove(&id);
        if removed.is_ok() {
            announce(&app, &library);
        }
        removed
    })
    .await
    .map_err(|error| format!("That could not be removed. {error}"))?
    .map_err(to_message)
}

/**
 * Tells every window the library changed.
 *
 * The same event the first-run import sends, so a translation downloaded or
 * removed reaches the chapter browser and the translation setting by the route
 * they already listen on. Threading a callback from the library screen to each
 * of them instead would mean a list that is right where somebody is looking and
 * stale one screen over -- which is how an operator ends up choosing a
 * translation that is no longer on the machine.
 *
 * Best effort. A window that has gone away is not a reason to fail a removal
 * that has already happened.
 */
fn announce(app: &AppHandle, library: &Library) {
    if let Ok(status) = library.status() {
        let _ = app.emit(bible::EVENT_LIBRARY, status);
    }
    // The listener holds the names every translation answers to, so one just
    // downloaded should be askable for by name and one just removed should
    // stop being.
    if let Some(detector) = app.try_state::<Arc<Detector>>() {
        apply_voice(app, &detector, &settings::load(app).unwrap_or_default());
    }
}

/// The senders for the configured outputs, one per output that asked for one.
///
/// Keyed by output id so closing one output cannot take another off the air --
/// which, on a Sunday, is somebody's stream.
#[derive(Default)]
struct NdiOutputs {
    running: std::sync::Mutex<std::collections::HashMap<String, Running>>,
    /// Why an output that asked to be on the network is not, in words for the
    /// operator.
    ///
    /// Kept until it next starts or is switched off, so the Displays dialog can
    /// say so. A failure that reached only the log is a feed a church finds
    /// missing during the service: a Mac that had not been given Screen
    /// Recording once published nothing, said nothing, and looked exactly
    /// like a network problem.
    problems: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// Held while a feed is being started, so that pressing Open and the
    /// dialog's save arriving together cannot start the same feed twice.
    turn: std::sync::Mutex<()>,
}

/// A running sender and what it was started as.
struct Running {
    /// Dropping it takes the source off the network. Never read otherwise.
    _sender: ndi_output::Output,
    shape: FeedShape,
}

/// Everything about a feed that needs a restart to change.
#[derive(PartialEq)]
struct FeedShape {
    name: String,
    fps: u32,
    keyable: bool,
    /// The frame size, for an output with no screen. One on a monitor takes
    /// the monitor's.
    size: Option<(u32, u32)>,
}

impl FeedShape {
    fn of(output: &settings::Output) -> Self {
        let name = if output.ndi_name.trim().is_empty() {
            format!("Pulpitry — {}", output.name.trim())
        } else {
            output.ndi_name.trim().to_string()
        };
        Self {
            name,
            fps: output.fps,
            keyable: output.is_overlay(),
            size: output.display.is_none().then_some((output.width, output.height)),
        }
    }
}

impl NdiOutputs {
    /// Publishes one output's window, replacing any sender it already had.
    ///
    /// Failure is logged, kept for the dialog, and otherwise swallowed. A
    /// church that has not installed the NDI runtime should still get their
    /// screen: the window is the thing they asked for and the feed is the
    /// extra.
    fn start(&self, app: &AppHandle, output: &settings::Output) {
        let _turn = self.turn.lock();
        self.start_now(app, output);
    }

    fn start_now(&self, app: &AppHandle, output: &settings::Output) {
        // The old one first: a rename has to take the old name off the network
        // before the new one appears, or a switcher briefly lists both.
        self.stop(&output.id);

        // The title the window actually has. A custom output's title carries
        // its name, and one renamed since it opened still has the old one --
        // looked for by the new, it would be reported as not open.
        let title = app
            .get_webview_window(&projector::label_for(&output.id))
            .and_then(|window| window.title().ok())
            .unwrap_or_else(|| projector::title_for(&output.id, &output.name));
        let shape = FeedShape::of(output);

        match ndi_output::Output::start_window(
            &title,
            &shape.name,
            shape.fps,
            shape.keyable,
            shape.size,
        ) {
            Ok(sender) => {
                if let Ok(mut running) = self.running.lock() {
                    running.insert(output.id.clone(), Running { _sender: sender, shape });
                }
            }
            Err(why) => {
                log_line!("[ndi] {} could not be published: {why}", output.name);
                if let Ok(mut problems) = self.problems.lock() {
                    problems.insert(output.id.clone(), why);
                }
            }
        }
    }

    /// Takes one output off the network. Dropping the sender is what stops it.
    fn stop(&self, id: &str) {
        let gone = self.running.lock().ok().and_then(|mut running| running.remove(id));
        // Dropped outside the lock: dropping joins the sender's thread, and the
        // dialog asking for state should not wait on that.
        drop(gone);
        if let Ok(mut problems) = self.problems.lock() {
            problems.remove(id);
        }
    }

    /// Whether an output is on the network, and if it asked to be and is not, why.
    fn state(&self, id: &str) -> (bool, Option<String>) {
        let sending = self.running.lock().map(|running| running.contains_key(id)).unwrap_or(false);
        let problem = self.problems.lock().ok().and_then(|problems| problems.get(id).cloned());
        (sending, problem)
    }

    /// Brings every open output's feed into line with its settings.
    ///
    /// # Why this exists
    ///
    /// The Displays dialog saves as it is changed, and a feed used to follow
    /// only the Open button: ticking "Send this on the network" on an output
    /// already on a screen did nothing until it was closed and opened again,
    /// and neither did renaming the source. An operator reads that as "NDI
    /// does not work", and was right to.
    ///
    /// A feed whose name, rate and keyability are unchanged is left alone, so
    /// a save that touched something else does not blink a live source.
    fn reconcile(&self, app: &AppHandle, settings: &Settings) {
        let _turn = self.turn.lock();
        let open = |output: &&settings::Output| {
            app.get_webview_window(&projector::label_for(&output.id)).is_some()
        };

        // Off, closed, or no longer an output at all.
        let wanted: Vec<&str> = settings
            .outputs
            .iter()
            .filter(open)
            .filter(|output| output.ndi_enabled)
            .map(|output| output.id.as_str())
            .collect();
        let unwanted: Vec<String> = self
            .running
            .lock()
            .map(|running| {
                running.keys().filter(|id| !wanted.contains(&id.as_str())).cloned().collect()
            })
            .unwrap_or_default();
        for id in unwanted {
            self.stop(&id);
        }

        for output in settings.outputs.iter().filter(open).filter(|output| output.ndi_enabled) {
            let unchanged = self
                .running
                .lock()
                .map(|running| {
                    running.get(&output.id).is_some_and(|live| live.shape == FeedShape::of(output))
                })
                .unwrap_or(false);
            if !unchanged {
                self.start_now(app, output);
            }
        }
    }
}

/// Starts or stops one output's feed to match its settings.
///
/// Called whenever an output's window appears, from whichever button opened
/// it: there is nothing to capture before the window exists, so starting the
/// sender first would fail on an absent window and report it as a missing
/// projector. The window appearing is the moment this becomes possible, which
/// makes here the right place rather than a convenient one.
fn feed_follows(app: &AppHandle, senders: &NdiOutputs, id: &str) {
    let settings = settings::load(app).unwrap_or_default();
    match settings.outputs.iter().find(|output| output.id == id) {
        Some(output) if output.ndi_enabled => senders.start(app, output),
        _ => senders.stop(id),
    }
}

/// What NDI sources this machine can see, ours included.
///
/// Asked on demand rather than with the status, because it costs two seconds of
/// discovery and the dialog opens far more often than anybody wonders whether
/// the network is carrying the feed.
#[tauri::command]
async fn ndi_sources() -> Vec<String> {
    // On a thread: discovery blocks, and blocking the async runtime stalls
    // every other command the window is waiting on.
    tauri::async_runtime::spawn_blocking(ndi_output::Output::visible_sources)
        .await
        .unwrap_or_default()
}

/// Who the bundled texts belong to, for the About dialog.
///
/// The Biblica editions and the Free Bible Version are CC BY-SA: naming them is
/// a condition of being allowed to ship the text, so this is read from the
/// manifest rather than typed into the dialog, where it would drift the first
/// time a translation was added or dropped.
#[tauri::command]
fn bible_attributions(app: AppHandle, library: State<'_, Arc<Library>>) -> Vec<String> {
    library.attributions(&app)
}

/// The Greek or Hebrew behind one verse, for the operator's screen.
///
/// Never the projector. A congregation is not reading morphology codes, and an
/// interlinear on a wall is a distraction wearing the clothes of scholarship.
#[tauri::command]
fn original_words(
    library: State<'_, Arc<Library>>,
    book: String,
    chapter: i64,
    verse: i64,
) -> CommandResult<Vec<bible::OriginalWord>> {
    library.original(&book, chapter, verse).map_err(to_message)
}

/// What a Strong's number means. Asked when the operator opens a word.
#[tauri::command]
fn lexicon_entry(
    library: State<'_, Arc<Library>>,
    strongs: String,
) -> CommandResult<Option<bible::LexiconEntry>> {
    library.lexicon(&strongs).map_err(to_message)
}

/**
 * Writes the log somewhere the operator can attach it to an email.
 *
 * Copied rather than pointed at. The file is inside the application's data
 * directory, which on both platforms is a folder a volunteer cannot navigate to
 * from a file chooser -- and "find ~/Library/Application Support" is the point
 * where a support thread stops.
 *
 * Both files: the current one and the previous, because the failure worth
 * reading is often the one that made them restart the application.
 */
#[tauri::command]
fn export_log(app: AppHandle, to: String) -> CommandResult<String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let target = std::path::PathBuf::from(&to);

    let mut written = String::new();
    for name in ["pulpitry.previous.log", "pulpitry.log"] {
        let from = directory.join(name);
        let Ok(text) = std::fs::read_to_string(&from) else { continue };
        written.push_str(&format!("===== {name} =====\n"));
        written.push_str(&text);
        written.push('\n');
    }

    if written.is_empty() {
        return Err("There is no log to export yet.".into());
    }

    std::fs::write(&target, written).map_err(|error| {
        format!("The log could not be written to {}. {error}", target.display())
    })?;
    Ok(target.display().to_string())
}

/// What this machine has made, for the Usage pane to show.
///
/// Read from the same file the tally is kept in, so the number an operator
/// sees is the number that will be reported -- rather than a second count that
/// could drift from it.
#[tauri::command]
fn made_here(app: AppHandle) -> CommandResult<castavox_core::made::Tally> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(castavox_core::made::tally(&dir))
}

#[tauri::command]
fn list_translations(library: State<'_, Arc<Library>>) -> CommandResult<Vec<Translation>> {
    library.translations().map_err(to_message)
}

#[tauri::command]
fn list_books(library: State<'_, Arc<Library>>, translation: String) -> CommandResult<Vec<Book>> {
    library.books(&translation).map_err(to_message)
}

#[tauri::command]
fn get_chapter(
    library: State<'_, Arc<Library>>,
    translation: String,
    book_number: i64,
    chapter: i64,
) -> CommandResult<Vec<Verse>> {
    library.chapter(&translation, book_number, chapter).map_err(to_message)
}

#[tauri::command]
fn search_verses(
    library: State<'_, Arc<Library>>,
    translation: String,
    query: String,
    limit: Option<i64>,
) -> CommandResult<Vec<Verse>> {
    library.search(&translation, &query, limit.unwrap_or(50)).map_err(to_message)
}

/// The same passage, drawn from another translation.
///
/// # Why an output resolves its own scripture
///
/// Content is broadcast to every output, because they must agree about what is
/// live. But "the same passage" and "the same words" are different things: a
/// church with a deaf ministry in the overflow room, or a congregation reading
/// two languages, wants one reference on every screen and the wording each room
/// can follow.
///
/// This is the mirror's own trick turned inward. The mirror sends Castavox a
/// reference and lets it draw from its own library; an output does the same on
/// one machine. Passing text between them would make the operator's Bible the
/// only one that could ever be shown.
///
/// Empty where the passage does not exist in that translation -- a Catholic
/// edition's extra books, or a partial text -- and the window keeps what it was
/// given rather than emptying a screen mid-service.
#[tauri::command]
fn scripture_in(
    library: State<'_, Arc<Library>>,
    translation: String,
    reference: String,
) -> CommandResult<Passage> {
    let Some(found) = library.resolve_reference(&translation, &reference).map_err(to_message)?
    else {
        return Ok(Passage::default());
    };

    let chapter = library
        .chapter(&translation, found.book_number, found.chapter)
        .map_err(to_message)?;

    // A whole chapter when no verse was named, which is what "Psalm 23" means.
    let first = found.verse.unwrap_or(0);
    let last = found.end_verse.or(found.verse).unwrap_or(i64::MAX);

    let lines: Vec<projector::ScriptureLine> = chapter
        .into_iter()
        .filter(|verse| first == 0 || (verse.verse >= first && verse.verse <= last))
        .map(|verse| projector::ScriptureLine { number: verse.verse, text: verse.text })
        .collect();

    /*
     * The label is composed here, not adjusted at the far end.
     *
     * It read "Genesis 1:12 (AMP)" over Yoruba words, because the caption was
     * the operator's and only the verses had been redrawn. The book name is
     * the other half of that: this translation calls it whatever it calls it,
     * and a label in one language over a verse in another is worse than no
     * label at all.
     */
    let caption = match (lines.first(), lines.last()) {
        (Some(one), Some(other)) => {
            let range = if one.number == other.number {
                one.number.to_string()
            } else {
                format!("{}-{}", one.number, other.number)
            };
            format!("{} {}:{} ({})", found.book, found.chapter, range, translation.to_uppercase())
        }
        _ => String::new(),
    };

    Ok(Passage { lines, caption })
}

/// A passage as one output draws it: the words, and the label for them.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub lines: Vec<projector::ScriptureLine>,
    /// Empty when the passage is not in that translation, and the window keeps
    /// the label it was given along with the words.
    pub caption: String,
}

#[tauri::command]
fn resolve_reference(
    library: State<'_, Arc<Library>>,
    translation: String,
    reference: String,
) -> CommandResult<Option<Reference>> {
    library.resolve_reference(&translation, &reference).map_err(to_message)
}

#[tauri::command]
fn adjacent_verse(
    library: State<'_, Arc<Library>>,
    translation: String,
    book_number: i64,
    chapter: i64,
    verse: i64,
    forward: bool,
) -> CommandResult<Option<Verse>> {
    library
        .adjacent_verse(&translation, book_number, chapter, verse, forward)
        .map_err(to_message)
}

/// Writes a prepared transcript to a path the operator chose in the native save
/// dialog. Deliberately narrow rather than a general file-writing command.
#[tauri::command]
fn export_transcript(path: String, contents: String) -> CommandResult<u64> {
    std::fs::write(&path, &contents)
        .map_err(|err| format!("could not write {path}: {err}"))?;
    Ok(contents.len() as u64)
}

/// The most recent services, newest first.
#[tauri::command]
fn history_list(
    transcripts: State<'_, Arc<Transcripts>>,
    limit: Option<i64>,
) -> CommandResult<Vec<Session>> {
    transcripts.list(limit.unwrap_or(200)).map_err(to_message)
}

/// The services whose transcript contains a phrase.
#[tauri::command]
fn history_search(
    transcripts: State<'_, Arc<Transcripts>>,
    query: String,
    limit: Option<i64>,
) -> CommandResult<Vec<Session>> {
    transcripts.search(&query, limit.unwrap_or(200)).map_err(to_message)
}

#[tauri::command]
fn history_get(
    transcripts: State<'_, Arc<Transcripts>>,
    id: i64,
) -> CommandResult<Option<Session>> {
    transcripts.get(id).map_err(to_message)
}

#[tauri::command]
fn history_lines(
    transcripts: State<'_, Arc<Transcripts>>,
    id: i64,
) -> CommandResult<Vec<transcripts::Line>> {
    transcripts.lines(id).map_err(to_message)
}

#[tauri::command]
fn history_retitle(
    transcripts: State<'_, Arc<Transcripts>>,
    id: i64,
    title: String,
) -> CommandResult<()> {
    transcripts.retitle(id, &title).map_err(to_message)
}

/// Adds a past service from a transcript file on disk.
///
/// The file is read here rather than in the web layer: a four-hour service is
/// several hundred kilobytes of text, and moving it through the bridge as a
/// string to hand straight back again is work for nothing. The frontend sends a
/// path and gets the finished service.
#[tauri::command]
fn history_import(
    transcripts: State<'_, Arc<Transcripts>>,
    path: String,
) -> CommandResult<Session> {
    let file = std::path::Path::new(&path);
    let text = std::fs::read_to_string(file)
        .map_err(|error| format!("could not read that file: {error}"))?;

    // The file's own name, which is what somebody who chose it expects to see.
    let title = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or_else(|| "Imported transcript".to_string());

    let id = transcripts.import(&title, &text).map_err(to_message)?;
    crate::log_line!("[history] imported {} into service {id}", file.display());
    transcripts
        .get(id)
        .map_err(to_message)?
        .ok_or_else(|| "the service was added but could not be read back".to_string())
}

#[tauri::command]
fn history_remove(transcripts: State<'_, Arc<Transcripts>>, id: i64) -> CommandResult<()> {
    transcripts.remove(id).map_err(to_message)
}

/// Whether summarising can be offered at all.
///
/// Asked before the button is drawn, so a church without a model is told why
/// rather than shown something that always fails.
#[tauri::command]
fn summary_available(app: AppHandle) -> bool {
    settings::load(&app)
        .map(|settings| summarise::available(&settings, settings::has_assist_key()))
        .unwrap_or(false)
}

/// Turns a sermon or an outline into draft slides.
///
/// `source` is whatever the operator has: an outline typed by the preacher, a
/// paragraph of notes, or the transcript of a service already recorded. What
/// comes back is drafts, and nothing is written to the slide library until
/// somebody has read them and pressed Keep — see `slides.rs` for why.
#[tauri::command]
async fn generate_slides(app: AppHandle, source: String) -> CommandResult<Vec<slides::DraftSlide>> {
    let settings = settings::load(&app).map_err(to_message)?;

    // The same credential rule as the summariser. On a subscription it is the
    // device token and the deployment is ours; anywhere else it is the church's
    // own model key, and asking for the wrong one is how a church on a plan
    // gets told to buy a second thing.
    let hosted = settings.speech_engine == "hosted";
    let key = if hosted {
        settings::load_hosted_token()
            .map_err(to_message)?
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| {
                "Activate your Castavox subscription in Settings to make slides.".to_string()
            })?
    } else {
        settings::load_assist_key()
            .map_err(to_message)?
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| {
                "Slides need the assistant. Add a model key and endpoint in Settings.".to_string()
            })?
    };

    if !summarise::available(&settings, true) {
        return Err("Slides need the assistant. Set the endpoint and deployment in Settings.".into());
    }

    // Off the UI thread: one request that may take the better part of a minute.
    let made = tauri::async_runtime::spawn_blocking(move || slides::generate(&settings, &key, &source))
        .await
        .map_err(|err| err.to_string())?
        .map_err(to_message)?;

    // Counted on success only, and counted even where the check-in is off:
    // the switch decides what is sent, not what a church's own file records.
    if let Ok(dir) = app.path().app_data_dir() {
        castavox_core::made::record(&dir, 0, 1);
    }
    Ok(made)
}

/// Asks the model what a recorded service was about.
///
/// Stores what comes back, so it is asked once per service rather than once per
/// time somebody opens it.
/// What a summary is doing, while it is doing it.
const EVENT_SUMMARY_PROGRESS: &str = "summary-progress";

#[tauri::command]
async fn summarise_session(
    app: AppHandle,
    transcripts: State<'_, Arc<Transcripts>>,
    id: i64,
) -> CommandResult<Description> {
    let settings = settings::load(&app).map_err(to_message)?;

    // On a subscription the credential is the device token and the deployment
    // is ours; anywhere else it is the church's own model key. Asking for the
    // wrong one is how a church on a plan gets told to buy a second thing.
    let hosted = settings.speech_engine == "hosted";
    let key = if hosted {
        settings::load_hosted_token()
            .map_err(to_message)?
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| {
                "Activate your Castavox subscription in Settings to write summaries.".to_string()
            })?
    } else {
        settings::load_assist_key()
            .map_err(to_message)?
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| {
                "Summaries need the assistant. Add a model key and endpoint in Settings.".to_string()
            })?
    };

    if !summarise::available(&settings, true) {
        return Err(
            "Summaries need the assistant. Set the endpoint and deployment in Settings.".into()
        );
    }

    let lines = transcripts.lines(id).map_err(to_message)?;
    if lines.is_empty() {
        return Err("There is nothing recorded for this service.".into());
    }
    let transcript =
        lines.into_iter().map(|line| line.text).collect::<Vec<_>>().join(" ");

    /*
     * Off the UI thread, and saying what it is doing while it is there.
     *
     * A four-hour service is several requests, any of which may wait out a
     * busy model, so this can run for minutes. Without a word from it the
     * dialog looks frozen and the operator presses Summarise again -- which
     * starts a second set of requests and makes the queue it is waiting on
     * longer.
     */
    let reporter = app.clone();
    let described = tauri::async_runtime::spawn_blocking(move || {
        summarise::describe(&settings, &key, &transcript, &|note: &str| {
            let _ = reporter.emit(EVENT_SUMMARY_PROGRESS, note);
        })
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(to_message)?;

    transcripts
        .describe(id, &described.title, &described.summary, &described.topics)
        .map_err(to_message)?;

    // After it is stored, so a summary that was written and lost is not counted
    // as one a church has.
    if let Ok(dir) = app.path().app_data_dir() {
        castavox_core::made::record(&dir, 1, 0);
    }
    Ok(described)
}

/// Writes a service's summary to a file the operator chose.
///
/// The summary is stored as Markdown and converted here, so every format says
/// the same thing and there is one text to get right.
#[tauri::command]
fn export_summary(
    transcripts: State<'_, Arc<Transcripts>>,
    id: i64,
    path: String,
    format: String,
) -> CommandResult<u64> {
    let session = transcripts
        .get(id)
        .map_err(to_message)?
        .ok_or_else(|| "That service is no longer here.".to_string())?;
    if session.summary.trim().is_empty() {
        return Err("This service has not been summarised yet.".into());
    }

    let (title, markdown, topics) = (&session.title, &session.summary, &session.topics);
    let bytes = match format.as_str() {
        "markdown" => {
            let mut out = String::new();
            if !title.is_empty() {
                out.push_str(&format!("# {title}\n\n"));
            }
            out.push_str(markdown);
            if !topics.is_empty() {
                out.push_str(&format!("\n\n**Subjects:** {}\n", topics.join(", ")));
            }
            out.into_bytes()
        }
        "text" => exports::to_text(title, markdown, topics).into_bytes(),
        "docx" => exports::to_docx(title, markdown, topics).map_err(to_message)?,
        "pdf" => exports::to_pdf(title, markdown, topics).map_err(to_message)?,
        other => return Err(format!("{other} is not a format this can write.")),
    };

    let written = bytes.len() as u64;
    std::fs::write(&path, bytes).map_err(|err| format!("could not write {path}: {err}"))?;
    Ok(written)
}

#[tauri::command]
fn get_live(projector: State<'_, Arc<Projector>>) -> Option<LiveContent> {
    projector.live()
}

#[tauri::command]
fn set_live(projector: State<'_, Arc<Projector>>, content: Option<LiveContent>) {
    projector.set_live(content);
}

#[tauri::command]
fn get_audio(projector: State<'_, Arc<Projector>>) -> AudioState {
    projector.audio()
}

#[tauri::command]
fn set_audio(projector: State<'_, Arc<Projector>>, audio: AudioState) -> AudioState {
    projector.set_audio(audio)
}

#[tauri::command]
fn get_ticker(projector: State<'_, Arc<Projector>>) -> Ticker {
    projector.ticker()
}

#[tauri::command]
fn set_ticker(projector: State<'_, Arc<Projector>>, ticker: Ticker) -> Ticker {
    projector.set_ticker(ticker)
}

#[tauri::command]
fn get_media(projector: State<'_, Arc<Projector>>) -> MediaCommand {
    projector.media()
}

#[tauri::command]
fn set_media(projector: State<'_, Arc<Projector>>, command: MediaCommand) -> MediaCommand {
    projector.set_media(command)
}

#[tauri::command]
fn get_media_progress(projector: State<'_, Arc<Projector>>) -> MediaProgress {
    projector.progress()
}

/// Reported by whichever surface is actually playing the clip.
#[tauri::command]
fn report_media_progress(projector: State<'_, Arc<Projector>>, progress: MediaProgress) {
    projector.report_progress(progress);
}

/*
 * The three projector commands are async, and must stay that way.
 *
 * Tauri runs a synchronous command on the main thread. Building a WebView2
 * window needs that thread free to pump its message loop while the webview
 * starts, so doing it from a synchronous command deadlocks on Windows -- as
 * Tauri's own documentation for `WebviewWindowBuilder::build` says in as many
 * words. And since every IPC message crosses that same loop, the app stops
 * answering entirely: scripture, songs, themes and settings all go at once,
 * with nothing pointing back at the projector.
 *
 * Async commands run on the async runtime instead, leaving the loop free.
 * macOS is indifferent, which is why this survived every test on the machine it
 * was written on.
 */
#[tauri::command]
async fn list_displays(projector: State<'_, Arc<Projector>>) -> CommandResult<Vec<Display>> {
    projector.displays().map_err(to_message)
}

/// What each configured output is doing right now.
///
/// Asked of the windows rather than of settings: a window can be closed by the
/// operating system, a monitor can be unplugged, and a pane that reports what
/// was *intended* is a pane an operator will trust and act on wrongly.
#[tauri::command]
fn outputs_state(
    app: AppHandle,
    projector: State<'_, Arc<Projector>>,
    senders: State<'_, NdiOutputs>,
) -> CommandResult<Vec<OutputState>> {
    let settings = settings::load(&app).map_err(to_message)?;
    Ok(settings
        .outputs
        .iter()
        .map(|output| OutputState::of(&output.id, &projector, &senders))
        .collect())
}

/// Opens one output's window, or moves it if it is already open.
///
/// Async for the same reason `open_projector` is: building a webview from a
/// synchronous command deadlocks Windows, and the whole application stops
/// answering rather than just this window failing.
#[tauri::command]
async fn open_output(
    app: AppHandle,
    projector: State<'_, Arc<Projector>>,
    senders: State<'_, NdiOutputs>,
    id: String,
) -> CommandResult<OutputState> {
    let settings = settings::load(&app).map_err(to_message)?;
    let output = settings
        .outputs
        .iter()
        .find(|output| output.id == id)
        // Not "failed": the output was deleted, which is a different thing and
        // the only way an operator reaches this.
        .ok_or_else(|| "That output no longer exists.".to_string())?;

    projector
        .open_output(
            &output.id,
            &output.name,
            output.display,
            (output.width, output.height),
            output.is_overlay(),
        )
        .map_err(to_message)?;

    feed_follows(&app, &senders, &id);
    Ok(OutputState::of(&id, &projector, &senders))
}

#[tauri::command]
async fn close_output(
    projector: State<'_, Arc<Projector>>,
    senders: State<'_, NdiOutputs>,
    id: String,
) -> CommandResult<OutputState> {
    // The feed first: a sender left publishing a window that has gone captures
    // nothing and announces a dead source on the network.
    senders.stop(&id);
    projector.close_output(&id);
    Ok(OutputState::of(&id, &projector, &senders))
}

/// Whether one output's window is up, and whether its feed is.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputState {
    pub id: String,
    pub open: bool,
    /// On the network right now.
    pub sending: bool,
    /// Why it is not, when it was asked to be. In words for the operator.
    pub problem: Option<String>,
}

impl OutputState {
    fn of(id: &str, projector: &Projector, senders: &NdiOutputs) -> Self {
        let (sending, problem) = senders.state(id);
        Self { id: id.to_string(), open: projector.output_open(id), sending, problem }
    }
}

#[tauri::command]
async fn open_projector(
    projector: State<'_, Arc<Projector>>,
    senders: State<'_, NdiOutputs>,
    app: AppHandle,
    display: Option<usize>,
) -> CommandResult<ProjectorState> {
    let state = projector.open(display).map_err(to_message)?;
    // The keyboard opens the projector without the Displays dialog, and its
    // feed should come with it exactly as it does from there. A failure is
    // kept for the dialog rather than refusing the window: the window is what
    // the operator asked for, and it has already worked.
    feed_follows(&app, &senders, projector::MAIN_ID);
    Ok(state)
}

#[tauri::command]
async fn close_projector(
    projector: State<'_, Arc<Projector>>,
    senders: State<'_, NdiOutputs>,
) -> CommandResult<ProjectorState> {
    senders.stop(projector::MAIN_ID);
    // Result rather than a bare value: an async command has to return one.
    Ok(projector.close())
}

#[tauri::command]
fn projector_state(projector: State<'_, Arc<Projector>>) -> ProjectorState {
    projector.state()
}

/// A second congregation-facing display, on a screen the operator chooses.
///
/// Async for the same reason `open_projector` is — building a webview from a
/// synchronous command deadlocks the message loop on Windows and takes the
/// whole application with it.
#[tauri::command]
async fn open_second(
    projector: State<'_, Arc<Projector>>,
    senders: State<'_, NdiOutputs>,
    app: AppHandle,
    display: Option<usize>,
) -> CommandResult<projector::SecondState> {
    let state = projector.open_second(display).map_err(to_message)?;
    feed_follows(&app, &senders, projector::SECOND_ID);
    Ok(state)
}

#[tauri::command]
async fn close_second(
    projector: State<'_, Arc<Projector>>,
    senders: State<'_, NdiOutputs>,
) -> CommandResult<projector::SecondState> {
    senders.stop(projector::SECOND_ID);
    Ok(projector.close_second())
}

#[tauri::command]
fn second_state(projector: State<'_, Arc<Projector>>) -> projector::SecondState {
    projector.second_state()
}

/// Reads the bundled hymn library and hands it to the catalog.
/// Reads the looks that ship with the application and hands them to the catalogue.
///
/// Plain JSON rather than gzipped: twenty themes is twenty kilobytes, and a
/// file somebody can open and read is worth more than the saving.
fn seed_looks(app: &AppHandle, catalog: &Catalog) -> anyhow::Result<()> {
    let path = app
        .path()
        .resolve("resources/looks.json", tauri::path::BaseDirectory::Resource)
        .context("could not locate the bundled looks")?;
    let manifest: catalog::LookManifest =
        serde_json::from_str(&std::fs::read_to_string(&path)?)
            .context("the bundled looks are malformed")?;

    let added = catalog.import_looks(&manifest, &manifest.looks)?;
    if added > 0 {
        log_line!("[looks] added {added} of {}", manifest.looks.len());
    }
    Ok(())
}

fn seed_hymns(app: &AppHandle, catalog: &Catalog) -> anyhow::Result<()> {
    use std::io::Read;

    let manifest_path = app
        .path()
        .resolve("resources/hymns.json", tauri::path::BaseDirectory::Resource)
        .context("could not locate the hymn manifest")?;
    let manifest: catalog::HymnManifest =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path)?)
            .context("the hymn manifest is malformed")?;

    let path = app
        .path()
        .resolve(
            &format!("resources/{}", manifest.file),
            tauri::path::BaseDirectory::Resource,
        )
        .context("could not locate the bundled hymns")?;

    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(&path)?).read_to_string(&mut text)?;
    let hymns: Vec<catalog::BundledHymn> =
        serde_json::from_str(&text).context("the bundled hymns are malformed")?;

    // The manifest and the bundle are written by the same script in the same
    // run, so disagreeing means one of the two was replaced on its own -- a
    // half-applied update, and a reason to stop rather than seed a library
    // that is not the one the checksum claims.
    if hymns.len() as i64 != manifest.hymn_count {
        anyhow::bail!(
            "the hymn bundle holds {} hymns but the manifest says {}",
            hymns.len(),
            manifest.hymn_count
        );
    }

    let imported = catalog.import_hymns(&manifest, &hymns)?;
    if imported > 0 {
        println!("[hymns] imported {imported} public-domain hymns");
    }
    Ok(())
}

/// What an import did, in numbers an operator can act on.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportReport {
    added: usize,
    /// Songs already in the library under the same title, left untouched.
    duplicates: usize,
    /// Files that could not be read. Named in the log, counted here.
    failed: usize,
}

/**
 * Songs from wherever the church already keeps them.
 *
 * A folder of OpenSong or OpenLyrics files, an OpenLP library, or text pasted
 * into the dialog. Nothing is fetched from the internet: every song comes from
 * something the operator pointed at.
 *
 * A song whose title is already in the library is left alone rather than
 * duplicated -- importing the same folder twice is a thing people do, and it
 * should be uneventful.
 *
 * Async because a library can be four hundred songs and several thousand
 * files, and the window must stay answerable while it reads them.
 */
#[tauri::command]
async fn import_songs(
    catalog: State<'_, Arc<Catalog>>,
    kind: String,
    path: Option<String>,
    text: Option<String>,
    title: Option<String>,
) -> CommandResult<ImportReport> {
    let mut report = ImportReport::default();
    let mut songs = Vec::new();

    match kind.as_str() {
        "text" => {
            let words = text.unwrap_or_default();
            // No title given: the first line is what somebody pasted as one.
            let named = match title.as_deref().map(str::trim).filter(|given| !given.is_empty()) {
                Some(given) => given.to_string(),
                None => words
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .unwrap_or("Untitled song")
                    .to_string(),
            };
            songs.push(songs_import::from_plain(&named, &words).map_err(to_message)?);
        }
        "openlp" => {
            let file = path.clone().ok_or_else(|| "no file was chosen".to_string())?;
            songs.extend(songs_import::from_openlp(std::path::Path::new(&file)).map_err(to_message)?);
        }
        "easyworship" => {
            let file = path.clone().ok_or_else(|| "no file was chosen".to_string())?;
            songs
                .extend(songs_import::from_easyworship(std::path::Path::new(&file)).map_err(to_message)?);
        }
        "opensong" | "openlyrics" => {
            let chosen = path.clone().ok_or_else(|| "no file was chosen".to_string())?;
            for file in song_files(std::path::Path::new(&chosen)) {
                let Ok(raw) = std::fs::read_to_string(&file) else {
                    report.failed += 1;
                    continue;
                };
                let parsed = if kind == "opensong" {
                    songs_import::from_opensong(&raw)
                } else {
                    songs_import::from_openlyrics(&raw)
                };
                match parsed {
                    Ok(song) => songs.push(song),
                    Err(why) => {
                        // Named here and counted for the operator: one bad file
                        // in four hundred should not stop the other 399.
                        log_line!("[songs] {} could not be read: {why}", file.display());
                        report.failed += 1;
                    }
                }
            }
        }
        other => return Err(format!("{other} is not a kind of song file this can read")),
    }

    for song in songs {
        if catalog.song_titled(&song.title).map_err(to_message)? {
            report.duplicates += 1;
            continue;
        }
        let item = Item {
            id: None,
            title: song.title.clone(),
            subtitle: String::new(),
            body: catalog::ItemBody::Song { sections: song.sections, rights: song.rights },
            path: None,
            updated_at: 0,
        };
        match catalog.save(&item) {
            Ok(_) => report.added += 1,
            Err(why) => {
                log_line!("[songs] {} could not be saved: {why}", song.title);
                report.failed += 1;
            }
        }
    }

    log_line!(
        "[songs] imported from {kind}: {} added, {} already there, {} unreadable",
        report.added,
        report.duplicates,
        report.failed,
    );
    Ok(report)
}

/// Every song file under what the operator chose, folder or single file.
///
/// Churches keep these in a folder, sometimes with subfolders per year or per
/// service. Capped, because a mis-click on a home directory should stop rather
/// than read a hundred thousand files.
fn song_files(chosen: &std::path::Path) -> Vec<std::path::PathBuf> {
    const CAP: usize = 20_000;
    if chosen.is_file() {
        return vec![chosen.to_path_buf()];
    }

    let mut found = Vec::new();
    let mut pending = vec![chosen.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if found.len() < CAP {
                // OpenSong's own files have no extension at all, so anything
                // that is not obviously something else is worth trying.
                let skip = matches!(
                    path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
                    Some("jpg" | "jpeg" | "png" | "gif" | "mp3" | "mp4" | "mov" | "pdf" | "zip" | "db" | "sqlite")
                );
                if !skip {
                    found.push(path);
                }
            }
        }
    }
    found
}

#[tauri::command]
fn catalog_save(
    app: tauri::AppHandle,
    catalog: State<'_, Arc<Catalog>>,
    item: Item,
) -> CommandResult<Item> {
    // Importing a picture is the moment the operator says this file may be
    // shown, so it is also the moment to let the webview read it.
    allow_asset(&app, item.path.as_deref());
    catalog.save(&item).map_err(to_message)
}

#[tauri::command]
fn catalog_get(catalog: State<'_, Arc<Catalog>>, id: i64) -> CommandResult<Option<Item>> {
    catalog.get(id).map_err(to_message)
}

#[tauri::command]
fn catalog_remove(catalog: State<'_, Arc<Catalog>>, id: i64) -> CommandResult<()> {
    catalog.remove(id).map_err(to_message)
}

#[tauri::command]
fn catalog_list(
    catalog: State<'_, Arc<Catalog>>,
    kind: String,
    limit: Option<i64>,
) -> CommandResult<Vec<Item>> {
    catalog.list(&kind, limit.unwrap_or(200)).map_err(to_message)
}

#[tauri::command]
fn catalog_search(
    catalog: State<'_, Arc<Catalog>>,
    query: String,
    kind: Option<String>,
    limit: Option<i64>,
) -> CommandResult<Vec<Item>> {
    catalog
        .search(&query, kind.as_deref(), limit.unwrap_or(50))
        .map_err(to_message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_transcript_to_the_chosen_path() {
        let path = std::env::temp_dir().join("pulpitry-export-test.txt");
        let _ = std::fs::remove_file(&path);

        let contents = "Pulpitry transcript\n\n[10:32] For God so loved the world.\n";
        let written = export_transcript(path.display().to_string(), contents.to_string())
            .expect("write should succeed");

        assert_eq!(written as usize, contents.len());
        assert_eq!(std::fs::read_to_string(&path).expect("read back"), contents);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_unwritable_path_reports_why() {
        let outcome = export_transcript(
            "/definitely/not/a/real/directory/out.txt".into(),
            "text".into(),
        );
        let message = outcome.expect_err("should fail");
        assert!(message.contains("could not write"), "unhelpful: {message}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::chose(app, event.id().as_ref()))
        .setup(|app| {
            // First, so that everything after it can be explained if it fails.
            // A GUI build on Windows has no console: without this the app can
            // only fail silently, which is how a whole release went out fixing
            // the wrong thing.
            if let Ok(dir) = app.path().app_data_dir() {
                if let Some(path) = log::start(&dir) {
                    log::catch_panics();
                    // The shared crate writes to whatever it is given; without
                    // this its diagnostics would go to a stderr nobody reads.
                    castavox_core::log::to(|message| log::line(message));
                    log::line(&format!("log: {}", path.display()));
                }
            }

            app.manage(Projector::new(app.handle().clone()));
            // Nothing is started here: no output has a window yet, so there
            // would be nothing to capture. A window appearing is what starts
            // its feed.
            app.manage(NdiOutputs::default());

            let library = Arc::new(Library::open(app.handle())?);
            app.manage(Arc::clone(&library));

            // Shares the database file with the verse library but holds its own
            // connection, so neither module reaches into the other.
            let data_dir = app.path().app_data_dir()?;
            let catalog = Arc::new(Catalog::open(&data_dir)?);
            // Images imported in an earlier session would otherwise come back
            // as broken frames: the scope is granted per file and per launch.
            for path in catalog.media_paths().unwrap_or_default() {
                allow_asset(app.handle(), Some(&path));
            }
            // The bundled hymns, seeded once. Off the main thread with the
            // translations: 266 songs is not slow, but it is disk work and the
            // window should paint first.
            {
                let handle = app.handle().clone();
                let catalog = Arc::clone(&catalog);
                std::thread::spawn(move || {
                    // The looks first: they are twenty rows and a church that
                    // opens the theme list in the first minute should find
                    // them there.
                    if let Err(error) = seed_looks(&handle, &catalog) {
                        crate::log_line!("[looks] {error:#}");
                    }
                    if let Err(error) = seed_hymns(&handle, &catalog) {
                        // Not fatal, and deliberately not shown: the operator
                        // still has an app, just an empty song list, and an
                        // error box on launch about hymns they did not ask for
                        // would be the more annoying failure.
                        crate::log_line!("[hymns] {error:#}");
                    }
                });
            }

            app.manage(catalog);

            // A new install is on the local engine and has no model for it yet.
            // Before the rest of the setup, so the fetch is under way while the
            // verse library imports.
            provision_local_model(app.handle());

            /*
             * The once-a-day check-in, from every installation.
             *
             * There is no switch. A count that measures only the churches who
             * agreed to be counted is a floor with an unknown gap above it, and
             * every conclusion drawn from it is wrong in the same direction.
             *
             * The policy used to say that on the free local engine nothing
             * leaves the building. That is no longer true and the policy has
             * been changed to say so. See `castavox_core::checkin` for what
             * that costs and what keeps it defensible.
             *
             * Failure is silent and never delays this. `send` returns
             * immediately and does its work on its own thread.
             */
            {
                let stored = settings::load(app.handle()).unwrap_or_default();
                if let Ok(dir) = app.path().app_data_dir() {
                    checkin::send(
                        CHECK_IN_ENDPOINT,
                        &dir,
                        "pulpitry",
                        env!("CARGO_PKG_VERSION"),
                        &stored.speech_engine,
                    );
                    // The same install id on the same launch: two notes rather
                    // than two decisions, and the policy describes them together.
                    castavox_core::made::send(MADE_ENDPOINT, &dir, "pulpitry");
                }
            }

            // The mirror, off unless the church asked for it. Subscribed to the
            // live event rather than called from set_live, so the projector
            // stays unaware that any of this exists.
            let mirror = mirror::Mirror::new(app.handle().clone());
            mirror::follow_live(app.handle(), Arc::clone(&mirror));
            app.manage(Arc::clone(&mirror));

            // Detection searches whichever translation the operator last chose.
            let saved = settings::load(app.handle()).unwrap_or_default();
            mirror.configure(&saved);
            // A background chosen in a previous session has to be readable again.
            allow_asset(app.handle(), saved.projector.background_path.as_deref());

            // Optional, off unless the operator configures it. Everything it
            // proposes is verified against the library before being shown.
            let assistant = Assistant::new(app.handle().clone(), Arc::clone(&library));
            assistant.configure(&saved);
            app.manage(Arc::clone(&assistant));

            // Offline paraphrase matching. The index build is deferred until
            // the verse library exists, since it has nothing to embed before
            // then.
            let model_dir = app
                .path()
                .resolve("resources/embedder", tauri::path::BaseDirectory::Resource)
                .unwrap_or_else(|_| std::path::PathBuf::from("resources/embedder"));
            let semantic = Semantic::new(app.handle().clone(), Arc::clone(&library), model_dir);
            app.manage(Arc::clone(&semantic));
            // The model's restatement is searched against this index.
            assistant.attach_semantic(Arc::clone(&semantic));

            let follower = follow::Follower::new(app.handle().clone());
            app.manage(Arc::clone(&follower));

            let detector = Detector::new(
                app.handle().clone(),
                Arc::clone(&library),
                assistant,
                Arc::clone(&semantic),
                Arc::clone(&follower),
                saved.translation.clone(),
            );
            app.manage(Arc::clone(&detector));
            apply_voice(
                app.handle(),
                &detector,
                &settings::load(app.handle()).unwrap_or_default(),
            );

            // Shares the database file with the library and the catalogue, in
            // its own tables and on its own connection.
            let transcripts = Arc::new(transcripts::Transcripts::open(&data_dir)?);
            app.manage(Arc::clone(&transcripts));

            app.manage(Arc::new(SpeechManager::new(
                app.handle().clone(),
                detector,
                transcripts,
            )));

            // Importing 31,102 verses takes a moment on first launch. Do it off
            // the main thread so the window paints immediately, and tell the UI
            // when the library is usable.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                // Translations land one at a time; forward each step so the
                // operator can start using the first while the rest import.
                let reporter = handle.clone();
                let report = move |status: LibraryStatus| {
                    let _ = reporter.emit(bible::EVENT_LIBRARY, status);
                };

                /*
                 * The Greek and Hebrew, after the translations rather than
                 * before them.
                 *
                 * Four hundred thousand rows takes a few seconds on a first
                 * launch, and nothing on screen needs it: an operator opens
                 * to a verse list, not an interlinear. Making them wait for it
                 * before the first translation appears would trade the thing
                 * they came for against the thing they may never open.
                 *
                 * A failure is logged and swallowed. It is a reference panel;
                 * losing it should not stop a service.
                 */
                if let Err(err) = library.ensure_interlinear(&handle) {
                    crate::log_line!("[bible] the interlinear did not import: {err:#}");
                }
                if let Err(err) = library.ensure_lexicon(&handle) {
                    crate::log_line!("[bible] the lexicon did not import: {err:#}");
                }

                let status = match library.ensure_bundled_translations(&handle, report) {
                    Ok(()) => library.status().unwrap_or_else(|err| LibraryStatus {
                        ready: false,
                        translations: Vec::new(),
                        importing: None,
                        error: Some(err.to_string()),
                    }),
                    Err(err) => LibraryStatus {
                        ready: false,
                        translations: Vec::new(),
                        importing: None,
                        error: Some(format!("{err:#}")),
                    },
                };
                if let Some(message) = &status.error {
                    crate::log_line!("[library] {message}");
                }
                let ready = status.ready;
                let _ = handle.emit(bible::EVENT_LIBRARY, status);

                // Only now is there anything to embed.
                if ready {
                    if let Ok(settings) = settings::load(&handle) {
                        if let Some(semantic) = handle.try_state::<Arc<Semantic>>() {
                            semantic.configure(&settings);
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_audio_inputs,
            bible_attributions,
            original_words,
            lexicon_entry,
            ndi_sources,
            get_settings,
            save_settings,
            save_assist_key,
            clear_assist_key,
            test_assist_model,
            start_transcription,
            stop_transcription,
            speech_status,
            hosted::hosted_status,
            hosted::hosted_activate,
            hosted::hosted_portal,
            hosted::hosted_deactivate,
            speech_models,
            measure_speech,
            mirror::mirror_state,
            mirror::mirror_offer_code,
            mirror::mirror_withdraw_code,
            mirror::mirror_forget,
            download_speech_model,
            node_status,
            library_status,
            translation_library,
            install_translation,
            remove_translation,
            export_log,
            made_here,
            send_feedback,
            list_translations,
            list_books,
            get_chapter,
            search_verses,
            resolve_reference,
            scripture_in,
            adjacent_verse,
            export_transcript,
            history_list,
            history_search,
            history_get,
            history_lines,
            history_retitle,
            history_import,
            history_remove,
            summary_available,
            summarise_session,
            generate_slides,
            export_summary,
            semantic_status,
            semantic_search,
            list_fonts,
            songbook_search,
            songbook_get,
            songbook_add,
            get_live,
            set_live,
            get_audio,
            set_audio,
            get_ticker,
            set_ticker,
            get_media,
            set_media,
            get_media_progress,
            report_media_progress,
            list_displays,
            open_projector,
            close_projector,
            projector_state,
            outputs_state,
            open_output,
            close_output,
            open_second,
            close_second,
            second_state,
            set_background,
            note,
            follow_deck,
            follow_at,
            get_stage,
            set_stage,
            get_theme,
            theme_for_window,
            catalog_save,
            import_songs,
            catalog_get,
            catalog_remove,
            catalog_list,
            catalog_search,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Pulpitry")
        .run(|app, event| {
            // Never leave the sidecar or the microphone running behind us.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(manager) = app.try_state::<Arc<SpeechManager>>() {
                    manager.stop();
                }
            }
        });
}
