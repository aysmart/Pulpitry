/**
 * Whether a key press belongs to the operator's hands rather than to a shortcut.
 *
 * Two cases, and both are the difference between a shortcut and a hazard.
 *
 * Somebody typing in a search box pressing Left means "move the caret", and a
 * shortcut that steps the live verse instead would change what a congregation
 * is reading because the operator looked for a hymn.
 *
 * Somebody with a dialogue open is looking at the dialogue. Arrow keys there
 * belong to it, and stepping the wall from underneath a settings window is a
 * change nobody can see the cause of.
 */
export function handsAreBusy(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return true;

  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target?.isContentEditable) return true;

  // Marked on the dialogues themselves rather than matched by their styling:
  // a class is a thing somebody restyles without knowing this depends on it.
  return document.querySelector("[data-dialog]") !== null;
}
