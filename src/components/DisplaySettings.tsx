import { open } from "@tauri-apps/plugin-dialog";

import { allowBackground, FONT_FAMILIES, type ProjectorTheme } from "../lib/theme";
import { ThemeTemplates } from "./ThemeTemplates";

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring";

function Slider({
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

function Swatch({
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

/**
 * Appearance of the projector output.
 *
 * The controls are grouped by the problem they solve rather than by CSS
 * property: choosing type, then keeping it readable over whatever is behind it.
 */
export function DisplaySettings({
  theme,
  onChange,
  onError,
}: {
  theme: ProjectorTheme;
  onChange: (next: ProjectorTheme) => void;
  onError: (message: string) => void;
}) {
  const set = <K extends keyof ProjectorTheme>(key: K, value: ProjectorTheme[K]) =>
    onChange({ ...theme, [key]: value });

  const pickBackground = async (kind: "image" | "video") => {
    try {
      const path = await open({
        title: kind === "image" ? "Choose a background image" : "Choose a background video",
        multiple: false,
        directory: false,
        filters: [
          kind === "image"
            ? { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }
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

  const usingMedia = theme.backgroundKind !== "color";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        <label className="flex flex-[2] flex-col gap-1">
          <span className="text-[12px] text-pulpitry-muted">Typeface</span>
          <select
            value={theme.fontFamily}
            onChange={(event) => set("fontFamily", event.target.value)}
            className={FIELD}
          >
            {FONT_FAMILIES.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
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
        <Swatch label="Text" value={theme.textColor} onChange={(value) => set("textColor", value)} />
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

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={theme.showReference}
          onChange={(event) => set("showReference", event.target.checked)}
          className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
        />
        <span className="text-[13px] text-pulpitry-text">Show the reference beneath</span>
      </label>

      <div className="border-t border-pulpitry-line pt-3">
        <span className="text-[12px] text-pulpitry-muted">Background</span>
        <div className="mt-1.5 flex gap-1.5">
          {(["color", "image", "video"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => {
                if (kind === "color") set("backgroundKind", "color");
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
          <p className="mt-1.5 truncate text-[11px] text-pulpitry-muted" title={theme.backgroundPath}>
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
          ) : (
            <Slider
              label="Dim behind text"
              value={theme.backgroundDim}
              min={0}
              max={0.85}
              step={0.05}
              format={(value) => (value === 0 ? "off" : `${Math.round(value * 100)}%`)}
              onChange={(value) => set("backgroundDim", value)}
            />
          )}
        </div>
      </div>

      <ThemeTemplates theme={theme} onApply={onChange} onError={onError} />
    </div>
  );
}
