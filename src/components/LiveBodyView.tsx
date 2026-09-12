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
  itemHeading,
  itemText,
  layoutOf,
  type AudioState,
  type LiveBody,
  type MediaCommand,
  type SlideComponent,
  type TextBlock,
} from "../lib/projector";
import {
  fontStack,
  panelStyle,
  referenceStyle,
  textStyle,
  withAlpha,
  type ProjectorTheme,
} from "../lib/theme";
import { DesignedView } from "./DesignedView";
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
 * The box every arrangement is drawn into, and the thing the fit is measured
 * against.
 *
 * Every word of this is load-bearing, and each clause is a bug that happened.
 *
 * `flex-1 min-h-0` gives the box the frame's own height. Without it the box
 * hugs its contents, and `fitted` -- which asks whether scrollHeight exceeds
 * clientHeight -- gets the same number twice and reports "fits" at every size,
 * in both directions. That is how a five-point slide was clipped and a
 * one-sentence slide was set at the smallest size there is.
 *
 * `[&>*]:shrink-0` is the other half, and without it the first half lies. A
 * flex child in a column with `min-h-0` may shrink below its own contents, so
 * a row of cards compressed to 66px instead of overflowing: the box reported a
 * perfect fit while the text ran out of the panels. Nothing overflows the box
 * now, so what the box says is true.
 *
 * `safe center` rather than `center`, because centred content that overflows
 * spills from both ends and the clipped end is the top -- a slide a few pixels
 * too tall lost its heading rather than its last line.
 */
