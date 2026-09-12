#!/usr/bin/env node
/**
 * Builds the looks Pulpitry ships with.
 *
 *   node scripts/build-looks.mjs
 *
 * Output, in src-tauri/resources/:
 *   looks.json   the manifest the Rust side reads at startup, holding every
 *                look and a checksum over them
 *
 * # Why this exists
 *
 * A church opening a presentation application for the first time should find
 * something that already looks made. Ours had a designer and an empty list:
 * every colour, typeface and background was a decision to take before a single
 * verse could go on a wall, on a Tuesday evening, by a volunteer who came to
 * run a service rather than to design one.
 *
 * These are not examples. Each one is a look a church could use on Sunday
 * without touching it, and each is a *template* in the catalogue, which means
 * an output can be pointed at it: the foyer screen in one look, the stream's
 * lower third in another.
 *
 * # Why a generated file rather than JSON by hand
 *
 * Twenty themes is twenty-eight fields each. Written out by hand that is six
 * hundred values to keep consistent, and the ones that matter -- the palette,
 * the typeface, whether the words carry an outline -- would be lost among the
 * ones that never change. Here each look states only what makes it itself, and
 * the rest comes from the same defaults the application uses.
 *
 * Generated files are committed, so a normal build needs no network and no
 * node script run. Re-run this only to change the looks.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "src-tauri/resources");

/**
 * The same defaults `DEFAULT_THEME` holds in src/lib/theme.ts.
 *
 * Repeated rather than imported: this script writes a resource the Rust side
 * reads, and importing TypeScript into a plain node script would mean a build
 * step for a build step. The Rust side defaults every field it does not find,
 * so a drift here costs nothing worse than a look drawn as the app's default.
 */
const BASE = {
  fontFamily: "sourceSerif",
  fontScale: 1,
  textColor: "#1C1B18",
  outlineWidth: 0,
  outlineColor: "#000000",
  shadow: false,
  backgroundKind: "color",
  backgroundColor: "#F4F1EA",
  gradientFrom: "#F4F1EA",
  gradientTo: "#D9D2C2",
  gradientAngle: 160,
  backgroundPath: null,
  backgroundDim: 0,
  backgroundFit: "",
  backgroundScale: 1,
  backgroundBlur: 0,
  motion: "drift",
  motionSpeed: 1,
  texture: "none",
  textureStrength: 0.35,
  showReference: true,
  referenceFontFamily: "",
  referenceScale: 1,
  referenceColor: "",
  panelColor: "",
  panelTextColor: "",
};

/**
 * Each look states what makes it itself.
 *
 * Ordered as a church would meet them: the quiet ones a congregation can read
 * for twenty minutes first, then the darker ones for a stream, then the ones
 * with movement. Light text on a dark ground carries a shadow rather than an
 * outline -- an outline on light text reads as a sticker, and a shadow is what
 * keeps it legible over a moving background.
 */
