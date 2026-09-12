import {
  newShape as newBlock,
  type ShapeElement,
  type SlideElement,
  type TextElement,
} from "./design";
import { newSlot } from "./shapes";

/**
 * Display shapes a church can put on a stream tonight.
 *
 * # Why these rather than the six in the renderer
 *
 * The built-in forms are geometry: they can be chosen and not changed, and a
 * church that wants the band two hundred pixels higher has nowhere to go. These
 * are made of the same elements a shape drawn by hand is made of, so what the
 * library shows is exactly what a copy will be — and the first thing most
 * churches do to any of them is move the band and drop a logo in it, which is
 * a drag rather than a feature request.
 *
 * # What they have in common
 *
 * Dark furniture and light words, because an overlay is keyed over whatever the
 * camera is pointing at and the one thing that cannot be predicted is what is
 * behind it. A church with a pale set can recolour in two presses; a church
 * that never opens the studio still reads on a bright Sunday and a dark
 * evening.
 *
 * Nothing fills the frame. That is the whole difference between a shape and a
 * slide, and a template that ignored it would teach the wrong thing on the
 * first screen a church sees.
 */
export interface ShapeTemplate {
  id: string;
  name: string;
  /** What it is for, which is what an operator chooses by. */
  hint: string;
  elements: SlideElement[];
}

/** Ink for furniture: near-black at four fifths, so video shows through it. */
const INK = "#0B0F18CC";
const INK_SOLID = "#0B0F18F2";
const GOLD = "#D8B25C";
const PAPER = "#F4F1EAF2";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function block(box: Box, fill: string, radius = 0): ShapeElement {
  return { ...newBlock(radius > 0 ? "rounded" : "rectangle"), ...box, fill, radius };
}

function rule(box: Box, fill = GOLD): ShapeElement {
  return { ...newBlock("line"), ...box, fill, radius: box.h / 2 };
}

/** A fade to nothing, which is how words sit on video without a band. */
function scrim(box: Box, from: string, angle: number): ShapeElement {
  return {
    ...newBlock("rectangle"),
    ...box,
    fill: from,
    fillKind: "gradient",
    fillTo: "#00000000",
    fillAngle: angle,
    radius: 0,
  };
}

function words(box: Box, over: Partial<TextElement> = {}): TextElement {
  return { ...newSlot("words"), ...box, ...over };
}

function citation(box: Box, over: Partial<TextElement> = {}): TextElement {
  return { ...newSlot("reference"), ...box, ...over };
}

