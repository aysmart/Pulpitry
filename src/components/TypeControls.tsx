import type { ProjectorTheme } from "../lib/theme";
import { FontPicker, Swatch } from "./Controls";

const FIELD =
  "w-full rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12px] text-pulpitry-text outline-none focus-visible:focus-ring";

const LABEL = "mb-1 block text-[10.5px] tracking-[0.08em] text-pulpitry-muted uppercase";

/**
 * A row of choices where one is on.
 *
 * Buttons rather than a menu, for the settings judged by looking: an operator
 * changing the alignment wants to see the result of all three, and a menu
 * hides two of them behind a press.
 */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="min-w-0">
      <span className={LABEL}>{label}</span>
      <div className="flex items-center gap-0.5 rounded border border-pulpitry-line bg-pulpitry-raised p-0.5">
        {options.map(([id, text]) => (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className={`min-w-0 flex-1 truncate rounded px-1.5 py-1 text-[11.5px] transition-colors focus-visible:focus-ring ${
              value === id
                ? "bg-pulpitry-teal-dim text-pulpitry-text"
                : "text-pulpitry-muted hover:text-pulpitry-text"
            }`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Number_({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <label className="min-w-0">
      <span className={LABEL}>{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(event) => {
            const next = Number.parseFloat(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          className={FIELD}
        />
        {suffix ? (
          <span className="shrink-0 text-[11px] text-pulpitry-muted">
            {suffix}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/**
 * How the words are set, wherever they are being looked at.
 *
 * # Why this is the church's look and not the song's
 *
 * Every control here changes the theme — the church's own look, applied to
 * every verse, every lyric and every slide. That is deliberate, and it is the
 * opposite of what a presentation program usually does.
 *
 * A per-song setting sounds kinder and is a trap: a church sets the type on the
 * song they happen to be editing, changes their look six months later, and half
 * their library quietly ignores it. Nobody remembers which half. The screen
 * then disagrees with itself in the one place a congregation is looking.
 *
 * What a per-song setting is genuinely for — the one carol that wants a
 * different background — is a job for a theme applied to an output, which
 * Pulpitry already has.
 *
 * # Why it is here rather than only in Settings
 *
 * Because type is judged by looking at real words. Sitting beside a verse of
 * the song being typed, with the church's real background behind it, the answer
 * to "is this readable from the back" is visible. In a settings dialogue over
 * sample text it is a guess.
 */
export function TypeControls({
  theme,
  onChange,
}: {
  theme: ProjectorTheme;
  onChange: (theme: ProjectorTheme) => void;
}) {
  const set = <K extends keyof ProjectorTheme>(
    key: K,
    value: ProjectorTheme[K],
  ) => onChange({ ...theme, [key]: value });

  return (
    <div className="flex flex-col gap-2.5 rounded border border-pulpitry-line p-3">
      <p className="text-[11px] leading-relaxed text-pulpitry-muted">
        Your church&apos;s look, applied to everything on the screen — not to
        this song alone.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Choice<ProjectorTheme["vertical"]>
          label="Position"
          value={theme.vertical}
          options={[
            ["top", "Top"],
            ["middle", "Middle"],
            ["bottom", "Bottom"],
          ]}
          onChange={(vertical) => set("vertical", vertical)}
        />
        <Choice<ProjectorTheme["align"]>
          label="Align"
          value={theme.align}
          options={[
            ["left", "Left"],
            ["center", "Centre"],
            ["right", "Right"],
          ]}
          onChange={(align) => set("align", align)}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <FontPicker
          label="Font"
          value={theme.fontFamily}
          onChange={(family) => set("fontFamily", family)}
          className={FIELD}
        />
        <Number_
          label="Size"
          value={theme.fontScale}
          step={0.05}
          min={0.4}
          max={2.5}
          suffix="×"
          onChange={(scale) => set("fontScale", scale)}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Number_
          label="Line height"
          value={theme.lineHeight}
          step={0.05}
          min={0.8}
          max={2.5}
          onChange={(height) => set("lineHeight", height)}
        />
        <label className="min-w-0">
          <span className={LABEL}>Weight</span>
          <select
            value={theme.fontWeight}
            onChange={(event) => set("fontWeight", Number(event.target.value))}
            className={FIELD}
          >
            {/* Zero rather than a number: a face has a weight of its own, and
                naming one here would override it for every typeface. */}
            <option value={0}>The typeface&apos;s</option>
            {[300, 400, 500, 600, 700, 800, 900].map((weight) => (
              <option key={weight} value={weight}>
                {weight}
              </option>
            ))}
          </select>
        </label>
        <Number_
          label="Tracking"
          value={theme.letterSpacing}
          step={0.5}
          suffix="px"
          onChange={(spacing) => set("letterSpacing", spacing)}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="min-w-0">
          <span className={LABEL}>Case</span>
          <select
            value={theme.textCase || "none"}
            onChange={(event) =>
              set("textCase", event.target.value as ProjectorTheme["textCase"])
            }
            className={FIELD}
          >
            {/* Applied when drawn and never to the stored words: a church that
                projects capitals still has the song written as it was given. */}
            <option value="none">As written</option>
            <option value="upper">CAPITALS</option>
            <option value="title">Title Case</option>
            <option value="lower">lower case</option>
          </select>
        </label>
        <Swatch
          label="Text colour"
          value={theme.textColor}
          onChange={(colour) => set("textColor", colour)}
        />
      </div>

      <div>
        <span className={LABEL}>
          Shadow — lifts light words off a busy background
        </span>
        <div className="flex items-center gap-0.5 rounded border border-pulpitry-line bg-pulpitry-raised p-0.5">
          {[0, 1, 2, 3, 4, 5].map((level) => {
            const on = theme.shadow ? theme.shadowLevel : 0;
            return (
              <button
                key={level}
                type="button"
                aria-pressed={on === level}
                title={
                  level === 0
                    ? "No shadow"
                    : `Strength ${level} of 5`
                }
                onClick={() =>
                  onChange({
                    ...theme,
                    shadow: level > 0,
                    shadowLevel: level === 0 ? theme.shadowLevel : level,
                  })
                }
                className={`min-w-0 flex-1 rounded px-1 py-1 text-[11.5px] transition-colors focus-visible:focus-ring ${
                  on === level
                    ? "bg-pulpitry-teal-dim text-pulpitry-text"
                    : "text-pulpitry-muted hover:text-pulpitry-text"
                }`}
              >
                L{level}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
