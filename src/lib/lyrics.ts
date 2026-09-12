import type { SongSection } from "./catalog";

/**
 * A song is not a deck of slides.
 *
 * # The difference, and why it has to be in the model
 *
 * A slide is a thing somebody made: it has a layout, it holds what it holds,
 * and it goes up whole. A verse is not. A verse is eight lines of poetry, and
 * how many of them a congregation sees at once is a decision about the room —
 * how far back the last row is, how big the screen is, whether the band takes
 * the verse slowly. The same verse is two lines at a time in one church and
 * four in another, and neither is an edit to the song.
 *
 * Treating a section as a slide gets this wrong in both directions: an
 * eight-line verse goes up as eight lines nobody at the back can read, and
 * splitting it by hand into four two-line "slides" turns one verse into four
 * library entries that have to be kept in step with each other for ever.
 *
 * So the words are stored as the writer broke them — whole sections, whole
 * lines — and broken into screenfuls when they are staged. Changing how many
 * lines a screen holds changes nothing about the song.
 *
 * # Labels
 *
 * A screenful after the first carries its section's name with "(cont.)", so an
 * operator glancing at the list knows they are still in verse one rather than
 * somewhere new. That is what a worship leader says out loud too.
 */

/** How many lines of a song go on one screen. Zero means the whole section. */
export type LinesPerScreen = 0 | 2 | 3 | 4 | 6;

export const LINE_CHOICES: Array<{ value: LinesPerScreen; label: string }> = [
  { value: 2, label: "2 lines" },
  { value: 3, label: "3 lines" },
  { value: 4, label: "4 lines" },
  { value: 6, label: "6 lines" },
  { value: 0, label: "Whole section" },
];

const KEY = "pulpitry.lyrics.lines";

/**
 * Two, which is what most churches project.
 *
 * It is the setting a congregation can read from the back and sing without
 * losing their place, and it is what a worship leader expects to see. A church
 * with a big screen and a short room can raise it in one press.
 */
export const DEFAULT_LINES: LinesPerScreen = 2;

export function storedLines(): LinesPerScreen {
  try {
    const held = Number(localStorage.getItem(KEY));
    if (LINE_CHOICES.some((choice) => choice.value === held)) {
      return held as LinesPerScreen;
    }
  } catch {
    // A private window, or storage turned off. The default is fine.
  }
  return DEFAULT_LINES;
}

export function rememberLines(lines: LinesPerScreen): void {
  try {
    localStorage.setItem(KEY, String(lines));
  } catch {
    // Nothing to do: it reverts to two, which is where it started.
  }
}

/**
 * The song, as the screenfuls it will actually be shown in.
 *
 * Blank lines inside a section are kept as breaks the writer made and do not
 * take up a screen of their own — a gap between two halves of a verse is a
 * breath, not a slide.
 */
export function screensOf(
  sections: SongSection[],
  perScreen: number = storedLines(),
): SongSection[] {
  if (perScreen <= 0) return sections;

  const screens: SongSection[] = [];

  for (const section of sections) {
    const lines = section.lines.filter((line) => line.trim().length > 0);

    // A section with nothing in it is still a section: a label somebody put
    // there on purpose, and dropping it would renumber everything after it.
    if (lines.length === 0) {
      screens.push({ ...section, lines: [] });
      continue;
    }

    for (let at = 0; at < lines.length; at += perScreen) {
      const part = lines.slice(at, at + perScreen);
      screens.push({
        ...section,
        // Components and elements belong to a deck's slide, not to a verse,
        // and carrying them onto every screenful of a song would draw the same
        // designed slide four times.
        components: undefined,
        layout: undefined,
        elements: undefined,
        label:
          at === 0
            ? section.label
            : section.label
              ? `${section.label} (cont.)`
              : "",
        lines: part,
      });
    }
  }

  return screens;
}

/**
 * Where to land after the number of lines changes.
 *
 * The operator is mid-song when they change it, so the screen they were on has
 * to survive: matched by its first line, which is the one thing that means the
 * same before and after. Falling back to the start is honest — nothing was
 * showing, or the words have changed underneath — and never to a guess.
 */
export function sameScreen(
  screens: SongSection[],
  firstLine: string | undefined,
): number {
  if (!firstLine) return 0;
  const at = screens.findIndex((screen) => screen.lines[0] === firstLine);
  return at >= 0 ? at : 0;
}
