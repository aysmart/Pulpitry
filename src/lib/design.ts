import type { BackgroundKind, ProjectorTheme } from "./theme";

/**
 * Slides laid out by hand, rather than arranged for you.
 *
 * # Why this exists beside the arranged kind
 *
 * Pulpitry already had two ways to make a slide and both decide the layout for
 * the operator: `blocks` are lines centred in the frame, and `components` are
 * a title and a body that `layoutFor` arranges into one of five shapes. That is
 * right for a sermon deck generated from what was said — nobody wants to
 * position forty slides — and it is the wrong answer for the four slides a
 * church makes on purpose. A welcome card with the church's name in the corner,
 * a gold rule under a title, giving details set against a photograph: none of
 * those can be asked for, only drawn.
 *
 * So a section can carry `elements`, and where it does, that is the slide.
 * Nothing decides anything: every element has a position, a size and its own
 * type, and the renderer paints exactly what it is given.
 *
 * # The canvas is 1920 x 1080, always
 *
 * Positions are stored in that space and painted as a percentage of the frame,
 * so one deck is the same design on a 1280 projector, a 4K panel and a
 * thumbnail the size of a stamp. It is the same 16:9 frame every other surface
 * in this application draws into, which is what makes the editor's canvas an
 * honest preview rather than an approximation.
 *
 * # Backgrounds belong to the deck, not the slide
 *
 * A church makes a deck to look like one thing; slides that each carried their
 * own background would mostly be a way to end up with a deck that does not
 * match itself. The editor says "All slides" under Background for that reason.
 * It is stored as the same fields a theme uses, so the existing `Backdrop`
 * draws it — which is how a deck gets a gradient, a photograph, a clip or one
 * of the drawn motions without a second implementation of any of them.
 */
export const CANVAS = { width: 1920, height: 1080 } as const;

/** Where an element sits, in canvas units. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How words are set. Shared by the text and scripture elements. */
export interface Typeset {
  /** A key from FONT_FAMILIES, or empty to follow the theme. */
  font: string;
  weight: number;
  /** Canvas units, so 84 is 84px of 1080 — the same on any screen. */
  size: number;
  lineHeight: number;
  letterSpacing: number;
  color: string;
  /** 0 to 100, as the editor shows it. */
  opacity: number;
  align: "left" | "center" | "right";
  vertical: "top" | "middle" | "bottom";
  underline: boolean;
  strike: boolean;
  /** Applied when drawn, never to the stored text: "SHOUT" is a decision
   *  about this slide, and destroying the operator's capitals is not. */
  textCase: "none" | "upper" | "title" | "lower";
}

export type ElementKind = "text" | "scripture" | "shape" | "image";

export interface TextElement extends Box, Typeset {
  kind: "text";
  id: string;
  text: string;
}

/**
 * A verse, resolved from the library at the moment it is placed.
 *
 * The reference is kept beside the words so the slide says where it is from and
 * so the operator can ask for it again in another translation. The words are
 * stored rather than looked up when the slide goes live, which is deliberate:
 * a wall is not the place to discover that a reference no longer resolves, and
 * a deck made in March should read in June exactly as it did when it was
 * checked.
 */
export interface ScriptureElement extends Box, Typeset {
  kind: "scripture";
  id: string;
  reference: string;
  /** As the library gave them. Empty while a reference is being typed. */
  lines: string[];
  /** Which Bible the words came from, shown with the reference. */
  translation: string;
  /** Whether the reference is drawn under the words. */
  showReference: boolean;
}

/**
 * Every shape the renderer can draw.
 *
 * A short list on purpose, and each one earns its place on a church slide: a
 * band to tint or divide, a rule under a heading, a disc or a marker behind a
 * number, a triangle or a chevron to point at something. Anything beyond this
 * is a drawing program, and a church making a poster has one of those.
 */
export type ShapeKind =
  | "rectangle"
  | "rounded"
  | "circle"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "chevron"
  | "star"
  | "line";

export const SHAPES: ShapeKind[] = [
  "rectangle",
  "rounded",
  "circle",
  "ellipse",
  "triangle",
  "diamond",
  "chevron",
  "star",
  "line",
];

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rectangle: "Rectangle",
  rounded: "Rounded",
  circle: "Circle",
  ellipse: "Ellipse",
  triangle: "Triangle",
  diamond: "Diamond",
  chevron: "Chevron",
  star: "Star",
  line: "Rule",
};

