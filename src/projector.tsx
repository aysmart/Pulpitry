import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { LiveBodyView } from "./components/LiveBodyView";
import { fillsFrame, type LiveBody } from "./lib/projector";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import {
  EVENT_STAGE,
  backgroundOf,
  getStage,
  type StageState,
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
  themeForWindow,
  onTheme,
  referenceStyle,
  verticalStyle,
  type ProjectorTheme,
} from "./lib/theme";
import { withBackground } from "./lib/design";
import { Backdrop } from "./components/Backdrop";
import { OverlayView } from "./components/OverlayView";
import { StageView } from "./components/StageView";
import { plainText, type OverlayForm } from "./lib/overlays";
import { scriptureIn } from "./lib/bible";
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
  // A designed slide always has: whatever it says, it says where the operator
  // put it, and a caption bolted underneath would land on top of their layout.
  if (body.kind === "designed") return true;
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
  /*
   * Which shape this window draws in.
   *
   * "none" is the whole screen, which every window was and most still are.
   * Anything else is furniture on transparency, to be keyed at the far end --
   * and the difference has to be known before the first paint, or a lower
   * third flashes as a full-screen card on the way to being itself.
   */
  const [form, setForm] = useState<OverlayForm>("none");
  /** Empty follows the Scripture panel, which is what every window did. */
  const [translation, setTranslation] = useState("");
  /*
   * Whether the desk that owns the wall captions its words.
   *
   * Taken from the *shared* look rather than this window's, and only for this
   * one question. An output that names a template of its own stops following
   * the wall's look, which is right for its colours and its type and wrong for
   * whether a caption exists at all: the song desk turns its titles off and a
   * lower third with its own template went on printing them.
   */
  const [captions, setCaptions] = useState(true);

  /*
   * The page itself has to be see-through, not only the window around it.
   *
   * An overlay went out over NDI as a solid block because `body` carries the
   * application's charcoal from the stylesheet. The window was transparent,
   * the capture kept the alpha, NDI carried BGRA and the overlay's own box was
   * transparent -- every layer but the one that paints first, which filled the
   * frame before any of the others were reached.
   *
   * Set here rather than in the stylesheet because it is the one window that
   * wants it. The operator window is the same application and must keep its
   * ground; a whole-screen output wants the theme's background, not nothing.
   */
  useEffect(() => {
    const clear = form !== "none" && form !== "stage";
    const was = {
      html: document.documentElement.style.background,
      body: document.body.style.background,
    };
    if (clear) {
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
    }
    return () => {
      document.documentElement.style.background = was.html;
      document.body.style.background = was.body;
    };
  }, [form]);
  const [uppercase, setUppercase] = useState(false);
  const [stageClock, setStageClock] = useState(true);
  const [stageLive, setStageLive] = useState(true);
  const [stage, setStageState] = useState<StageState>({
    startedAt: 0,
    limitMinutes: 0,
    note: "",
    nextUp: "",
  });
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
    // This window's own theme, not the shared one: an output can be given a
    // template of its own, and one that took the broadcast would quietly draw
    // in somebody else's look.
    const mine = getCurrentWindow().label;
    void themeForWindow(mine)
      .then((look) => {
        if (!active) return;
        setTheme(look.theme);
        setForm(look.overlay as OverlayForm);
        setTranslation(look.translation);
        setUppercase(look.uppercase);
        setStageClock(look.stageClock);
        setStageLive(look.stageLive);
      })
      .catch(() => undefined);
    void getTheme()
      .then((shared) => active && setCaptions(shared.showReference))
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
    void getStage()
      .then((current) => active && setStageState(current))
      .catch(() => undefined);

    void Promise.all([
      onLive((next) => active && setContent(next)),
      // Broadcast like content rather than fetched like appearance: two stage
      // screens showing different timers would be worse than one.
      listen<StageState>(EVENT_STAGE, (event) =>
        active ? setStageState(event.payload) : undefined,
      ).then((stop) => stop),
      // The payload is the shared theme, which is right only for a window
      // following it. Re-asking costs one call on a settings save and is the
      // only version that stays correct for a window with its own template.
      onTheme((shared) => {
        // The payload is the wall's look, which is the desk's; this window's
        // own is re-asked for below because it may name a template.
        if (active) setCaptions(shared.showReference);
        void themeForWindow(mine)
          .then((look) => {
            if (!active) return;
            setTheme(look.theme);
            setForm(look.overlay as OverlayForm);
            setTranslation(look.translation);
            setUppercase(look.uppercase);
            setStageClock(look.stageClock);
            setStageLive(look.stageLive);
          })
          .catch(() => undefined);
      }),
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

  /*
   * The same passage, in this output's own Bible.
   *
   * Content arrives already drawn in the operator's translation, because every
   * output must agree about what is live. An output told to read another one
   * re-draws the words from the reference it was given -- the mirror's own
   * trick, turned inward on one machine.
   *
   * On its own effect rather than inside the subscription: the translation can
   * change while something is live, and a church that switches an overflow room
   * to another Bible should see it happen rather than at the next verse.
   */
  const [drawn, setDrawn] = useState<LiveContent | null>(null);
  useEffect(() => {
    let active = true;
    if (!translation || !content || content.body.kind !== "scripture") {
      setDrawn(content);
      return () => {
        active = false;
      };
    }
    void scriptureIn(translation, content.caption)
      .then((passage) => {
        if (!active) return;
        // Nothing back means the passage is not in that translation -- a
        // Catholic edition's extra books, a partial text. Keep what we were
        // given rather than emptying a screen mid-service.
        setDrawn(
          passage.lines.length
            ? {
                ...content,
                body: { kind: "scripture", lines: passage.lines },
                // The label comes with the words. It read "Genesis 1:12 (AMP)"
                // over Yoruba, because only the verses had been redrawn.
                caption: passage.caption || content.caption,
              }
            : content,
        );
      })
      .catch(() => active && setDrawn(content));
    return () => {
      active = false;
    };
  }, [content, translation]);

  /*
   * The platform's own screen, which is nobody else's.
   *
   * Before the overlay branch because it is not one: an overlay is the
   * congregation's content in another shape, and this is different content
   * altogether -- a timer, and a line from the desk that must never reach a
   * wall.
   */
  if (form === "stage") {
    return (
      <div className="relative h-full w-full overflow-hidden [container-type:size]">
        <StageView
          stage={stage}
          theme={theme}
          reference={drawn?.caption ?? null}
          text={plainText(drawn)}
          uppercase={uppercase}
          showClock={stageClock}
          showLive={stageLive}
        />
      </div>
    );
  }

  /*
   * An overlay draws its furniture and nothing else.
   *
   * No backdrop, no ticker band, no 16:9 letterboxing -- every one of those
   * paints across the frame, and a frame painted across is a picture rather
   * than something a switcher can key. The container query unit still works,
   * so a form drawn at 1280 and at 3840 is the same design.
   */
  if (form !== "none") {
    return (
      <div
        className="relative h-full w-full overflow-hidden [container-type:size]"
        style={{ background: "transparent" }}
      >
        <OverlayView
          form={form}
          theme={theme}
          reference={drawn?.caption ?? null}
          text={plainText(drawn)}
          uppercase={uppercase}
          captions={captions}
        />
      </div>
    );
  }

  return (
    <div
      // container-type so the announcement band can size itself against the
      // screen rather than the viewport, exactly as it does in the preview.
      className="relative h-full w-full overflow-hidden [container-type:size]"
      // Set here rather than on each piece of text, so everything this output
      // draws agrees -- verse, lyric and slide alike.
      style={uppercase ? { textTransform: "uppercase" } : undefined}
    >
      {/* A designed deck carries its own background, and the wall is the one
          surface where getting that wrong is visible to everybody. */}
      <Backdrop theme={withBackground(theme, backgroundOf(drawn?.body))} />

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
            className={`relative flex h-full w-full flex-col items-center overflow-hidden [container-type:size] ${
              drawn && fillsFrame(drawn.body) ? "" : "px-[6cqw] py-[5cqh]"
            }`}
            // Where the words sit in the frame, which the theme decides: a
            // church with a logo across the bottom of their screen ranges the
            // words to the top and nothing overlaps.
            style={verticalStyle(theme)}
          >
            {drawn ? (
              <>
                <LiveBodyView
                  body={drawn.body}
                  theme={theme}
                  audio={audio}
                  command={command}
                  progress={drawn.progress}
                />
                {captions && drawn.caption && !titledItself(drawn.body) ? (
                  /* Its own typeface, size and colour, set by the theme. The
                     margin is in cqh like everything else in this frame, so it
                     holds its proportion whatever the screen is. */
                  <p
                    className="mt-[4cqh] text-center tracking-wide opacity-60"
                    style={referenceStyle(theme)}
                  >
                    {drawn.caption}
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
