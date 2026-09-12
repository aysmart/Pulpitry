//! Operator settings.
//!
//! Non-secret preferences live in a JSON file in the app config directory. The
//! Azure subscription key never goes there — it is held in the OS credential
//! store (Keychain on macOS, Credential Manager on Windows) via `keyring`.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "com.pulpitry.desktop";
const KEYCHAIN_ACCOUNT: &str = "azure-speech-key";
const KEYCHAIN_ASSIST_ACCOUNT: &str = "azure-assist-key";
/// The device token a hosted subscription is activated into. A secret, so it
/// lives here beside the keys rather than in the settings file.
const KEYCHAIN_HOSTED_ACCOUNT: &str = "hosted-device-token";

/// Azure AI Foundry's inference API is versioned by query string.
pub const DEFAULT_ASSIST_API_VERSION: &str = "2024-05-01-preview";

/// Serde default for a flag that is on unless a settings file says otherwise.
fn yes() -> bool {
    true
}

/// Waiting to be clicked, which is what every install has done until now.
fn manual() -> String {
    "manual".into()
}

/// The gentlest of the drawn motions, and the one that suits text best.
fn drift() -> String {
    "drift".into()
}

/// As designed, for a theme written before the speed could be changed.
fn one() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub language: String,
    pub input_device_id: Option<String>,
    /// The translation the operator is working in. Verse detection searches
    /// this one, so it has to outlive the window that selected it.
    pub translation: String,

    /// Whether a detected verse stages itself, or waits to be clicked.
    ///
    /// "auto" or "manual", and auto stages to *preview* rather than to the
    /// wall. Our own terms say nothing should reach a congregation without
    /// somebody deciding it should, and detection is a guess: it mishears
    /// names, and a paraphrase match is a weaker claim than a quotation. Auto
    /// saves the operator the hunt through the list; it does not save them the
    /// decision.
    #[serde(default = "manual")]
    pub verse_display: String,

    /// An optional model of the church's own, used to suggest paraphrased
    /// scripture. Everything it proposes is verified against the local library
    /// before the operator ever sees it, and exact detection works without any
    /// of this.
    pub assist_enabled: bool,
    /// Wherever that model answers: a provider's API, or Ollama or LM Studio
    /// on this machine. e.g. https://api.openai.com/v1 or
    /// http://localhost:11434/v1
    pub assist_endpoint: String,
    /// Deployment or model name, e.g. gpt-4o-mini or Llama-3.3-70B-Instruct.
    pub assist_model: String,
    pub assist_api_version: String,
    /**
     * How the chosen service expects to be asked.
     *
     * "openAi" for most of them -- OpenAI itself, DeepSeek, Grok, Mistral,
     * Groq, OpenRouter, Gemini's compatibility endpoint, and Ollama or LM
     * Studio on this machine. "azure" for Azure OpenAI and AI Foundry.
     * "anthropic" for Claude.
     *
     * Absent on a settings file written before there was a choice, and Azure
     * is what those files described.
     */
    #[serde(default = "shape_before_the_others")]
    pub assist_shape: String,

    /// Offering what is on the projector to a Castavox on the same wifi.
    ///
    /// Off unless asked for. It opens a port and announces this machine on the
    /// local network, and neither is a thing to do to a church that never asked
    /// — one running Pulpitry alone should look, on the network, like a church
    /// that has never heard of the mirror.
    #[serde(default)]
    pub mirror_enabled: bool,
    /// Screens that have been paired, so one paired last Sunday still works
    /// today. Holds a derived secret and never leaves this machine.
    #[serde(default)]
    pub mirror_pairings: Vec<castavox_core::mirror::Pairing>,

    /*
     * The old whole-projector NDI switch, kept only to be read once.
     *
     * Settings → Stage had a "Send the screen over NDI" row of its own, from
     * before every output could be put on the network from Displays. Two
     * places to turn on one feed was one too many, and the older one could do
     * less: no overlay, no size, no second feed. It is gone, and what it held
     * is moved onto the Projector output by `carry_the_old_feed` so that a
     * church which had it on keeps its feed -- under the same name, so the
     * switcher's source list still has it where they left it.
     *
     * Not deleted from the struct, because a settings file written by 0.8.5
     * or earlier still has these keys, and they are how the move knows to
     * happen.
     */
    #[serde(default)]
    pub ndi_enabled: bool,
    #[serde(default)]
    pub ndi_name: String,

    /// Local embedding-based paraphrase matching. Offline and free, so it is on
    /// by default; the index costs a couple of minutes to build once.
    /// Which recogniser turns audio into words: "local" or "hosted".
    ///
    /// A new install gets the local engine: it costs nothing, needs no account
    /// and no network, and it is what most churches should be using. Anything
    /// else would open a fresh install on a demand for a key — a paywall in
    /// front of the free thing.
    ///
    /// An install that predates this field gets the same, which is what the
    /// serde default below is for. It read "azure" until that engine was
    /// withdrawn; a machine still holding that value is moved to local on
    /// load, because the alternative is billing somebody for a decision we
    /// made.
    #[serde(default = "engine_before_the_local_one")]
    pub speech_engine: String,
    /// This machine, to a hosted subscription. Not a secret and not a
    /// fingerprint: a random identifier made once, so that reactivating the
    /// same laptop does not consume a second of the seats they paid for.
    pub hosted_device_id: String,
    /// The whisper.cpp model, by file name.
    ///
    /// Empty means nothing has been chosen for this machine yet, which is the
    /// signal `provision_local_model` acts on at startup. It is only ever empty
    /// once.
    pub speech_model: String,
    /// Whether to look for a newer version each time the application starts.
    ///
    /// **On**, unlike the check-in, and separate from it for a reason: the
    /// check-in is opt-in and most churches will never switch it on, which
    /// makes it exactly the wrong channel for this — the churches least likely
    /// to opt in are the ones least likely to be watching a downloads page.
    ///
    /// It is defensible on by default because it sends nothing: a plain read of
    /// a public list of releases, identical from every installation, and it does
    /// not reach our servers at all. An operator who wants a machine that
    /// touches nothing can still turn it off, which is why this exists.
    #[serde(default = "yes")]
    pub update_check: bool,


    /*
     * Speaking to the machine instead of reaching for it.
     *
     * Off until a church turns it on. The failure worth designing against is a
     * screen that moves because of something a preacher said, which is worse
     * than a feature nobody found.
     */
    #[serde(default)]
    pub voice_commands: bool,
    /// A second way to be heard rather than a requirement: with one set,
    /// anything said after it counts. Empty is fine — an instruction then has
    /// to be the whole of what was said.
    #[serde(default)]
    pub wake_word: String,
    /// A church's own words, pointed at actions we already have.
    #[serde(default)]
    pub voice_phrases: Vec<castavox_core::commands::Phrase>,
    pub semantic_enabled: bool,
    /// Cosine similarity a match must reach to be shown, 0 to 1.
    pub semantic_threshold: f32,

    /// How the congregation-facing window looks.
    ///
    /// The look every output falls back to. An output that names a template of
    /// its own uses that instead; one that does not uses this, which is what
    /// the two windows always shared.
    pub projector: ProjectorTheme,

    /// The congregation-facing outputs, beyond the first.
    ///
    /// Empty on every installation that predates this, which is the behaviour
    /// it replaces: one projector, one optional second display, both showing
    /// the same thing in the same look. A church that never opens this pane
    /// keeps exactly that.
    #[serde(default)]
    pub outputs: Vec<Output>,
}