export interface ShapeElement extends Box {
  kind: "shape";
  id: string;
  shape: ShapeKind;
  fill: string;
  opacity: number;
  /** Corner rounding in canvas units. Only the boxy shapes use it. */
  radius: number;
}

/**
 * A comparison, a rota, a set of figures — the one arranged component that
 * cannot be reduced to lines without losing what it is.
 *
 * It exists so a generated slide survives being edited. The engine draws
 * tables often — "under the law" beside "under grace", a giving summary, a
 * rota — and promoting one to a stack of text elements would turn the grid
 * into a paragraph. Drawn here with the same hairlines the wall uses.
 */
export interface TableElement extends Box, Typeset {
  kind: "table";
  id: string;
  header: string[];
  rows: string[][];
}

export interface ImageElement extends Box {
  kind: "image";
  id: string;
  path: string;
  fit: "cover" | "contain";
  opacity: number;
  radius: number;
}

export type SlideElement =
  | TextElement
  | ScriptureElement
  | TableElement
  | ImageElement
  | ShapeElement;

/** Whether an element is set in type, and therefore carries a `Typeset`. */
export function isTypeset(
  element: SlideElement,
): element is TextElement | ScriptureElement | TableElement {
  return (
    element.kind === "text" ||
    element.kind === "scripture" ||
    element.kind === "table"
  );
}

/**
 * A deck's background, as the fields a theme already uses.
 *
 * Deliberately the same names: merged over the church's theme it produces a
 * `ProjectorTheme`, which every surface that draws a backdrop already accepts.
 * A deck therefore gets motion, video, photographs, gradients and dimming for
 * free, and there is exactly one implementation of each.
 */
export interface Background {
  backgroundKind: BackgroundKind;
  backgroundColor: string;
  gradientFrom: string;
  gradientTo: string;
  gradientAngle: number;
  backgroundPath: string | null;
  /** A scrim over a picture or clip, so words stay readable. 0 to 1. */
  backgroundDim: number;
  backgroundFit: string;
  backgroundScale: number;
  backgroundBlur: number;
  motion: string;
  motionSpeed: number;
}

export const DEFAULT_BACKGROUND: Background = {
  backgroundKind: "gradient",
  backgroundColor: "#101C33",
  gradientFrom: "#1B3A7A",
  gradientTo: "#0A1124",
  gradientAngle: 160,
  backgroundPath: null,
  backgroundDim: 0.25,
  backgroundFit: "cover",
  backgroundScale: 1,
  backgroundBlur: 0,
  motion: "drift",
  motionSpeed: 0.8,
};

/**
 * The theme a designed slide is drawn against.
 *
 * The church's own theme, with the deck's background over it. Everything that
 * is not a background — the reference's typeface, the outline, the texture —
 * is still theirs, because a deck is a design *in* their house style rather
 * than an escape from it.
 */
export function withBackground(
  theme: ProjectorTheme,
  background?: Background | null,
): ProjectorTheme {
  return background ? { ...theme, ...background } : theme;
}

/** Ready-made gradients, so a deck can look made without colour-picking. */
export const GRADIENT_PRESETS: Array<{
  label: string;
  from: string;
  to: string;
  angle: number;
}> = [
  { label: "Night sky", from: "#1B3A7A", to: "#080D1C", angle: 160 },
  { label: "Violet blue", from: "#5B3AA8", to: "#14102C", angle: 150 },
  { label: "Royal violet", from: "#3A2A78", to: "#0E0A1E", angle: 165 },
  { label: "Deep teal", from: "#0E3B3E", to: "#05171A", angle: 155 },
  { label: "Harmattan", from: "#F6E3C0", to: "#C98B4B", angle: 150 },
  { label: "Claret", from: "#5A1622", to: "#160608", angle: 165 },
  { label: "Palm", from: "#14402F", to: "#05120C", angle: 160 },
  { label: "Paper", from: "#F7F4EC", to: "#DCD4C2", angle: 150 },
];

/** The drawn motions, named as an operator would choose between them. */
export const MOTIONS: Array<{ key: string; label: string }> = [
  { key: "drift", label: "Drifting washes" },
  { key: "bokeh", label: "Rising lights" },
  { key: "rays", label: "Turning rays" },
  { key: "stars", label: "Slow starfield" },
];

let made = 0;

/** Unique within a session, which is all an element id has to be. */
function identity(): string {
  made += 1;
  return `e${Date.now().toString(36)}${made.toString(36)}`;
}

