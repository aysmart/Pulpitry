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
  "%3C/svg%3E\")";

/** Named so the settings screen and the renderer cannot disagree. */
export const TEXTURES: Array<{ id: Texture; name: string; hint: string }> = [
  { id: "none", name: "None", hint: "Flat, as chosen" },
  { id: "grain", name: "Grain", hint: "Fine film noise; stops a flat colour looking flat" },
  { id: "linen", name: "Linen", hint: "A woven weave, very subtle at distance" },
  { id: "dots", name: "Dots", hint: "A regular halftone field" },
  { id: "vignette", name: "Vignette", hint: "Darkens the corners, pulling the eye to the words" },
];

/** The layer that sits over the background, if the theme asks for one. */
export function textureStyle(theme: ProjectorTheme): React.CSSProperties | null {
  const strength = Math.min(1, Math.max(0, theme.textureStrength));
  if (theme.texture === "none" || strength === 0) return null;

  switch (theme.texture) {
    case "grain":
      return { backgroundImage: GRAIN, opacity: strength * 0.4, mixBlendMode: "overlay" };
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
export const FONT_FAMILIES: Array<{ key: string; label: string; stack: string }> = [
  { key: "sourceSerif", label: "Source Serif (bundled)", stack: '"Source Serif 4", ui-serif, Georgia, serif' },
  { key: "georgia", label: "Georgia", stack: 'Georgia, "Times New Roman", serif' },
  { key: "palatino", label: "Palatino", stack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif' },
  { key: "baskerville", label: "Baskerville", stack: 'Baskerville, Cambria, Georgia, serif' },
  { key: "times", label: "Times", stack: '"Times New Roman", Times, serif' },
  { key: "system", label: "System sans", stack: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { key: "helvetica", label: "Helvetica / Arial", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { key: "verdana", label: "Verdana", stack: 'Verdana, Geneva, sans-serif' },
  { key: "trebuchet", label: "Trebuchet", stack: '"Trebuchet MS", "Lucida Grande", sans-serif' },
];

export function fontStack(key: string): string {
  return FONT_FAMILIES.find((entry) => entry.key === key)?.stack ?? FONT_FAMILIES[0]!.stack;
}

/**
 * Base type size, before the operator's scale.
 *
 * A long verse and a two-word one cannot share a size, so this steps down by
 * length. Expressed in vw so it holds at any projector resolution.
 */
export function baseSize(body: string): number {
  const length = body.length;
  if (length < 90) return 7;
  if (length < 200) return 5;
  if (length < 400) return 3.6;
  return 2.8;
}

/** CSS for the scripture itself, given the theme. */
export function textStyle(
  theme: ProjectorTheme,
  body: string,
  /**
   * `vw` for a real screen; `cqw` inside a 16:9 box, where it means the same
   * proportion of the width and so previews the projector faithfully.
   */
  unit: "vw" | "cqw" = "vw",
  /** Shrinks the outline, which is authored in px for a projector. */
  outlineScale = 1,
): React.CSSProperties {
  const style: React.CSSProperties = {
    fontFamily: fontStack(theme.fontFamily),
    fontSize: `${(baseSize(body) * theme.fontScale).toFixed(2)}${unit}`,
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
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean.split("").map((part) => part + part).join("")
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

/** Grants the webview read access to a newly chosen background. */
export const allowBackground = (path: string | null) =>
  invoke<void>("set_background", { path });

export const onTheme = (handler: (theme: ProjectorTheme) => void): Promise<UnlistenFn> =>
  listen<ProjectorTheme>(EVENT_THEME, (event) => handler(event.payload));
