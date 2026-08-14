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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub azure_region: String,
    pub language: String,
    pub input_device_id: Option<String>,
    /// The translation the operator is working in. Verse detection searches
    /// this one, so it has to outlive the window that selected it.
    pub translation: String,

    /// Optional Azure AI Foundry model used to suggest paraphrased scripture.
    /// Everything it proposes is verified against the local library before the
    /// operator ever sees it, and exact detection works without any of this.
    pub assist_enabled: bool,
    /// e.g. https://my-resource.services.ai.azure.com/models
    pub assist_endpoint: String,
    /// Deployment or model name, e.g. gpt-4o-mini or Llama-3.3-70B-Instruct.
    pub assist_model: String,
    pub assist_api_version: String,

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
     * Publishing the projector to the network as an NDI source.
     *
     * Off unless asked for, for the mirror's reason and one of its own. It
     * announces this machine on the network and, on macOS, the first attempt
     * raises the Screen Recording prompt -- a permission dialog nobody asked
     * for is alarming, and one that appears on a Sunday morning is worse.
     *
     * It is also the one feature here that is heavy: the projector's pixels,
     * uncompressed, at around 100 Mbit/s for 1080p. That is a wired-network
     * feature and turning it on by accident on church wifi would take the
     * stream down with it.
     */
    #[serde(default)]
    pub ndi_enabled: bool,
    /// What the source is called on the network.
    ///
    /// Empty means the default below. A church with two campuses on one network
    /// needs to tell them apart, and "Pulpitry" twice in a switcher's source
    /// list is a coin toss.
    #[serde(default)]
    pub ndi_name: String,

    /// Local embedding-based paraphrase matching. Offline and free, so it is on
    /// by default; the index costs a couple of minutes to build once.
    /// Which recogniser turns audio into words: "local", "azure" or "hosted".
    ///
    /// A new install gets the local engine: it costs nothing, needs no account
    /// and no network, and it is what most churches should be using. Azure was
    /// the default when it was the only engine, and defaulting to it meant a
    /// fresh install opened on a demand for a subscription key — a paywall in
    /// front of the free thing.
    ///
    /// An install that predates this field still gets Azure, which is what the
    /// serde default below is for. Those machines have a key and a region set
    /// and are transcribing through them; switching their engine on upgrade
    /// would be a change of behaviour nobody asked for, discovered on a Sunday.
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
    pub semantic_enabled: bool,
    /// Cosine similarity a match must reach to be shown, 0 to 1.
    pub semantic_threshold: f32,

    /// How the congregation-facing window looks.
    pub projector: ProjectorTheme,
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
    /// "none" | "grain" | "linen" | "dots" | "vignette". Laid over whatever
    /// the background is, so a flat colour stops looking like a flat colour.
    pub texture: String,
    /// How strongly the texture reads, 0 to 1.
    pub texture_strength: f32,
    pub show_reference: bool,
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
            texture: "none".into(),
            texture_strength: 0.35,
            show_reference: true,
        }
    }
}

/// What a settings file written before the local engine existed was using.
///
/// Not `Settings::default()`, which is a *new* install and gets the local
/// engine. This is only for the field being absent from a file that is already
/// on disk, and the answer there is always Azure: it was the only engine when
/// that file was written.
fn engine_before_the_local_one() -> String {
    "azure".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            azure_region: String::new(),
            language: "en-US".into(),
            input_device_id: None,
            translation: "KJV".into(),
            assist_enabled: false,
            assist_endpoint: String::new(),
            assist_model: String::new(),
            assist_api_version: DEFAULT_ASSIST_API_VERSION.into(),
            speech_engine: "local".to_string(),
            ndi_enabled: false,
            ndi_name: String::new(),
            hosted_device_id: String::new(),
            speech_model: String::new(),
            mirror_enabled: false,
            mirror_pairings: Vec::new(),
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
    pub has_azure_key: bool,
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

pub fn load(app: &AppHandle) -> Result<Settings> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("could not read {}", path.display()))?;
    // A corrupt settings file should not stop the app from opening.
    let mut settings: Settings = serde_json::from_str(&raw).unwrap_or_default();
    correct_miscalibrated_threshold(&mut settings);
    Ok(settings)
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

pub fn save_azure_key(key: &str) -> Result<()> {
    entry()?
        .set_password(key)
        .context("could not save the Azure key to the OS credential store")
}

pub fn load_azure_key() -> Result<Option<String>> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(anyhow::Error::new(err).context("could not read the Azure key")),
    }
}

pub fn clear_azure_key() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(anyhow::Error::new(err).context("could not remove the Azure key")),
    }
}

pub fn has_azure_key() -> bool {
    matches!(load_azure_key(), Ok(Some(_)))
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

    #[test]
    fn the_old_default_threshold_is_lifted_to_the_measured_one() {
        // Nobody chose 0.60 — it was a default calibrated against the wrong
        // negative class, so carrying it forward would leave working installs
        // surfacing thematic speech as if it were quotation.
        let mut settings = Settings { semantic_threshold: 0.60, ..Settings::default() };
        correct_miscalibrated_threshold(&mut settings);
        assert_eq!(settings.semantic_threshold, 0.70);
    }

    #[test]
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
