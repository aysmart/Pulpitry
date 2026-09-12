import { useState } from "react";

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
import { fontStack, type ProjectorTheme } from "../lib/theme";
import { useTransport } from "../lib/useTransport";
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
    return {
      kind: "image" as const,
      path: item.path,
      looping: false,
      fill: item.fill,
    };
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
    return {
      kind: "image" as const,
      path: body.path,
      looping: false,
      fill: body.fill,
    };
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

/** The same, for a row that should not compete with the transport above it. */
const QUIET =
  "rounded border border-pulpitry-line px-2 py-1 text-[11.5px] text-pulpitry-muted transition-colors hover:border-pulpitry-muted hover:text-pulpitry-text disabled:opacity-35 focus-visible:focus-ring";

/**
 * Everything the output panes need, whichever way they are arranged.
 *
 * One interface for two arrangements: the desk's stage column and the slide
 * desk's output column show the same things in different shapes, and two prop
 * lists would drift the first time either gained a control.
 */
interface Output {
  preview: Presentable | null;
  live: LiveContent | null;
  onDisplay: () => void;
  onClear: () => void;
  onStep: (forward: boolean) => void;
  /** Only a deck has slides to follow. */
  canFollow: boolean;
  following: boolean;
  onFollowChange: (on: boolean) => void;
  /** Whether a match moves the screen rather than being offered. */
  advance: boolean;
  onAdvanceChange: (on: boolean) => void;
  /** The slide the sermon seems to have reached, and how sure. */
  suggestion: { index: number; score: number } | null;
  onTakeSuggestion: (index: number) => void;
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
}

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
  canFollow,
  following,
  onFollowChange,
  advance,
  onAdvanceChange,
  suggestion,
  onTakeSuggestion,
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
}: Output) {
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

  // Stepping, winding and the arrow keys, shared with the slide desk's output
  // column so the two cannot come to disagree about what a press does.
  const transport = useTransport({
    progress: live?.progress ?? 0,
    extent: liveExtent,
    onStep,
    onWind,
  });

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
        {/* Only where there is a deck to follow. A control that is present
            and does nothing on everything else teaches an operator to stop
            reading this row. */}
        {canFollow ? (
          <button
            type="button"
            onClick={() => onFollowChange(!following)}
            title={
              following
                ? "Stop watching for the slide being spoken about"
                : "Watch the sermon and say which slide it has reached"
            }
            className={
              following
                ? "rounded border border-pulpitry-gold-dim bg-pulpitry-gold/10 px-3 py-1.5 text-[12px] text-pulpitry-gold transition-colors focus-visible:focus-ring"
                : CONTROL
            }
          >
            {following ? "Following" : "Follow"}
          </button>
        ) : null}

        {/*
          Offered, not taken.
          
          Beside the transport rather than over the preview, because it is one
          more thing an operator may press -- not an announcement that
          interrupts what they were doing. It disappears the moment it is acted
          on or the deck moves, so it can never sit there recommending a slide
          that is already up.
        */}
        {/* Only once following is on, and worded as what it does rather than
            as a feature. A church that wants it is entitled to it; a church
            that switches it on by accident finds out in front of everybody. */}
        {canFollow && following ? (
          <label
            className="flex items-center gap-1.5 px-1 text-[11.5px] text-pulpitry-muted"
            title="Move the screen on a match instead of offering it. A wrong match then shows in front of the congregation."
          >
            <input
              type="checkbox"
              checked={advance}
              onChange={(event) => onAdvanceChange(event.target.checked)}
              className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
            />
            Move by itself
          </label>
        ) : null}

        {following && suggestion ? (
          <button
            type="button"
            onClick={() => onTakeSuggestion(suggestion.index)}
            title={`${Math.round(suggestion.score * 100)}% alike`}
            className="rounded border border-pulpitry-teal bg-pulpitry-teal/15 px-3 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold focus-visible:focus-ring"
          >
            Go to slide {suggestion.index + 1}
          </button>
        ) : null}

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
      {transport.screenfuls > 1 ? (
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-pulpitry-muted">
            This is taller than the screen — wind it as you read.
          </span>
          <span className="flex-1" />
          <span className="text-[11px] text-pulpitry-muted tabular-nums">
            {transport.screen + 1} of {transport.screenfuls}
          </span>
          <button
            type="button"
            onClick={transport.up}
            disabled={!transport.canUp}
            title="Back up a screenful"
            className={CONTROL}
          >
            ↑
          </button>
          <button
            type="button"
            onClick={transport.down}
            disabled={!transport.canDown}
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
/** Which slide of a deck or song something is, where it is one. */
function slideCount(item: Presentable | null): string {
  if (item?.kind !== "lyric") return "";
  return `Slide ${item.index + 1} of ${item.sections.length}`;
}

/**
 * One column: what the congregation is seeing, what is staged behind it, and
 * the transport under both.
 *
 * The slide desk's output, and a different claim from the desk's stage column.
 * There, Live is given the whole height because the operator's attention is on
 * a transcript and a chapter — the wall is being watched out of the corner of
 * an eye. Here the wall *is* the work: an operator running a deck is looking at
 * what is up, what is next, and the button that moves between them, and those
 * three belong in one column in that order.
 *
 * Both panes draw the real theme and the real backdrop at the wall's own
 * proportions, so the difference between them is only which one has been sent.
 */
export function MainOutput({
  side = "column",
  preview,
  live,
  onDisplay,
  onClear,
  onStep,
  onWind,
  onAdd,
  canFollow,
  following,
  onFollowChange,
  advance,
  onAdvanceChange,
  suggestion,
  onTakeSuggestion,
  theme,
  canStepBack,
  canStepForward,
  projectorOpen,
  audio,
  onAudioChange,
  media,
  ticker,
}: Output & {
  /**
   * How the two panes sit.
   *
   * A column on the slide desk, where the output is a narrow band beside the
   * work. A row on the song desk, where the middle of the window is wide and
   * two 16:9 panes stacked in it would each be a strip. The contents and the
   * transport are identical either way -- this decides only which direction
   * the pair runs.
   */
  side?: "column" | "row";
}) {
  const [liveExtent, setLiveExtent] = useState<Extent>({
    screenfuls: 1,
    step: 1,
  });
  const transport = useTransport({
    progress: live?.progress ?? 0,
    extent: liveExtent,
    onStep,
    onWind,
  });

  const previewPane = (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex shrink-0 items-baseline justify-between gap-2">
        <span className="text-[10.5px] tracking-[0.12em] text-pulpitry-muted uppercase">
          Preview
        </span>
        <span className="truncate text-[11px] text-pulpitry-muted">
          {slideCount(preview) ||
            (preview ? presentableLabel(preview) : "Nothing staged")}
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-pulpitry-line [container-type:size]">
        <Stage
          body={preview ? presentableText(preview) : null}
          asset={assetOf(preview)}
          slide={slideOf(preview, theme)}
          reference={preview ? presentableLabel(preview) : null}
          tone="preview"
          empty="Pick something below to stage it."
          theme={theme}
        />
      </div>
    </div>
  );

  return (
    <Panel
      title="Main output"
      accent="gold"
      className="min-h-0"
      bodyClassName="flex flex-col gap-1.5 p-2"
      actions={
        /* What state the output is in, in one word. An operator glancing at
           this column needs to know whether what they are looking at is on the
           wall or only on their desk, and the two panes below look alike by
           design. */
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] tracking-[0.12em] uppercase ${
            live
              ? "border-pulpitry-gold-dim bg-pulpitry-gold/10 text-pulpitry-gold"
              : preview
                ? "border-pulpitry-teal-dim text-pulpitry-teal"
                : "border-pulpitry-line text-pulpitry-muted"
          }`}
        >
          {live ? "Live" : preview ? "Staged" : "Empty"}
        </span>
      }
    >
      {/*
        Which way round the pair sits is the only difference between the two
        desks: a column beside the slides, a row across the middle of the songs
        window. Preview leads in a row because it is read left to right -- what
        is coming, then what is up -- and Live leads in a column because the eye
        goes to the top of one.
      */}
      <div
        className={
          side === "row"
            ? "flex min-h-0 flex-1 gap-2"
            : "flex min-h-0 flex-1 flex-col gap-2"
        }
      >
      {side === "row" ? previewPane : null}
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <div className="flex shrink-0 items-baseline justify-between gap-2">
          <span className="text-[10.5px] tracking-[0.12em] text-pulpitry-gold uppercase">
            Live display
          </span>
          <span className="truncate text-[11px] text-pulpitry-muted">
            {live?.caption ||
              (transport.screenfuls > 1
                ? `Screen ${transport.screen + 1} of ${transport.screenfuls}`
                : "")}
          </span>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-pulpitry-gold-dim/40 [container-type:size]">
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
          <TickerBand ticker={ticker} theme={theme} />
        </div>
      </div>
      {side === "column" ? previewPane : null}
      </div>

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

      {/* Winding, and only when there is something to wind: a table of figures
          or a lexicon entry taller than the wall. */}
      {transport.screenfuls > 1 ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-pulpitry-muted">
            Taller than the screen — wind it as you read.
          </span>
          <button
            type="button"
            onClick={transport.up}
            disabled={!transport.canUp}
            title="Back up a screenful"
            className={CONTROL}
          >
            ↑
          </button>
          <button
            type="button"
            onClick={transport.down}
            disabled={!transport.canDown}
            title="Down a screenful"
            className={CONTROL}
          >
            ↓
          </button>
        </div>
      ) : null}

      {/*
        The transport, in the order a hand uses it.

        Display is the middle and the loudest: on a slide desk it is pressed
        once per slide, which is more often than anything else in the window.
      */}
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onStep(false)}
          disabled={!canStepBack}
          title="The slide before this one"
          className={`${CONTROL} flex-1`}
        >
          Prev
        </button>
        <button
          type="button"
          onClick={onDisplay}
          disabled={!preview}
          className="flex-[1.6] rounded bg-pulpitry-gold px-3 py-2 text-[13px] text-pulpitry-ink transition-opacity hover:bg-pulpitry-gold/90 disabled:opacity-35 focus-visible:focus-ring"
        >
          Display
        </button>
        <button
          type="button"
          onClick={() => onStep(true)}
          disabled={!canStepForward}
          title="The next slide"
          className={`${CONTROL} flex-1`}
        >
          Next
        </button>
      </div>

      {/*
        The quieter row.

        Following a sermon belongs on the slide desk more than anywhere else --
        it is the one arrangement where the deck on screen and the words being
        spoken are the same argument -- so it stays, kept small, rather than
        being dropped for a tidier column.
      */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onAdd}
          disabled={!preview}
          title="Add what is staged to the service plan"
          className={QUIET}
        >
          Add to plan
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={!live}
          title="Take it off the screen"
          className={QUIET}
        >
          Clear
        </button>
        {canFollow ? (
          <button
            type="button"
            onClick={() => onFollowChange(!following)}
            title={
              following
                ? "Stop watching for the slide being spoken about"
                : "Watch the sermon and say which slide it has reached"
            }
            className={
              following
                ? "rounded border border-pulpitry-gold-dim bg-pulpitry-gold/10 px-2 py-1 text-[11.5px] text-pulpitry-gold focus-visible:focus-ring"
                : QUIET
            }
          >
            {following ? "Following" : "Follow"}
          </button>
        ) : null}
        {canFollow && following ? (
          <label
            className="flex items-center gap-1.5 text-[11px] text-pulpitry-muted"
            title="Move the screen on a match instead of offering it. A wrong match then shows in front of the congregation."
          >
            <input
              type="checkbox"
              checked={advance}
              onChange={(event) => onAdvanceChange(event.target.checked)}
              className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
            />
            Move by itself
          </label>
        ) : null}
        {following && suggestion ? (
          <button
            type="button"
            onClick={() => onTakeSuggestion(suggestion.index)}
            title={`${Math.round(suggestion.score * 100)}% alike`}
            className="rounded border border-pulpitry-teal bg-pulpitry-teal/15 px-2 py-1 text-[11.5px] text-pulpitry-text hover:border-pulpitry-gold focus-visible:focus-ring"
          >
            Go to slide {suggestion.index + 1}
          </button>
        ) : null}
      </div>
    </Panel>
  );
}

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
