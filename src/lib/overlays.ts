import { laidOut, type LiveContent } from "./projector";
import type { ProjectorTheme } from "./theme";

/**
 * The overlay forms an output can be sent as.
 *
 * # What an overlay is, and what it is not
 *
 * A full-screen output is a *picture*: a background, and words on it. That is
 * what a projector wants, and it is useless to a video switcher — which
 * already has a camera to show and needs the words *over* it.
 *
 * An overlay draws only its own furniture on nothing at all. The window is
 * transparent, the capture keeps the alpha and NDI carries it, so the far end
 * keys it over whatever it is already showing. What we send is the template,
 * not a photograph of a screen with the template on it.
 *
 * # Why these are built in rather than designed by the operator
 *
 * A theme is a look: colours, a typeface, a weight. An overlay is an
 * *arrangement*, and the arrangements that work in a broadcast are a small,
 * well-known set — a broadcast has spent sixty years learning where a caption
 * can sit without covering a face. A church should choose from them, colour
 * them with their own theme, and never be asked to invent one at eleven on a
 * Saturday night.
 *
 * So each of these takes the colours, the typeface and the accent from the
 * theme the output already has, and decides only where things go.
 */
export type OverlayForm =
  | "none"
  | "lower-third"
  | "ribbon"
  | "card"
  | "top-strip"
  | "side-panel"
  | "caption"
  | "stage";

export const OVERLAY_FORMS: Array<{
  id: OverlayForm;
  name: string;
  hint: string;
}> = [
  {
    id: "none",
    name: "Whole screen",
    hint: "A background and the words on it. For a projector, and not keyable.",
  },
  {
    id: "lower-third",
    name: "Lower third",
    hint: "A full-width band across the bottom, with the reference on a chip above it. The broadcast standard.",
  },
  {
    id: "ribbon",
    name: "Ribbon",
    hint: "One slim line: the reference at the left, the verse running on from it. Least screen taken.",
  },
  {
    id: "card",
    name: "Corner card",
    hint: "A panel in the bottom-left rather than the full width, for a shot where the speaker stands right.",
  },
  {
    id: "top-strip",
    name: "Top strip",
    hint: "The same band along the top, for a service whose lower third already belongs to somebody else.",
  },
  {
    id: "side-panel",
    name: "Side panel",
    hint: "A column down the right, for a wide shot with room beside the platform.",
  },
  {
    id: "stage",
    name: "Stage display",
    hint: "For the platform only: the timer, what is live, and a line from the desk. Never put this where a congregation can see it.",
  },
  {
    id: "caption",
    name: "Caption only",
    hint: "Words and a soft shadow, no band at all. The quietest, and the one that needs a calm background.",
  },
];

/**
 * Where an overlay's furniture sits, and what it is made of.
 *
 * Returned as plain style objects rather than classes because the projector
 * page draws these over nothing: there is no cascade to inherit from and no
 * stylesheet that could be right for every theme a church builds.
 *
 * Sizes are in `cqw` — hundredths of the output's own width — so a form drawn
 * at 1280 and the same form drawn at 3840 are the same design rather than the
 * same number of pixels.
 */
export interface OverlayPlan {
  /** Where the whole assembly sits in the frame. */
  frame: React.CSSProperties;
  /** The band, card or column behind the words. */
  band: React.CSSProperties;
  /** The verse itself. */
  body: React.CSSProperties;
  /** The reference line. */
  reference: React.CSSProperties;
  /** Whether the reference sits on its own chip above the band. */
  chip: boolean;
  /** Whether the reference sits inline, before the verse. */
  inline: boolean;
}

/** The accent a form leans on, which is the reference colour where set. */
function accentOf(theme: ProjectorTheme): string {
  return theme.panelColor || theme.referenceColor || "#E8590C";
}

/**
 * A colour that will read on the accent.
 *
 * Luminance rather than a guess: a church picking a pale gold accent gets dark
 * text on it and a church picking a deep blue gets light, without either being
 * asked which. The coefficients are the usual perceptual weights.
 */
function onAccent(hex: string): string {
  const clean = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const value = Number.parseInt(clean, 16);
  if (!Number.isFinite(value)) return "#FFFFFF";
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#141414" : "#FFFFFF";
}

