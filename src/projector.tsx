import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { LiveBodyView } from "./components/LiveBodyView";
import { fillsFrame, type LiveBody } from "./lib/projector";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  closeProjector,
  closeSecond,
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
import {
  DEFAULT_THEME,
  getTheme,
  onTheme,
  referenceStyle,
  type ProjectorTheme,
} from "./lib/theme";
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
/**
 * Whether the thing on screen already shows its own name.
 *
 * The caption is the item's title, drawn small beneath everything -- right for
 * a verse, whose reference is not otherwise on the slide, and wrong for a
 * composed slide, which carries its title as a component set large at the top.
 * "Seeing The Difference" appeared as the heading and again as a grey line
 * under it.
 */
function titledItself(body: LiveBody): boolean {
  return (
    body.kind === "composed" &&
    body.components.some(
      (component) => component.kind === "text" && component.level === "title",
    )
  );
}

function Projector() {
  const [content, setContent] = useState<LiveContent | null>(null);
  const [theme, setTheme] = useState<ProjectorTheme>(DEFAULT_THEME);
  const [audio, setAudio] = useState<AudioState>({ muted: false, volume: 1 });
  const [ticker, setTicker] = useState<Ticker>({
    text: "",
    visible: false,
    textColor: "#F4F1EA",
    bandColor: "#000000",
    bandOpacity: 0.45,
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
    void getLive()
      .then((current) => active && setContent(current))
      .catch(() => undefined);
    void getTheme()
      .then((current) => active && setTheme(current))
      .catch(() => undefined);
    void getAudio()
      .then((current) => active && setAudio(current))
      .catch(() => undefined);
    void getMedia()
      .then((current) => active && setCommand(current))
      .catch(() => undefined);
    void getTicker()
      .then((current) => active && setTicker(current))
      .catch(() => undefined);

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
  //
  // Which window to close is decided by which window this is. The same view
  // serves both outputs -- a church with an overflow room wants the same
  // content and the same theme there, and rendering it twice from one component
  // is the only way the two cannot drift apart.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      void (getCurrentWindow().label === "second"
        ? closeSecond()
        : closeProjector());
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

      {/*
        Text is laid out into 16:9, whatever shape the screen is.

        # Why the screen's own shape is not used

        A church's projector may be 16:10, or a TV panel may report something
        odd, and the desk's two preview panes are boxes on a laptop that are
        neither. Letting each surface use its own proportions meant the same
        words broke in different places and each one held a different number of
        lines -- so the pane labelled Live was not showing what was live.

        Fixing every surface to one ratio makes them the same layout by
        construction rather than by coincidence. 16:9 because that is what
        church projectors and streams are, and what a template is designed in.

        The backdrop above is deliberately outside this box and still covers the
        whole screen. Constraining the words is the point; letterboxing the
        colour would put black bars on a wall for no reason.
      */}
      <div className="relative flex h-full w-full items-center justify-center">
        {/*
          `min()` rather than max-width and max-height: `aspect-ratio` is
          honoured against an element's preferred size and then clamped, so a
          box given both constraints quietly stops being 16:9 on exactly the
          screens this exists to handle. Sizing it explicitly cannot drift.

          177.78cqh is 16/9 of the height. The units resolve against the root
          above, which is why the containment for the text sits on the child.
        */}
        <div className="[aspect-ratio:16/9] [width:min(100cqw,177.78cqh)]">
          <div
            className={`relative flex h-full w-full flex-col items-center justify-center overflow-hidden [container-type:size] ${
              content && fillsFrame(content.body) ? "" : "px-[6cqw] py-[5cqh]"
            }`}
          >
            {content ? (
              <>
                <LiveBodyView
                  body={content.body}
                  theme={theme}
                  audio={audio}
                  command={command}
                  progress={content.progress}
                />
                {theme.showReference && content.caption && !titledItself(content.body) ? (
                  /* Its own typeface, size and colour, set by the theme. The
                     margin is in cqh like everything else in this frame, so it
                     holds its proportion whatever the screen is. */
                  <p
                    className="mt-[4cqh] text-center tracking-wide opacity-60"
                    style={referenceStyle(theme)}
                  >
                    {content.caption}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
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
