//! A hosted subscription, as the operator sees it.
//!
//! Activation, deactivation, and how much of the plan is left. The talking to
//! the broker is in castavox-core so that Castavox says the same things; what
//! is here is where the token is kept and how the answer is worded for a
//! settings dialog.
//!
//! # Everything here is async, deliberately
//!
//! Tauri runs a synchronous command on the main thread. All three of these make
//! a network request, and a request on the main thread freezes the window until
//! it answers — for the full twenty-second timeout when the connection is bad,
//! which is exactly when somebody is most likely to be prodding at settings.
//! The blocking client then runs on a blocking thread rather than on the async
//! runtime, which it would otherwise stall.

use std::collections::BTreeMap;

use castavox_core::hosted::{self, App, Broker, Error};
use serde::Serialize;
use tauri::AppHandle;

use crate::settings;

/// What a settings dialog needs to draw the subscription section.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedView {
    /// Whether this machine holds a subscription at all.
    pub activated: bool,
    /// What the plan has left. Absent when the broker could not be reached,
    /// which is not the same as having nothing left.
    pub entitlement: Option<EntitlementView>,
    /// Why there is no entitlement to show, in words for the operator.
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementView {
    pub status: String,
    /// "12 hr 30 min", worded once in castavox-core so both products agree.
    pub speech_remaining: String,
    pub speech_seconds: i64,
    pub used_fraction: f64,
    /// The highest warning threshold passed, or none while there is room.
    pub warn_at: Option<f64>,
    pub period_ends_at: i64,
    pub expires_at: Option<i64>,
    /// Speech seconds by product, which the pooled quota otherwise hides.
    pub by_app: BTreeMap<String, i64>,
}

impl From<hosted::Entitlement> for EntitlementView {
    fn from(state: hosted::Entitlement) -> Self {
        Self {
            speech_remaining: hosted::readable(state.remaining.speech_seconds),
            speech_seconds: state.remaining.speech_seconds,
            used_fraction: state.remaining.speech_used_fraction,
            warn_at: state.remaining.warn_at,
            period_ends_at: state.period_ends_at,
            expires_at: state.expires_at,
            by_app: state
                .usage
                .by_app
                .into_iter()
                .map(|(app, usage)| (app, usage.speech_seconds))
                .collect(),
            status: state.status,
        }
    }
}

/// Reads the subscription's state, without asking the operator to do anything.
///
/// Called when settings open. A machine that is activated but offline reports
/// exactly that, rather than reporting nothing and letting the dialog imply the
/// subscription has gone.
fn look() -> HostedView {
    let Some(token) = settings::load_hosted_token().ok().flatten() else {
        return HostedView::default();
    };

    match Broker::new().entitlement(&token) {
        Ok(state) => HostedView {
            activated: true,
            entitlement: Some(state.into()),
            notice: None,
        },
        // A refusal here means the token is no longer any good — revoked, or
        // the subscription ended. Still activated as far as this machine is
        // concerned; the message says why it will not work.
        Err(error) => HostedView {
            activated: true,
            entitlement: None,
            notice: Some(error.to_string()),
        },
    }
}

#[tauri::command]
pub async fn hosted_status() -> HostedView {
    tauri::async_runtime::spawn_blocking(look)
        .await
        .unwrap_or_default()
}

/// Exchanges a licence key for a token this machine keeps.
///
/// The key is accepted the way somebody reads it off an invoice — spaced, in
/// whatever case they typed it — because the broker normalises it and refusing
/// a licence over a space would be our fault presented as theirs.
#[tauri::command]
pub async fn hosted_activate(app: AppHandle, licence: String) -> Result<HostedView, String> {
    let device_id = settings::device_id(&app).map_err(crate::to_message)?;
    let name = hostname();

    let activated = tauri::async_runtime::spawn_blocking(move || {
        Broker::new().activate(&licence, &device_id, App::Pulpitry, &name)
    })
    .await
    .map_err(|_| "Activation was interrupted.".to_string())?;

    match activated {
        Ok(activated) => {
            settings::save_hosted_token(&activated.token).map_err(crate::to_message)?;
            Ok(tauri::async_runtime::spawn_blocking(look)
                .await
                .unwrap_or_default())
        }
        // Shown to the operator as the broker worded it. It knows whether the
        // key was wrong, the seats are used up or the subscription has ended,
        // and each of those wants a different thing done about it.
        Err(error) => Err(describe(&error)),
    }
}

/// Forgets the subscription on this machine.
///
/// Local only: the seat is released when the broker is told, and it is not told
/// here. That is deliberate — a church that wipes a laptop should not silently
/// lose a seat it paid for, and releasing seats is an administrative act.
#[tauri::command]
pub async fn hosted_deactivate(app: AppHandle) -> Result<HostedView, String> {
    settings::clear_hosted_token().map_err(crate::to_message)?;

    // Back to Azure, so a machine is never left selecting an engine it can no
    // longer reach. Whisper would be the kinder default but it needs a model
    // downloaded, and offering an engine that cannot start is not kindness.
    if let Ok(mut current) = settings::load(&app) {
        if current.speech_engine == "hosted" {
            current.speech_engine = "azure".to_string();
            let _ = settings::save(&app, &current);
        }
    }

    Ok(HostedView::default())
}

/// Turns a failure into the sentence the operator should read.
fn describe(error: &Error) -> String {
    match error {
        // Passed through: the broker wrote these for exactly this moment.
        Error::Refused { .. } => error.to_string(),
        Error::Unreachable(_) => error.to_string(),
        Error::Unexpected(detail) => {
            crate::log_line!("[hosted] unexpected answer from the broker: {detail}");
            error.to_string()
        }
    }
}

/// A name for this machine, so a church can tell its seats apart.
///
/// Best effort and cosmetic: it appears beside the seat in our own records, and
/// a church with two laptops wants to know which one it is looking at. COMPUTERNAME
/// is set on Windows; a GUI process on macOS usually has neither HOSTNAME nor
/// much else, so the user name is the last thing worth trying.
fn hostname() -> String {
    for name in ["COMPUTERNAME", "HOSTNAME", "USER", "USERNAME"] {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim();
            if !value.is_empty() {
                return value.chars().take(60).collect();
            }
        }
    }
    "This machine".to_string()
}