export function overlayPlan(
  form: OverlayForm,
  theme: ProjectorTheme,
  /**
   * Whether this output sets its words in capitals.
   *
   * Passed in rather than baked into each form. The forms were written
   * uppercase because a broadcast lower third nearly always is -- short, read
   * in a glance, and capitals hold their shape against a moving picture. That
   * is wrong for the same form carrying four verses: capitals remove the
   * ascenders and descenders a reader's eye uses to tell words apart, and a
   * paragraph of them is markedly slower to read. Which it is depends on the
   * screen, so the screen decides.
   */
  uppercase = false,
): OverlayPlan {
  const accent = accentOf(theme);
  const ink = theme.panelTextColor || onAccent(accent);
  const family = theme.fontFamily;
  const scale = theme.fontScale || 1;

  // Shared by every banded form. Uppercase and tight tracking is what a
  // broadcast lower third does, and it is what makes a verse readable at the
  // size a band allows.
  const banded: React.CSSProperties = {
    fontFamily: `var(--font-${family}, inherit)`,
    color: ink,
    textTransform: uppercase ? "uppercase" : "none",
    // Capitals need the extra tracking; sentence case does not, and gets
    // loose-looking with it.
    letterSpacing: uppercase ? "0.02em" : "0",
    fontWeight: 700,
    lineHeight: 1.25,
  };

  switch (form) {
    case "ribbon":
      return {
        frame: { left: 0, right: 0, bottom: "8cqw", alignItems: "stretch" },
        band: {
          background: accent,
          padding: "1.1cqw 3cqw",
          display: "flex",
          alignItems: "baseline",
          // The citation and the words centre together as a pair. A band the
          // width of the screen with its text at the left edge reads as
          // something that failed to load.
          justifyContent: "center",
          gap: "1.6cqw",
        },
        body: { ...banded, fontSize: `${2.0 * scale}cqw`, textAlign: "center" },
        reference: {
          ...banded,
          fontSize: `${1.5 * scale}cqw`,
          opacity: 0.85,
          whiteSpace: "nowrap",
        },
        chip: false,
        inline: true,
      };

    case "card":
      return {
        frame: {
          left: "5cqw",
          bottom: "7cqw",
          width: "44cqw",
          alignItems: "flex-start",
        },
        band: {
          background: accent,
          padding: "2.4cqw 2.8cqw",
          borderRadius: "0.6cqw",
        },
        body: { ...banded, fontSize: `${2.3 * scale}cqw`, lineHeight: 1.35 },
        reference: { ...banded, fontSize: `${1.35 * scale}cqw` },
        chip: true,
        inline: false,
      };

    case "top-strip":
      return {
        frame: { left: 0, right: 0, top: 0, alignItems: "stretch" },
        band: { background: accent, padding: "1.8cqw 4cqw" },
        body: { ...banded, fontSize: `${2.1 * scale}cqw`, textAlign: "center" },
        reference: { ...banded, fontSize: `${1.3 * scale}cqw` },
        chip: false,
        inline: true,
      };

    case "side-panel":
      return {
        frame: {
          right: 0,
          top: 0,
          bottom: 0,
          width: "30cqw",
          alignItems: "stretch",
          justifyContent: "center",
        },
        band: {
          background: accent,
          padding: "3cqw 2.4cqw",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "1.4cqw",
        },
        body: {
          ...banded,
          fontSize: `${2.0 * scale}cqw`,
          lineHeight: 1.45,
        },
        reference: { ...banded, fontSize: `${1.3 * scale}cqw` },
        chip: false,
        inline: false,
      };

    case "caption":
      // No band at all, so the words carry themselves: a heavy shadow rather
      // than an outline, because an outline on a moving camera shimmers.
      return {
        frame: { left: "8cqw", right: "8cqw", bottom: "8cqw" },
        band: { background: "transparent", padding: 0 },
        body: {
          fontFamily: `var(--font-${family}, inherit)`,
          color: theme.textColor || "#FFFFFF",
          fontSize: `${2.6 * scale}cqw`,
          fontWeight: 700,
          lineHeight: 1.3,
          textAlign: "center",
          textTransform: uppercase ? "uppercase" : "none",
          textShadow: "0 0.25cqw 0.9cqw rgba(0,0,0,0.85)",
        },
        reference: {
          fontFamily: `var(--font-${family}, inherit)`,
          color: theme.referenceColor || theme.textColor || "#FFFFFF",
          fontSize: `${1.4 * scale}cqw`,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          textAlign: "center",
          textShadow: "0 0.2cqw 0.7cqw rgba(0,0,0,0.85)",
        },
        chip: false,
        inline: false,
      };

    case "lower-third":
    default:
      return {
        frame: { left: 0, right: 0, bottom: "6cqw", alignItems: "flex-start" },
        band: { background: accent, padding: "1.9cqw 4cqw", width: "100%" },
        body: { ...banded, fontSize: `${2.2 * scale}cqw`, textAlign: "center" },
        reference: { ...banded, fontSize: `${1.25 * scale}cqw` },
        chip: true,
        inline: false,
      };
  }
}

