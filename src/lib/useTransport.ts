import { useEffect } from "react";

import type { Extent } from "../components/LiveBodyView";
import { handsAreBusy } from "./shortcuts";

/**
 * The transport: stepping through what is staged, and winding what is live.
 *
 * Extracted from the stage column because a second arrangement now renders the
 * output without it — the slide desk puts Live, Preview and the transport in
 * one tall pane — and an operator whose arrow keys stopped working because they
 * were on the Slides arrangement would be right to call that broken.
 *
 * # Screens, and why the conversion lives here
 *
 * What every surface agrees on is a *point* in the text, 0 to 1, because each
 * of them shows a different amount at once and a screen number would mean a
 * different place on each. But "2 of 6" is what an operator can act on, so the
 * two are converted using what the pane that renders the wall in miniature
 * measured — and being in one place, the arrow keys and the buttons beside them
 * cannot wind by different amounts.
 */
export function useTransport({
  progress,
  extent,
  onStep,
  onWind,
}: {
  /** How far through what is live, 0 to 1. */
  progress: number;
  /** How far the live body runs, as the live pane measured it. */
  extent: Extent;
  onStep: (forward: boolean) => void;
  onWind: (progress: number) => void;
}) {
  const lastScreen = Math.max(1, extent.screenfuls - 1);
  const screen = Math.min(
    lastScreen,
    Math.round(progress / (extent.step || 1)),
  );

  const canWind = extent.screenfuls > 1;
  const canUp = canWind && screen > 0;
  const canDown = canWind && screen < lastScreen;

  /*
   * `step` is how much of the whole text one press moves on this surface, so
   * going back is a multiplication rather than a fraction of the press count.
   * It has to be: the same press moves a different distance on a screen showing
   * more text at once.
   */
  const up = () => onWind((screen - 1) * extent.step);
  const down = () =>
    onWind(screen + 1 >= lastScreen ? 1 : (screen + 1) / lastScreen);

  /*
   * The arrow keys, which are where an operator's hand already is.
   *
   * Left and right step through what is staged; up and down wind a body taller
   * than the screen. The same four things the buttons do, calling the same
   * expressions — a shortcut that winds by a different amount than the button
   * beside it is two behaviours wearing one name.
   *
   * `handsAreBusy` is what keeps this from being a hazard: an operator typing
   * in a search box means "move the caret" by Left, and one with a dialogue
   * open means the dialogue.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (handsAreBusy(event)) return;

      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          onStep(false);
          return;
        case "ArrowRight":
          event.preventDefault();
          onStep(true);
          return;
        case "ArrowUp":
          if (!canUp) return;
          event.preventDefault();
          up();
          return;
        case "ArrowDown":
          if (!canDown) return;
          event.preventDefault();
          down();
          return;
        default:
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onStep, onWind, extent, screen, lastScreen, canUp, canDown]);

  return {
    /** Which screenful of a long body is showing, counted from zero. */
    screen,
    screenfuls: extent.screenfuls,
    canUp,
    canDown,
    up,
    down,
  };
}
