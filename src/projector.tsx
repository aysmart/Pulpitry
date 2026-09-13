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
  closeThisOutput,
  coversDesk,
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
import { overlayWords, plainText, type OverlayForm } from "./lib/overlays";
import {
  filled,
  loadShape,
  onShapeChanged,
  shapeIdOf,
} from "./lib/shapes";
import type { SlideElement } from "./lib/design";
import { DesignedView } from "./components/DesignedView";
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
   * The church's own furniture, where this output names one.
   *
   * Loaded once when the window learns which form it draws, and again if that
   * changes. Null means one of the six built-in forms -- or a shape that has
   * since been deleted, in which case drawing nothing is the honest answer: an
   * output falling back to somebody else's furniture mid-service is worse than
   * one that is plainly empty.
   */
  const [shape, setShape] = useState<SlideElement[] | null>(null);

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

  /*
   * The furniture this window draws, read whenever it could have changed.
   *
   * Two moments, not one. The form changes when the operator points this output
   * at a different shape -- a settings save, which the look above answers. The
   * shape itself changes when they draw on it in the studio, which saves a
   * catalog row and nothing else: read once at startup, this window went on
   * drawing the version it opened with while the studio showed the new one.
   */
  useEffect(() => {
    if (shapeIdOf(form || "") === null) {
      setShape(null);
      return;
    }

    let active = true;
    const read = () =>
      void loadShape(form).then((drawn) => active && setShape(drawn));

    read();
    const stop = onShapeChanged((id) => {
      if (id === shapeIdOf(form || "")) read();
    });

    return () => {
      active = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [form]);

  /*
   * Escape closes the screen the key was pressed on.
   *
   * A borderless always-on-top window filling a display, with no title bar and
   * no pointer, is a trap when it lands on the only screen the operator has:
   * the desk is gone, the mouse is gone, and it reads as the application
   * hanging. Escape is the way out of that.
   *
   * It used to close the second display if this was the second display and the
   * projector otherwise -- so on any of the outputs a church adds for a foyer
   * or a stream, that key closed a screen somewhere else in the building and
   * left the one in front of them exactly where it was. The window now names
   * itself and the backend maps its label back to the output, which is the one
   * place that mapping lives.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Through the backend, which also stops the feed and forgets the window.
      // If that cannot be reached at all, the window closes itself: this key is
      // the way out of a screen with nothing else on it, and it has to work
      // even when the thing it would normally ask does not answer.
      void closeThisOutput().catch(() => getCurrentWindow().close());
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
   * A shape the church drew, filled with what is live -- and answered by that
   * shape or by nothing.
   *
   * `overlayPlan` ends in `default: lower-third`, so "shape:14" -- which is not
   * one of the six -- drew a lower third. Every shape a church made therefore
   * came out looking like the one they were trying to replace, on the wall and
   * over NDI, and the studio looked as though it had not saved anything.
   *
   * Nothing is also the right answer while it is still being read, and for a
   * shape that has since been deleted: a switcher keying an empty frame shows
   * the camera, and the operator sees the furniture is missing. Falling back to
   * somebody else's furniture hides both.
   */
  if (shapeIdOf(form) !== null) {
    /*
     * A shape draws when it has something to put in it.
     *
     * Null covers both of the cases where it has not: nothing is live, and what
     * is live is a slide, which belongs on a screen of its own. Either way the
     * furniture goes too -- a band with no words in it is not an overlay, it is
     * a bar across somebody's camera.
     */
    const words = overlayWords(drawn);
    if (!shape || !words) {
      return (
        <div
          className="relative h-full w-full overflow-hidden"
          style={{ background: "transparent" }}
        />
      );
    }

    return (
      <div
        className="relative h-full w-full overflow-hidden [container-type:size]"
        style={{ background: "transparent" }}
      >
        <DesignedView
          elements={filled(
            shape,
            words,
            captions ? (drawn?.caption ?? null) : null,
          )}
          theme={theme}
          uppercase={uppercase}
        />
      </div>
    );
  }

  /*
   * One of the shipped forms: furniture and nothing else.
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
          // A slide is not words: see `overlayWords`. Nothing here means this
          // output draws nothing, which leaves the camera showing.
          text={overlayWords(drawn)}
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

/**
 * The way out, on the one screen where it is needed.
 *
 * # The fault this answers
 *
 * An output is a borderless window, always on top, filling a display, with the
 * pointer hidden — because nobody points at a projector and a cursor sitting on
 * a wall is a distraction in a service. Put that same window on the screen the
 * operator is working on, which is what happens on a laptop with nothing
 * plugged into it, and every one of those decisions reads as a crash: the desk
 * vanishes, the mouse vanishes, and nothing answers. Escape has always closed
 * it; nothing has ever said so.
 *
 * Opening an output there is allowed on purpose — somebody setting this up at
 * home has one screen and still wants to see what it looks like — so the answer
 * is not to refuse it but to stop the window pretending it is in a hall.
 *
 * # Why a congregation never sees this
 *
 * It is drawn only when this window is on the same screen as the desk, which is
 * by definition not the screen anybody is watching. On a wall, a foyer panel or
 * an NDI feed there is no pointer and no chip, exactly as before.
 *
 * Mounted beside the view rather than inside it because the view returns early
 * for each of the shapes it draws, and a way out that appeared on some of them
 * would be worse than none.
 */
function DeskHint() {
  const [onDesk, setOnDesk] = useState(false);
  const [fresh, setFresh] = useState(true);

  useEffect(() => {
    let active = true;
    void coversDesk()
      .then((covering) => active && setOnDesk(covering))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    // Nobody points at a projector, and the cursor would sit on the wall --
    // but a hidden pointer on the operator's own screen is the single thing
    // that makes this look like a hang rather than a window.
    document.body.style.cursor = onDesk ? "default" : "none";
  }, [onDesk]);

  useEffect(() => {
    if (!onDesk) return;
    // Loud enough to be read, then out of the way: it stays as a chip rather
    // than disappearing, because somebody who looked away for the first six
    // seconds is exactly the person who needs it.
    const timer = window.setTimeout(() => setFresh(false), 6000);
    return () => window.clearTimeout(timer);
  }, [onDesk]);

  if (!onDesk) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 flex justify-center"
      style={{ zIndex: 2147483647 }}
    >
      <p
        className="mt-3 rounded-full bg-black/75 text-white shadow-lg backdrop-blur transition-all duration-700"
        style={
          fresh
            ? { padding: "0.5rem 1.1rem", fontSize: 14, opacity: 0.95 }
            : { padding: "0.25rem 0.7rem", fontSize: 11, opacity: 0.35 }
        }
      >
        {fresh
          ? "This output is covering the screen you work on — press Esc to close it"
          : "Esc closes this output"}
      </p>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Projector />
    <DeskHint />
  </React.StrictMode>,
);
