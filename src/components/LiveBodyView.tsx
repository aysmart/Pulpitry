import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import {
  bodyText,
  type AudioState,
  type LiveBody,
  type MediaCommand,
  type TextBlock,
} from "../lib/projector";
import { fontStack, textStyle, type ProjectorTheme } from "../lib/theme";
import { VideoSurface } from "./VideoSurface";

/**
 * Renders whatever is live, in whatever shape it takes.
 *
 * Shared by the projector and the slide editor so the two cannot drift apart.
 * `unit` is how: in `cqw` the same theme renders into a 16:9 box in exactly
 * the proportions it will take on the wall, so what an operator lays out is
 * what the congregation gets.
 */
export function LiveBodyView({
  body,
  theme,
  audio = { muted: false, volume: 1 },
  command,
  unit = "cqw",
  outlineScale = 1,
  progress = 0,
  onExtent,
}: {
  body: LiveBody;
  theme: ProjectorTheme;
  /** Always a fraction of the drawing box's own width; see textStyle. It
   *  stays a parameter only so a caller can be explicit. */
  unit?: "cqw";
  outlineScale?: number;
  /** Volume for a clip. Ignored by every other kind of body. */
  audio?: AudioState;
  /** Transport for a clip. Ignored by every other kind of body. */
  command?: MediaCommand;
  /** How far through a long body it is wound, 0 to 1. */
  progress?: number;
  /**
   * How far this body runs, once laid out.
   *
   * Only the operator's preview asks. It renders the same content in the same
   * proportions as the wall, so what it measures there is true there -- and it
   * is the only surface that can be measured, because the projector is a
   * different window and may be on a different machine's screen entirely.
   */
  onExtent?: (extent: Extent) => void;
}) {
  /*
   * How much text there is, which is what decides how big it is set.
   *
   * Only scripture was measured, so every other kind was sized as though it
   * were empty -- and `baseSize` gives an empty string its largest setting. A
   * four-hundred-word lexicon entry was therefore rendered at the size meant
   * for one short verse, which is most of why it overflowed a screen so far.
   */
  const style = textStyle(
    theme,
    bodyText(body),
    unit,
    outlineScale,
    // Written text is wound rather than shrunk: it is the one kind that is
    // expected not to fit, so it is set to be read and the surplus goes below
    // the fold where the operator can reach it.
    body.kind === "richText" ? READABLE : 0,
  );

  switch (body.kind) {
    case "scripture":
      return (
        <p
          className="w-full text-center leading-[1.3] text-balance"
          style={style}
        >
          {body.lines.map((line, index) => (
            <span key={line.number}>
              {/* Verse numbers only earn their place when several are shown
                  together; a single verse already has its reference beneath. */}
              {body.lines.length > 1 ? (
                <sup className="mr-[0.25em] align-super text-[0.5em] opacity-55">
                  {line.number}
                </sup>
              ) : null}
              {line.text}
              {index < body.lines.length - 1 ? " " : null}
            </span>
          ))}
        </p>
      );

    case "lyric":
      return (
        <p className="w-full text-center leading-[1.35]" style={style}>
          {body.lines.map((line, index) => (
            <span key={index} className="block">
              {line}
            </span>
          ))}
        </p>
      );

    case "richText":
      return (
        <ScrollingBlocks
          blocks={body.blocks}
          style={style}
          theme={theme}
          progress={progress}
          onExtent={onExtent}
        />
      );

    case "image":
      return (
        <img
          src={convertFileSrc(body.path)}
          alt=""
          className="max-h-full max-w-full object-contain"
        />
      );

    case "media":
      return (
        <VideoSurface
          path={body.path}
          // Audible, unlike a background: a clip played as content is meant to
          // be heard, and this surface is the one the congregation is watching.
          muted={audio.muted}
          volume={audio.volume}
          looping={command?.looping ?? body.looping}
          command={command}
          // The wall is the output whenever it exists, so it keeps the clock.
          reportProgress
          className="max-h-full max-w-full object-contain"
        />
      );
  }
}