export const SHAPE_TEMPLATES: ShapeTemplate[] = [
  {
    id: "lower-band",
    name: "Lower band",
    hint: "A band across the bottom with a gold rule. The one most churches mean by a lower third.",
    elements: [
      block({ x: 0, y: 690, w: 1920, h: 280 }, INK),
      rule({ x: 150, y: 722, w: 220, h: 8 }),
      citation({ x: 150, y: 748, w: 1620, h: 54 }, { size: 32, align: "left", color: GOLD }),
      words({ x: 150, y: 808, w: 1620, h: 130 }, { size: 68, align: "left" }),
    ],
  },
  {
    id: "lower-band-centred",
    name: "Lower band, centred",
    hint: "The same band with everything centred. Reads better when the camera is on a lectern in the middle.",
    elements: [
      block({ x: 0, y: 700, w: 1920, h: 270 }, INK),
      citation({ x: 150, y: 726, w: 1620, h: 50 }, { size: 30, color: GOLD }),
      words({ x: 150, y: 786, w: 1620, h: 140 }, { size: 68 }),
    ],
  },
  {
    id: "slim-strip",
    name: "Slim strip",
    hint: "One line at the very bottom. The least furniture there is while still having a band.",
    elements: [
      block({ x: 0, y: 880, w: 1920, h: 120 }, INK_SOLID),
      words({ x: 120, y: 898, w: 1400, h: 84 }, { size: 46, align: "left" }),
      citation({ x: 1540, y: 902, w: 260, h: 76 }, { size: 28, align: "right", color: GOLD }),
    ],
  },
  {
    id: "scrim",
    name: "Fade",
    hint: "No band at all: a fade up from the bottom edge, so the picture keeps its bottom corner.",
    elements: [
      scrim({ x: 0, y: 560, w: 1920, h: 520 }, "#000000D9", 0),
      citation({ x: 150, y: 740, w: 1620, h: 50 }, { size: 30, color: GOLD }),
      words({ x: 150, y: 800, w: 1620, h: 150 }, { size: 66 }),
    ],
  },
  {
    id: "scrim-left",
    name: "Fade from the left",
    hint: "A side fade with the words ranged left. For a camera framed to one side.",
    elements: [
      scrim({ x: 0, y: 0, w: 1180, h: 1080 }, "#000000E6", 90),
      citation({ x: 130, y: 470, w: 820, h: 50 }, { size: 30, align: "left", color: GOLD }),
      words({ x: 130, y: 530, w: 820, h: 260 }, { size: 60, align: "left", vertical: "top" }),
    ],
  },
  {
    id: "card-left",
    name: "Card, left",
    hint: "A rounded card in the corner. Leaves three quarters of the picture alone.",
    elements: [
      block({ x: 110, y: 600, w: 880, h: 330 }, INK, 20),
      rule({ x: 160, y: 640, w: 160, h: 6 }),
      citation({ x: 160, y: 664, w: 780, h: 46 }, { size: 28, align: "left", color: GOLD }),
      words({ x: 160, y: 716, w: 780, h: 170 }, { size: 52, align: "left", vertical: "top" }),
    ],
  },
  {
    id: "card-right",
    name: "Card, right",
    hint: "The same card on the other side, for a camera framed left.",
    elements: [
      block({ x: 930, y: 600, w: 880, h: 330 }, INK, 20),
      rule({ x: 980, y: 640, w: 160, h: 6 }),
      citation({ x: 980, y: 664, w: 780, h: 46 }, { size: 28, align: "left", color: GOLD }),
      words({ x: 980, y: 716, w: 780, h: 170 }, { size: 52, align: "left", vertical: "top" }),
    ],
  },
  {
    id: "pill",
    name: "Pill",
    hint: "A rounded band floating clear of the edges. Modern, and forgiving of an overscanning screen.",
    elements: [
      block({ x: 220, y: 760, w: 1480, h: 190 }, INK_SOLID, 95),
      words({ x: 280, y: 785, w: 1360, h: 140 }, { size: 56 }),
    ],
  },
  {
    id: "badge",
    name: "Badge and band",
    hint: "The citation on a coloured block beside the words. Good when the reference matters as much as the verse.",
    elements: [
      block({ x: 0, y: 760, w: 1920, h: 200 }, INK),
      block({ x: 0, y: 760, w: 360, h: 200 }, GOLD),
      citation({ x: 30, y: 800, w: 300, h: 120 }, { size: 34, color: "#101010" }),
      words({ x: 410, y: 786, w: 1380, h: 150 }, { size: 56, align: "left" }),
    ],
  },
  {
    id: "top-band",
    name: "Top band",
    hint: "Across the top, for a frame whose lower half is busy: a platform, a band, a table.",
    elements: [
      block({ x: 0, y: 0, w: 1920, h: 180 }, INK),
      rule({ x: 0, y: 178, w: 1920, h: 6 }),
      words({ x: 150, y: 20, w: 1620, h: 110 }, { size: 50 }),
      citation({ x: 150, y: 128, w: 1620, h: 44 }, { size: 26, color: GOLD }),
    ],
  },
  {
    id: "side-panel-wide",
    name: "Side panel, wide",
    hint: "A full-height panel down one side. Holds a long verse without covering the speaker.",
    elements: [
      block({ x: 1330, y: 0, w: 590, h: 1080 }, INK),
      rule({ x: 1390, y: 300, w: 140, h: 6 }),
      citation({ x: 1390, y: 324, w: 470, h: 50 }, { size: 28, align: "left", color: GOLD }),
      words({ x: 1390, y: 384, w: 470, h: 380 }, { size: 44, align: "left", vertical: "top" }),
    ],
  },
  {
    id: "quote",
    name: "Quotation",
    hint: "Large words, centred, with a rule above and below. For one line that carries the moment.",
    elements: [
      scrim({ x: 0, y: 300, w: 1920, h: 780 }, "#000000CC", 0),
      rule({ x: 810, y: 520, w: 300, h: 5 }),
      words({ x: 260, y: 570, w: 1400, h: 230 }, { size: 74, lineHeight: 1.3 }),
      rule({ x: 810, y: 826, w: 300, h: 5 }),
      citation({ x: 260, y: 850, w: 1400, h: 56 }, { size: 32, color: GOLD }),
    ],
  },
  {
    id: "paper",
    name: "Paper band",
    hint: "Dark words on a light band, for a stream whose picture is mostly dark.",
    elements: [
      block({ x: 0, y: 720, w: 1920, h: 250 }, PAPER),
      rule({ x: 150, y: 752, w: 200, h: 8 }, "#8A6A22"),
      citation({ x: 150, y: 776, w: 1620, h: 48 }, { size: 30, align: "left", color: "#6B5416" }),
      words({ x: 150, y: 832, w: 1620, h: 120 }, { size: 62, align: "left", color: "#14130F" }),
    ],
  },
  {
    id: "corner",
    name: "Corner note",
    hint: "Small, high and out of the way. For a notice or a name rather than a reading.",
    elements: [
      block({ x: 1180, y: 70, w: 660, h: 150 }, INK, 14),
      words({ x: 1220, y: 92, w: 580, h: 74 }, { size: 38, align: "left" }),
      citation({ x: 1220, y: 168, w: 580, h: 40 }, { size: 24, align: "left", color: GOLD }),
    ],
  },
  /*
   * The six Pulpitry drew in the renderer, as templates like everything else.
   *
   * They were a section of their own in the library -- "built in", drawn by the
   * renderer, copyable but not editable. That distinction was real and it was
   * not the church's problem: what they want is the shape, in the list with the
   * others, in a form they can move. An output can still be pointed at the
   * built-in form directly, which is what every installation already using one
   * is doing; these are the same arrangements as something to start from.
   */
  {
    id: "classic-lower-third",
    name: "Lower third",
    hint: "The original: a full-width band with the citation on a chip above it.",
    elements: [
      block({ x: 0, y: 745, w: 1920, h: 200 }, INK),
      block({ x: 150, y: 690, w: 360, h: 55 }, PAPER, 4),
      citation({ x: 170, y: 698, w: 320, h: 40 }, { size: 26, align: "left", color: "#141414" }),
      words({ x: 150, y: 775, w: 1620, h: 140 }, { size: 60 }),
    ],
  },
  {
    id: "classic-ribbon",
    name: "Ribbon",
    hint: "A thin band with the citation ahead of the words on one line. The least vertical space of any of them.",
    elements: [
      block({ x: 0, y: 780, w: 1920, h: 130 }, INK),
      citation({ x: 150, y: 805, w: 360, h: 80 }, { size: 30, align: "left", color: GOLD }),
      words({ x: 540, y: 800, w: 1230, h: 90 }, { size: 44, align: "left" }),
    ],
  },
  {
    id: "classic-card",
    name: "Card",
    hint: "A block at the left with the citation on a chip above it. Leaves the right of the frame clear.",
    elements: [
      block({ x: 96, y: 615, w: 845, h: 275 }, INK, 12),
      block({ x: 96, y: 560, w: 330, h: 55 }, PAPER, 4),
      citation({ x: 116, y: 568, w: 290, h: 40 }, { size: 26, align: "left", color: "#141414" }),
      words({ x: 150, y: 645, w: 740, h: 215 }, { size: 46, align: "left", vertical: "top" }),
    ],
  },
  {
    id: "classic-top-strip",
    name: "Top strip",
    hint: "A band across the top with the words centred in it. For a frame that is busy below.",
    elements: [
      block({ x: 0, y: 0, w: 1920, h: 150 }, INK),
      words({ x: 150, y: 20, w: 1620, h: 110 }, { size: 42 }),
    ],
  },
  {
    id: "classic-side-panel",
    name: "Side panel",
    hint: "A panel down the right, words ranged left inside it. A long verse without covering the speaker.",
    elements: [
      block({ x: 1344, y: 0, w: 576, h: 1080 }, INK),
      citation({ x: 1400, y: 380, w: 464, h: 60 }, { size: 26, align: "left", color: GOLD }),
      words({ x: 1400, y: 450, w: 464, h: 300 }, { size: 40, align: "left", vertical: "top" }),
    ],
  },
  {
    id: "classic-caption",
    name: "Caption",
    hint: "No furniture at all: the words carry themselves. The one that works over a moving camera.",
    elements: [
      citation({ x: 300, y: 786, w: 1320, h: 50 }, { size: 28, color: GOLD }),
      words({ x: 300, y: 842, w: 1320, h: 140 }, { size: 58 }),
    ],
  },
  {
    id: "cinematic",
    name: "Cinematic",
    hint: "Two rules and nothing else, with the words between them. Quiet enough to leave up.",
    elements: [
      rule({ x: 150, y: 792, w: 1620, h: 3 }, "#FFFFFF80"),
      words({ x: 150, y: 810, w: 1620, h: 120 }, { size: 56 }),
      rule({ x: 150, y: 938, w: 1620, h: 3 }, "#FFFFFF80"),
      citation({ x: 150, y: 946, w: 1620, h: 44 }, { size: 26, color: "#FFFFFFCC" }),
    ],
  },
];
