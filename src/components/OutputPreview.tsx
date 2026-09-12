import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { scriptureIn } from "../lib/bible";
import { plainText, type OverlayForm } from "../lib/overlays";
import {
  EVENT_STAGE,
  fillsFrame,
  getStage,
  type LiveBody,
  type LiveContent,
  type StageState,
  type Ticker,
} from "../lib/projector";
import { referenceStyle, type ProjectorTheme } from "../lib/theme";
import { Backdrop } from "./Backdrop";
import { LiveBodyView } from "./LiveBodyView";
import { OverlayView } from "./OverlayView";
import { StageView } from "./StageView";
import { TickerBand } from "./TickerBand";

/**
 * What one output is drawing, in the pane where it is configured.
 *
 * # Why this is worth a thumbnail
 *
 * An output with no screen of its own cannot be looked at. Until this, the
 * only way to see what one was sending was a receiver on another machine --
 * which is how a feed that was announced and blank went unnoticed for two
 * days. The shapes are also hard to hold in the head: six overlay forms, each
 * with its own translation, capitals and theme, described in a sentence each.
 *
 * # Drawn by the same components as the window
 *
 * `StageView`, `OverlayView` and `LiveBodyView` are the ones the output's own
 * window runs, given that output's own theme, translation and capitals. A
 * stylised approximation would drift from the thing it claims to preview the
 * first time either changed -- and this pane exists to be trusted at a glance.
 *
 * # What it is not
 *
 * It is drawn here, in the operator's window, not captured from the output's.
 * So it shows what the output *should* be drawing, and cannot prove what a
 * switcher receives: if the output's own window had stopped drawing, this
 * would look perfectly correct. The row's "on the network" line and Check the
 * network can see it are the parts that answer that.
 */
