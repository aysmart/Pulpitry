import { useEffect, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import {
  bodyText,
  type AudioState,
  type LiveBody,
  type LiveContent,
  type MediaCommand,
  type MediaProgress,
  type TextBlock,
  type Ticker,
} from "../lib/projector";
import { handsAreBusy } from "../lib/shortcuts";
import { fontStack, type ProjectorTheme } from "../lib/theme";
import { Backdrop } from "./Backdrop";
import {
  presentableLabel,
  presentableText,
  toLiveContent,
  type Presentable,
} from "../lib/usePresentation";
import { EmptyState, Panel } from "./Panel";
import { MediaTransport } from "./MediaTransport";
import { SlideCanvas } from "./SlideCanvas";
import type { Extent } from "./LiveBodyView";
import { TickerBand } from "./TickerBand";
import { VideoSurface } from "./VideoSurface";

function Stage({
  body,
  asset,
  slide,
  reference,
  tone,
  empty,
  theme,
  projectorOpen = false,
  audio = { muted: false, volume: 1 },
  command,
  progress = 0,
  onExtent,
}: {
  body: string | null;
  /** A picture or clip, which fills the pane instead of the text layout. */
  asset?: {
    kind: "image" | "media";
    path: string;
    looping: boolean;
    /** Whether it fills the pane or sits whole inside it. Carried here because
     *  these panes draw assets themselves rather than through LiveBodyView, so
     *  a switch the wall obeys means nothing until it reaches this copy. */
    fill: boolean;
  } | null;
  /** A written slide, which is its own layout and must not be flattened. */
  slide?: {
    blocks: TextBlock[];
    theme: ProjectorTheme;
    /** Present where the slide has components rather than lines. */
    body?: LiveBody;
  } | null;
  /** How far through a long slide it is wound, and how far it goes. Live
   *  only. */
  progress?: number;
  onExtent?: (extent: Extent) => void;
  reference: string | null;
  tone: "preview" | "live";
  empty: string;
  /** Set on the Live pane, so it previews what the congregation actually sees. */
  theme?: ProjectorTheme;
  /** Decides which surface owns the sound; see below. */
  projectorOpen?: boolean;
  audio?: AudioState;
  command?: MediaCommand;
}) {
  if (slide) {
    return (
      <div
        className="flex h-full items-center justify-center p-3"
        data-selectable
      >
        <SlideCanvas
          blocks={slide.blocks}
          body={slide.body}
          theme={slide.theme}
          progress={progress}
          onExtent={onExtent}
        />
      </div>
    );
  }

  if (asset) {
    return (
      <div
        className={`flex h-full items-center justify-center bg-pulpitry-ink ${
          asset.fill ? "overflow-hidden" : ""
        }`}
        data-selectable
      >
        {asset.kind === "image" ? (
          <img
            src={convertFileSrc(asset.path)}
            alt=""
            className={
              asset.fill
                ? "h-full w-full object-cover"
                : "max-h-full max-w-full object-contain"
            }
          />
        ) : (
          <VideoSurface
            path={asset.path}
            // Exactly one surface plays the sound. The projector owns it when
            // it is open; when it is not, this pane is the only output there
            // is, and muting it would mean a clip that silently does nothing.
            // Preview never makes noise — it is a look ahead, not an output.
            muted={tone === "preview" || projectorOpen || audio.muted}
            volume={audio.volume}
            looping={command?.looping ?? asset.looping}
            command={tone === "live" ? command : undefined}
            // Whoever owns the sound owns the clock: the projector when it is
            // open, this pane otherwise. Two reporters would fight.
            reportProgress={tone === "live" && !projectorOpen}
            className={
              asset.fill
                ? "h-full w-full object-cover"
                : "max-h-full max-w-full object-contain"
            }
          />
        )}
      </div>
    );
  }

  if (!body) {
    return <EmptyState>{empty}</EmptyState>;
  }

  // Outline width is authored for a projector; at panel scale the same value
  // would swallow the letterforms.
  const outline = theme && theme.outlineWidth > 0 ? theme.outlineWidth / 4 : 0;

  return (
    <div className="relative h-full overflow-hidden" data-selectable>
      {theme ? <Backdrop theme={theme} /> : null}

      <div className="relative flex h-full flex-col justify-center gap-3 px-6 py-5">
        <p
          className={`text-center text-[clamp(1rem,2.1vw,1.6rem)] leading-[1.35] text-balance ${
            theme ? "" : "scripture-type"
          } ${tone === "live" && !theme ? "text-pulpitry-text" : theme ? "" : "text-pulpitry-text/80"}`}
          style={
            theme
              ? {
                  fontFamily: fontStack(theme.fontFamily),
                  color: theme.textColor,
                  ...(outline
                    ? {
                        WebkitTextStrokeWidth: `${outline}px`,
                        WebkitTextStrokeColor: theme.outlineColor,
                        paintOrder: "stroke fill",
                      }
                    : {}),
                  ...(theme.shadow
                    ? { textShadow: "0 0.06em 0.14em rgba(0,0,0,0.55)" }
                    : {}),
                }
              : undefined
          }
        >
          {body}
        </p>
        {reference && (!theme || theme.showReference) ? (
          /*
           * The operator's typeface and colour, but not their size.
           *
           * Size is the one thing this pane deliberately does not follow. It is
           * a few inches across, and a reference set faithfully small here
           * would be unreadable to the person who has to check it -- so 12px is
           * the legible base and the operator's scale moves it relative to
           * that. The wall is where the real size is judged, and the wall gets
           * it exactly.
           */
          <p
            className={`text-center tracking-wide ${
              theme
                ? "opacity-60"
                : tone === "live"
                  ? "text-pulpitry-gold"
                  : "text-pulpitry-muted"
            }`}
            style={
              theme
                ? {
                    fontFamily: fontStack(
                      theme.referenceFontFamily || theme.fontFamily,
                    ),
                    color: theme.referenceColor || theme.textColor,
                    fontSize: `${(12 * (theme.referenceScale || 1)).toFixed(1)}px`,
                  }
                : { fontSize: "12px" }
            }
          >
            {reference}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The written slide behind an item, if that is what it is. */
/**
 * What the canvas should draw for a staged item, if anything.
 *
 * Asked of `toLiveContent` rather than worked out here, because that is the
 * function that decides what goes to the projector and these panes exist to
 * show what the projector will get. Deciding it twice is how Preview came to
 * disagree: it tested for a slide, and a deck's section is a lyric -- so a
 * sermon's slides, which are kept as a deck, fell through to the plain-text
 * pane and a table arrived as a run of words.
 */
function slideOf(item: Presentable | null, theme: ProjectorTheme) {
  if (!item) return null;
  const body = toLiveContent(item).body;
  if (body.kind === "richText") return { blocks: body.blocks, theme, body };
  if (body.kind === "composed") return { blocks: [], theme, body };
  return null;
}

/**
 * The same, for whatever the projector is currently showing.
 *
 * Both kinds of slide: `richText` is what every slide made before components
 * existed carries, and `composed` is what one made since carries. Leaving the
 * second out sent it to the plain-text pane, where a table arrived as a run of
 * words -- so a slide that was correct on the wall looked broken on the desk.
 */
function liveSlide(body: LiveBody | undefined, theme: ProjectorTheme) {
  if (body?.kind === "richText") return { blocks: body.blocks, theme, body };
  if (body?.kind === "composed") return { blocks: [], theme, body };
  return null;
}

/** The picture or clip behind an item, if that is what it is. */
function assetOf(item: Presentable | null) {
  if (item?.kind === "image")
    return { kind: "image" as const, path: item.path, looping: false, fill: item.fill };
  if (item?.kind === "media")
    return {
      kind: "media" as const,
      path: item.path,
      looping: item.looping,
      fill: item.fill,
    };
  return null;
}

/** The same, for whatever the projector is currently showing. */
function liveAsset(body: LiveBody | undefined) {
  if (body?.kind === "image")
    return { kind: "image" as const, path: body.path, looping: false, fill: body.fill };
  if (body?.kind === "media")
    return {
      kind: "media" as const,
      path: body.path,
      looping: body.looping,
      fill: body.fill,
    };
  return null;
}

const CONTROL =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-2 text-[13px] text-pulpitry-text transition-opacity hover:border-pulpitry-muted disabled:opacity-35 focus-visible:focus-ring";

/**
 * Preview and Live, with the transport between them.
 *
 * Live is read from the shared state rather than this window's own, so what is
 * shown here is by construction what the projector is showing.
 */
export function StagePanel({
  preview,
  live,
  onDisplay,
  onClear,
  onStep,
  onWind,
  onAdd,
  theme,
  canStepBack,
  canStepForward,
  projectorOpen,
  audio,
  onAudioChange,
  media,
  ticker,
}: {
  preview: Presentable | null;
  live: LiveContent | null;
  onDisplay: () => void;
  onClear: () => void;
  onStep: (forward: boolean) => void;
  /** Winds what is live to a point in it, 0 at the top and 1 at the end. */
  onWind: (progress: number) => void;
  onAdd: () => void;
  theme: ProjectorTheme;
  canStepBack: boolean;
  canStepForward: boolean;
  projectorOpen: boolean;
  audio: AudioState;
  onAudioChange: (next: Partial<AudioState>) => void;
  media: {
    command: MediaCommand;
    progress: MediaProgress;
    play: () => void;
    pause: () => void;
    seek: (to: number) => void;
    restart: () => void;
    toggleLoop: () => void;
  };
  ticker: Ticker;
}) {
  /*
   * How many screenfuls what is live takes, as the Live pane measured it.
   *
   * Held here rather than derived from the content, because it is a fact about
   * layout -- the typeface, the theme's scale and the shape of the screen all
   * decide it -- and the only place those are all true at once is the pane that
   * renders the wall in miniature.
   */
  const [liveExtent, setLiveExtent] = useState<Extent>({
    screenfuls: 1,
    step: 1,
  });

  /*
   * The stored position is a point in the text; the operator thinks in screens.
   *
   * The point is what every surface agrees on -- this preview, the projector,
   * the second display, a paired Castavox -- because each of them shows a
   * different amount of text and a screen number would mean a different place
   * on each. But "2 of 6" is what an operator can act on, so the two are
   * converted here, using what *this* surface measured.
   *
   * `step` is how much of the whole text one press moves on this surface, so
   * the conversion is a division rather than a fraction of the press count. It
   * has to be: the same press moves a different distance on a screen showing
   * more text at once.
   */
  const lastScreen = Math.max(1, liveExtent.screenfuls - 1);
  const liveScreen = Math.min(
    lastScreen,
    Math.round((live?.progress ?? 0) / (liveExtent.step || 1)),
  );

  /*
   * The arrow keys, which are where an operator's hand already is.
   *
   * Left and right step through what is staged; up and down wind a body taller
   * than the screen. The same four things the buttons below do, and they call
   * the same expressions rather than their own -- a shortcut that winds by a
   * different amount than the button beside it is two behaviours wearing one
   * name.
   *
   * `handsAreBusy` is what keeps this from being a hazard: an operator typing
   * in a search box means "move the caret" by Left, and one with a dialogue
   * open means the dialogue.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (handsAreBusy(event)) return;

      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          onStep(false);
          return;
        case "ArrowRight":
          event.preventDefault();
          onStep(true);
          return;
        case "ArrowUp":
          if (liveExtent.screenfuls <= 1 || liveScreen === 0) return;
          event.preventDefault();
          onWind((liveScreen - 1) * liveExtent.step);
          return;
        case "ArrowDown":
          if (liveExtent.screenfuls <= 1 || liveScreen >= lastScreen) return;
          event.preventDefault();
          onWind(liveScreen + 1 >= lastScreen ? 1 : (liveScreen + 1) / lastScreen);
          return;
        default:
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onStep, onWind, liveExtent, liveScreen, lastScreen]);


  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onDisplay}
          disabled={!preview}
          className="flex-1 rounded bg-pulpitry-gold px-4 py-2 text-[13px] text-pulpitry-ink transition-opacity hover:bg-pulpitry-gold/90 disabled:opacity-35 focus-visible:focus-ring"
        >
          Display
        </button>
        <button
          type="button"
          onClick={() => onStep(false)}
          disabled={!canStepBack}
          className={CONTROL}
        >
          Prev
        </button>
        <button
          type="button"
          onClick={() => onStep(true)}
          disabled={!canStepForward}
          className={CONTROL}
        >
          Next
        </button>
        <button
          type="button"
          onClick={onAdd}
          disabled={!preview}
          title="Add what is staged to the service plan"
          className={CONTROL}
        >
          Add
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={!live}
          className={CONTROL}
        >
          Clear
        </button>
      </div>

      {/*
        Winding controls, and only when there is something to wind.
        
        They appear for the one body that outgrows a screen -- a lexicon entry,
        which runs to several hundred words. Every other body fits, and a pair
        of permanently dead arrows beside Display would be four more pixels of
        chrome for an operator to learn to ignore.
        
        The count is what the Live pane measured. It renders the same content in
        the same proportions as the wall, so its answer is the wall's answer.
      */}
      {liveExtent.screenfuls > 1 ? (
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-pulpitry-muted">
            This is taller than the screen — wind it as you read.
          </span>
          <span className="flex-1" />
          <span className="text-[11px] text-pulpitry-muted tabular-nums">
            {liveScreen + 1} of {liveExtent.screenfuls}
          </span>
          <button
            type="button"
            onClick={() => onWind((liveScreen - 1) * liveExtent.step)}
            disabled={liveScreen === 0}
            title="Back up a screenful"
            className={CONTROL}
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() =>
              onWind(
                liveScreen + 1 >= lastScreen
                  ? 1
                  : (liveScreen + 1) / lastScreen,
              )
            }
            disabled={liveScreen >= lastScreen}
            title="Down a screenful"
            className={CONTROL}
          >
            ↓
          </button>
        </div>
      ) : null}

      <Panel
        title="Live"
        accent="gold"
        // The whole column. Preview moved out to sit beside the library, where
        // the operator is choosing what to stage; Live belongs where they are
        // watching what the congregation sees, and it had half the height for
        // the more important half of the job.
        className="flex-1"
        bodyClassName="relative [container-type:size]"
      >
        <Stage
          body={live ? bodyText(live.body) : null}
          asset={liveAsset(live?.body)}
          slide={liveSlide(live?.body, theme)}
          reference={live?.caption ?? null}
          tone="live"
          empty="Nothing is on the projector."
          theme={theme}
          projectorOpen={projectorOpen}
          audio={audio}
          command={media.command}
          progress={live?.progress ?? 0}
          onExtent={setLiveExtent}
        />
        {/* Shown here as well as on the wall, so the operator can see what the
            congregation is reading rather than trusting that it is there. */}
        <TickerBand ticker={ticker} theme={theme} />
      </Panel>

      {live?.body.kind === "media" ? (
        <MediaTransport
          command={media.command}
          progress={media.progress}
          audio={audio}
          onPlay={media.play}
          onPause={media.pause}
          onSeek={media.seek}
          onRestart={media.restart}
          onToggleLoop={media.toggleLoop}
          onAudioChange={onAudioChange}
        />
      ) : null}
    </div>
  );
}

/**
 * What is staged next, beside the library that stages it.
 *
 * Split out of the stage column so that Live could have all of it. These two
 * were stacked, which gave each of them half the height and put Preview -- a
 * look ahead -- level in weight with the thing the congregation is actually
 * reading. It also sat a long way from the library, so choosing a verse meant
 * looking at one side of the screen and checking the result on the other.
 *
 * # It carries the theme, which it did not used to
 *
 * As a short pane under Live it drew plain text on the panel's own background,
 * and that was defensible: it was a reminder of what was staged, and the pane
 * beside it was already showing the real thing.
 *
 * It is not defensible now. This is a column the width of the wall's own
 * proportions, and the whole reason to look at it is to know what the
 * congregation will see -- so it renders the typeface, the colour and the
 * backdrop they will actually get. A preview that looks nothing like the output
 * is a preview of nothing.
 */
export function PreviewPanel({
  preview,
  theme,
}: {
  preview: Presentable | null;
  theme: ProjectorTheme;
}) {
  return (
    <Panel title="Preview">
      <Stage
        body={preview ? presentableText(preview) : null}
        asset={assetOf(preview)}
        slide={slideOf(preview, theme)}
        reference={preview ? presentableLabel(preview) : null}
        tone="preview"
        empty="Pick a verse from the Chapter panel to stage it."
        theme={theme}
      />
    </Panel>
  );
}
