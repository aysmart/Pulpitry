import type { Workspace } from "./workspaces";

/**
 * Being shown around.
 *
 * # Why a tour at all
 *
 * Everything the operator needs is on screen at once. In a hurry that is the
 * whole point -- a verse goes up without a click spent navigating -- and to
 * somebody opening this for the first time it is a wall of panels with no way
 * in. The arrangements answered half of it, by showing only what a job needs;
 * this answers the other half, which is what the panels *are*.
 *
 * # Why it is long
 *
 * Because it is the whole application. A tour that covered the first three
 * panels would leave somebody believing that is all there is -- and the parts
 * nobody finds on their own are exactly the ones worth having: the lexicon
 * entry that can go on a wall, the shape studio, the set that is not the
 * service, the clip that keeps its place. Each stop is a sentence or two and
 * any of them can be the last one: the bar says how much is left, and nobody
 * is made to read to the end.
 *
 * # What it is not
 *
 * Not a manual, and not a substitute for one. It is the thing a person beside
 * you would point at: this is where the words come from, this is what goes on
 * the wall, this is how you get it there.
 *
 * It changes nothing. It moves between desks and opens the three screens it
 * describes, and that is the whole of what it does: it presses nothing, stages
 * nothing, saves nothing, and puts everything back as it found it. That is not
 * tidiness -- the first place this will be run is an hour before a service, or
 * during one.
 */
export interface TourStep {
  /**
   * The element it points at, named by `data-tour`.
   *
   * Absent for the steps that are about the whole window rather than a part of
   * it, which are shown as a card in the middle.
   */
  at?: string;
  /**
   * The desk this step is about.
   *
   * The tour moves there before the step is shown, because half of what there
   * is to explain is that the window rearranges itself -- and telling somebody
   * that while they look at the arrangement it happens to be in is telling
   * them nothing.
   */
  desk?: Workspace;
  /**
   * A screen to open for this step, and to close when it moves off.
   *
   * The three screens that are not panels -- the outputs, the looks, the
   * settings -- hold most of what a church sets up once and then relies on,
   * and a tour that pointed at the buttons and said "there is a lot in here"
   * would be describing the one part nobody can guess at. So it opens them.
   *
   * This is the only thing the tour does that the operator would not have done
   * themselves, and it is safe: opening a screen changes nothing, the tour
   * never presses anything inside one, and it closes again as the tour moves
   * on or is stopped.
   */
  open?: "displays" | "looks" | "settings";
  /** Which part of the service this belongs to, so a long tour stays placed. */
  group: string;
  title: string;
  body: string;
}