/** The chip the reference sits on, above a band. Paper rather than accent. */
export function chipStyle(theme: ProjectorTheme): React.CSSProperties {
  return {
    background: theme.backgroundColor || "#F4F1EA",
    color: theme.referenceColor || "#141414",
    padding: "0.55cqw 1.4cqw",
    marginLeft: "4cqw",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    fontWeight: 700,
  };
}

/**
 * A live item as one line of words, for a band that holds one.
 *
 * An overlay has room for a sentence, not a layout. A scripture's verses run
 * together, a lyric's lines do the same, and a composed slide gives up its
 * text in order — which is the honest reduction: a band cannot show a chart,
 * and pretending otherwise puts an empty bar on a stream.
 *
 * Returns null where there is nothing to say, and the caller draws nothing at
 * all rather than an empty band. A band holding no verse is exactly the bug
 * worth not shipping.
 */
export function plainText(
  content: {
    body:
      | { kind: "scripture"; lines: Array<{ number: number; text: string }> }
      | { kind: "lyric"; lines: string[] }
      | { kind: "richText"; blocks: Array<{ text: string }> }
      | { kind: "composed"; components: unknown[] }
      | { kind: string };
  } | null,
): string | null {
  if (!content) return null;
  const body = content.body as Record<string, unknown> & { kind: string };

  const said = (() => {
    switch (body.kind) {
      case "scripture":
        return (body.lines as Array<{ text: string }>)
          .map((line) => line.text)
          .join(" ");
      /*
       * A lyric keeps its breaks, and a passage does not.
       *
       * These were both run together with spaces, so a two-line screenful
       * reached a lower third as one long line that wrapped wherever the band
       * happened to end -- and a congregation reading a stream saw a different
       * shape from the one in the room. A song is broken where the writer broke
       * it and again into screenfuls by the song desk, and both of those
       * decisions are about how it is *sung*. A passage is prose: it has no
       * line breaks to keep, and inventing some would be worse.
       */
      case "lyric":
        return (body.lines as string[]).join("\n");
      case "richText":
        return (body.blocks as Array<{ text: string }>)
          .map((block) => block.text)
          .join("\n");
      case "composed":
        return (body.components as Array<Record<string, unknown>>)
          .filter((component) => component.kind === "text")
          .map((component) => String(component.text ?? ""))
          .join("\n");
      default:
        return "";
    }
  })();

  /*
   * Runs of spaces collapse; line breaks survive.
   *
   * This collapsed every kind of whitespace, newlines included, which was the
   * other half of the same fault: a lyric could keep its breaks all the way to
   * here and still arrive as one line.
   */
  const trimmed = said
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return trimmed ? trimmed : null;
}

/**
 * What an overlay output may draw of what is live — or null, meaning draw
 * nothing at all.
 *
 * # A slide is a whole screen, and cannot be one line of a band
 *
 * A verse, a lyric and a lexicon entry are words, and words go into a band:
 * that is the whole idea of a lower third. A slide is not words. It is a
 * layout -- a heading over a table, three panels across the frame, a chart, a
 * notice board with four things on it -- and the only honest way to show one is
 * to show it, which an overlay by definition cannot do. Flattened into a band
 * it arrives as a run of words with the structure that carried the meaning
 * taken out: "This week Midweek service Wednesday 6:00 PM Prayer meeting
 * Tuesday 6:00 AM" is not what anybody laid out.
 *
 * So slides go to screens of their own and overlays let them pass. An output
 * keyed over a camera simply keeps showing the camera, which is right: the
 * congregation in the room is looking at the notices, and the people watching
 * the stream are looking at whoever is speaking.
 *
 * # Nothing is also an answer
 *
 * Null where nothing is live, which every caller draws as an empty frame. A
 * band holding no verse is the bug worth not shipping -- and a shape a church
 * drew is furniture with holes in it, so a shape with nothing to put in its
 * holes is the same bug with their own logo on it.
 */
export function overlayWords(content: LiveContent | null): string | null {
  if (!content) return null;
  return laidOut(content.body) ? null : plainText(content);
}
