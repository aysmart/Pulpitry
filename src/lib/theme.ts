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
  /** "cover" | "contain" | "fill". Empty means cover. */
  backgroundFit: string;
  /** Scales the picture about its centre. 1.0 is untouched. */
  backgroundScale: number;
  /** Blurs the picture, in pixels at 1080p. 0 is off. */
  backgroundBlur: number;
  /**
   * Which drawn motion the background is, when the kind is "motion".
   *
   * Drawn rather than played: see MotionBackground. It takes its colours from
   * the gradient ends, so a church's own palette moves rather than somebody
   * else's stock footage.
   */
  motion: string;
  /** Multiplies how fast it moves. 1 is as designed; 0.5 is half as fast. */
  motionSpeed: number;
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

  /* -- how the type is set -- */

  /**
   * These seven were fixed in the renderer: centred, in the middle of the
   * frame, 1.3 leading, no tracking, the typeface's own weight, and a shadow
   * that was on or off. Each is a decision a church makes about their room —
   * words ranged left under a logo in the corner, a heavier weight for a hall
   * with sun in it — and none of them could be made.
   *
   * Defaulted to exactly what the renderer already did, so every theme and
   * every shipped look is drawn as it was.
   */
  align: "left" | "center" | "right";
  vertical: "top" | "middle" | "bottom";
  /** Multiplied by the font size. */
  lineHeight: number;
  /** Tracking, in pixels at 1080p. Negative tightens. */
  letterSpacing: number;
  /** 300 to 900. Zero means the typeface's own. */
  fontWeight: number;
  /** Applied when drawn, never to the stored words. */
  textCase: "" | "none" | "upper" | "title" | "lower";
  /** How strongly the shadow reads, 1 to 5. Ignored when `shadow` is off. */
  shadowLevel: number;
}

export type BackgroundKind = "color" | "gradient" | "image" | "video" | "motion";

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
  backgroundFit: "",
  backgroundScale: 1,
  backgroundBlur: 0,
  motion: "drift",
  motionSpeed: 1,
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
  align: "center",
  vertical: "middle",
  lineHeight: 1.3,
  letterSpacing: 0,
  fontWeight: 0,
  textCase: "",
  shadowLevel: 2,
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
  const bundled = FONT_FAMILIES.find((entry) => entry.key === key);
  if (bundled) return bundled.stack;
  if (!key.trim()) return FONT_FAMILIES[0]!.stack;

  /*
   * A family installed on this machine, named as the system reports it.
   *
   * Quoted, because family names have spaces in them, and with the bundled
   * serif behind it — which is what makes a deck portable. A church's own
   * typeface is on the machine that made the deck; carried to another church,
   * or opened on the laptop that covers when the usual one fails, the words
   * still read rather than falling back to whatever the browser defaults to.
   *
   * The quotation marks are stripped from the name first: a family cannot
   * contain one, and a stray quote would end the declaration early and take
   * the fallback with it.
   */
  return `"${key.replace(/["\\;]/g, "").trim()}", ${FONT_FAMILIES[0]!.stack}`;
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
  const size = baseSize(body, floor) * theme.fontScale;
  const style: React.CSSProperties = {
    fontFamily: fontStack(theme.fontFamily),
    fontSize: `${size.toFixed(2)}${unit}`,
    color: theme.textColor,
    /*
     * Leading, tracking and weight are inline rather than in a class, because
     * every surface that draws words already carries `leading-[1.3]` from the
     * days when that was the only answer, and a declaration here wins over the
     * class. An arranged slide sets its own after spreading this, so a heading
     * keeps its tight leading.
     *
     * Alignment is deliberately *not* here. A composed slide's alignment is its
     * layout's decision -- a heading ranged left under a hanging rule, a list
     * ranged left beneath it -- and those are set as classes, which an inline
     * declaration would silently overrule. It is applied by the bodies that
     * have no layout of their own: see `alignOf`.
     */
    lineHeight: theme.lineHeight || 1.3,
    fontWeight: theme.fontWeight || undefined,
    // Tracking is authored in pixels against a 1920 screen and has to scale
    // with the type, or a wide setting becomes a word per line in a preview.
    letterSpacing: theme.letterSpacing
      ? `${((theme.letterSpacing / 1920) * 100).toFixed(3)}cqw`
      : undefined,
    textTransform: caseOf(theme),
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
    style.textShadow = shadowOf(theme.shadowLevel);
  }

  return style;
}