/// The reserved id of the projector, whose window label and title predate the
/// outputs list and are known to `ndi_capture` and to churches' switchers.
pub const OUTPUT_MAIN: &str = "main";
/// The reserved id of the second display, for the same reason.
pub const OUTPUT_SECOND: &str = "second";

/// Whether an output is one of the two that cannot be removed.
pub fn is_reserved(id: &str) -> bool {
    id == OUTPUT_MAIN || id == OUTPUT_SECOND
}

/// One congregation-facing output: a screen, a network feed, or both.
///
/// # Why an output is not just a window
///
/// It was two windows, `projector` and `second`, deliberately identical -- the
/// same look, the same translation, the same everything, so a change to one
/// could not be forgotten in the other. That is right when a church has one
/// screen and a spare, and wrong the moment they have a stream that wants a
/// lower third, a main wall that wants full cards, and an overflow room reading
/// a different translation.
///
/// So the sameness moves down a level: **content is shared, presentation is
/// not**. Every output shows the same verse at the same moment -- two outputs
/// disagreeing about what is live is the one failure this cannot have -- and
/// each draws it however it was told to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Output {
    /// Stable for the life of the output: it is the window label, the settings
    /// key and what the network name is derived from. Generated once and never
    /// reused, so deleting an output and adding another cannot inherit its
    /// place in a switcher's source list.
    pub id: String,
    /// What the operator calls it. "Foyer", "Stream", "Overflow".
    pub name: String,
    /// Catalog id of the template it draws with, as a string because that is
    /// what the front end holds. Empty follows the theme on the Display pane.
    pub template: String,
    /// Which translation it resolves references in. Empty follows the Scripture
    /// panel, which is what most churches want and all of them had.
    pub translation: String,
    /// Monitor index, or `None` for an output with no screen of its own.
    pub display: Option<usize>,
    /// Whether it is announced on the network.
    pub ndi_enabled: bool,
    /// Its name on the network. Empty derives one from `name`, so a church that
    /// never opens this still gets "Pulpitry — Foyer" rather than a second
    /// source called "Pulpitry" that a switcher operator cannot tell apart.
    pub ndi_name: String,
    /// What an output with no screen is drawn at, and how often it is sent.
    ///
    /// A monitor-backed output takes its size from the monitor, which is the
    /// only size that can be right for it. One that exists only on the network
    /// has no monitor to ask, so it is told -- and 1080p at 30 is what a
    /// church's switcher expects unless somebody says otherwise.
    pub width: u32,
    pub height: u32,
    pub fps: u32,

    /// Which overlay form it draws, or `none` for the whole screen.
    ///
    /// # Why this is the difference that matters
    ///
    /// A full-screen output is a *picture*: a background, and words on it. It
    /// is what a projector wants and it is useless to a video switcher, which
    /// already has a camera to show and needs the words *over* it.
    ///
    /// An overlay output draws only its own furniture -- a bar, a chip, a
    /// caption -- on nothing at all. The window is transparent, the capture
    /// keeps the alpha, and NDI carries it, so the far end keys it over
    /// whatever it is already showing. That is the whole point: what we send
    /// is the template, not a photograph of a screen with the template on it.
    ///
    /// Empty and "none" both mean the full screen, so an output written before
    /// this existed keeps behaving as it did.
    pub overlay: String,

    /// Whether this output sets its words in capitals.
    ///
    /// Per output because the right answer differs by screen and not by
    /// church. A broadcast lower third is nearly always capitals -- it is
    /// short, it is read in a glance, and capitals hold their shape against a
    /// moving picture. A wall carrying four verses is the opposite: capitals
    /// remove the ascenders and descenders a reader's eye uses to tell words
    /// apart, and a paragraph of them is markedly slower to read.
    ///
    /// So a church with a stream and a main screen wants both at once, which
    /// is exactly what one setting for the whole application could not give
    /// them.
    pub uppercase: bool,

    /// Whether a stage output shows the wall clock beside its timer.
    ///
    /// On by default, because a platform rarely has a clock the speaker can
    /// see without turning round. Off for a stage that has one on the wall, or
    /// for a church that would rather a preacher watched the minutes they have
    /// left rather than the time of day.
    pub stage_clock: bool,
    /// Whether a stage output shows what the congregation is looking at.
    ///
    /// On by default, and worth being able to switch off: a screen showing
    /// only a timer is a different instrument. It can be small, it can be at
    /// the back of the hall, and it can be read at a glance from anywhere on
    /// the platform -- which a screen carrying a paragraph cannot.
    pub stage_live: bool,
}

