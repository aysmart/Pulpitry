import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const EVENT_THEME = "theme:changed";

export interface ProjectorTheme {
  fontFamily: string;
  fontScale: number;
  textColor: string;
  outlineWidth: number;
  outlineColor: string;
  shadow: boolean;
  backgroundKind: BackgroundKind;
  backgroundColor: string;
  /** Ends of the gradient, and the angle it runs at in degrees. */
  gradientFrom: string;
  gradientTo: string;
  gradientAngle: number;
  backgroundPath: string | null;
  backgroundDim: number;
  texture: Texture;
  /** How strongly the texture reads, 0 to 1. */
  textureStrength: number;
  showReference: boolean;

  /* -- the reference line, which is its own piece of typography -- */

  /**
   * Typeface for the reference. Empty follows the scripture's.
   *
   * Empty rather than a copy of `fontFamily`, so a theme that never touches
   * this keeps following the scripture when the scripture's own typeface is
   * changed later. A copy would silently stop tracking it.
   */
  referenceFontFamily: string;
  /** Multiplies the reference's size. 1 is what it has always been. */
  referenceScale: number;
  /** Colour for the reference. Empty follows the scripture's, for the same
   *  reason the typeface does. */
  referenceColor: string;

  /* -- colour as structure -- */

  /**
   * The fill behind a panel: a card, a step, a quadrant.
   *
   * The theme has only ever described a background and some text on it, which
   * is all a slide of centred lines needs. A slide built from shapes needs a
   * colour that regions are made *of* — and without one those regions can only
   * be outlined, which on a wall reads as a form to fill in rather than as a
   * designed block.
   *
   * Empty derives one from the accent, so every theme that already exists gets
   * structure without anybody opening the editor. The same idiom the reference
   * fields use above, and for the same reason: a theme nobody has touched
   * should keep tracking the palette it was built from rather than freeze a
   * copy of it.
   */
  panelColor: string;
  /** Text on that fill. Empty follows the body's, which the derived fill is
   *  chosen to stay readable under. */
  panelTextColor: string;
}

export type BackgroundKind = "color" | "gradient" | "image" | "video";

export type Texture = "none" | "grain" | "linen" | "dots" | "vignette";

export const DEFAULT_THEME: ProjectorTheme = {
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
  texture: "none",
  textureStrength: 0.35,
  showReference: true,
  // Empty and 1: the reference looks exactly as it did before it was
  // adjustable, so an existing theme is unchanged by this existing.
  referenceFontFamily: "",
  referenceScale: 1,
  referenceColor: "",
  // Derived, for the reason the field explains: a theme saved before panels
  // existed has these empty, and must look considered rather than unfinished.
  panelColor: "",
  panelTextColor: "",
};

/**
 * Grain, as an SVG filter rather than a bitmap.
 *
 * A tiled noise image would be another asset to ship and would visibly repeat
 * across a 1920px wall; feTurbulence is generated at whatever size it is drawn
 * and has no seam. The CSP allows data: images, which is what makes it usable
 * here at all.
 */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E" +
  "%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' " +
  "stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E" +
  '%3C/svg%3E")';

/** Named so the settings screen and the renderer cannot disagree. */
export const TEXTURES: Array<{ id: Texture; name: string; hint: string }> = [
  { id: "none", name: "None", hint: "Flat, as chosen" },
  {
    id: "grain",
    name: "Grain",
    hint: "Fine film noise; stops a flat colour looking flat",
  },
  {
    id: "linen",
    name: "Linen",
    hint: "A woven weave, very subtle at distance",
  },
  { id: "dots", name: "Dots", hint: "A regular halftone field" },
  {
    id: "vignette",
    name: "Vignette",
    hint: "Darkens the corners, pulling the eye to the words",
  },
];

/** The layer that sits over the background, if the theme asks for one. */
export function textureStyle(
  theme: ProjectorTheme,
): React.CSSProperties | null {
  const strength = Math.min(1, Math.max(0, theme.textureStrength));
  if (theme.texture === "none" || strength === 0) return null;

  switch (theme.texture) {
    case "grain":
      return {
        backgroundImage: GRAIN,
        opacity: strength * 0.4,
        mixBlendMode: "overlay",
      };
    case "linen":
      return {
        backgroundImage:
          "repeating-linear-gradient(0deg, rgba(255,255,255,0.5) 0 1px, transparent 1px 3px)," +
          "repeating-linear-gradient(90deg, rgba(0,0,0,0.5) 0 1px, transparent 1px 3px)",
        opacity: strength * 0.22,
      };
    case "dots":
      return {
        backgroundImage: "radial-gradient(currentColor 1px, transparent 1px)",
        backgroundSize: "0.9cqw 0.9cqw",
        color: "rgba(255,255,255,0.9)",
        opacity: strength * 0.18,
      };
    case "vignette":
      return {
        // Not a texture in the literal sense, but it earns its place here: it
        // is the cheapest way to keep words legible over a bright background.
        background: `radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,${(
          strength * 0.7
        ).toFixed(2)}) 100%)`,
      };
    default:
      return null;
  }
}

