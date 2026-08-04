import type { Ticker } from "../lib/projector";
import type { ProjectorTheme } from "../lib/theme";
import { TickerBand } from "./TickerBand";
import { Backdrop } from "./Backdrop";

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

const CHOICE =
  "flex-1 rounded border px-2 py-1.5 text-[12px] transition-colors focus-visible:focus-ring";

/**
 * The announcement that crawls across the screen while something else is on it.
 *
 * Separate from a slide on purpose: a slide replaces what the congregation is
 * looking at, and a notice about the car park should not interrupt a reading.
 *
 * It is not kept between sessions. An announcement belongs to one gathering,
 * and one that came back by itself next week — quite possibly about an event
 * that has already happened — would be worse than typing it again.
 */
export function TickerPanel({
  ticker,
  theme,
  onChange,
}: {
  ticker: Ticker;
  theme: ProjectorTheme;
  onChange: (next: Partial<Ticker>) => void;
}) {
  const empty = !ticker.text.trim();

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 overflow-auto p-2.5">
      <textarea
        value={ticker.text}
        placeholder="Church picnic this Saturday, 10am at Riverside Park — sign up in the foyer"
        aria-label="Announcement"
        rows={3}
        onChange={(event) => onChange({ text: event.target.value })}
        className={`${FIELD} resize-none font-[inherit] leading-relaxed`}
      />

      <button
        type="button"
        onClick={() => onChange({ visible: !ticker.visible })}
        disabled={empty && !ticker.visible}
        title={empty ? "Write something first" : undefined}
        className={`rounded px-3 py-2 text-[13px] transition-opacity disabled:opacity-35 focus-visible:focus-ring ${
          ticker.visible
            ? "bg-pulpitry-gold text-pulpitry-ink hover:bg-pulpitry-gold/90"
            : "border border-pulpitry-line bg-pulpitry-raised text-pulpitry-text hover:border-pulpitry-muted"
        }`}
      >
        {ticker.visible ? "On the screen — take it off" : "Put it on the screen"}
      </button>

      <div>
        <span className="text-[12px] text-pulpitry-muted">Position</span>
        <div className="mt-1.5 flex gap-1.5">
          {(["top", "bottom"] as const).map((where) => (
            <button
              key={where}
              type="button"
              onClick={() => onChange({ position: where })}
              className={`${CHOICE} capitalize ${
                ticker.position === where
                  ? "border-pulpitry-gold-dim bg-pulpitry-gold/10 text-pulpitry-gold"
                  : "border-pulpitry-line bg-pulpitry-raised text-pulpitry-text hover:border-pulpitry-muted"
              }`}
            >
              {where}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] text-pulpitry-muted">Speed</span>
          <span className="text-[11px] text-pulpitry-muted tabular-nums">
            {Math.round(ticker.speed)}s a pass
          </span>
        </div>
        <input
          type="range"
          min={6}
          max={60}
          step={1}
          // Reversed, so dragging right speeds it up rather than raising a
          // number that means the opposite.
          value={66 - ticker.speed}
          aria-label="Announcement speed"
          onChange={(event) => onChange({ speed: 66 - Number(event.target.value) })}
          className="mt-1.5 h-1 w-full accent-pulpitry-gold focus-visible:focus-ring"
        />
      </div>

      <div>
        <span className="text-[12px] text-pulpitry-muted">On the screen</span>
        {/* The real band on the real theme, moving at the real speed. A still
            mockup would not tell you whether it is readable at that pace. */}
        <div className="relative mt-1.5 aspect-video overflow-hidden rounded border border-pulpitry-line [container-type:size]">
          <Backdrop theme={theme} playVideo={false} />
          <TickerBand
            ticker={{ ...ticker, visible: ticker.visible || !empty }}
            theme={theme}
          />
        </div>
      </div>
    </div>
  );
}
