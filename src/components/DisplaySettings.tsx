import { open } from "@tauri-apps/plugin-dialog";

import { allowBackground, TEXTURES, type ProjectorTheme } from "../lib/theme";

import { FontPicker, Slider, Swatch } from "./Controls";

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring";

/**
 * Appearance of the projector output.
 *
 * The controls are grouped by the problem they solve rather than by CSS
 * property: choosing type, then keeping it readable over whatever is behind it.
 */
/**
 * The drawn motions, in the order they suit words.
 *
 * Drift first because nothing in it has an edge, which is what a screen
 * carrying a verse wants; the others are for a room that wants something to
 * look at between items.
 */
const MOTIONS: Array<{ id: string; name: string; hint: string }> = [
  {
    id: "drift",
    name: "Drift",
    hint: "Wide washes of colour moving against each other. Nothing has an edge, so nothing competes with the words.",
  },
  {
    id: "bokeh",
    name: "Bokeh",
    hint: "Soft discs rising, the way light behaves behind a shallow lens.",
  },
  {
    id: "rays",
    name: "Rays",
    hint: "Faint beams turning slowly about a point above the screen.",
  },
  {
    id: "orbs",
    name: "Spheres",
    hint: "Large soft spheres crossing each other. The quietest of the moving ones after Drift.",
  },
  {
    id: "aurora",
    name: "Aurora",
    hint: "Curtains of light leaning and folding. Colour with a direction to it.",
  },
  {
    id: "embers",
    name: "Embers",
    hint: "Sparks rising and going out. Warm palettes; a hall before an evening service.",
  },
  {
    id: "waves",
    name: "Swells",
    hint: "Long slow swells across the bottom of the screen, well clear of the words.",
  },
  {
    id: "ripple",
    name: "Ripples",
    hint: "Rings opening outwards, as slow as rain on still water.",
  },
  {
    id: "dust",
    name: "Motes",
    hint: "Dust drifting sideways through a shaft of light. Barely there, which is the point.",
  },
  {
    id: "stars",
    name: "Stars",
    hint: "A slow field of points, brightening and fading out of step.",
  },
];

