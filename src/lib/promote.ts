import type { SongSection } from "./catalog";
import {
  CANVAS,
  newImage,
  newScripture,
  newTable,
  newText,
  type SlideElement,
  type TextElement,
  type Typeset,
} from "./design";
import {
  componentText,
  itemHeading,
  itemText,
  layoutOf,
  type SlideComponent,
  type SlideLayout,
} from "./projector";
import {
  baseSize,
  panelStyle,
  withColourAlpha,
  type ProjectorTheme,
} from "./theme";

/**
 * Turning an arranged slide into a laid-out one, as it was already drawn.
 *
 * # The problem this solves
 *
 * Pulpitry has two kinds of slide and they are made in opposite ways. A
 * generated sermon deck is **components**: a title, some points, a table — and
 * `LiveBodyView` arranges them, sizing everything from one measured base so it
 * fits whatever frame it lands in. A deck made in the studio is **elements**:
 * positions and sizes the operator chose.
 *
 * Opening the first kind in the studio has to produce the second kind. The
 * naive conversion — stack every line at a fixed size — was honest but wrong
 * in the way that matters: the operator pressed Edit on a slide they had seen
 * on the wall and got a different slide. Nothing about the deck had changed,
 * so the studio looked broken and the arrangement looked lost.
 *
 * So this reproduces what the engine drew: the hanging rule above a heading,
 * the panel behind a section marker, the cards, the two-column split, the
 * table's hairlines, the sizes as the same multiples of the same base. What
 * comes back is editable — every piece is its own element — and it starts where
 * the slide already was.
 *
 * # Where it is necessarily approximate
 *
 * The engine's base size is *measured*: it renders, asks whether the content
 * overflowed, and shrinks until it fits. Nothing here can measure, because
 * this runs before anything is on screen. So the size is the same first guess
 * the engine starts from, brought down by an estimate of how tall the result
 * will be — close, and never clipped, because a text element's box does not
 * clip what it holds.
 *
 * That inexactness costs nothing after the first moment: from the instant a
 * slide is promoted it is drawn by `DesignedView` on every surface, so the
 * studio and the wall agree exactly, whatever this function chose.
 */

/** One `cqw` of the canvas, in canvas units. The frame is 16:9 by construction. */
const CQW = CANVAS.width / 100;

/** The inset every surface draws text into: `px-[6cqw] py-[5cqh]`. */
const INSET_X = 6 * CQW;
const INSET_Y = 0.05 * CANVAS.height;

const WIDTH = CANVAS.width - INSET_X * 2;
const HEIGHT = CANVAS.height - INSET_Y * 2;

/** The engine's own floor, in canvas units: SLIDE_FLOOR of 2.4cqw. */
const FLOOR = 2.4 * CQW;

/**
 * How wide a character is, as a fraction of its size.
 *
 * A rough average across the bundled faces, used only to guess how many lines
 * a box will hold. Too small and a slide is promoted a step larger than the
 * engine drew it; too large and a step smaller. Either is a difference an
 * operator fixes by dragging, and neither can clip anything.
 */
const GLYPH = 0.52;

/** How tall a run of text will be once it wraps in a box this wide. */
function tall(
  text: string,
  size: number,
  lineHeight: number,
  width: number,
): number {
  const perLine = Math.max(1, Math.floor(width / (size * GLYPH)));
  // Authored breaks are kept by the renderer, so they are counted here.
  const lines = text
    .split("\n")
    .reduce(
      (running, line) =>
        running + Math.max(1, Math.ceil(line.trim().length / perLine)),
      0,
    );
  return Math.max(1, lines) * size * lineHeight;
}

interface Piece {
  elements: SlideElement[];
  height: number;
}

/** A text element, with only what makes it itself stated. */
function words(
  text: string,
  box: { x: number; y: number; w: number; h: number },
  over: Partial<Typeset>,
  theme: ProjectorTheme,
): TextElement {
  return {
    ...newText(text),
    ...box,
    ...over,
    color: over.color ?? theme.textColor,
  };
}

