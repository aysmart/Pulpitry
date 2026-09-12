import { convertFileSrc } from "@tauri-apps/api/core";

import {
  CANVAS,
  cased,
  type ScriptureElement,
  type ShapeElement,
  type ShapeKind,
  type SlideElement,
  type TableElement,
  type Typeset,
} from "../lib/design";
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
}: {
  elements: SlideElement[];
  /** For anything an element chose to leave to the church's own look. */
  theme: ProjectorTheme;
  hide?: string | null;
}) {
  return (
    <div className="absolute inset-0">
      {elements
        .filter((element) => element.id !== hide)
        .map((element) => (
          <div key={element.id} className="absolute" style={boxStyle(element)}>
            <Drawn element={element} theme={theme} />
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
        background: element.fill,
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
}: {
  element: SlideElement;
  theme: ProjectorTheme;
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
          {element.reference}
          {element.translation ? ` (${element.translation})` : ""}
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
