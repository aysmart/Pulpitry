import { useEffect, useRef } from "react";

import { withAlpha, type ProjectorTheme } from "../lib/theme";

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
export type MotionKind =
  | "drift"
  | "bokeh"
  | "rays"
  | "stars"
  | "aurora"
  | "waves"
  | "embers"
  | "ripple"
  | "orbs"
  | "dust";

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
    case "aurora":
      return aurora(context, width, height, look, t);
    case "waves":
      return waves(context, width, height, look, t);
    case "embers":
      return embers(context, width, height, look, t);
    case "ripple":
      return ripple(context, width, height, look, t);
    case "orbs":
      return orbs(context, width, height, look, t);
    case "dust":
      return dust(context, width, height, look, t);
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
 * Curtains of light, leaning and folding.
 *
 * The one motion with a direction to it: bands that lean, thin and thicken as
 * they cross. Drawn as soft vertical gradients rather than shapes, because an
 * aurora has no edges and anything with one reads as a graphic.
 */
function aurora(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const curtains = 5;
  context.globalCompositeOperation = "lighter";
  for (let i = 0; i < curtains; i += 1) {
    const phase = t * (0.05 + i * 0.011) + i * 1.7;
    const centre = width * (0.5 + 0.42 * Math.sin(phase));
    const spread = width * (0.1 + 0.07 * (1 + Math.sin(phase * 0.7)));
    const lean = height * 0.22 * Math.sin(phase * 0.5);

    const band = context.createLinearGradient(
      centre - spread,
      0,
      centre + spread + lean,
      height,
    );
    const hue = i % 2 === 0 ? look.from : look.to;
    band.addColorStop(0, withAlpha(hue, 0));
    band.addColorStop(0.5, withAlpha(hue, 0.3));
    band.addColorStop(1, withAlpha(hue, 0));
    context.fillStyle = band;
    context.fillRect(0, 0, width, height);
  }
  context.globalCompositeOperation = "source-over";
}

/**
 * Long swells crossing the bottom of the frame.
 *
 * Kept low and slow: the words sit in the middle, and a wave that reached them
 * would be something to watch rather than something to read over.
 */
function waves(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const lines = 4;
  context.globalCompositeOperation = "lighter";
  for (let i = 0; i < lines; i += 1) {
    const base = height * (0.62 + i * 0.1);
    const amplitude = height * (0.035 + i * 0.012);
    const speed = t * (0.18 + i * 0.05);

    context.beginPath();
    context.moveTo(0, height);
    for (let x = 0; x <= width; x += Math.max(6, width / 160)) {
      const across = x / width;
      const y =
        base +
        Math.sin(across * Math.PI * 2 + speed) * amplitude +
        Math.sin(across * Math.PI * 5.3 - speed * 0.6) * amplitude * 0.35;
      context.lineTo(x, y);
    }
    context.lineTo(width, height);
    context.closePath();
    context.fillStyle = withAlpha(i % 2 === 0 ? look.from : look.to, 0.16);
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
}

/**
 * Sparks rising and going out, the way they do over a fire.
 *
 * Each keeps its own speed and its own life, so nothing pulses together -- a
 * field that breathes in step reads as an animation rather than as air.
 */
function embers(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const count = 90;
  context.globalCompositeOperation = "lighter";
  for (let i = 0; i < count; i += 1) {
    const seed = ((i * 2246822519) % 10_000) / 10_000;
    const other = ((i * 3266489917) % 10_000) / 10_000;
    const life = (t * (0.05 + seed * 0.07) + other) % 1;

    const x = width * (other + Math.sin(t * 0.3 + i) * 0.02);
    const y = height * (1.05 - life * 1.1);
    const size = Math.max(width, height) * (0.0012 + seed * 0.0022);
    // Brightest in the middle of the climb, out by the top.
    const glow = Math.sin(life * Math.PI) * 0.7;

    context.fillStyle = withAlpha(look.from, glow);
    context.beginPath();
    context.arc(x, y, size, 0, Math.PI * 2);
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
}

/** Rings opening outwards, as slow as rain on still water. */
function ripple(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const rings = 6;
  const reach = Math.hypot(width, height) * 0.55;
  context.globalCompositeOperation = "lighter";
  context.lineWidth = Math.max(1, Math.max(width, height) * 0.004);

  for (let i = 0; i < rings; i += 1) {
    const seed = ((i * 2654435761) % 10_000) / 10_000;
    const grown = (t * 0.09 + i / rings) % 1;
    const x = width * (0.2 + seed * 0.6);
    const y = height * (0.25 + ((seed * 7) % 1) * 0.5);

    context.beginPath();
    context.arc(x, y, grown * reach, 0, Math.PI * 2);
    // Fading as it widens: a ring that stayed bright would be a circle drawn
    // on the wall rather than something spreading across it.
    context.strokeStyle = withAlpha(look.from, 0.28 * (1 - grown));
    context.stroke();
  }
  context.globalCompositeOperation = "source-over";
}

/** Large soft spheres, crossing each other slowly. */
function orbs(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const count = 5;
  context.globalCompositeOperation = "lighter";
  for (let i = 0; i < count; i += 1) {
    const seed = ((i * 2246822519) % 10_000) / 10_000;
    const x = width * (0.5 + 0.4 * Math.sin(t * (0.03 + seed * 0.02) + i * 1.9));
    const y = height * (0.5 + 0.36 * Math.cos(t * (0.024 + seed * 0.017) + i));
    const radius = Math.max(width, height) * (0.16 + seed * 0.18);

    const sphere = context.createRadialGradient(x, y, 0, x, y, radius);
    const hue = i % 2 === 0 ? look.from : look.to;
    sphere.addColorStop(0, withAlpha(hue, 0.34));
    sphere.addColorStop(0.6, withAlpha(hue, 0.12));
    sphere.addColorStop(1, withAlpha(hue, 0));
    context.fillStyle = sphere;
    context.fillRect(0, 0, width, height);
  }
  context.globalCompositeOperation = "source-over";
}

/** Motes drifting sideways, the way dust moves through a shaft of light. */
function dust(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: Look,
  t: number,
) {
  const count = 120;
  context.globalCompositeOperation = "lighter";
  for (let i = 0; i < count; i += 1) {
    const seed = ((i * 2246822519) % 10_000) / 10_000;
    const other = ((i * 3266489917) % 10_000) / 10_000;
    // Sideways rather than up, and at three different speeds, so the field has
    // depth rather than being one sheet sliding past.
    const speed = 0.01 + (i % 3) * 0.012;
    const x = ((seed + t * speed) % 1.1 - 0.05) * width;
    const y = height * (other + Math.sin(t * 0.2 + i) * 0.01);
    const size = Math.max(width, height) * (0.0006 + seed * 0.0018);

    context.fillStyle = withAlpha(look.from, 0.18 + other * 0.3);
    context.beginPath();
    context.arc(x, y, size, 0, Math.PI * 2);
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
}

/**
 * A colour with an alpha, whatever form the theme wrote it in.
 *
 * Themes hold `#rrggbb`, and canvas gradients need a form that carries
 * transparency. An unparseable colour falls back to white rather than throwing:
 * a background is decoration, and a typo in a hex field must not stop a
 * service.
 */
/*
 * The shared one, deliberately.
 *
 * This file kept a copy, which was harmless while a colour was six digits and
 * wrong the moment one could carry its own alpha: a motion background built
 * from a gradient the operator had set to a third would have been drawn at full
 * strength here and at a third everywhere else. The shared helper multiplies,
 * so the two agree.
 */