export function OutputPreview({
  form,
  theme,
  translation,
  uppercase,
  stageClock,
  stageLive,
  live,
  ticker,
}: {
  form: OverlayForm;
  theme: ProjectorTheme;
  /** Empty follows the Scripture panel, exactly as the window does. */
  translation: string;
  uppercase: boolean;
  stageClock: boolean;
  stageLive: boolean;
  live: LiveContent | null;
  ticker: Ticker;
}) {
  const drawn = useDrawn(live ?? SAMPLE, translation);
  const stage = useStage(form === "stage");

  return (
    <div
      /*
       * `size`, not `inline-size`: the views inside size themselves in `cqh`
       * as well as `cqw`, and under inline containment `cqh` silently falls
       * back to the viewport -- which draws a preview to different proportions
       * than the screen it is previewing. `SlideCanvas` learned this first.
       */
      className="relative w-full overflow-hidden rounded border border-pulpitry-line [container-type:size]"
      style={{ aspectRatio: 16 / 9 }}
      // Decoration, not information: everything it shows is on the row in
      // words, and a screen reader reading a preview aloud is noise.
      aria-hidden="true"
    >
      {form === "stage" ? (
        <StageView
          stage={stage}
          theme={theme}
          reference={drawn?.caption ?? null}
          text={plainText(drawn)}
          uppercase={uppercase}
          showClock={stageClock}
          showLive={stageLive}
        />
      ) : form !== "none" ? (
        /* The chequerboard says what the window cannot: this output draws
           furniture on nothing at all, and the camera behind it at the far
           end is what fills the rest. A black box would read as a black
           screen, which is the one thing an overlay never sends. */
        <div className="absolute inset-0" style={CHEQUER}>
          <OverlayView
            form={form}
            theme={theme}
            reference={drawn?.caption ?? null}
            text={plainText(drawn)}
            uppercase={uppercase}
          />
        </div>
      ) : (
        <>
          <Backdrop theme={theme} playVideo={false} />
          <TickerBand ticker={ticker} theme={theme} />
          <div
            className={`absolute inset-0 flex flex-col items-center justify-center ${
              drawn && fillsFrame(drawn.body) ? "" : "px-[6cqw] py-[5cqh]"
            }`}
            style={uppercase ? { textTransform: "uppercase" } : undefined}
          >
            {drawn ? (
              <>
                <PreviewBody body={drawn.body} theme={theme} progress={drawn.progress} />
                {theme.showReference && drawn.caption ? (
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
        </>
      )}

      {live ? null : (
        <span className="absolute right-1 top-1 rounded bg-black/55 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/75">
          Sample
        </span>
      )}
    </div>
  );
}

/**
 * A clip is named rather than played.
 *
 * `LiveBodyView` draws a video the way the wall wants it: audible, and
 * reporting its own position back so the transport knows where it is. Five
 * thumbnails doing that would play a service's audio five times over and
 * argue with the wall about the clock.
 */
function PreviewBody({
  body,
  theme,
  progress,
}: {
  body: LiveBody;
  theme: ProjectorTheme;
  progress: number;
}) {
  if (body.kind === "media") {
    return (
      <p className="text-center text-[5cqw] font-medium tracking-wide text-white/70">
        Video playing
      </p>
    );
  }

  return (
    <LiveBodyView
      body={body}
      theme={theme}
      unit="cqw"
      // The outline is authored in px against a ~1920px screen; at this width
      // the same value would swallow the letterforms. SlideCanvas's figure.
      outlineScale={0.2}
      progress={progress}
    />
  );
}

/**
 * Something to look at when nothing is live.
 *
 * An overlay with nothing live draws nothing, which is correct on a switcher
 * and useless in a dialog: an operator choosing between six shapes would be
 * choosing between six empty boxes. Marked "Sample" so nobody reads it as
 * something that went out.
 */
const SAMPLE: LiveContent = {
  body: {
    kind: "scripture",
    lines: [
      {
        number: 16,
        text: "For God so loved the world, that he gave his only begotten Son.",
      },
    ],
  },
  caption: "John 3:16",
  ids: [],
  progress: 0,
};

/** Two greys in a chequer, the usual way of drawing "nothing is here". */
const CHEQUER: React.CSSProperties = {
  backgroundColor: "#2a2a28",
  backgroundImage:
    "linear-gradient(45deg, #201f1d 25%, transparent 25%), linear-gradient(-45deg, #201f1d 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #201f1d 75%), linear-gradient(-45deg, transparent 75%, #201f1d 75%)",
  backgroundSize: "12px 12px",
  backgroundPosition: "0 0, 0 6px, 6px -6px, -6px 0",
};

/**
 * The same passage in this output's Bible, as its window would redraw it.
 *
 * Mirrors the projector page: content is broadcast already drawn in the
 * operator's translation, and an output told to read another redraws it from
 * the reference. Nothing back means the passage is not in that translation --
 * a partial text, a different canon -- and then what we were given stands.
 */
function useDrawn(content: LiveContent, translation: string): LiveContent | null {
  const [drawn, setDrawn] = useState<LiveContent | null>(content);

  useEffect(() => {
    let active = true;
    if (!translation || content.body.kind !== "scripture") {
      setDrawn(content);
      return () => {
        active = false;
      };
    }
    void scriptureIn(translation, content.caption)
      .then((passage) => {
        if (!active) return;
        setDrawn(
          passage.lines.length
            ? {
                ...content,
                body: { kind: "scripture", lines: passage.lines },
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

  return drawn;
}

/** The timer and its note, for a stage display's preview only. */
function useStage(wanted: boolean): StageState {
  const [stage, setStage] = useState<StageState>(NO_STAGE);

  useEffect(() => {
    if (!wanted) return;
    let active = true;
    void getStage()
      .then((current) => active && setStage(current))
      .catch(() => undefined);

    // Kept current while the dialog is open: the stage controls are in the
    // same dialog, and a timer started there should appear in the preview
    // beside them rather than at the next reopen.
    const stop = listen<StageState>(EVENT_STAGE, (event) => {
      if (active) setStage(event.payload);
    });
    return () => {
      active = false;
      void stop.then((off) => off());
    };
  }, [wanted]);

  return stage;
}

const NO_STAGE: StageState = { startedAt: 0, limitMinutes: 0, note: "", nextUp: "" };
