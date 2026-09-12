//! The typefaces installed on this machine.
//!
//! # Why the operating system is asked rather than the webview
//!
//! A browser can be asked this — `queryLocalFonts` — on exactly one of the
//! three platforms Pulpitry runs on, behind a permission prompt, in a Chromium
//! recent enough to have it. macOS has no such API in its webview at all. So
//! the list comes from the platform: Core Text on macOS, the font registry on
//! Windows, fontconfig on Linux.
//!
//! # What a church does with it
//!
//! Every look shipped with Pulpitry is set in a face that exists everywhere,
//! which is right for a default and wrong as a limit: a church with a brand has
//! a typeface, it is already installed on the machine that runs the service,
//! and until now the answer was that they could not use it. A slide deck or a
//! theme may now name any family on the machine.
//!
//! A deck that names a family is drawn in it where the family is present and
//! falls back to the bundled serif where it is not — the stack is built on the
//! front end, so a deck carried to another church still reads.

use std::collections::BTreeSet;

/// Every font family on this machine, in the order a list should show them.
///
/// A `BTreeSet` throughout: the platforms return duplicates — a family
/// installed for one user and for everybody, the same face in several styles —
/// and they return them in installation order, which is no order at all to a
/// person looking for a name.
pub fn families() -> Vec<String> {
    let mut found = BTreeSet::new();
    gather(&mut found);

    found
        .into_iter()
        .filter(|name| {
            let trimmed = name.trim();
            /*
             * Dropped: the hidden system families.
             *
             * macOS reports a dozen names beginning with a dot -- ".SF NS",
             * ".LastResort" -- which are the system's own and are not meant to
             * be chosen. Asking for one gets a face that may change with the
             * next OS release, so they are not offered.
             */
            !trimmed.is_empty() && !trimmed.starts_with('.')
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn gather(found: &mut BTreeSet<String>) {
    use core_foundation::array::CFArray;
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> core_foundation::array::CFArrayRef;
    }

    /*
     * Core Text rather than AppKit.
     *
     * `NSFontManager` answers the same question and is main-thread-only, and
     * this runs on whichever thread the command was dispatched to. Core Text's
     * font manager is thread-safe, so there is nothing to marshal.
     */
    let names = unsafe {
        let raw = CTFontManagerCopyAvailableFontFamilyNames();
        if raw.is_null() {
            return;
        }
        // `create` rather than `get`: the function's name says Copy, so this
        // owns the array and releases it when it goes out of scope.
        CFArray::<CFString>::wrap_under_create_rule(raw)
    };

    for name in names.iter() {
        found.insert(name.to_string());
    }
}

#[cfg(target_os = "windows")]
fn gather(found: &mut BTreeSet<String>) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const FONTS: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";

    // Both, because a font installed for one user is not in the machine's key
    // and is exactly the kind a church's own branding arrives as.
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let Ok(key) = RegKey::predef(root).open_subkey(FONTS) else {
            continue;
        };
        for (name, _) in key.enum_values().flatten() {
            for family in windows_families(&name) {
                found.insert(family);
            }
        }
    }
}

/// The family names inside one registry entry.
///
/// Windows stores the *description* rather than the family: "Arial (TrueType)",
/// and for a grouped installation "Arial Narrow Bold & Arial Narrow Bold Italic
/// (TrueType)". So the format is stripped and the ampersand list split, which
/// gives names a person recognises rather than the registry's own wording.
#[cfg(target_os = "windows")]
fn windows_families(entry: &str) -> Vec<String> {
    let without_format = match entry.rfind(" (") {
        Some(at) if entry.ends_with(')') => &entry[..at],
        _ => entry,
    };

    without_format
        .split('&')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

#[cfg(target_os = "linux")]
fn gather(found: &mut BTreeSet<String>) {
    /*
     * fontconfig through its own tool.
     *
     * Linking the library would mean a build dependency on every machine that
     * compiles this, for one list read once when a dialogue opens. `fc-list` is
     * part of the same package as the library it reads, so where fontconfig is
     * present the tool is too -- and where neither is, no list is the honest
     * answer rather than a build failure.
     */
    let Ok(output) = std::process::Command::new("fc-list")
        .args(["--format", "%{family[0]}\n"])
        .output()
    else {
        return;
    };

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        // fontconfig gives a comma-separated list of a family's aliases, most
        // familiar first.
        if let Some(name) = line.split(',').next() {
            let name = name.trim();
            if !name.is_empty() {
                found.insert(name.to_string());
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn gather(_found: &mut BTreeSet<String>) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The platform answers at all, and the answer looks like font names.
    ///
    /// Deliberately weak about *which* families: a machine's fonts are its
    /// own, and asserting that Helvetica is present would be asserting
    /// something about the machine running the test rather than about this
    /// code. What is worth holding is that the call works, returns something
    /// on a desktop, and hides nothing the list should not offer.
    #[test]
    fn the_machine_reports_its_families() {
        let families = families();

        if cfg!(any(target_os = "macos", target_os = "windows")) {
            assert!(
                families.len() > 10,
                "a desktop with fewer than ten font families is a broken read: {families:?}"
            );
        }

        assert!(
            families.iter().all(|name| !name.starts_with('.')),
            "the system's hidden families should not be offered: {families:?}"
        );
        assert!(
            families.iter().all(|name| name.trim() == name && !name.is_empty()),
            "names should arrive trimmed and non-empty: {families:?}"
        );

        let mut sorted = families.clone();
        sorted.sort();
        assert_eq!(families, sorted, "the list should be in name order");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_registry_entry_names_the_families_in_it() {
        assert_eq!(windows_families("Arial (TrueType)"), vec!["Arial"]);
        assert_eq!(
            windows_families("Arial Narrow Bold & Arial Narrow Bold Italic (TrueType)"),
            vec!["Arial Narrow Bold", "Arial Narrow Bold Italic"]
        );
        // No format in parentheses, which some entries genuinely lack.
        assert_eq!(windows_families("Segoe UI Variable"), vec!["Segoe UI Variable"]);
    }
}