function accentOf(theme: ProjectorTheme): string {
  return theme.referenceColor || theme.textColor;
}

/**
 * A heading under its hanging rule, which is what ties it to what follows.
 *
 * Two elements, because they are two things on the slide and the operator is
 * entitled to move either. The proportions are `Heading`'s own: a rule
 * 0.07 of the base tall and `scale * 1.2` wide, a gap of 0.2, then the words
 * at `scale`, weight 700, leading 1.12.
 */
function heading(
  text: string,
  y: number,
  base: number,
  scale: number,
  theme: ProjectorTheme,
): Piece {
  const rule = base * 0.07;
  const gap = base * 0.2;
  const size = base * scale;
  const height = tall(text, size, 1.12, WIDTH);

  return {
    elements: [
      {
        kind: "shape",
        id: `rule-${y}`,
        shape: "line",
        fill: accentOf(theme),
        opacity: 100,
        radius: rule / 2,
        x: INSET_X,
        y,
        w: base * scale * 1.2,
        h: rule,
      },
      words(
        text,
        { x: INSET_X, y: y + rule + gap, w: WIDTH, h: height },
        {
          size,
          weight: 700,
          lineHeight: 1.12,
          letterSpacing: -0.012 * size,
          align: "left",
          vertical: "top",
        },
        theme,
      ),
    ],
    height: rule + gap + height,
  };
}

/** How much larger than the body a section marker is set. `sectionScale`. */
function sectionScale(text: string): number {
  const length = text.trim().length;
  if (length <= 18) return 2.1;
  if (length <= 32) return 1.7;
  if (length <= 52) return 1.35;
  return 1.1;
}

