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
 * and costs the thing we are best at: their operator changes window to reach
 * the songs, and ours does not.
 *
 * So: one window, four arrangements. The decision row is constant, because that
 * is what a service is run from — the transcript, the detections, the staged
 * item and the live one side by side, and the queue. What changes is which
 * library has the width, and whether a panel that has nothing to say about this
 * job is on screen at all.
 *
 * # What each one is for
 *
 * - **Scripture**: the default and the original layout. The chapter and the
 *   original-languages panel beside the library.
 * - **Songs**: the song library takes the width a lyric needs, and the Greek
 *   and Hebrew panel goes — it has nothing to do with a chorus.
 * - **Slides**: the most width of any, because a deck is read as thumbnails.
 * - **Plan**: the service order, which is a list and wants less room than a
 *   deck but more than a rail.
 */
export type Workspace = "scripture" | "songs" | "slides" | "plan";

/** The library tab a workspace works in; the names ScripturePanel uses. */
export type LibraryTab = "Scripture" | "Songs" | "Slides" | "Schedule";

export interface WorkspaceShape {
  label: string;
  /** Said on hover, because four one-word buttons deserve an explanation once. */
  hint: string;
  tab: LibraryTab;
  /**
   * Column widths for the working row, as a CSS grid template.
   *
   * One column or two, matching what is rendered: a template with more columns
   * than children leaves a gap, and one with fewer silently wraps a panel onto
   * a second row underneath — which this layout has done before. The staged
   * and live pair is not here; it lives in the decision row, beside each
   * other, whichever arrangement is chosen.
   */
  columns: string;
  /** How much of the height the working row takes from the decision row. */
  basis: string;
  /** Whether the original-languages panel is on screen. */
  original: boolean;
}

export const WORKSPACES: Record<Workspace, WorkspaceShape> = {
  scripture: {
    label: "Scripture",
    hint: "The chapter, the original languages, and the verse library",
    tab: "Scripture",
    columns: "minmax(0,1fr) minmax(0,0.85fr)",
    basis: "38%",
    original: true,
  },
  songs: {
    label: "Songs",
    hint: "The song library at the width a lyric needs",
    tab: "Songs",
    columns: "minmax(0,1fr)",
    basis: "44%",
    original: false,
  },
  slides: {
    label: "Slides",
    hint: "Decks as thumbnails, which want more room than anything else here",
    tab: "Slides",
    columns: "minmax(0,1fr)",
    basis: "50%",
    original: false,
  },
  plan: {
    label: "Plan",
    hint: "The service order, and what comes next",
    tab: "Schedule",
    columns: "minmax(0,1fr)",
    basis: "40%",
    original: false,
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
