import { invoke } from "@tauri-apps/api/core";

import { FONT_FAMILIES } from "./theme";

/**
 * The typefaces on this machine.
 *
 * Read from the platform rather than from the webview: `queryLocalFonts` exists
 * on one of the three platforms Pulpitry runs on, and not the one most churches
 * are on. See src-tauri/src/fonts.rs.
 */
let asked: Promise<string[]> | null = null;

/**
 * Every family installed here, cached for the session.
 *
 * Cached because it cannot change while the app is running in any way that
 * matters — a font installed mid-service is not a case worth a re-read — and
 * because two pickers open one after another should not both pay for the call.
 *
 * An empty list where the platform cannot answer, which is a list with only the
 * bundled faces in it rather than an error: a church that never wanted their
 * own typeface should not meet a failure about one.
 */
export function systemFonts(): Promise<string[]> {
  asked ??= invoke<string[]>("list_fonts").catch(() => []);
  return asked;
}

/** The bundled keys, so a system family is told apart from one of ours. */
const BUNDLED = new Set(FONT_FAMILIES.map((entry) => entry.key));

/**
 * What a stored `fontFamily` means.
 *
 * One of ours is a key — "sourceSerif" — and anything else is the name of a
 * family on the machine that chose it. Told apart by the key list rather than
 * by shape, because "times" is both a plausible key and a plausible family.
 */
export function isBundled(family: string): boolean {
  return BUNDLED.has(family);
}
