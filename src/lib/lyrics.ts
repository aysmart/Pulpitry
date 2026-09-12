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

/**
 * How many lines of a song go on one screen.
 *
 * Zero is Auto, which puts the whole part up and lets the renderer shrink it to
 * fit -- right for a two-line chorus and wrong for an eight-line verse, which
 * is why it is not the default.
 */
export type LinesPerScreen = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const LINE_CHOICES: Array<{ value: LinesPerScreen; label: string }> = [
  { value: 0, label: "Auto — the whole part" },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const).map((value) => ({
    value: value as LinesPerScreen,
    label: value === 1 ? "1 line" : `${value} lines`,
  })),
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


/**
 * Whether a line names a part rather than being one.
 *
 * The same rule the importer applies to a file (src-tauri/src/songs_import.rs)
 * and deliberately as narrow: "Chorus" is a heading, "Chorus of angels sing" is
 * a lyric, and a rule loose enough to catch the second would eat a line of
 * somebody's song. Two words at most, sixteen characters at most, and a name
 * this application recognises.
 */
const NAMES: Record<string, string> = {
  verse: "Verse",
  v: "Verse",
  chorus: "Chorus",
  c: "Chorus",
  refrain: "Chorus",
  bridge: "Bridge",
  b: "Bridge",
  tag: "Tag",
  t: "Tag",
  intro: "Intro",
  ending: "Ending",
  outro: "Ending",
  coda: "Ending",
  vamp: "Vamp",
  interlude: "Interlude",
  instrumental: "Interlude",
};

export function looksLikeLabel(line: string): string | null {
  // The wrappers a label arrives in: "[Verse 1]", "(Chorus)", "VERSE 1:".
  const bare = line
    .trim()
    .replace(/^[[({]+/, "")
    .replace(/[\])}]+$/, "")
    .trim()
    .replace(/[:.]+$/, "")
    .trim();

  if (!bare || bare.length > 16 || bare.split(/\s+/).length > 2) return null;

  const lower = bare.toLowerCase();
  const twoWord: Record<string, string> = {
    "pre chorus": "Pre-chorus",
    "post chorus": "Post-chorus",
  };
  const spaced = lower.replace(/[-_]/g, " ");
  if (twoWord[spaced]) return twoWord[spaced];

  // "verse 2", "verse2" and "v2" all say the same thing.
  const match = /^([a-z-]+)\s*(\d*)$/.exec(lower);
  if (!match) return null;
  const name = NAMES[match[1]!];
  if (!name) return null;
  return match[2] ? `${name} ${match[2]}` : name;
}

/**
 * Lyrics as somebody types or pastes them, read into parts.
 *
 * Two things start a part and it has to be both: a blank line, which is how a
 * typed lyric sheet separates verses, and a label on its own line, which is how
 * every export writes them. Splitting on blank lines alone turned a pasted
 * EasyWorship song -- whose lines run one after another with no blank line
 * anywhere -- into a single part called "Intro" with "Verse 1" and "Chorus"
 * sitting inside it as words somebody sings.
 *
 * A label with nothing under it is dropped: in these files a bare "Chorus"
 * between two verses means sing it again, and an empty part would be a blank
 * projector in the middle of a song.
 */
export function parseSections(text: string): SongSection[] {
  const sections: SongSection[] = [];
  let current: SongSection | null = null;
  let unnamed = 0;

  const flush = () => {
    if (current && current.lines.length > 0) sections.push(current);
    current = null;
  };

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();

    if (!line) {
      flush();
      continue;
    }

    const label = looksLikeLabel(line);
    if (label) {
      flush();
      current = { label, lines: [] };
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      unnamed += 1;
      current = { label: `Verse ${unnamed}`, lines: [line] };
    }
  }
  flush();

  return sections;
}
