import { DEFAULT_THEME, type ProjectorTheme } from "./theme";

/**
 * Looks that ship with the app.
 *
 * Not stored in the library: they are read-only starting points, and an
 * operator who edits one is really making their own, which is what Save does.
 * Each is a whole theme, so applying one settles typeface, colour, outline and
 * background together rather than leaving a half-changed look.
 *
 * Grouped by the decision they answer, which is almost always about the room
 * rather than about taste. A bright hall with a weak projector needs Light or
 * Legibility; a dark auditorium can afford anything. Thirty tiles with no
 * grouping would be a wall to scroll past rather than a choice to make.
 */
export type TemplateGroup = "Light" | "Dark" | "Colour" | "Seasonal" | "Legibility";

export interface SampleTemplate {
  id: string;
  name: string;
  group: TemplateGroup;
  /** What it is for, shown on hover. */
  hint: string;
  theme: ProjectorTheme;
}

/** Order the groups are shown in: the two everyday choices first. */
export const TEMPLATE_GROUPS: TemplateGroup[] = [
  "Light",
  "Dark",
  "Colour",
  "Seasonal",
  "Legibility",
];

const base = DEFAULT_THEME;

/** A flat colour behind the words. */
function flat(
  id: string,
  name: string,
  group: TemplateGroup,
  hint: string,
  theme: Partial<ProjectorTheme>,
): SampleTemplate {
  return { id, name, group, hint, theme: { ...base, ...theme } };
}

/** A wash of two colours, which is what most of these are. */
function wash(
  id: string,
  name: string,
  group: TemplateGroup,
  hint: string,
  from: string,
  to: string,
  textColor: string,
  extra: Partial<ProjectorTheme> = {},
): SampleTemplate {
  return {
    id,
    name,
    group,
    hint,
    theme: {
      ...base,
      textColor,
      backgroundKind: "gradient",
      gradientFrom: from,
      gradientTo: to,
      gradientAngle: 160,
      ...extra,
    },
  };
}