/** One component, as the elements the engine would have drawn for it. */
function piece(
  component: SlideComponent,
  y: number,
  base: number,
  width: number,
  x: number,
  theme: ProjectorTheme,
  ranged: boolean,
): Piece {
  switch (component.kind) {
    case "text": {
      const size =
        component.level === "title"
          ? base * 1.35
          : component.level === "statement"
            ? base * 1.1
            : base;
      const align =
        ranged || component.level === "body" ? "left" : ("center" as const);
      const height = tall(component.text, size, 1.25, width);
      return {
        elements: [
          words(
            component.text,
            { x, y, w: width, h: height },
            {
              size,
              weight: component.level === "body" ? 400 : 600,
              lineHeight: 1.25,
              align,
              vertical: "top",
            },
            theme,
          ),
        ],
        height,
      };
    }

    case "list": {
      const headed = component.items.filter((item) => itemHeading(item)).length;
      const asCards =
        headed === component.items.length && component.items.length <= 4;

      if (asCards) {
        /*
         * Cards: a panel per point, side by side.
         *
         * Each is four elements at most -- the panel, its number, its heading,
         * its words -- so an operator can restyle one card, or drag it out of
         * the row, which is exactly what a deck built by hand does with three
         * parallel points.
         */
        const panel = panelStyle(theme);
        const gap = base * 0.5;
        const pad = base * 0.6;
        const count = component.items.length;
        const each = (width - gap * (count - 1)) / count;
        const inner = each - pad * 2;

        const numberSize = base * 0.62;
        const headSize = base * 0.8;
        const textSize = base * 0.66;
        const rowGap = base * 0.28;

        let tallest = 0;
        const cards = component.items.map((item, index) => {
          const headHeight = tall(itemHeading(item), headSize, 1.18, inner);
          const bodyHeight = tall(itemText(item), textSize, 1.3, inner);
          const height =
            pad * 2 +
            headHeight +
            bodyHeight +
            rowGap +
            (component.ordered ? numberSize * 1.2 + rowGap : 0);
          tallest = Math.max(tallest, height);
          return { item, index, headHeight, bodyHeight, height };
        });

        const elements: SlideElement[] = [];
        for (const card of cards) {
          const left = x + (each + gap) * card.index;
          elements.push({
            kind: "shape",
            id: `card-${y}-${card.index}`,
            shape: "rounded",
            fill: panel.fill,
            opacity: 100,
            radius: base * 0.14,
            x: left,
            y,
            w: each,
            h: tallest,
          });

          let at = y + pad;
          if (component.ordered) {
            elements.push(
              words(
                `${card.index + 1}`,
                {
                  x: left + pad,
                  y: at,
                  w: inner,
                  h: numberSize * 1.2,
                },
                {
                  size: numberSize,
                  weight: 700,
                  align: "left",
                  vertical: "top",
                  color: accentOf(theme),
                },
                theme,
              ),
            );
            at += numberSize * 1.2 + rowGap;
          }

          elements.push(
            words(
              itemHeading(card.item),
              { x: left + pad, y: at, w: inner, h: card.headHeight },
              {
                size: headSize,
                weight: 700,
                lineHeight: 1.18,
                align: "left",
                vertical: "top",
                color: accentOf(theme),
              },
              theme,
            ),
          );
          at += card.headHeight + rowGap;

          elements.push(
            words(
              itemText(card.item),
              { x: left + pad, y: at, w: inner, h: card.bodyHeight },
              {
                size: textSize,
                lineHeight: 1.3,
                weight: 400,
                align: "left",
                vertical: "top",
                color: panel.text || theme.textColor,
              },
              theme,
            ),
          );
        }

        return { elements, height: tallest };
      }

      /*
       * A bulleted list: a marker and a line, per point.
       *
       * The marker is its own element because it is its own colour on the wall
       * -- the accent, at seven tenths opacity -- and merging it into the text
       * would either lose that or tint the whole line.
       */
      const gap = base * 0.3;
      const marker = base * 1.1;
      const elements: SlideElement[] = [];
      let at = y;

      component.items.forEach((item, index) => {
        const head = itemHeading(item);
        const line = head ? `${head}: ${itemText(item)}` : itemText(item);
        const height = tall(line, base, 1.3, width - marker - base * 0.5);

        elements.push(
          words(
            component.ordered ? `${index + 1}.` : "·",
            { x, y: at, w: marker, h: base * 1.3 },
            {
              size: base,
              weight: 400,
              align: "left",
              vertical: "top",
              // Seven tenths, as the engine draws a marker -- carried in the
              // colour, so nothing on a promoted slide has a second, hidden
              // transparency an operator cannot reach.
              color: withColourAlpha(accentOf(theme), 70),
            },
            theme,
          ),
          words(
            line,
            {
              x: x + marker,
              y: at,
              w: width - marker,
              h: height,
            },
            {
              size: base,
              lineHeight: 1.3,
              weight: 400,
              align: "left",
              vertical: "top",
            },
            theme,
          ),
        );
        at += height + gap;
      });

      return { elements, height: Math.max(0, at - y - gap) };
    }

    case "table": {
      const size = base * 0.82;
      const rows = component.rows.length + (component.header.length > 0 ? 1 : 0);
      const height = rows * size * 1.3 + size * 0.6;
      return {
        elements: [
          {
            ...newTable(),
            header: component.header,
            rows: component.rows,
            x,
            y,
            w: width,
            h: height,
            size,
            lineHeight: 1.3,
            weight: 400,
            align: "left",
            vertical: "top",
            color: theme.textColor,
          },
        ],
        height,
      };
    }

    case "quote": {
      const size = base * 1.05;
      // The engine gives a quotation eight tenths of the frame and centres it.
      const box = width * 0.8;
      const left = x + (width - box) / 2;
      const said = tall(component.text, size, 1.3, box);
      const elements: SlideElement[] = [
        words(
          component.text,
          { x: left, y, w: box, h: said },
          {
            size,
            lineHeight: 1.3,
            weight: 400,
            align: "center",
            vertical: "top",
          },
          theme,
        ),
      ];
      let height = said;

      if (component.attribution) {
        const gap = base * 0.35;
        const small = base * 0.6;
        elements.push(
          words(
            `— ${component.attribution}`,
            { x: left, y: y + said + gap, w: box, h: small * 1.4 },
            {
              size: small,
              weight: 400,
              align: "center",
              vertical: "top",
              color: withColourAlpha(theme.textColor, 70),
            },
            theme,
          ),
        );
        height += gap + small * 1.4;
      }

      return { elements, height };
    }

    case "passage": {
      /*
       * A reference, and the offer of the verse behind it.
       *
       * The engine draws the reference alone -- the words are staged from the
       * library, which is the rule the generator follows and why it never sends
       * text. Promoted to a scripture element it arrives the same way, and the
       * operator can look it up in one press if they want the verse on the
       * slide.
       */
      const size = base * 0.62;
      return {
        elements: [
          {
            ...newScripture(),
            reference: component.reference,
            lines: [],
            showReference: true,
            x,
            y,
            w: width,
            h: size * 1.6,
            size,
            align: ranged ? "left" : "center",
            vertical: "top",
            color: accentOf(theme),
          },
        ],
        height: size * 1.6,
      };
    }

    case "figure": {
      // Fitted, never cropped: a church's graphics carry their own words.
      const height = HEIGHT * 0.55;
      return {
        elements: [
          {
            ...newImage(component.source.path),
            fit: "contain",
            x,
            y,
            w: width,
            h: height,
          },
        ],
        height,
      };
    }

    case "chart": {
      const elements: SlideElement[] = [];
      let at = y;
      if (component.label) {
        const size = base * 0.8;
        const height = tall(component.label, size, 1.2, width);
        elements.push(
          words(
            component.label,
            { x, y: at, w: width, h: height },
            {
              size,
              weight: 700,
              align: "left",
              vertical: "top",
              color: accentOf(theme),
            },
            theme,
          ),
        );
        at += height + base * 0.3;
      }
      // The bars become a table, which is the honest still of a chart: the
      // figures were checked against the transcript and they survive here.
      const size = base * 0.8;
      const height = component.bars.length * size * 1.3 + size * 0.6;
      elements.push({
        ...newTable(),
        header: [],
        rows: component.bars.map((bar) => [bar.label, String(bar.value)]),
        x,
        y: at,
        w: width,
        h: height,
        size,
        align: "left",
        vertical: "top",
        color: theme.textColor,
      });
      return { elements, height: at - y + height };
    }

    default:
      return { elements: [], height: 0 };
  }
}