/**
 * The shadow, in five strengths rather than on and off.
 *
 * A shadow is doing one of two different jobs and the same one cannot do both:
 * lifting light words a little off a gradient, or keeping them readable over a
 * photograph of a sky. The offset and blur grow together, in ems, so a shadow
 * holds its proportion at every size.
 */
export function shadowOf(level: number): string {
  const steps = [
    "none",
    "0 0.03em 0.07em rgba(0,0,0,0.45)",
    "0 0.06em 0.14em rgba(0,0,0,0.55)",
    "0 0.07em 0.2em rgba(0,0,0,0.65)",
    "0 0.08em 0.28em rgba(0,0,0,0.75)",
    "0 0.1em 0.36em rgba(0,0,0,0.85)",
  ];
  return steps[Math.max(0, Math.min(5, Math.round(level || 2)))]!;
}

/**
 * How plain words are ranged.
 *
 * Applied only to the bodies with no arrangement of their own -- a passage, a
 * lyric, a written slide. An arranged slide's alignment belongs to its layout,
 * and overruling that from the theme would range a heading's hanging rule away
 * from the heading it hangs over.
 */
export function alignOf(theme: ProjectorTheme): React.CSSProperties {
  return { textAlign: theme.align || "center" };
}

/** What the theme does to the case of the words, as CSS names it. */
export function caseOf(theme: ProjectorTheme): React.CSSProperties["textTransform"] {
  switch (theme.textCase) {
    case "upper":
      return "uppercase";
    case "lower":
      return "lowercase";
    case "title":
      return "capitalize";
    default:
      return undefined;
  }
}

/**
 * Where the words sit in the frame.
 *
 * Returned as a style rather than applied here, because the frame belongs to
 * each surface: the projector's 16:9 box, the preview panes, a thumbnail. Each
 * puts it on the flex column it already has.
 */
