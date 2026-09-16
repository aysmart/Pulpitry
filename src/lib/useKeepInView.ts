import { useEffect, type RefObject } from "react";

/**
 * Which mark a list puts on the item being followed.
 *
 * - `live`: what is on the wall. Moves from outside the list most often —
 *   Next, a voice command, following a sermon through a deck.
 * - `preview`: what is staged. Moves when a detection or a search stages
 *   something the list happens to contain.
 * - `selected`: a list with one kind of selection and no wall behind it.
 */
export type Mark = "live" | "preview" | "selected";

/**
 * Keeps the item a list is following on screen, when it moves.
 *
 * # The fault
 *
 * A list is scrolled by a person, and its selection is moved by the app: the
 * operator presses Next verse, says "next verse", a detection stages a
 * passage, a deck steps on. The highlight moves and the list stays put, so
 * the verse on the wall is marked somewhere below the fold and the operator
 * has to go looking for the place they already are. During a service, that
 * is the one place they should never have to look for.
 *
 * # What it does, and what it deliberately does not
 *
 * When the followed item changes, the list scrolls just far enough to show it
 * — `nearest`, so an item already in view does not move at all and a list is
 * never yanked to put something at its top. It acts only on a change: an
 * operator scrolling the list to read ahead is left exactly where they put it
 * until the selection actually moves again.
 *
 * `inline` as well as `block`, so a horizontal strip of slides follows a deck
 * the same way a column of verses follows a chapter.
 *
 * After a frame, because the change that moved the selection has usually
 * also re-rendered the list, and scrolling to a row before it has been laid
 * out scrolls to where it used to be.
 */
export function useKeepInView(
  container: RefObject<HTMLElement | null>,
  mark: Mark,
  key: string | number | null | undefined,
) {
  useEffect(() => {
    if (key === null || key === undefined || key === "") return;

    const frame = requestAnimationFrame(() => {
      const item = container.current?.querySelector<HTMLElement>(
        `[data-${mark}="true"]`,
      );
      item?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [container, mark, key]);
}
