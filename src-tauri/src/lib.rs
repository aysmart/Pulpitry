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
mod projector;
mod semantic;
mod settings;
mod slides;
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
        has_azure_key: settings::has_azure_key(),
        has_assist_key: settings::has_assist_key(),
        has_hosted_subscription: settings::has_hosted_token(),
    }
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

#[tauri::command]
fn get_theme(app: tauri::AppHandle) -> CommandResult<ProjectorTheme> {
    Ok(settings::load(&app).map_err(to_message)?.projector)
}

#[tauri::command]
fn semantic_status(semantic: State<'_, Arc<Semantic>>) -> IndexStatus {
    semantic.status()
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

#[tauri::command]
fn save_azure_key(key: String) -> CommandResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("The Azure Speech key cannot be empty.".into());
    }
    settings::save_azure_key(key).map_err(to_message)
}

#[tauri::command]
fn clear_azure_key() -> CommandResult<()> {
    settings::clear_azure_key().map_err(to_message)
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
 * The NDI output, as the operator drives it.
 *
 * The running output lives in a Mutex<Option<..>> in app state: `Some` while it
 * is publishing, `None` otherwise, and dropping the old one is what stops the
 * threads and takes the source off the network. Nothing else is needed to stop
 * it, which is the point of `Output` owning its own shutdown.
 */
struct NdiOutput(std::sync::Mutex<Option<ndi_output::Output>>);

/// What the settings panel needs to draw the row.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NdiState {
    /// Whether the runtime is installed at all.
    available: bool,
    running: bool,
    name: String,
    /// Set when starting failed, in words for the operator.
    error: Option<String>,
}

