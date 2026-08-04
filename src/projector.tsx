import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { LiveBodyView } from "./components/LiveBodyView";
import {
  closeProjector,
  getAudio,
  getLive,
  getMedia,
  getTicker,
  onAudio,
  onLive,
  onMedia,
  onTicker,
  type AudioState,
  type LiveContent,
  type MediaCommand,
  type Ticker,
} from "./lib/projector";
import { DEFAULT_THEME, getTheme, onTheme, type ProjectorTheme } from "./lib/theme";
import { Backdrop } from "./components/Backdrop";
import { TickerBand } from "./components/TickerBand";
import "./styles.css";

/**
 * The congregation-facing window.
 *
 * Shows only what is live, over whatever background the operator chose, and
 * nothing at all when they clear — a blank screen is the "off" state, not a
 * logo or a placeholder.
 */
function Projector() {
  const [content, setContent] = useState<LiveContent | null>(null);
  const [theme, setTheme] = useState<ProjectorTheme>(DEFAULT_THEME);
  const [audio, setAudio] = useState<AudioState>({ muted: false, volume: 1 });
  const [ticker, setTicker] = useState<Ticker>({
    text: "",
    visible: false,
    position: "bottom",
    speed: 24,
  });
  const [command, setCommand] = useState<MediaCommand>({
    playing: true,
    looping: false,
    seekNonce: 0,
    seekTo: 0,
  });

  useEffect(() => {
    let active = true;
    const stops: Array<() => void> = [];

    // This window can be opened at any point during a service, so take whatever
    // is already live rather than staying blank until the next change.
    void getLive().then((current) => active && setContent(current)).catch(() => undefined);
    void getTheme().then((current) => active && setTheme(current)).catch(() => undefined);
    void getAudio().then((current) => active && setAudio(current)).catch(() => undefined);
    void getMedia().then((current) => active && setCommand(current)).catch(() => undefined);
    void getTicker().then((current) => active && setTicker(current)).catch(() => undefined);

    void Promise.all([
      onLive((next) => active && setContent(next)),
      onTheme((next) => active && setTheme(next)),
      onAudio((next) => active && setAudio(next)),
      onMedia((next) => active && setCommand(next)),
      onTicker((next) => active && setTicker(next)),
    ]).then((unlisteners) => {
      stops.push(...unlisteners);
      if (!active) stops.forEach((stop) => stop());
    });

    return () => {
      active = false;
      stops.forEach((stop) => stop());
    };
  }, []);

  // A borderless always-on-top window covering the screen is a trap if there
  // is only one display: the operator cannot reach the controls to close it.
  // Escape is the way out.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void closeProjector();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      // container-type so the announcement band can size itself against the
      // screen rather than the viewport, exactly as it does in the preview.
      className="relative h-full w-full overflow-hidden [container-type:size]"
    >
      <Backdrop theme={theme} />

      <TickerBand ticker={ticker} theme={theme} />

      <div className="relative flex h-full w-full flex-col items-center justify-center px-[6vw] py-[5vh]">
        {content ? (
          <>
            <LiveBodyView body={content.body} theme={theme} audio={audio} command={command} />
            {theme.showReference && content.caption ? (
              <p
                className="mt-[4vh] text-center text-[clamp(0.9rem,1.6vw,1.8rem)] tracking-wide opacity-60"
                style={{ color: theme.textColor }}
              >
                {content.caption}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Nobody points at a projector, and the cursor would sit on the wall.
document.body.style.cursor = "none";

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Projector />
  </React.StrictMode>,
);