impl Output {
    /// Whether this output is drawn on nothing, to be keyed at the far end.
    ///
    /// The one question the window builder, the capture and the projector page
    /// all need answered the same way, so it is answered once.
    pub fn is_overlay(&self) -> bool {
        !matches!(self.overlay.trim(), "" | "none")
    }
}

impl Default for Output {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            template: String::new(),
            translation: String::new(),
            display: None,
            ndi_enabled: false,
            ndi_name: String::new(),
            width: 1920,
            height: 1080,
            fps: 30,
            overlay: String::new(),
            // Sentence case: it is what the projector has always drawn, and
            // the form that stays readable at any length.
            uppercase: false,
            stage_clock: true,
            stage_live: true,
        }
    }
}

/// Appearance of the projector output.
///
/// Kept in settings rather than in the projector window so the operator window
/// can preview it, and so it survives the projector being closed and reopened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectorTheme {
    /// Key into the family list the UI offers, not a raw CSS stack.
    pub font_family: String,
    /// Multiplies the length-based automatic sizing.
    pub font_scale: f32,
    pub text_color: String,
    /// Outline width in pixels at 1080p; 0 turns it off. Essential once there
    /// is a photograph behind the text.
    pub outline_width: f32,
    pub outline_color: String,
    /// A soft drop shadow, which lifts text off busy backgrounds where a hard
    /// outline would look heavy.
    pub shadow: bool,
    /// "color" | "gradient" | "image" | "video"
    pub background_kind: String,
    pub background_color: String,
    /// Ends of the gradient, and the angle it runs at in degrees. A wash of
    /// colour reads better behind text than a photograph and costs nothing to
    /// carry, which makes it the useful middle ground between the two.
    pub gradient_from: String,
    pub gradient_to: String,
    pub gradient_angle: f32,
    /// Absolute path to the chosen image or video.
    pub background_path: Option<String>,
    /// Darkens the background behind the text, 0 to 1. The single most
    /// effective way to keep words readable over a bright photograph.
    pub background_dim: f32,

    /// How the picture meets the frame: "cover" | "contain" | "fill".
    ///
    /// Cover fills the screen and crops whatever does not fit, which is right
    /// almost always -- a projector has one shape and a photograph has
    /// another. Contain is for a picture that must be seen whole: a diagram, a
    /// map, an image with words in it, where cropping loses the point. Fill
    /// stretches, which distorts, and exists because somebody occasionally
    /// wants it and refusing would be us deciding.
    ///
    /// Empty means cover, so a theme written before this keeps what it had.
    pub background_fit: String,
    /// Scales the picture about its centre. 1.0 is untouched.
    ///
    /// For the photograph whose subject sits just outside the crop, which is
    /// otherwise unfixable without opening an image editor at ten to eleven on
    /// a Sunday.
    pub background_scale: f32,
    /// Blurs the picture, in pixels at 1080p. 0 is off.
    ///
    /// A different instrument from the scrim, and the better one for a busy
    /// photograph: dimming makes a picture darker, blurring makes it stop
    /// competing. Together they turn nearly any photograph into a background
    /// that words can sit on.
    pub background_blur: f32,
    /// "none" | "grain" | "linen" | "dots" | "vignette". Laid over whatever
    /// the background is, so a flat colour stops looking like a flat colour.
    /// Which drawn motion a "motion" background is: drift, bokeh, rays, stars.
    ///
    /// Drawn in the window from the theme's own gradient colours rather than
    /// played from a file, so it needs no licence, no download, and looks like
    /// the church rather than like stock footage.
    #[serde(default = "drift")]
    pub motion: String,
    /// Multiplies how fast it moves. 1 is as designed.
    #[serde(default = "one")]
    pub motion_speed: f32,
    pub texture: String,
    /// How strongly the texture reads, 0 to 1.
    pub texture_strength: f32,
    pub show_reference: bool,

    /// Typeface for the reference line. Empty follows the scripture's.
    ///
    /// Empty rather than a copy, so a theme that never touches this keeps
    /// tracking the scripture when its typeface changes later.
    pub reference_font_family: String,
    /// Multiplies the reference's size. 1.0 is what it has always been.
    pub reference_scale: f32,
    /// Colour for the reference line. Empty follows the scripture's.
    pub reference_color: String,

    /// The fill behind a panel: a card, a step, a quadrant.
    ///
    /// Empty derives one from the accent, so a theme written before panels
    /// existed gets structure without anybody opening the editor.
    ///
    /// Here as well as in the frontend because it has to be. `serde` drops a
    /// field it does not know about, silently, and this struct is what every
    /// theme is written through -- so a colour the operator chose would reach
    /// the disk and not come back. Three separate features have been lost that
    /// way already: a slide's components, a mirrored comparison, and a
    /// background image.
    pub panel_color: String,
    /// Text on that fill. Empty follows the body's.
    pub panel_text_color: String,
}

