import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";

import { getLive, onLive, type LiveContent } from "./lib/projector";

/**
 * The stage display: what the preacher sees.
 *
 * Not a copy of the projector. Somebody standing in front of that wall can turn
 * round and read it; what they cannot see is what is coming next, and what they
 * cannot easily judge is how long they have been speaking. So this shows three
 * things and nothing else:
 *
 *   - what the congregation is looking at now, large enough to read from the
 *     back of a platform;
 *   - what the operator has staged next, smaller, so the end of a passage is
 *     not a surprise;
 *   - the time, because every preacher wants it and nobody wants to look at
 *     their wrist while speaking.
 *
 * # Black, and deliberately plain
 *
 * This screen is a metre from somebody's face in a dark room, and they are
 * talking while they read it. It carries no theme, no background image and no
 * animation: the projector is where a church's design lives, and every one of
 * those things here is a way to dazzle or distract the one person who cannot
 * look away.
 */

/** What the operator's window sends. Preview is its own state, so it is pushed. */
interface StageMessage {
  next: { caption: string; lines: string[] } | null;
}

const EVENT_STAGE = "stage:next";

function textOf(live: LiveContent | null): { caption: string; lines: string[] } | null {
  if (!live) return null;
  switch (live.body.kind) {
    case "scripture":
      return { caption: live.caption, lines: live.body.lines.map((line) => line.text) };
    case "lyric":
      return { caption: live.caption, lines: live.body.lines };
    case "richText":
      return { caption: live.caption, lines: live.body.blocks.map((block) => block.text) };
    // A photograph or a clip has no words to read out. Saying which it is beats
    // an empty panel that reads as a fault.
    case "image":
      return { caption: live.caption, lines: ["(image)"] };
    case "media":
      return { caption: live.caption, lines: ["(video)"] };
    default:
      return null;
  }
}

function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Ticked on the second rather than every frame: this is a clock on a
    // machine that is also transcribing, and the seconds hand is not worth a
    // repaint budget.
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  return (
    <span className="tabular-nums text-[5vh] font-light text-white/70">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </span>
  );
}

function Stage() {
  const [live, setLive] = useState<LiveContent | null>(null);
  const [next, setNext] = useState<StageMessage["next"]>(null);

  useEffect(() => {
    let active = true;
    let stopLive: (() => void) | undefined;
    let stopNext: (() => void) | undefined;

    void getLive()
      .then((current) => active && setLive(current))
      .catch(() => undefined);
    void onLive((content) => setLive(content)).then((off) => {
      if (active) stopLive = off;
      else off();
    });

    // What is staged next lives in the operator window's own state, so it is
    // pushed here rather than read. A stage display that only knew what was
    // already on the wall would be telling the preacher what they can see.
    void listen<StageMessage>(EVENT_STAGE, (event) => setNext(event.payload.next)).then((off) => {
      if (active) stopNext = off;
      else off();
    });

    return () => {
      active = false;
      stopLive?.();
      stopNext?.();
    };
  }, []);

  const now = textOf(live);

  return (
    <div className="flex h-screen w-screen flex-col bg-black px-[4vw] py-[4vh] text-white">
      <header className="flex shrink-0 items-baseline justify-between">
        <span className="text-[3.2vh] uppercase tracking-[0.2em] text-white/40">
          {now?.caption || "Nothing on screen"}
        </span>
        <Clock />
      </header>

      <main className="flex min-h-0 flex-1 items-center">
        {now ? (
          <p className="max-h-full overflow-hidden text-[7vh] leading-[1.25] text-white">
            {now.lines.join(" ")}
          </p>
        ) : (
          <p className="text-[5vh] text-white/25">The screen is blank.</p>
        )}
      </main>

      {/* Next, and visibly subordinate: it is a glance, not a thing to read
          aloud. A preacher who mistakes it for what is on the wall has been
          badly served by the design. */}
      <footer className="shrink-0 border-t border-white/15 pt-[2vh]">
        <span className="text-[2.6vh] uppercase tracking-[0.2em] text-white/35">
          {next ? `Next — ${next.caption || "staged"}` : "Nothing staged"}
        </span>
        {next ? (
          <p className="mt-[1vh] max-h-[22vh] overflow-hidden text-[3.6vh] leading-snug text-white/55">
            {next.lines.join(" ")}
          </p>
        ) : null}
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Stage />
  </React.StrictMode>,
);