/** Lays a slide out at one base size, from the top of the content box. */
function arrange(
  components: SlideComponent[],
  layout: SlideLayout,
  base: number,
  theme: ProjectorTheme,
): Piece {
  const title = components.find(
    (component) => component.kind === "text" && component.level === "title",
  );
  const rest = components.filter((component) => component !== title);

  /*
   * A movement of the sermon begins: the heading on a field of colour, set as
   * large as the frame allows. The field is the panel colour, which is the
   * accent's own tint, so it is the church's and not a colour this file chose.
   */
  if (layout === "section" && title?.kind === "text") {
    const panel = panelStyle(theme);
    const scale = sectionScale(title.text);
    const padX = base * 0.7;
    const padY = base * 0.55;
    const inner = heading(title.text, padY, base, scale, theme);

    return {
      elements: [
        {
          kind: "shape",
          id: "field",
          shape: "rounded",
          fill: panel.fill,
          opacity: 100,
          radius: base * 0.1,
          x: INSET_X,
          y: 0,
          w: WIDTH,
          h: inner.height + padY * 2,
        },
        // Indented by the field's own padding, which the heading knows nothing
        // about: it lays out against the frame, so it is moved in here.
        ...inner.elements.map((element) => ({
          ...element,
          x: element.x + padX,
          w: Math.min(element.w, WIDTH - padX * 2),
        })),
      ],
      height: inner.height + padY * 2,
    };
  }

  if (layout === "split") {
    const figure = rest.find((component) => component.kind === "figure");
    if (figure?.kind === "figure") {
      /*
       * The words take two thirds, the picture one, and the words are set
       * smaller than they would be whole-frame -- given half the frame they
       * wrap twice as often.
       */
      const column = base * 0.88;
      const gap = base * 1.2;
      const textWidth = ((WIDTH - gap) * 1.35) / 2.35;
      const pictureWidth = WIDTH - gap - textWidth;

      const elements: SlideElement[] = [];
      let y = 0;
      if (title?.kind === "text") {
        const head = heading(title.text, y, column, 1.35, theme);
        elements.push(...head.elements);
        y += head.height + base * 0.5;
      }

      const beside = rest.filter((component) => component !== figure);
      const top = y;
      for (const component of beside) {
        const drawn = piece(
          component,
          y,
          column,
          textWidth,
          INSET_X,
          theme,
          true,
        );
        elements.push(...drawn.elements);
        y += drawn.height + column * 0.45;
      }
      const textHeight = Math.max(0, y - top - column * 0.45);

      const pictureHeight = Math.min(HEIGHT * 0.66, Math.max(textHeight, column * 6));
      elements.push({
        ...newImage(figure.source.path),
        fit: "contain",
        x: INSET_X + textWidth + gap,
        // Centred against the words, which is how the engine sets it.
        y: top + Math.max(0, (textHeight - pictureHeight) / 2),
        w: pictureWidth,
        h: pictureHeight,
      });

      return {
        elements,
        height: Math.max(y - column * 0.45, top + pictureHeight),
      };
    }

    const table = rest.find((component) => component.kind === "table");
    if (table?.kind === "table") {
      /*
       * A comparison drawn as the two columns it already is: each side under
       * its own accented heading, with a hairline beneath and air between.
       */
      const elements: SlideElement[] = [];
      let y = 0;
      if (title?.kind === "text") {
        const head = heading(title.text, y, base, 1.3, theme);
        elements.push(...head.elements);
        y += head.height + base * 0.5;
      }

      const gap = base * 1.1;
      const count = Math.max(1, table.header.length);
      const each = (WIDTH - gap * (count - 1)) / count;
      const headSize = base * 0.95;
      const rowSize = base * 0.88;
      const rule = base * 0.035;
      let tallest = 0;

      table.header.forEach((head, column) => {
        const left = INSET_X + (each + gap) * column;
        let at = y;

        const headHeight = tall(head, headSize, 1.2, each);
        elements.push(
          words(
            head,
            { x: left, y: at, w: each, h: headHeight },
            {
              size: headSize,
              weight: 700,
              lineHeight: 1.2,
              align: "left",
              vertical: "top",
              color: accentOf(theme),
            },
            theme,
          ),
        );
        at += headHeight + base * 0.35;

        elements.push({
          kind: "shape",
          id: `column-rule-${column}`,
          shape: "line",
          fill: withColourAlpha(accentOf(theme), 50),
          opacity: 100,
          radius: 0,
          x: left,
          y: at,
          w: each,
          h: rule,
        });
        at += rule + base * 0.35;

        for (const row of table.rows) {
          const cell = row[column] ?? "";
          const height = tall(cell, rowSize, 1.3, each);
          elements.push(
            words(
              cell,
              { x: left, y: at, w: each, h: height },
              {
                size: rowSize,
                lineHeight: 1.3,
                weight: 400,
                align: "left",
                vertical: "top",
              },
              theme,
            ),
          );
          at += height + base * 0.5;
        }

        tallest = Math.max(tallest, at - y);
      });

      let bottom = y + tallest;
      for (const component of rest.filter((entry) => entry !== table)) {
        const drawn = piece(component, bottom, base, WIDTH, INSET_X, theme, true);
        elements.push(...drawn.elements);
        bottom += drawn.height + base * 0.5;
      }

      return { elements, height: bottom };
    }
  }

  /*
   * One thing, given the frame, and centred: there is nothing for it to align
   * with, so the hanging rule would point at nothing.
   */
  if (layout === "single") {
    const elements: SlideElement[] = [];
    let y = 0;
    for (const component of components) {
      const drawn = piece(component, y, base, WIDTH, INSET_X, theme, false);
      elements.push(...drawn.elements);
      y += drawn.height + base * 0.5;
    }
    return { elements, height: Math.max(0, y - base * 0.5) };
  }

  // Stacked, and cards, which is the same stack with the points as panels.
  const gap = layout === "cards" ? base * 0.7 : base * 0.45;
  const elements: SlideElement[] = [];
  let y = 0;

  if (title?.kind === "text") {
    const head = heading(title.text, y, base, 1.35, theme);
    elements.push(...head.elements);
    y += head.height + gap;
  }

  for (const component of rest) {
    const drawn = piece(component, y, base, WIDTH, INSET_X, theme, true);
    elements.push(...drawn.elements);
    y += drawn.height + gap;
  }

  return { elements, height: Math.max(0, y - gap) };
}

