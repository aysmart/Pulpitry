/** Small shared controls, so the theme editor and the notice panel match. */

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

export function Swatch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[12px] text-pulpitry-muted">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-10 shrink-0 cursor-pointer rounded border border-pulpitry-line bg-pulpitry-raised focus-visible:focus-ring"
        />
        <input
          value={value}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD} w-full font-mono text-[12px]`}
        />
      </span>
    </label>
  );
}