const LOOKS = [
  {
    name: "Paper",
    hint: "Warm off-white with a serif. The quietest thing here, and the one a congregation can read longest.",
    theme: { texture: "grain", textureStrength: 0.22 },
  },
  {
    name: "Ink",
    hint: "Near-black ground, warm white words. What most churches mean by a projected verse.",
    theme: {
      textColor: "#F7F3EA",
      backgroundColor: "#14130F",
      shadow: true,
    },
  },
  {
    name: "Slate",
    hint: "A cool grey wash. Neutral enough to sit under anybody's branding.",
    theme: {
      textColor: "#F4F6F8",
      backgroundKind: "gradient",
      gradientFrom: "#2B3440",
      gradientTo: "#131A21",
      gradientAngle: 165,
      shadow: true,
    },
  },
  {
    name: "Midnight",
    hint: "Deep blue, gold reference line. Reads well in a dark hall and on a stream.",
    theme: {
      textColor: "#EDF1F7",
      backgroundKind: "gradient",
      gradientFrom: "#101C33",
      gradientTo: "#060A14",
      gradientAngle: 155,
      shadow: true,
      referenceColor: "#D8B25C",
      panelColor: "#1B2A46",
    },
  },
  {
    name: "Harmattan",
    hint: "Dust and warm light. Built for a hall with sun in it rather than a dark auditorium.",
    theme: {
      textColor: "#2A1C0E",
      backgroundKind: "gradient",
      gradientFrom: "#F6E3C0",
      gradientTo: "#DFB98A",
      gradientAngle: 150,
      texture: "grain",
      textureStrength: 0.25,
      referenceColor: "#7A4A15",
    },
  },
  {
    name: "Palm",
    hint: "Deep green with cream words. A hymn board's colours, which is where this idea comes from.",
    theme: {
      textColor: "#F2EFE2",
      backgroundKind: "gradient",
      gradientFrom: "#123227",
      gradientTo: "#07160F",
      gradientAngle: 160,
      shadow: true,
      referenceColor: "#C9B37A",
    },
  },
  {
    name: "Claret",
    hint: "Dark red and off-white. Communion, Advent, anything with weight to it.",
    theme: {
      textColor: "#F8F1EC",
      backgroundKind: "gradient",
      gradientFrom: "#3B1118",
      gradientTo: "#160608",
      gradientAngle: 165,
      shadow: true,
      referenceColor: "#D9A38C",
    },
  },
  {
    name: "Chalk",
    hint: "Grey-blue board, white chalk. Sans-serif, for a room that wants something plainer than a serif.",
    theme: {
      fontFamily: "system",
      textColor: "#F3F5F4",
      backgroundColor: "#2E3A3A",
      shadow: true,
      texture: "dots",
      textureStrength: 0.18,
    },
  },
  {
    name: "Broadsheet",
    hint: "Newspaper white with Times. Long readings, small rooms, and anybody who wants no design at all.",
    theme: {
      fontFamily: "times",
      textColor: "#111111",
      backgroundColor: "#FBFAF7",
      referenceScale: 0.9,
    },
  },
  {
    name: "Stream",
    hint: "Built for a camera: pure black, generous shadow, a smaller reference so a lower third fits.",
    theme: {
      fontFamily: "helvetica",
      textColor: "#FFFFFF",
      backgroundColor: "#000000",
      shadow: true,
      referenceScale: 0.85,
      referenceColor: "#B9C2CC",
      panelColor: "#111418",
    },
  },
  {
    name: "Vellum",
    hint: "Aged paper and dark brown, with a vignette. For a hymn or a psalm rather than a notice.",
    theme: {
      fontFamily: "palatino",
      textColor: "#30231A",
      backgroundColor: "#F2E8D5",
      texture: "vignette",
      textureStrength: 0.3,
      referenceColor: "#6B4A2E",
    },
  },
  {
    name: "Linen",
    hint: "Woven off-white, Baskerville. The quiet one with a little texture in it.",
    theme: {
      fontFamily: "baskerville",
      textColor: "#232019",
      backgroundColor: "#EFEAE0",
      texture: "linen",
      textureStrength: 0.28,
    },
  },
  {
    name: "Sunrise drift",
    hint: "Amber and rose, moving slowly. Drawn rather than filmed, so it is sharp on any screen.",
    theme: {
      textColor: "#FFF6EC",
      backgroundKind: "motion",
      motion: "drift",
      motionSpeed: 0.75,
      gradientFrom: "#E08A3C",
      gradientTo: "#2A1020",
      shadow: true,
    },
  },
  {
    name: "Deep drift",
    hint: "Blue and violet washes. The one to use when a service wants movement without anything to watch.",
    theme: {
      textColor: "#F0F4FF",
      backgroundKind: "motion",
      motion: "drift",
      motionSpeed: 0.6,
      gradientFrom: "#2B4C9B",
      gradientTo: "#070B1A",
      shadow: true,
    },
  },
  {
    name: "Bokeh gold",
    hint: "Soft lights rising through warm dark. Worship sets, and the ten minutes before a service.",
    theme: {
      textColor: "#FFF8EA",
      backgroundKind: "motion",
      motion: "bokeh",
      motionSpeed: 0.8,
      gradientFrom: "#E7B75F",
      gradientTo: "#150F08",
      shadow: true,
      referenceColor: "#E7C98A",
    },
  },
  {
    name: "Light rays",
    hint: "Beams turning above the words. Slow enough to sit behind a reading.",
    theme: {
      textColor: "#F6F8FF",
      backgroundKind: "motion",
      motion: "rays",
      motionSpeed: 0.5,
      gradientFrom: "#9FC4F0",
      gradientTo: "#0A1424",
      shadow: true,
    },
  },
  {
    name: "Starfield",
    hint: "A slow field of points. Carols, evening services, anything late.",
    theme: {
      textColor: "#F2F5FF",
      backgroundKind: "motion",
      motion: "stars",
      motionSpeed: 0.7,
      gradientFrom: "#DCE6FF",
      gradientTo: "#04070F",
      shadow: true,
      referenceColor: "#9FB0D8",
    },
  },
  {
    name: "Bold sans",
    hint: "Trebuchet, high contrast, no ornament. For a screen read at a distance or in a bright room.",
    theme: {
      fontFamily: "trebuchet",
      fontScale: 1.08,
      textColor: "#FFFFFF",
      backgroundColor: "#1A1A1A",
      shadow: true,
      outlineWidth: 0,
    },
  },
  {
    name: "Overflow",
    hint: "Plain, large and legible for a second room or a corridor screen, where nobody is adjusting anything.",
    theme: {
      fontFamily: "verdana",
      fontScale: 1.12,
      textColor: "#101010",
      backgroundColor: "#FFFFFF",
      showReference: true,
      referenceScale: 0.95,
    },
  },
  {
    name: "Teal card",
    hint: "Mid teal with a panel colour set, for the slide layouts built from cards and quadrants.",
    theme: {
      fontFamily: "system",
      textColor: "#F2FBFA",
      backgroundKind: "gradient",
      gradientFrom: "#0E3B3E",
      gradientTo: "#07201F",
      gradientAngle: 150,
      shadow: true,
      panelColor: "#125257",
      panelTextColor: "#F2FBFA",
      referenceColor: "#8FD2CE",
    },
  },
];

const looks = LOOKS.map((look) => ({
  name: look.name,
  hint: look.hint,
  theme: { ...BASE, ...look.theme },
}));

// Over the looks themselves, so the Rust side re-seeds when they change and
// does nothing on every other launch.
const checksum = createHash("sha256")
  .update(JSON.stringify(looks))
  .digest("hex")
  .slice(0, 16);

mkdirSync(outputDir, { recursive: true });
writeFileSync(
  resolve(outputDir, "looks.json"),
  `${JSON.stringify({ source: "Pulpitry, scripts/build-looks.mjs", checksum, looks }, null, 2)}\n`,
);

console.log(`${looks.length} looks, checksum ${checksum}`);
