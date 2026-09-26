import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { catalogGet, catalogList, type Item } from "./catalog";
import {
  newShape as newBlock,
  newText,
  type SlideElement,
  type TextElement,
  type VerseRun,
} from "./design";
import { runsText } from "./projector";

/**
 * Display shapes: the furniture an overlay output draws around the words.
 *
 * # What was wrong with six of them
 *
 * Pulpitry shipped six overlay forms as geometry inside the renderer — a lower
 * third, a ribbon, a card, a side panel — and a church could choose between
 * them and change nothing. But a stream's furniture is the most
 * church-specific thing on any screen: their band sits at their proportions, in
 * their colours, usually with their logo in it, and often shaped around a
 * camera framing nobody else has. Six presets is a choice between six other
 * churches' answers.
 *
 * # What a shape is
 *
 * The same elements a designed slide is made of — positioned, sized, typed and
 * coloured against the same 1920×1080 frame — with two of them marked as
 * *slots*: the words, and the citation. Everything else is furniture the church
 * drew, and it is drawn exactly as they drew it.
 *
 * There is no background. An overlay is keyed: what is not drawn is not there,
 * and a shape that filled the frame would stop being an overlay and start being
 * a slide.
 *
 * # How an output names one
 *
 * `overlay: "shape:14"`, where 14 is the library row. The built-in forms keep
 * their plain names, so nothing an existing installation has chosen changes
 * meaning, and an output pointed at a shape that has since been deleted falls
 * back to drawing nothing rather than to somebody else's furniture.
 */
const PREFIX = "shape:";

/** The library id an output's form names, or null for a built-in form. */
export function shapeIdOf(form: string): number | null {
  if (!form.startsWith(PREFIX)) return null;
  const id = Number.parseInt(form.slice(PREFIX.length), 10);
  return Number.isFinite(id) ? id : null;
}

export function formFor(id: number): string {
  return `${PREFIX}${id}`;
}

/** Every shape the church has drawn, most recently touched first. */
export function listShapes(): Promise<Item[]> {
  return catalogList("overlay", 100);
}

/**
 * The shape a form names, or null where it names one of the shipped forms.
 *
 * Null is also the answer for a shape that has been deleted or cannot be read,
 * and every surface that draws one treats that as *draw nothing*. Falling back
 * to a built-in form would put furniture nobody chose on a wall, and — because
 * the built-in the fallback lands on is a lower third — it looked exactly like
 * the studio had saved nothing at all.
 */
export async function loadShape(form: string): Promise<SlideElement[] | null> {
  const id = shapeIdOf(form || "");
  if (id === null) return null;
  try {
    const item = await catalogGet(id);
    return item?.body.kind === "overlay" ? item.body.elements : null;
  } catch {
    return null;
  }
}

/** A shape was drawn over or deleted; the payload is its library id. */
export const EVENT_SHAPE = "shape:changed";

/**
 * Told when a shape changes, because a shape is appearance kept in the catalog.
 *
 * Every other piece of appearance travels on a settings save, which each window
 * answers by re-asking for its own look. A shape is written by the studio
 * instead — so without this, an output went on drawing the version it read when
 * it opened, and moving a band did nothing to the wall until something else
 * happened to be saved.
 */
export const onShapeChanged = (
  handler: (id: number) => void,
): Promise<UnlistenFn> =>
  listen<number>(EVENT_SHAPE, (event) => handler(event.payload));

/**
 * The shape with its holes filled.
 *
 * A slot with nothing to put in it is dropped rather than drawn empty: a
 * citation box with no citation would otherwise leave a coloured rectangle on
 * a stream, and "no reference on this item" is exactly when that happens.
 */
export function filled(
  elements: SlideElement[],
  /**
   * What is live, split at each verse: the words slot keeps the runs so its
   * renderer can raise the numbers, the same as the wall behind the camera.
   */
  words: VerseRun[] | null,
  reference: string | null,
): SlideElement[] {
  const out: SlideElement[] = [];

  for (const element of elements) {
    if (element.kind !== "text" || !element.slot) {
      out.push(element);
      continue;
    }

    if (element.slot === "reference") {
      if (!reference || !reference.trim()) continue;
      out.push({ ...element, text: reference, runs: undefined });
      continue;
    }

    const text = words ? runsText(words) : null;
    if (!text || !text.trim()) continue;
    // Both: `text` is what anything measuring or summarising the shape reads,
    // and the runs are what it is drawn from.
    out.push({ ...element, text, runs: words ?? undefined });
  }

  return out;
}

/** Whether a shape has anywhere to put what is live. */
export function hasWords(elements: SlideElement[]): boolean {
  return elements.some(
    (element) => element.kind === "text" && element.slot === "words",
  );
}

