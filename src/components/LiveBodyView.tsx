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
  type SlideComponent,
  type TextBlock,
} from "../lib/projector";
import {
  fontStack,
  referenceStyle,
  textStyle,
  withAlpha,
  type ProjectorTheme,
} from "../lib/theme";
import { VideoSurface } from "./VideoSurface";

/**
 * A slide made of components.
 *
 * Everything is sized from the one style the rest of the frame uses, so a
 * composed slide sits at the same scale as a verse and inherits the fitting
 * that keeps it inside the frame. Sizes here are multiples of that, not
 * independent choices -- a table that picked its own size would be the one
 * thing on the wall that did not match.
 */
/**
 * The box every arrangement is drawn into.
 *
 * A plain column, as it was before there were arrangements. It neither clips
 * nor caps its own height: the frame around it already does both, and a second
 * box trying to do it as well is how a slide lost everything below its first
 * line -- the words were there, drawn, and hidden by their own container.
 *
 * Sized from the length-based guess, like every other kind of body. It is a
 * guess and it is sometimes wrong -- a slide whose heading and rule push it a
 * line past the frame loses that line -- but measuring properly means changing
 * how every surface sizes text, which is the display-parity work and not this.
 */
const FRAME = "flex w-full flex-col";

/**
 * A heading, ranged left under a hanging rule.
 *
 * Shared by the two layouts that have one so they cannot drift: the rule is
 * what ties a heading to what sits beneath it, and a heading centred over
 * left-ranged content points at nothing.
 */
function Heading({
  text,
  style,
  accent,
  base,
  scale,
}: {
  text: string;
  style: CSSProperties;
  accent: string;
  base: string;
  scale: number;
}) {
  return (
    <div className="flex w-full flex-col gap-[0.2em]">
      <span
        aria-hidden
        className="rounded-full"
        style={{
          backgroundColor: accent,
          height: `calc(${base} * 0.07)`,
          width: `calc(${base} * ${scale * 1.2})`,
        }}
      />
      <h2
        className="w-full text-left text-balance"
        style={{
          ...style,
          fontSize: `calc(${base} * ${scale})`,
          fontWeight: 700,
          lineHeight: 1.12,
          letterSpacing: "-0.012em",
        }}
      >
        {text}
      </h2>
    </div>
  );
}

/**
 * A slide made of components, arranged as its layout says.
 *
 * Everything is sized from the one style the rest of the frame uses, so a
 * composed slide sits at the same scale as a verse and inherits the fitting
 * that keeps it inside the frame. Sizes here are multiples of that, not
 * independent choices -- a table that picked its own size would be the one
 * thing on the wall that did not match.
 */