impl Default for ProjectorTheme {
    fn default() -> Self {
        Self {
            font_family: "sourceSerif".into(),
            font_scale: 1.0,
            text_color: "#1C1B18".into(),
            outline_width: 0.0,
            outline_color: "#000000".into(),
            shadow: false,
            background_kind: "color".into(),
            background_color: "#F4F1EA".into(),
            gradient_from: "#F4F1EA".into(),
            gradient_to: "#D9D2C2".into(),
            gradient_angle: 160.0,
            background_path: None,
            background_dim: 0.0,
            // Cover, untouched and unblurred: what every theme drew before
            // these existed, so nothing already saved changes appearance.
            background_fit: String::new(),
            background_scale: 1.0,
            background_blur: 0.0,
            motion: drift(),
            motion_speed: one(),
            texture: "none".into(),
            texture_strength: 0.35,
            show_reference: true,
            // Empty and 1.0: the reference looks exactly as it did before it
            // was adjustable, so no existing theme is changed by this existing.
            reference_font_family: String::new(),
            reference_scale: 1.0,
            reference_color: String::new(),
            panel_color: String::new(),
            panel_text_color: String::new(),
        }
    }
}

/// What a settings file written before the local engine existed was using.
///
/// Not `Settings::default()`, which is a *new* install. This is only for the
/// field being absent from a file already on disk -- written when Azure was
/// the only engine -- and that option has since been withdrawn, so the answer
/// is this machine.
fn engine_before_the_local_one() -> String {
    "local".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "en-US".into(),
            input_device_id: None,
            translation: "KJV".into(),
            verse_display: manual(),
            assist_enabled: false,
            assist_endpoint: String::new(),
            assist_model: String::new(),
            assist_api_version: DEFAULT_ASSIST_API_VERSION.into(),
            assist_shape: "openAi".into(),
            speech_engine: "local".to_string(),
            voice_commands: false,
            wake_word: String::new(),
            voice_phrases: Vec::new(),
            ndi_enabled: false,
            ndi_name: String::new(),
            hosted_device_id: String::new(),
            speech_model: String::new(),
            mirror_enabled: false,
            mirror_pairings: Vec::new(),
            // Off. Only an operator turns this on.
            update_check: true,
            semantic_enabled: true,
            // Measured against the full 31,102-verse index, and against the
            // negative class that actually matters. Announcements are easy to
            // reject (they top out at 0.59). The hard case is preaching that
            // is *thematic* without quoting anything — "what it means to walk
            // in the light", "the church is called to love one another" —
            // which lands at 0.58-0.68 and is most of a sermon. Genuine
            // paraphrases sit at 0.71-0.81, so this separates them cleanly.
            semantic_threshold: 0.70,
            projector: ProjectorTheme::default(),
            outputs: Vec::new(),
        }
    }
}

