import type { Workspace } from "./workspaces";

/**
 * Being shown around, once.
 *
 * # Why a tour at all
 *
 * Everything the operator needs is on screen at once. In a hurry that is the
 * whole point -- a verse goes up without a click spent navigating -- and to
 * somebody opening this for the first time it is a wall of panels with no way
 * in. The arrangements answered half of it, by showing only what a job needs;
 * this answers the other half, which is what the panels *are*.
 *
 * # What it is not
 *
 * Not a manual, and not a substitute for one. It is the thing a person beside
 * you would point at: this is where the words come from, this is what goes on
 * the wall, this is how you get it there. Fourteen of those, each one sentence
 * or two, stoppable at any point -- because the reason somebody opens Pulpitry
 * for the first time is usually that a service starts in an hour.
 *
 * Nothing here acts on the app. The tour points and explains; every step is
 * safe to read with a congregation in the room, which matters because the
 * first place this will be run is a Sunday morning.
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
  title: string;
  body: string;
}

export const TOUR: TourStep[] = [
  {
    desk: "scripture",
    title: "A quick look around",
    body:
      "Two minutes, fourteen stops. Nothing here changes what is on a screen, so it is safe to read with a service running. Stop whenever you like — Help will bring it back.",
  },
  {
    at: "desks",
    desk: "scripture",
    title: "Four desks, one window",
    body:
      "Scripture, Songs, Slides and Media. Each shows only the panels its job needs, and what is on the wall stays exactly where it is when you move between them.",
  },
  {
    at: "listen",
    desk: "scripture",
    title: "Listening",
    body:
      "Pulpitry listens to whoever is preaching and finds the verses they read — or paraphrase. The microphone it uses is the one named beside this button.",
  },
  {
    at: "transcript",
    desk: "scripture",
    title: "What is being said",
    body:
      "The sermon as it is heard. Nothing here reaches a screen; it is what the detections are made from, and it is never written to a log.",
  },
  {
    at: "detected",
    desk: "scripture",
    title: "What was heard in it",
    body:
      "References said aloud, and passages recognised from a paraphrase — a preacher saying it in their own words still finds the verse. Click one to stage it.",
  },
  {
    at: "feed",
    desk: "scripture",
    title: "History and Queue",
    body:
      "Every verse that has been on the screen this service, and the passages you put aside to come back to. Both end with the service; the plan does not.",
  },
  {
    at: "bible",
    desk: "scripture",
    title: "Finding a verse",
    body:
      "Type it the way it is said — Jere 32 11 — or search the words themselves. Meaning finds a passage you can only describe: “the one about the widow's offering”.",
  },
  {
    at: "output",
    desk: "scripture",
    title: "Preview, and Live",
    body:
      "Preview is yours; Live is the wall. One click stages, two puts it up — and on the keyboard, Enter stages and a second Enter puts it up.",
  },
  {
    at: "tab-Schedule",
    desk: "scripture",
    title: "The service plan",
    body:
      "The running order, beside the readings because that is where it is written. Add to plan puts whatever is staged into it, from any desk.",
  },
  {
    at: "displays",
    desk: "scripture",
    title: "The screens",
    body:
      "Every screen and feed the congregation sees: the projector, an overflow room, a lower third keyed over a camera. Each one can draw a different translation in a different look.",
  },
  {
    at: "looks",
    desk: "scripture",
    title: "How the words are set",
    body:
      "The typeface, the colours and the background. Each desk keeps its own look, because a verse and a chorus are not read the same way.",
  },
  {
    at: "library",
    desk: "songs",
    title: "Songs",
    body:
      "The church's own library, the set the band is playing, and the parts of the staged song — stepped one screenful at a time, broken where the writer broke them.",
  },
  {
    at: "library",
    desk: "slides",
    title: "Slides",
    body:
      "Decks read as thumbnails rather than as names, and a studio for laying a slide out by hand: text, shapes, pictures, a background of its own.",
  },
  {
    at: "library",
    desk: "media",
    title: "Pictures and clips",
    body:
      "The media library at the size a picture is actually chosen by. A clip's transport sits under the live pane, where the eye already is.",
  },
];

const KEY = "pulpitry.tour";

/**
 * Whether this machine has been shown around.
 *
 * Per machine rather than in the settings file, for the same reason the
 * arrangement is: it is about the person in front of this desk, not something
 * a church decides once. A second machine in the same building gets its own
 * first run, which is right -- somebody new is usually sitting at it.
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
