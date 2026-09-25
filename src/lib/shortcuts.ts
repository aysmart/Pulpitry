import { useEffect } from "react";

/**
 * Every shortcut, written down once.
 *
 * Both the keys and the sheet that lists them read this, because a key that
 * does one thing and is described as another is worse than one nobody knows
 * about -- and there were eleven nobody knew about, which is most of why an
 * operator asked for more.
 *
 * The accelerators on the menu bar are here too, though the menu owns them.
 * An operator wanting to know what this desk answers to should find the answer
 * in one list rather than in two places, one of which is a menu they have
 * never opened.
 */
export interface Shortcut {
  keys: string[];
  does: string;
  group: string;
}

export const SHORTCUTS: Shortcut[] = [
  { group: "On the screen", keys: ["Space"], does: "Put what is staged up" },
  {
    group: "On the screen",
    keys: ["Enter", "Enter"],
    does: "Stage what is selected, then put it up",
  },
  {
    group: "On the screen",
    keys: ["B"],
    does: "Blank the screen, and again to bring back what was on it",
  },
  { group: "On the screen", keys: ["⌘/Ctrl", "."], does: "Clear the screen" },

  { group: "Moving through it", keys: ["←", "→"], does: "Previous and next" },
  {
    group: "Moving through it",
    keys: ["↑", "↓"],
    does: "Wind a reading taller than the screen, a screenful at a time",
  },
  {
    group: "Moving through it",
    keys: ["1", "…", "9"],
    does: "Stage that part of the song, or that slide of the deck",
  },
  {
    group: "Moving through it",
    keys: ["[", "]"],
    does: "The desk before or after this one",
  },

  {
    group: "Finding a verse",
    keys: ["⌘/Ctrl", "F"],
    does: "Jump to this desk's search box",
  },
  {
    group: "Finding a verse",
    keys: ["⌘/Ctrl", "Enter"],
    does: "In the scripture box: stage what was typed and put it up",
  },
  {
    group: "Finding a verse",
    keys: ["Shift", "↑ / ↓"],
    does: "Add the verse above or below to the passage staged",
  },

  {
    group: "Screens",
    keys: ["⌘/Ctrl", "P"],
    does: "Open or close the projector",
  },
  {
    group: "Screens",
    keys: ["⌘/Ctrl", "⇧", "P"],
    does: "Open or close the second display",
  },
  {
    group: "Screens",
    keys: ["Esc"],
    does: "On an output covering the screen you work on: close it",
  },

  {
    group: "The desk",
    keys: ["⌘/Ctrl", "L"],
    does: "Start or stop listening",
  },
  { group: "The desk", keys: ["⌘/Ctrl", "H"], does: "Past services" },
  { group: "The desk", keys: ["⌘/Ctrl", ","], does: "Settings" },
  { group: "The desk", keys: ["?"], does: "This list" },
];

/**
 * The keys the window itself answers, as opposed to the menu bar's.
 *
 * Every one of them stands down while the operator is typing or a dialogue is
 * open -- see `handsAreBusy` -- and every one acts on what is *staged* rather
 * than on whatever happens to be selected, so a keystroke can put up only the
 * thing the operator has already looked at.
 */
export function useShortcuts(actions: {
  /** Put what is staged on the screen. */
  display: () => void;
  /** Take the screen down, or bring back what was on it. */
  blank: () => void;
  /** Stage the nth part of the staged song or deck, counted from one. */
  part: (nth: number) => void;
  /** Move a desk left or right. */
  desk: (delta: number) => void;
  /** Put the caret in this desk's search box. */
  search: () => void;
  /** Show the list of shortcuts. */
  help: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const chord = event.metaKey || event.ctrlKey;

      // The two that work while typing, because both are about the typing:
      // one moves the caret to the box, the other answers the sheet.
      if (chord && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        actions.search();
        return;
      }
      if (chord && event.key === "/") {
        event.preventDefault();
        actions.help();
        return;
      }

      if (handsAreBusy(event)) return;

      if (event.key === "?") {
        event.preventDefault();
        actions.help();
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        actions.display();
        return;
      }
      if (event.key === "b" || event.key === "B") {
        event.preventDefault();
        actions.blank();
        return;
      }
      if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        actions.desk(event.key === "[" ? -1 : 1);
        return;
      }
      if (event.key >= "1" && event.key <= "9") {
        event.preventDefault();
        actions.part(Number(event.key));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions]);
}

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
