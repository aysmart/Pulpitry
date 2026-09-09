import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { baseSize, type ProjectorTheme } from "../lib/theme";
import type { StageState } from "../lib/projector";

/**
 * What the platform sees, and only the platform.
 *
 * # What belongs here that must never be on the wall
 *
 * A stage display answers three questions a congregation must never be asked:
 * how long have I been speaking, what am I meant to be showing, and is the
 * person at the desk trying to tell me something. Every one of those on a
 * congregation's screen is a mistake nobody can take back — so this is its own
 * view rather than the projector with a clock added to it.
 *
 * # Design
 *
 * Read from six metres away by somebody who is also talking. That rules out
 * most of what makes a screen pleasant: no photograph behind it, no gradient,
 * nothing that moves. Black, one accent, and sizes that are frankly too large
 * for a desk — because this is not read at a desk.
 *
 * The clock is there because a stage rarely has one that the speaker can see
 * without turning round, and turning round is the thing they must not do.
 */

/** mm:ss, or h:mm:ss once a service has been going long enough to need it. */
function asClock(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "−" : "";
  const seconds = Math.abs(Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${sign}${hours}:${pad(minutes)}:${pad(rest)}`
    : `${sign}${minutes}:${pad(rest)}`;
}

/**
 * The largest size at which the whole verse still fits the box it is in.
 *
 * # Why this is measured rather than guessed
 *
 * The projector picks a size from the text's length, which works because there
 * the text has the whole frame. A stage display shares its frame with a timer
 * and a reference, so the same length has less room and the same size runs off
 * the bottom -- which is what clipped "that tree, you're dead." halfway through
 * its own line.
 *
 * A guess cannot fix that, because the room depends on the screen's shape, the
 * timer's size, whether the clock is shown and whether there is a note. Asking
 * the browser is the only answer that stays right as those change.
 *
 * Steps down rather than binary-searching: a dozen reflows of one paragraph is
 * nothing, and stepping is obviously correct where a search over a
 * non-monotonic wrap is not quite.
 */
function useFittedSize(
  box: React.RefObject<HTMLDivElement | null>,
  text: string | null,
  max: number,
): number {
  const [size, setSize] = useState(max);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element || !text) {
      setSize(max);
      return;
    }

    let chosen = max;
    const fits = () => element.scrollHeight <= element.clientHeight + 1;

    // Try the largest first: most verses fit it, and those pay one measure.
    element.style.setProperty("--stage-size", `${chosen}cqw`);
    while (!fits() && chosen > 1.4) {
      chosen = Math.round((chosen - 0.15) * 100) / 100;
      element.style.setProperty("--stage-size", `${chosen}cqw`);
    }
    setSize(chosen);
  }, [box, text, max]);

  return size;
}

export function StageView({
  stage,
  theme,
  reference,
  text,
  uppercase,
  showClock,
  showLive,
}: {
  stage: StageState;
  theme: ProjectorTheme;
  reference: string | null;
  text: string | null;
  /** Whether this output sets its words in capitals. */
  uppercase: boolean;
  /** The wall clock beside the timer. */
  showClock: boolean;
  /** What the congregation is looking at. */
  showLive: boolean;
}) {
  /*
   * Counted here rather than sent.
   *
   * The desk broadcasts the instant the timer started; each screen counts from
   * it. A count sent every second would be a message a second from a machine
   * running a service, and it would drift the moment one was dropped.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(tick);
  }, []);

  const accent = theme.referenceColor || "#E8590C";
  const running = stage.startedAt > 0;
  const elapsed = running ? (now - stage.startedAt) / 1000 : 0;
  const counting =
    stage.limitMinutes > 0 ? stage.limitMinutes * 60 - elapsed : elapsed;

  // Over time is the one state that has to be unmissable, and colour is the
  // only thing that carries at six metres to somebody mid-sentence.
  const over = stage.limitMinutes > 0 && counting < 0;

  const wall = new Date(now).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  /*
   * A timer on its own is a different instrument, not a stage display with
   * pieces missing.
   *
   * With nothing else on it, the clock stops being a line at the top and
   * becomes the whole screen: centred, and as large as the frame allows. That
   * is what makes it readable from anywhere on a platform rather than only
   * from the seat it was aimed at -- which is the reason to want one.
   */
  const timerOnly = !showLive && !showClock;

  /*
   * The largest size the verse still fits at, capped where legibility stops
   * improving. `baseSize` is the opening guess -- a short line has no reason
   * to start large and be measured down.
   */
  const liveBox = useRef<HTMLDivElement | null>(null);
  const fitted = useFittedSize(
    liveBox,
    text,
    Math.min(baseSize(text ?? ""), 5.2),
  );

  if (timerOnly) {
    return (
      <div
        className="flex h-full w-full items-center justify-center p-[3cqw]"
        style={{ background: "#000000" }}
      >
        <span
          style={{
            fontSize: "26cqw",
            fontWeight: 800,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.03em",
            lineHeight: 1,
            color: over ? "#FF4D4D" : running ? accent : "#3A3A3A",
          }}
        >
          {running ? asClock(counting) : "—"}
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col justify-between p-[3cqw]"
      style={{ background: "#000000", color: "#FFFFFF" }}
    >
      <div className="flex items-baseline justify-between">
        <span
          style={{
            // Larger when it is the only thing in the top band, because there
            // is the room and it is what the screen is for.
            fontSize: showLive ? "9cqw" : "16cqw",
            fontWeight: 800,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.02em",
            color: over ? "#FF4D4D" : running ? accent : "#5A5A5A",
          }}
        >
          {running ? asClock(counting) : "—"}
        </span>
        {showClock ? (
          <span
            style={{
              fontSize: showLive ? "3.4cqw" : "5cqw",
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              color: "#8A8A8A",
            }}
          >
            {wall}
          </span>
        ) : null}
      </div>

      {/*
        What the congregation is looking at, so the speaker never has to turn
        round to find out.

        Top-aligned rather than centred. Centring put one short line in the
        middle of a very tall region and left a void under it, which read as a
        screen that had failed rather than one with little to say. Text now
        starts under the timer and grows down, which is also where a reader's
        eye already is.

        Sized by length, the same steps the projector uses: a two-word line and
        a long verse cannot share a size, and a stage display is read at six
        metres by somebody who is also talking.
      */}
      {showLive ? (
        <div
          ref={liveBox}
          /*
           * `min-h-0` is what makes `flex-1` mean "no taller than what is
           * left". A column flex child keeps `min-height: auto` by default, so
           * it refuses to shrink below its content: the band grew past the
           * frame and the last line was cut off by the overflow above it,
           * which looks like a rendering fault and is a layout one.
           */
          className="flex min-h-0 flex-1 flex-col gap-[1.2cqw] overflow-hidden py-[2.5cqw]"
          style={{ ["--stage-size" as string]: `${fitted}cqw` }}
        >
          {reference ? (
            <span
              style={{
                fontSize: "2.4cqw",
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: accent,
              }}
            >
              {reference}
            </span>
          ) : null}

          {text ? (
            <span
              style={{
                fontSize: "var(--stage-size)",
                lineHeight: 1.3,
                fontWeight: 600,
                textTransform: uppercase ? "uppercase" : "none",
              }}
            >
              {text}
            </span>
          ) : (
            /*
             * Quiet, and small.
             *
             * This had the hero slot at hero size, so a stage screen with
             * nothing live announced its own emptiness in letters larger than
             * anything it would ever say. When nothing is on, the timer is the
             * whole point of the screen and this is a footnote.
             */
            <span
              style={{ fontSize: "1.9cqw", fontWeight: 500, color: "#6A6A6A" }}
            >
              Nothing on screen
            </span>
          )}
        </div>
      ) : (
        // Keeps the note at the bottom and the timer at the top rather than
        // letting the two collapse together in the middle.
        <div className="flex-1" />
      )}

      {/* Last, and only when there is one. A permanent empty box teaches a
          platform to stop looking at the place a message would appear. */}
      {stage.note.trim() ? (
        <div
          style={{
            background: accent,
            color: "#101010",
            fontSize: "3.2cqw",
            fontWeight: 800,
            padding: "1.4cqw 2cqw",
            textTransform: "uppercase",
            letterSpacing: "0.02em",
          }}
        >
          {stage.note}
        </div>
      ) : null}
    </div>
  );
}
