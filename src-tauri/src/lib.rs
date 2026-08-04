mod assist;
mod audio;
mod bible;
mod catalog;
mod detect;
mod embed;
mod projector;
mod semantic;
mod settings;
mod speech;
mod spoken;
mod suggestion;

use std::sync::Arc;

use audio::AudioDevice;
use assist::Assistant;
use bible::{Book, Library, LibraryStatus, Reference, Translation, Verse};
use catalog::{Catalog, Item};
use detect::Detector;
use projector::{AudioState, Display, LiveContent, Projector, ProjectorState};
use semantic::{IndexStatus, Semantic};
use settings::{ProjectorTheme, Settings, SettingsView};
use speech::{SpeechManager, SpeechStatus};
use tauri::{Emitter, Manager, State};

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
    settings::save(&app, &settings).map_err(to_message)?;
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
        eprintln!("[assets] could not grant access to {path}: {err}");
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
fn list_displays(projector: State<'_, Arc<Projector>>) -> CommandResult<Vec<Display>> {
    projector.displays().map_err(to_message)
}

#[tauri::command]
fn open_projector(
    projector: State<'_, Arc<Projector>>,
    display: Option<usize>,
) -> CommandResult<ProjectorState> {
    projector.open(display).map_err(to_message)
}

#[tauri::command]
fn close_projector(projector: State<'_, Arc<Projector>>) -> ProjectorState {
    projector.close()
}

#[tauri::command]
fn projector_state(projector: State<'_, Arc<Projector>>) -> ProjectorState {
    projector.state()
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

            app.manage(Arc::new(SpeechManager::new(app.handle().clone(), detector)));

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
                    eprintln!("[library] {message}");
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
            library_status,
            list_translations,
            list_books,
            get_chapter,
            search_verses,
            resolve_reference,
            adjacent_verse,
            export_transcript,
            semantic_status,
            get_live,
            set_live,
            get_audio,
            set_audio,
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
