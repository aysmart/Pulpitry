import { useLayoutEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import {
  CANVAS,
  cased,
  type ScriptureElement,
  type ShapeElement,
  type ShapeKind,
  type SlideElement,
  type TableElement,
  type TextElement,
  type Typeset,
} from "../lib/design";
import { VerseRuns } from "./VerseRuns";
import {
  fontStack,
  referenceStyle,
  withAlpha,
  type ProjectorTheme,
} from "../lib/theme";

/**
 * A slide the operator laid out, drawn.
 *
 * # One renderer, every surface
 *
 * The wall, the Live pane, Preview, the page list in the editor, the cards in
 * the library and the editor's own canvas all render through here. That is not
 * tidiness: a design tool whose canvas disagrees with its output is worse than
 * no design tool, because the disagreement is only discovered in front of a
 * congregation.
 *
 * # How it scales
 *
 * Everything is expressed as a percentage of the frame — positions, sizes and
 * type — so the same numbers hold at any size. `cqw` for type because the box
 * is 16:9 by construction on every surface, so a fraction of its width is a
 * fixed fraction of its height too; a design at 1920 is therefore the same
 * design in a thumbnail 180px across.
 *
 * Callers give the box `container-type: size` and a 16:9 ratio. Everything
 * here is absolutely positioned inside it.
 */
export function DesignedView({
  elements,
  theme,
  /** Left undrawn, because the editor is drawing it as an editable box. */
  hide,
  uppercase = false,
}: {
  elements: SlideElement[];
  /** For anything an element chose to leave to the church's own look. */
  theme: ProjectorTheme;
  hide?: string | null;
  /**
   * This output's capitals switch, which is a fact about the screen rather
   * than about the design.
   *
   * A stream feeding a broadcast overlay is often set in capitals while the
   * hall's own projector is not, so it belongs to the output and overrides
   * what any one element asked for -- the same way it does for a slide, where
   * it is set once on the frame and everything inside it obeys. Taken as a
   * prop rather than inherited from an ancestor's style so the slot below can
   * measure again when it changes: capitals are wider, and words that fitted
   * in sentence case need not fit in capitals.
   */
  uppercase?: boolean;
}) {
  return (
    <div
      className="absolute inset-0"
      style={uppercase ? { textTransform: "uppercase" } : undefined}
    >
      {elements
        .filter((element) => element.id !== hide)
        .map((element) => (
          <div key={element.id} className="absolute" style={boxStyle(element)}>
            <Drawn element={element} theme={theme} uppercase={uppercase} />
          </div>
        ))}
    </div>
  );
}

/**
 * Where an element sits, as a share of the frame.
 *
 * Exported so the editor's own boxes — the selection outline, the drag target,
 * the field an operator types into — sit exactly where the drawn element does.
 * Computing that twice is how a design tool comes to disagree with its output
 * by a few pixels, which is the kind of fault nobody can see and everybody
 * fights.
 */
export function boxStyle(box: {
  x: number;
  y: number;
  w: number;
  h: number;
}): React.CSSProperties {
  return {
    left: `${(box.x / CANVAS.width) * 100}%`,
    top: `${(box.y / CANVAS.height) * 100}%`,
    width: `${(box.w / CANVAS.width) * 100}%`,
    height: `${(box.h / CANVAS.height) * 100}%`,
  };
}

/** Type, as a fraction of the frame rather than in pixels. */
export function typeStyle(
  element: Typeset,
  theme: ProjectorTheme,
): React.CSSProperties {
  const decoration = [
    element.underline ? "underline" : "",
    element.strike ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    // 100cqw is the frame's width, and sizes are authored against 1920.
    fontFamily: fontStack(element.font || theme.fontFamily),
    fontWeight: element.weight,
    fontSize: `${(element.size / CANVAS.width) * 100}cqw`,
    lineHeight: element.lineHeight,
    letterSpacing: element.letterSpacing
      ? `${(element.letterSpacing / CANVAS.width) * 100}cqw`
      : undefined,
    color: element.color,
    opacity: element.opacity / 100,
    textAlign: element.align,
    textDecorationLine: decoration || undefined,
    // The shadow is the theme's, because whether words on this church's wall
    // need lifting off their background is a fact about their room.
    textShadow: theme.shadow ? "0 0.06em 0.14em rgba(0,0,0,0.55)" : undefined,
  };
}

const PLACE: Record<Typeset["vertical"], string> = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
};

