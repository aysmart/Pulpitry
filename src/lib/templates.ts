import { DEFAULT_THEME, type ProjectorTheme } from "./theme";

/**
 * Looks that ship with the app.
 *
 * Not stored in the library: they are read-only starting points, and an
 * operator who edits one is really making their own, which is what Save does.
 * Each is a whole theme, so applying one settles typeface, colour, outline and
 * background together rather than leaving a half-changed look.
 *
 * Chosen for rooms rather than for taste. A church with a bright hall and a
 * weak projector needs Bold Contrast; one with a dark auditorium can afford
 * Evening. That is the decision these are here to make easy.
 */
export interface SampleTemplate {
  id: string;
  name: string;
  /** What it is for, shown on hover. */
  hint: string;
  theme: ProjectorTheme;
}

const base = DEFAULT_THEME;

export const SAMPLE_TEMPLATES: SampleTemplate[] = [
  {
    id: "parchment",
    name: "Parchment",
    hint: "Ink on warm paper. Reads well in a bright room.",
    theme: { ...base },
  },
  {
    id: "ink",
    name: "Ink",
    hint: "Light text on near-black. The safest look in a dark auditorium.",
    theme: {
      ...base,
      textColor: "#F4F1EA",
      backgroundColor: "#14140F",
      shadow: true,
    },
  },
  {
    id: "dawn",
    name: "Dawn",
    hint: "A warm wash, for a morning service.",
    theme: {
      ...base,
      textColor: "#2A1F14",
      backgroundKind: "gradient",
      gradientFrom: "#F7EFE2",
      gradientTo: "#E4C79B",
      gradientAngle: 155,
      texture: "grain",
      textureStrength: 0.3,
    },
  },
  {
    id: "evening",
    name: "Evening",
    hint: "Deep blue to plum, with a soft grain.",
    theme: {
      ...base,
      textColor: "#F2EFE8",
      shadow: true,
      backgroundKind: "gradient",
      gradientFrom: "#16263F",
      gradientTo: "#3C2036",
      gradientAngle: 165,
      texture: "grain",
      textureStrength: 0.45,
    },
  },
  {
    id: "linen",
    name: "Linen",
    hint: "Pale and woven; quiet behind long passages.",
    theme: {
      ...base,
      textColor: "#22201B",
      backgroundKind: "gradient",
      gradientFrom: "#EFEBE1",
      gradientTo: "#DCD5C6",
      gradientAngle: 180,
      texture: "linen",
      textureStrength: 0.7,
    },
  },
  {
    id: "slate",
    name: "Slate",
    hint: "Cool grey with a vignette pulling the eye inward.",
    theme: {
      ...base,
      textColor: "#F0F1F2",
      shadow: true,
      backgroundKind: "gradient",
      gradientFrom: "#3A3F45",
      gradientTo: "#1C1F23",
      gradientAngle: 160,
      texture: "vignette",
      textureStrength: 0.5,
    },
  },
  {
    id: "contrast",
    name: "Bold Contrast",
    hint: "White on black with an outline. For a washed-out screen.",
    theme: {
      ...base,
      fontFamily: "inter",
      textColor: "#FFFFFF",
      outlineWidth: 3,
      outlineColor: "#000000",
      backgroundColor: "#000000",
      shadow: false,
    },
  },
  {
    id: "carols",
    name: "Carols",
    hint: "Night blue with a halftone field, for candlelit services.",
    theme: {
      ...base,
      textColor: "#F6F1E4",
      shadow: true,
      backgroundKind: "gradient",
      gradientFrom: "#0E1B33",
      gradientTo: "#1E2C4A",
      gradientAngle: 200,
      texture: "dots",
      textureStrength: 0.45,
    },
  },
];

/** Representative words, so a thumbnail shows type rather than a colour chip. */
export const TEMPLATE_SAMPLE = [
  {
    text: "The Lord is my shepherd",
    level: "body",
    align: "center",
    bold: false,
    italic: false,
  },
];
