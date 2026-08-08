mod assist;
mod audio;
mod bible;
mod catalog;
mod detect;
mod node;
mod embed;
mod projector;
mod semantic;
mod settings;
mod speech;
mod exports;
mod log;
mod summarise;
mod transcripts;
mod whisper;
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

fn view(settings: Settings) -> SettingsView {
    SettingsView {
        settings,
        has_azure_key: settings::has_azure_key(),
        has_assist_key: settings::has_assist_key(),
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
    settings::save(&app, &settings).map_err(to_message)?;

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

/// Asks the model what a recorded service was about.
///
/// Stores what comes back, so it is asked once per service rather than once per
/// time somebody opens it.
#[tauri::command]
async fn summarise_session(
    app: AppHandle,
    transcripts: State<'_, Arc<Transcripts>>,
    id: i64,
) -> CommandResult<Description> {
    let settings = settings::load(&app).map_err(to_message)?;
    let key = settings::load_assist_key()
        .map_err(to_message)?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            "Summaries need the assistant. Add a model key and endpoint in Settings.".to_string()
        })?;
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

    // Off the UI thread: one request against an hour of speech.
    let described = tauri::async_runtime::spawn_blocking(move || {
        summarise::describe(&settings, &key, &transcript)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(to_message)?;

    transcripts
        .describe(id, &described.title, &described.summary, &described.topics)
        .map_err(to_message)?;
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
    display: Option<usize>,
) -> CommandResult<ProjectorState> {
    projector.open(display).map_err(to_message)
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
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // First, so that everything after it can be explained if it fails.
            // A GUI build on Windows has no console: without this the app can
            // only fail silently, which is how a whole release went out fixing
            // the wrong thing.
            if let Ok(dir) = app.path().app_data_dir() {
                if let Some(path) = log::start(&dir) {
                    log::catch_panics();
                    log::line(&format!("log: {}", path.display()));
                }
            }

            app.manage(Projector::new(app.handle().clone()));

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

            // Detection searches whichever translation the operator last chose.
            let saved = settings::load(app.handle()).unwrap_or_default();
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
            get_settings,
            save_settings,
            save_azure_key,
            clear_azure_key,
            save_assist_key,
            clear_assist_key,
            start_transcription,
            stop_transcription,
            speech_status,
            speech_models,
            download_speech_model,
            node_status,
            library_status,
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
            history_remove,
            summary_available,
            summarise_session,
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
