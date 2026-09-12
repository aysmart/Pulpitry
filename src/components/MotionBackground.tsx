import { useEffect, useRef } from "react";

import type { ProjectorTheme } from "../lib/theme";

/**
 * A background that moves, drawn rather than played.
 *
 * # Why not a video loop
 *
 * Moving backgrounds are normally shipped as video: a few hundred megabytes of
 * stock footage, licensed per clip, fixed in colour and resolution. Drawing
 * them instead costs nothing to download, is sharp at any size because there
 * is no source resolution, needs no licence from anybody — and, the part that
 * matters most in a church, **takes its colours from the theme**. A church with
 * a deep blue palette gets deep blue motion rather than somebody else's teal.
 *
 * # What it draws on
 *
 * A canvas capped at 1600 wide however large the screen is. Every one of these
 * is soft by nature — gradients, blurred discs, faint rays — so the cap is
 * invisible and it keeps a 4K projector output from costing eight times what a
 * 1080p one does. The CSS scales it up; the blur hides the difference.
 *
 * # Still where a still is wanted
 *
 * Thumbnails and previews pass `playing = false` and get one frame: a wall of
 * animating panels in a dialog is noise, and the operator is looking at the
 * colours and the shape, not the movement.
 */
export type MotionKind = "drift" | "bokeh" | "rays" | "stars";

const CAP = 1600;

export function MotionBackground({
  theme,
  playing = true,
}: {
  theme: ProjectorTheme;
  playing?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  /*
   * The colours are read inside the effect rather than tracked as
   * dependencies, so that changing a colour in the designer does not restart
   * the animation from its first frame -- a restart reads as a stutter on the
   * wall, and the operator is editing a theme, not scrubbing a clip.
   */
  const look = useRef({
    kind: (theme.motion || "drift") as MotionKind,
    speed: theme.motionSpeed || 1,
    from: theme.gradientFrom || theme.backgroundColor,
    to: theme.gradientTo || theme.backgroundColor,
  });
  look.current = {
    kind: (theme.motion || "drift") as MotionKind,
    speed: theme.motionSpeed || 1,
    from: theme.gradientFrom || theme.backgroundColor,
    to: theme.gradientTo || theme.backgroundColor,
  };

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext("2d");
    if (!context) return;

    let frame = 0;
    let stopped = false;

    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const scale = Math.min(1, CAP / Math.max(width, 1));
      element.width = Math.max(1, Math.round(width * scale));
      element.height = Math.max(1, Math.round(height * scale));
    };
    resize();

    // A projector's window is resized when it moves between monitors, and a
    // preview's box changes with the dialog.
    const watcher = new ResizeObserver(resize);
    watcher.observe(element);

    const draw = (time: number) => {
      if (stopped) return;
      paint(context, element.width, element.height, look.current, time / 1000);
      if (playing) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      watcher.disconnect();
    };
  }, [playing]);

  return <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden="true" />;
}

interface Look {
  kind: MotionKind;
  speed: number;
  from: string;
  to: string;
}

/** One frame of whichever motion the theme asks for. */
function paint(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  seconds: number,
) {
  const t = seconds * look.speed;
  context.clearRect(0, 0, width, height);

  // The ground is the darker of the two, so text keeps the contrast the theme
  // was designed with whatever moves over it.
  context.fillStyle = look.to;
  context.fillRect(0, 0, width, height);

  switch (look.kind) {
    case "bokeh":
      return bokeh(context, width, height, look, t);
    case "rays":
      return rays(context, width, height, look, t);
    case "stars":
      return stars(context, width, height, look, t);
    default:
      return drift(context, width, height, look, t);
  }
}

/**
 * Three wide washes of colour, moving slowly against each other.
 *
 * The default, and the one that suits text best: nothing has an edge, so
 * nothing competes with a letterform. Each wash is larger than the frame, so
 * the movement never brings a boundary into view.
 */
