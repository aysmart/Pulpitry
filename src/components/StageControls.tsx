import { useEffect, useState } from "react";

import { getStage, setStage, type StageState } from "../lib/projector";

/**
 * The desk's end of the stage display.
 *
 * # Why the note is here and not on the congregation's screen
 *
 * The one thing an operator cannot do during a service is talk to the
 * platform. They can change what is on the wall, and they can do nothing at
 * all about a speaker who has run eight minutes over — so they wave, or they
 * do not, and everybody pretends it is fine. This is the sentence they would
 * have said.
 *
 * # Why "Start" and not a countdown that runs itself
 *
 * A service does not begin when the plan says it does. Starting is a decision
 * somebody makes in the room, and a timer that had already been running for
 * six minutes when the preacher stood up would be worse than no timer.
 */

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text focus-visible:focus-ring";

const BUTTON =
  "rounded border border-pulpitry-line px-2.5 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold focus-visible:focus-ring";

export function StageControls() {
  const [state, setState] = useState<StageState>({
    startedAt: 0,
    limitMinutes: 0,
    note: "",
  });
  const [note, setNote] = useState("");

  useEffect(() => {
    void getStage()
      .then((current) => {
        setState(current);
        setNote(current.note);
      })
      .catch(() => undefined);
  }, []);

  const push = (change: Partial<StageState>) => {
    const next = { ...state, ...change };
    setState(next);
    void setStage(next).catch(() => undefined);
  };

  const running = state.startedAt > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => push({ startedAt: running ? 0 : Date.now() })}
          className={BUTTON}
        >
          {running ? "Stop the timer" : "Start the timer"}
        </button>
        {running ? (
          <button
            type="button"
            onClick={() => push({ startedAt: Date.now() })}
            className={BUTTON}
          >
            Restart
          </button>
        ) : null}

        <label className="flex items-center gap-2">
          <span className="text-[11.5px] text-pulpitry-muted">
            Count down from
          </span>
          <input
            type="number"
            min={0}
            max={240}
            value={state.limitMinutes || ""}
            onChange={(event) =>
              push({ limitMinutes: Number(event.target.value) || 0 })
            }
            placeholder="—"
            className={`w-20 ${FIELD}`}
          />
          <span className="text-[11.5px] text-pulpitry-muted">minutes</span>
        </label>
      </div>

      {/* Not saved as you type: a half-written word appearing on a stage in
          front of somebody mid-sentence is worse than a slow message. */}
      <div className="flex gap-2">
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") push({ note: note.trim() });
          }}
          placeholder="A line to the platform — “five minutes”, “wrap up”"
          className={`flex-1 ${FIELD}`}
        />
        <button
          type="button"
          onClick={() => push({ note: note.trim() })}
          className={BUTTON}
        >
          Send
        </button>
        {state.note ? (
          <button
            type="button"
            onClick={() => {
              setNote("");
              push({ note: "" });
            }}
            className={BUTTON}
          >
            Clear
          </button>
        ) : null}
      </div>

      <p className="text-[11px] leading-snug text-pulpitry-muted">
        Shown only on an output whose shape is “Stage display”. Counting up when
        no limit is set; over time turns red.
      </p>
    </div>
  );
}