/// What the frontend is allowed to see: the key itself is never returned, only
/// whether one has been stored.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    pub settings: Settings,
    pub has_assist_key: bool,
    /// Whether this machine has been activated on a hosted subscription, which
    /// is what decides if the third engine is offered at all.
    pub has_hosted_subscription: bool,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("could not resolve the app config directory")?;
    fs::create_dir_all(&dir).context("could not create the app config directory")?;
    Ok(dir.join("settings.json"))
}

/// The first default was calibrated against the wrong negative class and let
/// thematic speech through. Anyone still carrying it never chose it, so lift
/// it to the measured value rather than leaving them with the bad one.
const MISCALIBRATED_THRESHOLD: f32 = 0.60;

/// What a settings file written before the choice existed was describing.
fn shape_before_the_others() -> String {
    "azure".to_string()
}

pub fn load(app: &AppHandle) -> Result<Settings> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("could not read {}", path.display()))?;
    // A corrupt settings file should not stop the app from opening.
    let mut settings: Settings = serde_json::from_str(&raw).unwrap_or_default();
    correct_miscalibrated_threshold(&mut settings);
    retire_own_azure(app, &mut settings);
    seat_the_original_two(&mut settings);
    if carry_the_old_feed(&mut settings) {
        let _ = save(app, &settings);
    }
    Ok(settings)
}

/// Moves the old Settings → Stage NDI switch onto the Projector output.
///
/// Once: the old switch is cleared as it is carried, so turning the Projector's
/// feed off afterwards stays off rather than coming back on the next launch.
///
/// The name is kept as the network knew it. The old row published as
/// "Pulpitry" when left empty, and an output left empty publishes as
/// "Pulpitry — Projector" -- a different source, as far as a switcher is
/// concerned, and a church would find its feed missing from the one place
/// they had set it up.
///
/// Returns whether anything moved, so the caller knows to write it down.
fn carry_the_old_feed(settings: &mut Settings) -> bool {
    if !settings.ndi_enabled {
        return false;
    }
    let name = match settings.ndi_name.trim() {
        "" => "Pulpitry".to_string(),
        named => named.to_string(),
    };
    if let Some(main) = settings.outputs.iter_mut().find(|output| output.id == OUTPUT_MAIN) {
        main.ndi_enabled = true;
        if main.ndi_name.trim().is_empty() {
            main.ndi_name = name;
        }
    }
    settings.ndi_enabled = false;
    settings.ndi_name.clear();
    true
}