function drift(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const blobs = [
    { hue: look.from, at: 0.0, size: 0.9 },
    { hue: look.to, at: 2.1, size: 1.1 },
    { hue: look.from, at: 4.2, size: 0.7 },
  ];

  context.globalCompositeOperation = "lighter";
  for (const blob of blobs) {
    // Two periods that do not divide into each other, so the pattern does not
    // visibly repeat for minutes rather than seconds.
    const x = width * (0.5 + 0.32 * Math.sin(t * 0.06 + blob.at));
    const y = height * (0.5 + 0.28 * Math.cos(t * 0.043 + blob.at * 1.7));
    const radius = Math.max(width, height) * blob.size;
    const wash = context.createRadialGradient(x, y, 0, x, y, radius);
    wash.addColorStop(0, withAlpha(blob.hue, 0.55));
    wash.addColorStop(1, withAlpha(blob.hue, 0));
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);
  }
  context.globalCompositeOperation = "source-over";
}

/** Soft discs rising, the way light behaves behind a shallow lens. */
function bokeh(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const count = 18;
  context.globalCompositeOperation = "lighter";
  for (let i = 0; i < count; i += 1) {
    // Deterministic rather than random: the same theme draws the same
    // background every service, and a preview matches the wall.
    const seed = (i * 2654435761) % 1000 / 1000;
    const drift = (t * (0.02 + seed * 0.03) + seed) % 1.3;
    const x = width * ((seed * 1.37) % 1);
    const y = height * (1.15 - drift);
    const radius = Math.max(width, height) * (0.03 + seed * 0.07);
    const disc = context.createRadialGradient(x, y, 0, x, y, radius);
    disc.addColorStop(0, withAlpha(look.from, 0.4));
    disc.addColorStop(0.6, withAlpha(look.from, 0.12));
    disc.addColorStop(1, withAlpha(look.from, 0));
    context.fillStyle = disc;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
}

/** Faint beams turning about a point above the frame. */
function rays(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const origin = { x: width * 0.5, y: -height * 0.15 };
  const reach = Math.hypot(width, height) * 1.2;
  const beams = 9;

  context.globalCompositeOperation = "lighter";
  for (let i = 0; i < beams; i += 1) {
    const spread = (Math.PI * 0.9) / beams;
    const angle = Math.PI * 0.05 + i * spread + Math.sin(t * 0.05 + i) * 0.04;
    const breathe = 0.1 + 0.06 * (1 + Math.sin(t * 0.25 + i * 1.3));
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(origin.x + Math.cos(angle) * reach, origin.y + Math.sin(angle) * reach);
    context.lineTo(
      origin.x + Math.cos(angle + spread * 0.55) * reach,
      origin.y + Math.sin(angle + spread * 0.55) * reach,
    );
    context.closePath();
    context.fillStyle = withAlpha(look.from, breathe);
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
}

/** A slow field of points, brightening and fading out of step. */
function stars(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const count = 140;
  for (let i = 0; i < count; i += 1) {
    const seed = ((i * 2246822519) % 10_000) / 10_000;
    const other = ((i * 3266489917) % 10_000) / 10_000;
    const x = ((seed + t * 0.002) % 1) * width;
    const y = other * height;
    const twinkle = 0.25 + 0.35 * (1 + Math.sin(t * 0.7 + i));
    const size = Math.max(width, height) * (0.0008 + seed * 0.0016);
    context.fillStyle = withAlpha(look.from, Math.min(0.9, twinkle));
    context.beginPath();
    context.arc(x, y, size, 0, Math.PI * 2);
    context.fill();
  }
}

/**
 * A colour with an alpha, whatever form the theme wrote it in.
 *
 * Themes hold `#rrggbb`, and canvas gradients need a form that carries
 * transparency. An unparseable colour falls back to white rather than throwing:
 * a background is decoration, and a typo in a hex field must not stop a
 * service.
 */
function withAlpha(colour: string, alpha: number): string {
  const hex = colour.trim().replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (full.length < 6 || Number.isNaN(value)) {
    return `rgba(255, 255, 255, ${alpha})`;
  }
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