export const TOUR: TourStep[] = [
  {
    group: "First things",
    desk: "scripture",
    title: "A look around",
    body:
      "Pulpitry runs what the congregation sees: verses, songs, slides, pictures. This points at each part of the window in turn. Nothing in it changes what is on a screen, so it is safe to read with a service running — and you can stop at any point.",
  },
  {
    at: "desks",
    desk: "scripture",
    group: "First things",
    title: "Four desks, one window",
    body:
      "Scripture, Songs, Slides and Media. Each shows only the panels its job needs, and what is on the wall stays exactly where it is when you move between them.",
  },
  {
    at: "listen",
    desk: "scripture",
    group: "First things",
    title: "Listening",
    body:
      "Pulpitry listens to whoever is preaching and finds the verses they read — or paraphrase. The microphone it uses is the one named beside this button.",
  },

  {
    at: "transcript",
    desk: "scripture",
    group: "Scripture",
    title: "What is being said",
    body:
      "The sermon as it is heard, a line at a time. Nothing here reaches a screen, and none of it is ever written to a log.",
  },
  {
    at: "detected",
    desk: "scripture",
    group: "Scripture",
    title: "What was heard in it",
    body:
      "References said aloud, and passages recognised from a paraphrase — a preacher saying it in their own words still finds the verse. Click one to stage it, twice to put it up.",
  },
  {
    at: "feed",
    desk: "scripture",
    group: "Scripture",
    title: "History and Queue",
    body:
      "Every verse that has been on the screen this service, and the passages you set aside to come back to. Both end with the service; the plan does not.",
  },
  {
    at: "bible",
    desk: "scripture",
    group: "Scripture",
    title: "Finding a verse",
    body:
      "Type it the way it is said — Jere 32 11 — or search the words themselves. Meaning finds a passage you can only describe: “the one about the widow's offering”.",
  },
  {
    at: "bible",
    desk: "scripture",
    group: "Scripture",
    title: "Which Bible",
    body:
      "The translation beside the search is the one this desk reads. Any output can be given a different one, so an overflow room can follow another translation from the same click.",
  },
  {
    at: "original",
    desk: "scripture",
    group: "Scripture",
    title: "The original languages",
    body:
      "The Greek or Hebrew behind the staged verse, word by word, with a lexicon entry for any of them — and that entry can go on the wall under the word it explains.",
  },
  {
    at: "staged",
    desk: "scripture",
    group: "Scripture",
    title: "What is staged",
    body:
      "Drawn with the church's own look and background, in the shape the wall is, so what fits here is what fits there.",
  },
  {
    at: "output",
    desk: "scripture",
    group: "Scripture",
    title: "Preview, and Live",
    body:
      "Preview is yours; Live is the wall. One click stages and two puts it up — on the keyboard, Enter stages and a second Enter puts it up.",
  },
  {
    at: "output",
    desk: "scripture",
    group: "Scripture",
    title: "Stepping, and winding",
    body:
      "Prev and Next move through a passage or a deck. Anything taller than the screen — a long reading, a lexicon entry — is wound a screenful at a time rather than shrunk to fit.",
  },
  {
    at: "output",
    desk: "scripture",
    group: "Scripture",
    title: "Two lists, one row",
    body:
      "Add to queue keeps a passage to hand for later in this hour. Add to plan puts it in the service, which outlives today. Every desk has both, named after the list they fill.",
  },

  {
    at: "tab-Schedule",
    desk: "scripture",
    group: "The plan",
    title: "The service plan",
    body:
      "The running order, beside the readings because that is where it is written: services you can reopen next Sunday, headings, and notes that never reach a screen.",
  },

  {
    at: "library",
    desk: "songs",
    group: "Songs",
    title: "The song library",
    body:
      "Your church's songs, found by a half-remembered line as readily as by title. A folder exported from another program imports with its verses and choruses already apart.",
  },
  {
    at: "song-parts",
    desk: "songs",
    group: "Songs",
    title: "The parts of a song",
    body:
      "Verse, chorus, bridge — stepped one screenful at a time, broken where the writer broke them rather than wherever the screen happened to run out.",
  },
  {
    at: "song-set",
    desk: "songs",
    group: "Songs",
    title: "The set",
    body:
      "What the band is playing, in the worship leader's order. It is its own list, so reordering the set cannot reorder the service.",
  },
  {
    at: "song-finder",
    desk: "songs",
    group: "Songs",
    title: "Song Finder",
    body:
      "A hosted catalogue searched by meaning, for the song nobody can name — a line, a theme, a feeling. It needs a Castavox subscription.",
  },
  {
    at: "library",
    desk: "songs",
    group: "Songs",
    title: "Editing a song",
    body:
      "Open one to set its words and its author, how many lines a screen holds, and whether its title shows underneath — which is off, because nobody singing needs to be told which song they are singing.",
  },

  {
    at: "deck-strip",
    desk: "slides",
    group: "Slides",
    title: "The deck in hand",
    body:
      "Every slide in order, drawn as it will appear rather than listed by name — so the one with the bank details on it is found by looking.",
  },
  {
    at: "library",
    desk: "slides",
    group: "Slides",
    title: "The slide library",
    body:
      "Your decks and the templates they start from, searched by the words on the slides themselves.",
  },
  {
    at: "library",
    desk: "slides",
    group: "Slides",
    title: "The studio",
    body:
      "Open a deck to lay a slide out by hand: text, shapes, pictures, tables, and a background of its own. Slides written from a sermon open in the same place and are edited the same way.",
  },
  {
    at: "library",
    desk: "slides",
    group: "Slides",
    title: "The notice band",
    body:
      "Notice runs a line across the bottom of every screen — a car to move, a room change — without taking off what is already on it.",
  },

  {
    at: "library",
    desk: "media",
    group: "Media",
    title: "Pictures and clips",
    body:
      "The media library at the size a picture is actually chosen by. Each one either fills the screen or sits whole inside it, and the file stays where you put it.",
  },
  {
    at: "output",
    desk: "media",
    group: "Media",
    title: "Playing a clip",
    body:
      "The transport sits under the live pane: play, pause, seek, loop. A clip keeps its place while you look at another desk, and the sound follows whichever screen the congregation is watching.",
  },

  {
    at: "displays",
    desk: "scripture",
    group: "The screens",
    title: "The screens",
    body:
      "Everything the congregation sees is set up behind this button. Let us open it.",
  },
  {
    open: "displays",
    at: "output-row",
    desk: "scripture",
    group: "The screens",
    title: "One row per output",
    body:
      "The projector and the second display are always here; add a row for a foyer panel, a stage display, or a feed for the stream. Open and Close put each one up and take it down.",
  },
  {
    open: "displays",
    at: "output-screen",
    desk: "scripture",
    group: "The screens",
    title: "Which screen it goes to",
    body:
      "Any monitor this machine can see — or none at all. An output with no screen is still drawn and still sent over the network, which is exactly what a switcher in another room wants.",
  },
  {
    open: "displays",
    at: "output-look",
    desk: "scripture",
    group: "The screens",
    title: "Its own look, its own Bible",
    body:
      "Each output can draw in a look of its own and read a translation of its own. Every screen shows the same verse at the same moment — what differs is how, and in which words.",
  },
  {
    open: "displays",
    at: "output-shape",
    desk: "scripture",
    group: "The screens",
    title: "A whole screen, or furniture",
    body:
      "Whole screen is a projector: a background with the words on it. A shape is drawn on nothing at all, for a switcher to key over a camera. Stage display is the platform's own screen, with the timer and the note from the desk.",
  },
  {
    open: "displays",
    at: "shapes-button",
    desk: "scripture",
    group: "The screens",
    title: "Display shapes",
    body:
      "The furniture a stream draws around the words — a band, a rule, your own logo — drawn in a studio of its own and kept as a library, rather than chosen from somebody else's six.",
  },
  {
    open: "displays",
    at: "output-feed",
    desk: "scripture",
    group: "The screens",
    title: "On the network",
    body:
      "An output can be published as an NDI source for a video switcher, with a transparent background so it keys cleanly. Check the network can see it answers the only question worth asking about a feed.",
  },
  {
    open: "displays",
    at: "output-preview",
    desk: "scripture",
    group: "The screens",
    title: "What each one is drawing",
    body:
      "Drawn by the same renderer the output itself uses, in its own look, with whatever is live in it. An output with no screen of its own can be looked at here.",
  },

  {
    at: "looks",
    desk: "scripture",
    group: "Themes",
    title: "How the words are set",
    body:
      "The look is the typeface, the colours, the background and the motion behind them. It has a screen of its own, which this opens.",
  },
  {
    open: "looks",
    at: "looks-grid",
    desk: "scripture",
    group: "Themes",
    title: "A library of looks",
    body:
      "Each one drawn at the size it will be read from, with real words in it, grouped by the room it was built for — a hall with sun in it, a camera, a dark auditorium. Clicking one applies it.",
  },
  {
    open: "looks",
    at: "looks-grid",
    desk: "scripture",
    group: "Themes",
    title: "Motion behind the words",
    body:
      "Many of them move: a slow drift, ink in water, light through glass. They are drawn rather than played from a file, so they cost nothing to keep and never pixelate on a big wall.",
  },
  {
    open: "looks",
    at: "looks-header",
    desk: "scripture",
    group: "Themes",
    title: "Making one your own",
    body:
      "Open a look to change it: the typeface and size, where the words sit, the weight, the case, the shadow, the colours with their transparency, and whether a title shows under the words. Save it and it joins the library.",
  },
  {
    at: "looks",
    desk: "scripture",
    group: "Themes",
    title: "One look per desk",
    body:
      "Each desk keeps its own, because a verse and a chorus are not read the same way — and the wall wears the look of whichever desk put something on it.",
  },

  {
    at: "settings",
    desk: "scripture",
    group: "Before a service",
    title: "Settings",
    body:
      "The things a church sets once. This opens it.",
  },
  {
    open: "settings",
    at: "settings-rail",
    desk: "scripture",
    group: "Before a service",
    title: "What is where",
    body:
      "Account is the subscription and the machines on it. Scripture is what the model may suggest and how sure it must be. Audio is where the words come from. Stage is where the picture goes and who else follows it. Usage, Help and Feedback are the rest.",
  },
  {
    open: "settings",
    at: "settings-rail",
    desk: "scripture",
    group: "Before a service",
    title: "Which engine listens",
    body:
      "Under Audio: this machine, which needs a model downloaded once and then works with no connection at all, or a Castavox subscription, which is faster and needs one. The languages each can hear are not the same, and the picker says so.",
  },
  {
    open: "settings",
    at: "settings-rail",
    desk: "scripture",
    group: "Before a service",
    title: "Bibles, and what the desk may suggest",
    body:
      "Under Scripture: the translations installed on this machine, and the index behind paraphrase matching — how sure it must be before a passage is offered at all.",
  },
  {
    open: "settings",
    at: "settings-rail",
    desk: "scripture",
    group: "Before a service",
    title: "Castavox",
    body:
      "Under Stage: Pulpitry can mirror what is live to a paired Castavox stream, so the people watching at home read the same verse as the room.",
  },
  {
    desk: "scripture",
    group: "Before a service",
    title: "In the menu bar",
    body:
      "Two more things live up there: Past services keeps every transcript with what was shown alongside it, and Slides from a sermon turns one into a deck you can edit.",
  },

  {
    at: "tour",
    desk: "scripture",
    group: "That is the tour",
    title: "Whenever somebody new sits down",
    body:
      "This button starts it again, from anywhere, as often as you like. The manual is in Help beside it.",
  },
];

const KEY = "pulpitry.tour";

/**
 * Whether this machine has been shown around.
 *
 * What decides whether the tour opens by itself, which it does once: on an
 * installation that has never run it. Per machine rather than in the settings
 * file, for the same reason the arrangement is -- it is about the person in
 * front of this desk, not something a church decides once. A second machine in
 * the same building gets its own first run, which is right, because somebody
 * new is usually sitting at it.
 */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    // Storage turned off. Better to offer it again than never.
    return false;
  }
}

export function rememberTour(): void {
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    // Nothing to do: it offers itself again next launch.
  }
}