/// The projector and the second display, as rows in the outputs list.
///
/// # Why they had to join it
///
/// They were two buttons in the title bar with a screen picker each, and
/// everything else an output can be told -- its look, its Bible, whether it is
/// capitals, whether it goes on the network -- was unreachable for exactly the
/// two outputs every church already had. A church with one screen could
/// configure nothing; a church that added a third could configure only that
/// one.
///
/// So the pair become ordinary rows, and the whole pane applies to them. They
/// keep their reserved ids, and through those their original window labels and
/// titles -- `ndi_capture` finds a window by name and a church's switcher has
/// "Pulpitry — Projector" in its source list, so renaming them on upgrade
/// would take a working feed off the air.
///
/// They cannot be removed, which is why they are seated here rather than left
/// to the operator to add: an outputs list with no way to reach the projector
/// would be worse than the buttons it replaced.
fn seat_the_original_two(settings: &mut Settings) {
    for (id, name) in [(OUTPUT_MAIN, "Projector"), (OUTPUT_SECOND, "Second display")] {
        if settings.outputs.iter().any(|output| output.id == id) {
            continue;
        }
        settings.outputs.insert(
            // In order, and before anything a church has added: the projector
            // is the first output in every building that has one.
            if id == OUTPUT_MAIN { 0 } else { settings.outputs.len().min(1) },
            Output {
                id: id.to_string(),
                name: name.to_string(),
                // No screen until the operator says which, exactly as the old
                // picker asked. Guessing a monitor would put a congregation's
                // screen somewhere nobody chose.
                display: None,
                ..Output::default()
            },
        );
    }
}

/**
 * Moves a church off the Azure Speech engine, which has been withdrawn.
 *
 * A church could once stream through an Azure Speech account of its own. That
 * choice is gone, and an installation still holding it has to land somewhere on
 * the next launch.
 *
 * **This machine, not the subscription.** Local costs them nothing and keeps
 * them working; moving them onto a paid engine because we withdrew a free one
 * would be a bill they never agreed to.
 *
 * The key goes with it. It is a secret we asked a church to give us, no longer
 * read anywhere, and a stored credential nothing uses is only ever a liability.
 */
fn retire_own_azure(app: &AppHandle, settings: &mut Settings) {
    if settings.speech_engine != "azure" {
        return;
    }
    settings.speech_engine = "local".into();
    let _ = clear_azure_key();
    let _ = save(app, settings);
}

fn correct_miscalibrated_threshold(settings: &mut Settings) {
    if (settings.semantic_threshold - MISCALIBRATED_THRESHOLD).abs() < f32::EPSILON {
        settings.semantic_threshold = Settings::default().semantic_threshold;
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<()> {
    let path = settings_path(app)?;
    let raw = serde_json::to_string_pretty(settings)?;
    fs::write(&path, raw).with_context(|| format!("could not write {}", path.display()))?;
    Ok(())
}

fn entry() -> Result<keyring::Entry> {
    entry_for(KEYCHAIN_ACCOUNT)
}

fn entry_for(account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .context("could not reach the OS credential store")
}

pub fn save_assist_key(key: &str) -> Result<()> {
    entry_for(KEYCHAIN_ASSIST_ACCOUNT)?
        .set_password(key)
        .context("could not save the model key to the OS credential store")
}

pub fn load_assist_key() -> Result<Option<String>> {
    match entry_for(KEYCHAIN_ASSIST_ACCOUNT)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(anyhow::Error::new(err).context("could not read the model key")),
    }
}

pub fn clear_assist_key() -> Result<()> {
    match entry_for(KEYCHAIN_ASSIST_ACCOUNT)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(anyhow::Error::new(err).context("could not remove the model key")),
    }
}

pub fn has_assist_key() -> bool {
    matches!(load_assist_key(), Ok(Some(_)))
}



pub fn clear_azure_key() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(anyhow::Error::new(err).context("could not remove the Azure key")),
    }
}


pub fn save_hosted_token(token: &str) -> Result<()> {
    entry_for(KEYCHAIN_HOSTED_ACCOUNT)?
        .set_password(token)
        .context("could not save the subscription to the OS credential store")
}

pub fn load_hosted_token() -> Result<Option<String>> {
    match entry_for(KEYCHAIN_HOSTED_ACCOUNT)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(anyhow::Error::new(err).context("could not read the subscription")),
    }
}

pub fn clear_hosted_token() -> Result<()> {
    match entry_for(KEYCHAIN_HOSTED_ACCOUNT)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(anyhow::Error::new(err).context("could not remove the subscription")),
    }
}

pub fn has_hosted_token() -> bool {
    matches!(load_hosted_token(), Ok(Some(_)))
}