/** Names them once they are placed, so nothing carries a colliding id. */
let promoted = 0;
function named(elements: SlideElement[]): SlideElement[] {
  return elements.map((element) => {
    promoted += 1;
    return { ...element, id: `p${promoted.toString(36)}` };
  });
}

/**
 * The slide, as elements, laid out where the engine had it.
 *
 * Already-designed slides come back untouched — promotion happens once, the
 * first time a generated slide is opened in the studio.
 */
export function promote(
  section: SongSection,
  theme: ProjectorTheme,
): SlideElement[] {
  if (section.elements && section.elements.length > 0) return section.elements;

  const components = (section.components ?? []) as SlideComponent[];

  // A section with only lines: a deck imported from a text file, or a song.
  // Stacked as body text, which is how the engine draws lyric lines.
  if (components.length === 0) {
    const lines = section.lines.filter((line) => line.trim().length > 0);
    if (lines.length === 0) return [];
    const base = baseSize(lines.join(" ")) * CQW;
    const height = tall(lines.join("\n"), base, 1.35, WIDTH);
    return named([
      words(
        lines.join("\n"),
        {
          x: INSET_X,
          y: INSET_Y + Math.max(0, (HEIGHT - height) / 2),
          w: WIDTH,
          h: height,
        },
        { size: base, weight: 500, lineHeight: 1.35, align: "center", vertical: "middle" },
        theme,
      ),
    ]);
  }

  const layout = layoutOf(section.layout, components);

  /*
   * The engine's guess, brought down until the estimate fits.
   *
   * The engine does this by measuring what it drew; this can only estimate, so
   * it steps down in tenths rather than searching -- a step too large or small
   * is a drag away, and stopping at the same floor the engine uses means a
   * dense slide is promoted at the size the wall would have shown.
   */
  const guess =
    baseSize(
      /*
       * The same text the engine measures.
       *
       * `bodyText` of a composed body is its components' own text joined by
       * newlines, and the size guess falls in steps with how long that is. It
       * was the components' *JSON* here for one build, which counts field names
       * and quotation marks as words on the slide -- so every promoted slide
       * came back a size or two smaller than the wall had drawn it.
       */
      components.map(componentText).join("\n"),
    ) * CQW;

  let arranged = arrange(components, layout, guess, theme);
  let base = guess;
  while (arranged.height > HEIGHT && base > FLOOR) {
    base = Math.max(FLOOR, base * 0.9);
    arranged = arrange(components, layout, base, theme);
  }

  // Vertically centred in the content box, as every arrangement is.
  const offset = INSET_Y + Math.max(0, (HEIGHT - arranged.height) / 2);
  return named(
    arranged.elements.map((element) => ({ ...element, y: element.y + offset })),
  );
}
