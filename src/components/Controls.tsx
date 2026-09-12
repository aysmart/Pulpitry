/** Small shared controls, so the theme editor and the notice panel match. */

import {
  alphaOf,
  readColour,
  rgbOf,
  withColourAlpha,
} from "../lib/theme";

export const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between text-[12px] text-pulpitry-muted">
        <span>{label}</span>
        <span className="tabular-nums text-pulpitry-text">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-pulpitry-gold focus-visible:focus-ring"
      />
    </label>
  );
}

/**
 * A colour, and how much of it there is.
 *
 * # Why the alpha is here rather than as an element's opacity
 *
 * Every colour in this application was six hex digits, and transparency was a
 * separate multiplier on whatever drew the colour. That is enough for "fade
 * this whole thing" and it cannot express the two devices a church slide is
 * mostly made of: a tint — a white band at a fifth, so a photograph shows
 * through the words' backing — and a fade, where one end of a gradient is not
 * there at all. Neither is a property of an element; both are properties of a
 * colour, and CSS has understood eight-digit hex for years.
 *
 * So a colour carries its own alpha, stored as `#RRGGBBAA` below full opacity
 * and as plain `#RRGGBB` at it. Nothing saved before this changes, and nothing
 * that *draws* a colour needed a line changed: it is the same string handed to
 * the same property.
 *
 * The native picker cannot show alpha — it takes exactly six digits — so it
 * edits the colour and the box beside it edits the alpha, which is also the
 * arrangement every design tool uses.
 */
export function Swatch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const alpha = alphaOf(value);

  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[12px] text-pulpitry-muted">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="color"
          // The opaque part only: given eight digits the picker treats the
          // value as invalid and shows black, which reads as the colour having
          // been lost.
          value={rgbOf(value)}
          aria-label={`${label} colour`}
          onChange={(event) =>
            onChange(withColourAlpha(event.target.value, alpha))
          }
          className="h-8 w-10 shrink-0 cursor-pointer rounded border border-pulpitry-line bg-pulpitry-raised focus-visible:focus-ring"
        />
        <input
          value={value}
          spellCheck={false}
          aria-label={`${label} in hex`}
          onChange={(event) => {
            /*
             * Typed straight through, and interpreted only when it parses.
             *
             * A controlled field that rewrote every keystroke made "#1a2b3c"
             * impossible to type: the third character produced a colour, the
             * value was replaced, and the caret jumped. So the text is passed
             * on as-is and a valid colour is what changes anything.
             */
            const read = readColour(event.target.value);
            onChange(read ?? event.target.value);
          }}
          className={`${FIELD} w-full font-mono text-[12px]`}
        />
        <span className="flex shrink-0 items-center gap-1">
          <input
            type="number"
            min={0}
            max={100}
            value={alpha}
            aria-label={`${label} opacity`}
            onChange={(event) => {
              const next = Number.parseFloat(event.target.value);
              if (Number.isFinite(next)) onChange(withColourAlpha(value, next));
            }}
            className={`${FIELD} w-[3.6rem] text-[12px]`}
          />
          <span className="text-[11px] text-pulpitry-muted">%</span>
        </span>
      </span>
    </label>
  );
}