const FRAME =
  "flex w-full min-h-0 flex-1 flex-col [justify-content:safe_center] [&>*]:shrink-0";

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
  const composedBox = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(SLIDE_FLOOR);

  /*
   * As large as actually fits, measured rather than guessed.
   *
   * The size arrives as a guess from how many characters the slide holds, and
   * a character count cannot know the typeface, the box, or where the lines
   * break -- nor that a heading is set larger with a rule above it. Measured
   * on the real projector, a five-point slide wanted 431px in a frame with
   * 378, and the surplus was clipped: the last line and its reference went off
   * the bottom, on air, with nothing anywhere to say they had.
   *
   * The same measurement prose has always used. What it needed was a box with
   * a definite height -- `flex-1 min-h-0`, see FRAME -- because the question
   * it asks is whether scrollHeight exceeds clientHeight, and a box that hugs
   * its contents answers no at every size.
   */
  useLayoutEffect(() => {
    const element = composedBox.current;
    if (!element) return;

    const measure = () => {
      const chosen = fitted(element, style.fontSize, SLIDE_FLOOR);
      element.style.setProperty("--fit", `${chosen.toFixed(2)}cqw`);
      setFit((current) => (current === chosen ? current : chosen));
    };

    measure();

    /*
     * Again once the typeface has arrived.
     *
     * A font landing after the first measurement changes how tall the words
     * are, and the observer below would catch that only if it changed the box
     * -- which it does not, because the box is a fixed share of the frame. The
     * slide would keep a size chosen from the fallback's metrics.
     */
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
    // Keyed on the guess rather than on `style`, which is built fresh every
    // render: depending on the object re-ran this on every render including
    // the one `setFit` caused, and measuring while a measurement is being
    // applied gives a different answer each pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, theme, style.fontSize]);

  // Everything on the slide is a multiple of the fitted size, so shrinking to
  // fit takes the headings, the rules and the panels down with the words.
  const base = "var(--fit)";
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
    "--fit": `${fit.toFixed(2)}cqw`,
  } as CSSProperties;

  // Derived where the stored name is one this build no longer draws; see
  // `layoutOf`. A withdrawn layout must not silently become another one.
  const layout = layoutOf(body.layout, body.components);

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
  if (layout === "section" && title?.kind === "text") {
    const panel = panelStyle(theme);
    return (
      <div ref={composedBox} className={FRAME} style={frame}>
        {/*
          The heading stands on a field of colour rather than on the backdrop.
          One device, and the reason it is this one: a section marker is the
          slide with the least on it, so it is the slide that most looks
          unfinished when there is nothing but a line of type in the middle of
          a frame. A field gives the words something to sit on.

          The field is the panel colour, which is the accent's own tint, so it
          is the brand's and not a colour this file chose.
        */}
        <div
          className="w-full rounded-[0.1em] px-[0.7em] py-[0.55em]"
          style={{ backgroundColor: panel.fill }}
        >
          <Heading
            text={title.text}
            style={style}
            accent={accent}
            base={base}
            /*
             * Falls away as the heading gets longer.
             *
             * A flat 2.1 is right for "Fear" and ruinous for "Recognizing The
             * Difference Between Similar Patterns", which ran off the top of
             * the frame and off the bottom at once. The guessed size already
             * shrinks with the character count; multiplying it by a constant
             * undoes exactly that, so the multiplier has to fall too.
             */
            scale={sectionScale(title.text)}
          />
        </div>
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
  if (layout === "split") {
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
      /*
       * The words take two thirds and are set smaller than they would be
       * whole-frame.
       *
       * The size is guessed from how many characters the slide holds, and that
       * guess assumes the words have the frame. Given half of it they wrap
       * twice as often, and a three-point slide ran off the bottom -- the
       * heading's own rule clipped away above the top edge.
       */
      const column = `calc(${base} * 0.88)`;
      return (
        <div ref={composedBox} className={`${FRAME} gap-[0.5em]`} style={frame}>
          {title?.kind === "text" ? (
            <Heading text={title.text} style={style} accent={accent} base={column} scale={1.35} />
          ) : null}
          <div className="flex w-full items-center gap-[1.2em]">
            <div className="flex min-w-0 flex-[1.35] flex-col gap-[0.45em]">
              {beside.map((component, index) => (
                <Component
                  key={index}
                  component={component}
                  style={style}
                  theme={theme}
                  base={column}
                  ranged
                />
              ))}
            </div>
            {/*
              Fitted, never cropped, and given no device of its own.

              A block behind it was tried, on the reasoning that a fitted
              picture floats. It does not: a church's pictures are the graphics
              it already made and they arrive with their own background, so
              there was nothing to place them against and an offset rectangle
              behind one reads as a misprint rather than as a decision.

              Cropping was tried before that and cut the words off the top of
              the graphic. Both are the same mistake -- treating these as
              photographs, which they are not.
            */}
            <img
              src={convertFileSrc(figure.source.path)}
              alt=""
              className="max-h-[66cqh] min-w-0 flex-1 self-center rounded-[0.12em] object-contain"
            />
          </div>
        </div>
      );
    }

    const table = rest.find((component) => component.kind === "table");
    const after = rest.filter((component) => component !== table);
    if (table?.kind === "table") {
      return (
        <div ref={composedBox} className={`${FRAME} gap-[0.5em]`} style={frame}>
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
  if (layout === "single") {
    return (
      <div ref={composedBox} className={`${FRAME} gap-[0.5em]`} style={frame}>
        {body.components.map((component, index) => (
          <Component key={index} component={component} style={style} theme={theme} base={base} />
        ))}
      </div>
    );
  }

  /*
   * A heading, and the points as panels.
   *
   * The same stack as below with one thing changed, so it stays one
   * arrangement rather than two that must be kept in step.
   */
  if (layout === "cards") {
    return (
      <div ref={composedBox} className={`${FRAME} gap-[0.7em]`} style={frame}>
        {title?.kind === "text" ? (
          <Heading text={title.text} style={style} accent={accent} base={base} scale={1.35} />
        ) : null}
        {rest.map((component, index) => (
          <Component
            key={index}
            component={component}
            style={style}
            theme={theme}
            base={base}
            ranged
            asCards
          />
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
    <div ref={composedBox} className={`${FRAME} gap-[0.45em]`} style={frame}>
      {title?.kind === "text" ? (
        <Heading text={title.text} style={style} accent={accent} base={base} scale={1.35} />
      ) : null}
      {rest.map((component, index) => (
        <Component key={index} component={component} style={style} theme={theme} base={base} ranged />
      ))}
    </div>
  );
}

/**
 * How much larger than the body a section marker is set.
 *
 * Measured from the heading's own length, in the same spirit as the size guess
 * it multiplies. Deliberately coarse: this decides between "large" and "very
 * large", and a slide holding one line of type has room to be wrong by a step.
 */
function sectionScale(text: string): number {
  const length = text.trim().length;
  if (length <= 18) return 2.1;
  if (length <= 32) return 1.7;
  if (length <= 52) return 1.35;
  return 1.1;
}

/** The theme's accent, or the body colour where it sets none. */
function accentOf(theme: ProjectorTheme): string {
  return theme.referenceColor || theme.textColor;
}

function Component({
  component,
  style,
  theme,
  base: given,
  ranged = false,
  asCards = false,
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
   * Whether a list of headed points is drawn as panels.
   *
   * The layout's decision and not this component's. Cards were derived here
   * from "every point has a heading", which meant a slide could not be asked
   * for them and could not be refused them -- and the model now specifies the
   * arrangement, so the answer belongs where the arrangement is decided.
   */
  asCards?: boolean;
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

    case "list": {
      const headed = component.items.filter((item) => itemHeading(item)).length;

      /*
       * Cards, where the points have headings and there are few enough.
       *
       * A row of panels is what a designed deck does with three parallel
       * points, and a row of bullets is what a text dump does with them. The
       * difference is not decoration: a card gives each point its own region,
       * so three points read as three things rather than as a paragraph that
       * has been broken up.
       *
       * Four is the ceiling. Five panels across a 16:9 frame are columns too
       * narrow to hold a sentence, and the honest drawing of five points is a
       * list. Headings are required because a card of one sentence is a bullet
       * in a box, which is worse than a bullet.
       */
      if (asCards && headed === component.items.length && component.items.length <= 4) {
        const panel = panelStyle(theme);
        return (
          <div className="flex w-full items-stretch gap-[0.5em]">
            {component.items.map((item, index) => (
              <div
                key={index}
                className="flex flex-1 flex-col gap-[0.28em] rounded-[0.14em] p-[0.6em]"
                style={{ backgroundColor: panel.fill, color: panel.text }}
              >
                {component.ordered ? (
                  <span
                    className="tabular-nums"
                    style={{
                      ...style,
                      color: accentOf(theme),
                      fontSize: `calc(${base} * 0.62)`,
                      fontWeight: 700,
                    }}
                  >
                    {index + 1}
                  </span>
                ) : null}
                <h3
                  style={{
                    ...style,
                    color: accentOf(theme),
                    fontSize: `calc(${base} * 0.8)`,
                    fontWeight: 700,
                    lineHeight: 1.18,
                  }}
                >
                  {itemHeading(item)}
                </h3>
                <p
                  style={{
                    ...style,
                    color: panel.text,
                    fontSize: `calc(${base} * 0.66)`,
                    lineHeight: 1.3,
                  }}
                >
                  {itemText(item)}
                </p>
              </div>
            ))}
          </div>
        );
      }

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
                style={{ color: accentOf(theme) }}
              >
                {component.ordered ? `${index + 1}.` : "\u00b7"}
              </span>
              <span>
                {itemHeading(item) ? (
                  <strong className="font-semibold">{itemHeading(item)}: </strong>
                ) : null}
                {itemText(item)}
              </span>
            </li>
          ))}
        </ol>
      );
    }

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

    case "chart": {
      /*
       * Bars, drawn in CSS rather than on a canvas.
       *
       * A church chart has two to six figures in it. That is a row of divs
       * with heights in per cent -- no library, no canvas, no second way for
       * the type to be sized, and it scales with the slide like everything
       * else because its height is in the same units.
       *
       * The figure is printed above its bar. A bar chart read from the back of
       * a room communicates the *shape* -- up, down, flat -- and the number is
       * what somebody actually wants; making them estimate it off an axis they
       * cannot read is the worst of both.
       */
      const largest = Math.max(...component.bars.map((bar) => bar.value), 1);
      return (
        <figure className="flex w-full flex-col gap-[0.35em]">
          {component.label ? (
            <figcaption
              className={ranged ? "text-left" : "text-center"}
              style={{
                ...style,
                color: accentOf(theme),
                fontSize: `calc(${base} * 0.62)`,
                fontWeight: 600,
              }}
            >
              {component.label}
            </figcaption>
          ) : null}
          <div className="flex w-full items-end gap-[0.5em]" style={{ height: `calc(${base} * 4)` }}>
            {component.bars.map((bar, index) => (
              <div key={index} className="flex h-full flex-1 flex-col gap-[0.2em]">
                <span
                  className="text-center tabular-nums"
                  style={{ ...style, fontSize: `calc(${base} * 0.55)`, fontWeight: 600 }}
                >
                  {bar.value.toLocaleString()}
                </span>
                {/*
                  The bar's own plot area, and it has to be its own box.
                  A percentage height resolves against the whole column, so with
                  the labels taking their share every bar wanted more room than
                  was left and flex shrank them all to the same height -- four
                  identical bars over four different figures, which is a chart
                  that lies about the only thing a chart is for.
                */}
                <div className="flex min-h-0 flex-1 items-end">
                  <div
                    className="w-full rounded-t-[0.06em]"
                    style={{
                      backgroundColor: accentOf(theme),
                      // A floor, so a small figure beside a large one is still
                      // a bar rather than a line nobody can see.
                      height: `${Math.max(4, (bar.value / largest) * 100)}%`,
                    }}
                  />
                </div>
                <span
                  className="text-center opacity-70"
                  style={{ ...style, fontSize: `calc(${base} * 0.5)` }}
                >
                  {bar.label}
                </span>
              </div>
            ))}
          </div>
        </figure>
      );
    }

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

    /*
     * Laid out by hand, so nothing here decides anything.
     *
     * It ignores `style` deliberately: every other kind is sized by how much
     * text there is, and on a designed slide the size is the design. The box
     * it draws into is the whole frame, which `fillsFrame` is what arranges.
     */
    case "designed":
      return <DesignedView elements={body.elements} theme={theme} />;

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

    /*
     * Filled to the frame, or fitted whole inside it.
     *
     * `h-full w-full object-cover` rather than `max-*`: a picture that fills
     * has to be *given* the frame, and a maximum only ever stops it being
     * larger. The frame drops its own padding for this, see `fillsFrame` --
     * without that the picture stops short of every edge and reads as a
     * border somebody forgot to remove.
     */
    case "image":
      return (
        <img
          src={convertFileSrc(body.path)}
          alt=""
          className={
            body.fill
              ? "h-full w-full object-cover"
              : "max-h-full max-w-full object-contain"
          }
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
          className={
            body.fill
              ? "h-full w-full object-cover"
              : "max-h-full max-w-full object-contain"
          }
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
function fitted(
  element: HTMLElement,
  guessed: CSSProperties["fontSize"],
  /**
   * How small this may be set before it stops shrinking.
   *
   * READABLE for prose, which nobody promised would fit: below that it cannot
   * be read from the back of a room, so it stays legible and is wound instead.
   * A slide has no winding. Its only alternative to shrinking is losing its
   * last line off the bottom, so it may go smaller.
   */
  floor = READABLE,
): number {
  const guess =
    typeof guessed === "string" ? Number.parseFloat(guessed) : Number.NaN;
  if (!Number.isFinite(guess) || guess <= floor) return floor;

  const apply = (value: number) =>
    element.style.setProperty("--fit", `${value.toFixed(2)}cqw`);
  const fits = () => element.scrollHeight <= element.clientHeight + 0.5;

  // If it will not fit even set small, it is one of the long ones: leave it at
  // the floor and let the winding below do its job.
  apply(floor);
  if (!fits()) return floor;

  let low = floor;
  let high = guess;
  let best = floor;
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
  return Math.max(floor, Math.floor(best / FIT_STEP) * FIT_STEP);
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

/**
 * How small a composed slide may be set before it stops shrinking.
 *
 * Lower than READABLE and deliberately so: prose that will not fit is wound,
 * and a slide has nothing to wind. The same as the smallest size the
 * length-based guess produces, so nothing here is smaller than something
 * already going on a wall.
 */
const SLIDE_FLOOR = 2.4;