/**
 * Written text that may be taller than the screen, wound to where the operator
 * put it.
 *
 * # Why this scrolls rather than shrinking
 *
 * Everything else here is sized to fit: a verse, a chorus and a written slide
 * are all short enough that making the type meet the box is the right answer.
 * A lexicon entry is not — it runs to several hundred words, and shrinking that
 * to fit a wall produces text nobody past the third row can read. So the type
 * stays the size the theme says and the surplus goes below the fold, where the
 * operator can wind to it.
 *
 * # A fraction is the unit, and this side owns the measurement
 *
 * The position arrives as a fraction of the way through the text, because every
 * surface showing it is a different shape and holds a different amount: the
 * preview box, the projector's display, the second display, and a paired
 * Castavox overlay. A frame number is a place that exists on one of them and
 * not the others -- which is exactly how winding to frame three moved the desk
 * and did nothing at all on the screen beside it.
 *
 * What this side reports back is how many screenfuls the text turned out to
 * take here, so the operator's controls can step in whole screens. A screenful
 * is 82% of the visible height, leaving a line or two of what was showing so a
 * reader is not dropped into unfamiliar prose.
 */
function ScrollingBlocks({
  blocks,
  style,
  theme,
  progress,
  onExtent,
}: {
  blocks: TextBlock[];
  style: CSSProperties;
  theme: ProjectorTheme;
  progress: number;
  onExtent?: (extent: Extent) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [extent, setExtent] = useState<Extent>({ screenfuls: 1, step: 1 });

  // After layout rather than after paint: the scroll position is set from the
  // same measurement, and a frame showing the top of a wound entry is a frame
  // the congregation sees.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;

    const measure = () => {
      const overflow = Math.max(0, element.scrollHeight - element.clientHeight);

      /*
       * A fraction of the *whole text*, not of the scrollable range.
       *
       * Of the range was the obvious reading and it does not align two screens.
       * The range is total height minus what is visible, and two surfaces show
       * different amounts -- so at "half way along the range" the desk's top
       * line and the overlay's top line are different lines. What a viewer
       * means by aligned is that the same words are at the top.
       *
       * So the fraction addresses a point in the text itself, and each surface
       * scrolls to that point, clamped at its own end. Until the shorter one
       * runs out, both show the same first line.
       */
      element.scrollTop = Math.min(
        element.scrollHeight * Math.min(1, Math.max(0, progress)),
        overflow,
      );

      // How far one press moves, as a fraction of the whole text. It is a
      // property of this surface -- 82% of what this surface can show -- so it
      // is measured here and sent up to whatever draws the buttons.
      const step =
        element.scrollHeight > 0
          ? (element.clientHeight * STEP) / element.scrollHeight
          : 1;
      const screenfuls =
        element.clientHeight > 0
          ? 1 + Math.ceil(overflow / (element.clientHeight * STEP))
          : 1;

      /*
       * Only on a real change, compared field by field.
       *
       * This was `setExtent({ ... })` unconditionally, which is fine while the
       * state is a number and fatal once it is an object: a fresh object is
       * never `Object.is` to the last one, so every measurement re-rendered,
       * every re-render ran the ResizeObserver, and React tore the whole window
       * down with "maximum update depth exceeded". The operator saw Pulpitry go
       * blank the moment anything long went live.
       */
      setExtent((current) =>
        current.screenfuls === screenfuls && current.step === step
          ? current
          : { screenfuls, step },
      );
    };

    measure();

    // Fonts land after the first layout and a projector window can be moved to
    // a screen of another size, either of which changes where the bottom is.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [blocks, progress, style, theme]);

  useEffect(() => onExtent?.(extent), [extent, onExtent]);

  return (
    <div
      ref={box}
      // No scrollbar: this is a wall, and the operator is the scrollbar.
      className="flex max-h-full w-full flex-col gap-[0.4em] overflow-hidden"
    >
      {blocks.map((block, index) => (
        <p
          key={index}
          style={{
            ...style,
            fontFamily: fontStack(theme.fontFamily),
            fontWeight: block.bold ? 600 : 400,
            fontStyle: block.italic ? "italic" : "normal",
            textAlign: block.align,
            fontSize:
              block.level === "heading" && typeof style.fontSize === "string"
                ? `calc(${style.fontSize} * 1.4)`
                : style.fontSize,
          }}
        >
          {block.text}
        </p>
      ))}
    </div>
  );
}

/**
 * How much of the visible height one press moves.
 *
 * Not a whole screenful: an overlap of a couple of lines is what lets a reader
 * find their place again, and losing it is the thing that makes projected prose
 * unfollowable.
 */
const STEP = 0.82;

/** How far a body runs, and how far one press of the controls moves through it. */
export interface Extent {
  /** Presses needed to reach the end, counting the first screen as one. */
  screenfuls: number;
  /** What one press is worth, as a fraction of the whole text. */
  step: number;
}

/**
 * The smallest a wound body is set, as a fraction of the frame's width.
 *
 * Chosen to stay readable from the back of a hall rather than to make any
 * particular entry fit -- nothing about a lexicon article fits, which is why it
 * winds.
 */
const READABLE = 4.2;
