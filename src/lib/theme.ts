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
  backgroundKind: "color" | "image" | "video";
  backgroundColor: string;
  backgroundPath: string | null;
  backgroundDim: number;
  showReference: boolean;
}

export const DEFAULT_THEME: ProjectorTheme = {
  fontFamily: "sourceSerif",
  fontScale: 1,
  textColor: "#1C1B18",
  outlineWidth: 0,
  outlineColor: "#000000",
  shadow: false,
  backgroundKind: "color",
  backgroundColor: "#F4F1EA",
  backgroundPath: null,
  backgroundDim: 0,
  showReference: true,
};

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
export function textStyle(theme: ProjectorTheme, body: string): React.CSSProperties {
  const style: React.CSSProperties = {
    fontFamily: fontStack(theme.fontFamily),
    fontSize: `${(baseSize(body) * theme.fontScale).toFixed(2)}vw`,
    color: theme.textColor,
  };

  if (theme.outlineWidth > 0) {
    // paint-order matters: without it the stroke is centred on the glyph edge
    // and eats into the letterforms, which at projector size looks like a
    // bolder, muddier typeface rather than an outline.
    style.WebkitTextStrokeWidth = `${theme.outlineWidth}px`;
    style.WebkitTextStrokeColor = theme.outlineColor;
    style.paintOrder = "stroke fill";
  }

  if (theme.shadow) {
    style.textShadow = "0 0.06em 0.14em rgba(0,0,0,0.55)";
  }

  return style;
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