/** A slot, which is a text element that says what fills it. */
export function newSlot(slot: "words" | "reference"): TextElement {
  const words = slot === "words";
  return {
    ...newText(
      words
        ? "The words that are live appear here"
        : "John 3:16 (KJV)",
    ),
    slot,
    x: 150,
    y: words ? 760 : 690,
    w: 1620,
    h: words ? 170 : 60,
    size: words ? 74 : 34,
    weight: words ? 700 : 600,
    align: "center",
    vertical: words ? "middle" : "bottom",
    color: "#FFFFFF",
    lineHeight: 1.25,
  };
}

/**
 * A shape to start from: a band across the lower third, a citation, the words.
 *
 * Not a blank canvas. A church opening this for the first time wants the thing
 * they already recognise, to move rather than to build — and the commonest
 * answer by far is a band at the bottom with the words in it.
 */
export function starterShape(): SlideElement[] {
  return [
    {
      ...newBlock("rectangle"),
      x: 0,
      y: 660,
      w: 1920,
      h: 300,
      fill: "#101C33E6",
      radius: 0,
    },
    {
      ...newBlock("line"),
      x: 150,
      y: 668,
      w: 220,
      h: 8,
      fill: "#D8B25C",
      radius: 4,
    },
    newSlot("reference"),
    newSlot("words"),
  ];
}

/**
 * What the studio shows in a slot while the shape is being designed.
 *
 * The words are runs because that is what a slot is filled with at the moment
 * it is drawn; one run with no number, which is what a single verse is.
 */
export const SAMPLE: { words: VerseRun[]; reference: string } = {
  words: [
    { number: null, text: "Wait on the Lord\nand He will renew your strength" },
  ],
  reference: "Isaiah 40:31 (KJV)",
};


/**
 * One of the six shipped forms, as elements a church can then move.
 *
 * # Why a copy rather than an edit
 *
 * The built-in forms are geometry in the renderer. They cannot be edited,
 * because there is nothing stored to edit — and they should not be: a church
 * that drags the lower third about and regrets it must be able to get the
 * original back, and a shipped form that can be changed is one that eventually
 * cannot be got back.
 *
 * So a shipped form is copied, and the copy is theirs: the band, the rule and
 * the two holes at the proportions the renderer draws them, from which the
 * first thing most churches do is move the band up and drop a logo in it.
 *
 * # Approximate, and honestly so
 *
 * The renderer sizes its type from the output's width and its own scale; these
 * numbers are that arrangement at 1920 × 1080, which is where every shape is
 * measured. A copy looks like what it came from and is not a pixel-for-pixel
 * duplicate of it — and from the moment it is copied it is not meant to be.
 */
export function shapeFromForm(form: string): SlideElement[] {
  const band = (box: { x: number; y: number; w: number; h: number }) => ({
    ...newBlock("rectangle"),
    ...box,
    fill: "#101C33E6",
    radius: 0,
  });

  const words = (box: { x: number; y: number; w: number; h: number }, size: number) => ({
    ...newSlot("words"),
    ...box,
    size,
  });

  const citation = (box: { x: number; y: number; w: number; h: number }, size: number) => ({
    ...newSlot("reference"),
    ...box,
    size,
  });

  switch (form) {
    case "ribbon":
      return [
        band({ x: 0, y: 780, w: 1920, h: 130 }),
        citation({ x: 150, y: 805, w: 380, h: 80 }, 30),
        words({ x: 540, y: 800, w: 1230, h: 90 }, 40),
      ];

    case "card":
      return [
        { ...newBlock("rounded"), x: 96, y: 560, w: 845, h: 330, fill: "#101C33E6", radius: 12 },
        citation({ x: 150, y: 590, w: 740, h: 50 }, 26),
        words({ x: 150, y: 650, w: 740, h: 210 }, 44),
      ];

    case "top-strip":
      return [
        band({ x: 0, y: 0, w: 1920, h: 150 }),
        words({ x: 150, y: 20, w: 1620, h: 110 }, 40),
      ];

    case "side-panel":
      return [
        band({ x: 1344, y: 0, w: 576, h: 1080 }),
        citation({ x: 1400, y: 380, w: 464, h: 60 }, 26),
        words({ x: 1400, y: 450, w: 464, h: 260 }, 38),
      ];

    case "caption":
      // No band at all: the words carry themselves on a heavy shadow, which is
      // what the built-in does and why it is the one that works over a camera.
      return [
        citation({ x: 300, y: 790, w: 1320, h: 50 }, 28),
        words({ x: 300, y: 845, w: 1320, h: 130 }, 50),
      ];

    case "lower-third":
    default:
      return starterShape();
  }
}
