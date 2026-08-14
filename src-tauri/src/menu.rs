//! The application menu.
//!
//! Until now this was whatever Tauri supplies by default — File, Edit, View,
//! Window, Help, with nothing of Pulpitry's in any of them. That is worse than
//! no menu at all on macOS, where the menu bar is the first place somebody
//! looks for what an application can do, and a stock one says "this was not
//! finished".
//!
//! # What is in it, and what is not
//!
//! Only things that are true from anywhere. A menu item that is meaningful only
//! when a particular panel has focus is a menu item that is greyed out or,
//! worse, silently does nothing — so the passage list, the song library and the
//! schedule keep their own controls and stay out of here.
//!
//! What is left is the service itself: the screens, the microphone, and what is
//! on the wall. Those are the things an operator needs in a hurry, they are the
//! things worth a keyboard shortcut, and they are exactly what is hard to find
//! when the window is covered by a projector output.
//!
//! # Why the items emit rather than act
//!
//! Nearly every action here has a counterpart in the operator window — a button
//! that already knows whether the projector is open, whether the microphone is
//! running, what is staged. Calling the backend directly from a menu item would
//! put a second path into the same state and the two would disagree the first
//! time either changed.
//!
//! So a menu item emits, the window listens, and there is one implementation of
//! each action with two ways to reach it.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// What the operator window listens for. One event, with the item's id.
pub const EVENT_MENU: &str = "menu:chose";

/// The window a menu action is meant for. The projector has no menu bar of its
/// own and must never be the thing that receives one.
const OPERATOR: &str = "operator";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, label, true, accelerator)
    };

    /*
     * macOS puts About, Settings and Quit under the application's own name, and
     * an operator looking for preferences will look there before anywhere else.
     * On Windows and Linux this submenu is simply the first one.
     *
     * About is ours rather than the predefined one. The native panel shows a
     * name, an icon and a version, and cannot show the part worth showing: what
     * is inside — whose speech model, whose translations, whose hymns. A church
     * running this in public should be able to find that out without leaving
     * the application and without taking our word for it.
     */
    let app_menu = Submenu::with_items(
        app,
        "Pulpitry",
        true,
        &[
            &item("about", "About Pulpitry", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    /*
     * Screens, and the shortcuts an operator actually needs.
     *
     * Clear is the one worth its place: a photograph left on the wall through a
     * prayer is the commonest thing anybody wants undone in a hurry, and the
     * button for it is behind whichever panel has focus. Escape already closes
     * a projector; this empties one without closing it.
     */
    let screens = Submenu::with_items(
        app,
        "Screens",
        true,
        &[
            &item("projector", "Projector", Some("CmdOrCtrl+P"))?,
            &item("second", "Second display", Some("CmdOrCtrl+Shift+P"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("clear", "Clear the screen", Some("CmdOrCtrl+."))?,
        ],
    )?;

    let service = Submenu::with_items(
        app,
        "Service",
        true,
        &[
            &item("listen", "Start or stop listening", Some("CmdOrCtrl+L"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("history", "Past services…", Some("CmdOrCtrl+H"))?,
            &item("mirror", "Mirror to Castavox…", None)?,
        ],
    )?;

    // Edit exists for one reason: without it, copy and paste stop working in
    // every text field on macOS. Nothing here is Pulpitry's own.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item("manual", "Pulpitry manual", None)?,
            &item("subscription", "Castavox subscription", None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit, &screens, &service, &window, &help])
}

/// Passes a chosen item to the operator window.
///
/// Two go straight out to a browser instead. A manual that opened inside the
/// application would be a webview with no way back, and the one thing somebody
/// reading documentation needs is their own tabs and their own back button.
pub fn chose<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "manual" => open(app, "https://www.castavox.com/pulpitry/manual"),
        "subscription" => open(app, "https://www.castavox.com/pricing"),
        // Everything else belongs to the window that already knows the state it
        // would change.
        other => {
            if let Some(window) = app.get_webview_window(OPERATOR) {
                let _ = window.emit(EVENT_MENU, other);
            }
        }
    }
}

fn open<R: Runtime>(app: &AppHandle<R>, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        crate::log_line!("[menu] could not open {url}: {error}");
    }
}