/** The base layer: a colour, a wash of two, or nothing when a file is behind. */
export function backgroundStyle(theme: ProjectorTheme): React.CSSProperties {
  if (theme.backgroundKind === "gradient") {
    return {
      backgroundImage: `linear-gradient(${theme.gradientAngle}deg, ${theme.gradientFrom}, ${theme.gradientTo})`,
    };
  }
  return { backgroundColor: theme.backgroundColor };
}

/**
 * Families available without bundling more fonts.
 *
 * Every stack ends in a generic, and each names the equivalent on both
 * platforms — Palatino and Book Antiqua are the same design under two names,
 * as are Baskerville and Cambria closely enough for projection.
 */
export const FONT_FAMILIES: Array<{
  key: string;
  label: string;
  stack: string;
}> = [
  {
    key: "sourceSerif",
    label: "Source Serif (bundled)",
    stack: '"Source Serif 4", ui-serif, Georgia, serif',
  },
  {
    key: "georgia",
    label: "Georgia",
    stack: 'Georgia, "Times New Roman", serif',
  },
  {
    key: "palatino",
    label: "Palatino",
    stack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif',
  },
  {
    key: "baskerville",
    label: "Baskerville",
    stack: "Baskerville, Cambria, Georgia, serif",
  },
  { key: "times", label: "Times", stack: '"Times New Roman", Times, serif' },
  {
    key: "system",
    label: "System sans",
    stack: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  {
    key: "helvetica",
    label: "Helvetica / Arial",
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  { key: "verdana", label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  {
    key: "trebuchet",
    label: "Trebuchet",
    stack: '"Trebuchet MS", "Lucida Grande", sans-serif',
  },
];

export function fontStack(key: string): string {
  return (
    FONT_FAMILIES.find((entry) => entry.key === key)?.stack ??
    FONT_FAMILIES[0]!.stack
  );
}

/**
 * How the reference beneath the words is set.
 *
 * # Why it is not simply the scripture, smaller
 *
 * It is a different thing being said. The verse is what the congregation is
 * reading; "John 3:16 (KJV)" is a citation, and a service sheet or a broadcast
 * lower third would set it in another face, or another weight, or the accent
 * colour of the church's branding. Following the scripture is the sensible
 * default and was the only option; it should not have been the only option.
 *
 * An empty family or colour means "follow the scripture", and is stored empty
 * rather than as a copy so that changing the scripture's typeface later still
 * moves the reference with it.
 *
 * `unit` is the same choice the body makes: a fraction of the width of the box
 * being drawn into, so every surface showing this agrees.
 */
export function referenceStyle(
  theme: ProjectorTheme,
  unit: "cqw" = "cqw",
): React.CSSProperties {
  return {
    fontFamily: fontStack(theme.referenceFontFamily || theme.fontFamily),
    color: theme.referenceColor || theme.textColor,
    // 1.6 is the size the reference has always been drawn at, so a scale of 1
    // changes nothing anywhere.
    fontSize: `${(REFERENCE_SIZE * (theme.referenceScale || 1)).toFixed(2)}${unit}`,
  };
}

/** The reference's size before the operator's scale, as a fraction of width. */
const REFERENCE_SIZE = 1.6;

/**
 * Base type size, before the operator's scale.
 *
 * A long verse and a two-word one cannot share a size, so this steps down by
 * length. Expressed in vw so it holds at any projector resolution.
 */
export function baseSize(body: string, floor = 0): number {
  const length = body.length;
  const fitted = length < 90 ? 7 : length < 200 ? 5 : length < 400 ? 3.6 : 2.8;
  /*
   * `floor` is for text that is never expected to fit.
   *
   * The sizes above exist to make a passage fit one screen, which is the right
   * trade when the alternative is clipping it. It is the wrong trade for a
   * lexicon entry: that runs to thousands of characters, so the scale bottoms
   * out at its smallest setting and puts three hundred words on a wall at a
   * size nobody past the front row can read -- to fit something that was never
   * going to fit.
   *
   * Those bodies are wound instead, so they can be set for reading and run off
   * the bottom on purpose.
   */
  return Math.max(fitted, floor);
}

/** CSS for the scripture itself, given the theme. */
export function textStyle(
  theme: ProjectorTheme,
  body: string,
  /**
   * Always `cqw` now: a fraction of the width of the box being drawn into.
   *
   * It used to be `vw` on the real screen and `cqw` in a preview, which is the
   * same proportion only when the preview box is exactly the shape of the
   * display. It never reliably was, so the wall and the two panes claiming to
   * preview it wrapped at different points and showed different numbers of
   * lines. One unit, measured against whatever box each surface actually has,
   * removes the question.
   */
  unit: "cqw" = "cqw",
  /** Shrinks the outline, which is authored in px for a projector. */
  outlineScale = 1,
  /** Smallest setting this body may be shrunk to; see [`baseSize`]. */
  floor = 0,
): React.CSSProperties {
  const style: React.CSSProperties = {
    fontFamily: fontStack(theme.fontFamily),
    fontSize: `${(baseSize(body, floor) * theme.fontScale).toFixed(2)}${unit}`,
    color: theme.textColor,
  };

  if (theme.outlineWidth > 0) {
    // paint-order matters: without it the stroke is centred on the glyph edge
    // and eats into the letterforms, which at projector size looks like a
    // bolder, muddier typeface rather than an outline.
    style.WebkitTextStrokeWidth = `${theme.outlineWidth * outlineScale}px`;
    style.WebkitTextStrokeColor = theme.outlineColor;
    style.paintOrder = "stroke fill";
  }

  if (theme.shadow) {
    style.textShadow = "0 0.06em 0.14em rgba(0,0,0,0.55)";
  }

  return style;
}

/**
 * A hex colour at a given opacity.
 *
 * The pickers hand back `#RRGGBB`, and a scrim needs alpha; keeping the two
 * apart means the operator picks a colour and a strength rather than reasoning
 * about an eight-digit hex.
 */
/**
 * The fill and the text for a panel, resolved.
 *
 * A tint of the accent rather than a solid block of it, and that is the whole
 * judgement here. A solid accent panel needs its own text colour, needs to
 * contrast with both the background *and* the body text, and gets one of those
 * wrong on some theme somebody will build. A tint sits over whatever is behind
 * it — colour, gradient or photograph — reads as a region, and leaves the body
 * colour still legible on it, which is why the text half can default to the
 * body's own.
 *
 * A church wanting a solid brand block sets `panelColor` and gets exactly that.
 */
export function panelStyle(theme: ProjectorTheme): {
  fill: string;
  text: string;
} {
  const accent = theme.referenceColor || theme.textColor;
  return {
    fill: theme.panelColor || withAlpha(accent, 0.14),
    text: theme.panelTextColor || theme.textColor,
  };
}

export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((part) => part + part)
          .join("")
      : clean.padEnd(6, "0").slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return `rgba(0,0,0,${alpha})`;
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${Math.min(
    1,
    Math.max(0, alpha),
  )})`;
}

/** Resolves a local file path to something the webview may load. */
export function backgroundUrl(theme: ProjectorTheme): string | null {
  if (theme.backgroundKind === "color" || !theme.backgroundPath) return null;
  return convertFileSrc(theme.backgroundPath);
}

export const getTheme = () => invoke<ProjectorTheme>("get_theme");

/**
 * The theme this particular window should draw with.
 *
 * Asked by the window, of itself. Content is broadcast to every output --
 * they must agree about what is live -- and appearance is fetched, because
 * they need not agree about anything else. An output with no template of its
 * own is answered with the shared theme, which is what every window had
 * before there was more than one kind.
 */
export const themeForWindow = (label: string) =>
  invoke<WindowLook>("theme_for_window", { label });

/** How one window should draw: its look, and the shape it draws in. */
export interface WindowLook {
  theme: ProjectorTheme;
  /** An overlay form id, or "none" for the whole screen. */
  overlay: string;
  /** The translation to draw scripture in. Empty follows the panel. */
  translation: string;
  /** Whether this window sets its words in capitals. */
  uppercase: boolean;
  /** A stage display's two halves, each of which can be turned off. */
  stageClock: boolean;
  stageLive: boolean;
}

/** Grants the webview read access to a newly chosen background. */
export const allowBackground = (path: string | null) =>
  invoke<void>("set_background", { path });

export const onTheme = (
  handler: (theme: ProjectorTheme) => void,
): Promise<UnlistenFn> =>
  listen<ProjectorTheme>(EVENT_THEME, (event) => handler(event.payload));