/** The type a new element is set in: white, centred, readable at the back. */
const TYPESET: Typeset = {
  font: "",
  weight: 700,
  size: 96,
  lineHeight: 1.15,
  letterSpacing: 0,
  color: "#FFFFFF",
  opacity: 100,
  align: "center",
  vertical: "middle",
  underline: false,
  strike: false,
  textCase: "none",
};

export function newText(text = "New text"): TextElement {
  return {
    kind: "text",
    id: identity(),
    text,
    // A wide box across the middle: the commonest thing anybody adds is a
    // line of words meant to be read, and a box the size of a word would have
    // to be dragged out before it could be typed into.
    x: 210,
    y: 440,
    w: 1500,
    h: 200,
    ...TYPESET,
  };
}

export function newScripture(): ScriptureElement {
  return {
    kind: "scripture",
    id: identity(),
    reference: "",
    lines: [],
    translation: "",
    showReference: true,
    x: 210,
    y: 300,
    w: 1500,
    h: 480,
    ...TYPESET,
    size: 72,
    weight: 500,
    lineHeight: 1.3,
  };
}

export function newShape(shape: ShapeKind): ShapeElement {
  // A rule arrives as a rule rather than as a band: the commonest shape on a
  // church slide is the short line under a heading, and one that had to be
  // flattened from a square first is a shape nobody would bother adding.
  const line = shape === "line";
  const round = shape === "circle";
  return {
    kind: "shape",
    id: identity(),
    shape,
    /*
     * A rule arrives solid and a band arrives as a tint.
     *
     * The transparency is in the colour rather than in the element, because a
     * tint is what a band is *for* — something for words to sit on with the
     * picture behind still showing — and that is a property of the colour.
     * `opacity` stays at full so there is one number to think about.
     */
    fill: line ? "#D8B25C" : "#FFFFFF33",
    opacity: 100,
    radius: shape === "rounded" ? 32 : line ? 4 : 0,
    x: line ? 210 : 660,
    y: line ? 660 : 340,
    w: line ? 280 : round ? 400 : 600,
    h: line ? 8 : 400,
  };
}

export function newTable(): TableElement {
  return {
    kind: "table",
    id: identity(),
    header: ["", ""],
    rows: [
      ["", ""],
      ["", ""],
    ],
    x: 210,
    y: 340,
    w: 1500,
    h: 400,
    ...TYPESET,
    size: 56,
    weight: 400,
    lineHeight: 1.3,
    align: "left",
    vertical: "top",
  };
}

export function newImage(path: string): ImageElement {
  return {
    kind: "image",
    id: identity(),
    path,
    fit: "cover",
    opacity: 100,
    radius: 0,
    x: 560,
    y: 240,
    w: 800,
    h: 600,
  };
}

/** A copy with its own identity, for duplicating a slide or an element. */
export function reidentify(element: SlideElement): SlideElement {
  return { ...element, id: identity() };
}

/** What the case setting does when the slide is drawn. */
export function cased(text: string, how: Typeset["textCase"]): string {
  switch (how) {
    case "upper":
      return text.toLocaleUpperCase();
    case "lower":
      return text.toLocaleLowerCase();
    case "title":
      return text.replace(
        /\p{L}[\p{L}\p{M}'’]*/gu,
        (word) => word[0]!.toLocaleUpperCase() + word.slice(1),
      );
    default:
      return text;
  }
}

/** Everything readable on a designed slide, for sizing, search and mirroring. */
export function elementsText(elements: SlideElement[]): string {
  return elements
    .map((element) => {
      switch (element.kind) {
        case "text":
          return element.text;
        case "scripture":
          return [element.lines.join(" "), element.reference]
            .filter(Boolean)
            .join(" — ");
        case "table":
          return [element.header, ...element.rows]
            .map((row) => row.filter(Boolean).join("   "))
            .filter(Boolean)
            .join("\n");
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Keeps an element inside the canvas, and big enough to see.
 *
 * Dragging is in screen pixels against a scaled canvas, so rounding errors
 * accumulate; and an element dragged off the edge is not recoverable except by
 * typing numbers into the inspector, which is a poor way to find out that a
 * design tool lets you lose things.
 */
export function within<T extends Box>(box: T): T {
  const w = Math.max(24, Math.min(CANVAS.width, Math.round(box.w)));
  const h = Math.max(8, Math.min(CANVAS.height, Math.round(box.h)));
  return {
    ...box,
    w,
    h,
    x: Math.max(0, Math.min(CANVAS.width - w, Math.round(box.x))),
    y: Math.max(0, Math.min(CANVAS.height - h, Math.round(box.y))),
  };
}
