/**
 * The desk, arranged for the job in hand.
 *
 * # Why one window with four arrangements
 *
 * Everything the operator needs has always been on screen at once: the
 * transcript, the detections, what is live, the queue, a chapter, the
 * libraries. In a hurry that is right — a verse goes up without a click spent
 * navigating — and to learn it is a wall. Somebody opening Pulpitry for the
 * first time meets eight panels and cannot tell which two matter.
 *
 * A competitor splits this into three separate windows, which reads clearly
 * and costs the thing we are better at: their operator changes window to reach
 * the songs, and ours does not.
 *
 * So: one window, four arrangements, and **each shows only the panels that
 * apply to that job**. The Greek behind a verse has nothing to say about a
 * chorus; the paraphrase detections have nothing to say about a slide deck;
 * and the width they take is exactly what the song library and the deck
 * thumbnails need.
 *
 * Two panels are in every arrangement, because they are what a service is run
 * from whatever is on the screen: **what is live**, with its transport, and
 * **what is staged next**.
 *
 * # What each one is for
 *
 * - **Scripture**: the six panes the scripture desk is: what is being said,
 *   what scripture was heard in it, the feed of verses shown and verses put
 *   aside, the Bible itself searched by word or by meaning, the original
 *   languages behind the staged verse, and what the screen will look like.
 * - **Songs**: the song library at the width a lyric needs, the set beside what
 *   is live, and nothing about scripture detection.
 * - **Slides**: a deck read as thumbnails, which wants more room than anything
 *   else here.
 * - **Media**: the pictures and clips, at the size they are actually chosen by,
 *   beside the output that plays them.
 *
 * The service plan had a desk of its own and does not need one. A running
 * order is written and then followed, and neither of those is a job with a
 * whole window's worth of work in it: what it wants is to be *beside* the
 * thing being prepared. It is a second tab on the scripture desk's library
 * pane, where a reading is looked up -- which is the half of a service plan
 * anybody actually sits down and prepares.
 */
export type Workspace = "scripture" | "songs" | "slides" | "media";

/**
 * Every library the panel can show.
 *
 * Declared here rather than in the panel, because it is the arrangements that
 * decide which of them a job needs, and two lists of the same names would
 * drift the first time one was added.
 */
export type LibraryTab =
  | "Scripture"
  | "Compare"
  | "Songs"
  | "Media"
  | "Slides"
  | "Schedule";

/**
 * How the window itself is divided.
 *
 * - **desk**: a decision row over a working row. What was said, what was heard
 *   and what is live across the top; where the operator looks things up
 *   underneath. Right for work driven by something arriving — speech, a plan.
 * - **deck**: a work column beside an output column. The deck in hand over the
 *   library that stages it, and one tall column holding what is on the wall,
 *   what is staged behind it and the transport between them. Right for work
 *   driven by the operator: a deck is stepped, and stepping is the job.
 * - **song**: the same output column as the deck frame, with the work beside it
 *   in two rows — the plan and the song's parts above, the library, the
 *   AI Song Finder and what would be added below. The output is identical to the
 *   slide desk's on purpose: an operator moves between these two arrangements
 *   during one service, and the pane they watch the congregation through
 *   should not change shape when they do.
 */
export type Frame = "desk" | "deck" | "song";

export interface WorkspaceShape {
  label: string;
  /** Said on hover, because four one-word buttons deserve an explanation once. */
  hint: string;
  frame: Frame;
  /**
   * The libraries this job can reach, in the order they are offered.
   *
   * Seven tabs were on screen whatever the operator was doing, and five of
   * them were noise at any given moment: a worship set has nothing to ask of
   * the chapter navigator, and a deck has nothing to ask of the Greek. The
   * first is where the arrangement opens — a tuple with at least one, so that
   * "the first tab" is something the desk can rely on.
   *
   * One name means one pane and no tab strip. Scripture is that: the pane is
   * the Bible, and a row of tabs above it with nothing to switch to would be a
   * chooser offering one choice.
   */
  tabs: [LibraryTab, ...LibraryTab[]];

