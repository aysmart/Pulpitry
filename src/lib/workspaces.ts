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
 * - **Scripture**: everything the detection system produces — the transcript,
 *   the detections, the chapter, and the original languages.
 * - **Songs**: the song library at the width a lyric needs, the queue beside
 *   what is live, and nothing about scripture detection.
 * - **Slides**: a deck read as thumbnails, which wants more room than anything
 *   else here.
 * - **Plan**: the running order, and what comes next.
 */
export type Workspace = "scripture" | "songs" | "slides" | "plan";

/**
 * Every library the panel can show.
 *
 * Declared here rather than in the panel, because it is the arrangements that
 * decide which of them a job needs, and two lists of the same names would
 * drift the first time one was added.
 */
export type LibraryTab =
  | "Scripture"
  | "Songs"
  | "Media"
  | "Slides"
  | "Schedule"
  | "History"
  | "Themes";

export interface WorkspaceShape {
  label: string;
  /** Said on hover, because four one-word buttons deserve an explanation once. */
  hint: string;
  /**
   * The libraries this job can reach, in the order they are offered.
   *
   * Seven tabs were on screen whatever the operator was doing, and five of
   * them were noise at any given moment: a worship set has nothing to ask of
   * the chapter navigator, and a deck has nothing to ask of the Greek. The
   * first is where the arrangement opens — a tuple with at least one, so that
   * "the first tab" is something the desk can rely on.
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
  /** What is queued next. Everywhere except scripture-only work. */
  queue: boolean;
  /**
   * Columns for that row, in the order the panels are written.
   *
   * It has to match what is rendered: a template with more columns than
   * children leaves a gap at the end, and one with fewer silently wraps a
   * panel onto a second row — which this layout has done before.
   */
  topColumns: string;

  /* -- the working row: where the operator looks things up -- */

  /** The Greek and Hebrew behind the verse. Scripture work only. */
  original: boolean;
  /** Columns for the working row, in render order. */
  columns: string;
  /** How much of the height the working row takes from the decision row. */
  basis: string;
}

export const WORKSPACES: Record<Workspace, WorkspaceShape> = {
  scripture: {
    label: "Scripture",
    hint: "The transcript, what was heard, the chapter and the original languages",
    tabs: ["Scripture", "History", "Themes"],
    transcript: true,
    detected: true,
    queue: true,
    topColumns:
      "minmax(200px,0.7fr) minmax(240px,0.9fr) minmax(360px,1.5fr) minmax(180px,0.6fr)",
    original: true,
    columns: "minmax(0,1fr) minmax(0,0.8fr) minmax(320px,0.95fr)",
    basis: "38%",
  },
  songs: {
    label: "Songs",
    hint: "The song library at the width a lyric needs, and what comes next",
    tabs: ["Songs", "Media", "Themes"],
    // Nothing about scripture detection: a worship set is not where a
    // paraphrase match is read, and those two panels are the width the
    // library needs.
    transcript: false,
    detected: false,
    queue: true,
    topColumns: "minmax(360px,1.6fr) minmax(220px,0.6fr)",
    original: false,
    columns: "minmax(0,1.6fr) minmax(320px,1fr)",
    basis: "46%",
  },
  slides: {
    label: "Slides",
    hint: "A deck as thumbnails, which wants more room than anything else here",
    tabs: ["Slides", "Media", "Themes"],
    transcript: false,
    detected: false,
    queue: true,
    topColumns: "minmax(360px,1.6fr) minmax(220px,0.6fr)",
    original: false,
    columns: "minmax(0,1.8fr) minmax(320px,1fr)",
    basis: "52%",
  },
  plan: {
    label: "Plan",
    hint: "The running order, and what comes next",
    tabs: ["Schedule", "History", "Songs", "Slides"],
    transcript: false,
    detected: false,
    queue: true,
    topColumns: "minmax(360px,1.6fr) minmax(220px,0.6fr)",
    original: false,
    columns: "minmax(0,1.25fr) minmax(320px,1fr)",
    basis: "42%",
  },
};

/** Left to right, in the order a service is prepared and then run. */
export const WORKSPACE_ORDER: Workspace[] = ["scripture", "songs", "slides", "plan"];

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