/// This machine's identifier, made on first use and kept from then on.
pub fn device_id(app: &AppHandle) -> Result<String> {
    let mut settings = load(app)?;
    if settings.hosted_device_id.trim().is_empty() {
        settings.hosted_device_id = castavox_core::hosted::new_device_id();
        save(app, &settings)?;
    }
    Ok(settings.hosted_device_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A theme saved before drawn backgrounds existed still loads.
    ///
    /// The fields are defaulted rather than required, so an upgrade does not
    /// meet a parse error -- and the motion that comes back has to be a real
    /// one, because an empty string would draw nothing at all.
    #[test]
    fn a_theme_without_the_motion_fields_still_loads() {
        // Two hashes: the fixture is full of hex colours, and `"#` would end a
        // string opened with one.
        let json = r##"{
            "fontFamily": "inter",
            "fontScale": 1.0,
            "textColor": "#1C1B18",
            "outlineWidth": 0.0,
            "outlineColor": "#000000",
            "shadow": false,
            "backgroundKind": "color",
            "backgroundColor": "#F4F1EA",
            "gradientFrom": "#F4F1EA",
            "gradientTo": "#D9D2C2",
            "gradientAngle": 160.0,
            "backgroundPath": null,
            "backgroundDim": 0.0,
            "backgroundFit": "",
            "backgroundScale": 1.0,
            "backgroundBlur": 0.0,
            "texture": "none",
            "textureStrength": 0.35,
            "showReference": true,
            "referenceFontFamily": "",
            "referenceScale": 1.0,
            "referenceColor": "",
            "panelColor": "",
            "panelTextColor": ""
        }"##;

        let theme: ProjectorTheme = serde_json::from_str(json).expect("an older theme loads");
        assert_eq!(theme.motion, "drift");
        assert_eq!(theme.motion_speed, 1.0);
    }

    #[test]
    fn the_old_default_threshold_is_lifted_to_the_measured_one() {
        // Nobody chose 0.60 — it was a default calibrated against the wrong
        // negative class, so carrying it forward would leave working installs
        // surfacing thematic speech as if it were quotation.
        let mut settings = Settings { semantic_threshold: 0.60, ..Settings::default() };
        correct_miscalibrated_threshold(&mut settings);
        assert_eq!(settings.semantic_threshold, 0.70);
    }

    /// A church that had the old NDI row on keeps its feed, under its name.
    #[test]
    fn the_old_feed_moves_onto_the_projector_once() {
        let mut settings = Settings { ndi_enabled: true, ..Settings::default() };
        seat_the_original_two(&mut settings);

        assert!(carry_the_old_feed(&mut settings));
        let main = settings.outputs.iter().find(|output| output.id == OUTPUT_MAIN).unwrap();
        assert!(main.ndi_enabled);
        // What the old row published as when its name was left empty.
        assert_eq!(main.ndi_name, "Pulpitry");

        // Once. Turning the Projector's feed off must not be undone next launch.
        assert!(!settings.ndi_enabled);
        assert!(!carry_the_old_feed(&mut settings));
    }

    /// A name the church chose is the name the switcher knows, so it is kept.
    #[test]
    fn the_old_feed_keeps_its_name() {
        let mut settings = Settings {
            ndi_enabled: true,
            ndi_name: "Main hall".into(),
            ..Settings::default()
        };
        seat_the_original_two(&mut settings);
        carry_the_old_feed(&mut settings);
        let main = settings.outputs.iter().find(|output| output.id == OUTPUT_MAIN).unwrap();
        assert_eq!(main.ndi_name, "Main hall");
    }

    /// Off stays off: nothing is switched on for a church that never asked.
    #[test]
    fn no_old_feed_moves_nothing() {
        let mut settings = Settings::default();
        seat_the_original_two(&mut settings);
        assert!(!carry_the_old_feed(&mut settings));
        assert!(settings.outputs.iter().all(|output| !output.ndi_enabled));
    }

    #[test]
    fn the_original_two_are_seated_and_kept_in_order() {
        // A file from before the outputs list existed.
        let mut settings: Settings = serde_json::from_str(r#"{"translation":"kjv"}"#).unwrap();
        seat_the_original_two(&mut settings);

        let ids: Vec<&str> = settings.outputs.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, vec![OUTPUT_MAIN, OUTPUT_SECOND]);
        // No screen guessed: putting a congregation's display somewhere
        // nobody chose is worse than asking.
        assert!(settings.outputs.iter().all(|o| o.display.is_none()));

        // Run again -- every launch does -- and nothing is duplicated, and
        // nothing an operator set is overwritten.
        settings.outputs[0].name = "Main wall".into();
        settings.outputs[0].display = Some(1);
        seat_the_original_two(&mut settings);
        assert_eq!(settings.outputs.len(), 2);
        assert_eq!(settings.outputs[0].name, "Main wall");
        assert_eq!(settings.outputs[0].display, Some(1));
    }

    /// A church's own outputs keep their place behind the two.
    #[test]
    fn seating_does_not_disturb_outputs_a_church_added() {
        let mut settings = Settings::default();
        settings.outputs.push(Output { id: "foyer".into(), name: "Foyer".into(), ..Output::default() });
        seat_the_original_two(&mut settings);

        let ids: Vec<&str> = settings.outputs.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, vec![OUTPUT_MAIN, OUTPUT_SECOND, "foyer"]);
    }

    /// A church that never opens the new pane keeps exactly what it had.
    #[test]
    fn settings_written_before_outputs_existed_have_none() {
        // The field is absent from every settings file on disk today. Absent
        // must mean "one projector and an optional second, both the same",
        // which is what an empty list means -- not a default output that
        // starts announcing itself on a church network unasked.
        let before = r#"{"translation":"kjv"}"#;
        let settings: Settings = serde_json::from_str(before).expect("older settings");
        assert!(settings.outputs.is_empty(), "no output should be invented");
    }

    /// An output round-trips as the operator window writes it.
    #[test]
    fn an_output_keeps_what_was_set_on_it() {
        let json = r#"{
            "id": "out-2",
            "name": "Foyer",
            "template": "7",
            "translation": "niv",
            "display": 1,
            "ndiEnabled": true,
            "ndiName": "Pulpitry — Foyer"
        }"#;
        let output: Output = serde_json::from_str(json).expect("an output");
        assert_eq!(output.name, "Foyer");
        assert_eq!(output.template, "7");
        assert_eq!(output.translation, "niv");
        assert_eq!(output.display, Some(1));
        assert!(output.ndi_enabled);

        // A screenless output is a real arrangement, not a missing field: it
        // exists only on the network. `None` has to survive the round trip
        // rather than becoming monitor zero, which is the operator's screen.
        let screenless = r#"{"id":"out-3","name":"Stream","ndiEnabled":true}"#;
        let output: Output = serde_json::from_str(screenless).expect("a screenless output");
        assert_eq!(output.display, None);
        assert!(output.translation.is_empty(), "empty follows the panel");
    }

    fn a_theme_saved_before_gradients_existed_still_loads() {
        // Settings written by an earlier build have none of these keys. The
        // struct-level serde default is what keeps that from wiping a theme an
        // operator spent time on, so it is worth pinning.
        let old = r##"{
            "fontFamily":"sourceSerif","fontScale":1.2,"textColor":"#FFFFFF",
            "outlineWidth":2.0,"outlineColor":"#000000","shadow":true,
            "backgroundKind":"image","backgroundColor":"#101010",
            "backgroundPath":"/pictures/dove.jpg","backgroundDim":0.4,
            "showReference":true
        }"##;
        let theme: ProjectorTheme = serde_json::from_str(old).expect("an older theme");

        assert_eq!(theme.font_scale, 1.2);
        assert_eq!(theme.background_path.as_deref(), Some("/pictures/dove.jpg"));
        assert_eq!(theme.texture, "none");
        // A drawn background is the gentle one until somebody chooses another.
        assert_eq!(theme.motion, "drift");
        assert_eq!(theme.motion_speed, 1.0);
        assert_eq!(theme.gradient_angle, 160.0);
    }

    #[test]
    fn a_theme_round_trips_as_the_operator_window_writes_it() {
        let json = r##"{
            "fontFamily":"inter","fontScale":1.0,"textColor":"#FFFFFF",
            "outlineWidth":0.0,"outlineColor":"#000000","shadow":false,
            "backgroundKind":"gradient","backgroundColor":"#101010",
            "gradientFrom":"#123456","gradientTo":"#654321","gradientAngle":45.0,
            "backgroundPath":null,"backgroundDim":0.0,
            "texture":"linen","textureStrength":0.5,"showReference":true
        }"##;
        let theme: ProjectorTheme = serde_json::from_str(json).expect("a gradient theme");

        assert_eq!(theme.background_kind, "gradient");
        assert_eq!(theme.gradient_from, "#123456");
        assert_eq!(theme.texture, "linen");
        assert_eq!(theme.texture_strength, 0.5);

        let encoded = serde_json::to_string(&theme).expect("encode");
        assert!(encoded.contains("\"gradientFrom\""), "wire format drifted: {encoded}");
        assert!(encoded.contains("\"textureStrength\""), "wire format drifted: {encoded}");
    }

    #[test]
    fn a_threshold_the_operator_chose_is_left_alone() {
        for chosen in [0.45, 0.55, 0.65, 0.80] {
            let mut settings = Settings { semantic_threshold: chosen, ..Settings::default() };
            correct_miscalibrated_threshold(&mut settings);
            assert_eq!(settings.semantic_threshold, chosen, "clobbered a chosen value");
        }
    }
}