  /* -- the decision row: what is live, and what feeds it -- */

  /**
   * The transcript of what is being said.
   *
   * Scripture work only. It is the input to verse detection, and during a
   * worship set or a notice slide it is a column of words nobody reads.
   */
  transcript: boolean;
  /** The verses, references and paraphrases heard. Scripture work only. */
  detected: boolean;
  /**
   * The scripture feed: verses shown this session, and verses put aside.
   *
   * Two lists that answer two questions — what did we read, and what are we
   * coming back to — in one pane, because on a scripture desk they are the
   * same glance. See ScriptureFeed.
   */
  feed: boolean;
  /**
   * Columns for that row, in the order the panels are written. Desk frame only.
   *
   * It has to match what is rendered: a template with more columns than
   * children leaves a gap at the end, and one with fewer silently wraps a
   * panel onto a second row — which this layout has done before.
   */
  topColumns?: string;

  /* -- the working row: where the operator looks things up -- */

  /** The Greek and Hebrew behind the verse. Scripture work only. */
  original: boolean;
  /**
   * Columns, in render order: the working row in the desk frame, and the whole
   * window — work beside output — in the deck and song frames.
   */
  columns: string;
  /** The song frame's lower row: the library, the AI Song Finder, the preview. */
  bottomColumns?: string;
  /**
   * A height share. The working row's, in the desk frame; the deck strip's, in
   * the deck frame.
   */
  basis: string;
  /**
   * Whether the deck frame's upper row -- the strip of slides -- is there.
   *
   * Deck frame only, and true wherever it is not said. The media desk borrows
   * this frame for its shape and has nothing to put in that row: pictures and
   * clips are not stepped in order, so there is no "the one after this" to
   * show, and the room goes to the library where it is read.
   */
  strip?: boolean;
}