/**
 * The outline of a shape that is not a box.
 *
 * Clipped rather than drawn as SVG: the shape is one element with one fill, and
 * a clip path scales with the box on both axes without a viewBox to keep in
 * step. Percentages, so a star is a star at any size.
 */
const CLIP: Partial<Record<ShapeKind, string>> = {
  triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
  diamond: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
  chevron: "polygon(0% 0%, 60% 0%, 100% 50%, 60% 100%, 0% 100%, 40% 50%)",
  star:
    "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, " +
    "21% 91%, 32% 57%, 2% 35%, 39% 35%)",
};

function Shape({ element }: { element: ShapeElement }) {
  const radius =
    element.shape === "circle" || element.shape === "ellipse"
      ? "50%"
      : element.shape === "rounded" || element.shape === "line"
        ? `${(element.radius / CANVAS.width) * 100}cqw`
        : undefined;

  return (
    <div
      className="h-full w-full"
      style={{
        // Two stops where the fill is a gradient, which is how a scrim is
        // made: dark where the words are and nothing at the far end.
        background:
          element.fillKind === "gradient"
            ? `linear-gradient(${element.fillAngle ?? 0}deg, ${element.fill}, ${
                element.fillTo ?? "#00000000"
              })`
            : element.fill,
        opacity: element.opacity / 100,
        borderRadius: radius,
        clipPath: CLIP[element.shape],
      }}
    />
  );
}

/**
 * A table, with the wall's own hairlines.
 *
 * The sizes and rules are the ones `LiveBodyView` draws a composed table with,
 * for one reason: a generated comparison opened in the studio has to look like
 * the slide the operator already saw. Hairlines are the text's own colour at
 * low opacity rather than a border colour of their own — a rule heavy enough
 * to see up close becomes a grid that fights the words from the back of a room.
 */