/// What NDI sources this machine can see, ours included.
///
/// Asked on demand rather than with the status, because it costs two seconds of
/// discovery and the settings panel opens far more often than anybody wonders
/// whether the network is carrying the feed.
#[tauri::command]
async fn ndi_sources() -> Vec<String> {
    // On a thread: discovery blocks, and blocking the async runtime stalls
    // every other command the window is waiting on.
    tauri::async_runtime::spawn_blocking(ndi_output::Output::visible_sources)
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn ndi_status(state: State<'_, NdiOutput>, app: AppHandle) -> NdiState {
    let settings = settings::load(&app).unwrap_or_default();
    NdiState {
        available: ndi_output::Output::available(),
        running: state.0.lock().map(|held| held.is_some()).unwrap_or(false),
        name: settings.ndi_name,
        error: None,
    }
}

/// Starts or stops publishing, and saves the choice.
///
/// The setting is written whatever happens, including when starting fails: an
/// operator who asked for this and was told the runtime is missing should find
/// the switch still on after installing it, rather than having to remember what
/// they were doing.
#[tauri::command]
fn ndi_set(
    state: State<'_, NdiOutput>,
    app: AppHandle,
    enabled: bool,
    name: String,
) -> CommandResult<NdiState> {
    let mut settings = settings::load(&app).unwrap_or_default();
    settings.ndi_enabled = enabled;
    settings.ndi_name = name.trim().to_string();
    let _ = settings::save(&app, &settings);

    let mut held = state.0.lock().map_err(|_| "the NDI output is wedged".to_string())?;

    // Always dropped first, even when starting again: a rename has to close the
    // old source before opening the new one, or the network briefly carries two.
    *held = None;

    let mut error = None;
    if enabled {
        match ndi_output::Output::start(&settings.ndi_name) {
            Ok(output) => *held = Some(output),
            Err(problem) => {
                crate::log_line!("[ndi] {problem}");
                error = Some(problem);
            }
        }
    }

    Ok(NdiState {
        available: ndi_output::Output::available(),
        running: held.is_some(),
        name: settings.ndi_name,
        error,
    })
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
    book: i64,
    chapter: i64,
    verse: i64,
) -> CommandResult<Vec<bible::OriginalWord>> {
    library.original(book, chapter, verse).map_err(to_message)
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

#[tauri::command]
async fn open_projector(
    projector: State<'_, Arc<Projector>>,
    ndi: State<'_, NdiOutput>,
    app: AppHandle,
    display: Option<usize>,
) -> CommandResult<ProjectorState> {
    let state = projector.open(display).map_err(to_message)?;

    /*
     * Resume the NDI output, if it was left on.
     *
     * It cannot start at launch: there is no projector window then, so there is
     * nothing to capture and the capture would fail on an empty room. The
     * window appearing is the moment it becomes possible, which makes this the
     * right place rather than a convenient one.
     *
     * A failure here is logged and swallowed. Opening the projector is the
     * thing the operator asked for and it has already worked; refusing it
     * because a network feature could not start would be the wrong way round.
     */
    let settings = settings::load(&app).unwrap_or_default();
    if settings.ndi_enabled {
        if let Ok(mut held) = ndi.0.lock() {
            if held.is_none() {
                match ndi_output::Output::start(&settings.ndi_name) {
                    Ok(output) => *held = Some(output),
                    Err(problem) => crate::log_line!("[ndi] could not resume: {problem}"),
                }
            }
        }
    }

    Ok(state)
}

#[tauri::command]
async fn close_projector(projector: State<'_, Arc<Projector>>) -> CommandResult<ProjectorState> {
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
    display: Option<usize>,
) -> CommandResult<projector::SecondState> {
    projector.open_second(display).map_err(to_message)
}

#[tauri::command]
async fn close_second(
    projector: State<'_, Arc<Projector>>,
) -> CommandResult<projector::SecondState> {
    Ok(projector.close_second())
}

#[tauri::command]
fn second_state(projector: State<'_, Arc<Projector>>) -> projector::SecondState {
    projector.second_state()
}

/// Reads the bundled hymn library and hands it to the catalog.
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
            // Not started here even when the setting is on: the projector has
            // no window yet, so there would be nothing to capture. The window
            // is what starts it.
            app.manage(NdiOutput(std::sync::Mutex::new(None)));

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
             * The once-a-day check-in, if this church switched it on.
             *
             * Reads the stored setting and does nothing whatever when it is
             * off: no identifier is written, no thread is started, no request
             * is made. The privacy policy tells churches on the free local
             * engine that nothing leaves the building, and for anybody who has
             * not touched the switch that stays literally true.
             *
             * Failure is silent and never delays this. `send` returns
             * immediately and does its work on its own thread.
             */
            {
                let stored = settings::load(app.handle()).unwrap_or_default();
                if let Ok(dir) = app.path().app_data_dir() {
                    checkin::send(
                        stored.check_in,
                        CHECK_IN_ENDPOINT,
                        &dir,
                        "pulpitry",
                        env!("CARGO_PKG_VERSION"),
                        &stored.speech_engine,
                    );
                    // The same switch and the same install id, on the same
                    // launch: a tally that needed its own consent would be a
                    // second thing to explain to a church.
                    castavox_core::made::send(stored.check_in, MADE_ENDPOINT, &dir, "pulpitry");
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

            let detector = Detector::new(
                app.handle().clone(),
                Arc::clone(&library),
                assistant,
                Arc::clone(&semantic),
                saved.translation.clone(),
            );
            app.manage(Arc::clone(&detector));

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
            ndi_status,
            ndi_sources,
            ndi_set,
            get_settings,
            save_settings,
            save_azure_key,
            clear_azure_key,
            save_assist_key,
            clear_assist_key,
            start_transcription,
            stop_transcription,
            speech_status,
            hosted::hosted_status,
            hosted::hosted_activate,
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
            export_log,
            made_here,
            send_feedback,
            list_translations,
            list_books,
            get_chapter,
            search_verses,
            resolve_reference,
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
            open_second,
            close_second,
            second_state,
            set_background,
            get_theme,
            catalog_save,
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