export const WORKSPACES: Record<Workspace, WorkspaceShape> = {
  scripture: {
    label: "Scripture",
    hint: "What is being said, what was heard, the Bible, the original languages",
    frame: "desk",
    /*
     * The Bible, and the service it is being read in.
     *
     * The plan was a desk and is a tab, because it is not a job: a running
     * order is written once and then followed, and the following is done from
     * whichever desk holds the next thing. Here rather than anywhere else
     * because preparing a service and looking a reading up are the same
     * sitting, and this is the pane with the room for both.
     *
     * The session's own history is not a tab: the verses shown are a feed of
     * their own in the row above. Neither is the look -- that is in the top
     * bar, where every desk can reach it.
     */
    tabs: ["Scripture", "Compare", "Schedule"],
    transcript: true,
    detected: true,
    feed: true,
    topColumns:
      "minmax(200px,0.7fr) minmax(240px,0.9fr) minmax(360px,1.5fr) minmax(220px,0.75fr)",
    original: true,
    columns: "minmax(0,1fr) minmax(0,0.8fr) minmax(320px,0.95fr)",
    basis: "38%",
  },
  songs: {
    label: "Songs",
    hint: "The plan, the output, the song's parts, and where the next song comes from",
    frame: "song",
    // One name, so the pane is the song library and carries no tab strip.
    // Media was a second tab here until it became a desk of its own: a picture
    // reached from behind the songs was a pane and a half of somebody else's
    // work, and the desk that holds them holds them at the size they are
    // chosen by.
    tabs: ["Songs"],
    // Nothing about scripture detection: a worship set is not where a
    // paraphrase match is read, and those two panels are the width the
    // library needs.
    transcript: false,
    detected: false,
    feed: false,
    original: false,
    // Work, then output -- the deck frame's own split, so the pane an operator
    // watches the congregation through is in the same place and the same shape
    // in both arrangements.
    columns: "minmax(0,1fr) minmax(340px,0.42fr)",
    // Above the libraries: the running order, and the parts of the song that
    // is staged. Both are lists of names and neither needs width.
    topColumns: "minmax(220px,1fr) minmax(220px,1fr)",
    // This church's library, the AI Song Finder, and what would be added from it.
    // Even, because choosing a song is reading three lists against each other.
    bottomColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1.05fr)",
    // The upper row's share. A third: a plan is a dozen lines and a song is
    // half a dozen parts, and the libraries below are where the work is.
    basis: "34%",
  },
  slides: {
    label: "Slides",
    hint: "The deck in hand, the library that stages it, and the output beside both",
    /*
     * The one arrangement that is not a desk.
     *
     * A deck is not looked up, it is *run*: the operator has the slides in
     * order and their whole job is knowing which one is up, which one is next,
     * and pressing the thing that moves between them. Two rows across the
     * window put those three in three different places. One column holds them
     * in the order the hand uses them, and the width that frees goes to the
     * deck and the library, which are read as pictures rather than as text.
     */
    frame: "deck",
    /*
     * The decks, and no look of its own.
     *
     * A deck carries its own background and every slide on it is laid out
     * against that background in the studio. A look applied over the top would
     * be a second answer to a question the deck has already answered -- and the
     * operator would have two places to change the same thing, which is how a
     * deck comes to look different on the wall than it did while it was made.
     * The top bar's Themes button is absent on this desk for the same reason.
     *
     * Media was a second tab here and is a desk now, for the same reason the
     * decks want this width: pictures are chosen by looking at them.
     */
    tabs: ["Slides"],
    transcript: false,
    detected: false,
    feed: false,
    // The plan lives on the far side of the deck strip in this frame: the
    // library and the output are what a deck is run from, and a third list
    // would take the width the slides are read at.
    original: false,
    // Work, then output. The output column is given a floor rather than a
    // share: below about 340px a 16:9 pane stops being a preview of anything.
    columns: "minmax(0,1fr) minmax(340px,0.42fr)",
    // The deck strip's height. Enough for one row of slides and their
    // numbers, and the rest belongs to the library.
    basis: "38%",
  },
  media: {
    label: "Media",
    hint: "The pictures and the clips, and the output that plays them",
    /*
     * The deck frame, without the deck.
     *
     * A picture is chosen the way a slide is -- by looking at it, not by
     * reading a name -- so the library wants the width, and what is live wants
     * a tall pane beside it rather than a strip across the top. A clip makes
     * that pane do real work: its transport lives under the live pane, so
     * playing, pausing, seeking and looping are where the eye already is.
     *
     * The thumbnails are the only list here, so they take the whole column.
     */
    frame: "deck",
    strip: false,
    // One name, so the pane is the library and carries no tab strip.
    tabs: ["Media"],
    transcript: false,
    detected: false,
    feed: false,
    original: false,
    // The same split as the slide and song desks, so the pane an operator
    // watches the congregation through does not move when they change desks.
    columns: "minmax(0,1fr) minmax(340px,0.42fr)",
    // Unused without a strip, and kept honest rather than left as a number
    // that means nothing: the library is the whole column.
    basis: "0",
  },
};

/** Left to right, in the order a service is prepared and then run. */
export const WORKSPACE_ORDER: Workspace[] = [
  "scripture",
  "songs",
  "slides",
  "media",
];

const KEY = "pulpitry.workspace";

/**
 * The arrangement this desk was last left in.
 *
 * Remembered per machine rather than in the settings file: it is where
 * somebody put their hands, not something a church decides once. A machine
 * that only ever runs songs should open on songs.
 */
export function storedWorkspace(): Workspace {
  try {
    const held = localStorage.getItem(KEY);
    if (held && held in WORKSPACES) return held as Workspace;
  } catch {
    // A private window, or storage turned off. The default is fine.
  }
  return "scripture";
}

export function rememberWorkspace(workspace: Workspace): void {
  try {
    localStorage.setItem(KEY, workspace);
  } catch {
    // Nothing to do: it reopens on Scripture, which is the old behaviour.
  }
}