function Table({
  element,
  theme,
  style,
}: {
  element: TableElement;
  theme: ProjectorTheme;
  style: React.CSSProperties;
}) {
  const hairline = withAlpha(theme.textColor, 0.45);
  const between = withAlpha(theme.textColor, 0.18);
  const heads = element.header.filter((cell) => cell.trim().length > 0);

  return (
    <table
      className="w-full border-collapse"
      style={{ ...style, textAlign: element.align }}
    >
      {heads.length > 0 ? (
        <thead>
          <tr>
            {element.header.map((cell, index) => (
              <th
                key={index}
                scope="col"
                className="px-[0.6em] pb-[0.28em] font-semibold"
                style={{
                  borderBottom: `0.06em solid ${hairline}`,
                  textAlign: element.align,
                }}
              >
                {cased(cell, element.textCase)}
              </th>
            ))}
          </tr>
        </thead>
      ) : null}
      <tbody>
        {element.rows.map((row, at) => (
          <tr key={at}>
            {row.map((cell, index) => (
              <td
                key={index}
                className="px-[0.6em] py-[0.26em] tabular-nums"
                style={{
                  borderBottom:
                    at < element.rows.length - 1
                      ? `0.03em solid ${between}`
                      : "none",
                  textAlign: element.align,
                }}
              >
                {cased(cell, element.textCase)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Drawn({
  element,
  theme,
  uppercase,
}: {
  element: SlideElement;
  theme: ProjectorTheme;
  /** Passed on only so a slot can re-measure when it changes; see above. */
  uppercase?: boolean;
}) {
  if (element.kind === "shape") return <Shape element={element} />;

  if (element.kind === "image") {
    return (
      <img
        src={convertFileSrc(element.path)}
        alt=""
        className="h-full w-full"
        style={{
          objectFit: element.fit,
          opacity: element.opacity / 100,
          borderRadius: `${(element.radius / CANVAS.width) * 100}cqw`,
        }}
      />
    );
  }

  // A hole the service drops words into, rather than words somebody typed and
  // could see: it is sized to the box instead of the box to it.
  if (element.kind === "text" && element.slot) {
    return <SlotText element={element} theme={theme} uppercase={uppercase} />;
  }

  const style = typeStyle(element, theme);

  return (
    <div
      className="flex h-full w-full flex-col"
      style={{ justifyContent: PLACE[element.vertical] }}
    >
      {element.kind === "table" ? (
        <Table element={element} theme={theme} style={style} />
      ) : element.kind === "scripture" ? (
        <Scripture element={element} theme={theme} style={style} />
      ) : (
        /*
         * Line breaks are the operator's.
         *
         * `pre-wrap` rather than reflowing: somebody who pressed Return in the
         * middle of a title meant the line to break there, and a slide that
         * rewraps it has overruled a layout decision on a wall.
         */
        <p className="whitespace-pre-wrap" style={style}>
          {cased(element.text, element.textCase)}
        </p>
      )}
    </div>
  );
}

/**
 * How small a slot's words may be set before the box wins and clips.
 *
 * A share of the size the shape was drawn at rather than a fixed number: a
 * caption designed at 30 and a lower third designed at 68 are different
 * decisions about how this church's screen reads, and shrinking both to the
 * same floor would throw one of them away. A quarter is far enough to take a
 * whole psalm into a band built for one line, and near enough the drawn size
 * that what is on the wall is still recognisably the shape somebody made.
 */
const SLOT_FLOOR = 0.25;

/**
 * A slot's words, set as large as its box will hold.
 *
 * # Why this one is measured and the rest are not
 *
 * Every other element in a design was typed by the person who drew it, in front
 * of the box it sits in: if it is too big they can see that and make it
 * smaller, and quietly resizing what they chose would be overruling them.
 *
 * A slot is the opposite. Nobody has seen what goes in it -- it is whatever is
 * live at that moment, one line of a chorus or the whole of Genesis 1:26 -- and
 * the size in the file is the designer's wish for the short case. Left alone it
 * spills out of the band, over the camera, off the bottom of the frame, and the
 * words a congregation is reading are the ones lost at the edge.
 *
 * So the box is fixed and the type gives way: the largest size that fits, found
 * by measuring, because whether words fit depends on the typeface, the width
 * and where the lines break, and none of that can be counted from characters.
 *
 * # Why it is binary search and not a loop that steps down
 *
 * Each try costs a layout. Ten tries land within a thousandth of the answer
 * whatever the range, where stepping down by a point can take fifty for a long
 * verse in a small band -- at which point a wall full of words takes a visible
 * moment to settle.
 */
function SlotText({
  element,
  theme,
  uppercase,
}: {
  element: TextElement;
  theme: ProjectorTheme;
  uppercase?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLParagraphElement>(null);
  const text = cased(element.text, element.textCase);
  /*
   * The verses, where a passage was dropped into this hole.
   *
   * Absent for a citation, for a chorus and for the placeholder an operator
   * sees while drawing the shape -- all of which are one run of words with
   * nothing to raise. The case is applied to each run rather than to the
   * joined string, so a shape set in capitals still capitalises exactly what
   * it did before.
   */
  const runs = element.runs?.map((run) => ({
    ...run,
    text: cased(run.text, element.textCase),
  }));
  // Authored in the 1920-wide frame, drawn as a share of whatever the frame
  // happens to be: the same arithmetic as `typeStyle`, held here because this
  // one is searched over rather than set once.
  const drawn = (element.size / CANVAS.width) * 100;

  useLayoutEffect(() => {
    const node = box.current;
    const line = words.current;
    if (!node || !line) return;

    const apply = (size: number) =>
      node.style.setProperty("--slot", `${size.toFixed(3)}cqw`);
    /*
     * The words' own height against the hole's, and not `scrollHeight`.
     *
     * A flex column only scrolls downwards: words ranged to the bottom of their
     * box overflow off the *top*, where `scrollHeight` cannot see them and
     * reports a perfect fit while a verse runs up over the camera. Every
     * citation slot is ranged to the bottom, so that is not a corner case.
     *
     * Half a pixel of slack: a box and its contents can round apart, and
     * shrinking a line that already fits is worse than the rounding.
     */
    const fits = () =>
      line.getBoundingClientRect().height <= node.clientHeight + 0.5;

    const fit = () => {
      apply(drawn);
      if (fits()) return;

      const floor = drawn * SLOT_FLOOR;
      let low = floor;
      let high = drawn;
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
      apply(best);
    };

    fit();

    // The same design is drawn at a dozen sizes -- a thumbnail, a preview pane,
    // a wall -- and `cqw` keeps the proportions but not the line breaks, which
    // depend on the real width. So it is measured again whenever the box
    // changes size, not only when the words change.
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    drawn,
    text,
    // Capitals are wider and taller: the same words that fitted in sentence
    // case can need another line in capitals, and the switch changes the
    // drawing without changing a character of the text.
    uppercase,
    element.font,
    element.lineHeight,
    element.letterSpacing,
    element.weight,
    theme.fontFamily,
  ]);

  return (
    <div
      ref={box}
      // Clipped, because the floor is a floor: a reading long enough to defeat
      // even the smallest size stops at the edge of the band it was given
      // rather than running across a camera shot.
      className="flex h-full w-full flex-col overflow-hidden"
      style={{
        justifyContent: PLACE[element.vertical],
        // The fallback is what it was drawn at, so the first paint is the
        // designer's size and the measurement only ever takes it down.
        ["--slot" as string]: `${drawn.toFixed(3)}cqw`,
      }}
    >
      <p
        ref={words}
        // `anywhere` as well as the operator's own breaks: a single unbroken
        // word longer than the box -- a hyphenated compound, a URL in a notice
        // -- has nowhere to wrap and would run out of the side of the band
        // however small the type were set.
        className="whitespace-pre-wrap [overflow-wrap:anywhere]"
        style={{ ...typeStyle(element, theme), fontSize: "var(--slot)" }}
      >
        {runs ? <VerseRuns runs={runs} /> : text}
      </p>
    </div>
  );
}

function Scripture({
  element,
  theme,
  style,
}: {
  element: ScriptureElement;
  theme: ProjectorTheme;
  style: React.CSSProperties;
}) {
  // Nothing resolved yet: the reference alone, so an unfinished slide reads as
  // unfinished rather than as an empty box.
  const lines = element.lines.length > 0 ? element.lines : [];

  return (
    <>
      {lines.length > 0 ? (
        <p className="whitespace-pre-wrap" style={style}>
          {cased(lines.join(" "), element.textCase)}
        </p>
      ) : null}

      {element.showReference && element.reference ? (
        <p
          className={`tracking-wide ${lines.length > 0 ? "mt-[1.5cqw] opacity-70" : ""}`}
          style={{
            ...referenceStyle(theme),
            /*
             * A citation under a verse, or the content itself.
             *
             * With words above it this is a reference and is set small against
             * them. With nothing above it the reference *is* the slide -- which
             * is how the engine draws a `passage` component, and how one
             * arrives here when a generated slide is promoted -- so it takes
             * the element's own size rather than a fraction of it.
             */
            fontSize: `${((element.size * (lines.length > 0 ? 0.42 : 1)) / CANVAS.width) * 100}cqw`,
            color: lines.length > 0 ? undefined : element.color,
            textAlign: element.align,
          }}
        >
          {/*
            The reference exactly as the library composed it.

            It already names the translation -- "John 1:1 (KJV)" -- and in that
            translation's own language for the book, which is the whole reason
            the label is built there rather than assembled at this end. Adding
            the translation here as well produced "John 1:1 (KJV) (KJV)".

            `element.translation` is kept as a record of which Bible the words
            came from, and is not drawn.
          */}
          {element.reference}
        </p>
      ) : null}
    </>
  );
}

/** Whether a slide has anything an operator would call content. */
export function hasContent(elements: SlideElement[]): boolean {
  return elements.some((element) => {
    switch (element.kind) {
      case "text":
        return element.text.trim().length > 0;
      case "scripture":
        return element.lines.length > 0 || element.reference.trim().length > 0;
      case "table":
        return [element.header, ...element.rows]
          .flat()
          .some((cell) => cell.trim().length > 0);
      // A picture or a shape is content the moment it is placed.
      default:
        return true;
    }
  });
}
