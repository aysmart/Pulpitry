import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import { rememberTour, TOUR } from "../lib/tour";
import type { Workspace } from "../lib/workspaces";

/** Room for the card, and how far it sits off the thing it points at. */
const CARD = 340;
const GAP = 14;
/** Enough for the longest step at the narrowest window, and clamped anyway. */
const TALL = 210;
const EDGE = 16;

/**
 * The tour: a light on one panel at a time, and a sentence about it.
 *
 * # Why it dims the window rather than opening pages of its own
 *
 * A page of screenshots is out of date the week it is written and teaches
 * nobody where anything is. Pointing at the real panel, in the real window,
 * with the operator's own translation and look in it, is the only version that
 * cannot drift -- and the thing being learned is *where*, which a picture of
 * somewhere else cannot say.
 *
 * # It never touches anything
 *
 * Every step reads. Nothing stages, nothing goes live, nothing is saved, and
 * the desk it moves to is the only change it makes -- because the first run of
 * this will be on a Sunday morning with a congregation already in the room,
 * and a tour that pressed things would be unusable exactly when it is needed.
 *
 * `data-dialog`, so the window's own keyboard rules stand down while it is up:
 * Enter here means the next step, not the wall.
 */
export function Tour({
  from,
  onDesk,
  onClose,
}: {
  /** The desk this was opened from, which is where it puts them back. */
  from: Workspace;
  /** Moves the window to the desk a step is about, before it is pointed at. */
  onDesk: (desk: Workspace) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  /*
   * The desk it opened on, held rather than read.
   *
   * `from` is the desk the window is showing, and the tour moves that itself:
   * by the last step it would say "media", so putting somebody back where they
   * were means remembering it before the first step moves anything.
   */
  const [started] = useState(from);
  const step = TOUR[index]!;
  const last = index === TOUR.length - 1;

  const finish = useCallback(() => {
    /*
     * Back where they were.
     *
     * The tour walks through four desks and would otherwise end by leaving
     * somebody on the media library, three desks from the work they stopped
     * doing to read it. An interruption should put things back.
     */
    onDesk(started);
    rememberTour();
    onClose();
  }, [started, onDesk, onClose]);

  // The desk first: a step about the song library has nothing to point at
  // until the song desk is the one on screen.
  useEffect(() => {
    if (step.desk) onDesk(step.desk);
  }, [step, onDesk]);

  useLayoutEffect(() => {
    if (!step.at) {
      setBox(null);
      return;
    }

    const find = () => {
      const node = document.querySelector(`[data-tour="${step.at}"]`);
      setBox(node ? node.getBoundingClientRect() : null);
    };

    find();
    /*
     * And again a moment later.
     *
     * A step that changes desk is measuring a panel that React has not
     * rendered yet, and one that has just appeared has not been laid out. The
     * second look costs nothing and is the difference between a light on the
     * panel and a light on where the panel used to be.
     */
    const settle = window.setTimeout(find, 80);
    window.addEventListener("resize", find);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("resize", find);
    };
  }, [step]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        finish();
        return;
      }
      if (event.key === "Enter" || event.key === "ArrowRight") {
        event.preventDefault();
        if (last) finish();
        else setIndex((at) => at + 1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex((at) => Math.max(0, at - 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [last, finish]);

  /*
   * Where the card goes: below what is lit, or above it where there is no
   * room, and inside the window either way. Centred on the screen when the
   * step is about the whole window rather than one panel.
   */
  const place = (): { top: number; left: number } => {
    if (!box) {
      return {
        top: Math.max(EDGE, window.innerHeight / 2 - TALL / 2),
        left: Math.max(EDGE, window.innerWidth / 2 - CARD / 2),
      };
    }
    const below = box.bottom + GAP;
    const top =
      below + TALL < window.innerHeight ? below : Math.max(EDGE, box.top - TALL - GAP);
    const wanted = box.left + box.width / 2 - CARD / 2;
    return {
      top: Math.min(top, window.innerHeight - TALL - EDGE),
      left: Math.min(Math.max(EDGE, wanted), window.innerWidth - CARD - EDGE),
    };
  };

  const at = place();

  return (
    <div data-dialog className="fixed inset-0 z-[60]">
      {/*
        The dim, and the hole in it.

        One element does both: a huge spread shadow covers the window and the
        element's own box is the part it does not cover. Four divs around the
        panel would leave hairlines at the corners on a fractional scale, which
        on a dark ground reads as a rendering fault.
      */}
      {box ? (
        <div
          className="pointer-events-none absolute rounded-md ring-2 ring-pulpitry-gold/70 transition-all duration-200"
          style={{
            top: box.top - 4,
            left: box.left - 4,
            width: box.width + 8,
            height: box.height + 8,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.66)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/66" />
      )}

      <div
        className="absolute flex flex-col gap-2 rounded-lg border border-pulpitry-line bg-pulpitry-surface p-3.5 shadow-2xl"
        style={{ top: at.top, left: at.left, width: CARD }}
        role="dialog"
        aria-label="A look around Pulpitry"
      >
        <div className="flex items-center gap-2">
          {/* The part of the service this belongs to, rather than the number
              alone: thirty stops is a lot to hold, and "Songs, four of five"
              is a place where "step nineteen" is a count. */}
          <span className="text-[10.5px] tracking-[0.14em] text-pulpitry-gold uppercase">
            {step.group}
          </span>
          <span className="text-[10.5px] text-pulpitry-muted tabular-nums">
            {index + 1}/{TOUR.length}
          </span>
          {/* How much is left, which is the one thing a person reads before
              deciding whether to carry on. A bar rather than thirty dots: at
              this length the dots stop being countable and become texture. */}
          <span
            className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-pulpitry-line"
            aria-hidden
          >
            <span
              className="block h-full rounded-full bg-pulpitry-gold/80 transition-all duration-200"
              style={{ width: `${((index + 1) / TOUR.length) * 100}%` }}
            />
          </span>
        </div>

        <h2 className="text-[15px] text-pulpitry-text">{step.title}</h2>
        <p className="text-[12.5px] leading-relaxed text-pulpitry-muted">
          {step.body}
        </p>

        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={finish}
            className="rounded px-1.5 py-1 text-[12px] text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
          >
            {last ? "Close" : "Skip the tour"}
          </button>
          <span className="flex-1" />
          {index > 0 ? (
            <button
              type="button"
              onClick={() => setIndex((was) => was - 1)}
              className="rounded border border-pulpitry-line px-2.5 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold-dim focus-visible:focus-ring"
            >
              Back
            </button>
          ) : null}
          <button
            type="button"
            autoFocus
            onClick={() => (last ? finish() : setIndex((was) => was + 1))}
            className="rounded bg-pulpitry-gold px-3 py-1.5 text-[12px] text-pulpitry-ink transition-opacity hover:bg-pulpitry-gold/90 focus-visible:focus-ring"
          >
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