export function verticalStyle(theme: ProjectorTheme): React.CSSProperties {
  return {
    justifyContent:
      theme.vertical === "top"
        ? "flex-start"
        : theme.vertical === "bottom"
          ? "flex-end"
          : "center",
  };
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

/**
 * A colour's digits, whatever shape it was written in.
 *
 * Three, six or eight, with or without a hash: `#FFF`, `ffffff`, `#FFFFFF80`.
 * Eight is six plus alpha, which CSS understands natively — so a colour with
 * alpha needs no special handling anywhere it is *drawn*, only where it is
 * picked apart.
 */
function digits(hex: string): { rgb: string; alpha: number } | null {
  const clean = hex.trim().replace("#", "");
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null;

  if (clean.length === 3 || clean.length === 4) {
    const doubled = clean
      .split("")
      .map((part) => part + part)
      .join("");
    return {
      rgb: doubled.slice(0, 6),
      alpha: clean.length === 4 ? Number.parseInt(doubled.slice(6, 8), 16) / 255 : 1,
    };
  }
  if (clean.length === 6) return { rgb: clean, alpha: 1 };
  if (clean.length === 8) {
    return {
      rgb: clean.slice(0, 6),
      alpha: Number.parseInt(clean.slice(6, 8), 16) / 255,
    };
  }
  return null;
}

/** The opaque part of a colour, as `<input type="color">` requires it. */
export function rgbOf(hex: string): string {
  return `#${digits(hex)?.rgb ?? "000000"}`;
}

/** How transparent a colour is, 0 to 100, as the editors show it. */
export function alphaOf(hex: string): number {
  return Math.round((digits(hex)?.alpha ?? 1) * 100);
}

/**
 * The same colour at a different alpha.
 *
 * Stored as six digits at full opacity and eight below it, so a colour nobody
 * has made transparent stays exactly the string it always was — which keeps
 * every theme, look and deck saved before alpha existed byte-identical.
 */
export function withColourAlpha(hex: string, percent: number): string {
  const parts = digits(hex);
  const rgb = parts?.rgb ?? "000000";
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (clamped >= 100) return `#${rgb}`;
  const byte = Math.round((clamped / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${rgb}${byte}`;
}

/**
 * What somebody typed, as a colour, or nothing.
 *
 * Returns null rather than a guess while a field is half-typed: "#ff" is not a
 * colour yet, and turning it into one would fight the person typing it.
 */
export function readColour(raw: string): string | null {
  const parts = digits(raw);
  if (!parts) return null;
  return parts.alpha >= 1
    ? `#${parts.rgb}`
    : withColourAlpha(`#${parts.rgb}`, parts.alpha * 100);
}

/**
 * A colour at a fraction of its own opacity.
 *
 * Multiplies rather than replaces: a hairline derived at 0.45 from a text
 * colour the church already set to 80% should be 0.36, not 0.45. Before alpha
 * could be stored that distinction could not arise, and the stored alpha was
 * silently dropped here.
 */
export function withAlpha(hex: string, alpha: number): string {
  const parts = digits(hex);
  if (!parts) return `rgba(0,0,0,${alpha})`;
  const value = Number.parseInt(parts.rgb, 16);
  if (!Number.isFinite(value)) return `rgba(0,0,0,${alpha})`;
  const combined = Math.min(1, Math.max(0, alpha)) * parts.alpha;
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${combined})`;
}

/**
 * How the picture sits in the frame.
 *
 * One place, so the projector, the stage panes, the slide editor and the
 * thumbnails cannot disagree -- an operator who blurs a photograph and sees it
 * sharp on the wall has been lied to, which is the whole reason `Backdrop`
 * exists as one component.
 *
 * The blur is scaled by the container rather than fixed in pixels: the same
 * theme is drawn at 1920 on a wall and at 320 in a thumbnail, and a 40px blur
 * would erase the thumbnail entirely. Expressed against a 1080p frame's width,
 * as every other size in this file is.
 *
 * `cqw` rather than `cqh`, and that is not a preference. The thumbnails are
 * `container-type: inline-size`, which has no block size to measure -- `cqh`
 * there silently falls back to the viewport, so a gentle blur on a wall would
 * have been an opaque smear in every thumbnail. Width works in both kinds of
 * container, and the frames are 16:9 either way.
 *
 * A blurred picture is also scaled up a little, always. Blur samples beyond
 * the edge of the image and leaves a soft transparent border where there is
 * nothing to sample -- a pale halo round all four sides of the screen, which
 * looks like a fault. Growing it past the frame puts that edge outside.
 */
export function pictureStyle(theme: ProjectorTheme): React.CSSProperties {
  const fit = theme.backgroundFit || "cover";
  const blur = Math.max(0, theme.backgroundBlur || 0);
  // 1.06 covers the softest edge a large blur leaves; more would crop a
  // "contain" picture that was chosen to be seen whole.
  const bleed = blur > 0 ? 1.06 : 1;
  const scale = Math.max(0.2, theme.backgroundScale || 1) * bleed;

  return {
    objectFit:
      fit === "fill" ? "fill" : fit === "contain" ? "contain" : "cover",
    transform: scale === 1 ? undefined : `scale(${scale})`,
    filter:
      blur > 0 ? `blur(${((blur / 1920) * 100).toFixed(3)}cqw)` : undefined,
  };
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