export const SAMPLE_TEMPLATES: SampleTemplate[] = [
  // Light — a bright hall, or a projector fighting daylight.
  flat("parchment", "Parchment", "Light", "Ink on warm paper. The default, and hard to beat.", {}),
  wash("linen", "Linen", "Light", "Pale and woven; quiet behind long passages.",
    "#EFEBE1", "#DCD5C6", "#22201B", { gradientAngle: 180, texture: "linen", textureStrength: 0.7 }),
  flat("chalk", "Chalk", "Light", "Almost white, with the faintest grain.",
    { backgroundColor: "#FBFAF7", textColor: "#2B2A26", texture: "grain", textureStrength: 0.2 }),
  wash("bone", "Bone", "Light", "Soft ivory that never glares.",
    "#F2EDE3", "#E6DCCB", "#33302A", { gradientAngle: 170 }),
  wash("sandstone", "Sandstone", "Light", "Warm stone; flattering under tungsten light.",
    "#F6E9D5", "#E2C79C", "#3A2E1E", { gradientAngle: 150, texture: "grain", textureStrength: 0.25 }),
  wash("mist", "Mist", "Light", "Cool and pale, for a modern room.",
    "#EEF2F4", "#D8E0E6", "#23303A"),

  // Dark — a darkened auditorium, where light text is kinder to the eye.
  flat("ink", "Ink", "Dark", "Light text on near-black. The safest look in the dark.",
    { textColor: "#F4F1EA", backgroundColor: "#14140F", shadow: true }),
  wash("slate", "Slate", "Dark", "Cool grey with a vignette pulling the eye inward.",
    "#3A3F45", "#1C1F23", "#F0F1F2", { shadow: true, texture: "vignette", textureStrength: 0.5 }),
  flat("charcoal", "Charcoal", "Dark", "Flat and neutral; lets a photograph elsewhere do the work.",
    { backgroundColor: "#1A1A1A", textColor: "#EDEDED", texture: "grain", textureStrength: 0.3 }),
  wash("midnight", "Midnight", "Dark", "Deep navy, calmer than black.",
    "#0B1220", "#161E2E", "#E8EDF5", { gradientAngle: 170, texture: "vignette", textureStrength: 0.4 }),
  wash("basalt", "Basalt", "Dark", "Dark stone with a woven surface.",
    "#24262A", "#101113", "#E6E6E4", { gradientAngle: 150, texture: "linen", textureStrength: 0.4 }),
  wash("espresso", "Espresso", "Dark", "Warm dark brown; softer than grey at night.",
    "#2A1F18", "#140E0A", "#F0E4D4", { gradientAngle: 165, texture: "grain", textureStrength: 0.35 }),

  // Colour — when the look should carry something of its own.
  wash("dawn", "Dawn", "Colour", "A warm wash, for a morning service.",
    "#F7EFE2", "#E4C79B", "#2A1F14", { gradientAngle: 155, texture: "grain", textureStrength: 0.3 }),
  wash("evening", "Evening", "Colour", "Deep blue to plum, with a soft grain.",
    "#16263F", "#3C2036", "#F2EFE8", { gradientAngle: 165, shadow: true, texture: "grain", textureStrength: 0.45 }),
  wash("dusk", "Dusk", "Colour", "Violet falling into night.",
    "#3B2A4A", "#1E1630", "#EFE7F5", { gradientAngle: 170, texture: "vignette", textureStrength: 0.45 }),
  wash("harbour", "Harbour", "Colour", "Deep sea blue; steady behind long readings.",
    "#10394F", "#0A2233", "#E6F1F6", { shadow: true }),
  wash("meadow", "Meadow", "Colour", "Forest green, unusual and easy on the eye.",
    "#1F3D2B", "#0F2318", "#E9F2E6", { gradientAngle: 165, texture: "grain", textureStrength: 0.3 }),
  wash("ember", "Ember", "Colour", "Banked coals; warm without shouting.",
    "#4A1F12", "#20100A", "#F8E3D2", { texture: "vignette", textureStrength: 0.4 }),
  wash("amethyst", "Amethyst", "Colour", "Royal purple with a halftone field.",
    "#4B2E63", "#241534", "#F0E6F8", { gradientAngle: 150, texture: "dots", textureStrength: 0.35 }),
  wash("teal", "Teal Wash", "Colour", "The house teal, deepened for projection.",
    "#12403A", "#08211E", "#E4F2EE", { gradientAngle: 170, shadow: true }),

  // Seasonal — the church year, in the colours it is usually kept in.
  wash("advent", "Advent", "Seasonal", "Violet, for the weeks of waiting.",
    "#2B1B4A", "#140C26", "#EDE6FA", { gradientAngle: 165, texture: "dots", textureStrength: 0.4 }),
  wash("carols", "Carols", "Seasonal", "Night blue for candlelit services.",
    "#0E1B33", "#1E2C4A", "#F6F1E4", { gradientAngle: 200, shadow: true, texture: "dots", textureStrength: 0.45 }),
  wash("lent", "Lent", "Seasonal", "Sombre and unadorned.",
    "#3A2E3B", "#1C161D", "#E9E2EA", { texture: "vignette", textureStrength: 0.5 }),
  wash("easter", "Easter", "Seasonal", "White and gold, at the brightest.",
    "#FFF8E7", "#F3D9A4", "#3B2A12", { gradientAngle: 150, texture: "grain", textureStrength: 0.25 }),
  wash("pentecost", "Pentecost", "Seasonal", "Flame red.",
    "#7A1E12", "#3A0C08", "#FFEAD6", { texture: "vignette", textureStrength: 0.4 }),
  wash("harvest", "Harvest", "Seasonal", "Amber and earth, for autumn.",
    "#6B3A12", "#2E1607", "#FBE9CF", { gradientAngle: 158, texture: "grain", textureStrength: 0.35 }),

  // Legibility — when the screen is washed out and nothing else matters.
  flat("contrast", "Bold Contrast", "Legibility", "White on black with an outline. For a washed-out screen.",
    { fontFamily: "helvetica", textColor: "#FFFFFF", outlineWidth: 3, outlineColor: "#000000", backgroundColor: "#000000" }),
  flat("nightOutline", "Night Outline", "Legibility", "Verdana was drawn to be read small and far away.",
    { fontFamily: "verdana", textColor: "#FFFFFF", outlineWidth: 2, outlineColor: "#000000", backgroundColor: "#101010" }),
  flat("daylight", "Daylight", "Legibility", "Black on white. The most light a projector can throw.",
    { fontFamily: "verdana", textColor: "#000000", backgroundColor: "#FFFFFF" }),
  flat("goldOnInk", "Gold on Ink", "Legibility", "The house colours, and a strong contrast besides.",
    { textColor: "#E8B04B", backgroundColor: "#14140F", shadow: true }),
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
