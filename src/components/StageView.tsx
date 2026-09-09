import { useEffect, useState } from "react";

import type { ProjectorTheme } from "../lib/theme";
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

export function StageView({
  stage,
  theme,
  reference,
  text,
}: {
  stage: StageState;
  theme: ProjectorTheme;
  reference: string | null;
  text: string | null;
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

  return (
    <div
      className="flex h-full w-full flex-col justify-between p-[3cqw]"
      style={{ background: "#000000", color: "#FFFFFF" }}
    >
      <div className="flex items-baseline justify-between">
        <span
          style={{
            fontSize: "9cqw",
            fontWeight: 800,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.02em",
            color: over ? "#FF4D4D" : running ? accent : "#5A5A5A",
          }}
        >
          {running ? asClock(counting) : "—"}
        </span>
        <span
          style={{
            fontSize: "3.4cqw",
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            color: "#8A8A8A",
          }}
        >
          {wall}
        </span>
      </div>

      {/* What the congregation is looking at, so the speaker never has to turn
          round to find out. Large, because it is read while talking. */}
      <div className="flex flex-1 flex-col justify-center gap-[1.4cqw] py-[2cqw]">
        {reference ? (
          <span
            style={{
              fontSize: "2.6cqw",
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: accent,
            }}
          >
            {reference}
          </span>
        ) : null}
        <span style={{ fontSize: "4.2cqw", lineHeight: 1.35, fontWeight: 600 }}>
          {text ?? "Nothing on screen"}
        </span>
      </div>

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
