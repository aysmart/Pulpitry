/** Small shared controls, so the theme editor and the notice panel match. */

import { useEffect, useState } from "react";

import { isBundled, systemFonts } from "../lib/fonts";
import {
  alphaOf,
  FONT_FAMILIES,
  readColour,
  rgbOf,
  withColourAlpha,
} from "../lib/theme";

export const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

/**
 * Choosing a typeface, from what ships and from what the machine has.
 *
 * Two groups, and the bundled ones first: those are the faces every look was
 * designed in and the ones that exist on any machine the deck might be carried
 * to. A church's own typeface is the second group, and it is the reason this
 * exists — a brand's face is already installed on the machine that runs the
 * service, and until now the answer was that it could not be used.
 *
 * Each name is drawn in its own face, because that is how anybody chooses one.
 *
 * The system list arrives after the first render: it is a platform call, and
 * waiting on it before showing the picker would stall the dialogue for the
 * benefit of a list most operators will not open.
 */
export function FontPicker({
  label,
  value,
  onChange,
  className = FIELD,
  /** Offered as the first choice, for an element that may follow the theme. */
  inherit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  inherit?: string;
}) {
  const [installed, setInstalled] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void systemFonts().then((families) => {
      if (live) setInstalled(families);
    });
    return () => {
      live = false;
    };
  }, []);

  /*
   * A family that is no longer here still shows.
   *
   * A deck made on the church's own machine and opened on a stand-in laptop
   * names a face that machine may not have. Dropping it from the list would
   * silently reset the deck's typeface the moment somebody touched the picker;
   * keeping it says what the deck asks for, and the stack behind it is what
   * makes the slide read anyway.
   */
  const missing =
    value && !isBundled(value) && !installed.includes(value) ? value : null;

  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[12px] text-pulpitry-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={className}
      >
        {inherit !== undefined ? <option value="">{inherit}</option> : null}

        <optgroup label="Bundled with Pulpitry">
          {FONT_FAMILIES.map((entry) => (
            <option
              key={entry.key}
              value={entry.key}
              style={{ fontFamily: entry.stack }}
            >
              {entry.label}
            </option>
          ))}
        </optgroup>

        {missing ? (
          <optgroup label="Asked for, but not on this computer">
            <option value={missing}>{missing}</option>
          </optgroup>
        ) : null}

        {installed.length > 0 ? (
          <optgroup label="On this computer">
            {installed.map((family) => (
              <option key={family} value={family} style={{ fontFamily: family }}>
                {family}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}

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