export function DisplaySettings({
  theme,
  onChange,
  onError,
  /** Off when these controls are already inside the Themes tab. */
  showThemesHint = true,
}: {
  theme: ProjectorTheme;
  onChange: (next: ProjectorTheme) => void;
  onError: (message: string) => void;
  showThemesHint?: boolean;
}) {
  const set = <K extends keyof ProjectorTheme>(
    key: K,
    value: ProjectorTheme[K],
  ) => onChange({ ...theme, [key]: value });

  const pickBackground = async (kind: "image" | "video") => {
    try {
      const path = await open({
        title:
          kind === "image"
            ? "Choose a background image"
            : "Choose a background video",
        multiple: false,
        directory: false,
        filters: [
          kind === "image"
            ? {
                name: "Images",
                extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
              }
            : { name: "Video", extensions: ["mp4", "mov", "m4v", "webm"] },
        ],
      });
      if (typeof path !== "string") return;

      // The webview can read no arbitrary file; this grants access to exactly
      // the one just chosen.
      await allowBackground(path);
      onChange({ ...theme, backgroundKind: kind, backgroundPath: path });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  // A gradient has no file behind it, so it must not offer to name one.
  const usingMedia =
    theme.backgroundKind === "image" || theme.backgroundKind === "video";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        {/* Any face on the machine, not only the bundled ones: a church with
            a brand has a typeface, and it is already installed here. */}
        <div className="flex flex-[2]">
          <FontPicker
            label="Typeface"
            value={theme.fontFamily}
            onChange={(family) => set("fontFamily", family)}
            className={FIELD}
          />
        </div>
        <div className="flex flex-1 flex-col justify-end">
          <Slider
            label="Size"
            value={theme.fontScale}
            min={0.5}
            max={2}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(value) => set("fontScale", value)}
          />
        </div>
      </div>

      <div className="flex gap-3">
        <Swatch
          label="Text"
          value={theme.textColor}
          onChange={(value) => set("textColor", value)}
        />
        <Swatch
          label="Outline"
          value={theme.outlineColor}
          onChange={(value) => set("outlineColor", value)}
        />
      </div>

      <Slider
        label="Outline width"
        value={theme.outlineWidth}
        min={0}
        max={8}
        step={0.5}
        format={(value) => (value === 0 ? "off" : `${value}px`)}
        onChange={(value) => set("outlineWidth", value)}
      />

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={theme.shadow}
          onChange={(event) => set("shadow", event.target.checked)}
          className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
        />
        <span className="text-[13px] text-pulpitry-text">Soft drop shadow</span>
      </label>

      {/*
        The reference, and how it is set.
        
        Its own group rather than another checkbox in a list, because it is its
        own piece of typography: the verse is what the congregation reads and
        "John 3:16 (KJV)" is a citation beneath it, which a service sheet or a
        broadcast lower third would happily set in another face or the church's
        accent colour. The controls only appear once it is being shown -- three
        dead fields under an unticked box are three things to ignore.
      */}
      <div className="flex flex-col gap-2 border-t border-pulpitry-line pt-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={theme.showReference}
            onChange={(event) => set("showReference", event.target.checked)}
            className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
          />
          <span className="text-[13px] text-pulpitry-text">
            Show the reference beneath
          </span>
        </label>

        {theme.showReference ? (
          <>
            <div className="flex gap-3">
              {/* Empty rather than a copy of the scripture's: a theme left on
                  this keeps following the typeface above when it is changed
                  later, which a copy would silently stop doing. */}
              <div className="flex flex-[2]">
                <FontPicker
                  label="Reference typeface"
                  value={theme.referenceFontFamily}
                  onChange={(family) => set("referenceFontFamily", family)}
                  className={FIELD}
                  inherit="Same as the scripture"
                />
              </div>
              <div className="flex flex-1 flex-col justify-end">
                <Slider
                  label="Reference size"
                  value={theme.referenceScale}
                  min={0.5}
                  max={2}
                  step={0.05}
                  format={(value) => `${Math.round(value * 100)}%`}
                  onChange={(value) => set("referenceScale", value)}
                />
              </div>
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={theme.referenceColor !== ""}
                onChange={(event) =>
                  // Falling back to the scripture's colour rather than to black:
                  // ticking this should start from what is already on screen, so
                  // the first thing the operator sees is not a change they did
                  // not ask for.
                  set(
                    "referenceColor",
                    event.target.checked ? theme.textColor : "",
                  )
                }
                className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
              />
              <span className="text-[13px] text-pulpitry-text">
                Give the reference its own colour
              </span>
            </label>

            {theme.referenceColor !== "" ? (
              <Swatch
                label="Reference"
                value={theme.referenceColor}
                onChange={(value) => set("referenceColor", value)}
              />
            ) : null}
          </>
        ) : null}
      </div>

      <div className="border-t border-pulpitry-line pt-3">
        <span className="text-[12px] text-pulpitry-muted">Background</span>
        <div className="mt-1.5 flex gap-1.5">
          {(["color", "gradient", "motion", "image", "video"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => {
                if (kind === "color" || kind === "gradient" || kind === "motion")
                  set("backgroundKind", kind);
                else void pickBackground(kind);
              }}
              className={`flex-1 rounded border px-2 py-1.5 text-[12px] capitalize transition-colors focus-visible:focus-ring ${
                theme.backgroundKind === kind
                  ? "border-pulpitry-gold-dim bg-pulpitry-gold/10 text-pulpitry-gold"
                  : "border-pulpitry-line bg-pulpitry-raised text-pulpitry-text hover:border-pulpitry-muted"
              }`}
            >
              {kind}
            </button>
          ))}
        </div>

        {usingMedia && theme.backgroundPath ? (
          <p
            className="mt-1.5 truncate text-[11px] text-pulpitry-muted"
            title={theme.backgroundPath}
          >
            {theme.backgroundPath.split("/").pop()}
          </p>
        ) : null}

        <div className="mt-3 flex flex-col gap-3">
          {theme.backgroundKind === "color" ? (
            <Swatch
              label="Colour"
              value={theme.backgroundColor}
              onChange={(value) => set("backgroundColor", value)}
            />
          ) : theme.backgroundKind === "motion" ? (
            <>
              {/* The colours come from the gradient's ends, which is what
                  makes a drawn background the church's own rather than stock
                  footage in somebody else's palette. Said here, because two
                  fields called From and To under a heading called Motion
                  would otherwise look like a mistake. */}
              <div className="flex gap-1.5">
                {MOTIONS.map((motion) => (
                  <button
                    key={motion.id}
                    type="button"
                    onClick={() => set("motion", motion.id)}
                    title={motion.hint}
                    className={`flex-1 rounded border px-2 py-1.5 text-[12px] transition-colors focus-visible:focus-ring ${
                      (theme.motion || "drift") === motion.id
                        ? "border-pulpitry-gold-dim bg-pulpitry-gold/10 text-pulpitry-gold"
                        : "border-pulpitry-line bg-pulpitry-raised text-pulpitry-text hover:border-pulpitry-muted"
                    }`}
                  >
                    {motion.name}
                  </button>
                ))}
              </div>
              <p className="text-[11px] leading-snug text-pulpitry-muted">
                {MOTIONS.find((motion) => motion.id === (theme.motion || "drift"))?.hint}
              </p>
              <Swatch
                label="From"
                value={theme.gradientFrom}
                onChange={(value) => set("gradientFrom", value)}
              />
              <Swatch
                label="To"
                value={theme.gradientTo}
                onChange={(value) => set("gradientTo", value)}
              />
              <Slider
                label="Speed"
                value={theme.motionSpeed ?? 1}
                min={0.25}
                max={2}
                step={0.25}
                format={(value) => `${value}×`}
                onChange={(value) => set("motionSpeed", value)}
              />
            </>
          ) : theme.backgroundKind === "gradient" ? (
            <>
              <Swatch
                label="From"
                value={theme.gradientFrom}
                onChange={(value) => set("gradientFrom", value)}
              />
              <Swatch
                label="To"
                value={theme.gradientTo}
                onChange={(value) => set("gradientTo", value)}
              />
              <Slider
                label="Angle"
                value={theme.gradientAngle}
                min={0}
                max={360}
                step={5}
                format={(value) => `${Math.round(value)}°`}
                onChange={(value) => set("gradientAngle", value)}
              />
            </>
          ) : (
            <>
              <Slider
                label="Dim behind text"
                value={theme.backgroundDim}
                min={0}
                max={0.85}
                step={0.05}
                format={(value) =>
                  value === 0 ? "off" : `${Math.round(value * 100)}%`
                }
                onChange={(value) => set("backgroundDim", value)}
              />

              {/* A different instrument from the dim, and often the better
                  one: dimming makes a picture darker, blurring makes it stop
                  competing. Together they turn nearly any photograph into a
                  background that words can sit on. */}
              <Slider
                label="Blur"
                value={theme.backgroundBlur}
                min={0}
                max={60}
                step={2}
                format={(value) => (value === 0 ? "off" : `${value}px`)}
                onChange={(value) => set("backgroundBlur", value)}
              />

              <Slider
                label="Scale"
                value={theme.backgroundScale}
                min={0.5}
                max={2.5}
                step={0.05}
                format={(value) => `${value.toFixed(2)}×`}
                onChange={(value) => set("backgroundScale", value)}
              />

              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-pulpitry-muted">
                  How it meets the frame
                </span>
                <select
                  value={theme.backgroundFit || "cover"}
                  onChange={(event) => set("backgroundFit", event.target.value)}
                  className={FIELD}
                >
                  <option value="cover">Fill the screen, cropping</option>
                  <option value="contain">Show all of it, with bars</option>
                  <option value="fill">Stretch to fit</option>
                </select>
                <span className="text-[11px] leading-snug text-pulpitry-muted">
                  {theme.backgroundFit === "contain"
                    ? "For a picture that loses its point when cropped — a diagram, a map, an image with words in it. The bars take the colour above."
                    : theme.backgroundFit === "fill"
                      ? "Distorts. Here because it is occasionally wanted, and refusing would be us deciding."
                      : "Right almost always: a screen has one shape and a photograph has another."}
                </span>
              </label>
            </>
          )}
        </div>
      </div>

      <div className="border-t border-pulpitry-line pt-3">
        <span className="text-[12px] text-pulpitry-muted">Texture</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {TEXTURES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => set("texture", option.id)}
              title={option.hint}
              className={`rounded border px-2 py-1.5 text-[12px] transition-colors focus-visible:focus-ring ${
                theme.texture === option.id
                  ? "border-pulpitry-gold-dim bg-pulpitry-gold/10 text-pulpitry-gold"
                  : "border-pulpitry-line bg-pulpitry-raised text-pulpitry-text hover:border-pulpitry-muted"
              }`}
            >
              {option.name}
            </button>
          ))}
        </div>

        {theme.texture !== "none" ? (
          <div className="mt-3">
            <Slider
              label="Strength"
              value={theme.textureStrength}
              min={0.05}
              max={1}
              step={0.05}
              format={(value) => `${Math.round(value * 100)}%`}
              onChange={(value) => set("textureStrength", value)}
            />
          </div>
        ) : null}
      </div>

      {showThemesHint ? (
        <p className="border-t border-pulpitry-line pt-3 text-[11px] text-pulpitry-muted">
          Whole looks live in the Themes tab, where you can build and keep your
          own.
        </p>
      ) : null}
    </div>
  );
}