function Composed({
  body,
  style,
  theme,
}: {
  body: Extract<LiveBody, { kind: "composed" }>;
  style: CSSProperties;
  theme: ProjectorTheme;
}) {
  // The one size everything on the slide is a multiple of, so a heading and a
  // table hold their relationship at whatever size the slide is set.
  const base = typeof style.fontSize === "string" ? style.fontSize : "4cqw";
  const accent = theme.referenceColor || theme.textColor;
  /*
   * The frame carries the slide's own size, so the `em` spacing below is a
   * fraction of the type rather than of an inherited default.
   *
   * Without it every gap resolved against 16px and stayed 16px, so the space
   * between a heading and its list was the same on a phone-sized preview and
   * on a wall -- which is to say it vanished on the wall.
   */
  const frame = {
    fontFamily: fontStack(theme.fontFamily),
    color: theme.textColor,
    fontSize: base,
  } as CSSProperties;

  const title = body.components.find(
    (component) => component.kind === "text" && component.level === "title",
  );
  const rest = body.components.filter((component) => component !== title);

  /*
   * A movement of the sermon begins.
   *
   * Set as large as the frame allows, because this slide has one job and a
   * whole wall to do it with. Drawn at body size in the middle of an empty
   * frame, it looked like a slide that had failed to load -- which is what
   * "those slides with just a title show as broken" was.
   */
  if (body.layout === "section" && title?.kind === "text") {
    return (
      <div className={FRAME} style={frame}>
        <Heading text={title.text} style={style} accent={accent} base={base} scale={2.1} />
      </div>
    );
  }

  /*
   * A comparison, as the two columns it already is.
   *
   * A ruled grid is right on a lower third, where the card is short and wide
   * and rules are how rows stay apart. On a wall it reads as a spreadsheet:
   * what a congregation needs is the two things beside each other, each under
   * its own heading, with air between them.
   */
  if (body.layout === "split") {
    /*
     * A picture in its own panel, with the words beside it.
     *
     * Never behind them. A church's pictures carry their own words -- they are
     * the graphics it already made -- and body text laid over those is two
     * headlines arguing. A panel gives the picture a place to be a picture.
     */
    const figure = rest.find((component) => component.kind === "figure");
    if (figure?.kind === "figure") {
      const beside = rest.filter((component) => component !== figure);
      return (
        <div className="flex w-full flex-col gap-[0.5em]" style={frame}>
          {title?.kind === "text" ? (
            <Heading text={title.text} style={style} accent={accent} base={base} scale={1.3} />
          ) : null}
          <div className="flex w-full items-center gap-[1.1em]">
            <div className="flex min-w-0 flex-[1.15] flex-col gap-[0.45em]">
              {beside.map((component, index) => (
                <Component
                  key={index}
                  component={component}
                  style={style}
                  theme={theme}
                  base={base}
                  ranged
                />
              ))}
            </div>
            {/* Cropped to a panel rather than fitted, so two slides with
                differently shaped pictures still look like one deck. */}
            <img
              src={convertFileSrc(figure.source.path)}
              alt=""
              className="h-[42cqh] flex-1 rounded-[0.12em] object-cover"
            />
          </div>
        </div>
      );
    }

    const table = rest.find((component) => component.kind === "table");
    const after = rest.filter((component) => component !== table);
    if (table?.kind === "table") {
      return (
        <div className={`${FRAME} gap-[0.5em]`} style={frame}>
          {title?.kind === "text" ? (
            <Heading text={title.text} style={style} accent={accent} base={base} scale={1.3} />
          ) : null}
          <div className="flex w-full items-stretch gap-[1.1em]">
            {table.header.map((head, column) => (
              <div key={column} className="flex flex-1 flex-col gap-[0.35em]">
                <h3
                  className="text-left"
                  style={{
                    ...style,
                    color: accent,
                    fontSize: `calc(${base} * 0.95)`,
                    fontWeight: 700,
                    lineHeight: 1.2,
                  }}
                >
                  {head}
                </h3>
                <span
                  aria-hidden
                  className="w-full"
                  style={{
                    backgroundColor: withAlpha(accent, 0.5),
                    height: `calc(${base} * 0.035)`,
                  }}
                />
                <ul className="flex flex-col gap-[0.5em]">
                  {table.rows.map((row, at) => (
                    <li
                      key={at}
                      className="text-left"
                      style={{ ...style, fontSize: `calc(${base} * 0.88)`, lineHeight: 1.3 }}
                    >
                      {row[column] ?? ""}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {after.map((component, index) => (
            <Component key={index} component={component} style={style} theme={theme} base={base} ranged />
          ))}
        </div>
      );
    }
  }

  /*
   * One thing, given the frame.
   *
   * Centred, because there is nothing for it to align with: the hanging rule
   * exists to tie a heading to what sits under it, and here there is neither.
   */
  if (body.layout === "single") {
    return (
      <div className={`${FRAME} gap-[0.5em]`} style={frame}>
        {body.components.map((component, index) => (
          <Component key={index} component={component} style={style} theme={theme} base={base} />
        ))}
      </div>
    );
  }

  /*
   * A heading and what sits beneath it.
   *
   * Ranged left under a hanging rule rather than centred. Centring was the one
   * relationship every slide had, and it is what made a heading over three
   * points read as a paragraph somebody had broken up: a centred list has a
   * ragged left edge, and parallel points stop looking parallel.
   */
  return (
    <div className={`${FRAME} gap-[0.45em]`} style={frame}>
      {title?.kind === "text" ? (
        <Heading text={title.text} style={style} accent={accent} base={base} scale={1.35} />
      ) : null}
      {rest.map((component, index) => (
        <Component key={index} component={component} style={style} theme={theme} base={base} ranged />
      ))}
    </div>
  );
}

function Component({
  component,
  style,
  theme,
  base: given,
  ranged = false,
}: {
  component: SlideComponent;
  style: CSSProperties;
  theme: ProjectorTheme;
  /**
   * The size everything on this slide is a multiple of.
   *
   * Passed in rather than read off `style`, and that distinction was the whole
   * bug: this read the *guessed* size, so shrinking the slide to fit changed
   * the container's variable and not one word inside it. The box never got
   * shorter, the search concluded nothing fit, and the slide was drawn at the
   * guess and clipped -- while the number said it had been fitted.
   */
  base?: string;
  /**
   * Whether this sits under a left-ranged heading.
   *
   * A list or a table centred beneath a left-ranged title floats free of it,
   * and the hanging rule above the title then points at nothing. Alignment is
   * the layout's decision, so the layout passes it down.
   */
  ranged?: boolean;
}) {
  // The one size everything else is a multiple of.
  const base =
    given ?? (typeof style.fontSize === "string" ? style.fontSize : "4cqw");

  switch (component.kind) {
    case "text":
      return (
        <p
          className={`w-full text-balance ${
            ranged || component.level === "body" ? "text-left" : "text-center"
          }`}
          style={{
            ...style,
            fontSize:
              component.level === "title"
                ? `calc(${base} * 1.35)`
                : component.level === "statement"
                  ? `calc(${base} * 1.1)`
                  : base,
            fontWeight: component.level === "body" ? 400 : 600,
            lineHeight: 1.25,
          }}
        >
          {component.text}
        </p>
      );

    case "list":
      /* Ranged left, not centred. A centred list has a ragged left edge, which
         is the one thing that makes parallel points stop looking parallel. */
      return (
        <ol
          className={`flex w-fit max-w-full flex-col gap-[0.3em] text-left ${
            ranged ? "" : "mx-auto"
          }`}
          style={{ ...style, fontSize: base, lineHeight: 1.3 }}
        >
          {component.items.map((item, index) => (
            <li key={index} className="flex gap-[0.5em]">
              <span
                aria-hidden={!component.ordered}
                className="shrink-0 tabular-nums opacity-70"
                style={{ color: theme.referenceColor || theme.textColor }}
              >
                {component.ordered ? `${index + 1}.` : "·"}
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      );

    case "table":
      /* Hairlines in the text's own colour at low opacity rather than a border
         colour of its own: a table on a projector is read from the back, and
         rules heavy enough to see up close become a grid that fights the words
         at distance. */
      return (
        <table
          className={`w-fit max-w-full border-collapse text-left ${ranged ? "" : "mx-auto"}`}
          style={{ ...style, fontSize: `calc(${base} * 0.82)`, lineHeight: 1.3 }}
        >
          {component.header.length > 0 ? (
            <thead>
              <tr>
                {component.header.map((cell, index) => (
                  <th
                    key={index}
                    scope="col"
                    className="px-[0.6em] pb-[0.28em] font-semibold"
                    style={{ borderBottom: `0.06em solid ${withAlpha(theme.textColor, 0.45)}` }}
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {component.rows.map((row, at) => (
              <tr key={at}>
                {row.map((cell, index) => (
                  <td
                    key={index}
                    className="px-[0.6em] py-[0.26em] tabular-nums"
                    style={{
                      borderBottom:
                        at < component.rows.length - 1
                          ? `0.03em solid ${withAlpha(theme.textColor, 0.18)}`
                          : "none",
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );

    case "quote":
      return (
        <figure className="mx-auto flex w-full max-w-[80%] flex-col gap-[0.35em]">
          <blockquote
            className="text-balance text-center italic"
            style={{ ...style, fontSize: `calc(${base} * 1.05)`, lineHeight: 1.3 }}
          >
            {component.text}
          </blockquote>
          {component.attribution ? (
            <figcaption
              className="text-center not-italic opacity-70"
              style={{ ...style, fontSize: `calc(${base} * 0.6)` }}
            >
              — {component.attribution}
            </figcaption>
          ) : null}
        </figure>
      );

    case "figure":
      /* Fitted, never cropped, when it is a component among others -- a
         photograph cropped to fill a slot loses whatever was the point of it.
         The Backed arrangement crops deliberately, and does it itself. */
      return (
        <figure className="flex w-full flex-col items-center gap-[0.3em]">
          <img
            src={convertFileSrc(component.source.path)}
            alt=""
            className="max-h-full max-w-full object-contain"
          />
          {component.caption ? (
            <figcaption
              className="text-center opacity-70"
              style={{ ...style, fontSize: `calc(${base} * 0.55)` }}
            >
              {component.caption}
            </figcaption>
          ) : null}
        </figure>
      );

    case "passage":
      /* The reference only. The verse is staged from the library, which is the
         same rule the generator follows and the reason it never sends text. */
      return (
        <p
          className={`w-full tracking-wide ${ranged ? "text-left" : "text-center"}`}
          // Sized from the slide rather than from the theme's reference scale:
          // a line that keeps its size while everything around it shrinks is
          // the line that pushes the slide off the bottom of the frame.
          style={{ ...referenceStyle(theme), fontSize: `calc(${base} * 0.62)` }}
        >
          {component.reference}
        </p>
      );
  }
}

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
    case "composed":
      return <Composed body={body} style={style} theme={theme} />;

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
  /** The size the text was actually set at, once it had been fitted. */
  const [fit, setFit] = useState(READABLE);

  // After layout rather than after paint: the scroll position is set from the
  // same measurement, and a frame showing the top of a wound entry is a frame
  // the congregation sees.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;

    const measure = () => {
      /*
       * As large as fits, and only then wound.
       *
       * The size arrives here as a guess from the length of the text, and for
       * a short entry that guess is the *largest* setting -- under ninety
       * characters gets 7cqw, and a heading a further 1.4 times that. A brief
       * lexicon entry is short, so it was being set enormous, overflowing a
       * frame it would have fitted at any sane size, and the winding below
       * dutifully broke three lines of English across two screens. Small texts
       * paginated precisely because they were small.
       *
       * So shrink to fit first, no further than READABLE. Anything that fits
       * is one screenful and stays one; the several-hundred-word entries this
       * winding was built for still cannot fit at READABLE, and still wind.
       */
      const chosen = fitted(element, style.fontSize);
      element.style.setProperty("--fit", `${chosen.toFixed(2)}cqw`);
      setFit((current) => (current === chosen ? current : chosen));

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
      style={{ "--fit": `${fit.toFixed(2)}cqw` } as CSSProperties}
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
              block.level === "heading"
                ? "calc(var(--fit) * 1.4)"
                : "var(--fit)",
          }}
        >
          {block.text}
        </p>
      ))}
    </div>
  );
}

/** Coarse enough that two surfaces measuring the same words agree on a size. */
const FIT_STEP = 0.1;

/**
 * The largest size at which this text still fits its box, down to READABLE.
 *
 * Measured rather than guessed, because whether words fit depends on the
 * typeface, the box and where the lines break, and none of that is knowable
 * from a character count.
 *
 * The result is rounded down to a coarse step so that the desk and the wall --
 * the same layout at different sizes -- land on the same number rather than on
 * two that differ by a hair and by one whole line.
 */
function fitted(element: HTMLElement, guessed: CSSProperties["fontSize"]): number {
  const guess =
    typeof guessed === "string" ? Number.parseFloat(guessed) : Number.NaN;
  if (!Number.isFinite(guess) || guess <= READABLE) return READABLE;

  const apply = (value: number) =>
    element.style.setProperty("--fit", `${value.toFixed(2)}cqw`);
  const fits = () => element.scrollHeight <= element.clientHeight + 0.5;

  // If it will not fit even set small, it is one of the long ones: leave it at
  // READABLE and let the winding below do its job.
  apply(READABLE);
  if (!fits()) return READABLE;

  let low = READABLE;
  let high = guess;
  let best = READABLE;
  for (let i = 0; i < 10; i += 1) {
    const mid = (low + high) / 2;
    apply(mid);
    if (fits()) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }
  return Math.max(READABLE, Math.floor(best / FIT_STEP) * FIT_STEP);
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

